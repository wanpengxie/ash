package ai.ash.ui

import ai.ash.apps.Csp
import ai.ash.apps.HostPage
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A card's mini app talks to the host only through checks bound to who it is (MOBILE-ARCH §12.4). */
class MiniGateTest {
    private fun rpc(method: String, params: JSONObject, id: Any = "a1") =
        JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", method).put("params", params).toString()
    private val call = rpc("ash/call", JSONObject().put("member", "service:weather").put("word", "now").put("body", JSONObject().put("city", "杭州")))
    private val send = rpc("ash/send", JSONObject().put("action", "go").put("context", JSONObject().put("a", 1)))

    private fun live(app: String? = "weather"): Pair<MiniGate, MiniGate.Ticket> = MiniGate("card_1", "mini", app).let { g -> g.load(); g to g.ticket() }

    @Test fun aRequestOnTheCurrentPortIsTaken() {
        val (g, t) = live()
        val v = g.check(t, call, 0) as MiniGate.Verdict.Act
        assertEquals("a1", v.id)
        assertEquals("杭州", v.request.getJSONObject("call").getJSONObject("body").getString("city"))
        val s = g.check(t, send, 0) as MiniGate.Verdict.Send
        assertEquals("go", s.action); assertEquals(1, s.context.getInt("a"))
    }

    @Test fun aMessageOfAnOlderPageIsRefused() {
        val (g, old) = live()
        g.load()
        val now = g.ticket()
        assertTrue(g.check(old, call, 0) is MiniGate.Verdict.Refuse)
        assertTrue(g.check(now, call, 0) is MiniGate.Verdict.Act)
        // An older port of the same page (handed again after it came back on screen) too.
        val again = g.ticket()
        assertTrue(g.check(now, call, 10_000) is MiniGate.Verdict.Refuse)
        assertTrue(g.check(again, call, 10_000) is MiniGate.Verdict.Act)
    }

    @Test fun aMessageWithoutOurPortNeverCounts() {
        val (g, _) = live()
        // Not on a port the host handed (a stray postMessage from another frame): nothing.
        val v = g.check(null, call, 0) as MiniGate.Verdict.Refuse
        assertEquals(null, v.id)
        // Off screen: the port is closed and nothing is taken.
        val t = g.ticket(); g.pause()
        assertTrue(g.check(t, call, 0) is MiniGate.Verdict.Refuse)
        assertFalse(g.live(t))
    }

    @Test fun oversizeAndWrongShapesAreRefused() {
        val (g, t) = live()
        val big = rpc("ash/tell", JSONObject().put("text", "字".repeat(30_000)))
        assertTrue(big.length < MiniGate.MAX_BYTES && big.toByteArray().size > MiniGate.MAX_BYTES)
        assertEquals("too_large", (g.check(t, big, 0) as MiniGate.Verdict.Refuse).reason)
        for (bad in listOf(
            "not json", "[]", null,
            JSONObject().put("id", "a").put("method", "ash/send").put("params", JSONObject().put("action", "go")).toString(),   // no jsonrpc
            JSONObject().put("jsonrpc", "2.0").put("method", "ash/send").put("params", JSONObject().put("action", "go")).toString(),   // no id
            rpc("ash/send", JSONObject()), rpc("ash/send", JSONObject().put("action", "x".repeat(65))), rpc("ash/send", JSONObject().put("action", "go").put("context", "x")),
            rpc("ash/call", JSONObject().put("member", "").put("word", "w")), rpc("ash/call", JSONObject().put("member", "m").put("word", "w").put("body", 1)),
            rpc("ash/ask", JSONObject().put("text", "")), rpc("ash/tell", JSONObject().put("text", 5)),
            rpc("ash/eval", JSONObject()), rpc("ash/send", JSONObject().put("action", "go"), id = 1.5),
        )) assertTrue(bad.toString(), g.check(t, bad, 100_000) is MiniGate.Verdict.Refuse)
    }

    @Test fun aCardWithoutAnAppOnlySends() {
        val (g, t) = live(app = null)
        assertEquals(MiniGate.CARD_ORIGIN, g.origin)
        for (m in listOf("ash/call", "ash/ask", "ash/tell")) {
            val params = if (m == "ash/call") JSONObject().put("member", "m").put("word", "w") else JSONObject().put("text", "hi")
            assertEquals(m, "not_allowed", (g.check(t, rpc(m, params), 0) as MiniGate.Verdict.Refuse).reason)
        }
        assertTrue(g.check(t, send, 0) is MiniGate.Verdict.Send)
        // Nor does a page claiming an app it is not.
        assertEquals(MiniGate.CARD_ORIGIN, MiniGate("c", "m", "../evil").origin)
        assertEquals("https://weather.ash-app.invalid", MiniGate("c", "m", "weather").origin)
    }

