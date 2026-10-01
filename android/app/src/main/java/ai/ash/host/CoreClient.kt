package ai.ash.host

import android.content.Context
import ai.ash.BuildConfig
import ai.ash.host.senses.SenseTransport
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/** The host speaking to ash core's SDK as `device:phone` (owner-level on this phone). */
class CoreClient(ctx: Context) {
    class HttpError(val status: Int, message: String) : java.io.IOException(message)
    private val secrets = Secrets(ctx)

    private fun call(method: String, path: String, body: JSONObject? = null, timeoutMs: Int = 10_000): String {
        val c = URL("http://127.0.0.1:${CoreProcess.PORT}$path").openConnection(Proxy.NO_PROXY) as HttpURLConnection
        c.requestMethod = method
        c.connectTimeout = 3_000
        c.readTimeout = timeoutMs
        c.setRequestProperty("authorization", "Bearer ${secrets.coreToken}")
        if (body != null) {
            c.doOutput = true
            c.setRequestProperty("content-type", "application/json")
            c.outputStream.use { it.write(body.toString().toByteArray()) }
        }
        val code = c.responseCode
        val text = (if (code < 400) c.inputStream else c.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
        if (code >= 400) throw HttpError(code, "ash core $path: $code $text")
        return text
    }

    fun sendPresentAction(payload: JSONObject): JSONObject = JSONObject(call("POST", "/api/send", payload))

    fun agents(): JSONArray = JSONArray(call("GET", "/api/agents"))

    fun manifest(): JSONObject = JSONObject(call("GET", "/api/manifest"))

    /** Only the host's authenticated connection may submit a sensor event. */
    fun sendSense(word: String, body: JSONObject, clientId: String) {
        SenseTransport("http://127.0.0.1:${BuildConfig.SENSE_PORT}", secrets.coreToken).send(word, body, clientId)
    }
}
