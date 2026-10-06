package ai.ash.host

import android.content.Context
import android.util.Log
import ai.ash.host.cap.Capabilities
import ai.ash.host.cap.CapResult
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * The host bridge: a loopback HTTP/1.1 service ash core talks to (see packages/core/src/host.ts).
 *   GET  /manifest          the phone's capabilities       POST /call {capability, args, caller}
 *   POST /present           show a notification            POST /present/hide {id}
 *   POST /alarm {at}        wake ash core at a time        GET /key, POST /sign {data}
 *   POST /restart {reason?} restart ash core (e.g. after a plugin change); answered before it happens
 * Every other app on the phone can reach loopback ports, so every request carries the bearer
 * token that only ash core (started by us, with the token in its config) knows.
 */
class HostServer(private val ctx: Context, private val token: String) {
    private val decisions = ScreenDecisionHost(ctx)
    private val pool = Executors.newCachedThreadPool()
    private var server: ServerSocket? = null
    var port = 0
        private set

    fun start(preferred: Int): Int {
        val s = try {
            ServerSocket(preferred, 32, InetAddress.getByName("127.0.0.1"))
        } catch (e: Exception) {
            ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"))
        }
        server = s
        port = s.localPort
        pool.execute {
            while (!s.isClosed) {
                val c = try { s.accept() } catch (e: Exception) { break }
                try { pool.execute { hostClientRequest({ error -> Log.w(TAG, "host client failed", error) }) { serve(c) } } }
                catch (_: RejectedExecutionException) { try { c.close() } catch (_: IOException) {} }
            }
        }
        Log.i(TAG, "host bridge on 127.0.0.1:$port")
        return port
    }

    fun stop() {
        try { server?.close() } catch (_: Exception) {}
        pool.shutdownNow()
    }

    private fun serve(sock: Socket) {
        sock.use { s ->
            s.soTimeout = 200_000
            val input = BufferedInputStream(s.getInputStream())
            val requestLine = readLine(input) ?: return
            val parts = requestLine.split(" ")
            if (parts.size < 2) return
            val method = parts[0]
            val path = parts[1].substringBefore('?')
            val headers = HashMap<String, String>()
            while (true) {
                val l = readLine(input) ?: return
                if (l.isEmpty()) break
                val i = l.indexOf(':')
                if (i > 0) headers[l.substring(0, i).trim().lowercase()] = l.substring(i + 1).trim()
            }
            val len = headers["content-length"]?.toIntOrNull() ?: 0
            if (len > 16 * 1024 * 1024) return respond(s, 413, JSONObject().put("error", "too_large"))
            val body = if (len > 0) readN(input, len) else ByteArray(0)
            val auth = headers["authorization"]?.removePrefix("Bearer ")?.trim() ?: ""
            if (!MessageDigest.isEqual(auth.toByteArray(), token.toByteArray())) return respond(s, 401, JSONObject().put("error", "unauthorized"))
            val json = if (body.isNotEmpty()) try { JSONObject(String(body, Charsets.UTF_8)) } catch (e: Exception) { JSONObject() } else JSONObject()
            val out = try {
                route(method, path, json)
            } catch (e: Throwable) {
                Log.w(TAG, "$method $path failed", e)
                500 to JSONObject().put("error", "internal").put("message", e.message ?: e.javaClass.simpleName)
            }
            respond(s, out.first, out.second)
        }
    }

