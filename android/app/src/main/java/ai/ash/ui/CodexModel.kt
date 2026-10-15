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
    const val NEW = "x.codex.new"

    data class Session(val id: String, val title: String, val state: String, val open: Boolean, val cwd: String?, val updatedAt: Long?) {
        val running get() = state == "running"
        val waiting get() = state == "waiting_approval"
    }
    /** One item of a turn; [id] is Codex's own id, when it has one. */
    data class Item(val kind: String, val text: String, val id: String? = null, val clientId: String? = null)
    data class Turn(val id: String, val status: String, val items: List<Item>)
    data class Approval(val requestId: String, val kind: String, val summary: String)
    data class Detail(val session: Session, val turns: List<Turn>, val approvals: List<Approval>)
    data class Computer(val id: String, val name: String)
    /** A project: the sessions that work in one directory ([cwd] null: those that say none). */
    data class Project(val cwd: String?, val name: String, val sessions: List<Session>)

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
            Turn(t.optString("id"), t.str("status") ?: "unknown", t.optJSONArray("items").mapObjects {
                Item(it.optString("kind"), it.optString("text"), it.str("id"), it.str("client_id"))
            })
        }
        val approvals = data.optJSONArray("approvals").mapObjects { Approval(it.optString("request_id"), it.optString("kind"), it.optString("summary")) }
        return Detail(session(data), turns, approvals.filter { it.requestId.isNotEmpty() })
    }

    /** The computers that can be asked: those of `service:devices list` that are computers and online, in its order. */
    fun computers(data: JSONObject?): List<Computer> =
        data?.optJSONArray("devices").mapObjects { it }.filter { it.optString("kind") == "computer" && it.optBoolean("online") && it.optString("device").isNotEmpty() &&
                (it.optJSONArray("capabilities")?.let { caps -> (0 until caps.length()).any { i -> caps.optString(i).startsWith("x.codex.") } } ?: true) }
            .map { Computer(it.optString("device"), it.str("name") ?: "电脑") }

    /** The computer shown: the one chosen before while it is still there, else the first. */
    fun pick(computers: List<Computer>, chosen: String?): String? = computers.firstOrNull { it.id == chosen }?.id ?: computers.firstOrNull()?.id

    /**
     * The sessions by project: a project with a running or waiting session first, then the one changed most recently; inside a
     * project the order the computer gave.
     */
    fun projects(sessions: List<Session>): List<Project> {
        val groups = LinkedHashMap<String?, MutableList<Session>>()
        for (s in sessions) groups.getOrPut(s.cwd?.trimEnd('/')?.ifEmpty { "/" }) { mutableListOf() }.add(s)
        return groups.map { (cwd, list) -> Project(cwd, cwd?.substringAfterLast('/')?.ifEmpty { cwd } ?: "其他", list) }
            .sortedWith(compareByDescending<Project> { p -> p.sessions.any { it.running || it.waiting } }.thenByDescending { p -> p.sessions.maxOf { it.updatedAt ?: 0L } })
    }

    /**
     * The row key of item [i] of [turn] (MOBILE-ARCH §2.2): a user message keeps its exact client id,
     * including messages added to a running turn. Never guess identity from text or turn membership.
     */
    fun itemKey(turn: Turn, i: Int): String {
        val item = turn.items[i]
        if (item.kind == "user") item.clientId?.let { return it }
        return item.id?.let { "id:$it" } ?: "${turn.id}~$i"
    }

    /** The messages sent to [thread] on [device] whose exact client id the session now shows: they no longer wait apart. */
    fun settled(ops: List<Pending>, device: String, thread: String, d: Detail): List<String> {
        if (d.session.id != thread) return emptyList()
        val clients = d.turns.flatMap { it.items }.filter { it.kind == "user" }.mapNotNull { it.clientId }.toSet()
        return ops.filter { it.to == device && it.body.optString("op") == "send" && it.body.optString("thread") == thread && it.clientId in clients }.map { it.clientId }
    }

    /** The new session's id from x.codex.new. */
    fun created(data: JSONObject?): String? = data?.str("thread")

    fun stateLabel(s: Session): String = when { s.waiting -> "等你批准"; s.running -> "在跑"; !s.open -> "历史"; else -> "空闲" }

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
        "unavailable" -> "电脑上的 Codex App 没能打开这个会话（电脑可能锁屏或睡着了），稍后再试。"
        "not_found" -> "这个请求已经不在等了。"
        else -> message.ifEmpty { "没有成功" }
    }
}

