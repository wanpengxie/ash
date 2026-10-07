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

/**
 * Ephemeral, except what the owner has already taken in ([noticed], persisted by the host): a host/core restart never
 * resurrects an old task or stop button, and never shows the owner again what they already saw or closed.
 */
internal class TaskStatusModel {
    companion object { const val STALE_MS = 100_000L; const val NOTICED_MAX = 500 }
    var frame: TaskFrame? = null; private set
    private var received = 0L
    private var finished = 0L
    private val retired = mutableSetOf<String>()
    /**
     * What the owner already knows about, by turn and question, not by session (a core restart starts a new session):
     * `end:<turn>` an ended turn's result, `card:<id>` a question, `closed:<turn>` a turn whose island they closed.
     * Ash in front or a closed island makes everything current known; the island returns only for something new.
     */
    private val noticed = LinkedHashSet<String>()
    fun restoreNoticed(keys: Collection<String>) { noticed.addAll(keys); trim() }
    fun noticedKeys(): List<String> = noticed.toList()
    private fun trim() { while (noticed.size > NOTICED_MAX) noticed.remove(noticed.first()) }
    /** The owner closed the island for this turn: it stays away for the rest of the turn (the notification carries on). */
    val dismissed: Boolean get() = frame?.turn?.let { "closed:$it" in noticed } ?: false
    fun accept(next: TaskFrame, now: Long): Boolean {
        val old = frame
        if (next.session in retired || old?.session == next.session && next.revision <= old.revision) return false
        if (old != null && old.session != next.session) retired.add(old.session)
        if (retired.size > 32) retired.remove(retired.first())
        if (next.state == "done" && (old?.turn != next.turn || old?.state != "done")) finished = now
        frame = next; received = now
        return true
    }
    /** A turn under way that has sent no status for this long shows as disconnected. */
    fun stale(now: Long): Boolean = frame?.state != "done" && now - received > STALE_MS
    private fun running(f: TaskFrame) = f.canStop && f.state !in setOf("done", "waiting_you")
    /** What in this frame the owner could still be told about: the ended turn's result and each open question. */
    private fun items(f: TaskFrame): List<String> {
        val turn = f.turn ?: return emptyList()
        return buildList {
            if (!running(f)) add("end:$turn")
            for (c in f.cards) if (c.state == "waiting") add("card:${c.id}")
        }
    }
    /** The owner has it in front of them (Ash is open): all of it is known now. True when that changed anything. */
    fun notice(): Boolean {
        val f = frame ?: return false
        val before = noticed.size
        noticed.removeAll(items(f).toSet()); noticed.addAll(items(f)); trim()
        return noticed.size != before
    }
    fun dismiss(turn: String): Boolean {
        val f = frame
        if (f?.turn != turn) return false
        noticed.addAll(items(f)); noticed.add("closed:$turn"); trim()
        return true
    }
    /** A turn is under way or has just ended (the notification). */
    fun active(): Boolean = frame?.let { it.turn != null && it.state !in setOf("idle", "resting") } ?: false
    /**
     * The island shows a task under way (unless closed for this turn), and otherwise only what the owner has not seen:
     * a result or question they took in, in Ash or by closing the island, never comes back.
     */
    fun visible(now: Long, homeVisible: Boolean = true, editing: Boolean = false): Boolean {
        val f = frame ?: return false
        if (!active() || dismissed) return false
        return running(f) || items(f).any { it !in noticed }
    }
    fun canStop(turn: String, now: Long): Boolean = frame?.let { it.turn == turn && it.canStop && !stale(now) && active() } ?: false
    fun elapsed(now: Long): Long = frame?.let { ((if (it.state == "done") finished else now) - it.startedAt).coerceAtLeast(0) / 1000 } ?: 0
    fun clear() { frame = null; retired.clear(); received = 0; finished = 0 }
}
