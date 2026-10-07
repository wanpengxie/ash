package ai.ash.ui

import ai.ash.host.TaskFrame
import org.json.JSONArray
import org.json.JSONObject

/** UI projection only. A completed turn is not evidence of successful delivery. */
internal object IslandPresentation {
    fun project(frame: TaskFrame, elapsed: Long, stale: Boolean, interactive: Boolean, canStop: Boolean, notice: String?,
        submitted: Map<String, String>, now: Long): JSONObject {
        val kind = when {
            stale -> "stale"
            frame.outcome == "cancelled" -> "stopped"
            frame.state == "done" && frame.outcome.isNotBlank() && frame.outcome != "completed" -> "incomplete"
            // A normal end is labelled only once judged; until then, and when unsure, it stays the neutral reply.
            frame.state == "done" -> when (frame.verdict) {
                "delivered" -> "result"; "needs_reply" -> "ask"; "needs_action_in_ash" -> "in_app"; "incomplete" -> "incomplete"
                else -> "reply"
            }
            frame.state == "listening" -> "listening"
            frame.state == "thinking" -> "thinking"
            else -> "working"
        }
        val cards = JSONArray()
        for (card in frame.cards) {
            val state = if (card.state == "waiting" && card.expiresAt <= now) "expired" else card.state
            val options = JSONArray()
            for ((id, label) in card.options) options.put(JSONObject().put("id", id).put("label", label))
            cards.put(JSONObject().put("id", card.id).put("kind", if (card.kind == "approval") "approval" else "ask")
                .put("state", state).put("title", card.title).put("detail", card.detail).put("original", card.original)
                .put("options", options).put("allow_custom", card.allowCustom)
                .put("localState", if (state == "waiting") submitted[card.id] ?: "" else ""))
        }
        // Something still waits on the owner: closing only collapses to the capsule (design §6).
        val mayClose = !stale && kind !in setOf("incomplete", "ask", "in_app") && !canStop && frame.state in setOf("done", "waiting_you") && frame.cards.none { it.actionable(now) }
        return JSONObject().put("session", frame.session).put("turn", frame.turn).put("kind", kind).put("reply", frame.reply)
            .put("activity", frame.text.substringBefore(" · ")).put("elapsed", elapsed).put("cards", cards)
            .put("stale", stale).put("interactive", interactive && !stale).put("canStop", canStop)
            .put("mayClose", mayClose).put("notice", notice ?: "")
    }

    /** The resident entry (island v2): nothing under way and nothing new; it carries no task content at all. */
    fun resident(): JSONObject = JSONObject().put("session", "").put("turn", "").put("kind", "resident").put("reply", "")
        .put("activity", "").put("elapsed", 0).put("cards", JSONArray()).put("stale", false).put("interactive", true)
        .put("canStop", false).put("mayClose", true).put("notice", "")
}
