package ai.ash.sysapps.codex

import ai.ash.ui.CodexModel
import org.json.JSONObject

/** Application routing and ledger invalidation, independent of Android views. */
object CodexOpen {
    data class Route(val device: String?, val thread: String?)

    /** A thread id, or JSON {device?,thread?}. Invalid arguments leave the current route intact. */
    fun route(arg: String?): Route? {
        val text = arg?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        if (!text.startsWith("{")) return Route(null, text)
        val data = runCatching { JSONObject(text) }.getOrNull() ?: return null
        val device = (data.opt("device") as? String)?.takeIf { it.startsWith("device:") && it.length > 7 }
        val thread = (data.opt("thread") as? String)?.takeIf { it.isNotBlank() }
        return if (device == null && thread == null) null else Route(device, thread)
    }

    // Reading Codex is itself recorded. Never invalidate a read with its own ledger message.
    fun affectsSession(message: JSONObject): Boolean = message.optString("word") in setOf(
        CodexModel.SEND, CodexModel.NEW, CodexModel.STOP, CodexModel.APPROVE,
    ) || (message.optString("kind") == "event" && message.optString("word").startsWith("x.codex."))

    /** The actor on a mutating request, not the device that later answers it. */
    fun actorLine(message: JSONObject): String? {
        if (message.optString("kind") != "request" || !affectsSession(message)) return null
        val from = message.optString("from")
        val who = when {
            from == "person:owner" -> "你"
            from == "agent:main" -> "Ash"
            from.startsWith("agent:") -> from.removePrefix("agent:")
            else -> return null
        }
        val action = when (message.optString("word")) {
            CodexModel.SEND -> "发送消息"
            CodexModel.NEW -> "新建会话"
            CodexModel.STOP -> "停止这一轮"
            else -> "回答审批"
        }
        return "$who 发起：$action"
    }

    fun affectsComputers(message: JSONObject): Boolean = message.optString("kind") == "event" &&
        message.optString("word") in setOf("device.changed", "connected", "disconnected", "pair.changed")
}
