package ai.ash.caps.perception

import ai.ash.caps.Cap
import ai.ash.caps.CapResult
import ai.ash.caps.Capability
import ai.ash.caps.Effect
import ai.ash.caps.Risk
import ai.ash.caps.media.ContainerPaths
import ai.ash.caps.prop
import ai.ash.caps.result
import ai.ash.caps.schema
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.os.Build
import android.os.Environment
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream

/**
 * What the phone can read and say without the cloud: the text in an image (PP-OCRv6 medium on ONNX Runtime) and speech
 * (the phone's own speech engine). Both are cheap enough to call often; neither sends anything off the phone, and the only
 * network use is the one-time download of the OCR models into the app's private files. Images and audio cross to the agent
 * the way the other media words do: files in shared storage.
 */
object PerceptionCapabilities {
    private val paths = ContainerPaths()
    @Volatile private var ocrEngine: OcrEngine? = null
    @Volatile private var speech: SystemTts? = null

    private fun ocr(ctx: Context): OcrEngine = ocrEngine ?: synchronized(this) {
        ocrEngine ?: OcrEngine(ctx.filesDir, { ctx.assets.open(OcrModels.DICTIONARY_ASSET).bufferedReader(Charsets.UTF_8).use { it.readText() } }).also { ocrEngine = it }
    }

    private fun tts(ctx: Context): SystemTts = speech ?: synchronized(this) { speech ?: SystemTts(ctx.applicationContext).also { speech = it } }

    private fun canRead(ctx: Context) = ctx.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED ||
        (Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager())

    private fun canWrite(ctx: Context) = ctx.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED ||
        (Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager())

    private const val ASK = "Ask the owner to allow it: show a permission card with permission \"photos\"."

    // ───────────────────────────── ocr.read ─────────────────────────────

    private val read = Cap(
        name = "ocr.read",
        description = "Read the text in an image on the phone, offline (no cloud): returns the text in reading order and each line with its box " +
            "and confidence. Give path (an image file in shared storage, /sdcard/...) or data (base64). Good for screenshots, photos of documents, " +
            "receipts and signs; one model reads Chinese, English, Japanese and many Latin-script languages together. The first call downloads the " +
            "model (about 140 MB) once, which can take minutes; later calls take a few seconds. To read the screen now, save it with screen.screenshot and pass the path.",
        schema = schema(
            "path" to prop("string", "Absolute path of the image file (shared storage, /sdcard/...)."),
            "data" to prop("string", "The image itself as base64 (about 10 MB at most), instead of path."),
            "max_side" to prop("integer", "Longest side in px the image is scaled to for finding text, 320–2048 (default 960); raise it for small text on a large image."),
            "min_score" to prop("number", "Drop lines the reader is less sure of than this, 0–1 (default 0.5)."),
        ),
        effect = Effect.READ, risk = Risk.NONE, label = "在识别图片里的字",
        result = result("text:string!", "blocks:array!", "ms:integer!", "width:integer", "height:integer"),
    ) { ctx, args ->
        PerceptionArguments.ocr(args, { a ->
            val t0 = System.nanoTime()
            val image = try { load(ctx, a) } catch (e: Failure) { return@ocr e.result }
            val (r, loadMs) = try {
                ocr(ctx).read(image, a.maxSide, a.minScore)
            } catch (e: ModelUnavailable) {
                return@ocr CapResult.error("unavailable", e.message ?: "the OCR models are not available",
                    "Check that the phone is online and has about 200 MB free, then call again; a download that stopped resumes.")
            } catch (e: UnsatisfiedLinkError) {
                return@ocr CapResult.error("unavailable", "the OCR runtime does not run on this phone (${e.message})")
            }
            val ms = (System.nanoTime() - t0) / 1_000_000
            val blocks = JSONArray()
            for (b in r.blocks) blocks.put(JSONObject().put("text", b.text).put("box", JSONArray(b.box.toList())).put("score", Math.round(b.score * 1000) / 1000.0))
            val data = JSONObject().put("text", r.text).put("blocks", blocks).put("width", r.width).put("height", r.height).put("ms", ms)
                .put("detect_ms", r.detectMs).put("recognize_ms", r.recognizeMs).put("load_ms", loadMs)
            CapResult.text(if (r.blocks.isEmpty()) "No text found in the image (${r.width}×${r.height})." else r.text, data)
        }, { CapResult.error("bad_request", it) })
    }

