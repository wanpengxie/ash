package ai.ash.apps

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class McpHostTest {
    private class FakeBackend : AppsBackend {
        val calls = mutableListOf<Triple<String, String, JSONObject>>()
        val messages = mutableListOf<Pair<String, String>>()
        var fail: String? = null
        override fun callTool(app: String, tool: String, arguments: JSONObject): JSONObject {
            fail?.let { throw AppsError(it) }
            calls += Triple(app, tool, arguments)
            return JSONObject().put("content", JSONArray().put(JSONObject().put("type", "text").put("text", "ok")))
        }
        override fun sendMessage(app: String, text: String) { messages += app to text }
    }

    private class FakeUi(var allow: Boolean = true) : HostUi {
        val asked = mutableListOf<String>()
        val opened = mutableListOf<String>()
        var size: Pair<Int?, Int?>? = null
        override fun confirmLink(url: String, answer: (Boolean) -> Unit) { asked += url; answer(allow) }
        override fun confirmMessage(text: String, answer: (Boolean) -> Unit) { asked += text; answer(allow) }
        override fun openLink(url: String) { opened += url }
        override fun sizeChanged(width: Int?, height: Int?) { size = width to height }
    }

    private val backend = FakeBackend()
    private val ui = FakeUi()
    private val out = mutableListOf<JSONObject>()
    private val host = McpHost("health", "健康", "1.1", Csp(listOf("https://api.example.com"), emptyList()), backend, ui,
        context = { JSONObject().put("theme", "dark").put("locale", "zh-CN") }, send = { out += JSONObject(it) }, worker = { it.run() })

    private fun req(id: Any, method: String, params: JSONObject = JSONObject()) =
        host.handle(JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", method).put("params", params).toString())

    private fun last() = out.last()

    @Test fun initializeAnswersWithHostInfoAndContext() {
        req(1, "ui/initialize", JSONObject().put("protocolVersion", "2026-01-26").put("appCapabilities", JSONObject()))
        val r = last().getJSONObject("result")
        assertEquals(1, last().getInt("id"))
        assertEquals("2026-01-26", r.getString("protocolVersion"))
        assertEquals("ash-apps", r.getJSONObject("hostInfo").getString("name"))
        val ctx = r.getJSONObject("hostContext")
        assertEquals("dark", ctx.getString("theme"))
        assertEquals("fullscreen", ctx.getString("displayMode"))
        assertEquals("zh-CN", ctx.getString("locale"))
        assertEquals("mobile", ctx.getString("platform"))
        assertTrue(r.getJSONObject("hostCapabilities").has("openLinks"))
        assertEquals("https://api.example.com", r.getJSONObject("hostCapabilities").getJSONObject("sandbox").getJSONObject("csp").getJSONArray("connectDomains").getString(0))
    }

    @Test fun initializedNotificationSendsToolInputOnceAndUnlocksContextChanges() {
        host.contextChanged(JSONObject().put("theme", "light"))
        assertTrue(out.isEmpty())
        host.handle("""{"jsonrpc":"2.0","method":"ui/notifications/initialized","params":{}}""")
        host.handle("""{"jsonrpc":"2.0","method":"ui/notifications/initialized","params":{}}""")
        assertEquals(1, out.size)
        assertEquals("ui/notifications/tool-input", last().getString("method"))
        assertFalse(last().has("id"))
        host.contextChanged(JSONObject().put("theme", "light"))
        assertEquals("ui/notifications/host-context-changed", last().getString("method"))
    }

    @Test fun toolsCallGoesToThisAppOnly() {
        req("a", "tools/call", JSONObject().put("name", "health.today").put("arguments", JSONObject().put("x", 1)).put("app", "bank"))
        assertEquals(Triple("health", "health.today", JSONObject().put("x", 1)).toString(), backend.calls.single().let { Triple(it.first, it.second, it.third) }.toString())
        assertEquals("a", last().getString("id"))
        assertEquals("ok", last().getJSONObject("result").getJSONArray("content").getJSONObject(0).getString("text"))
    }

    @Test fun toolsCallRejectsBadNamesAndArguments() {
        req(2, "tools/call", JSONObject().put("name", "../bank/call"))
        assertEquals(McpHost.INVALID_PARAMS, last().getJSONObject("error").getInt("code"))
        req(3, "tools/call", JSONObject().put("name", "app:bank.pay"))
        assertEquals(McpHost.INVALID_PARAMS, last().getJSONObject("error").getInt("code"))
        req(4, "tools/call", JSONObject().put("name", "health.log").put("arguments", JSONArray()))
        assertEquals(McpHost.INVALID_PARAMS, last().getJSONObject("error").getInt("code"))
        assertTrue(backend.calls.isEmpty())
    }

    @Test fun toolsCallFailureIsAJsonRpcError() {
        backend.fail = "not granted"
        req(5, "tools/call", JSONObject().put("name", "health.today"))
        val e = last().getJSONObject("error")
        assertEquals(McpHost.SERVER_ERROR, e.getInt("code"))
        assertEquals("not granted", e.getString("message"))
        assertEquals(5, last().getInt("id"))
    }

    @Test fun openLinkAsksAndOnlyOpensWebLinks() {
        req(6, "ui/open-link", JSONObject().put("url", "https://example.com/a"))
        assertEquals(listOf("https://example.com/a"), ui.opened)
        assertTrue(last().has("result"))
        req(7, "ui/open-link", JSONObject().put("url", "intent://x#Intent;end"))
        assertEquals(McpHost.SERVER_ERROR, last().getJSONObject("error").getInt("code"))
        req(8, "ui/open-link", JSONObject().put("url", "javascript:alert(1)"))
        assertEquals("Invalid URL", last().getJSONObject("error").getString("message"))
        ui.allow = false
        req(9, "ui/open-link", JSONObject().put("url", "https://example.com/b"))
        assertEquals("Link opening denied by user", last().getJSONObject("error").getString("message"))
        assertEquals(1, ui.opened.size)
    }

    @Test fun messageAcceptsBlockOrListAndGoesToThisApp() {
        req(10, "ui/message", JSONObject().put("role", "user").put("content", JSONObject().put("type", "text").put("text", "记一下体重")))
        req(11, "ui/message", JSONObject().put("role", "user").put("content", JSONArray().put(JSONObject().put("type", "text").put("text", "a")).put(JSONObject().put("type", "text").put("text", "b"))))
        assertEquals(listOf("health" to "记一下体重", "health" to "a\nb"), backend.messages)
        req(12, "ui/message", JSONObject().put("content", JSONObject().put("type", "image")))
        assertEquals(McpHost.INVALID_PARAMS, last().getJSONObject("error").getInt("code"))
        ui.allow = false
        req(13, "ui/message", JSONObject().put("content", JSONObject().put("type", "text").put("text", "x")))
        assertEquals("Message sending denied", last().getJSONObject("error").getString("message"))
        assertEquals(2, backend.messages.size)
    }

    @Test fun unknownMethodsAndBadMessagesGetErrorShapes() {
        req(14, "resources/read", JSONObject().put("uri", "ui://x"))
        assertEquals(McpHost.METHOD_NOT_FOUND, last().getJSONObject("error").getInt("code"))
        assertEquals(14, last().getInt("id"))
        host.handle("{not json")
        assertEquals(McpHost.PARSE_ERROR, last().getJSONObject("error").getInt("code"))
        assertTrue(last().isNull("id"))
        host.handle("""{"jsonrpc":"1.0","id":15,"method":"ping"}""")
        assertEquals(McpHost.INVALID_REQUEST, last().getJSONObject("error").getInt("code"))
        host.handle("""{"jsonrpc":"2.0","id":{"x":1},"method":"ping"}""")
        assertEquals(McpHost.INVALID_REQUEST, last().getJSONObject("error").getInt("code"))
        req(16, "ping")
        assertEquals(0, last().getJSONObject("result").length())
        req(17, "ui/request-display-mode", JSONObject().put("mode", "pip"))
        assertEquals("fullscreen", last().getJSONObject("result").getString("mode"))
    }

    @Test fun notificationsNeverGetAnswers() {
        host.handle("""{"jsonrpc":"2.0","method":"ui/notifications/size-changed","params":{"width":320,"height":480}}""")
        host.handle("""{"jsonrpc":"2.0","method":"something/unknown"}""")
        host.handle("""{"jsonrpc":"2.0","id":3,"result":{}}""")
        assertTrue(out.isEmpty())
        assertEquals(320 to 480, ui.size)
    }

    @Test fun tooManyCallsInFlightAreRefused() {
        val queued = mutableListOf<Runnable>()
        val slow = McpHost("health", "健康", "1", Csp(emptyList(), emptyList()), backend, ui, { JSONObject() }, { out += JSONObject(it) }, { queued += it })
        repeat(McpHost.MAX_IN_FLIGHT + 1) { slow.handle(JSONObject().put("jsonrpc", "2.0").put("id", it).put("method", "tools/call").put("params", JSONObject().put("name", "t")).toString()) }
        assertEquals(McpHost.MAX_IN_FLIGHT, queued.size)
        assertEquals("Too many calls in flight", last().getJSONObject("error").getString("message"))
        queued.forEach { it.run() }
        assertEquals(McpHost.MAX_IN_FLIGHT, backend.calls.size)
    }
}
