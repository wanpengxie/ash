package ai.ash.ui

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime

class ChatCardModelTest {
    private fun c(id: String, kind: String, vararg pairs: Pair<String, Any>) = JSONObject().put("id", id).put("component", kind).apply { pairs.forEach { put(it.first, it.second) } }

    @Test fun aPointerWritesWhereTheHubWould() {
        val data = JSONObject().put("list", JSONArray().put(JSONObject().put("done", false)))
        assertTrue(ChatCardModel.write(data, "/name", "Ann"))
        assertTrue(ChatCardModel.write(data, "/a/b/c", 3))
        assertTrue(ChatCardModel.write(data, "/list/0/done", true))
        assertEquals("Ann", data.getString("name"))
        assertEquals(3, data.getJSONObject("a").getJSONObject("b").getInt("c"))
        assertEquals(true, ChatCardModel.read(data, "/list/0/done"))
        // An array only by an index it has; never the root, never a prototype name.
        assertFalse(ChatCardModel.write(data, "/list/1", "x"))
        assertFalse(ChatCardModel.write(data, "/list/x", "x"))
        assertFalse(ChatCardModel.write(data, "/", "x"))
        assertFalse(ChatCardModel.write(data, "name", "x"))
        assertFalse(ChatCardModel.write(data, "/__proto__", "x"))
        // As the hub's setPointer: a plain value on the way becomes an object.
        assertTrue(ChatCardModel.write(data, "/name/first", "x"))
        assertEquals("x", ChatCardModel.read(data, "/name/first"))
    }

    @Test fun aFieldNameIsEscapedInItsPointer() {
        assertEquals("/user", ChatCardModel.pathOf("user"))
        assertEquals("/a~1b~0c", ChatCardModel.pathOf("a/b~c"))
        val data = JSONObject()
        assertTrue(ChatCardModel.write(data, ChatCardModel.pathOf("a/b~c"), "v"))
        assertEquals("v", data.getString("a/b~c"))
        assertEquals("v", ChatCardModel.read(data, "/a~1b~0c"))
        assertNull(ChatCardModel.read(data, "/missing"))
    }

    @Test fun aPasswordShowsOnlyItsLastFourWhenLongEnough() {
        assertEquals("****", ChatCardModel.masked(""))
        assertEquals("****", ChatCardModel.masked("1234567"))
        assertEquals("****5678", ChatCardModel.masked("12345678"))
        assertEquals("****wxyz", ChatCardModel.masked("abcdefghijklmnopqrstuvwxyz"))
        // Characters, not UTF-16 halves.
        assertEquals("****😀😀😀😀", ChatCardModel.masked("😀".repeat(8)))
    }

    @Test fun theFormAnswerCarriesValuesAndOnlyMaskedPasswords() {
        val data = JSONObject().put("host", "example.org").put("port", "22").put("mode", JSONArray().put("ssh"))
        val secret = JSONObject().put("password", "SSH_PASS")
        val typed = mapOf("/password" to "hunter2hunter2")
        val body = ChatCardModel.formAnswer(data, secret, typed)
        assertTrue(body.getBoolean("ok"))
        val out = body.getJSONObject("result").getJSONObject("data")
        val values = out.getJSONObject("values")
        assertEquals(setOf("host", "port", "mode"), values.keySet())
        assertEquals("example.org", values.getString("host"))
        assertEquals(JSONObject().put("ref", "SSH_PASS").put("masked", "****ter2").toString(), out.getJSONObject("secret").getJSONObject("password").toString())
        assertFalse(body.toString().contains("hunter2hunter2"))
        // The working copy is left as it was.
        assertEquals(3, data.length())
    }

    @Test fun aPasswordFieldThatSomehowGotIntoTheDataIsNeverSent() {
        val data = JSONObject().put("password", "oops-typed-here").put("user", "ann")
        val body = ChatCardModel.formAnswer(data, JSONObject().put("password", "P"), mapOf("/password" to "abc"))
        assertFalse(body.toString().contains("oops"))
        assertEquals("****", body.getJSONObject("result").getJSONObject("data").getJSONObject("secret").getJSONObject("password").getString("masked"))
    }

    @Test fun anEmptyPasswordBoxStopsTheForm() {
        val secret = JSONObject().put("token", "API_TOKEN")
        val titles = JSONObject().put("token", "访问令牌")
        assertEquals("请先填写访问令牌", ChatCardModel.missingSecret(secret, titles, emptyMap()))
        assertEquals("请先填写访问令牌", ChatCardModel.missingSecret(secret, titles, mapOf("/token" to "")))
        assertNull(ChatCardModel.missingSecret(secret, titles, mapOf("/token" to "t")))
        assertEquals("请先填写token", ChatCardModel.missingSecret(secret, JSONObject(), emptyMap()))
    }

