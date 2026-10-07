package ai.ash.host.apps

import ai.ash.BuildConfig
import ai.ash.bridge.Bridge
import ai.ash.bridge.IAppsHost
import ai.ash.host.Paths
import ai.ash.ui.transport.ownerBearerFromPrivateUiUrl
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import android.os.ParcelFileDescriptor
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/**
 * Where the apps shell (ai.ash.apps) connects: it forwards the owner's apps routes ([AppsRoutes]) to the core, as the
 * owner, and nothing else. Every call is refused unless the caller is signed like Ash. The shell never sees the token.
 */
class AppsHostService : Service() {
    override fun onBind(intent: Intent): IBinder = binder

    private val binder = object : IAppsHost.Stub() {
        private fun check() { if (!Bridge.sameSigner(this@AppsHostService, Binder.getCallingUid())) throw SecurityException("only Ash's apps shell may use this") }
        override fun protocol(): Int { check(); return Bridge.PROTOCOL }
        override fun request(method: String?, path: String?, body: String?): ParcelFileDescriptor {
            check()
            val m = method ?: ""
            val p = path ?: ""
            val ctx = applicationContext
            // The pipe is handed back at once; the core may take long (a tool call can wait for the owner's approval).
            return later { if (!AppsRoutes.allowed(m, p)) reply(403, "not an apps route") else forward(ctx, m, p, body ?: "") }
        }
    }

    companion object {
        private const val TAG = "ash.apps"
        private const val MAX_BODY = 1 shl 20
        private const val MAX_REPLY = 16 shl 20

        internal fun reply(status: Int, error: String): JSONObject =
            JSONObject().put("status", status).put("type", "application/json").put("body", JSONObject().put("error", error).toString())

        private fun later(produce: () -> JSONObject): ParcelFileDescriptor {
            val (read, write) = ParcelFileDescriptor.createPipe()
            Thread({
                val text = try { produce() } catch (e: Exception) { Log.w(TAG, "apps request failed: ${e.javaClass.simpleName}"); reply(502, "ash core did not answer") }
                runCatching { ParcelFileDescriptor.AutoCloseOutputStream(write).use { it.write(text.toString().toByteArray(Charsets.UTF_8)) } }
            }, "ash-apps-request").start()
            return read
        }

        private fun forward(ctx: Context, method: String, path: String, body: String): JSONObject {
            if (body.length > MAX_BODY) return reply(413, "request too large")
            val record = Paths(ctx).uiUrl
            if (!record.exists()) return reply(503, "ash core is not running")
            val token = ownerBearerFromPrivateUiUrl(record.readText().trim(), BuildConfig.CORE_PORT)
            val c = URL("http://127.0.0.1:${BuildConfig.CORE_PORT}$path").openConnection(Proxy.NO_PROXY) as HttpURLConnection
            try {
                c.instanceFollowRedirects = false
                c.requestMethod = method
                c.connectTimeout = 3_000
                c.readTimeout = if (method == "POST") 5 * 60_000 else 15_000
                c.setRequestProperty("authorization", "Bearer $token")
                if (method == "POST") {
                    val bytes = body.toByteArray(Charsets.UTF_8)
                    c.doOutput = true
                    c.setRequestProperty("content-type", "application/json")
                    c.setFixedLengthStreamingMode(bytes.size)
                    c.outputStream.use { it.write(bytes) }
                }
                val status = try { c.responseCode } catch (e: java.net.ConnectException) { return reply(503, "ash core is not running") }
                if (status in 300..399) return reply(502, "ash core redirected")
                val type = (c.contentType ?: "").take(128)
                val out = ByteArrayOutputStream()
                ((if (status < 400) c.inputStream else c.errorStream))?.use { input ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        if (out.size() + n > MAX_REPLY) return reply(502, "reply too large")
                        out.write(buf, 0, n)
                    }
                }
                val bytes = out.toByteArray()
                val result = JSONObject().put("status", status).put("type", type)
                if (AppsRoutes.textual(type)) {
                    val text = bytes.toString(Charsets.UTF_8)
                    // The owner's credential never leaves Ash, even if a reply carried it.
                    if (text.contains(token)) return reply(502, "credential in core reply")
                    result.put("body", text)
                } else result.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
                return result
            } finally { c.disconnect() }
        }
    }
}
