package ai.ash.caps.perception

import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** A model file the app fetches once: where from (tried in order), its exact size and sha-256. */
class ModelFile(val name: String, val urls: List<String>, val bytes: Long, val sha256: String) {
    /** The file name on the phone; the checksum is in it, so a new version of the model is a new file. */
    val fileName: String get() = "$name-${sha256.take(12)}.onnx"
}

/** The models could not be had: the message says why, in words for the agent. */
class ModelUnavailable(message: String) : Exception(message)

/**
 * Model files in the app's private directory. A file is downloaded to `<file>.part` (resumed after a break), checked against
 * its size and sha-256, and only then renamed to its name, so a file with that name is always a whole, checked one.
 */
class ModelStore(private val dir: File, private val http: OkHttpClient = client()) {
    private val lock = Any()

    /** All of [files] on the phone, downloading what is missing (one download at a time); [deadlineMs] bounds the whole wait. */
    fun ensure(files: List<ModelFile>, deadlineMs: Long = 15 * 60_000L, now: () -> Long = System::currentTimeMillis): Map<String, File> = synchronized(lock) {
        val deadline = now() + deadlineMs
        dir.mkdirs()
        files.associate { it.name to fetch(it, deadline, now) }
    }

    /** Whether every file is already here (no network needed). */
    fun has(files: List<ModelFile>): Boolean = files.all { File(dir, it.fileName).let { f -> f.isFile && f.length() == it.bytes } }

    private fun fetch(m: ModelFile, deadline: Long, now: () -> Long): File {
        val target = File(dir, m.fileName)
        if (target.isFile && target.length() == m.bytes) return target
        val part = File(dir, m.fileName + ".part")
        val missing = m.bytes - (if (part.isFile) part.length() else 0L)
        if (dir.usableSpace < missing + SPARE_BYTES)
            throw ModelUnavailable("not enough free space on the phone for ${m.name} (needs ${(missing + SPARE_BYTES) shr 20} MB, ${dir.usableSpace shr 20} MB free)")
        val problems = mutableListOf<String>()
        for (url in m.urls) {
            try {
                download(url, part, m.bytes, deadline, now)
                if (part.length() != m.bytes || sha256(part) != m.sha256) {
                    part.delete()
                    throw IOException("the file does not match its checksum")
                }
                if (!part.renameTo(target)) throw IOException("cannot move the file into place")
                dir.listFiles { f -> f.name.startsWith(m.name + "-") && f.name != target.name && !f.name.endsWith(".part") }?.forEach { it.delete() }
                return target
            } catch (e: DeadlineReached) {
                throw ModelUnavailable("downloading ${m.name} took too long (it resumes where it stopped on the next call)")
            } catch (e: IOException) {
                problems += "${hostOf(url)}: ${e.message ?: e.javaClass.simpleName}"
            }
        }
        throw ModelUnavailable("${m.name} could not be downloaded (${problems.joinToString("; ")})")
    }

    private class DeadlineReached : IOException()

    private fun download(url: String, part: File, total: Long, deadline: Long, now: () -> Long) {
        var have = if (part.isFile) part.length() else 0L
        if (have > total) { part.delete(); have = 0 }
        if (have == total) return
        val request = Request.Builder().url(url).apply { if (have > 0) header("Range", "bytes=$have-") }.build()
        http.newCall(request).execute().use { response ->
            if (response.code == 200 && have > 0) have = 0 // the server ignored the range: start again
            else if (response.code != 200 && response.code != 206) throw IOException("HTTP ${response.code}")
            val body = response.body ?: throw IOException("empty answer")
            RandomAccessFile(part, "rw").use { out ->
                out.setLength(have); out.seek(have)
                val buffer = ByteArray(64 * 1024)
                body.byteStream().use { input ->
                    while (true) {
                        if (now() > deadline) throw DeadlineReached()
                        val n = input.read(buffer)
                        if (n < 0) break
                        if (out.filePointer + n > total) throw IOException("more data than expected")
                        out.write(buffer, 0, n)
                    }
                }
            }
        }
    }

    private fun hostOf(url: String) = runCatching { java.net.URI(url).host }.getOrNull() ?: url

    companion object {
        private const val SPARE_BYTES = 64L shl 20

        fun client(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).followRedirects(true).build()

        fun sha256(file: File): String {
            val md = MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input ->
                val buffer = ByteArray(1 shl 16)
                while (true) { val n = input.read(buffer); if (n < 0) break; md.update(buffer, 0, n) }
            }
            return md.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
        }
    }
}
