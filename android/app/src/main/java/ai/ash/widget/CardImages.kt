package ai.ash.widget

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.util.LruCache
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import javax.net.ssl.HttpsURLConnection

/**
 * Pictures on cards: fetched over https (never plain http) or decoded from a data: URL, cut down to what the widget
 * shows (RemoteViews carries every bitmap, and Android caps a widget's bitmap memory), and kept on disk. An image not
 * fetched yet draws a placeholder, and the widget redraws when it arrives; one that cannot be fetched stays a
 * placeholder and its card's creator is told why.
 */
object CardImages {
    private const val TAG = "ash.widgets"
    /** Longest side kept on disk; widgets never show more. */
    private const val KEEP_PX = 1024
    private const val MAX_DOWNLOAD = 15 * 1024 * 1024
    private val main = Handler(Looper.getMainLooper())
    private val fetcher = Executors.newFixedThreadPool(2) { Thread(it, "ash-card-images") }
    private val pending = ConcurrentHashMap.newKeySet<String>()
    /** url -> why it could not be fetched (kept until the app restarts, so a broken link is not fetched over and over). */
    val failed = ConcurrentHashMap<String, String>()
    private val memory = object : LruCache<String, Bitmap>(16 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
    }

    private fun dir(ctx: Context) = File(ctx.cacheDir, "card-images").apply { mkdirs() }
    private fun key(url: String) = MessageDigest.getInstance("SHA-256").digest(url.toByteArray()).joinToString("") { "%02x".format(it) }.take(40)

    /**
     * The bitmap for [img] at most [maxW] x [maxH] px, or null (draw the placeholder) while it is being fetched or
     * when it failed. [ready] runs on the main thread once a fetch ends, so the widget can redraw.
     */
    fun get(ctx: Context, img: Img, maxW: Int, maxH: Int, ready: () -> Unit): Bitmap? {
        val w = maxW.coerceIn(8, KEEP_PX); val h = maxH.coerceIn(8, KEEP_PX)
        return when (img) {
            is Img.Avatar -> WidgetHost.face(ctx, img.name)
            is Img.Path -> path(img.d, w, h)
            is Img.Url -> {
                val url = img.url
                val memKey = "$url|$w|$h"
                memory.get(memKey)?.let { return it }
                val bmp = if (url.startsWith("data:")) decodeData(url, w, h) else {
                    val file = File(dir(ctx), key(url))
                    if (file.isFile) decodeFile(file, w, h) else { fetch(ctx.applicationContext, url, file, ready); null }
                }
                bmp?.also { memory.put(memKey, it) }
            }
        }
    }

    private fun sample(srcW: Int, srcH: Int, w: Int, h: Int): Int {
        var s = 1
        while (srcW / (s * 2) >= w && srcH / (s * 2) >= h) s *= 2
        return s
    }

