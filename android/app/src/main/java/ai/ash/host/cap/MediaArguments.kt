package ai.ash.host.cap

import org.json.JSONObject
import java.io.File
import java.util.Locale

/** What kind of media a MediaStore row is (the Files table's media_type). */
enum class MediaKind(val word: String, val mediaType: Int) {
    IMAGE("image", 1), AUDIO("audio", 2), VIDEO("video", 3);

    companion object {
        fun of(mediaType: Int): MediaKind? = values().firstOrNull { it.mediaType == mediaType }
        fun of(word: String): MediaKind? = values().firstOrNull { it.word == word }
    }
}

data class MediaListArgs(
    val kinds: List<MediaKind>, val since: Long?, val until: Long?, val album: String?, val name: String?,
    val newestFirst: Boolean, val limit: Int, val offset: Int, val withLocation: Boolean,
)
data class MediaAlbumsArgs(val kinds: List<MediaKind>)
data class MediaReadArgs(val id: Long, val maxSize: Int, val copy: Boolean)
data class MediaSaveArgs(val path: String?, val data: String?, val name: String?, val mime: String?, val album: String)
data class CameraArgs(val reason: String?, val timeoutMs: Long, val maxSize: Int)

/**
 * A MediaStore query as the provider takes it. Android 11+ checks the grammar strictly, so the selection holds plain
 * comparisons only; [plainSort] is the order to fall back to if a phone refuses [sortOrder]'s expression.
 */
data class MediaQuery(val selection: String, val args: Array<String>, val sortOrder: String, val plainSort: String)

/**
 * Every media word's input, parsed before the provider is touched (JSONObject opt* coercion is not validation), and
 * the pure parts of the work: the MediaStore selection, mime types, file names and container paths.
 */
object MediaArguments {
    private const val MAX_SAFE = 9_007_199_254_740_991L
    const val DEFAULT_MAX_SIZE = 1280

    // Files-table columns (MediaStore.MediaColumns / FileColumns); literal so the logic runs off the phone.
    const val ID = "_id"
    const val NAME = "_display_name"
    const val MIME = "mime_type"
    const val SIZE = "_size"
    const val TAKEN = "datetaken"
    const val ADDED = "date_added"
    const val WIDTH = "width"
    const val HEIGHT = "height"
    const val DURATION = "duration"
    const val ALBUM = "bucket_display_name"
    const val MEDIA_TYPE = "media_type"
    const val DATA = "_data"
    const val ORIENTATION = "orientation"

    private fun integer(value: Any?): Long? {
        if (value !is Number) return null
        val number = value.toDouble()
        if (!number.isFinite() || number < 0 || number > MAX_SAFE.toDouble() || number % 1.0 != 0.0) return null
        return number.toLong()
    }

    private fun keysOnly(input: JSONObject, allowed: Set<String>): String? =
        input.keys().asSequence().firstOrNull { it !in allowed }

    private fun text(input: JSONObject, key: String): Result<String?> {
        if (!input.has(key) || input.isNull(key)) return Result.success(null)
        val v = input.opt(key) as? String ?: return Result.failure(IllegalArgumentException("$key must be text"))
        return Result.success(v.trim().ifEmpty { null })
    }

    private fun bool(input: JSONObject, key: String, default: Boolean): Boolean? =
        if (!input.has(key)) default else input.opt(key) as? Boolean

    private fun kinds(input: JSONObject): List<MediaKind>? {
        if (!input.has("type")) return MediaKind.values().toList()
        return when (val t = input.opt("type")) {
            "any" -> MediaKind.values().toList()
            is String -> MediaKind.of(t)?.let { listOf(it) }
            else -> null
        }
    }

    private fun size(input: JSONObject, word: String): Result<Int> {
        if (!input.has("max_size")) return Result.success(DEFAULT_MAX_SIZE)
        val v = integer(input.opt("max_size"))
        if (v == null || v !in 256..2048) return Result.failure(IllegalArgumentException("$word max_size must be an integer from 256 to 2048"))
        return Result.success(v.toInt())
    }

