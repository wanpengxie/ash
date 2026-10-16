package ai.ash.caps.perception

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** An image as packed 0xAARRGGBB pixels, the form `Bitmap.getPixels` gives; plain arrays so the reader runs off the phone too. */
class RgbImage(val width: Int, val height: Int, val pixels: IntArray) {
    init { require(width > 0 && height > 0 && pixels.size == width * height) { "a ${width}x$height image needs ${width.toLong() * height} pixels, not ${pixels.size}" } }

    /** The rectangle [x0, x1) × [y0, y1) scaled to [dw] × [dh]: bilinear when it is not shrunk much, else an average over the covered pixels (keeps thin strokes of shrunk text). */
    fun scaled(x0: Int, y0: Int, x1: Int, y1: Int, dw: Int, dh: Int): RgbImage {
        require(x0 in 0 until x1 && x1 <= width && y0 in 0 until y1 && y1 <= height && dw > 0 && dh > 0) { "bad region $x0,$y0,$x1,$y1 -> ${dw}x$dh" }
        val sw = (x1 - x0).toDouble() / dw
        val sh = (y1 - y0).toDouble() / dh
        val out = IntArray(dw * dh)
        if (sw <= 1.5 && sh <= 1.5) {
            for (dy in 0 until dh) {
                val fy = ((dy + 0.5) * sh - 0.5 + y0).coerceIn(y0.toDouble(), (y1 - 1).toDouble())
                val ya = fy.toInt(); val yb = min(ya + 1, y1 - 1); val wy = fy - ya
                for (dx in 0 until dw) {
                    val fx = ((dx + 0.5) * sw - 0.5 + x0).coerceIn(x0.toDouble(), (x1 - 1).toDouble())
                    val xa = fx.toInt(); val xb = min(xa + 1, x1 - 1); val wx = fx - xa
                    val p00 = pixels[ya * width + xa]; val p10 = pixels[ya * width + xb]; val p01 = pixels[yb * width + xa]; val p11 = pixels[yb * width + xb]
                    var px = 0xff
                    for (shift in intArrayOf(16, 8, 0)) {
                        val top = ((p00 shr shift) and 255) * (1 - wx) + ((p10 shr shift) and 255) * wx
                        val bottom = ((p01 shr shift) and 255) * (1 - wx) + ((p11 shr shift) and 255) * wx
                        px = (px shl 8) or (top * (1 - wy) + bottom * wy + 0.5).toInt().coerceIn(0, 255)
                    }
                    out[dy * dw + dx] = px
                }
            }
        } else {
            val xs = IntArray(dw + 1) { min(x1, x0 + floor(it * sw).toInt()) }
            xs[dw] = x1
            for (dy in 0 until dh) {
                val ya = y0 + floor(dy * sh).toInt()
                val yb = max(ya + 1, if (dy == dh - 1) y1 else min(y1, y0 + ceil((dy + 1) * sh).toInt()))
                for (dx in 0 until dw) {
                    val xa = min(xs[dx], x1 - 1)
                    val xb = max(xa + 1, xs[dx + 1])
                    var r = 0L; var g = 0L; var b = 0L
                    for (y in ya until min(yb, y1)) {
                        val row = y * width
                        for (x in xa until xb) { val p = pixels[row + x]; r += (p shr 16) and 255; g += (p shr 8) and 255; b += p and 255 }
                    }
                    val n = ((min(yb, y1) - ya) * (xb - xa)).toLong()
                    out[dy * dw + dx] = (0xff shl 24) or ((r / n).toInt() shl 16) or ((g / n).toInt() shl 8) or (b / n).toInt()
                }
            }
        }
        return RgbImage(dw, dh, out)
    }

    fun crop(x0: Int, y0: Int, x1: Int, y1: Int): RgbImage = scaled(x0, y0, x1, y1, x1 - x0, y1 - y0)

    /** Turned clockwise by [quarters] × 90°. */
    fun rotated(quarters: Int): RgbImage = when (((quarters % 4) + 4) % 4) {
        1 -> RgbImage(height, width, IntArray(pixels.size).also { o -> for (y in 0 until height) for (x in 0 until width) o[x * height + (height - 1 - y)] = pixels[y * width + x] })
        2 -> RgbImage(width, height, IntArray(pixels.size).also { o -> for (i in pixels.indices) o[pixels.size - 1 - i] = pixels[i] })
        3 -> RgbImage(height, width, IntArray(pixels.size).also { o -> for (y in 0 until height) for (x in 0 until width) o[(width - 1 - x) * height + y] = pixels[y * width + x] })
        else -> this
    }

    /** Channels first (RGB, or BGR when requested), each value `(v / 255 - mean) / std`. */
    fun toChw(mean: Float, std: Float, bgr: Boolean = false): FloatArray = toChw(floatArrayOf(mean, mean, mean), floatArrayOf(std, std, std), bgr)

    fun toChw(mean: FloatArray, std: FloatArray, bgr: Boolean = false): FloatArray {
        val plane = width * height
        val out = FloatArray(3 * plane)
        for (i in 0 until plane) {
            val p = pixels[i]
            out[i] = (((p shr (if (bgr) 0 else 16)) and 255) / 255f - mean[0]) / std[0]
            out[plane + i] = (((p shr 8) and 255) / 255f - mean[1]) / std[1]
            out[2 * plane + i] = (((p shr (if (bgr) 16 else 0)) and 255) / 255f - mean[2]) / std[2]
        }
        return out
    }
}
