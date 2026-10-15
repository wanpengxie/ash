package ai.ash.ui

import ai.ash.R
import ai.ash.caps.camera.CaptureProvider
import ai.ash.ui.design.AshPage
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.Role
import android.animation.ValueAnimator
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Outline
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.MediaStore
import android.util.LruCache
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.webkit.MimeTypeMap
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Attachments and files in the chat, drawn natively (what the web page's attach-menu.js, attachments.js, files.js and the file
 * parts of conversation.js and cards.js did):
 *  - 「+」: a sheet of four ways to attach (camera, video, gallery, files); what is chosen is read, shrunk if it is a still picture,
 *    and handed back as the `attachments` of a `say` ([Uploads] has the rules);
 *  - an attachment in a message: a chip that opens the file on its body, or reads an inline one from the ledger when tapped
 *    (a picture shows right under its chip, tap it to see it large; anything else opens in the viewer);
 *  - a file / image card;
 *  - the viewer ([viewer]) and the system's file picker to save a file ([save]).
 * Reads go through [port]; every callback is on the main thread. The host forwards [onActivityResult].
 */
class ChatFiles(private val activity: Activity, private val port: HumanPort) : ChatHooks.Files {
    private val access = FileAccess(port)
    /** The file viewer: open a file / folder / link; the home pages' 「她的文件」 uses it too. */
    val viewer = FileViewer(activity, access, ::save)

    private class Saving(val name: String, val bytes: ByteArray, val done: (Boolean?) -> Unit)
    private var picking: ((JSONArray) -> Unit)? = null
    private var captureFile: File? = null
    private var saving: Saving? = null