    fun <T> list(input: JSONObject, ok: (MediaListArgs) -> T, invalid: (String) -> T): T {
        keysOnly(input, setOf("type", "since_ms", "until_ms", "album", "name", "order", "limit", "offset", "with_location"))
            ?.let { return invalid("media.list has no field $it") }
        val kinds = kinds(input) ?: return invalid("media.list type must be image, video, audio or any")
        val since = if (input.has("since_ms")) integer(input.opt("since_ms")) ?: return invalid("media.list since_ms must be Unix milliseconds") else null
        val until = if (input.has("until_ms")) integer(input.opt("until_ms")) ?: return invalid("media.list until_ms must be Unix milliseconds") else null
        if (since != null && until != null && until <= since) return invalid("media.list until_ms must be after since_ms")
        val album = text(input, "album").getOrElse { return invalid("media.list ${it.message}") }
        val name = text(input, "name").getOrElse { return invalid("media.list ${it.message}") }
        if ((album?.length ?: 0) > 200 || (name?.length ?: 0) > 200) return invalid("media.list album and name are at most 200 characters")
        val order = if (input.has("order")) input.opt("order") as? String else "newest"
        if (order != "newest" && order != "oldest") return invalid("media.list order must be newest or oldest")
        val limit = if (input.has("limit")) integer(input.opt("limit")) else 30L
        if (limit == null || limit !in 1..100) return invalid("media.list limit must be an integer from 1 to 100")
        val offset = if (input.has("offset")) integer(input.opt("offset")) else 0L
        if (offset == null || offset > 1_000_000) return invalid("media.list offset must be an integer from 0 to 1000000")
        val withLocation = bool(input, "with_location", false) ?: return invalid("media.list with_location must be true or false")
        return ok(MediaListArgs(kinds, since, until, album, name, order == "newest", limit.toInt(), offset.toInt(), withLocation))
    }

    fun <T> albums(input: JSONObject, ok: (MediaAlbumsArgs) -> T, invalid: (String) -> T): T {
        keysOnly(input, setOf("type"))?.let { return invalid("media.albums has no field $it") }
        val kinds = kinds(input) ?: return invalid("media.albums type must be image, video, audio or any")
        return ok(MediaAlbumsArgs(kinds))
    }

    fun <T> read(input: JSONObject, ok: (MediaReadArgs) -> T, invalid: (String) -> T): T {
        keysOnly(input, setOf("id", "max_size", "copy"))?.let { return invalid("media.read has no field $it") }
        val id = integer(input.opt("id"))
        if (id == null || id < 1) return invalid("media.read needs the integer id from media.list")
        val size = size(input, "media.read").getOrElse { return invalid(it.message!!) }
        val copy = bool(input, "copy", false) ?: return invalid("media.read copy must be true or false")
        return ok(MediaReadArgs(id, size, copy))
    }

    fun <T> save(input: JSONObject, ok: (MediaSaveArgs) -> T, invalid: (String) -> T): T {
        keysOnly(input, setOf("path", "data", "name", "mime_type", "album"))?.let { return invalid("media.save has no field $it") }
        val path = text(input, "path").getOrElse { return invalid("media.save ${it.message}") }
        val data = text(input, "data").getOrElse { return invalid("media.save ${it.message}") }
        if ((path == null) == (data == null)) return invalid("media.save needs exactly one of path (a file in your environment) or data (base64)")
        if (path != null && !path.startsWith("/")) return invalid("media.save path must be absolute")
        if (data != null && !Regex("^[A-Za-z0-9+/\\s]+={0,2}\\s*$").matches(data)) return invalid("media.save data must be base64")
        val name = text(input, "name").getOrElse { return invalid("media.save ${it.message}") }
        if (name != null && (name.length > 120 || safeName(name) != name)) return invalid("media.save name must be a plain file name (no slashes), at most 120 characters")
        val mime = text(input, "mime_type").getOrElse { return invalid("media.save ${it.message}") }?.lowercase(Locale.ROOT)
        if (mime != null && !Regex("^(image|video)/[a-z0-9.+-]{1,60}$").matches(mime)) return invalid("media.save mime_type must be an image/* or video/* type")
        val album = text(input, "album").getOrElse { return invalid("media.save ${it.message}") } ?: "Ash"
        if (album.length > 60 || safeName(album) != album || album.startsWith(".")) return invalid("media.save album must be a plain folder name, at most 60 characters")
        return ok(MediaSaveArgs(path, data, name, mime, album))
    }

