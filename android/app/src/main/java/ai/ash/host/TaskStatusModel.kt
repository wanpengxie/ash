package ai.ash.host

import org.json.JSONObject

data class TaskCard(val id: String, val pendingId: String, val target: String, val turn: String, val kind: String,
    val title: String, val detail: String, val original: String, val options: List<Pair<String, String>>,
    val expiresAt: Long, val allowCustom: Boolean, val state: String) {
    fun actionable(now: Long) = state == "waiting" && expiresAt > now
    companion object {
        fun parse(b: JSONObject): TaskCard {
            val options = b.getJSONArray("options")
            require(options.length() <= 8)
            return TaskCard(b.getString("id"), b.getString("pending_id"), b.getString("to"), b.getString("turn"),
                b.getString("kind"), b.getString("title"), b.getString("detail"), b.getString("original"),
                (0 until options.length()).map { options.getJSONObject(it).let { o -> o.getString("id") to o.getString("label") } },
                b.getLong("expires_at"), b.optBoolean("allow_custom"), b.getString("state")).also {
                require(it.id.isNotBlank() && it.pendingId.isNotBlank() && PresentRoutes.member.matches(it.target))
                require(it.options.map { o -> o.first }.distinct().size == it.options.size)
            }
        }
    }
}

internal data class TaskFrame(val session: String, val revision: Long, val turn: String?, val startedAt: Long,
    val state: String, val text: String, val steps: List<String>, val canStop: Boolean,
    val tool: String = "", val stepStartedAt: Long = startedAt, val outcome: String = "",
    val reply: String = "", val cards: List<TaskCard> = emptyList(), val verdict: String = "") {
    companion object {
        /** How a normally ended turn left things for the owner (core's task.outcome route); anything else is no verdict. */
        val VERDICTS = setOf("delivered", "needs_reply", "needs_action_in_ash", "incomplete")
        fun parse(b: JSONObject): TaskFrame {
            val session = b.getString("session")
            val revision = b.getLong("revision")
            val turn = if (b.isNull("turn")) null else b.getString("turn")
            val started = b.getLong("started_at")
            val state = b.getString("state")
            fun safe(text: String): String = text.replace(Regex("[\\p{Cc}\\p{Cf}]"), " ").take(80)
            require(session.length in 1..80 && revision > 0 && started >= 0)
            require(turn == null || Regex("[A-Za-z0-9_-]{1,160}").matches(turn))
            require(state in setOf("idle", "listening", "thinking", "working", "done", "waiting_you", "resting"))
            val a = b.getJSONArray("steps")
            require(a.length() <= 5)
            val canStop = b.getBoolean("can_stop")
            require(!canStop || turn != null && state !in setOf("idle", "resting", "done"))
            val cards = b.optJSONArray("cards")
            return TaskFrame(session, revision, turn, started, state, safe(b.getString("text")),
                (0 until a.length()).map { safe(a.getString(it)) }, canStop, safe(b.optString("tool", "")),
                b.optLong("step_started_at", started).coerceAtLeast(started), safe(b.optString("outcome", "")),
                b.optString("reply", ""), if (cards == null) emptyList() else (0 until cards.length()).map { TaskCard.parse(cards.getJSONObject(it)) },
                b.optString("verdict", "").takeIf { it in VERDICTS }.orEmpty())
        }
    }
}

/** Ephemeral only. A host/core restart never resurrects an old task or stop button. */
internal class TaskStatusModel {
    var frame: TaskFrame? = null; private set
    private var received = 0L
    private var finished = 0L
    private var dismissed = false
    private val retired = mutableSetOf<String>()
    fun accept(next: TaskFrame, now: Long): Boolean {
        val old = frame
        if (next.session in retired || old?.session == next.session && next.revision <= old.revision) return false
        if (old != null && old.session != next.session) retired.add(old.session)
        if (retired.size > 32) retired.remove(retired.first())
        if (next.state == "done" && (old?.turn != next.turn || old?.state != "done")) finished = now
        if (old?.turn != next.turn || old?.session != next.session) dismissed = false
        frame = next; received = now
        return true
    }
    fun stale(now: Long): Boolean = frame?.state != "done" && now - received > 15_000
    fun dismiss(turn: String): Boolean {
        if (frame?.turn != turn) return false
        dismissed = true; return true
    }
    fun visible(now: Long, homeVisible: Boolean = true, editing: Boolean = false): Boolean = frame?.let {
        it.turn != null && it.state !in setOf("idle", "resting") &&
            !dismissed
    } ?: false
    fun canStop(turn: String, now: Long): Boolean = frame?.let { it.turn == turn && it.canStop && !stale(now) && visible(now) } ?: false
    fun elapsed(now: Long): Long = frame?.let { ((if (it.state == "done") finished else now) - it.startedAt).coerceAtLeast(0) / 1000 } ?: 0
    fun clear() { frame = null; retired.clear(); received = 0; finished = 0; dismissed = false }
}