    /** Decode no bigger than needed, then scale to fit [w] x [h] keeping the shape. */
    private fun decode(bytes: () -> ByteArray?, file: File?, w: Int, h: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        if (file != null) BitmapFactory.decodeFile(file.path, bounds) else bytes()?.let { BitmapFactory.decodeByteArray(it, 0, it.size, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val opts = BitmapFactory.Options().apply { inSampleSize = sample(bounds.outWidth, bounds.outHeight, w, h) }
        val bmp = (if (file != null) BitmapFactory.decodeFile(file.path, opts) else bytes()?.let { BitmapFactory.decodeByteArray(it, 0, it.size, opts) }) ?: return null
        val scale = minOf(1f, minOf(w.toFloat() / bmp.width, h.toFloat() / bmp.height).let { if (it <= 0f) 1f else it })
        if (scale >= 0.999f) return bmp
        return Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt().coerceAtLeast(1), (bmp.height * scale).toInt().coerceAtLeast(1), true)
    }

    private fun decodeFile(file: File, w: Int, h: Int) = runCatching { decode({ null }, file, w, h) }.getOrNull()

    private fun decodeData(url: String, w: Int, h: Int): Bitmap? = runCatching {
        val bytes = Base64.decode(url.substringAfter(','), Base64.DEFAULT)
        decode({ bytes }, null, w, h)
    }.getOrNull()

    /** Whether a data: image decodes at all (an undecodable one is a problem to report, not a pending fetch). */
    fun decodes(url: String): Boolean = decodeData(url, 16, 16) != null

    private fun fetch(app: Context, url: String, file: File, ready: () -> Unit) {
        if (failed.containsKey(url) || !pending.add(url)) return
        fetcher.execute {
            val why = runCatching { download(url, file); null }.getOrElse { it.message ?: it.javaClass.simpleName }
            pending.remove(url)
            if (why != null) { failed[url] = why; Log.w(TAG, "card image $url: $why") }
            main.post(ready)
        }
    }

    private fun download(url: String, file: File) {
        var target = URL(url)
        repeat(5) {
            if (target.protocol != "https") throw IllegalStateException("只取 https 图片（跳转到了 ${target.protocol}）")
            val conn = target.openConnection() as HttpsURLConnection
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 10_000; conn.readTimeout = 15_000
            conn.setRequestProperty("Accept", "image/png,image/jpeg,image/webp,image/gif,image/*;q=0.8")
            try {
                val code = conn.responseCode
                if (code in 300..399) { target = URL(target, conn.getHeaderField("Location") ?: throw IllegalStateException("跳转没有地址")); return@repeat }
                if (code != HttpURLConnection.HTTP_OK) throw IllegalStateException("服务器回答 HTTP $code")
                if (conn.contentLengthLong > MAX_DOWNLOAD) throw IllegalStateException("图片有 ${conn.contentLengthLong / 1024 / 1024} MB，超过 15 MB")
                val out = ByteArrayOutputStream()
                conn.inputStream.use { input ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        if (out.size() > MAX_DOWNLOAD) throw IllegalStateException("图片超过 15 MB")
                    }
                }
                val bytes = out.toByteArray()
                // Keep a copy no bigger than a widget ever shows.
                val bmp = decode({ bytes }, null, KEEP_PX, KEEP_PX)
                    ?: throw IllegalStateException(if (String(bytes, 0, minOf(bytes.size, 200)).contains("<svg")) "是 SVG，手机小组件画不了" else "不是手机能解码的图片（PNG/JPEG/WebP/GIF）")
                val tmp = File(file.path + ".tmp")
                tmp.outputStream().use { bmp.compress(if (bmp.hasAlpha()) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, 90, it) }
                if (!tmp.renameTo(file)) throw IllegalStateException("存不下图片")
                return
            } finally { conn.disconnect() }
        }
        throw IllegalStateException("跳转太多次")
    }

    /** An icon path, white on transparent (the widget tints it), fitted into [w] x [h]. */
    private fun path(d: String, w: Int, h: Int): Bitmap? = runCatching {
        val ops = SvgPath.parse(d)
        val b = SvgPath.bounds(ops)
        // A2UI icon paths are drawn on a 24-unit square, like Material icons; a larger path is fitted as a whole.
        val box = if (b[0] >= 0 && b[1] >= 0 && b[2] <= 24.5f && b[3] <= 24.5f) floatArrayOf(0f, 0f, 24f, 24f) else b
        val p = Path()
        for (op in ops) when (op) {
            is PathOp.Move -> p.moveTo(op.x, op.y)
            is PathOp.Line -> p.lineTo(op.x, op.y)
            is PathOp.Cubic -> p.cubicTo(op.x1, op.y1, op.x2, op.y2, op.x, op.y)
            is PathOp.Quad -> p.quadTo(op.x1, op.y1, op.x, op.y)
            PathOp.Close -> p.close()
        }
        val side = minOf(w, h)
        val scale = side / maxOf(box[2] - box[0], box[3] - box[1], 1f)
        p.transform(Matrix().apply { setTranslate(-box[0], -box[1]); postScale(scale, scale) })
        Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888).also { Canvas(it).drawPath(p, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }) }
    }.getOrNull()
}
