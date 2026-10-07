package ai.ash.apps

import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicInteger

/** What the host does for a view, through Ash: always for the one app the view belongs to. */
interface AppsBackend {
    /** POST /api/apps/<app>/call: an MCP CallToolResult. Throws [AppsError] when Ash or the core refuses. */
    fun callTool(app: String, tool: String, arguments: JSONObject): JSONObject
    /** POST /api/apps/<app>/message. */
    fun sendMessage(app: String, text: String)
}

class AppsError(message: String) : Exception(message)

/** What only the owner's screen can do: ask, open a link. Answers may come later, on any thread. */
interface HostUi {
    fun confirmLink(url: String, answer: (Boolean) -> Unit)
    fun confirmMessage(text: String, answer: (Boolean) -> Unit)
    fun openLink(url: String)
    fun sizeChanged(width: Int?, height: Int?) {}
    fun log(level: String, data: String) {}
}

/**
 * The MCP Apps host for one view (JSON-RPC 2.0, spec 2026-01-26). The view can: initialize, call its own app's tools,
 * ask to open a link (the owner confirms), send Ash a message (the owner confirms), report its size and log. Anything
 * else is "method not found". The app is fixed when the router is made: nothing in a message can point it elsewhere.
 */
class McpHost(
    private val app: String,
    private val appName: String,
    private val hostVersion: String,
    private val csp: Csp,
    private val backend: AppsBackend,
    private val ui: HostUi,
    /** The host context as of now (theme, locale, size …). */
    private val context: () -> JSONObject,
    /** Delivers one message to the view. */
    private val send: (String) -> Unit,
    /** Where calls to Ash run (they may wait long, e.g. for the owner's approval). */
    private val worker: Executor,
) {
    @Volatile var initialized = false
        private set
    private val inFlight = AtomicInteger(0)
    @Volatile private var asking = false

    fun handle(raw: String) {
        if (raw.length > MAX_MESSAGE) return error(null, INVALID_REQUEST, "Message too large")
        val msg = runCatching { JSONObject(raw) }.getOrNull() ?: return error(null, PARSE_ERROR, "Parse error")
        val id = msg.opt("id").takeIf { it is String || it is Number }
        val hasId = msg.has("id") && !msg.isNull("id")
        if (msg.optString("jsonrpc") != "2.0") return if (hasId) error(id, INVALID_REQUEST, "Invalid Request") else Unit
        val method = msg.opt("method") as? String
        if (method == null) {
            // A response to something the host sent (nothing it waits on), or garbage.
            if (!msg.has("result") && !msg.has("error") && hasId) error(id, INVALID_REQUEST, "Invalid Request")
            return
        }
        if (hasId && id == null) return error(null, INVALID_REQUEST, "Invalid Request")
        val params = msg.optJSONObject("params") ?: JSONObject()
        if (id == null) return notification(method, params)
        when (method) {
            "ui/initialize", "initialize" -> result(id, initializeResult(params))
            "ping" -> result(id, JSONObject())
            "tools/call" -> toolsCall(id, params)
            "ui/open-link" -> openLink(id, params)
            "ui/message" -> message(id, params)
            "ui/request-display-mode" -> result(id, JSONObject().put("mode", "fullscreen"))
            // Accepted, kept nowhere yet: Ash has no per-view model context.
            "ui/update-model-context" -> result(id, JSONObject())
            else -> error(id, METHOD_NOT_FOUND, "Method not found: ${method.take(80)}")
        }
    }

    /** Host → view: the context changed (theme, size). Only once the view said it is initialized. */
    fun contextChanged(partial: JSONObject) { if (initialized) notify("ui/notifications/host-context-changed", partial) }

    private fun notification(method: String, params: JSONObject) {
        when (method) {
            "ui/notifications/initialized", "notifications/initialized" -> {
                if (initialized) return
                initialized = true
                // Opened as a page of its own, not by a tool call: no arguments to give.
                notify("ui/notifications/tool-input", JSONObject().put("arguments", JSONObject()))
            }
            "ui/notifications/size-changed" -> ui.sizeChanged(
                params.optDouble("width").takeIf { !it.isNaN() }?.toInt(), params.optDouble("height").takeIf { !it.isNaN() }?.toInt())
            "notifications/message" -> ui.log(params.optString("level", "info").take(16), params.opt("data")?.toString()?.take(2000) ?: "")
            else -> Unit // Other notifications need nothing from the host.
        }
    }

    private fun initializeResult(params: JSONObject): JSONObject = JSONObject()
        .put("protocolVersion", PROTOCOL_VERSION)
        .put("hostInfo", JSONObject().put("name", "ash-apps").put("version", hostVersion))
        .put("hostCapabilities", JSONObject()
            .put("openLinks", JSONObject())
            .put("serverTools", JSONObject())
            .put("logging", JSONObject())
            .put("sandbox", JSONObject().put("csp", csp.toJson())))
        .put("hostContext", context()
            .put("displayMode", "fullscreen")
            .put("availableDisplayModes", JSONArray().put("fullscreen"))
            .put("platform", "mobile")
            .put("deviceCapabilities", JSONObject().put("touch", true).put("hover", false))
            .put("userAgent", "ash-apps/$hostVersion ($appName)"))

    private fun toolsCall(id: Any, params: JSONObject) {
        val name = params.opt("name") as? String
        if (name == null || !TOOL.matches(name)) return error(id, INVALID_PARAMS, "Invalid tool name")
        val args = when (val a = params.opt("arguments")) { null, JSONObject.NULL -> JSONObject(); is JSONObject -> a; else -> return error(id, INVALID_PARAMS, "arguments must be an object") }
        if (inFlight.incrementAndGet() > MAX_IN_FLIGHT) { inFlight.decrementAndGet(); return error(id, SERVER_ERROR, "Too many calls in flight") }
        worker.execute {
            try { result(id, backend.callTool(app, name, args)) }
            catch (e: AppsError) { error(id, SERVER_ERROR, e.message ?: "Tool call failed") }
            catch (e: Exception) { error(id, SERVER_ERROR, "Tool call failed") }
            finally { inFlight.decrementAndGet() }
        }
    }

    private fun openLink(id: Any, params: JSONObject) {
        val url = params.opt("url") as? String
        if (url == null || !webLink(url)) return error(id, SERVER_ERROR, "Invalid URL")
        if (asking) return error(id, SERVER_ERROR, "Link opening denied by user")
        asking = true
        ui.confirmLink(url) { yes ->
            asking = false
            if (yes) { ui.openLink(url); result(id, JSONObject()) } else error(id, SERVER_ERROR, "Link opening denied by user")
        }
    }

    private fun message(id: Any, params: JSONObject) {
        val text = messageText(params) ?: return error(id, INVALID_PARAMS, "Invalid message format")
        if (asking) return error(id, SERVER_ERROR, "Message sending denied")
        asking = true
        ui.confirmMessage(text) { yes ->
            asking = false
            if (!yes) return@confirmMessage error(id, SERVER_ERROR, "Message sending denied")
            worker.execute {
                try { backend.sendMessage(app, text); result(id, JSONObject()) }
                catch (e: AppsError) { error(id, SERVER_ERROR, e.message ?: "Message sending failed") }
                catch (e: Exception) { error(id, SERVER_ERROR, "Message sending failed") }
            }
        }
    }

    private fun notify(method: String, params: JSONObject) =
        send(JSONObject().put("jsonrpc", "2.0").put("method", method).put("params", params).toString())

    private fun result(id: Any, result: JSONObject) =
        send(JSONObject().put("jsonrpc", "2.0").put("id", id).put("result", result).toString())

    private fun error(id: Any?, code: Int, message: String) =
        send(JSONObject().put("jsonrpc", "2.0").put("id", id ?: JSONObject.NULL).put("error", JSONObject().put("code", code).put("message", message)).toString())

    companion object {
        const val PROTOCOL_VERSION = "2026-01-26"
        const val PARSE_ERROR = -32700
        const val INVALID_REQUEST = -32600
        const val METHOD_NOT_FOUND = -32601
        const val INVALID_PARAMS = -32602
        const val SERVER_ERROR = -32000
        const val MAX_MESSAGE = 4 shl 20
        const val MAX_IN_FLIGHT = 8
        private val TOOL = Regex("[A-Za-z0-9_][A-Za-z0-9_./-]{0,127}")

        /** Only http(s), with a host, no credentials in it. */
        fun webLink(url: String): Boolean {
            if (url.length > 2048) return false
            val u = runCatching { java.net.URI(url) }.getOrNull() ?: return false
            return (u.scheme == "https" || u.scheme == "http") && !u.host.isNullOrEmpty() && u.rawUserInfo == null
        }

        /** ui/message content: one text block, or a list of blocks whose text parts are joined. */
        fun messageText(params: JSONObject): String? {
            if (params.has("role") && params.optString("role") != "user") return null
            val blocks = when (val c = params.opt("content")) {
                is JSONObject -> listOf(c)
                is JSONArray -> (0 until c.length()).mapNotNull { c.opt(it) as? JSONObject }
                else -> return null
            }
            val text = blocks.filter { it.optString("type") == "text" }.mapNotNull { it.opt("text") as? String }.joinToString("\n").trim()
            return text.takeIf { it.isNotEmpty() && it.length <= 8000 }
        }
    }
}
