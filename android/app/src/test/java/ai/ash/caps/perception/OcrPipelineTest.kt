package ai.ash.caps.perception

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class OcrPipelineTest {
    private fun solid(w: Int, h: Int, argb: Int) = RgbImage(w, h, IntArray(w * h) { argb })

    // ---- the image helpers

    @Test fun scalingKeepsAPlainColourAndShrinksByAveraging() {
        val s = solid(40, 20, 0xff102030.toInt()).scaled(0, 0, 40, 20, 10, 5)
        assertEquals(10, s.width); assertEquals(5, s.height)
        assertTrue(s.pixels.all { it == 0xff102030.toInt() })
        // A black and white checker shrunk by two comes out grey, not black or white.
        val checker = RgbImage(4, 4, IntArray(16) { if ((it % 4 + it / 4) % 2 == 0) 0xffffffff.toInt() else 0xff000000.toInt() })
        val g = checker.scaled(0, 0, 4, 4, 2, 2)
        assertTrue(g.pixels.all { (it and 255) in 120..135 })
        // Growing is bilinear and stays within the colours it started with.
        val big = RgbImage(2, 1, intArrayOf(0xff000000.toInt(), 0xffffffff.toInt())).scaled(0, 0, 2, 1, 4, 1)
        assertEquals(listOf(0, 64, 191, 255), big.pixels.map { it and 255 })
    }

    @Test fun aRegionIsCutOutAndRotated() {
        val img = RgbImage(3, 2, intArrayOf(1, 2, 3, 4, 5, 6).map { 0xff000000.toInt() or it }.toIntArray())
        val lo = { i: RgbImage -> i.pixels.map { it and 255 } }
        assertEquals(listOf(2, 3, 5, 6), lo(img.crop(1, 0, 3, 2)))
        val right = img.rotated(1)
        assertEquals(2, right.width); assertEquals(3, right.height)
        assertEquals(listOf(4, 1, 5, 2, 6, 3), lo(right))
        assertEquals(listOf(6, 5, 4, 3, 2, 1), lo(img.rotated(2)))
        assertEquals(listOf(3, 6, 2, 5, 1, 4), lo(img.rotated(3)))
        assertEquals(lo(img), lo(img.rotated(4)))
    }

    @Test fun anImageNeedsItsPixels() {
        try { RgbImage(2, 2, IntArray(3)); fail("a short pixel array is refused") } catch (_: IllegalArgumentException) {}
    }

    // ---- detection post-processing

    private fun map(w: Int, h: Int, vararg rects: IntArray, p: Float = 0.9f) = FloatArray(w * h).also { m ->
        for (r in rects) for (y in r[1] until r[3]) for (x in r[0] until r[2]) m[y * w + x] = p
    }

    @Test fun regionsBecomeBoxesGrownByTheUnclipRule() {
        val boxes = DbPostProcess.boxes(map(100, 60, intArrayOf(10, 10, 50, 20), intArrayOf(10, 40, 90, 52)), 100, 60, 0.2f, 0.45f, 1.4)
        assertEquals(2, boxes.size)
        // 40 x 10: distance = 400 * 1.4 / 100 = 5.6
        val a = boxes.first { it.right < 60 }
        assertEquals(10 - 5.6, a.left, 1e-9); assertEquals(10 - 5.6, a.top, 1e-9); assertEquals(50 + 5.6, a.right, 1e-9); assertEquals(20 + 5.6, a.bottom, 1e-9)
        assertEquals(0.9f, a.score, 1e-6f)
    }

    @Test fun faintOrTinyRegionsAreDropped() {
        assertEquals(0, DbPostProcess.boxes(map(60, 60, intArrayOf(5, 5, 40, 20), p = 0.4f), 60, 60, 0.2f, 0.45f, 1.4).size)
        assertEquals(0, DbPostProcess.boxes(map(60, 60, intArrayOf(5, 5, 40, 7)), 60, 60, 0.2f, 0.45f, 1.4).size)
        // two regions that touch only at a corner are two lines, not one
        assertEquals(2, DbPostProcess.boxes(map(60, 60, intArrayOf(5, 5, 20, 12), intArrayOf(20, 12, 40, 20)), 60, 60, 0.2f, 0.45f, 1.4).size)
    }

    @Test fun aBoxStaysInsideTheMap() {
        val b = DbPostProcess.boxes(map(50, 30, intArrayOf(0, 0, 50, 30)), 50, 30, 0.2f, 0.45f, 1.4).single()
        assertEquals(0.0, b.left, 0.0); assertEquals(0.0, b.top, 0.0); assertEquals(50.0, b.right, 0.0); assertEquals(30.0, b.bottom, 0.0)
    }

    // ---- reading the scores

    private val chars = listOf("a", "b", "c")

    private fun scores(vararg picks: Int): Tensor {
        val classes = chars.size + 2
        val data = FloatArray(picks.size * classes)
        picks.forEachIndexed { t, c -> for (k in 0 until classes) data[t * classes + k] = if (k == c) 0.9f else 0.025f }
        return Tensor(data, longArrayOf(1, picks.size.toLong(), classes.toLong()))
    }

    @Test fun repeatsAndBlanksAreDroppedAndTheLastClassIsASpace() {
        val (text, score) = CtcDecode.decode(scores(0, 1, 1, 0, 1, 2, 4, 3), chars)
        assertEquals("aab c", text)
        assertEquals(0.9f, score, 1e-6f)
    }

    @Test fun aMismatchedDictionaryIsRefused() {
        try { CtcDecode.decode(scores(1), listOf("a", "b")); fail("5 classes do not fit a 2-character dictionary") } catch (_: IllegalArgumentException) {}
    }

    @Test fun silenceReadsAsNothing() {
        val (text, score) = CtcDecode.decode(scores(0, 0, 0), chars)
        assertEquals("", text); assertEquals(0f, score, 0f)
    }

    // ---- ordering and the whole pipeline with stand-in networks

    private fun block(text: String, l: Int, t: Int, r: Int, b: Int) = OcrBlock(text, intArrayOf(l, t, r, b), 0.9f)

    @Test fun blocksReadTopToBottomAndARowLeftToRight() {
        val sorted = OcrPipeline.readingOrder(listOf(block("C", 10, 100, 60, 130), block("B", 200, 12, 260, 40), block("A", 10, 10, 60, 38), block("D", 200, 102, 260, 131)))
        assertEquals(listOf("A", "B", "C", "D"), sorted.map { it.text })
        assertEquals("A B\nC D", OcrPipeline.layout(sorted))
    }

    private class FakeDet(val rects: List<IntArray>) : Net {
        var shape: LongArray? = null
        override fun run(input: Tensor): Tensor {
            shape = input.shape
            val h = input.shape[2].toInt(); val w = input.shape[3].toInt()
            val m = FloatArray(w * h)
            for (r in rects) for (y in r[1] until r[3]) for (x in r[0] until r[2]) m[y * w + x] = 0.95f
            return Tensor(m, longArrayOf(1, 1, h.toLong(), w.toLong()))
        }
    }

    private class FakeOri(val upsideDown: Boolean) : Net {
        override fun run(input: Tensor) = Tensor(if (upsideDown) floatArrayOf(0.02f, 0.98f) else floatArrayOf(0.98f, 0.02f), longArrayOf(1, 2))
    }

    private class FakeRec(val answer: Tensor) : Net {
        var shape: LongArray? = null
        override fun run(input: Tensor): Tensor { shape = input.shape; return answer }
    }

    @Test fun theBoxesComeBackInImagePixelsAndLowScoresAreFiltered() {
        val image = solid(640, 320, 0xffffffff.toInt())
        // The detector sees the image at 640x320 (already a multiple of 32): one line at x 64..320, y 64..96.
        val det = FakeDet(listOf(intArrayOf(64, 64, 320, 96)))
        val rec = FakeRec(scores(1, 0, 2))
        val result = OcrPipeline(det, FakeOri(false), rec, chars).read(image, maxSide = 640, minScore = 0.5f)
        assertArrayEquals(longArrayOf(1, 3, 320, 640), det.shape)
        val b = result.blocks.single()
        assertEquals("ab", b.text)
        // 256 x 32: distance = 8192 * 1.4 / 576 = 19.9 -> box grows by about 20 px each way
        assertEquals(44, b.box[0]); assertEquals(44, b.box[1]); assertEquals(340, b.box[2]); assertEquals(116, b.box[3])
        assertEquals("ab", result.text)
        assertEquals(640, result.width)
        // The reader is fed at height 48 and a width in proportion to the line.
        assertEquals(48L, rec.shape!![2])
        assertTrue(rec.shape!![3] > 48)
        assertEquals(0, OcrPipeline(det, FakeOri(false), rec, chars).read(image, 640, minScore = 0.95f).blocks.size)
    }

    @Test fun aLargeImageIsScaledDownForTheDetectorAndBoxesAreMappedBack() {
        val image = solid(2000, 1000, 0xffffffff.toInt())
        val det = FakeDet(listOf(intArrayOf(160, 96, 480, 128)))
        val result = OcrPipeline(det, FakeOri(false), FakeRec(scores(1)), chars).read(image, maxSide = 1000, minScore = 0.5f)
        // 2000x1000 at long side 1000 is 1000x500 -> 992x512 (multiples of 32): x scales 2000/992, y 1000/512.
        assertArrayEquals(longArrayOf(1, 3, 512, 992), det.shape)
        val box = result.blocks.single().box
        assertTrue(box[0] < 160 * 2000 / 992 && box[2] > 480 * 2000 / 992)
        assertTrue(box[3] <= 1000 && box[2] <= 2000)
    }

    @Test fun anUpsideDownLineIsTurnedAndATallOneLaidDown() {
        // A tall line (box taller than wide) is turned a quarter before it is read: the reader's input is wide.
        val image = solid(320, 640, 0xffffffff.toInt())
        val rec = FakeRec(scores(1))
        OcrPipeline(FakeDet(listOf(intArrayOf(128, 64, 160, 480))), FakeOri(true), rec, chars).read(image, 640, 0.5f)
        assertTrue("height 48, width > 48 for a laid-down line", rec.shape!![3] > 48)
    }
}
