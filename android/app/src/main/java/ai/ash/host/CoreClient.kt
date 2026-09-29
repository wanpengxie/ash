package ai.ash.host

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** The host speaking to ash core's SDK as `device:phone` (owner-level on this phone). */
class CoreClient(ctx: Context) {
    private val secrets = Secrets(ctx)

    private fun call(method: String, path: String, body: JSONObject? = null, timeoutMs: Int = 10_000): String {
        val c = URL("http://127.0.0.1:${CoreProcess.PORT}$path").openConnection() as HttpURLConnection
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
        if (code >= 400) error("ash core $path: $code $text")
        return text
    }

    fun answer(id: String, approve: Boolean) {
        call("POST", "/api/confirms/$id", JSONObject().put("approve", approve))
    }

    fun agents(): JSONArray = JSONArray(call("GET", "/api/agents"))

    fun manifest(): JSONObject = JSONObject(call("GET", "/api/manifest"))
}
