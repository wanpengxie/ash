package ai.ash.host.shizuku

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.io.OutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Client of the privileged virtual-screen server (ai.ash.vscreen.Main).
 *
 * The server is this APK's own code run by the shell uid: through Shizuku,
 * `CLASSPATH=<this apk> exec app_process /system/bin ai.ash.vscreen.Main` (the APK's classes.dex
 * holds the class; no separate jar, nothing copied to /data/local/tmp). Requests and replies are
 * JSON lines over the process's stdin/stdout, so there is no port another app could reach, no old
 * server version can survive an app update, and the server tears the display down and exits as soon
 * as this process (its pipe) goes away. stderr is drained and its tail kept for error messages.
 */
object VScreenClient {
    private const val TAG = "ash.vscreen"
    private const val MAIN = "ai.ash.vscreen.Main"
    private const val PREFIX = "@@ash-vscreen "
    private const val START_TIMEOUT_MS = 12_000L

    private val lock = Any()
    private val writeLock = Any()
    @Volatile private var proc: PrivProcess? = null
    @Volatile private var stdin: OutputStream? = null
    @Volatile private var dead = true
    private val pending = ConcurrentHashMap<Int, LinkedBlockingQueue<JSONObject>>()
    private val seq = AtomicInteger()
    private val errTail = StringBuilder()

    /** The server process is up (does not start it). */
    fun running(): Boolean = !dead && proc != null

    /**
     * Sends one request and waits for its reply. Starts the server first when needed
     * (requires Shizuku ready). Never throws for server-side errors: they come back as {ok:false,error}.
     */
    fun call(ctx: Context, op: String, args: JSONObject = JSONObject(), timeoutMs: Long = 10_000, start: Boolean = true): JSONObject {
        if (dead) {
            if (!start) return JSONObject().put("ok", false).put("error", "virtual screen server not running")
            ensureStarted(ctx)
        }
        val id = seq.incrementAndGet()
        val q = LinkedBlockingQueue<JSONObject>(1)
        pending[id] = q
        try {
            val line = JSONObject(args.toString()).put("id", id).put("op", op).toString() + "\n"
            synchronized(writeLock) {
                val out = stdin ?: throw IllegalStateException("virtual screen server not running")
                out.write(line.toByteArray(Charsets.UTF_8))
                out.flush()
            }
            return q.poll(timeoutMs, TimeUnit.MILLISECONDS)
                ?: JSONObject().put("ok", false).put("error", "the virtual screen server did not answer $op within ${timeoutMs}ms")
        } catch (e: Throwable) {
            markDead("write failed: ${e.message}")
            return JSONObject().put("ok", false).put("error", "virtual screen server connection lost: ${e.message}${tail()}")
        } finally {
            pending.remove(id)
        }
    }

    fun stop() {
        synchronized(lock) {
            val p = proc
            proc = null
            try { stdin?.close() } catch (e: Throwable) {} // server sees EOF: closes the display, exits
            stdin = null
            dead = true
            if (p != null) {
                Thread({ try { Thread.sleep(1500) } catch (e: Throwable) {}; if (p.alive()) p.destroy() }, "vscreen-reap").apply { isDaemon = true; start() }
            }
        }
    }

    private fun ensureStarted(ctx: Context) {
        synchronized(lock) {
            if (!dead && proc != null) return
            if (!ShizukuState.awaitReady(ctx)) {
                throw IllegalStateException("virtual screens need Shizuku: ${ShizukuState.whyNot(ctx)}")
            }
            val apk = ctx.applicationInfo.sourceDir
            val cmd = "CLASSPATH=${PrivShell.quote(apk)} exec /system/bin/app_process /system/bin --nice-name=ash_vscreen $MAIN"
            proc?.destroy()
            synchronized(errTail) { errTail.setLength(0) }
            val p = PrivShell.spawn("shizuku", cmd)
            val ready = CountDownLatch(1)
            proc = p
            stdin = p.stdin
            dead = false
            Thread({ readReplies(p, ready) }, "vscreen-out").apply { isDaemon = true; start() }
            Thread({ drainErr(p) }, "vscreen-err").apply { isDaemon = true; start() }
            if (!ready.await(START_TIMEOUT_MS, TimeUnit.MILLISECONDS) || dead) {
                val why = tail()
                markDead("start timeout")
                p.destroy()
                throw IllegalStateException("the virtual screen server did not start$why")
            }
            Log.i(TAG, "server started (apk=$apk)")
        }
    }

    private fun readReplies(p: PrivProcess, ready: CountDownLatch) {
        try {
            val r = p.stdout.bufferedReader(Charsets.UTF_8)
            while (true) {
                val line = r.readLine() ?: break
                if (!line.startsWith(PREFIX)) { appendErr(line); continue }
                val o = try { JSONObject(line.substring(PREFIX.length)) } catch (e: Throwable) { continue }
                if (o.optString("event") == "ready") { ready.countDown(); continue }
                val id = o.optInt("id", -1)
                pending[id]?.offer(o)
            }
        } catch (e: Throwable) {
            Log.w(TAG, "reply reader: ${e.message}")
        }
        if (proc === p) markDead("server exited")
        ready.countDown()
    }

    private fun drainErr(p: PrivProcess) {
        try {
            val r = p.stderr.bufferedReader(Charsets.UTF_8)
            while (true) appendErr(r.readLine() ?: break)
        } catch (e: Throwable) {}
    }

    private fun appendErr(line: String) {
        synchronized(errTail) {
            errTail.append(line).append('\n')
            if (errTail.length > 3000) errTail.delete(0, errTail.length - 2000)
        }
    }

    private fun tail(): String = synchronized(errTail) {
        val t = errTail.toString().trim()
        if (t.isEmpty()) "" else " (server log: ${t.takeLast(600).replace('\n', ' ')})"
    }

    private fun markDead(why: String) {
        if (dead) return
        dead = true
        Log.w(TAG, "server gone: $why")
        val err = JSONObject().put("ok", false).put("error", "virtual screen server: $why${tail()}")
        for (q in pending.values) q.offer(err)
    }
}
