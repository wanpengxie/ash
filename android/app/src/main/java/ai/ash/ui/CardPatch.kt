package ai.ash.ui

import org.json.JSONArray
import org.json.JSONObject

/**
 * A card drawn again by component, not as a whole (MOBILE-ARCH §12.6, §2.3): per card, each component id keeps the view
 * it was drawn as and what it was drawn from. A new plan with the same layout updates in place only the components whose
 * drawn fields changed; a component whose structure changed (its type, its children, how they are laid out) gets a new
 * view of its own, which takes over the views of its children that did not change. Everything else stays the same
 * instance. No Android here: [V] is the view type, and [Host] draws; unit tested on the JVM with a plain one.
 */
class CardPatcher<V : Any>(private val host: Host<V>) {
    /** What a node inherits from its parent: the ink (text colour) it is drawn in. */
    data class Env(val ink: Int?)

    interface Host<V : Any> {
        /** The child ids [n] draws now, in order (a Tabs: its selected tab's child; a Button draws its own face: none). */
        fun kids(n: JSONObject): List<String>
        /** What only a new view can show: the component and how its children are laid out (the child ids are added here). */
        fun shape(n: JSONObject): String
        /** Everything else [n] shows (its fields, the values and runtime state it shows) in [env]. */
        fun look(n: JSONObject, env: Env): String
        /** The env [n]'s children are drawn in. */
        fun env(n: JSONObject, env: Env): Env
        /** A new view for [n], holding [kids] (views of its children, which may still sit in another parent). */
        fun build(n: JSONObject, env: Env, kids: List<Pair<JSONObject, V>>): V
        /** [n]'s changed look on its existing [view]; false when it cannot be done in place (it is then drawn anew). */
        fun update(view: V, old: JSONObject, n: JSONObject, env: Env, kids: List<Pair<JSONObject, V>>): Boolean
        /** [new] takes [old]'s place inside [parent] (the view of [n]'s parent). */
        fun swap(parent: V, old: V, new: V, n: JSONObject)
    }

    private class Drawn<V>(val view: V, var node: JSONObject, val shape: String, var look: String, var kids: List<V>)

    private val drawn = HashMap<String, Drawn<V>>()

    /** The view of the card's [root] after this plan; the components no longer drawn are forgotten. */
    fun render(byId: Map<String, JSONObject>, root: String, env: Env): V? {
        val seen = HashSet<String>()
        val out = visit(root, env, byId, seen, 0)?.view
        drawn.keys.retainAll(seen)
        return out
    }

    /** The component ids drawn now. */
    fun ids(): Set<String> = drawn.keys

    /** The view of component [id], if it is drawn. */
    fun viewOf(id: String): V? = drawn[id]?.view

    /** Forgets every view: the next [render] draws the card anew (a card-level replacement). */
    fun clear() = drawn.clear()

    private fun visit(id: String, env: Env, byId: Map<String, JSONObject>, seen: MutableSet<String>, depth: Int): Drawn<V>? {
        val n = byId[id] ?: return null
        // A component appears once (a second mention, or a loop, is left out).
        if (depth > MAX_DEPTH || !seen.add(id)) return null
        val kidIds = host.kids(n)
        val kidEnv = host.env(n, env)
        val kids = kidIds.mapNotNull { k -> visit(k, kidEnv, byId, seen, depth + 1)?.let { it.node to it.view } }
        val shape = host.shape(n) + "|" + kids.joinToString(",") { it.first.optString("id") }
        val look = host.look(n, env)
        val old = drawn[id]
        if (old != null && old.shape == shape) {
            // The same layout: a child drawn anew takes its old view's place; nothing else moves.
            kids.forEachIndexed { i, (kn, kv) -> val was = old.kids.getOrNull(i); if (was != null && was !== kv) host.swap(old.view, was, kv, kn) }
            old.kids = kids.map { it.second }
            if (look == old.look || host.update(old.view, old.node, n, env, kids)) {
                old.node = n; old.look = look
                return old
            }
        }
        val d = Drawn(host.build(n, env, kids), n, shape, look, kids.map { it.second })
        drawn[id] = d
        return d
    }

    companion object {
        const val MAX_DEPTH = 64
    }
}

/** The plain parts of drawing a card by component: comparing what nodes show, an image box's size. */
object CardShape {
    /** A JSON value as text with its keys in order, so two equal values always read the same. */
    fun canon(v: Any?): String = StringBuilder().also { write(it, v) }.toString()

    private fun write(b: StringBuilder, v: Any?) {
        when (v) {
            null, JSONObject.NULL -> b.append("null")
            is JSONObject -> {
                b.append('{')
                v.keys().asSequence().sorted().forEachIndexed { i, k -> if (i > 0) b.append(','); b.append(JSONObject.quote(k)).append(':'); write(b, v.opt(k)) }
                b.append('}')
            }
            is JSONArray -> { b.append('['); for (i in 0 until v.length()) { if (i > 0) b.append(','); write(b, v.opt(i)) }; b.append(']') }
            is String -> b.append(JSONObject.quote(v))
            is Number -> b.append(if (v is Double || v is Float) v.toDouble().let { d -> if (d == Math.floor(d) && !d.isInfinite() && Math.abs(d) < 1e15) d.toLong().toString() else d.toString() } else v.toString())
            else -> b.append(v.toString())
        }
    }