    fun <T> camera(input: JSONObject, ok: (CameraArgs) -> T, invalid: (String) -> T): T {
        keysOnly(input, setOf("reason", "timeout_s", "max_size"))?.let { return invalid("camera.capture has no field $it") }
        val reason = text(input, "reason").getOrElse { return invalid("camera.capture ${it.message}") }
        if ((reason?.length ?: 0) > 120) return invalid("camera.capture reason is at most 120 characters")
        val timeout = if (input.has("timeout_s")) integer(input.opt("timeout_s")) else 120L
        if (timeout == null || timeout !in 15..150) return invalid("camera.capture timeout_s must be an integer from 15 to 150")
        val size = size(input, "camera.capture").getOrElse { return invalid(it.message!!) }
        return ok(CameraArgs(reason, timeout * 1000, size))
    }

    /** The provider query for [a]: only plain comparisons, LIKE with an escape, and a column sort. */
    fun query(a: MediaListArgs): MediaQuery {
        val where = mutableListOf<String>()
        val args = mutableListOf<String>()
        where += "$MEDIA_TYPE IN (${a.kinds.joinToString(",") { it.mediaType.toString() }})"
        // Taken time when the file has one, else when it was added (seconds); the same rule the result reports.
        if (a.since != null) {
            where += "(($TAKEN > 0 AND $TAKEN >= ?) OR (($TAKEN IS NULL OR $TAKEN <= 0) AND $ADDED >= ?))"
            args += a.since.toString(); args += (a.since / 1000).toString()
        }
        if (a.until != null) {
            where += "(($TAKEN > 0 AND $TAKEN < ?) OR (($TAKEN IS NULL OR $TAKEN <= 0) AND $ADDED < ?))"
            args += a.until.toString(); args += ((a.until + 999) / 1000).toString()
        }
        if (a.album != null) { where += "$ALBUM LIKE ? ESCAPE '\\'"; args += like(a.album, contains = false) }
        if (a.name != null) { where += "$NAME LIKE ? ESCAPE '\\'"; args += like(a.name, contains = true) }
        val dir = if (a.newestFirst) "DESC" else "ASC"
        return MediaQuery(where.joinToString(" AND "), args.toTypedArray(),
            "COALESCE(NULLIF($TAKEN, 0), $ADDED * 1000) $dir, $ID $dir", "$ADDED $dir, $ID $dir")
    }

    /** LIKE pattern for [text]: case-insensitive equality, or a substring when [contains]. */
    fun like(text: String, contains: Boolean): String {
        val escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        return if (contains) "%$escaped%" else escaped
    }

    /** When a row was taken: its own taken time, else when it was added. */
    fun takenMs(taken: Long?, addedSeconds: Long?): Long? = taken?.takeIf { it > 0 } ?: addedSeconds?.takeIf { it > 0 }?.times(1000)

    /** A file name safe on the phone and in the container: no separators, controls or leading dots, bounded. */
    fun safeName(name: String): String {
        val cleaned = name.replace(Regex("[\\\\/\\x00-\\x1f\\x7f:*?\"<>|]"), "_").trim().trimStart('.')
        return cleaned.take(120).ifEmpty { "file" }
    }

    private val EXTENSIONS = mapOf(
        "jpg" to "image/jpeg", "jpeg" to "image/jpeg", "png" to "image/png", "webp" to "image/webp", "gif" to "image/gif",
        "heic" to "image/heic", "heif" to "image/heif", "bmp" to "image/bmp", "avif" to "image/avif",
        "mp4" to "video/mp4", "m4v" to "video/mp4", "mov" to "video/quicktime", "webm" to "video/webm", "3gp" to "video/3gpp",
        "mkv" to "video/x-matroska",
    )

    fun mimeOf(name: String): String? = EXTENSIONS[name.substringAfterLast('.', "").lowercase(Locale.ROOT)]

