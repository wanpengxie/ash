package ai.ash.ui

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A push that changes only values is written on the controls in place; the mini app's port takes only what it may (MOBILE-ARCH §12.6, §12.4). */
class CardPatchTest {
    private fun node(id: String, component: String, vararg kv: Pair<String, Any>) =
        JSONObject().put("id", id).put("component", component).apply { for ((k, v) in kv) put(k, v) }

    private fun plan(title: String = "今天", rowKids: List<String> = listOf("a", "b"), extra: List<JSONObject> = emptyList(), data: JSONObject = JSONObject().put("name", "Al")) =
        ChatCardModel.plan(JSONObject().put("root", "root").put("data", data).put("components", JSONArray(listOf(
            node("root", "Column", "children" to JSONArray(listOf("title", "name", "go", "row"))),
            node("title", "Text", "text" to title),
            node("name", "TextField", "bind" to "/name", "label" to "名字"),
            node("go", "Button", "action" to JSONObject().put("call", JSONObject())),
            node("row", "Row", "children" to JSONArray(rowKids)),
            node("a", "Text", "text" to "左"),
            node("b", "Text", "text" to "右"),
        ) + extra)))!!

    /** A stand-in control: what it shows, and how often it was written. */
    class V(var shown: String) { var writes = 0 }

    private fun controls(p: ChatCardModel.Plan, editing: Set<String> = emptySet()): Pair<Map<String, V>, Map<String, ChatCardModel.Control>> {
        val views = p.byId.keys.associateWith { V(p.byId.getValue(it).optString("text")) }
        return views to views.mapValues { (id, v) -> ChatCardModel.Control({ id in editing }) { m -> v.shown = m.optString("text"); v.writes++; true } }
    }

    @Test fun aPushOfValuesIsWrittenInPlaceOnlyOnWhatChanged() {
        val was = plan()
        val now = plan(title = "明天", data = JSONObject().put("name", "Bob"))
        val card = JSONObject()
        val ids = ChatCardModel.changes(was, was.data, card, now, now.data, card)!!
        assertEquals(listOf("title", "name"), ids)
        val (views, ctl) = controls(was)
        val before = views.toMap()
        assertTrue(ChatCardModel.write(ids, now.byId, ctl))
        assertEquals("明天", views.getValue("title").shown)
        // Every control is the one drawn; only the changed ones were written.
        for ((id, v) in views) assertTrue(id, v === before[id])
        assertEquals(mapOf("title" to 1, "name" to 1), views.filterValues { it.writes > 0 }.mapValues { it.value.writes })
        // The hub's state of a button is a value too.
        val running = JSONObject().put("actions", JSONObject().put("go", JSONObject().put("state", "running")))
        assertEquals(listOf("go"), ChatCardModel.changes(was, was.data, card, was, was.data, running))
        // Nothing changed: nothing to write.
        assertEquals(emptyList<String>(), ChatCardModel.changes(was, was.data, card, plan(), was.data, card))
    }

    @Test fun anythingButValuesDrawsTheCardAnew() {
        val was = plan()
        val card = JSONObject()
        fun again(p: ChatCardModel.Plan) = ChatCardModel.changes(was, was.data, card, p, p.data, card)
        // Another child, another type, another label (not a value of a text box).
        assertNull(again(plan(rowKids = listOf("a", "b", "c"), extra = listOf(node("c", "Text", "text" to "新")))))
        assertNull(again(plan(rowKids = listOf("b", "a"))))
        val relabelled = plan().also { it.byId.getValue("name").put("label", "姓名") }
        assertNull(ChatCardModel.changes(was, was.data, card, relabelled, relabelled.data, card))
        // A control that cannot take the new value in place says so: drawn anew.
        val (_, ctl) = controls(was)
        val stuck = ctl + ("title" to ChatCardModel.Control { false })
        assertTrue(!ChatCardModel.write(listOf("title"), plan(title = "明天").byId, stuck))
    }

    @Test fun aControlTheOwnerIsAtIsNotWrittenTo() {
        val was = plan()
        val now = plan(title = "明天", data = JSONObject().put("name", "Bob"))
        val (views, ctl) = controls(was, editing = setOf("name"))
        views.getValue("name").shown = "Ali"
        assertTrue(ChatCardModel.write(ChatCardModel.changes(was, was.data, JSONObject(), now, now.data, JSONObject())!!, now.byId, ctl))
        assertEquals("Ali", views.getValue("name").shown)
        assertEquals(0, views.getValue("name").writes)
        assertEquals("明天", views.getValue("title").shown)
    }

    private fun rpc(method: String, params: JSONObject) = JSONObject().put("jsonrpc", "2.0").put("id", "a1").put("method", method).put("params", params).toString()

    @Test fun theMiniAppsPortTakesOnlyWhatItMayAndNeverWhoItIs() {
        // Who it is comes from the host: a card and component named in the message change nothing.
        val call = rpc("ash/call", JSONObject().put("member", "service:weather").put("word", "now").put("card", "card_other").put("component", "x"))
        val (id, request) = ChatCardModel.miniMessage(call, app = true)!!
        assertEquals("a1", id)
        val body = ChatCardModel.actBody("card_1", "mini", JSONObject(), request!!)
        assertEquals("card_1", body.getString("card")); assertEquals("mini", body.getString("component"))
        assertEquals(setOf("member", "word", "body"), body.getJSONObject("request").getJSONObject("call").keys().asSequence().toSet())
        // A card without an app only sends events.
        assertNull(ChatCardModel.miniMessage(call, app = false))
        assertNull(ChatCardModel.miniMessage(rpc("ash/ask", JSONObject().put("text", "hi")), app = false))
        assertNotNull(ChatCardModel.miniMessage(rpc("ash/send", JSONObject().put("action", "go")), app = false)!!.second)
        // Other methods, other shapes, too large: refused.
        assertNull(ChatCardModel.miniMessage(rpc("ash/open", JSONObject()), app = true))
        assertNull(ChatCardModel.miniMessage(JSONObject().put("method", "ash/send").toString(), app = true))
        assertNull(ChatCardModel.miniMessage(rpc("ash/send", JSONObject().put("action", "x".repeat(ChatCardModel.MINI_MAX))), app = true))
        // In shape or not: an answer the page understands either way.
        assertNull(ChatCardModel.miniMessage(rpc("ash/call", JSONObject().put("word", "now")), app = true)!!.second)
    }
}
