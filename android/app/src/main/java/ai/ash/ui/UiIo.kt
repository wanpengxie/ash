package ai.ash.ui

import android.os.Handler
import android.os.Looper
import java.io.File
import java.util.concurrent.Executors

/**
 * The native screens' bounded work queues (MOBILE-ARCH §7.2): disk reads and writes go to [disk], one thread, in order, so a
 * write and the next one never race; parsing what the link sends goes to [decode]. Results come back on the main thread
 * through [ui]. No screen starts a thread per request.
 */
object UiIo {
    private val main = Handler(Looper.getMainLooper())
    private val diskQueue = Executors.newSingleThreadExecutor { r -> Thread(r, "ash-ui-disk").apply { isDaemon = true } }
    private val decodeQueue = Executors.newSingleThreadExecutor { r -> Thread(r, "ash-ui-decode").apply { isDaemon = true } }

    fun disk(work: () -> Unit) { diskQueue.execute { runCatching(work) } }
    fun decode(work: () -> Unit) { decodeQueue.execute { runCatching(work) } }
    fun ui(work: () -> Unit) { main.post(work) }

    /** Writes [text] to [file] whole or not at all (a temporary file renamed over it). Disk thread only. */
    fun writeAtomically(file: File, text: String): Boolean = runCatching {
        file.parentFile?.mkdirs()
        val tmp = File(file.path + ".tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(file)) { tmp.delete(); error("rename failed") }
        true
    }.getOrDefault(false)
}

/** The drafts store of the device (one for the chat and Codex): words in preferences, picked files in files beside them. */
object UiDrafts {
    @Volatile private var drafts: Drafts? = null

    fun get(ctx: android.content.Context): Drafts = drafts ?: synchronized(this) {
        drafts ?: run {
            val prefs = ctx.applicationContext.getSharedPreferences("ash.drafts", android.content.Context.MODE_PRIVATE)
            Drafts(object : Drafts.Store {
                override fun get(key: String): String? = prefs.getString(key, null)
                // apply(): written to disk off the main thread.
                override fun put(key: String, value: String?) { prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.apply() }
            }).also { drafts = it }
        }
    }

    private fun fileOf(ctx: android.content.Context, key: String) =
        File(File(ctx.filesDir, "drafts"), key.replace(Regex("[^A-Za-z0-9._-]"), "_") + ".att")

    /** The files picked for [key]'s draft (empty: none); read on the disk queue, answered on the main thread. */
    fun files(ctx: android.content.Context, key: String, done: (org.json.JSONArray) -> Unit) {
        val f = fileOf(ctx, key)
        UiIo.disk {
            val a = if (f.isFile) runCatching { org.json.JSONArray(f.readText()) }.getOrNull() else null
            UiIo.ui { done(a ?: org.json.JSONArray()) }
        }
    }

    fun keepFiles(ctx: android.content.Context, key: String, files: org.json.JSONArray) {
        val f = fileOf(ctx, key)
        val text = if (files.length() == 0) null else files.toString()
        UiIo.disk { if (text == null) f.delete() else UiIo.writeAtomically(f, text) }
    }
}