    /** An inline picture the owner has opened, kept so a redrawn message shows it again without another read. */
    private class Opened(val name: String, val mime: String, val bytes: ByteArray, val thumb: Bitmap?)
    private val opened = object : LruCache<String, Opened>(16 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Opened) = value.bytes.size + (value.thumb?.byteCount ?: 0)
    }

    /** The small pictures of image cards (a file's bytes are not kept, only its [THUMB_PX] picture), and what is being read or has just failed. */
    private val cardThumbs = object : LruCache<String, Bitmap>(12 * 1024 * 1024) { override fun sizeOf(key: String, value: Bitmap) = value.byteCount }
    private val cardLoading = HashMap<String, MutableList<(Bitmap?) -> Unit>>()
    private val cardFailed = HashMap<String, Long>()

    // ---------- 「+」 ----------

    override fun pick(done: (JSONArray) -> Unit) {
        answer(JSONArray())
        picking = done
        var chosen = false
        val (dialog, frame) = AshDialogs.make(activity, opaque = false)
        fun launch(choice: Choice) { chosen = true; dialog.dismiss(); start(choice) }
        val sheet = sheet({ launch(it) }, { dialog.dismiss() })
        frame.addView(sheet.first, FrameLayout.LayoutParams(-1, -1))
        dialog.setOnDismissListener { if (!chosen) answer(JSONArray()) }
        dialog.show()
        sheet.second()
    }

    private enum class Choice(val label: String, val icon: Int) {
        PHOTO("拍照", R.drawable.ash_ic_camera), VIDEO("录像", R.drawable.ash_ic_video), GALLERY("相册", R.drawable.ash_ic_image), FILE("文件", R.drawable.ash_ic_file)
    }

    /** The layer (scrim + sheet) and a function that slides it up; a tap on the scrim closes the dialog. */
    private fun sheet(onChoice: (Choice) -> Unit, onClose: () -> Unit): Pair<View, () -> Unit> {
        val c = AshUi.p(activity)
        val grid = AshUi.hstack(activity, AshTokens.Space.sm - 2).apply {
            setPadding(0, AshUi.dp(activity, 6), 0, AshUi.dp(activity, 4)); gravity = Gravity.TOP
            for (choice in Choice.values()) addView(AshUi.vstack(activity, 8).apply {
                gravity = Gravity.CENTER_HORIZONTAL; isClickable = true; minimumHeight = AshUi.dp(activity, AshTokens.Size.touch)
                contentDescription = choice.label
                addView(FrameLayout(activity).apply {
                    background = AshUi.rounded(c.surface2, AshUi.dpF(activity, AshTokens.Radius.lg.toFloat()))
                    addView(View(activity).apply { background = AshPage.icon(activity, choice.icon).apply { setTint(c.text) } },
                        FrameLayout.LayoutParams(AshUi.dp(activity, 26), AshUi.dp(activity, 26), Gravity.CENTER))
                }, LinearLayout.LayoutParams(AshUi.dp(activity, 60), AshUi.dp(activity, 60)))
                addView(AshUi.text(activity, choice.label, AshType(13f, 18f, 400, Role.TEXT)).apply { gravity = Gravity.CENTER }, LinearLayout.LayoutParams(-1, -2))
                setOnClickListener { onChoice(choice) }
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
        val box = AshUi.vstack(activity, 12).apply {
            background = AshUi.sheetBackground(activity); elevation = AshUi.dpF(activity, 12f); isClickable = true
            setPadding(AshUi.dp(activity, AshTokens.Space.md), AshUi.dp(activity, 14), AshUi.dp(activity, AshTokens.Space.md), AshUi.dp(activity, 28))
            contentDescription = "添加附件"
            addView(View(activity).apply { background = AshUi.rounded(c.line2, AshUi.dpF(activity, 3f)) },
                LinearLayout.LayoutParams(AshUi.dp(activity, 36), AshUi.dp(activity, 5)).apply { gravity = Gravity.CENTER_HORIZONTAL })
            addView(grid)
            addView(AshUi.text(activity, "一条消息最多带约 3 MB", AshTokens.Type.caption))
        }
        val scrim = View(activity).apply { setBackgroundColor(c.scrim); isClickable = true }
        val layer = FrameLayout(activity).apply {
            addView(scrim, FrameLayout.LayoutParams(-1, -1))
            addView(box, FrameLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
        }
        val base = AshUi.dp(activity, 28)
        ViewCompat.setOnApplyWindowInsetsListener(layer) { _, insets ->
            box.setPadding(box.paddingLeft, box.paddingTop, box.paddingRight, base + insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom)
            insets
        }
        val rise = {
            ViewCompat.requestApplyInsets(layer)
            if (AshUi.motionOn(activity)) {
                scrim.alpha = 0f; box.visibility = View.INVISIBLE
                box.post {
                    box.translationY = box.height.toFloat(); box.visibility = View.VISIBLE
                    ValueAnimator.ofFloat(0f, 1f).apply {
                        duration = AshTokens.Motion.sheet; interpolator = AshTokens.Motion.easing()
                        addUpdateListener { box.translationY = box.height * (1f - it.animatedValue as Float); scrim.alpha = it.animatedValue as Float }
                        start()
                    }
                }
            }
        }
        scrim.setOnClickListener {
            if (!AshUi.motionOn(activity)) return@setOnClickListener onClose()
            scrim.isClickable = false
            ValueAnimator.ofFloat(0f, 1f).apply {
                duration = AshTokens.Motion.sheet; interpolator = AshTokens.Motion.easing()
                addUpdateListener { box.translationY = box.height * it.animatedValue as Float; scrim.alpha = 1f - it.animatedValue as Float }
                addListener(object : android.animation.AnimatorListenerAdapter() { override fun onAnimationEnd(a: android.animation.Animator) { onClose() } })
                start()
            }
        }
        return layer to rise
    }

    private fun answer(attachments: JSONArray) {
        val cb = picking ?: return
        picking = null
        cb(attachments)
    }

    private fun start(choice: Choice) {
        val launched = when (choice) {
            Choice.PHOTO -> capture(video = false) || gallery(images = true, videos = false, multiple = false)
            Choice.VIDEO -> capture(video = true) || gallery(images = false, videos = true, multiple = false)
            Choice.GALLERY -> gallery(images = true, videos = true, multiple = true)
            Choice.FILE -> files()
        }
        if (!launched) { toast("手机上找不到可用的选择器"); answer(JSONArray()) }
    }

    /** The system camera writes one photo or video into Ash's capture folder; it is then sent as a chosen file. */
    private fun capture(video: Boolean): Boolean {
        val file = CaptureProvider.newFile(activity, if (video) "video" else "photo", if (video) "mp4" else "jpg")
        val uri = CaptureProvider.uriFor(activity, file)
        val intent = Intent(if (video) MediaStore.ACTION_VIDEO_CAPTURE else MediaStore.ACTION_IMAGE_CAPTURE)
            .putExtra(MediaStore.EXTRA_OUTPUT, uri).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        intent.clipData = ClipData.newRawUri(if (video) "video" else "photo", uri)
        // A message carries about 3 MB: the camera stops there instead of recording what could not be sent.
        if (video) intent.putExtra(MediaStore.EXTRA_SIZE_LIMIT, (Uploads.MAX_SEND_BYTES - 128 * 1024).toLong())
        return try {
            activity.startActivityForResult(intent, REQ_CAPTURE); captureFile = file; true
        } catch (e: ActivityNotFoundException) { file.delete(); false } catch (e: SecurityException) { file.delete(); false }
    }

    private fun gallery(images: Boolean, videos: Boolean, multiple: Boolean): Boolean {
        if (Build.VERSION.SDK_INT >= 33) {
            val pick = Intent(MediaStore.ACTION_PICK_IMAGES).apply {
                if (images && !videos) type = "image/*" else if (videos && !images) type = "video/*"
                if (multiple) putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, minOf(Uploads.MAX_ATTACHMENTS, MediaStore.getPickImagesMaxLimit()))
            }
            try { activity.startActivityForResult(pick, REQ_PICK); return true } catch (e: ActivityNotFoundException) { /* the system picker below */ }
        }
        val kinds = listOfNotNull("image/*".takeIf { images }, "video/*".takeIf { videos })
        val pick = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE)
        if (kinds.size == 1) pick.type = kinds[0] else { pick.type = "*/*"; pick.putExtra(Intent.EXTRA_MIME_TYPES, kinds.toTypedArray()) }
        if (multiple) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        return try { activity.startActivityForResult(Intent.createChooser(pick, "选择"), REQ_PICK); true } catch (e: ActivityNotFoundException) { false }
    }

    private fun files(): Boolean {
        val pick = Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        return try { activity.startActivityForResult(Intent.createChooser(pick, "选择文件"), REQ_PICK); true } catch (e: ActivityNotFoundException) { false }
    }

    // ---------- results ----------

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        when (requestCode) {
            REQ_PICK -> {
                val uris = LinkedHashSet<Uri>()
                if (resultCode == Activity.RESULT_OK && data != null) {
                    // Several files come as ClipData; a single one may come as data (or both, on some pickers).
                    data.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) } }
                    data.data?.let { uris.add(it) }
                }
                read(uris.toList())
            }
            REQ_CAPTURE -> finishCapture(resultCode, data)
            REQ_SAVE -> finishSave(resultCode, data?.data)
            else -> return false
        }
        return true
    }

    private fun finishCapture(resultCode: Int, data: Intent?) {
        val file = captureFile
        captureFile = null
        if (resultCode == Activity.RESULT_OK && file != null && file.length() == 0L) {
            // A camera app that ignored the output file may still hand back a small photo.
            @Suppress("DEPRECATION") val thumb = data?.extras?.get("data") as? Bitmap
            if (thumb != null) runCatching { file.outputStream().use { thumb.compress(Bitmap.CompressFormat.JPEG, 92, it) } }
        }
        val elsewhere = data?.data?.takeIf { it.authority != "${activity.packageName}.capture" }
        val uri = when {
            resultCode != Activity.RESULT_OK -> null
            file != null && file.length() > 0 -> CaptureProvider.uriFor(activity, file)
            else -> elsewhere // a camera app that saved the video its own way
        }
        if (uri == null || uri == elsewhere) file?.delete()
        read(listOfNotNull(uri))
    }

    /** Reads and shrinks the chosen files off the main thread, then answers [pick] with those that can go (the owner is told about the rest). */
    private fun read(uris: List<Uri>) {
        if (uris.isEmpty()) { answer(JSONArray()); return }
        val resolver = activity.contentResolver
        Thread {
            val ok = JSONArray(); val refused = ArrayList<String>()
            for (uri in uris.take(Uploads.MAX_ATTACHMENTS)) when (val r = Uploads.prepare(resolver, uri)) {
                is Uploads.Result.Ok -> { ok.put(r.attachment); if (!Uploads.fits("", ok)) { ok.remove(ok.length() - 1); refused.add("附件太大：一条消息最多带约 3 MB") } }
                is Uploads.Result.Refused -> refused.add(r.why)
            }
            activity.runOnUiThread {
                refused.distinct().take(2).forEach { toast(it) }
                answer(ok)
            }
        }.start()
    }

    // ---------- saving ----------

    /** Puts [bytes] where the owner chooses (the system's file picker). [done]: true saved, false failed, null cancelled. */
    fun save(name: String, mime: String, bytes: ByteArray, done: (Boolean?) -> Unit) {
        val clean = name.substringAfterLast('/').filter { it.code >= 32 && it.code != 127 }.take(200)
        if (saving != null || clean.isEmpty() || bytes.size > MAX_SAVE_BYTES) { done(false); return }
        val type = mime.takeIf { it.matches(Regex("[a-z0-9.+-]+/[a-z0-9.+*-]+")) }
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(clean.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"
        saving = Saving(clean, bytes, done)
        try {
            activity.startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(type).putExtra(Intent.EXTRA_TITLE, clean), REQ_SAVE)
        } catch (e: Exception) { saving = null; done(false) }
    }

    private fun finishSave(resultCode: Int, uri: Uri?) {
        val job = saving ?: return
        saving = null
        if (resultCode != Activity.RESULT_OK || uri == null) { job.done(null); return }
        Thread {
            val ok = runCatching { activity.contentResolver.openOutputStream(uri, "w")?.use { it.write(job.bytes) } ?: error("destination unavailable") }.isSuccess
            activity.runOnUiThread { job.done(ok) }
        }.start()
    }

    // ---------- in a message ----------

    override fun attachment(item: JSONObject, attachment: JSONObject, mine: Boolean): View? {
        val name = attachment.optString("name").ifEmpty { "附件" }
        val index = attachment.optInt("index", -1)
        if (attachment.optString("source") == "inline" && index >= 0) return inlineAttachment(item, attachment, name, index)
        val ref = FileLinks.ref(attachment.optString("workspace"), attachment.optString("path"), name) ?: return null
        return chip(name, image = looksLikeImage(name)) { viewer.open(ref) }
    }

    override fun openLink(href: String) = viewer.openLink(href)

    override fun card(item: JSONObject, card: JSONObject): View? {
        val type = card.optString("type")
        if (type != "file" && type != "image") return null
        val ref = FileLinks.ref(card.optString("workspace"), card.optString("path"), card.optString("name").ifEmpty { null }) ?: return null
        if (type == "image") return imageCard(ref, card.optString("alt"), card)
        return AshUi.card(activity, 6).apply {
            setPadding(AshUi.dp(activity, 14), AshUi.dp(activity, 10), AshUi.dp(activity, 14), AshUi.dp(activity, 10))
            addView(chip(ref.baseName.ifEmpty { "打开文件" }, image = false, framed = false) { viewer.open(ref) }, LinearLayout.LayoutParams(-1, -2))
        }
    }

    /**
     * An image card: the picture itself in the chat, and a tap opens it large in the viewer. Its box has its final size from the
     * start (the card's width and height when it gives them, else 4:3), so the picture arriving fills it and moves nothing;
     * until then (or when it cannot be read) the box shows an image glyph.
     */
    private fun imageCard(ref: FileRef, alt: String, card: JSONObject): View {
        val (w, h) = cardBox(card.optInt("width"), card.optInt("height"))
        val c = AshUi.p(activity)
        val r = AshUi.dpF(activity, AshTokens.Radius.md.toFloat())
        val box = FrameLayout(activity).apply {
            background = AshUi.rounded(c.surface2, r)
            outlineProvider = object : ViewOutlineProvider() { override fun getOutline(v: View, o: Outline) { o.setRoundRect(0, 0, v.width, v.height, r) } }
            clipToOutline = true; isClickable = true; contentDescription = alt.ifEmpty { "图片" }
            setOnClickListener { viewer.open(ref) }
            layoutParams = ViewGroup.LayoutParams(AshUi.dp(activity, w), AshUi.dp(activity, h))
        }
        val glyph = View(activity).apply { background = AshPage.icon(activity, R.drawable.ash_ic_image).apply { setTint(c.text3) } }
        box.addView(glyph, FrameLayout.LayoutParams(AshUi.dp(activity, 28), AshUi.dp(activity, 28), Gravity.CENTER))
        loadCardThumb(ref) { bitmap ->
            if (bitmap == null || glyph.parent !== box) return@loadCardThumb
            box.removeView(glyph)
            box.addView(ImageView(activity).apply { setImageBitmap(bitmap); scaleType = ImageView.ScaleType.CENTER_CROP }, FrameLayout.LayoutParams(-1, -1))
        }
        return box
    }

    /** The picture of an image card's file: from the cache, or read from its body and shrunk off the main thread. [done] gets null when it cannot be had. */
    private fun loadCardThumb(ref: FileRef, done: (Bitmap?) -> Unit) {
        val key = "${ref.workspace}|${ref.path}"
        cardThumbs.get(key)?.let { return done(it) }
        // A file that just failed is not asked for again at every redraw; the viewer (a tap) asks anyway.
        if (SystemClock.elapsedRealtime() - (cardFailed[key] ?: -RETRY_MS) < RETRY_MS) return done(null)
        cardLoading[key]?.let { it.add(done); return }
        cardLoading[key] = arrayListOf(done)
        fun finish(bitmap: Bitmap?) {
            if (bitmap != null) cardThumbs.put(key, bitmap) else cardFailed[key] = SystemClock.elapsedRealtime()
            cardLoading.remove(key)?.forEach { it(bitmap) }
        }
        val body = ref.body ?: return finish(null)
        access.read(body, ref.path) { bytes, _ ->
            if (bytes == null || bytes.data.size > FileLinks.MAX_READ_BYTES) return@read finish(null)
            Thread {
                val bitmap = runCatching { Pictures.bitmap(bytes.data, THUMB_PX) }.getOrNull()
                activity.runOnUiThread { finish(bitmap) }
            }.start()
        }
    }

    private fun looksLikeImage(name: String) = Regex(".*\\.(png|jpe?g|gif|webp|heic|avif)$", RegexOption.IGNORE_CASE).matches(name)

    /** The chip of a file: a tile with its picture or file glyph, and its name. [framed]: with the card face of an attachment. */
    private fun chip(label: String, image: Boolean, framed: Boolean = true, onClick: () -> Unit): LinearLayout {
        val c = AshUi.p(activity)
        return AshUi.hstack(activity, 10).apply {
            isClickable = true; isFocusable = true; minimumHeight = AshUi.dp(activity, AshTokens.Size.touch)
            val face = if (framed) AshUi.rounded(c.surface, AshUi.dpF(activity, 16f), c.line, AshUi.dp(activity, 1)) else GradientDrawable().apply { setColor(Color.TRANSPARENT) }
            background = RippleDrawable(ColorStateList.valueOf(AshUi.withAlpha(c.ink, 0.08f)), face, AshUi.rounded(Color.WHITE, AshUi.dpF(activity, 16f)))
            if (framed) { setPadding(AshUi.dp(activity, 12), AshUi.dp(activity, 10), AshUi.dp(activity, 12), AshUi.dp(activity, 10)); minimumWidth = AshUi.dp(activity, 220) }
            addView(FrameLayout(activity).apply {
                background = AshUi.rounded(c.youSoft, AshUi.dpF(activity, 10f))
                addView(View(activity).apply { background = AshPage.icon(activity, if (image) R.drawable.ash_ic_image else R.drawable.ash_ic_file).apply { setTint(c.youText) } },
                    FrameLayout.LayoutParams(AshUi.dp(activity, 20), AshUi.dp(activity, 20), Gravity.CENTER))
            }, LinearLayout.LayoutParams(AshUi.dp(activity, 36), AshUi.dp(activity, 36)))
            addView(AshUi.text(activity, label, AshType(14f, 20f, 400, Role.INK)), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            setOnClickListener { onClick() }
        }
    }

    /** A chip that reads the file from the ledger when tapped: a picture appears under it, anything else opens in the viewer. */
    private fun inlineAttachment(item: JSONObject, attachment: JSONObject, name: String, index: Int): View {
        val messageId = attachment.optString("message_id").ifEmpty { item.optString("id") }
        val key = "$messageId:$index"
        val box = AshUi.vstack(activity, 6)
        var thumb: View? = null
        var loading = false
        fun showPicture(o: Opened, fresh: Boolean) {
            if (thumb != null || o.thumb == null) return
            val view = thumbnail(o.thumb, "附件图片", ATTACHMENT_THUMB_W, ATTACHMENT_THUMB_H) { viewer.show(o.name, o.mime, o.bytes) }
            thumb = view
            box.addView(view)
            if (fresh && AshUi.motionOn(activity)) { view.alpha = 0f; view.animate().alpha(1f).setDuration(AshTokens.Motion.message).start() }
        }
        val chip = chip(name, image = looksLikeImage(name)) {
            if (loading) return@chip
            loading = true
            access.inline(messageId, item.optLong("seq"), index) { read, why ->
                loading = false
                val decoded = read?.let { Uploads.decodeInline(it.b64, it.mime) }
                if (read == null || decoded == null) { toast(why?.message?.ifEmpty { null } ?: "附件无法打开"); return@inline }
                if (decoded.preview) {
                    val o = Opened(read.name, read.mime, decoded.bytes, Pictures.bitmap(decoded.bytes, THUMB_PX))
                    if (o.thumb == null) { toast("附件无法打开"); return@inline }
                    opened.put(key, o); showPicture(o, fresh = true)
                } else viewer.show(read.name, read.mime, decoded.bytes)
            }
        }
        box.addView(chip)
        opened.get(key)?.let { showPicture(it, fresh = false) }
        return box
    }

    /** A picture in a message, at most [maxW] x [maxH] dp, round cornered; a tap opens it large. */
    private fun thumbnail(bitmap: Bitmap, description: String, maxW: Int, maxH: Int, onClick: () -> Unit) = ImageView(activity).apply {
        setImageBitmap(bitmap); adjustViewBounds = true; scaleType = ImageView.ScaleType.FIT_CENTER
        maxWidth = AshUi.dp(activity, maxW); maxHeight = AshUi.dp(activity, maxH)
        val r = AshUi.dpF(activity, AshTokens.Radius.md.toFloat())
        outlineProvider = object : ViewOutlineProvider() { override fun getOutline(v: View, o: Outline) { o.setRoundRect(0, 0, v.width, v.height, r) } }
        clipToOutline = true; isClickable = true; contentDescription = description
        setOnClickListener { onClick() }
    }

    private fun toast(text: String) = Toast.makeText(activity, text, Toast.LENGTH_SHORT).show()

    companion object {
        const val REQ_PICK = 7201
        const val REQ_CAPTURE = 7202
        const val REQ_SAVE = 7203
        private const val MAX_SAVE_BYTES = Uploads.MAX_FILE_BYTES
        private const val THUMB_PX = 600
        private const val ATTACHMENT_THUMB_W = 200
        private const val ATTACHMENT_THUMB_H = 150
        private const val CARD_THUMB_W = 260
        private const val CARD_THUMB_H = 200
        private const val RETRY_MS = 60_000L

        /** An image card's box in dp: the picture's own shape fitted into [CARD_THUMB_W] x [CARD_THUMB_H] (not lower than 80), or 4:3 when its size is not known. */
        fun cardBox(width: Int, height: Int): Pair<Int, Int> {
            if (width <= 0 || height <= 0) return CARD_THUMB_W to CARD_THUMB_W * 3 / 4
            val scale = minOf(CARD_THUMB_W.toFloat() / width, CARD_THUMB_H.toFloat() / height)
            return Math.round(width * scale).coerceAtLeast(80) to Math.round(height * scale).coerceAtLeast(80)
        }
    }
}
