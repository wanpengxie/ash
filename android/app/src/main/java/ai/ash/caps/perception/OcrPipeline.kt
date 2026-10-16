package ai.ash.caps.perception

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** A tensor handed to or got from a network: row-major [data] of [shape]. */
class Tensor(val data: FloatArray, val shape: LongArray)

/** One network of the reader. Behind an interface so the work around the networks can be tested without any. */
interface Net {
    fun run(input: Tensor): Tensor
}

/** One line of text found in an image: its box in image pixels ([left, top, right, bottom]) and how sure the reader is, 0..1. */
class OcrBlock(val text: String, val box: IntArray, val score: Float)

class OcrTimings(var prepareNs: Long = 0, var orientationNs: Long = 0, var inferenceNs: Long = 0, var decodeNs: Long = 0)
class OcrResult(val blocks: List<OcrBlock>, val text: String, val width: Int, val height: Int, val detectMs: Long, val recognizeMs: Long, val timings: OcrTimings = OcrTimings())

/**
 * PP-OCRv6 as three networks and the plain code between them: [det] finds text lines (a probability map the size of
 * the scaled image), [ori] says whether a cropped line is upside down, [rec] reads a line (one score row per step, the
 * dictionary's characters plus a blank first and a space last).
 *
 * Differences from Paddle's own post-processing, on purpose: boxes are upright rectangles (a connected region of the map,
 * grown by the same unclip rule) rather than rotated polygons, which suits screenshots and straight photos of paper; and the
 * reader groups similar widths in bounded batches. Lines taller than wide are turned 90° before reading, as Paddle does.
 */
class OcrPipeline(private val det: Net, private val ori: Net, private val rec: Net, private val chars: List<String>, private val batchSize: Int = 8, private val detectionBoxThreshold: Float = DET_BOX_THRESHOLD, private val legacyRgb: Boolean = false) {
    init { require(batchSize in 1..8) }
    fun read(image: RgbImage, maxSide: Int = DEFAULT_MAX_SIDE, minScore: Float = DEFAULT_MIN_SCORE, now: () -> Long = System::nanoTime): OcrResult {
        val t0 = now()
        val boxes = detect(image, maxSide)
        val t1 = now()
        val timings = OcrTimings()
        val answers = recognizeAll(image, boxes, timings, now)
        val blocks = boxes.mapIndexedNotNull { i, box ->
            val (text, score) = answers[i]
            if (text.isBlank() || score < minScore) null else OcrBlock(text, box.rect, score)
        }
        val t2 = now()
        val sorted = readingOrder(blocks)
        return OcrResult(sorted, layout(sorted), image.width, image.height, (t1 - t0) / 1_000_000, (t2 - t1) / 1_000_000, timings)
    }

    class Found(val rect: IntArray, val score: Float)

    fun detect(image: RgbImage, maxSide: Int): List<Found> {
        val (w, h) = image.width to image.height
        val scale = min(1.0, maxSide.toDouble() / max(w, h))
        val nw = max(32, ((w * scale) / 32).roundToInt() * 32)
        val nh = max(32, ((h * scale) / 32).roundToInt() * 32)
        val scaled = image.scaled(0, 0, w, h, nw, nh)
        val out = det.run(Tensor(scaled.toChw(MEAN, STD, bgr = !legacyRgb), longArrayOf(1, 3, nh.toLong(), nw.toLong())))
        require(out.data.size == nw * nh) { "the detector answered ${out.data.size} values for a ${nw}x$nh image" }
        return DbPostProcess.boxes(out.data, nw, nh, DET_THRESHOLD, detectionBoxThreshold, DET_UNCLIP).map { b ->
            val rect = intArrayOf(
                (b.left * w / nw).roundToInt().coerceIn(0, w - 1), (b.top * h / nh).roundToInt().coerceIn(0, h - 1),
                (b.right * w / nw).roundToInt().coerceIn(1, w), (b.bottom * h / nh).roundToInt().coerceIn(1, h),
            )
            Found(rect, b.score)
        }.filter { it.rect[2] > it.rect[0] && it.rect[3] > it.rect[1] }
    }

