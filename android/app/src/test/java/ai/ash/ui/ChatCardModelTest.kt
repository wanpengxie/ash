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

    @Test fun aColourAsCss() {
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

    // --- the card runtime ---

    @Test fun aPressIsTheActWithTheCardsValuesNow() {
        val data = JSONObject().put("city", "杭州")
        val body = ChatCardModel.actBody("card_1", "go", data)
        assertEquals("card_1", body.getString("card"))
        assertEquals("go", body.getString("component"))
        assertEquals("杭州", body.getJSONObject("data").getString("city"))
        assertFalse(body.has("request"))
        // A copy: what is sent does not change with later edits.
        data.put("city", "北京")
        assertEquals("杭州", body.getJSONObject("data").getString("city"))
        val req = JSONObject().put("ask", JSONObject().put("text", "hi"))
        assertEquals("hi", ChatCardModel.actBody("card_1", "app", data, req).getJSONObject("request").getJSONObject("ask").getString("text"))
    }

    @Test fun onlyCallAskAndTellAreRunByTheHub() {
        assertTrue(ChatCardModel.hubAction(JSONObject().put("call", JSONObject().put("member", "service:x").put("word", "w"))))
        assertTrue(ChatCardModel.hubAction(JSONObject().put("ask", JSONObject().put("text", "?"))))
        assertTrue(ChatCardModel.hubAction(JSONObject().put("tell", JSONObject().put("text", "!"))))
        assertFalse(ChatCardModel.hubAction(JSONObject().put("copy", JSONObject().put("text", "x"))))
        assertFalse(ChatCardModel.hubAction(JSONObject().put("event", JSONObject().put("name", "x"))))
        assertFalse(ChatCardModel.hubAction(null))
        // The wait: the action's own time and 5 s more, else 35 s.
        assertEquals(35_000L, ChatCardModel.pressTimeoutMs(null))
        assertEquals(35_000L, ChatCardModel.pressTimeoutMs(JSONObject().put("tell", JSONObject().put("text", "!"))))
        assertEquals(65_000L, ChatCardModel.pressTimeoutMs(JSONObject().put("call", JSONObject().put("timeout_s", 60))))
        assertEquals(15_000L, ChatCardModel.pressTimeoutMs(JSONObject().put("ask", JSONObject().put("timeout_s", 10))))
    }

    @Test fun aButtonDoesNothingWhileItRuns() {
        val now = 1_000_000L
        val running = JSONObject().put("state", "running").put("text", "处理中…").put("at", now - 5_000)
        assertTrue(ChatCardModel.pressBusy(true, null, now, 35_000))
        assertTrue(ChatCardModel.pressBusy(false, running, now, 35_000))
        // Past its time it may be pressed again; done or failed it may always.
        assertFalse(ChatCardModel.pressBusy(false, running, now + 31_000, 35_000))
        assertFalse(ChatCardModel.pressBusy(false, JSONObject().put("state", "ok").put("at", now), now, 35_000))
        assertFalse(ChatCardModel.pressBusy(false, JSONObject().put("state", "failed").put("at", now), now, 35_000))
        assertFalse(ChatCardModel.pressBusy(false, null, now, 35_000))
    }

    @Test fun theLineUnderAButtonSaysTheOutcome() {
        val ok = JSONObject().put("state", "ok").put("text", "已完成 · 09:30").put("at", 1)
        val failed = JSONObject().put("state", "failed").put("text", "没有得到允许").put("at", 1)
        assertEquals("已完成 · 09:30" to false, ChatCardModel.outcome(false, null, ok))
        assertEquals("没有得到允许" to true, ChatCardModel.outcome(false, null, failed))
        assertNull(ChatCardModel.outcome(false, null, JSONObject().put("state", "running").put("text", "处理中…")))
        assertNull(ChatCardModel.outcome(false, null, null))
        // What failed here (never reached the hub) and a copy say theirs first.
        assertEquals("没有连上，再点一次试试" to true, ChatCardModel.outcome(false, ChatCardModel.failureText("offline"), ok))
        assertEquals("已复制" to false, ChatCardModel.outcome(true, null, failed))
        assertEquals("等太久了，可以再点一次", ChatCardModel.failureText("timeout"))
        assertEquals("这张卡片已经结束了", ChatCardModel.failureText("conflict"))
    }

    @Test fun aSleepingCardSaysWhenItsDataIsFrom() {
        val zone = java.time.ZoneId.of("Asia/Shanghai")
        val at = java.time.ZonedDateTime.of(2026, 10, 15, 9, 5, 0, 0, zone).toInstant().toEpochMilli()
        val later = at + 3 * 3_600_000L
        assertEquals("已休眠 · 09:05 的数据", ChatCardModel.caption(JSONObject().put("life", "dormant").put("fed_at", at).put("updated_at", later), zone))
        // No live data: the card's own time.
        assertEquals("已休眠 · 12:05 的数据", ChatCardModel.caption(JSONObject().put("life", "dormant").put("updated_at", later), zone))
        assertEquals("09:05 更新", ChatCardModel.caption(JSONObject().put("life", "active").put("fed_at", at), zone))
        assertNull(ChatCardModel.caption(JSONObject().put("life", "active").put("updated_at", at), zone))
        // The line is held from the start for a card of an app with a runtime.
        assertTrue(ChatCardModel.reservesCaption(JSONObject().put("life", "active").put("app", "weather")))
        assertTrue(ChatCardModel.reservesCaption(JSONObject().put("life", "idle").put("temporary_app", true)))
        assertFalse(ChatCardModel.reservesCaption(JSONObject().put("life", "active")))
        assertFalse(ChatCardModel.reservesCaption(JSONObject().put("app", "weather")))
        assertTrue(ChatCardModel.closed(JSONObject().put("state", "open").put("life", "closed")))
        assertTrue(ChatCardModel.closed(JSONObject().put("state", "closed")))
        assertFalse(ChatCardModel.closed(JSONObject().put("state", "open").put("life", "dormant")))
    }

    @Test fun theCardsOnScreenAreReportedOnce() {
        fun item(id: String, card: JSONObject?) = JSONObject().put("id", id).put("type", if (card == null) "say" else "card").apply { if (card != null) put("card", card) }
        val items = listOf(
            item("m1", JSONObject().put("type", "a2ui").put("id", "c1").put("state", "open").put("life", "dormant")),
            item("m2", null),
            item("m3", JSONObject().put("type", "a2ui").put("id", "c2").put("state", "closed")),
            item("m4", JSONObject().put("type", "link").put("id", "l1")),
            item("m5", JSONObject().put("type", "a2ui").put("id", "c3").put("state", "open")),
            item("m6", JSONObject().put("type", "a2ui").put("id", "c1").put("state", "open")),
            item("m7", JSONObject().put("type", "a2ui").put("id", "c4").put("state", "open").put("life", "closed")),
        )
        assertEquals(listOf("c1", "c3"), ChatCardModel.seenIds(items))
        assertEquals(50, ChatCardModel.seenIds((1..80).map { item("m$it", JSONObject().put("type", "a2ui").put("id", "c$it")) }).size)
    }

    @Test fun aMiniAppsRequestIsCheckedAndAnswered() {
        val call = ChatCardModel.miniRequest("""{"call":{"member":"service:weather","word":"now","body":{"city":"杭州"}}}""")!!
        assertEquals("service:weather", call.getJSONObject("call").getString("member"))
        assertEquals("杭州", call.getJSONObject("call").getJSONObject("body").getString("city"))
        assertEquals("{}", ChatCardModel.miniRequest("""{"call":{"member":"m","word":"w"}}""")!!.getJSONObject("call").getJSONObject("body").toString())
        assertEquals("几点了", ChatCardModel.miniRequest("""{"ask":{"text":"几点了"}}""")!!.getJSONObject("ask").getString("text"))
        assertEquals("好了", ChatCardModel.miniRequest("""{"tell":{"text":"好了"}}""")!!.getJSONObject("tell").getString("text"))
        assertNull(ChatCardModel.miniRequest("""{"call":{"member":"","word":"w"}}"""))
        assertNull(ChatCardModel.miniRequest("""{"call":{"member":"m","word":"w","body":[1]}}"""))
        assertNull(ChatCardModel.miniRequest("""{"ask":{"text":""}}"""))
        assertNull(ChatCardModel.miniRequest("""{"ask":{"text":"a"},"tell":{"text":"b"}}"""))
        assertNull(ChatCardModel.miniRequest("""{"event":{"name":"x"}}"""))
        assertNull(ChatCardModel.miniRequest("not json"))
        assertNull(ChatCardModel.miniRequest(null))
        val ok = ChatCardModel.miniAnswer(JSONObject().put("state", "ok").put("text", "已回答").put("result", "晴"), null)
        assertEquals("晴", ok.getString("result"))
        val failed = ChatCardModel.miniAnswer(null, "offline")
        assertEquals("failed", failed.getString("state"))
        assertEquals("没有连上，再点一次试试", failed.getString("text"))
        // At most 2 a second.
        val rate = ChatCardModel.Rate(2, 1000)
        assertTrue(rate.take(0)); assertTrue(rate.take(100)); assertFalse(rate.take(500)); assertTrue(rate.take(1000)); assertFalse(rate.take(1050)); assertTrue(rate.take(1100))
    }

    @Test fun theFormerlyRoundIconsHaveTheirOwnLines() {
        for (name in listOf("sun", "cloud", "rain", "snow", "wind", "moon", "person", "accountCircle", "star", "starHalf", "starOff",
            "volumeUp", "volumeDown", "volumeMute", "volumeOff", "weight", "water", "car")) assertTrue(name, ChatCardModel.ICONS[name] != null)
    }

    @Test fun onlyTheOwnerKeepsACardOfAnAppRunning() {
        val on = ChatCardModel.pinBody("card_1", true)
        assertEquals(setOf("id", "pinned"), on.keySet())
        assertEquals("card_1", on.getString("id"))
        assertTrue(on.getBoolean("pinned"))
        assertFalse(ChatCardModel.pinBody("card_1", false).getBoolean("pinned"))
        assertEquals("常驻", ChatCardModel.PIN_LABEL)
        // The switch: a card of an app that is not closed.
        assertTrue(ChatCardModel.pinnable(JSONObject().put("app", "weather").put("state", "open").put("life", "idle")))
        assertFalse(ChatCardModel.pinnable(JSONObject().put("state", "open").put("life", "active")))
        assertFalse(ChatCardModel.pinnable(JSONObject().put("app", "weather").put("state", "open").put("life", "closed")))
        assertFalse(ChatCardModel.pinnable(JSONObject().put("app", "weather").put("state", "closed")))
        // The line: 「常驻中」 while active and pinned (as shown), the sleeping line stays, a closed card says nothing of it.
        val zone = java.time.ZoneId.of("Asia/Shanghai")
        val at = java.time.ZonedDateTime.of(2026, 10, 15, 9, 5, 0, 0, zone).toInstant().toEpochMilli()
        val card = JSONObject().put("app", "weather").put("state", "open").put("life", "active").put("fed_at", at)
        assertEquals("09:05 更新", ChatCardModel.caption(card, zone))
        assertEquals("常驻中", ChatCardModel.caption(card, zone, pinned = true))
        assertEquals("常驻中", ChatCardModel.caption(JSONObject(card.toString()).put("pinned", true), zone))
        assertEquals("已休眠 · 09:05 的数据", ChatCardModel.caption(JSONObject(card.toString()).put("life", "dormant"), zone, pinned = true))
        assertEquals("09:05 更新", ChatCardModel.caption(JSONObject(card.toString()).put("life", "closed"), zone, pinned = true))
    }
}