    /**
     * An image box's size in px, which never depends on the picture (so its arrival or failure does not move the row): a side
     * the layout fixes ([wExact] / [hExact]) as given; a free side from the other at 16:9; both free: the width offered
     * ([wMax], else [fallbackW]) at 16:9. A side offered at most some size stays within it.
     */
    fun boxSize(wExact: Boolean, wMax: Int?, hExact: Boolean, hMax: Int?, fallbackW: Int): Pair<Int, Int> {
        fun fit(v: Int, max: Int?) = if (max != null) minOf(v, max) else v
        return when {
            wExact && hExact -> wMax!! to hMax!!
            wExact -> wMax!! to fit(wMax * 9 / 16, hMax)
            hExact -> fit(hMax!! * 16 / 9, wMax) to hMax
            else -> { val w = wMax ?: fallbackW; w to fit(w * 9 / 16, hMax) }
        }
    }
}

/**
 * What the owner is doing to a card's values, against what the hub sends (MOBILE-ARCH §3.3): an input being edited keeps its
 * value; the hub's value for it waits aside (by component id) and is taken when the editing ends, if the owner did not change
 * the field meanwhile. A value the owner changed that the hub has not yet confirmed (its draft is on the way) is the owner's.
 */
class CardEdits {
    private var seq = 0L
    /** Bind path -> the owner's last change there the hub has not confirmed. */
    private val unsent = HashMap<String, Long>()
    /** Bind path -> how many times the owner changed it. */
    private val changes = HashMap<String, Long>()
    private class Aside(val value: Any?, val changes: Long)
    /** Component id -> the hub's value kept aside while the owner edits it. */
    private val aside = HashMap<String, Aside>()

    /** The owner changed the value at [path]. */
    fun changed(path: String) { seq++; unsent[path] = seq; changes[path] = (changes[path] ?: 0L) + 1 }

    /** A draft carries the owner's changes up to this mark. */
    fun mark(): Long = seq

    /** The hub has the owner's changes up to [mark]. */
    fun confirmed(mark: Long) { unsent.values.removeAll { it <= mark } }

    fun unsent(path: String): Boolean = path in unsent

    /** Whether a value of the hub's waits for component [id]. */
    fun waiting(id: String): Boolean = id in aside

    /**
     * The working copy once the hub's [incoming] data comes, from the owner's [local] one: the hub's, except at the bind
     * paths of [inputs] (component id -> bind path) being edited ([editing]) or changed and not yet confirmed.
     */
    fun merge(local: JSONObject, incoming: JSONObject, inputs: Map<String, String>, editing: (String) -> Boolean): JSONObject {
        val out = JSONObject(incoming.toString())
        val kept = HashSet<String>()
        for ((id, path) in inputs) {
            val mine = ChatCardModel.read(local, path)
            val theirs = ChatCardModel.read(incoming, path)
            when {
                editing(id) -> {
                    put(out, path, mine); kept.add(path)
                    if (CardShape.canon(mine) != CardShape.canon(theirs)) aside[id] = Aside(theirs, changes[path] ?: 0L) else aside.remove(id)
                }
                unsent(path) -> { put(out, path, mine); kept.add(path); aside.remove(id) }
                else -> aside.remove(id)
            }
        }
        // A change of the owner's at a path no input shows now is the owner's too.
        for (path in unsent.keys) if (path !in kept) put(out, path, ChatCardModel.read(local, path))
        return out
    }

    /**
     * Editing of component [id] (bound at [path]) ended: the hub's value kept aside goes into [data] when the owner did not
     * change the field since (true); else the owner's value stays and goes with the next draft (false).
     */
    fun ended(id: String, path: String, data: JSONObject): Boolean {
        val a = aside.remove(id) ?: return false
        if ((changes[path] ?: 0L) != a.changes || unsent(path)) return false
        put(data, path, a.value)
        return true
    }

    private fun put(data: JSONObject, path: String, value: Any?) {
        if (value != null) { ChatCardModel.write(data, path, value); return }
        // No value: none there either.
        val keys = path.removePrefix("/").split("/").map { it.replace("~1", "/").replace("~0", "~") }
        val parent = ChatCardModel.read(data, "/" + path.removePrefix("/").split("/").dropLast(1).joinToString("/"))
        when (parent) {
            is JSONObject -> parent.remove(keys.last())
            is JSONArray -> keys.last().toIntOrNull()?.takeIf { it < parent.length() }?.let { parent.put(it, JSONObject.NULL) }
        }
    }
}