/**
 * Where the Codex page is and what it last read (MOBILE-ARCH §3.2, §11.1), as plain data. Every change of route bumps the
 * [generation]; a read is taken only in the generation it was asked in, so an answer about a page the owner left is dropped,
 * success or failure. A failed read keeps what is shown and says why ([problem]); only a successful read replaces it.
 */
class CodexState {
    var computers: List<CodexModel.Computer> = emptyList(); private set
    var device: String? = null; private set
    var chosen: String? = null; private set
    var deviceName: String? = null; private set
    var thread: String? = null; private set
    var title: String? = null; private set
    var newIn: CodexModel.Project? = null; private set
    var sessions: List<CodexModel.Session>? = null; private set
    var detail: CodexModel.Detail? = null; private set
    /** Why the last read failed (what is shown is from before it), or null. */
    var problem: String? = null; private set
    var computersAt = 0L; private set
    var generation = 0; private set

    val inTalk get() = thread != null || newIn != null

    /** The page went away: what is being read now no longer counts. */
    fun invalidate() { generation++ }

    private fun moved() { generation++; problem = null }

    /** The computers were read: the one chosen before while it is there, else the first. */
    fun computersRead(data: org.json.JSONObject?, failure: String?, now: Long) {
        computersAt = now
        if (failure != null && data == null) { problem = CodexModel.unreachable(failure); return }
        computers = CodexModel.computers(data)
        val next = if (inTalk && device != null) device else CodexModel.pick(computers, chosen ?: device)
        if (next != device) { device = next; deviceName = null; sessions = null; detail = null; moved() }
        computers.firstOrNull { it.id == device }?.name?.let { deviceName = it }
        if (device == null) problem = "没有在线的电脑。电脑上的 Ash 连上以后，这里就能看到 Codex。"
        else if (computers.none { it.id == device }) problem = "这台电脑暂时不在线，内容和草稿会保留。"
        else problem = null
    }

    fun choose(computer: String): Boolean {
        if (computer == device) return false
        chosen = computer; device = computer; deviceName = computers.firstOrNull { it.id == computer }?.name; sessions = null; detail = null; moved()
        return true
    }

    fun open(id: String, title: String?) { thread = id; this.title = title; newIn = null; detail = null; moved() }
    fun startNew(p: CodexModel.Project) { newIn = p; thread = null; title = null; detail = null; moved() }

    /** Back from a session (or a new one) to the list; false when the list is showing. */
    fun back(): Boolean {
        if (!inTalk) return false
        thread = null; newIn = null; title = null; detail = null; moved()
        return true
    }

    /** The list, read with [t]: false when it no longer counts. */
    fun listRead(gen: Int, data: org.json.JSONObject?, failure: String?): Boolean {
        if (gen != generation || thread != null) return false
        if (failure != null) { problem = CodexModel.unreachable(failure) }
        else { sessions = CodexModel.sessions(data); problem = null }
        return true
    }

    /** A session, read with [t]: false when it no longer counts. */
    fun detailRead(gen: Int, data: org.json.JSONObject?, failure: String?): Boolean {
        if (gen != generation || thread == null) return false
        if (failure != null) { problem = CodexModel.unreachable(failure) }
        else {
            val read = CodexModel.detail(data)?.takeIf { it.session.id == thread }
            if (read != null) { detail = read; title = read.session.title; problem = null }
            else problem = "暂时没有读到这个会话，内容会保留。"
        }
        return true
    }

    /** Where to come back to when the page is made again. */
    fun route(): Map<String, String> = buildMap {
        (chosen ?: device)?.let { put("device", it) }
        deviceName?.let { put("device_name", it) }
        thread?.let { put("thread", it) }; title?.let { put("title", it) }
        newIn?.cwd?.let { put("new_cwd", it); put("new_name", newIn!!.name) }
    }

    fun restore(route: Map<String, String>) {
        route["device"]?.let { chosen = it }
        deviceName = route["device_name"]
        val cwd = route["new_cwd"]
        when {
            route["thread"] != null -> open(route.getValue("thread"), route["title"])
            cwd != null -> startNew(CodexModel.Project(cwd, route["new_name"] ?: cwd.substringAfterLast('/'), emptyList()))
        }
        // A restored open conversation still belongs to its original computer, even while that computer is offline.
        if (inTalk) device = chosen
    }
}