    /** The image to read, or a [Failure] saying why not. Larger than [MAX_DECODE] px on the long side is read at a lower size. */
    private fun load(ctx: Context, a: OcrReadArgs): RgbImage {
        if (a.data != null) {
            if (a.data.length > PerceptionArguments.MAX_IMAGE_BYTES / 3 * 4 + 16) throw Failure(CapResult.error("too_large", "the image is over 10 MB; pass a path to the file instead"))
            val bytes = runCatching { Base64.decode(a.data, Base64.DEFAULT) }.getOrNull() ?: throw Failure(CapResult.error("bad_request", "ocr.read data is not valid base64"))
            return decode({ ByteArrayInputStream(bytes) }) ?: throw Failure(CapResult.error("bad_request", "ocr.read data is not an image Android can decode"))
        }
        val file = paths.toHost(a.path!!) ?: throw Failure(CapResult.error("unavailable",
            "${a.path} is not in shared storage; the phone can only open files there (/sdcard/...). Copy the image there or pass it as data"))
        if (!file.isFile) throw Failure(CapResult.error("not_found", "no file at ${a.path}"))
        if (!file.canRead()) throw Failure(CapResult.error("forbidden", "Ash may not read ${a.path} yet (the phone's photos, videos and files permission is off). $ASK"))
        if (file.length() > MAX_FILE) throw Failure(CapResult.error("too_large", "${a.path} is ${file.length() shr 20} MB; the limit is ${MAX_FILE shr 20} MB"))
        return decode({ file.inputStream() }) ?: throw Failure(CapResult.error("bad_request", "${a.path} is not an image Android can decode"))
    }

    private class Failure(val result: CapResult) : Exception()

    private const val MAX_FILE = 30L shl 20
    private const val MAX_DECODE = 3200