    /** The text of one line and the mean confidence of its characters. */
    fun recognize(image: RgbImage, box: Found, timings: OcrTimings = OcrTimings(), now: () -> Long = System::nanoTime): Pair<String, Float> {
        var start = now()
        var line = image.crop(box.rect[0], box.rect[1], box.rect[2], box.rect[3])
        if (line.height >= VERTICAL_RATIO * line.width) line = line.rotated(3)
        val oriInput = Tensor(line.scaled(0, 0, line.width, line.height, ORI_W, ORI_H).toChw(MEAN, STD), longArrayOf(1, 3, ORI_H.toLong(), ORI_W.toLong()))
        timings.prepareNs += now() - start
        start = now()
        val turn = ori.run(oriInput)
        timings.orientationNs += now() - start
        start = now()
        if (turn.data.size >= 2 && turn.data[1] > ORI_THRESHOLD && turn.data[1] > turn.data[0]) line = line.rotated(2)
        val w = min(MAX_REC_WIDTH, max(16, ceil(REC_HEIGHT.toDouble() * line.width / line.height).toInt()))
        val input = line.scaled(0, 0, line.width, line.height, w, REC_HEIGHT).toChw(0.5f, 0.5f, bgr = !legacyRgb)
        timings.prepareNs += now() - start
        start = now()
        val out = rec.run(Tensor(input, longArrayOf(1, 3, REC_HEIGHT.toLong(), w.toLong())))
        timings.inferenceNs += now() - start
        start = now()
        return CtcDecode.decode(out, chars).also { timings.decodeNs += now() - start }
    }

    /** Results retain the detector's order even though inference runs in width order. At most eight crops live at once. */
    fun recognizeAll(image: RgbImage, boxes: List<Found>, timings: OcrTimings = OcrTimings(), now: () -> Long = System::nanoTime): List<Pair<String, Float>> {
        val answers = MutableList(boxes.size) { "" to 0f }
        // Keep the old exact-width, single-line path available to the desktop comparison.
        if (batchSize == 1) {
            for (i in boxes.indices) answers[i] = recognize(image, boxes[i], timings, now)
            return answers
        }
        val widths = boxes.map { b ->
            val w = b.rect[2] - b.rect[0]; val h = b.rect[3] - b.rect[1]
            recognitionWidth(if (h >= VERTICAL_RATIO * w) h else w, if (h >= VERTICAL_RATIO * w) w else h)
        }
        for (indices in widthBatches(widths, batchSize)) {
            var start = now()
            val lines = indices.map { i ->
                val b = boxes[i].rect
                image.crop(b[0], b[1], b[2], b[3]).let { if (it.height >= VERTICAL_RATIO * it.width) it.rotated(3) else it }
            }.toMutableList()
            val oriData = FloatArray(lines.size * 3 * ORI_H * ORI_W)
            lines.forEachIndexed { i, line -> line.scaled(0, 0, line.width, line.height, ORI_W, ORI_H).toChw(MEAN, STD).copyInto(oriData, i * 3 * ORI_H * ORI_W) }
            timings.prepareNs += now() - start
            start = now()
            val turns = ori.run(Tensor(oriData, longArrayOf(lines.size.toLong(), 3, ORI_H.toLong(), ORI_W.toLong())))
            require(turns.shape.contentEquals(longArrayOf(lines.size.toLong(), 2)) && turns.data.size == lines.size * 2) { "the orientation model did not preserve the batch" }
            timings.orientationNs += now() - start
            start = now()
            lines.indices.forEach { i -> if (turns.data[i * 2 + 1] > ORI_THRESHOLD && turns.data[i * 2 + 1] > turns.data[i * 2]) lines[i] = lines[i].rotated(2) }
            val validWidths = indices.map { widths[it] }
            val paddedWidth = ((validWidths.max() + 7) / 8) * 8
            val input = paddedInput(lines, validWidths, paddedWidth, bgr = !legacyRgb)
            timings.prepareNs += now() - start
            start = now()
            val output = rec.run(input)
            timings.inferenceNs += now() - start
            start = now()
            // Pinned v6 graphs emit floor((width + 3) / 8) steps, including for non-aligned widths.
            require(output.shape.size == 3 && output.shape[1] == paddedWidth.toLong() / 8) { "unexpected v6 recognition stride" }
            val decoded = CtcDecode.decodeBatch(output, chars, validWidths.map { recognitionSteps(it) }.toIntArray())
            require(decoded.size == indices.size) { "the reader did not preserve the batch" }
            indices.forEachIndexed { n, original -> answers[original] = decoded[n] }
            timings.decodeNs += now() - start
        }
        return answers
    }

