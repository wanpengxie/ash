package ai.ash.host.shizuku

import android.content.Context
import android.os.ParcelFileDescriptor
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream

/** A privileged child process (Shizuku shell/root uid, or su), with its three pipes. */
class PrivProcess internal constructor(
    /** "shizuku" or "root". */
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
 * Runs shell commands with elevated privileges from the app process:
 * Shizuku first (IShizukuService.newProcess → runs as Shizuku's uid: 2000 "shell" in adb mode,
 * 0 in root mode), then root via `su -c`. No rish, no dex files: the Shizuku API in this APK
 * is enough (the old engine-side rish timed out on ROMs that freeze the Shizuku app; the
 * in-process API channel was the one that worked).
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

    /** Which channel would be used right now without prompting anybody ("shizuku", "root") or null. */
    fun channel(ctx: Context): String? = when {
        ShizukuState.ready() -> "shizuku"
        RootShell.known() == true -> "root"
        else -> null
    }

    /** A channel exists or might exist (Shizuku installed, or an su binary present). Cheap. */
    fun maybeAvailable(ctx: Context): Boolean = ShizukuState.ready() || ShizukuState.installed(ctx) || RootShell.present()

    /**
     * Resolves a channel, waiting briefly for the Shizuku binder after a cold start and probing su
     * when Shizuku cannot be used. Throws with a readable reason when nothing is usable.
     */
    fun requireChannel(ctx: Context, allowRoot: Boolean = true): String {
        if (ShizukuState.awaitReady(ctx)) return "shizuku"
        if (allowRoot && RootShell.probe()) return "root"
        val why = ShizukuState.whyNot(ctx) ?: "Shizuku is unavailable"
        val root = if (!allowRoot) "" else if (RootShell.present()) "; root (su) was refused or timed out" else "; the phone is not rooted"
        throw IllegalStateException("no privileged shell: $why$root")
    }

    /** Starts `sh -c <command>` through the given channel (see [requireChannel]). */
    fun spawn(via: String, command: String, cwd: String? = null): PrivProcess = when (via) {
        "shizuku" -> {
            val rp = ShizukuState.service().newProcess(arrayOf("/system/bin/sh", "-c", command), null, cwd)
                ?: throw IllegalStateException("Shizuku newProcess returned null")
            PrivProcess(
                "shizuku",
                ParcelFileDescriptor.AutoCloseOutputStream(rp.outputStream),
                ParcelFileDescriptor.AutoCloseInputStream(rp.inputStream),
                ParcelFileDescriptor.AutoCloseInputStream(rp.errorStream),
                { rp.waitFor() }, { rp.destroy() }, { rp.alive() }, rp,
            )
        }
        "root" -> {
            val pb = ProcessBuilder("su", "-c", command)
            if (cwd != null) pb.directory(File(cwd))
            pb.environment().apply { remove("LD_LIBRARY_PATH"); remove("LD_PRELOAD") }
            val p = pb.start()
            PrivProcess("root", p.outputStream, p.inputStream, p.errorStream, { p.waitFor() }, { p.destroy() }, { isAlive(p) }, p)
        }
        else -> throw IllegalArgumentException("unknown channel $via")
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

    private fun isAlive(p: Process): Boolean = try { p.exitValue(); false } catch (e: IllegalThreadStateException) { true }
}