    @Test fun whoItIsComesFromTheHostNotTheMessage() {
        val (g, t) = live()
        val spoof = rpc("ash/call", JSONObject().put("member", "m").put("word", "w").put("card", "card_other").put("component", "x").put("app", "bank"))
        val v = g.check(t, spoof, 0) as MiniGate.Verdict.Act
        val body = g.actBody(v.request, JSONObject().put("k", 1))
        assertEquals("card_1", body.getString("card"))
        assertEquals("mini", body.getString("component"))
        assertFalse(body.toString().contains("card_other"))
        assertFalse(body.toString().contains("bank"))
        assertEquals(setOf("member", "word", "body"), v.request.getJSONObject("call").keySet())
    }

    @Test fun ratesAsBefore() {
        val (g, t) = live()
        assertTrue(g.check(t, send, 0) is MiniGate.Verdict.Send)
        assertEquals("too_fast", (g.check(t, send, 500) as MiniGate.Verdict.Refuse).reason)
        assertTrue(g.check(t, send, 900) is MiniGate.Verdict.Send)
        assertTrue(g.check(t, call, 0) is MiniGate.Verdict.Act)
        assertTrue(g.check(t, call, 100) is MiniGate.Verdict.Act)
        assertTrue(g.check(t, call, 200) is MiniGate.Verdict.Refuse)
        assertTrue(g.check(t, call, 1000) is MiniGate.Verdict.Act)
    }

    @Test fun answersAreJsonRpcWithTheSameId() {
        val g = MiniGate("c", "m", "weather")
        val r = JSONObject(g.reply(7, JSONObject().put("state", "ok").put("text", "晴")))
        assertEquals("2.0", r.getString("jsonrpc")); assertEquals(7, r.getInt("id")); assertEquals("晴", r.getJSONObject("result").getString("text"))
        assertTrue(JSONObject(g.refusal("a", "not_allowed")).has("error"))
    }

    @Test fun thePageGetsTheAppPagesRulesAndShimFirstAndNoJsObject() {
        val g = MiniGate("c", "m", "weather")
        val doc = g.document("<!DOCTYPE html><html><head><script>ash.send('go',{a:1})</script></head></html>", mapOf("bg" to "rgba(0,0,0,1.000)"), true, "tok_12345678")
        assertTrue(doc.startsWith("<!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\" content=\"${Csp.inlineOnly().header()}\">"))
        assertTrue(doc.indexOf("tok_12345678") < doc.indexOf("<html>"))
        assertTrue(doc.indexOf("--ash-bg:rgba(0,0,0,1.000)") < doc.indexOf("<html>"))
        assertTrue(doc.indexOf("Object.defineProperty(window, \"ash\"") < doc.indexOf("ash.send('go'"))
        assertTrue(doc.contains("color-scheme:dark"))
        for (word in listOf("\"ash/send\"", "\"ash/call\"", "\"ash/ask\"", "\"ash/tell\"")) assertTrue(word, doc.contains(word))
        assertFalse(doc.contains("__ashCard")); assertFalse(doc.contains("__ashReply"))
        // Without an app: send only.
        val sandbox = MiniGate("c", "m", null).document("<p>hi</p>", emptyMap(), false, "tok_12345678")
        assertTrue(sandbox.contains("if (false)"))
        assertTrue(sandbox.endsWith("<p>hi</p>"))
    }

    @Test fun aCardsPolicyIsInlineOnlyAndAllowsNoRequest() {
        val h = Csp.inlineOnly().header()
        assertTrue(h.startsWith("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:"))
        assertTrue(h.contains("connect-src 'none'")); assertTrue(h.contains("frame-src 'none'")); assertTrue(h.contains("form-action 'none'"))
        assertFalse(h.contains("'self'")); assertFalse(h.contains("unsafe-eval"))
        assertFalse(Csp.inlineOnly().allows("https://card.ash-card.invalid/x"))
        // An app page's own policy is as it was.
        assertTrue(Csp(emptyList(), emptyList()).header().contains("script-src 'self' 'unsafe-inline';"))
        // The shim takes a later port only as `token#n`, n counting up; the same handshake again changes nothing.
        val shim = HostPage.shim("tok_12345678")
        assertTrue(shim.contains("TOKEN + \"#\"")); assertTrue(shim.contains("n <= epoch"))
    }

    @Test fun atMostThreeMiniAppsAliveTheOldestSeenGoesFirst() {
        val b = MiniBudget<String>(3)
        assertEquals(emptyList<String>(), b.seen("a")); b.seen("b"); b.seen("c")
        b.seen("a")
        assertEquals(listOf("b"), b.seen("d"))
        assertEquals(3, b.size())
        b.gone("a")
        assertEquals(emptyList<String>(), b.seen("e"))
    }
}