    companion object {
        const val DEFAULT_MAX_SIDE = 960
        const val DEFAULT_MIN_SCORE = 0.5f
        const val REC_HEIGHT = 48
        const val MAX_REC_WIDTH = 3200
        const val ORI_W = 160
        const val ORI_H = 80
        /** Bound recognition output to about 20 MB (18710 classes, stride eight), except one unavoidable long line. */
        const val MAX_BATCH_WIDTH = 2048
        private const val ORI_THRESHOLD = 0.9f
        private const val VERTICAL_RATIO = 1.5
        // Fixed small inference.yml values (also identical to medium).
        private const val DET_THRESHOLD = 0.2f
        private const val DET_BOX_THRESHOLD = 0.45f
        private const val DET_UNCLIP = 1.4
        private val MEAN = floatArrayOf(0.485f, 0.456f, 0.406f)
        private val STD = floatArrayOf(0.229f, 0.224f, 0.225f)

        fun recognitionWidth(w: Int, h: Int): Int = ceil(REC_HEIGHT.toDouble() * w / h).toInt().coerceIn(16, MAX_REC_WIDTH)

        fun recognitionSteps(width: Int): Int = (width + 3) / 8

        fun widthBatches(widths: List<Int>, maxBatch: Int = 8): List<List<Int>> {
            require(maxBatch in 1..8 && widths.all { it in 16..MAX_REC_WIDTH })
            val batches = mutableListOf<MutableList<Int>>()
            for (i in widths.indices.sortedBy { widths[it] }) {
                val last = batches.lastOrNull()
                val padded = ((widths[i] + 7) / 8) * 8
                if (last == null || last.size >= maxBatch || padded * (last.size + 1) > MAX_BATCH_WIDTH || widths[i] > widths[last.first()] * 1.25) batches += mutableListOf(i)
                else last += i
            }
            return batches
        }

        /** Zero is the official normalized padding value, corresponding to mid-grey; content keeps its own aspect ratio. */
        fun paddedInput(lines: List<RgbImage>, widths: List<Int>, paddedWidth: Int, bgr: Boolean = true): Tensor {
            require(lines.isNotEmpty() && lines.size == widths.size && widths.all { it in 16..paddedWidth } && paddedWidth <= MAX_REC_WIDTH)
            val plane = REC_HEIGHT * paddedWidth
            val data = FloatArray(lines.size * 3 * plane)
            lines.forEachIndexed { n, line ->
                val w = widths[n]
                val chw = line.scaled(0, 0, line.width, line.height, w, REC_HEIGHT).toChw(0.5f, 0.5f, bgr)
                for (c in 0..2) for (y in 0 until REC_HEIGHT) chw.copyInto(data, n * 3 * plane + c * plane + y * paddedWidth, c * w * REC_HEIGHT + y * w, c * w * REC_HEIGHT + (y + 1) * w)
            }
            return Tensor(data, longArrayOf(lines.size.toLong(), 3, REC_HEIGHT.toLong(), paddedWidth.toLong()))
        }

        /** Top to bottom; blocks whose heights overlap by half or more (one row of a screen) go left to right. */
        fun readingOrder(blocks: List<OcrBlock>): List<OcrBlock> {
            val rows = mutableListOf<MutableList<OcrBlock>>()
            for (b in blocks.sortedBy { it.box[1] }) {
                val row = rows.firstOrNull { r -> sameRow(r.first(), b) }
                if (row != null) row += b else rows += mutableListOf(b)
            }
            return rows.sortedBy { r -> r.minOf { it.box[1] } }.flatMap { r -> r.sortedBy { it.box[0] } }
        }

        private fun sameRow(a: OcrBlock, b: OcrBlock): Boolean {
            val overlap = min(a.box[3], b.box[3]) - max(a.box[1], b.box[1])
            return overlap >= 0.5 * min(a.box[3] - a.box[1], b.box[3] - b.box[1])
        }

        /** The text, one row per line of the screen, the blocks of a row separated by a space. */
        fun layout(sorted: List<OcrBlock>): String {
            val out = StringBuilder()
            var last: OcrBlock? = null
            for (b in sorted) {
                if (last != null) out.append(if (sameRow(last, b)) ' ' else '\n')
                out.append(b.text)
                last = b
            }
            return out.toString()
        }
    }
}