    @Test fun aFormIsAnsweredLikeAnAsk() {
        val m = ChatCardModel.formMessage("agent:main", "m_1", ChatCardModel.cancelAnswer())
        assertEquals("agent:main", m.getString("to"))
        assertEquals("response", m.getString("kind"))
        assertEquals("form", m.getString("word"))
        assertEquals("m_1", m.getString("reply_to"))
        assertEquals("answer:m_1", m.getString("client_id"))
        val body = m.getJSONObject("body")
        assertFalse(body.getBoolean("ok"))
        assertEquals("cancelled", body.getJSONObject("error").getString("code"))
        assertEquals("主人取消了", body.getJSONObject("error").getString("message"))
    }

    @Test fun anActionIsTheOwnersSayWithTheCardsData() {
        val data = JSONObject().put("count", 3)
        val body = ChatCardModel.sayBody("加一", "c1", "add", JSONObject().put("by", 1), data)
        assertEquals("加一", body.getString("text"))
        val card = body.getJSONObject("card")
        assertEquals("c1", card.getString("id"))
        assertEquals("add", card.getString("action"))
        assertEquals(1, card.getJSONObject("context").getInt("by"))
        assertEquals(3, card.getJSONObject("data").getInt("count"))
        // A copy: what is queued does not change with later edits.
        data.put("count", 4)
        assertEquals(3, card.getJSONObject("data").getInt("count"))
        assertFalse(ChatCardModel.sayBody("x", "c1", "go", null, JSONObject()).getJSONObject("card").has("context"))
    }

    @Test fun aButtonSaysItsVisibleLabel() {
        val byId = listOf(
            c("b1", "Button", "child" to "r1", "action" to JSONObject().put("event", JSONObject().put("name", "buy"))),
            c("r1", "Row", "children" to JSONArray().put("i1").put("t1")),
            c("i1", "Icon", "name" to "star"),
            c("t1", "Text", "text" to "**买** 一份"),
            c("b2", "Button", "child" to "i2", "action" to JSONObject().put("event", JSONObject().put("name", "refresh"))),
            c("i2", "Icon", "name" to "refresh"),
        ).associateBy { it.getString("id") }
        assertEquals("买 一份", ChatCardModel.label(byId, byId.getValue("b1")))
        assertEquals("refresh", ChatCardModel.label(byId, byId.getValue("b2")))
    }

    @Test fun aPlanIsReadWithItsDataAndRoot() {
        val raw = JSONObject().put("root", "root").put("reactive", true).put("binds", JSONArray().put("/n"))
            .put("data", JSONObject().put("n", 2)).put("theme", JSONObject().put("accent", "#3366FFFF"))
            .put("components", JSONArray().put(c("root", "Column", "children" to JSONArray().put("t"))).put(c("t", "Text", "text" to "hi")))
        val plan = ChatCardModel.plan(raw)!!
        assertEquals("root", plan.root)
        assertEquals(setOf("root", "t"), plan.byId.keys)
        assertTrue(plan.reactive)
        assertEquals(2, plan.data.getInt("n"))
        assertEquals("#3366FFFF", plan.accent)
        // The data is a copy: writing the working copy never changes the plan.
        plan.data.put("n", 5)
        assertEquals(2, raw.getJSONObject("data").getInt("n"))
        // No root, no components: nothing to draw (the card's text is shown instead).
        assertNull(ChatCardModel.plan(JSONObject().put("components", JSONArray().put(c("x", "Text")))))
        assertNull(ChatCardModel.plan(JSONObject()))
        assertNull(ChatCardModel.plan(null))
        assertEquals("other", ChatCardModel.plan(JSONObject().put("root", "other").put("components", JSONArray().put(c("other", "Text"))))!!.root)
    }

    @Test fun aClosedCardSaysHowItEnded() {
        assertEquals("已提交", ChatCardModel.stateLine("sent"))
        assertEquals("已取消", ChatCardModel.stateLine("cancelled"))
        assertEquals("已过期", ChatCardModel.stateLine("expired"))
        assertEquals("已结束", ChatCardModel.stateLine("closed"))
        assertNull(ChatCardModel.stateLine("open"))
    }

    @Test fun slidersKeepWholeNumbersWhole() {
        assertEquals(1.0, ChatCardModel.sliderStep(0.0, 10.0, Double.NaN), 0.0)
        assertEquals(0.5, ChatCardModel.sliderStep(0.0, 10.0, 0.5), 0.0)
        assertEquals(0.025, ChatCardModel.sliderStep(0.0, 2.5, Double.NaN), 1e-12)
        assertEquals(7L, ChatCardModel.sliderValue(0.0, 10.0, 1.0, 7))
        assertEquals(10L, ChatCardModel.sliderValue(0.0, 10.0, 1.0, 12))
        assertEquals(0.3, ChatCardModel.sliderValue(0.0, 1.0, 0.1, 3).toDouble(), 0.0)
        assertEquals("0.3", ChatCardModel.number(ChatCardModel.sliderValue(0.0, 1.0, 0.1, 3)))
        assertEquals("7", ChatCardModel.number(7L))
    }

