package ai.ash.ui

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A card drawn again by component (MOBILE-ARCH §12.6, §2.3, §3.3). Each case would fail against drawing the whole card anew
 * on every patch (every view a new instance, every field's text set again).
 */
class CardPatchTest {
    /** A view: what it shows and its children. */
    class V(val id: String) {
        var text: String? = null
        var parent: V? = null
        val kids = ArrayList<V>()
    }

    /** Draws plain [V]s the way the chat does: in place where it can, a field never while it is being edited. */
    class Host : CardPatcher.Host<V> {
        val built = ArrayList<String>()
        val updated = ArrayList<String>()
        var data = JSONObject()
        /** Runtime state per component (a button's: running, its line). */
        val runtime = HashMap<String, String>()
        /** Fields the owner is in. */
        val editing = HashSet<String>()

        private fun kidsOf(n: JSONObject) = (n.optJSONArray("children") ?: JSONArray()).let { a -> (0 until a.length()).map { a.getString(it) } }
        private fun shown(n: JSONObject): String = when (n.optString("component")) {
            "TextField" -> ChatCardModel.read(data, n.optString("bind"))?.toString().orEmpty()
            "Button" -> runtime[n.optString("id")].orEmpty()
            else -> n.optString("text")
        }
        override fun kids(n: JSONObject) = kidsOf(n)
        override fun shape(n: JSONObject) = n.optString("component") + "|" + n.optString("bind")
        override fun look(n: JSONObject, env: CardPatcher.Env) = CardShape.canon(n) + "|" + shown(n) + "|" + runtime[n.optString("id")]
        override fun env(n: JSONObject, env: CardPatcher.Env) = env
        override fun build(n: JSONObject, env: CardPatcher.Env, kids: List<Pair<JSONObject, V>>): V {
            built.add(n.optString("id"))
            return V(n.optString("id")).also { v ->
                v.text = shown(n)
                for ((_, k) in kids) { k.parent?.kids?.remove(k); k.parent = v; v.kids.add(k) }
            }
        }
        override fun update(view: V, old: JSONObject, n: JSONObject, env: CardPatcher.Env, kids: List<Pair<JSONObject, V>>): Boolean {
            updated.add(n.optString("id"))
            return when (n.optString("component")) {
                "TextField" -> { if (n.optString("id") !in editing) view.text = shown(n); true }
                // A button whose face changes (it runs now) is drawn anew; its line alone changes in place.
                "Button" -> { val face = runtime[n.optString("id")]?.startsWith("running") == true; if (face != (view.text?.startsWith("running") == true)) false else { view.text = shown(n); true } }
                "Image" -> false
                else -> { view.text = shown(n); true }
            }
        }
        override fun swap(parent: V, old: V, new: V, n: JSONObject) {
            val i = parent.kids.indexOf(old)
            new.parent?.kids?.remove(new)
            parent.kids[i] = new; new.parent = parent; old.parent = null
        }
    }

    private fun node(id: String, component: String, vararg kv: Pair<String, Any>) =
        JSONObject().put("id", id).put("component", component).apply { for ((k, v) in kv) put(k, v) }

    /** A form-like card: a title, a text box, a picture, a button the hub runs, and a row of two texts. */
    private fun plan(title: String = "今天", rowKids: List<String> = listOf("a", "b"), extra: List<JSONObject> = emptyList()): Map<String, JSONObject> =
        (listOf(
            node("root", "Column", "children" to JSONArray(listOf("title", "name", "pic", "go", "row"))),
            node("title", "Text", "text" to title),
            node("name", "TextField", "bind" to "/name"),
            node("pic", "Image", "url" to "https://example.com/a.png"),
            node("go", "Button", "action" to JSONObject().put("call", JSONObject())),
            node("row", "Row", "children" to JSONArray(rowKids)),
            node("a", "Text", "text" to "左"),
            node("b", "Text", "text" to "右"),
        ) + extra).associateBy { it.getString("id") }

    private val env = CardPatcher.Env(null)

    private fun all(root: V): Map<String, V> {
        val out = HashMap<String, V>()
        fun walk(v: V) { out[v.id] = v; v.kids.forEach(::walk) }
        walk(root)
        return out
    }

    @Test fun aPatchOfOneTextKeepsEveryOtherViewAndTheTextBox() {
        val host = Host().apply { data = JSONObject().put("name", "Al") }
        val p = CardPatcher(host)
        val before = all(p.render(plan(), "root", env)!!)
        host.built.clear()
        val root = p.render(plan(title = "明天"), "root", env)!!
        val after = all(root)
        for (id in listOf("root", "name", "pic", "go", "row", "a", "b", "title")) assertSame(id, before[id], after[id])
        assertEquals("明天", after.getValue("title").text)
        // Nothing drawn anew; only the Text was touched.
        assertEquals(emptyList<String>(), host.built)
        assertEquals(listOf("title"), host.updated)
        // The same plan again touches nothing.
        host.updated.clear()
        p.render(plan(title = "明天"), "root", env)
        assertEquals(emptyList<String>(), host.updated)
    }

    @Test fun aValueFromTheHubWaitsWhileTheOwnerIsInTheFieldAndComesWhenEditingEnds() {
        val host = Host().apply { data = JSONObject().put("name", "Al") }
        val p = CardPatcher(host)
        val edits = CardEdits()
        val field = all(p.render(plan(), "root", env)!!).getValue("name")
        // The owner is in the box (cursor / composing / selection); the hub says "Bob".
        host.editing.add("name")
        host.data = edits.merge(host.data, JSONObject().put("name", "Bob"), mapOf("name" to "/name")) { it in host.editing }
        val again = all(p.render(plan(title = "明天"), "root", env)!!)
        assertSame(field, again["name"])
        assertEquals("Al", field.text)
        assertFalse("the field is not touched", "name" in host.updated)
        assertTrue(edits.waiting("name"))
        // Editing ends, the owner did not change it: the hub's value is shown now.
        host.editing.clear()
        assertTrue(edits.ended("name", "/name", host.data))
        assertEquals("Bob", host.data.getString("name"))
        p.render(plan(title = "明天"), "root", env)
        assertSame(field, all(p.render(plan(title = "明天"), "root", env)!!)["name"])
        assertEquals("Bob", field.text)
    }

    @Test fun theOwnersChangeWinsOverAValueThatCameWhileTheyTyped() {
        val edits = CardEdits()
        var data = JSONObject().put("name", "Al")
        data = edits.merge(data, JSONObject().put("name", "Bob"), mapOf("name" to "/name")) { true }
        assertEquals("Al", data.getString("name"))
        // The owner types on.
        ChatCardModel.write(data, "/name", "Alice"); edits.changed("/name")
        assertFalse(edits.ended("name", "/name", data))
        assertEquals("Alice", data.getString("name"))
        // Not being edited, but not yet confirmed by the hub: still the owner's.
        data = edits.merge(data, JSONObject().put("name", "Bob"), mapOf("name" to "/name")) { false }
        assertEquals("Alice", data.getString("name"))
        // Once the hub has the draft, what it sends is taken.
        edits.confirmed(edits.mark())
        data = edits.merge(data, JSONObject().put("name", "Carol"), mapOf("name" to "/name")) { false }
        assertEquals("Carol", data.getString("name"))
        // A value of a field nobody touches is the hub's at once.
        assertEquals(2, edits.merge(JSONObject().put("n", 1), JSONObject().put("n", 2), mapOf("x" to "/n")) { false }.getInt("n"))
    }

    @Test fun aButtonsStateChangesOnlyThatButtonAndItsLine() {
        val host = Host()
        val p = CardPatcher(host)
        val before = all(p.render(plan(), "root", env)!!)
        // The hub writes the outcome under it: in place.
        host.updated.clear(); host.built.clear()
        host.runtime["go"] = "done: 已提交"
        var after = all(p.render(plan(), "root", env)!!)
        assertEquals(listOf("go"), host.updated)
        assertEquals(emptyList<String>(), host.built)
        assertSame(before["go"], after["go"])
        assertEquals("done: 已提交", after.getValue("go").text)
        // It runs: its face changes, so it alone is drawn anew, in the same place.
        host.updated.clear()
        host.runtime["go"] = "running"
        after = all(p.render(plan(), "root", env)!!)
        assertEquals(listOf("go"), host.built)
        assertNotSame(before["go"], after["go"])
        for (id in listOf("root", "title", "name", "pic", "row", "a", "b")) assertSame(id, before[id], after[id])
        assertEquals(3, after.getValue("root").kids.indexOf(after["go"]))
    }

    @Test fun aLayoutChangeReplacesOnlyTheSmallestSubtree() {
        val host = Host()
        val p = CardPatcher(host)
        val before = all(p.render(plan(), "root", env)!!)
        host.built.clear()
        val after = all(p.render(plan(rowKids = listOf("a", "b", "c"), extra = listOf(node("c", "Text", "text" to "新"))), "root", env)!!)
        // The row is new (its children changed); its old children are kept and moved in; everything else stays.
        assertEquals(setOf("row", "c"), host.built.toSet())
        assertNotSame(before["row"], after["row"])
        assertSame(before["a"], after["a"]); assertSame(before["b"], after["b"])
        for (id in listOf("root", "title", "name", "pic", "go")) assertSame(id, before[id], after[id])
        assertEquals(listOf("a", "b", "c"), after.getValue("row").kids.map { it.id })
        assertSame(after["row"], after.getValue("root").kids[4])
        // A component gone is forgotten.
        p.render(plan(rowKids = listOf("a")), "root", env)
        assertFalse("c" in p.ids())
    }

    @Test fun aComponentThatAppearsTwiceOrLoopsIsDrawnOnce() {
        val loop = mapOf(
            "root" to node("root", "Column", "children" to JSONArray(listOf("x", "x", "root"))),
            "x" to node("x", "Text", "text" to "x"))
        val root = CardPatcher(Host()).render(loop, "root", env)!!
        assertEquals(listOf("x"), root.kids.map { it.id })
    }

    @Test fun anImageBoxHasItsFinalSizeBeforeThePictureComes() {
        // Its sides come from the layout only: the same before and after a picture of any shape, or none.
        assertEquals(300 to 200, CardShape.boxSize(true, 300, true, 200, 240))
        // A height the layout leaves free: 16:9 of the width, not the picture's.
        assertEquals(320 to 180, CardShape.boxSize(true, 320, false, 2000, 240))
        assertEquals(320 to 100, CardShape.boxSize(true, 320, false, 100, 240))
        assertEquals(160 to 90, CardShape.boxSize(false, 400, true, 90, 240))
        assertEquals(240 to 135, CardShape.boxSize(false, null, false, null, 240))
    }

    @Test fun canonIgnoresKeyOrder() {
        assertEquals(CardShape.canon(JSONObject("""{"a":1,"b":[1,{"y":2,"x":1}]}""")), CardShape.canon(JSONObject("""{"b":[1,{"x":1,"y":2}],"a":1}""")))
        assertFalse(CardShape.canon(JSONObject("""{"a":1}""")) == CardShape.canon(JSONObject("""{"a":"1"}""")))
    }
}
