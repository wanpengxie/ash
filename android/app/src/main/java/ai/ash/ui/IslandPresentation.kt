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
            frame.state == "done" -> "reply"
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
        val mayClose = !stale && kind != "incomplete" && !canStop && frame.state in setOf("done", "waiting_you") && frame.cards.none { it.actionable(now) }
        return JSONObject().put("session", frame.session).put("turn", frame.turn).put("kind", kind).put("reply", frame.reply)
            .put("activity", frame.text.substringBefore(" · ")).put("elapsed", elapsed).put("cards", cards)
            .put("stale", stale).put("interactive", interactive && !stale).put("canStop", canStop)
            .put("mayClose", mayClose).put("notice", notice ?: "")
    }
}
