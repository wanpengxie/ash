package ai.ash.host

import org.json.JSONObject

internal data class TaskFrame(val session: String, val revision: Long, val turn: String?, val startedAt: Long,
    val state: String, val text: String, val steps: List<String>, val canStop: Boolean) {
    companion object {
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
            return TaskFrame(session, revision, turn, started, state, safe(b.getString("text")),
                (0 until a.length()).map { safe(a.getString(it)) }, canStop)
        }
    }
}

/** Ephemeral only. A host/core restart never resurrects an old task or stop button. */
internal class TaskStatusModel {
    var frame: TaskFrame? = null; private set
    private var received = 0L
    private var finished = 0L
    private val retired = mutableSetOf<String>()
    fun accept(next: TaskFrame, now: Long): Boolean {
        val old = frame
        if (next.session in retired || old?.session == next.session && next.revision <= old.revision) return false
        if (old != null && old.session != next.session) retired.add(old.session)
        if (retired.size > 32) retired.remove(retired.first())
        if (next.state == "done" && (old?.turn != next.turn || old?.state != "done")) finished = now
        frame = next; received = now
        return true
    }
    fun stale(now: Long): Boolean = now - received > 15_000
    fun visible(now: Long): Boolean = frame?.let {
        it.turn != null && now - received < 30_000 && it.state !in setOf("idle", "resting") &&
            (it.state != "done" || now - finished < 4_000)
    } ?: false
    fun canStop(turn: String, now: Long): Boolean = frame?.let { it.turn == turn && it.canStop && !stale(now) && visible(now) } ?: false
    fun elapsed(now: Long): Long = frame?.let { ((if (it.state == "done") finished else now) - it.startedAt).coerceAtLeast(0) / 1000 } ?: 0
    fun clear() { frame = null; retired.clear(); received = 0; finished = 0 }
}