    @Test fun datesAndTimesAreIsoText() {
        assertEquals(LocalDate.of(2026, 10, 15) to null, ChatCardModel.isoParts("2026-10-15"))
        assertEquals(null to LocalTime.of(9, 30), ChatCardModel.isoParts("09:30"))
        assertEquals(LocalDate.of(2026, 10, 15) to LocalTime.of(9, 30), ChatCardModel.isoParts("2026-10-15T09:30:00Z"))
        assertEquals(null to null, ChatCardModel.isoParts(""))
        assertEquals("2026-10-15T09:05", ChatCardModel.iso(LocalDate.of(2026, 10, 15), LocalTime.of(9, 5)))
        assertEquals("2026-10-15", ChatCardModel.iso(LocalDate.of(2026, 10, 15), null))
        assertEquals("21:00", ChatCardModel.iso(null, LocalTime.of(21, 0)))
    }

    @Test fun theMiniAppGetsItsRulesAndBridgeBeforeItsOwnHtml() {
        val doc = ChatCardModel.miniAppDocument("<!DOCTYPE html><html><head><script>ash.send('go',{a:1})</script></head></html>", mapOf("bg" to "rgba(0,0,0,1.000)"), dark = true)
        assertTrue(doc.startsWith("<!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\" content=\"${ChatCardModel.MINI_CSP}\">"))
        assertTrue(doc.indexOf("--ash-bg:rgba(0,0,0,1.000)") < doc.indexOf("<html>"))
        assertTrue(doc.indexOf("window.__ashCard") < doc.indexOf("ash.send('go'"))
        assertTrue(doc.contains("color-scheme:dark"))
        assertTrue(ChatCardModel.MINI_CSP.startsWith("default-src 'none'"))
        assertFalse(ChatCardModel.MINI_CSP.contains("connect-src"))
        assertTrue(ChatCardModel.miniAppDocument("<p>hi</p>", emptyMap(), dark = false).endsWith("<p>hi</p>"))
        assertEquals("rgba(255,0,0,0.502)", ChatCardModel.css(0x80FF0000.toInt()))
    }

    @Test fun feedbackIsTheOwnersSayNamedFeedback() {
        val data = JSONObject().put("x", 1)
        val up = ChatCardModel.feedbackBody("up", "card_1", data)
        assertEquals("👍", up.getString("text"))
        val card = up.getJSONObject("card")
        assertEquals("card_1", card.getString("id"))
        assertEquals("feedback", card.getString("action"))
        assertEquals("up", card.getJSONObject("context").getString("feedback"))
        assertEquals(1, card.getJSONObject("data").getInt("x"))
        val down = ChatCardModel.feedbackBody("down", "card_1", data)
        assertEquals("👎", down.getString("text"))
        assertEquals("down", down.getJSONObject("card").getJSONObject("context").getString("feedback"))
        // What is shown chosen: the tap here first, else what the item says; nothing else counts.
        assertEquals("down", ChatCardModel.feedbackShown("down", "up"))
        assertEquals("up", ChatCardModel.feedbackShown(null, "up"))
        assertNull(ChatCardModel.feedbackShown(null, "meh"))
        assertNull(ChatCardModel.feedbackShown(null, null))
    }

    private fun repoFile(path: String): java.io.File = generateSequence(java.io.File("").absoluteFile) { it.parentFile }.map { java.io.File(it, path) }.first { it.isFile }

    @Test fun everyIconNameOfTheCardLanguageHasItsLineIcon() {
        val src = repoFile("packages/sdk/src/card.ts").readText()
        val list = Regex("export const CARD_ICONS = \\[([^\\]]*)\\]").find(src)!!.groupValues[1]
        val names = Regex("\"([A-Za-z]+)\"").findAll(list).map { it.groupValues[1] }.toList()
        assertTrue(names.size > 50)
        for (name in names) assertTrue("icon $name has no entry", ChatCardModel.ICONS.containsKey(name))
        for (name in ai.ash.widget.CardSpec.icons.keys) assertTrue("icon $name has no entry", ChatCardModel.ICONS.containsKey(name))
        assertEquals(names.toSet(), ChatCardModel.ICONS.keys)
        assertTrue(ChatCardModel.ICONS.values.count { it != null } > names.size / 2)
    }

    @Test fun aPreviewIsAtMost900PxAndShrinksInSteps() {
        // 330 dp at 3x: 990 x 1500 px, the longer side to 900
        val (w, h) = ChatCardModel.previewSize(990, 1500, 0)!!
        assertEquals(900, h); assertEquals(594, w)
        val (w2, h2) = ChatCardModel.previewSize(990, 1500, 1)!!
        assertTrue(w2 < w && h2 < h)
        // never enlarged
        assertEquals(330 to 200, ChatCardModel.previewSize(330, 200, 0))
        assertNull(ChatCardModel.previewSize(990, 1500, ChatCardModel.PREVIEW_SHRINK.size))
        val part = ChatCardModel.previewPart(byteArrayOf(1, 2), 594, 900) { "AQI=" }
        assertEquals("image", part.getString("type"))
        assertEquals("AQI=", part.getString("data"))
        assertEquals("image/png", part.getString("mimeType"))
        assertEquals(594, part.getInt("width")); assertEquals(900, part.getInt("height"))
        assertEquals(300 * 1024, ChatCardModel.PREVIEW_BYTES)
    }
}
