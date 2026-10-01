package ai.ash.host.senses

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/** HTTP boundary shared by phone sensors; the token never appears in event data. */
internal class SenseTransport(private val endpoint: String, private val token: String) {
    fun send(word: String, body: JSONObject, clientId: String) {
        require(word in setOf("sense.calendar", "sense.battery", "sense.screen", "sense.notification"))
        require(clientId.isNotBlank())
        val request = JSONObject()
            .put("to", JSONObject.NULL)
            .put("kind", "event")
            .put("word", word)
            .put("body", body)
            .put("client_id", clientId)
        val connection = URL("$endpoint/api/send").openConnection(Proxy.NO_PROXY) as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 3_000
            connection.readTimeout = 5_000
            connection.setRequestProperty("authorization", "Bearer $token")
            connection.setRequestProperty("content-type", "application/json")
            connection.doOutput = true
            connection.outputStream.use { it.write(request.toString().toByteArray(Charsets.UTF_8)) }
            if (connection.responseCode !in 200..299) error("sensor event rejected: HTTP ${connection.responseCode}")
            val result = connection.inputStream.use { JSONObject(it.readBytes().toString(Charsets.UTF_8)) }
            require(result.optString("id").isNotBlank() && result.has("seq") && result.getLong("seq") >= 0) {
                "sensor event acknowledgement is invalid"
            }
        } finally {
            connection.disconnect()
        }
    }
}