/** The differentiable-binarization post-processing, without OpenCV: regions of the probability map above the threshold. */
object DbPostProcess {
    class Box(val left: Double, val top: Double, val right: Double, val bottom: Double, val score: Float)

    /**
     * Connected regions (4-neighbour) of [prob] ([w] × [h]) above [threshold] whose mean probability reaches [boxThreshold],
     * each as its upright bounding box grown by Paddle's unclip rule (distance = area × [unclip] / perimeter).
     */
    fun boxes(prob: FloatArray, w: Int, h: Int, threshold: Float, boxThreshold: Float, unclip: Double, maxBoxes: Int = 1000): List<Box> {
        val seen = BooleanArray(w * h)
        val stack = IntArray(w * h)
        val found = ArrayList<Box>()
        for (start in 0 until w * h) {
            if (seen[start] || prob[start] <= threshold) continue
            var top = 0
            stack[top++] = start; seen[start] = true
            var x0 = w; var y0 = h; var x1 = -1; var y1 = -1
            var sum = 0.0; var count = 0
            while (top > 0) {
                val p = stack[--top]
                val x = p % w; val y = p / w
                if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y
                sum += prob[p]; count++
                if (x > 0 && !seen[p - 1] && prob[p - 1] > threshold) { seen[p - 1] = true; stack[top++] = p - 1 }
                if (x < w - 1 && !seen[p + 1] && prob[p + 1] > threshold) { seen[p + 1] = true; stack[top++] = p + 1 }
                if (y > 0 && !seen[p - w] && prob[p - w] > threshold) { seen[p - w] = true; stack[top++] = p - w }
                if (y < h - 1 && !seen[p + w] && prob[p + w] > threshold) { seen[p + w] = true; stack[top++] = p + w }
            }
            val bw = x1 - x0 + 1; val bh = y1 - y0 + 1
            val score = (sum / count).toFloat()
            if (min(bw, bh) < MIN_SIDE || score < boxThreshold) continue
            val d = bw.toDouble() * bh * unclip / (2.0 * (bw + bh))
            found += Box(max(0.0, x0 - d), max(0.0, y0 - d), min(w.toDouble(), x1 + 1 + d), min(h.toDouble(), y1 + 1 + d), score)
        }
        return if (found.size > maxBoxes) found.sortedByDescending { it.score }.take(maxBoxes) else found
    }

    private const val MIN_SIDE = 3
}

/** CTC decoding of the reader's scores: step with the highest score, repeats and blanks dropped. */
object CtcDecode {
    /** [out] is [1, steps, classes]; class 0 is the blank, 1..n the dictionary, the last a space. */
    fun decode(out: Tensor, chars: List<String>): Pair<String, Float> {
        require(out.shape.size == 3 && out.shape[0] == 1L) { "decode needs one line; use decodeBatch for a batch" }
        return decodeBatch(out, chars).single()
    }

    fun decodeBatch(out: Tensor, chars: List<String>, validSteps: IntArray? = null): List<Pair<String, Float>> {
        require(out.shape.size == 3) { "the reader answered a tensor of rank ${out.shape.size}" }
        val batch = out.shape[0].toInt()
        val steps = out.shape[1].toInt(); val classes = out.shape[2].toInt()
        require(classes == chars.size + 2) { "the reader has $classes classes but the dictionary has ${chars.size} characters" }
        require(batch > 0 && steps > 0 && out.data.size.toLong() == batch.toLong() * steps * classes) { "invalid recognition output size" }
        require(validSteps == null || (validSteps.size == batch && validSteps.all { it in 1..steps }))
        return (0 until batch).map { b ->
            val text = StringBuilder()
            var sum = 0.0; var n = 0; var prev = 0
            for (t in 0 until (validSteps?.get(b) ?: steps)) {
                val offset = (b * steps + t) * classes
                var best = 0; var bestScore = out.data[offset]
                for (c in 1 until classes) { val s = out.data[offset + c]; if (s > bestScore) { bestScore = s; best = c } }
                if (best != 0 && best != prev) {
                    text.append(if (best == classes - 1) " " else chars[best - 1])
                    sum += bestScore; n++
                }
                prev = best
            }
            text.toString() to if (n == 0) 0f else (sum / n).toFloat()
        }
    }
}
