package ai.ash.host.cap

import ai.ash.host.AppState
import ai.ash.host.Notifications
import ai.ash.host.Paths
import ai.ash.host.media.CameraActivity
import ai.ash.host.media.CameraRequest
import ai.ash.host.media.CameraRequests
import ai.ash.host.media.CaptureProvider
import ai.ash.host.system.Launcher
import android.Manifest
import android.content.ContentResolver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.util.Base64
import android.util.Size
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The owner's photos, videos and audio through Android's media store, the gallery, and the camera. Reading needs the
 * storage permission the owner grants once ("photos" in Ash's permission guide); nothing here asks per call.
 * Files are handed to the agent as paths in its own environment: shared storage is visible there as-is, anything
 * else is copied into its workspace's media/ folder.
 */
object MediaCapabilities {
    private const val ASK = "Ask the owner to allow it: show a permission card with permission \"photos\"."

    private fun canRead(ctx: Context) = granted(ctx, Manifest.permission.READ_EXTERNAL_STORAGE) ||
        (Build.VERSION.SDK_INT >= 30 && Environment.isExternalStorageManager())

    private fun granted(ctx: Context, p: String) = ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun denied(what: String) = CapResult.error("permission_denied", "Ash may not $what yet (the phone's photos, videos and files permission is off). $ASK")

    private fun paths(ctx: Context): ContainerPaths {
        val root = Paths(ctx).containerRoot
        return ContainerPaths(File(root, "ubuntu"), File(root, "tmp"))
    }

    private fun iso(ms: Long) = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.ROOT).format(Date(ms))

    private val PROJECTION = with(MediaArguments) { arrayOf(ID, NAME, MIME, SIZE, TAKEN, ADDED, WIDTH, HEIGHT, DURATION, ALBUM, MEDIA_TYPE, DATA, ORIENTATION) }

    private fun files(): Uri = MediaStore.Files.getContentUri("external")

    private fun base(kind: MediaKind): Uri = when (kind) {
        MediaKind.IMAGE -> MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        MediaKind.VIDEO -> MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        MediaKind.AUDIO -> MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
    }

    /** One media store row, read by column name (a phone may leave any of them out). */
    private class Row(c: Cursor) {
        private fun long(c: Cursor, n: String): Long? = c.getColumnIndex(n).takeIf { it >= 0 && !c.isNull(it) }?.let { c.getLong(it) }
        private fun str(c: Cursor, n: String): String? = c.getColumnIndex(n).takeIf { it >= 0 && !c.isNull(it) }?.let { c.getString(it) }
        val id = long(c, MediaArguments.ID) ?: 0L
        val kind = long(c, MediaArguments.MEDIA_TYPE)?.let { MediaKind.of(it.toInt()) }
        val name = str(c, MediaArguments.NAME) ?: ""
        val mime = str(c, MediaArguments.MIME) ?: ""
        val size = long(c, MediaArguments.SIZE) ?: 0L
        val taken = MediaArguments.takenMs(long(c, MediaArguments.TAKEN), long(c, MediaArguments.ADDED))
        val added = long(c, MediaArguments.ADDED)?.times(1000)
        val width = long(c, MediaArguments.WIDTH) ?: 0L
        val height = long(c, MediaArguments.HEIGHT) ?: 0L
        val duration = long(c, MediaArguments.DURATION) ?: 0L
        val album = str(c, MediaArguments.ALBUM)
        val data = str(c, MediaArguments.DATA)
        val orientation = (long(c, MediaArguments.ORIENTATION) ?: 0L).toInt()
    }

    private fun Row.uri(): Uri? = kind?.let { ContentUris.withAppendedId(base(it), id) }

    /** The container path of the row's file when the agent can open it in place (shared storage, readable now). */
    private fun Row.inPlace(paths: ContainerPaths): String? {
        val f = data?.let { File(it) } ?: return null
        return paths.toAgent(f)?.takeIf { it.startsWith(paths.storage) && f.canRead() }
    }

    private fun Row.json(paths: ContainerPaths): JSONObject = JSONObject().apply {
        put("id", id); put("type", kind?.word ?: "other"); put("name", name); put("mime_type", mime); put("size", size)
        taken?.let { put("taken", iso(it)); put("taken_ms", it) }
        added?.let { put("added_ms", it) }
        if (width > 0 && height > 0) { put("width", width); put("height", height) }
        if (orientation != 0) put("orientation", orientation)
        if (duration > 0) put("duration_ms", duration)
        album?.let { put("album", it) }
        uri()?.let { put("uri", it.toString()) }
        inPlace(paths)?.let { put("path", it) }
    }

    /** Pages through the media store: limit and offset go to the provider when it honours them, else are applied here. */
    private fun query(ctx: Context, q: MediaQuery, limit: Int, offset: Int, block: (Row) -> Unit) {
        fun run(sort: String): Cursor? = if (Build.VERSION.SDK_INT >= 26) {
            ctx.contentResolver.query(files(), PROJECTION, Bundle().apply {
                putString(ContentResolver.QUERY_ARG_SQL_SELECTION, q.selection)
                putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, q.args)
                putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, sort)
                putInt(ContentResolver.QUERY_ARG_LIMIT, limit)
                putInt(ContentResolver.QUERY_ARG_OFFSET, offset)
            }, null)
        } else ctx.contentResolver.query(files(), PROJECTION, q.selection, q.args, sort)
        // A phone whose media store refuses the sort expression still answers in the order things were added.
        val cursor = try { run(q.sortOrder) } catch (e: IllegalArgumentException) { run(q.plainSort) } catch (e: android.database.sqlite.SQLiteException) { run(q.plainSort) }
            ?: throw IllegalStateException("the media store is unavailable")
        cursor.use { c ->
            val honored = if (Build.VERSION.SDK_INT >= 26) c.extras?.getStringArray(ContentResolver.EXTRA_HONORED_ARGS)?.toSet().orEmpty() else emptySet()
            val skip = if (Build.VERSION.SDK_INT >= 26 && ContentResolver.QUERY_ARG_OFFSET in honored) 0 else offset
            if (skip > 0 && !c.moveToPosition(skip - 1)) return
            var n = 0
            while (n < limit && c.moveToNext()) { block(Row(c)); n++ }
        }
    }

    private fun one(ctx: Context, id: Long): Row? {
        var row: Row? = null
        query(ctx, MediaQuery("${MediaArguments.ID} = ?", arrayOf(id.toString()), "${MediaArguments.ID} ASC", "${MediaArguments.ID} ASC"), 1, 0) { row = it }
        return row
    }

    // ───────────────────────────── media.list / media.albums ─────────────────────────────

    private val listMedia = Cap(
        name = "media.list",
        description = "List the owner's photos, videos and audio on the phone (the gallery and other media), newest first. Filter by type, " +
            "time (taken, else added), album and text in the file name; page with limit/offset. Each item has id (for media.read), name, " +
            "type, size, taken time, width/height, duration, album, content uri, and path when your environment can open the file " +
            "directly. with_location also reads where a photo was taken, when the photo records it. Needs the phone's photos permission.",
        schema = schema(
            "type" to prop("string", "image, video, audio or any (default any).", enum = listOf("image", "video", "audio", "any")),
            "since_ms" to prop("integer", "Only items taken at or after this Unix time in milliseconds."),
            "until_ms" to prop("integer", "Only items taken before this Unix time in milliseconds."),
            "album" to prop("string", "Only this album (folder name as media.albums lists it, e.g. Camera, Screenshots, WeiXin)."),
            "name" to prop("string", "Only items whose file name contains this text."),
            "order" to prop("string", "newest (default) or oldest first.", enum = listOf("newest", "oldest")),
            "limit" to prop("integer", "Items per page, 1–100 (default 30)."),
            "offset" to prop("integer", "Items to skip (next_offset from the previous page)."),
            "with_location" to prop("boolean", "Also return latitude/longitude of photos that record it (slower)."),
        ),
    ) { ctx, args ->
        MediaArguments.list(args, { a ->
            if (!canRead(ctx)) return@list denied("read the owner's photos and videos")
            val paths = paths(ctx)
            val items = JSONArray()
            val lines = mutableListOf<String>()
            var more = false
            query(ctx, MediaArguments.query(a), a.limit + 1, a.offset) { r ->
                if (items.length() == a.limit) { more = true; return@query }
                val o = r.json(paths)
                if (a.withLocation && r.kind == MediaKind.IMAGE) location(ctx, r.uri())?.let { o.put("latitude", it[0]).put("longitude", it[1]) }
                items.put(o)
                lines += listOfNotNull("id ${r.id}", r.name, r.taken?.let { iso(it) },
                    if (r.width > 0) "${r.width}×${r.height}" else null, if (r.duration > 0) "${r.duration / 1000}s" else null, r.album).joinToString(" · ")
            }
            val data = JSONObject().put("items", items).put("count", items.length())
            if (more) data.put("next_offset", a.offset + a.limit)
            val head = if (items.length() == 0) "No media matches." else "${items.length()} items" + if (more) " (more: offset ${a.offset + a.limit})" else ""
            CapResult.text(head + lines.joinToString("") { "\n$it" }, data)
        }, CapResult::fail)
    }

    private val albums = Cap(
        name = "media.albums",
        description = "The albums (folders) the owner's photos, videos and audio are in, with how many items each holds and the newest " +
            "item's time, largest first. Use a name with media.list album. Needs the phone's photos permission.",
        schema = schema("type" to prop("string", "image, video, audio or any (default any).", enum = listOf("image", "video", "audio", "any"))),
    ) { ctx, args ->
        MediaArguments.albums(args, { a ->
            if (!canRead(ctx)) return@albums denied("read the owner's photos and videos")
            class Album(var count: Int = 0, var latest: Long = 0, val kinds: MutableMap<String, Int> = mutableMapOf())
            val all = linkedMapOf<String, Album>()
            val q = MediaArguments.query(MediaListArgs(a.kinds, null, null, null, null, true, 1, 0, false))
            query(ctx, q, Int.MAX_VALUE, 0) { r ->
                val album = all.getOrPut(r.album ?: "") { Album() }
                album.count++
                r.taken?.let { if (it > album.latest) album.latest = it }
                r.kind?.let { album.kinds[it.word] = (album.kinds[it.word] ?: 0) + 1 }
            }
            val sorted = all.entries.sortedByDescending { it.value.count }
            val arr = JSONArray()
            for ((name, v) in sorted) arr.put(JSONObject().put("album", name).put("count", v.count).put("types", JSONObject(v.kinds as Map<*, *>))
                .apply { if (v.latest > 0) put("latest", iso(v.latest)) })
            val text = if (sorted.isEmpty()) "No media on the phone." else sorted.joinToString("\n") { (n, v) -> "${n.ifEmpty { "(no album)" }} · ${v.count}" }
            CapResult.text(text, JSONObject().put("albums", arr))
        }, CapResult::fail)
    }

    // ───────────────────────────── media.read ─────────────────────────────

    private val read = Cap(
        name = "media.read",
        description = "Open one item from media.list by id. A photo comes back as an image you can look at (scaled so its long side " +
            "is at most max_size px) with its details, and a JPEG of that size is put in your workspace (path). A video comes back " +
            "with one frame as an image; video and audio files come with a path you can process with your own tools (a file in " +
            "shared storage is opened in place, anything else is copied into your workspace's media/ folder). copy: true also copies " +
            "the original photo there. Needs the phone's photos permission.",
        schema = schema(
            "id" to prop("integer", "The item's id from media.list.", required = true),
            "max_size" to prop("integer", "Longest side of the returned image in px, 256–2048 (default 1280)."),
            "copy" to prop("boolean", "Also hand over the original file (a copy in your workspace, even if it is in shared storage)."),
        ),
    ) { ctx, args ->
        MediaArguments.read(args, { a ->
            if (!canRead(ctx)) return@read denied("read the owner's photos and videos")
            val r = one(ctx, a.id) ?: return@read CapResult.fail("no media item with id ${a.id} (ids come from media.list)")
            val kind = r.kind ?: return@read CapResult.fail("item ${a.id} is not a photo, video or audio file")
            val uri = r.uri()!!
            val paths = paths(ctx)
            val meta = r.json(paths)
            when (kind) {
                MediaKind.IMAGE -> {
                    val bmp = decode(ctx, uri, a.maxSize, r.orientation) ?: return@read CapResult.fail("cannot decode ${r.name} as an image")
                    val jpeg = jpeg(bmp)
                    val stem = MediaArguments.safeName(r.name.substringBeforeLast('.'))
                    val preview = File(paths.exchange.apply { mkdirs() }, "${r.id}-$stem-${bmp.width}.jpg").apply { writeBytes(jpeg) }
                    meta.put("path", paths.toAgent(preview)).put("image_width", bmp.width).put("image_height", bmp.height)
                    r.inPlace(paths)?.let { meta.put("original_path", it) }
                    if (a.copy) meta.put("original_path", handOver(ctx, paths, r, uri, copy = true))
                    location(ctx, uri)?.let { meta.put("latitude", it[0]).put("longitude", it[1]) }
                    CapResult.textAndImage(caption(r, meta), Base64.encodeToString(jpeg, Base64.NO_WRAP), "image/jpeg", meta)
                }
                else -> {
                    meta.put("path", handOver(ctx, paths, r, uri, a.copy))
                    val frame = if (kind == MediaKind.VIDEO) runCatching { frame(ctx, uri, a.maxSize) }.getOrNull() else null
                    if (frame == null) CapResult.text(caption(r, meta), meta)
                    else CapResult.textAndImage(caption(r, meta), Base64.encodeToString(jpeg(frame), Base64.NO_WRAP), "image/jpeg", meta)
                }
            }
        }, CapResult::fail)
    }

    private fun caption(r: Row, meta: JSONObject): String = listOfNotNull(
        "${r.kind?.word ?: "file"} ${r.id}: ${r.name}", r.taken?.let { "taken ${iso(it)}" }, r.album?.let { "album $it" },
        if (r.width > 0) "${r.width}×${r.height}" else null, if (r.duration > 0) "${r.duration / 1000}s" else null,
        "${r.size / 1024} KB", meta.optString("path").takeIf { it.isNotEmpty() }?.let { "path $it" },
        meta.optString("original_path").takeIf { it.isNotEmpty() }?.let { "original $it" },
    ).joinToString(" · ")

    /** A container path for the row's file: in place in shared storage, or a copy in the workspace's media/ folder. */
    private fun handOver(ctx: Context, paths: ContainerPaths, r: Row, uri: Uri, copy: Boolean): String {
        if (!copy) r.inPlace(paths)?.let { return it }
        val dir = paths.exchange.apply { mkdirs() }
        val dest = File(dir, "${r.id}-${MediaArguments.safeName(r.name)}")
        if (dest.isFile && dest.length() == r.size && r.size > 0) return paths.toAgent(dest)!!
        if (r.size > 0 && r.size > dir.usableSpace - 200L * 1024 * 1024) throw IllegalStateException("not enough free space on the phone to copy ${r.name} (${r.size / 1_000_000} MB)")
        val temp = File(dir, ".${dest.name}.part")
        (ctx.contentResolver.openInputStream(uri) ?: throw IllegalStateException("cannot open ${r.name}")).use { input -> temp.outputStream().use { input.copyTo(it) } }
        if (!temp.renameTo(dest)) { temp.delete(); throw IllegalStateException("cannot write ${dest.name}") }
        return paths.toAgent(dest)!!
    }

    /** Latitude and longitude a photo records, when the owner's permission lets Ash see it (Android hides it otherwise). */
    private fun location(ctx: Context, uri: Uri?): DoubleArray? {
        uri ?: return null
        return runCatching {
            val original = if (Build.VERSION.SDK_INT >= 29 && granted(ctx, Manifest.permission.ACCESS_MEDIA_LOCATION)) MediaStore.setRequireOriginal(uri) else uri
            ctx.contentResolver.openInputStream(original)?.use { input ->
                val ll = FloatArray(2)
                if (ExifInterface(input).getLatLong(ll) && !(ll[0] == 0f && ll[1] == 0f)) doubleArrayOf(ll[0].toDouble(), ll[1].toDouble()) else null
            }
        }.getOrNull()
    }

    private fun decode(ctx: Context, uri: Uri, maxSize: Int, orientation: Int): Bitmap? =
        decode({ ctx.contentResolver.openInputStream(uri) }, maxSize, orientation)

    /** A bitmap whose long side is at most [maxSize], upright. */
    private fun decode(open: () -> InputStream?, maxSize: Int, orientation: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        open()?.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSize) sample *= 2
        val bmp = open()?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) } ?: return null
        return upright(scaled(bmp, maxSize), orientation)
    }

    private fun scaled(src: Bitmap, maxSize: Int): Bitmap {
        val long = maxOf(src.width, src.height)
        if (long <= maxSize) return src
        val s = maxSize.toFloat() / long
        return Bitmap.createScaledBitmap(src, maxOf(1, Math.round(src.width * s)), maxOf(1, Math.round(src.height * s)), true)
    }

    private fun upright(src: Bitmap, degrees: Int): Bitmap {
        if (degrees % 360 == 0) return src
        return Bitmap.createBitmap(src, 0, 0, src.width, src.height, Matrix().apply { postRotate(degrees.toFloat()) }, true)
    }

    private fun frame(ctx: Context, uri: Uri, maxSize: Int): Bitmap? {
        if (Build.VERSION.SDK_INT >= 29) return ctx.contentResolver.loadThumbnail(uri, Size(maxSize, maxSize), null)
        val m = MediaMetadataRetriever()
        return try { m.setDataSource(ctx, uri); m.frameAtTime?.let { scaled(it, maxSize) } } finally { m.release() }
    }

    /** JPEG bytes, lowering quality until they are a reasonable size. */
    private fun jpeg(b: Bitmap): ByteArray {
        var bytes = ByteArray(0)
        for (q in intArrayOf(80, 65, 50, 35)) {
            bytes = ByteArrayOutputStream().also { b.compress(Bitmap.CompressFormat.JPEG, q, it) }.toByteArray()
            if (bytes.size <= 900_000) break
        }
        return bytes
    }

    private fun exifDegrees(file: File): Int = runCatching {
        when (ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90; ExifInterface.ORIENTATION_ROTATE_180 -> 180; ExifInterface.ORIENTATION_ROTATE_270 -> 270; else -> 0
        }
    }.getOrDefault(0)

    // ───────────────────────────── media.save ─────────────────────────────

    private val save = Cap(
        name = "media.save",
        description = "Save a photo or video into the owner's gallery (Pictures/<album> or Movies/<album>, album default Ash) so it " +
            "shows up in the phone's Photos app. Give path (a file in your environment, e.g. /root/work/out.jpg, or in shared " +
            "storage at /sdcard/...) or data (base64, up to about 10 MB). Returns the gallery item's content uri.",
        schema = schema(
            "path" to prop("string", "Absolute path of the image or video file in your environment."),
            "data" to prop("string", "The file itself as base64, instead of path."),
            "name" to prop("string", "File name in the gallery (default: the file's own name, or ash-<time>)."),
            "mime_type" to prop("string", "image/... or video/... (default: from the name or the bytes)."),
            "album" to prop("string", "Folder under Pictures or Movies (default Ash)."),
        ),
    ) { ctx, args ->
        MediaArguments.save(args, { a ->
            val paths = paths(ctx)
            val source: File? = a.path?.let { p ->
                paths.toHost(p)?.takeIf { it.isFile } ?: return@save CapResult.fail("media.save: $p is not a file in your environment")
            }
            val bytes = a.data?.let { runCatching { Base64.decode(it, Base64.DEFAULT) }.getOrNull() ?: return@save CapResult.fail("media.save: data is not valid base64") }
            if (bytes != null && bytes.isEmpty()) return@save CapResult.fail("media.save: data is empty")
            if (source != null && !source.canRead())
                return@save if (source.path.startsWith(paths.storage)) denied("read ${a.path}") else CapResult.fail("media.save: cannot read ${a.path}")
            val head = bytes?.copyOf(minOf(bytes.size, 16)) ?: source!!.inputStream().use { s -> ByteArray(16).let { b -> b.copyOf(maxOf(0, s.read(b))) } }
            val mime = a.mime ?: a.name?.let { MediaArguments.mimeOf(it) } ?: source?.let { MediaArguments.mimeOf(it.name) } ?: MediaArguments.sniff(head)
                ?: return@save CapResult.fail("media.save: cannot tell whether this is an image or a video; give mime_type")
            if (!mime.startsWith("image/") && !mime.startsWith("video/")) return@save CapResult.fail("media.save saves images and videos only ($mime)")
            var name = a.name ?: source?.name?.let { MediaArguments.safeName(it) } ?: "ash-${System.currentTimeMillis()}"
            if (MediaArguments.mimeOf(name) == null) name += "." + MediaArguments.extensionFor(mime)
            val video = mime.startsWith("video/")
            val open: () -> InputStream = { bytes?.inputStream() ?: source!!.inputStream() }
            try {
                val saved = if (Build.VERSION.SDK_INT >= 29) insert(ctx, name, mime, video, a.album, open) else legacySave(ctx, name, video, a.album, open)
                val folder = "${if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES}/${a.album}"
                val data = JSONObject().put("uri", saved.toString()).put("name", name).put("mime_type", mime).put("folder", folder)
                CapResult.text("Saved to the gallery: $folder/$name ($saved)", data)
            } catch (e: SecurityException) {
                denied("save to the gallery")
            }
        }, CapResult::fail)
    }

    private fun insert(ctx: Context, name: String, mime: String, video: Boolean, album: String, open: () -> InputStream): Uri {
        val collection = if (video) MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            else MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(MediaStore.MediaColumns.RELATIVE_PATH, "${if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES}/$album")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = ctx.contentResolver.insert(collection, values) ?: throw IllegalStateException("the gallery did not accept the file")
        try {
            (ctx.contentResolver.openOutputStream(uri, "w") ?: throw IllegalStateException("cannot write to the gallery")).use { out -> open().use { it.copyTo(out) } }
            ctx.contentResolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        } catch (e: Throwable) {
            runCatching { ctx.contentResolver.delete(uri, null, null) }
            throw e
        }
        return uri
    }

    @Suppress("DEPRECATION")
    private fun legacySave(ctx: Context, name: String, video: Boolean, album: String, open: () -> InputStream): Uri {
        if (!granted(ctx, Manifest.permission.WRITE_EXTERNAL_STORAGE)) throw SecurityException("no storage write permission")
        val dir = File(Environment.getExternalStoragePublicDirectory(if (video) Environment.DIRECTORY_MOVIES else Environment.DIRECTORY_PICTURES), album).apply { mkdirs() }
        var f = File(dir, name)
        var n = 1
        while (f.exists()) f = File(dir, "${name.substringBeforeLast('.')}-${n++}.${name.substringAfterLast('.')}")
        f.outputStream().use { out -> open().use { it.copyTo(out) } }
        val done = CountDownLatch(1)
        var uri: Uri? = null
        MediaScannerConnection.scanFile(ctx, arrayOf(f.path), null) { _, u -> uri = u; done.countDown() }
        done.await(10, TimeUnit.SECONDS)
        return uri ?: Uri.fromFile(f)
    }

    // ───────────────────────────── camera.capture ─────────────────────────────

    private val capture = Cap(
        name = "camera.capture",
        description = "Ask the owner to take a photo: the phone's own camera opens (Android does not let apps take pictures " +
            "unseen) and the owner presses the shutter. Returns the photo as an image you can look at and its path in your " +
            "workspace's media/ folder (it is not put in the gallery; media.save does that). If Ash is in the background the " +
            "owner gets a notification to open the camera. Fails with cancelled when the owner closes the camera without a photo.",
        schema = schema(
            "reason" to prop("string", "What the photo is for, shown to the owner when Ash has to ask through a notification (Chinese, short)."),
            "timeout_s" to prop("integer", "How long to wait for the photo, 15–150 seconds (default 120)."),
            "max_size" to prop("integer", "Longest side of the returned image in px, 256–2048 (default 1280); the saved file is full size."),
        ),
    ) { ctx, args ->
        MediaArguments.camera(args, { a ->
            val file = CaptureProvider.newFile(ctx, "photo", "jpg")
            val r = CameraRequests.create(file)
            try {
                val intent = Intent(ctx, CameraActivity::class.java).putExtra(CameraActivity.EXTRA_ID, r.id)
                val start = System.currentTimeMillis()
                val direct = AppState.inFront || Launcher.canStartDirectly(ctx)
                var how = Notifications.cameraHandoff(ctx, intent, a.reason, direct)
                // Android may drop a start from the background without a word: then ask through a notification.
                if (direct && !r.awaitOpen(6_000)) how = Notifications.cameraHandoff(ctx, Intent(intent), a.reason, false)
                val left = a.timeoutMs - (System.currentTimeMillis() - start)
                if (!r.awaitFinish(maxOf(0, left))) {
                    val opened = r.awaitOpen(0)
                    return@camera CapResult.error("timeout", if (opened) "the camera is open but the owner did not take a photo within ${a.timeoutMs / 1000}s"
                        else if (how == "notification") "the owner did not open the camera from Ash's notification within ${a.timeoutMs / 1000}s"
                        else "the camera did not open within ${a.timeoutMs / 1000}s")
                }
                when (val o = r.outcome) {
                    is CameraRequest.Outcome.Taken -> taken(ctx, file, a.maxSize)
                    is CameraRequest.Outcome.Failed -> CapResult.fail("camera.capture: ${o.message}")
                    else -> CapResult.error("cancelled", "the owner closed the camera without taking a photo")
                }
            } finally {
                CameraRequests.drop(r)
                Notifications.hideCameraHandoff(ctx)
                file.delete()
            }
        }, CapResult::fail)
    }

    private fun taken(ctx: Context, file: File, maxSize: Int): CapResult {
        val paths = paths(ctx)
        val dest = File(paths.exchange.apply { mkdirs() }, file.name)
        file.copyTo(dest, overwrite = true)
        val degrees = exifDegrees(dest)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }.also { BitmapFactory.decodeFile(dest.path, it) }
        val bmp = decode({ dest.inputStream() }, maxSize, degrees) ?: return CapResult.fail("camera.capture: the camera returned a file that is not a photo")
        val upright = degrees % 180 != 0
        val w = if (upright) bounds.outHeight else bounds.outWidth
        val h = if (upright) bounds.outWidth else bounds.outHeight
        val path = paths.toAgent(dest)!!
        val data = JSONObject().put("path", path).put("width", w).put("height", h).put("bytes", dest.length()).put("mime_type", "image/jpeg")
        return CapResult.textAndImage("Photo taken (${w}×$h, ${dest.length() / 1024} KB), saved at $path. It is not in the gallery; media.save puts it there.",
            Base64.encodeToString(jpeg(bmp), Base64.NO_WRAP), "image/jpeg", data)
    }

    val list: List<Capability> = listOf(listMedia, albums, read, save, capture)
}