    private fun route(method: String, path: String, b: JSONObject): Pair<Int, JSONObject> = when ("$method $path") {
        "GET /manifest" -> 200 to Capabilities.manifest(ctx)
        "POST /call" -> {
            val capability = b.optString("capability")
            val call = { decisions.call(capability, b.optJSONObject("args") ?: JSONObject(), b.optString("turn")) }
            val r: CapResult = when {
                capability in setOf("screen.see", "screen.screenshot") && (b.optJSONObject("args")?.optInt("display", 0) ?: 0) != 0 -> call()
                capability in setOf("screen.see", "screen.screenshot") -> ai.ash.ui.TaskCapsule.withoutOverlay(call)
                capability.startsWith("screen.") && capability !in setOf("screen.read", "screen.touch_status") -> ai.ash.ui.TaskCapsule.withTouchPassthrough(call)
                capability in setOf("apps.open", "settings.open", "intent.view", "input.key") -> ai.ash.ui.TaskCapsule.withTouchPassthrough(call)
                else -> call()
            }
            200 to r.toJson()
        }
        "POST /task/status" -> if (TaskStatus.accept(ctx, b)) 200 to JSONObject().put("ok", true) else 400 to JSONObject().put("error", "invalid_task_status")
        "POST /present" -> Present.show(ctx, b)
        "POST /island" -> 200 to JSONObject().put("showing", ai.ash.ui.TaskCapsule.showing())
        "POST /decision/surface" -> 200 to decisions.surface(b)
        "POST /decision/screen" -> 200 to decisions.snapshot()
        "POST /decision/return" -> 200 to decisions.returnToAsh(b)
        "POST /decision/virtual-close" -> 200 to decisions.closeVirtual(b)
        "POST /present/hide" -> {
            val id = b.optString("id")
            if (id.isBlank()) 400 to JSONObject().put("error", "id_required")
            else if (Present.hide(ctx, id)) 200 to JSONObject().put("ok", true)
            else 500 to JSONObject().put("error", "store_failed")
        }
        "POST /present/alert" -> {
            val id = b.optString("id")
            if (id.isBlank()) 400 to JSONObject().put("error", "id_required")
            else { Present.alert(ctx, id); 200 to JSONObject().put("ok", true) }
        }
        "POST /alarm" -> {
            Wake.schedule(ctx, if (b.isNull("at")) null else b.optLong("at"))
            200 to JSONObject().put("ok", true)
        }
        "GET /key" -> {
            Keys.ensure()
            200 to JSONObject().put("id", Keys.id()).put("publicKey", Keys.publicKey())
        }
        "POST /sign" -> 200 to JSONObject().put("sig", Keys.sign(Keys.unb64u(b.getString("data"))))
        "POST /restart" -> {
            // The caller is the process about to be stopped: answer first, restart a moment later
            // (the same path as the diagnostics page's 重启: stop it, the supervisor starts it again).
            val reason = b.optString("reason").take(200)
            Thread({
                try { Thread.sleep(RESTART_DELAY_MS) } catch (_: InterruptedException) {}
                CoreProcess(ctx).note("restart requested by ash core${if (reason.isNotEmpty()) ": $reason" else ""}")
                CoreService.start(ctx, CoreService.ACTION_RESTART)
            }, "ash-restart").start()
            200 to JSONObject().put("ok", true)
        }
        else -> 404 to JSONObject().put("error", "not_found")
    }

    private fun respond(s: Socket, status: Int, body: JSONObject) {
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        val head = "HTTP/1.1 $status ${if (status == 200) "OK" else "ERR"}\r\ncontent-type: application/json; charset=utf-8\r\ncontent-length: ${bytes.size}\r\nconnection: close\r\n\r\n"
        s.getOutputStream().apply { write(head.toByteArray()); write(bytes); flush() }
    }

    private fun readLine(i: InputStream): String? {
        val b = ByteArrayOutputStream()
        while (true) {
            val c = i.read()
            if (c < 0) return if (b.size() == 0) null else b.toString("UTF-8")
            if (c == '\n'.code) return b.toString("UTF-8").trimEnd('\r')
            b.write(c)
            if (b.size() > 16 * 1024) return null
        }
    }

    private fun readN(i: InputStream, n: Int): ByteArray {
        val out = ByteArray(n)
        var off = 0
        while (off < n) {
            val r = i.read(out, off, n - off)
            if (r < 0) break
            off += r
        }
        return out
    }

    companion object {
        private const val TAG = "ash.host"
        const val PORT = 4710
        private const val RESTART_DELAY_MS = 500L
    }
}

/** Client deadlines/disconnects are normal; an uncaught worker exception would kill the App. */
internal fun hostClientRequest(onFailure: (Throwable) -> Unit = {}, action: () -> Unit) {
    try { action() }
    catch (_: IOException) { /* The socket is closed by serve's use block. */ }
    catch (error: Throwable) { onFailure(error) }
}
