package ai.ash.host.shizuku

import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Root (su) detection. Checking for the binary is cheap and never prompts; running `su -c id`
 * may make the root manager (Magisk/KernelSU) ask the owner, so it is only done when root is
 * actually about to be used, and the answer is cached (yes: for the process lifetime; no: 60 s).
 */
object RootShell {
    private val DIRS = listOf("/system/bin", "/system/xbin", "/sbin", "/su/bin", "/debug_ramdisk", "/system/sbin", "/vendor/bin")

    @Volatile private var granted: Boolean? = null
    @Volatile private var checkedAt = 0L

    fun suPath(): String? {
        val path = (System.getenv("PATH") ?: "").split(':').filter { it.isNotBlank() }
        for (d in (path + DIRS).distinct()) {
            val f = File(d, "su")
            try { if (f.exists()) return f.absolutePath } catch (e: Throwable) {}
        }
        return null
    }

    fun present(): Boolean = suPath() != null

    /** Last probe result without probing (null = never probed or expired). */
    fun known(): Boolean? {
        val g = granted ?: return null
        if (!g && System.currentTimeMillis() - checkedAt > 60_000) return null
        return g
    }

    /** `su -c id` → uid=0 (bounded; may show the root manager's grant prompt once). */
    @Synchronized
    fun probe(timeoutMs: Long = 8000): Boolean {
        known()?.let { return it }
        if (!present()) { granted = false; checkedAt = System.currentTimeMillis(); return false }
        var p: Process? = null
        val ok = try {
            p = ProcessBuilder("su", "-c", "id").redirectErrorStream(true).start()
            p.outputStream.close()
            val out = StringBuilder()
            val reader = Thread { try { out.append(p.inputStream.bufferedReader().readText()) } catch (e: Throwable) {} }
            reader.isDaemon = true
            reader.start()
            reader.join(timeoutMs)
            val done = waitFor(p, 500)
            done && out.contains("uid=0")
        } catch (e: Throwable) {
            false
        } finally {
            try { p?.destroy() } catch (e: Throwable) {}
        }
        granted = ok
        checkedAt = System.currentTimeMillis()
        return ok
    }

    private fun waitFor(p: Process, ms: Long): Boolean = if (android.os.Build.VERSION.SDK_INT >= 26) {
        p.waitFor(ms, TimeUnit.MILLISECONDS)
    } else {
        val t = Thread { try { p.waitFor() } catch (e: Throwable) {} }
        t.isDaemon = true; t.start(); t.join(ms); !t.isAlive
    }
}