    /** The image or video type the first bytes announce, or null. */
    fun sniff(head: ByteArray): String? {
        fun at(i: Int, vararg b: Int) = head.size >= i + b.size && b.indices.all { head[i + it].toInt() and 0xff == b[it] }
        fun ascii(i: Int, s: String) = head.size >= i + s.length && s.indices.all { head[i + it].toInt() == s[it].code }
        return when {
            at(0, 0xff, 0xd8, 0xff) -> "image/jpeg"
            at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) -> "image/png"
            ascii(0, "GIF87a") || ascii(0, "GIF89a") -> "image/gif"
            ascii(0, "RIFF") && ascii(8, "WEBP") -> "image/webp"
            ascii(4, "ftypheic") || ascii(4, "ftypheix") || ascii(4, "ftypmif1") -> "image/heic"
            ascii(4, "ftypavif") -> "image/avif"
            ascii(4, "ftypqt") -> "video/quicktime"
            ascii(4, "ftyp") -> "video/mp4"
            at(0, 0x1a, 0x45, 0xdf, 0xa3) -> "video/webm"
            else -> null
        }
    }

    fun extensionFor(mime: String): String = when (mime) {
        "image/jpeg" -> "jpg"; "video/quicktime" -> "mov"; "video/3gpp" -> "3gp"; "video/x-matroska" -> "mkv"
        else -> EXTENSIONS.entries.firstOrNull { it.value == mime }?.key ?: mime.substringAfter('/').filter { it.isLetterOrDigit() }.take(8).ifEmpty { "bin" }
    }
}

/**
 * Paths as the agent's container sees them and as the phone does. The container's root is ubuntu/ under the container
 * directory; /tmp is its own tmp/; the phone's shared storage is bound at /sdcard and at its own path (launch.ts).
 */
class ContainerPaths(val rootfs: File, val tmp: File, val storage: String = SHARED_STORAGE) {
    /** The phone file behind a container path, or null when it is not one the agent may hand over. */
    fun toHost(path: String): File? {
        if (!path.startsWith("/") || path.contains('\u0000')) return null
        val normal = normalize(path) ?: return null
        val host = when {
            normal == "/sdcard" || normal.startsWith("/sdcard/") -> File(storage + normal.removePrefix("/sdcard"))
            normal == storage || normal.startsWith("$storage/") -> File(normal)
            normal == "/tmp" || normal.startsWith("/tmp/") -> File(tmp, normal.removePrefix("/tmp").trimStart('/'))
            listOf("/proc", "/dev", "/sys").any { normal == it || normal.startsWith("$it/") } -> return null
            else -> File(rootfs, normal.trimStart('/'))
        }
        // Symbolic links inside the container point at container paths, which mean something else on the phone:
        // the resolved file has to stay where the agent's own files are.
        val real = runCatching { host.canonicalFile }.getOrNull() ?: return null
        val allowed = listOf(rootfs, tmp, File(storage)).mapNotNull { runCatching { it.canonicalFile }.getOrNull() }
        return real.takeIf { r -> allowed.any { r.path == it.path || r.path.startsWith(it.path + File.separator) } }
    }

    /** The container path of a phone file in the container's root or in shared storage, or null. */
    fun toAgent(file: File): String? {
        val p = file.absolutePath
        val root = rootfs.absolutePath
        return when {
            p == root -> "/"
            p.startsWith("$root/") -> p.removePrefix(root)
            p == storage || p.startsWith("$storage/") -> p
            else -> null
        }
    }

    /** Where Ash hands phone files to the agent: its workspace's media/ folder. */
    val exchange: File get() = File(rootfs, EXCHANGE.trimStart('/'))

    companion object {
        const val SHARED_STORAGE = "/storage/emulated/0"
        const val EXCHANGE = "/root/work/media"

        /** Collapses "." and ".." without touching the file system; null when it climbs above the root. */
        fun normalize(path: String): String? {
            val parts = ArrayDeque<String>()
            for (part in path.split('/')) {
                when (part) {
                    "", "." -> {}
                    ".." -> if (parts.isEmpty()) return null else parts.removeLast()
                    else -> parts.addLast(part)
                }
            }
            return "/" + parts.joinToString("/")
        }
    }
}
