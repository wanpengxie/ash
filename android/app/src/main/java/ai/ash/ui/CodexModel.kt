package ai.ash.ui

import org.json.JSONArray
import org.json.JSONObject

/**
 * What the 「Codex」 page reads from the words of the owner's computer (`x.codex.*`), as plain data: the page itself only draws it.
 * Plain logic, so it can be checked without a device.
 */
object CodexModel {
    const val SESSIONS = "x.codex.sessions"
    const val SESSION = "x.codex.session"
    const val SEND = "x.codex.send"
    const val STOP = "x.codex.stop"
    const val APPROVE = "x.codex.approve"

    data class Session(val id: String, val title: String, val state: String, val open: Boolean, val cwd: String?, val updatedAt: Long?) {
        val running get() = state == "running"
        val waiting get() = state == "waiting_approval"
    }
    data class Item(val kind: String, val text: String)
    data class Turn(val id: String, val status: String, val items: List<Item>)
    data class Approval(val requestId: String, val kind: String, val summary: String)
    data class Detail(val session: Session, val turns: List<Turn>, val approvals: List<Approval>)

    private fun JSONObject.str(key: String) = optString(key).takeIf { it.isNotEmpty() }
    private fun <T> JSONArray?.mapObjects(f: (JSONObject) -> T): List<T> =
        if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }.map(f)

    private fun session(o: JSONObject) = Session(
        id = o.optString("id"), title = o.str("title") ?: "（未命名）", state = o.str("state") ?: "idle",
        open = o.optBoolean("open", true), cwd = o.str("cwd"), updatedAt = if (o.has("updated_at")) o.optLong("updated_at") else null,
    )

    /** The list: the order the computer gave (running first), those without an id dropped. */
    fun sessions(data: JSONObject?): List<Session> = data?.optJSONArray("sessions").mapObjects(::session).filter { it.id.isNotEmpty() }

    fun detail(data: JSONObject?): Detail? {
        if (data == null || data.optString("id").isEmpty()) return null
        val turns = data.optJSONArray("turns").mapObjects { t ->
            Turn(t.optString("id"), t.str("status") ?: "unknown", t.optJSONArray("items").mapObjects { Item(it.optString("kind"), it.optString("text")) })
        }
        val approvals = data.optJSONArray("approvals").mapObjects { Approval(it.optString("request_id"), it.optString("kind"), it.optString("summary")) }
        return Detail(session(data), turns, approvals.filter { it.requestId.isNotEmpty() })
    }

    /** The computer to ask: the first of `service:devices list` that is a computer and online. */
    fun computer(data: JSONObject?): String? =
        data?.optJSONArray("devices").mapObjects { it }.firstOrNull { it.optString("kind") == "computer" && it.optBoolean("online") && it.optString("device").isNotEmpty() }?.optString("device")

    fun stateLabel(s: Session): String = when { s.waiting -> "等你批准"; s.running -> "在跑"; !s.open -> "未打开"; else -> "空闲" }

    /** The line under a title: where it works, and when it last changed. */
    fun subtitle(s: Session, now: Long): String {
        val where = s.cwd?.trimEnd('/')?.substringAfterLast('/')?.takeIf { it.isNotEmpty() }
        return listOfNotNull(where, s.updatedAt?.let { ago(it, now) }).joinToString(" · ")
    }

    fun ago(at: Long, now: Long): String {
        val s = (now - at) / 1000
        return when { s < 60 -> "刚刚"; s < 3600 -> "${s / 60} 分钟前"; s < 86_400 -> "${s / 3600} 小时前"; else -> "${s / 86_400} 天前" }
    }

    /** Why the page has nothing to show, in one sentence, for a failed word. */
    fun unreachable(code: String): String = when (code) {
        "unavailable", "not_found", "offline" -> "电脑不在线，或者这台电脑上没有在运行的 Codex App。"
        else -> "暂时读不到 Codex，稍后会再试。"
    }

    /** What to tell the owner when sending or answering did not go through. */
    fun failure(code: String, message: String): String = when (code) {
        "result_unknown" -> "没有收到确认，先看看过程再决定要不要重发。"
        "unavailable" -> "Codex App 里没有打开这个会话，先在电脑上打开它。"
        "not_found" -> "这个请求已经不在等了。"
        else -> message.ifEmpty { "没有成功" }
    }
}
