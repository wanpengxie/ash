package ai.ash.kernel.host.ctx

import org.json.JSONObject

/** Content reads stay lazy until both accessibility password flags have been checked. */
internal object ContextContent {
    interface Node {
        val isPassword: Boolean
        val id: String?
        val text: CharSequence?
        val description: CharSequence?
        val childCount: Int
        fun child(index: Int): Node?
    }

    fun event(
        out: JSONObject,
        eventPassword: Boolean,
        source: Node?,
        eventText: () -> String,
        notification: (() -> Boolean)? = null,
    ) {
        source?.id?.let { out.put("id", it) }
        if (eventPassword || source?.isPassword == true) { redact(out); return }
        val ev = out.optString("ev")
        when (ev) {
            "notif" -> if (notification?.invoke() != true) putText(out, "text", eventText(), 500)
            "window" -> putText(out, "title", eventText(), 200)
            "text" -> out.put("text", clip(eventText(), 1000))
            "scroll" -> Unit
            else -> putText(out, "text", eventText(), 300)
        }
        if (source == null || ev == "notif" || ev == "window") return
        source.description?.let { if (it.isNotBlank()) out.put("desc", clip(it.toString(), 200)) }
        if (!out.has("text")) source.text?.let { if (it.isNotBlank()) out.put("text", clip(it.toString(), 300)) }
        if (ev != "focus" && ev != "text" && ev != "scroll" && !out.has("text") && !out.has("desc")) {
            val inner = ArrayList<String>()
            collect(source, inner, 0)
            if (inner.isNotEmpty()) out.put("inner", clip(inner.joinToString(" | "), 300))
        }
    }

    private fun collect(node: Node, out: MutableList<String>, depth: Int) {
        if (node.isPassword || depth > 3 || out.size >= 5) return
        for (i in 0 until node.childCount) {
            val child = node.child(i) ?: continue
            if (child.isPassword) continue // A password subtree cannot supply a label for its parent.
            screenText(child)?.takeIf { it.isNotEmpty() }?.let { out.add(it) }
            collect(child, out, depth + 1)
            if (out.size >= 5) return
        }
    }

    fun screenText(node: Node): String? {
        if (node.isPassword) return null
        return (node.text ?: node.description)?.toString()?.trim()
    }

    /** Protect pending records before another event (including focus/click) can flush them. */
    fun protectPending(pending: JSONObject?, event: JSONObject) {
        if (pending != null && event.optBoolean("password") &&
            pending.optString("pkg") == event.optString("pkg") &&
            (event.optString("id").isEmpty() || pending.optString("id").isEmpty() ||
                pending.optString("id") == event.optString("id"))) {
            // An unavailable source must not flush an earlier readable value from this app.
            redact(pending)
        }
    }

    /** A password transition is sticky for this coalesced record, including a later ordinary update. */
    fun mergeContent(pending: JSONObject, event: JSONObject) {
        if (pending.optBoolean("password") || event.optBoolean("password")) redact(pending)
        else if (event.has("text")) pending.put("text", event.getString("text"))
    }

    private fun redact(out: JSONObject) {
        for (key in arrayOf("text", "desc", "inner", "title", "body")) out.remove(key)
        out.put("password", true)
    }

    private fun putText(out: JSONObject, key: String, text: String, max: Int) {
        if (text.isNotEmpty()) out.put(key, clip(text, max))
    }

    private fun clip(text: String, max: Int) = if (text.length <= max) text else text.substring(0, max) + "…"
}