    /** Pixels of the image, upright, over white where it is transparent. */
    private fun decode(open: () -> InputStream): RgbImage? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        open().use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > MAX_DECODE) sample *= 2
        var bmp: Bitmap = open().use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) } ?: return null
        val degrees = runCatching {
            open().use { input ->
                when (ExifInterface(input).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
                    ExifInterface.ORIENTATION_ROTATE_90 -> 90; ExifInterface.ORIENTATION_ROTATE_180 -> 180; ExifInterface.ORIENTATION_ROTATE_270 -> 270; else -> 0
                }
            }
        }.getOrDefault(0)
        if (degrees != 0) bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, Matrix().apply { postRotate(degrees.toFloat()) }, true)
        val px = IntArray(bmp.width * bmp.height)
        bmp.getPixels(px, 0, bmp.width, 0, 0, bmp.width, bmp.height)
        val image = RgbImage(bmp.width, bmp.height, onWhite(px))
        bmp.recycle()
        return image
    }

    /** [px] with transparent parts turned white: the reader sees ink on paper, not ink on nothing. */
    fun onWhite(px: IntArray): IntArray {
        for (i in px.indices) {
            val p = px[i]
            val a = p ushr 24
            if (a == 255) continue
            val r = (((p shr 16) and 255) * a + 255 * (255 - a)) / 255
            val g = (((p shr 8) and 255) * a + 255 * (255 - a)) / 255
            val b = ((p and 255) * a + 255 * (255 - a)) / 255
            px[i] = (0xff shl 24) or (r shl 16) or (g shl 8) or b
        }
        return px
    }

    // ───────────────────────────── tts.speak ─────────────────────────────

    private val speak = Cap(
        name = "tts.speak",
        description = "Turn text into speech on the phone, offline, with the phone's own speech engine. play true (default) says it aloud and returns when it has " +
            "finished; play false writes a WAV file in shared storage (/sdcard/Ash/tts/) and returns its path, for you to send or keep. Chinese text is spoken in " +
            "Chinese, other text in English, unless lang says otherwise. Fails with unavailable when the engine has no voice for the language.",
        schema = schema(
            "text" to prop("string", "What to say, at most 4000 characters.", required = true),
            "lang" to prop("string", "BCP 47 tag, e.g. zh-CN, en-US (default: from the text)."),
            "voice" to prop("string", "A voice name of the phone's speech engine (an unknown name returns the names it has)."),
            "rate" to prop("number", "Speed, 0.25–4 (default 1)."),
            "pitch" to prop("number", "Pitch, 0.5–2 (default 1)."),
            "play" to prop("boolean", "true (default) plays it on the phone; false writes a file instead."),
        ),
        availableIf = { ctx -> tts(ctx).installed() },
        effect = Effect.ACT, risk = Risk.NONE, label = "在念出文字",
        result = result("played:boolean!", "ms:integer!", "path:string", "mime_type:string", "bytes:integer", "duration_ms:integer", "lang:string", "voice:string", "engine:string"),
    ) { ctx, args ->
        PerceptionArguments.speak(args, { a ->
            if (a.text.length > PerceptionArguments.MAX_TEXT)
                return@speak CapResult.error("too_large", "tts.speak takes at most ${PerceptionArguments.MAX_TEXT} characters (this is ${a.text.length}); say it in parts")
            val t0 = System.currentTimeMillis()
            try {
                if (a.play) {
                    val s = tts(ctx).play(a.text, a)
                    val data = JSONObject().put("played", true).put("duration_ms", s.durationMs).put("lang", s.lang).put("ms", System.currentTimeMillis() - t0)
                        .apply { s.voice?.let { put("voice", it) }; s.engine?.let { put("engine", it) } }
                    CapResult.text("Said it aloud on the phone (${s.durationMs / 1000.0}s, ${s.lang}).", data)
                } else {
                    if (!canWrite(ctx)) return@speak CapResult.error("forbidden", "Ash may not write to shared storage yet, where the audio file would go. $ASK")
                    val dir = File(File(Environment.getExternalStorageDirectory(), "Ash"), "tts").apply { mkdirs() }
                    prune(dir)
                    val file = File(dir, "tts-${java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.ROOT).format(java.util.Date())}-${System.nanoTime() % 1000}.wav")
                    val s = tts(ctx).render(a.text, a, file)
                    val path = paths.toAgent(file) ?: file.path
                    val data = JSONObject().put("played", false).put("path", path).put("mime_type", "audio/wav").put("bytes", file.length()).put("duration_ms", s.durationMs)
                        .put("lang", s.lang).put("ms", System.currentTimeMillis() - t0).apply { s.voice?.let { put("voice", it) }; s.engine?.let { put("engine", it) } }
                    CapResult.text("Wrote ${s.durationMs / 1000.0}s of speech to $path (${file.length() / 1024} KB WAV).", data)
                }
            } catch (e: TtsFailure) {
                CapResult.error(e.code, e.message ?: "speech failed")
            }
        }, { CapResult.error("bad_request", it) })
    }

    /** Speech files older than a day are removed on the way, so the folder does not fill up. */
    private fun prune(dir: File) {
        val cutoff = System.currentTimeMillis() - 24 * 3_600_000L
        dir.listFiles { f -> f.isFile && f.name.startsWith("tts-") && f.lastModified() < cutoff }?.forEach { it.delete() }
    }

    val list: List<Capability> = listOf(read, speak)
}
