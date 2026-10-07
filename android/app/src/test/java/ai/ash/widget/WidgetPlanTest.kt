package ai.ash.widget

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class WidgetPlanTest {
    private fun c(id: String, kind: String, vararg pairs: Pair<String, Any>) = JSONObject().put("id", id).put("component", kind).apply { pairs.forEach { put(it.first, it.second) } }
    private fun a2ui(vararg components: JSONObject) = JSONObject().put("root", "root").put("components", JSONArray(components.toList()))

    private val weather = a2ui(
        c("root", "Column", "children" to JSONArray(listOf("head", "temp", "bar", "line", "buttons"))),
        c("head", "Row", "children" to JSONArray(listOf("icon", "city", "badge")), "justify" to "spaceBetween"),
        c("icon", "Image", "url" to "icon:sun"),
        c("city", "Text", "text" to "上海", "variant" to "caption"),
        c("badge", "Badge", "text" to "晴"),
        c("temp", "Text", "text" to "23", "variant" to "h1"),
        c("bar", "ProgressBar", "value" to 40, "label" to "降雨"),
        c("line", "Divider"),
        c("buttons", "Row", "children" to JSONArray(listOf("refresh"))),
        c("refresh", "Button", "child" to "refresh_label", "action" to JSONObject().put("event", JSONObject().put("name", "refresh"))),
        c("refresh_label", "Text", "text" to "刷新"))

    @Test fun mapsTheSubsetToARenderPlan() {
        val root = WidgetPlan.plan(weather) as WNode.Box
        assertTrue(root.vertical)
        val head = root.children[0] as WNode.Box
        assertFalse(head.vertical); assertTrue(head.spread)
        assertEquals(WNode.Icon("☀️"), head.children[0])
        assertEquals(WNode.Text("上海", TextStyle.CAPTION), head.children[1])
        assertEquals(WNode.Badge("晴"), head.children[2])
        assertEquals(WNode.Text("23", TextStyle.NUMBER), root.children[1])
        assertEquals(WNode.Progress(40, "降雨"), root.children[2])
        assertEquals(WNode.Divider, root.children[3])
        assertEquals(listOf(WNode.Button("刷新", "refresh")), WidgetPlan.actions(root))
    }

    @Test fun spreadRowsKeepChildrenAtTheirOwnWidthWithGapsBetween() {
        val head = (WidgetPlan.plan(weather) as WNode.Box).children[0] as WNode.Box
        // The icon keeps to the city; one gap pushes the badge to the far end.
        assertEquals(listOf(WNode.Icon("☀️"), WNode.Text("上海", TextStyle.CAPTION), null, WNode.Badge("晴")), WidgetPlan.rowSlots(head))
        val around = WidgetPlan.plan(a2ui(c("root", "Row", "children" to JSONArray(listOf("a", "b")), "justify" to "spaceEvenly"),
            c("a", "Text", "text" to "a"), c("b", "Text", "text" to "b"))) as WNode.Box
        assertEquals(listOf(null, WNode.Text("a", TextStyle.BODY), null, WNode.Text("b", TextStyle.BODY), null), WidgetPlan.rowSlots(around))
        val plain = WidgetPlan.plan(a2ui(c("root", "Row", "children" to JSONArray(listOf("a", "b"))),
            c("a", "Image", "url" to "icon:cloud"), c("b", "Text", "text" to "霾"))) as WNode.Box
        assertEquals(plain.children, WidgetPlan.rowSlots(plain))
        val centred = WidgetPlan.plan(a2ui(c("root", "Row", "children" to JSONArray(listOf("a")), "align" to "center"), c("a", "Text", "text" to "a"))) as WNode.Box
        assertFalse(centred.center)
    }

    @Test fun theFrameLeavesOutATitleTheCardAlreadyOpensWith() {
        val today = WidgetPlan.plan(a2ui(c("root", "Column", "children" to JSONArray(listOf("t", "w"))),
            c("t", "Text", "text" to "今日", "variant" to "h3"),
            c("w", "Row", "children" to JSONArray(listOf("i", "s", "d")), "justify" to "spaceBetween"),
            c("i", "Image", "url" to "icon:cloud"), c("s", "Text", "text" to "霾"), c("d", "Text", "text" to "19℃ · 今 16-28℃")))
        assertTrue(WidgetPlan.opensWithTitle(today, "今日"))
        assertTrue(WidgetPlan.opensWithTitle(today, " 今日 "))
        assertFalse(WidgetPlan.opensWithTitle(today, "天气"))
        assertFalse(WidgetPlan.opensWithTitle(today, ""))
        // A heading row with a leading icon still counts; content that opens with something else keeps the frame title.
        val headed = WidgetPlan.plan(a2ui(c("root", "Column", "children" to JSONArray(listOf("h", "n"))),
            c("h", "Row", "children" to JSONArray(listOf("i", "t"))), c("i", "Image", "url" to "icon:weight"),
            c("t", "Text", "text" to "体重"), c("n", "Text", "text" to "61.8", "variant" to "h1")))
        assertTrue(WidgetPlan.opensWithTitle(headed, "体重"))
        assertFalse(WidgetPlan.opensWithTitle(WidgetPlan.plan(weather), "今天天气"))
    }

    @Test fun textVariantsAndAvatar() {
        val plan = WidgetPlan.plan(a2ui(c("root", "Column", "children" to JSONArray(listOf("a", "b", "c", "d"))),
            c("a", "Text", "text" to "标题", "variant" to "h2"), c("b", "Text", "text" to "正文"),
            c("c", "Image", "url" to "avatar"), c("d", "Text", "text" to "x", "variant" to "h5"))) as WNode.Box
        assertEquals(listOf(WNode.Text("标题", TextStyle.TITLE), WNode.Text("正文", TextStyle.BODY), WNode.Avatar, WNode.Text("x", TextStyle.BODY)), plan.children)
    }

    @Test fun refusesWhatTheSubsetDoesNotAllow() {
        fun bad(vararg components: JSONObject) = assertTrue(runCatching { WidgetPlan.plan(a2ui(*components)) }.isFailure)
        bad(c("root", "WebView"))
        bad(c("root", "Image", "url" to "https://example.com/x.png"))
        bad(c("root", "Column", "children" to JSONArray(listOf("a"))), c("a", "Row", "children" to JSONArray(listOf("b"))),
            c("b", "Column", "children" to JSONArray(listOf("c"))), c("c", "Row", "children" to JSONArray()))
        val btn = { n: Int -> listOf(c("b$n", "Button", "child" to "l$n", "action" to JSONObject().put("event", JSONObject().put("name", "a$n"))), c("l$n", "Text", "text" to "go")) }
        bad(c("root", "Row", "children" to JSONArray(listOf("b1", "b2", "b3"))), *(btn(1) + btn(2) + btn(3)).toTypedArray())
        bad(c("root", "Column", "children" to JSONArray(listOf("root"))))
    }

    @Test fun cardViewIsBoundExpiredOrUnbound() {
        val state = WidgetPlan.parseState(JSONObject().put("revision", 3)
            .put("cards", JSONArray().put(JSONObject().put("id", "weather").put("title", "今天天气").put("size", "4x2").put("owner", "agent:main")
                .put("updated_at", 1).put("expires_at", 5000).put("a2ui", weather)))
            .put("bindings", JSONObject().put("7", "weather")))
        assertTrue(WidgetPlan.view(state, 7, null, 1000) is CardView.Show)
        assertTrue(WidgetPlan.view(state, 7, null, 5000) is CardView.Expired)
        assertTrue(WidgetPlan.view(state, 8, null, 1000) is CardView.Unbound)
        // A pick on the phone shows until the core knows the binding; a removed card asks for a new pick.
        assertTrue(WidgetPlan.view(state, 8, "weather", 1000) is CardView.Show)
        assertTrue(WidgetPlan.view(state, 8, "gone", 1000) is CardView.Unbound)
        assertTrue(WidgetPlan.view(null, 7, null, 1000) is CardView.Unbound)
    }
}
