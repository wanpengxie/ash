package ai.ash.kernel.host.ctx

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile

/**
 * What [ContextProbe] recorded, read for the core (host capability `ctx`): the days there are and the size of each file, and
 * a file read piece by piece. Only the shell user can read [root], so this runs in the shell host. The caller names a day and
 * one of the four files; the path is made here and nowhere else, so nothing outside [root]/<day>/<file>.jsonl can be read.
 */
class ContextFiles(private val root: File, private val probe: () -> JSONObject) {

    /** Every day (oldest first) with its files' sizes and line counts, and whether the probe is recording now. */
    fun list(): JSONObject {
        val days = root.listFiles { f -> f.isDirectory && DAY.matches(f.name) }?.sortedBy { it.name } ?: emptyList()
        val out = JSONArray()
        for (d in days) {
            val files = JSONArray()
            for (name in FILES) {
                val f = File(d, "$name.jsonl")
                if (!f.isFile) continue
                val (lines, estimated) = lines(f)
                files.put(JSONObject().put("file", name).put("bytes", f.length()).put("lines", lines)
                    .put("lines_estimated", estimated).put("modified", f.lastModified()))
            }
            out.put(JSONObject().put("day", d.name).put("files", files))
        }
        return JSONObject().put("probe", probe()).put("days", out)
    }

    /**
     * Up to [limit] bytes of [day]'s [file] from byte [offset], cut after the last whole line (a line longer than [limit]
     * comes in pieces). `next_offset` is where to go on; `eof` says the file ended there (it may still grow while the probe
     * records). A day or file that is not there is an empty read at its end.
     */
    fun read(day: String, file: String, offset: Long, limit: Int): JSONObject {
        require(DAY.matches(day)) { "day must be YYYY-MM-DD" }
        require(file in FILES) { "file must be one of ${FILES.joinToString("|")}" }
        require(offset >= 0) { "offset must be >= 0" }
        require(limit in 1..MAX_READ) { "limit must be 1..$MAX_READ" }
        val f = File(File(root, day), "$file.jsonl")
        val size = if (f.isFile) f.length() else 0L
        val from = minOf(offset, size)
        val want = minOf(limit.toLong(), size - from).toInt()
        val buf = ByteArray(want)
        if (want > 0) RandomAccessFile(f, "r").use { it.seek(from); it.readFully(buf) }
        // Whole lines only, unless this is the file's end or not even one line fits.
        val end = from + want
        val cut = if (end >= size) want else (buf.lastIndexOf('\n'.code.toByte()) + 1).takeIf { it > 0 } ?: want
        val next = from + cut
        return JSONObject().put("day", day).put("file", file).put("offset", from).put("next_offset", next)
            .put("size", size).put("eof", next >= size).put("text", String(buf, 0, cut, Charsets.UTF_8))
    }

    /** Lines of [f]: counted when it is small, else estimated from its first [SAMPLE] bytes. */
    private fun lines(f: File): Pair<Long, Boolean> {
        val size = f.length()
        if (size == 0L) return 0L to false
        val exact = size <= COUNT_UP_TO
        val buf = ByteArray(64 * 1024)
        var seen = 0L
        var newlines = 0L
        f.inputStream().use { input ->
            while (exact || seen < SAMPLE) {
                val n = input.read(buf)
                if (n < 0) break
                for (i in 0 until n) if (buf[i] == '\n'.code.toByte()) newlines++
                seen += n
            }
        }
        if (exact) return newlines to false
        return (if (newlines == 0L) 1L else Math.round(size.toDouble() * newlines / seen)) to true
    }

    companion object {
        val FILES = listOf("events", "screens", "touch", "stats")
        val DAY = Regex("^\\d{4}-\\d{2}-\\d{2}$")
        const val MAX_READ = 256 * 1024
        private const val COUNT_UP_TO = 4L * 1024 * 1024
        private const val SAMPLE = 256L * 1024
    }
}
