package ai.ash.host.shizuku

import android.content.Context
import android.os.ParcelFileDescriptor
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream

/** A privileged child process (run by the Shizuku server, as its uid), with its three pipes. */
class PrivProcess internal constructor(
    /** Always "shizuku" (kept in results so callers can tell how a command ran). */
    val via: String,
    val stdin: OutputStream,
    val stdout: InputStream,
    val stderr: InputStream,
    private val waitFn: () -> Int,
    private val destroyFn: () -> Unit,
    private val aliveFn: () -> Boolean,
    /** Keeps the Shizuku IRemoteProcess binder referenced while the process is in use. */
    @Suppress("unused") private val keep: Any? = null,
) {
    fun waitFor(): Int = waitFn()
    fun destroy() = try { destroyFn() } catch (e: Throwable) {}
    fun alive(): Boolean = try { aliveFn() } catch (e: Throwable) { false }
}

/**
 * Runs shell commands with elevated privileges from the app process, through Shizuku only
 * (IShizukuService.newProcess → runs as the Shizuku server's uid, normally 2000 "shell").
 * ash deliberately never uses su: one well-understood privilege path the owner grants and revokes
 * in the Shizuku app. No rish, no dex files: the Shizuku API in this APK is enough (the old
 * engine-side rish timed out on ROMs that freeze the Shizuku app; the in-process API channel was
 * the one that worked).
 */
object PrivShell {
    const val DEFAULT_TIMEOUT_MS = 30_000
    const val MAX_TIMEOUT_MS = 120_000

    class Result(
        val via: String,
        val exitCode: Int,
        val stdout: String,
        val stderr: String,
        val timedOut: Boolean,
        val stdoutTruncated: Boolean,
        val stderrTruncated: Boolean,
    ) {
        val ok get() = !timedOut && exitCode == 0
    }

    /** "shizuku" when the privileged shell is usable right now without prompting anybody, else null. */
    fun channel(@Suppress("UNUSED_PARAMETER") ctx: Context): String? = if (ShizukuState.ready()) "shizuku" else null

    /** Shizuku is ready, or installed and might become ready (binder late after a cold start). Cheap. */
    fun maybeAvailable(ctx: Context): Boolean = ShizukuState.ready() || ShizukuState.installed(ctx)

    /**
     * Resolves the channel, waiting briefly for the Shizuku binder after a cold start.
     * Throws with a readable reason when Shizuku cannot be used.
     */
    fun requireChannel(ctx: Context): String {
        if (ShizukuState.awaitReady(ctx)) return "shizuku"
        val why = ShizukuState.whyNot(ctx) ?: "Shizuku is unavailable"
        throw IllegalStateException("no privileged shell (ash needs Shizuku): $why")
    }

    /** Starts `sh -c <command>` through Shizuku (see [requireChannel]). */
    fun spawn(via: String, command: String, cwd: String? = null): PrivProcess {
        require(via == "shizuku") { "unknown channel $via" }
        val rp = ShizukuState.service().newProcess(arrayOf("/system/bin/sh", "-c", command), null, cwd)
            ?: throw IllegalStateException("Shizuku newProcess returned null")
        return PrivProcess(
            "shizuku",
            ParcelFileDescriptor.AutoCloseOutputStream(rp.outputStream),
            ParcelFileDescriptor.AutoCloseInputStream(rp.inputStream),
            ParcelFileDescriptor.AutoCloseInputStream(rp.errorStream),
            { rp.waitFor() }, { rp.destroy() }, { rp.alive() }, rp,
        )
    }

    /**
     * Runs a command to completion (bounded). Output is decoded as UTF-8 and cut at [maxOut] bytes per
     * stream (the pipes keep being drained so the command never blocks on a full pipe).
     */
    fun exec(
        ctx: Context,
        command: String,
        timeoutMs: Int = DEFAULT_TIMEOUT_MS,
        stdin: String? = null,
        cwd: String? = null,
        maxOut: Int = 16_000,
        via: String? = null,
    ): Result {
        val channel = via ?: requireChannel(ctx)
        val p = spawn(channel, command, cwd)
        val out = Sink(maxOut)
        val err = Sink(maxOut)
        val to = pump(p.stdout, out, "priv-out")
        val te = pump(p.stderr, err, "priv-err")
        val feeder = Thread({
            try { if (stdin != null) p.stdin.write(stdin.toByteArray(Charsets.UTF_8)) } catch (e: Throwable) {
            } finally { try { p.stdin.close() } catch (e: Throwable) {} }
        }, "priv-in").apply { isDaemon = true; start() }
        var code = -1
        val waiter = Thread({ try { code = p.waitFor() } catch (e: Throwable) {} }, "priv-wait").apply { isDaemon = true; start() }
        waiter.join(timeoutMs.toLong().coerceIn(1000, MAX_TIMEOUT_MS.toLong()))
        val timedOut = waiter.isAlive
        if (timedOut) {
            p.destroy()
            waiter.join(1500)
        }
        // Background children may keep the pipes open: do not wait for EOF forever.
        to.join(1500); te.join(500); feeder.join(100)
        return Result(channel, if (timedOut) -1 else code, out.text(), err.text(), timedOut, out.truncated, err.truncated)
    }

    /** Single-quotes a string for sh. */
    fun quote(s: String): String = "'" + s.replace("'", "'\\''") + "'"

    private class Sink(private val cap: Int) {
        private val buf = ByteArrayOutputStream()
        @Volatile var truncated = false
        @Synchronized fun add(b: ByteArray, n: Int) {
            val room = cap - buf.size()
            if (room >= n) buf.write(b, 0, n) else { if (room > 0) buf.write(b, 0, room); truncated = true }
        }
        @Synchronized fun text(): String = String(buf.toByteArray(), Charsets.UTF_8)
    }

    private fun pump(input: InputStream, sink: Sink, name: String): Thread = Thread({
        try {
            val b = ByteArray(8192)
            while (true) {
                val n = input.read(b)
                if (n < 0) break
                if (n > 0) sink.add(b, n)
            }
        } catch (e: Throwable) {
        } finally { try { input.close() } catch (e: Throwable) {} }
    }, name).apply { isDaemon = true; start() }
}
