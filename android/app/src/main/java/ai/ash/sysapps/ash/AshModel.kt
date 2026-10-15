package ai.ash.sysapps.ash

import org.json.JSONArray
import org.json.JSONObject

/**
 * What the system app 「Ash」 (spec APPS-R1 §4) reads from the hub, as plain data; the screens only draw it. Plain logic, so it is
 * checked without a device.
 *
 * Words it reads: `service:history/current` (what she is doing and waiting on), `service:pulse/pulse.get` (when she comes to you
 * next), the tasks app's `list` with `subject: "ash"` (her own to-dos and, later, her lines), `service:persona` words (who she is,
 * her memory files, her diary, the notes on them). The tasks words are read loosely: a field it does not know is left out.
 */
object AshModel {
    const val PERSONA = "service:persona"
    const val TASKS = "service:tasks"
    const val OWNER = "person:owner"

    private fun JSONObject?.str(key: String): String? = this?.optString(key)?.takeIf { it.isNotEmpty() && !isNull(key) }
    private fun JSONObject?.long(key: String): Long? = if (this != null && has(key) && !isNull(key)) optLong(key) else null
    private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

    // ---- 现在 ------------------------------------------------------------------------------------------------------------

    /** Her state now. [state] is idle / working / thinking / waiting_you / offline; [since] when the current work began. */
    data class Now(val state: String, val doing: String?, val since: Long?, val waitingYou: Int, val nextComing: Long?)

    /** [current] is `history/current`'s data, [pulse] `pulse.get`'s (either may be missing: what it would say is left out). */
    fun now(online: Boolean, current: JSONObject?, pulse: JSONObject?, now: Long): Now {
        val presence = current?.optJSONObject("presence")
        val state = if (!online) "offline" else presence.str("state")?.takeIf { it in setOf("working", "thinking", "waiting_you") } ?: "idle"
        val busy = state == "working" || state == "thinking"
        val progress = current?.optJSONObject("progress")
        val since = if (busy && progress != null && (!progress.has("ended") || progress.isNull("ended"))) progress.long("started") else null
        val waiting = current?.optJSONArray("items").objects().count { it.optJSONObject("ask") != null }
        val next = if (pulse?.optBoolean("active") == true && pulse.optBoolean("enabled")) pulse.optJSONArray("next_wakes")?.let { a -> (0 until a.length()).map { a.optLong(it) }.filter { it > now }.minOrNull() } else null
        return Now(state, if (state == "working") presence.str("text") else null, since, waiting, next)
    }

    /** The line under her name: what she is doing, in words. */
    fun nowText(n: Now, name: String): String = when (n.state) {
        "offline" -> "离线，连上后会自动刷新"
        "working" -> n.doing ?: "在忙"
        "thinking" -> "在想"
        "waiting_you" -> "在等你一句话"
        else -> "$name 现在空着"
    }

    // ---- 她手上的事与主线（任务应用里 subject: ash 的那一侧）--------------------------------------------------------------

    /** One to-do. [status]: todo / doing / waiting / done / dropped (anything else is shown as todo). */
    data class Todo(val id: String, val title: String, val status: String, val assignee: String?, val due: Long?, val source: String?,
                    val line: String?, val updatedAt: Long?, val updatedBy: String?, val note: String?, val result: String?) {
        val open get() = status != "done" && status != "dropped"
    }
    private val STATUSES = setOf("todo", "doing", "waiting", "done", "dropped")

    fun todos(data: JSONObject?): List<Todo> = (data?.optJSONArray("tasks") ?: data?.optJSONArray("items")).objects().filter { it.str("subject") == "ash" }.mapNotNull { o ->
        val id = o.str("id") ?: return@mapNotNull null
        Todo(id, o.str("title") ?: o.str("text") ?: "（没写内容）", o.str("status")?.takeIf { it in STATUSES } ?: "todo", o.str("assignee") ?: o.str("owner"),
            o.long("due") ?: o.long("due_at") ?: o.long("remind_at"), o.optJSONObject("source").str("message") ?: o.optJSONObject("source").str("turn"),
            o.str("thread"), o.long("updated_at"), o.str("updated_by"), o.str("note"), o.str("result"))
    }

    /** In-progress work first; the closed records remain available in the task app. */
    fun activeTodos(todos: List<Todo>) = todos.filter { it.open }.sortedWith(compareBy<Todo> { order(it.status) }.thenBy { it.due ?: Long.MAX_VALUE }.thenByDescending { it.updatedAt ?: 0 })

    private fun order(status: String) = when (status) { "doing" -> 0; "waiting" -> 1; else -> 2 }

    fun statusText(status: String) = when (status) { "doing" -> "在做"; "waiting" -> "等对方"; "done" -> "完成"; "dropped" -> "不做了"; else -> "待做" }

    // ---- 谁 ----------------------------------------------------------------------------------------------------------------

    /** Who did something, in words: you, her, a helper by its name, the hub. */
    fun who(by: String?, primary: String?, name: String, helpers: Map<String, String> = emptyMap()): String = when {
        by == null -> "未记录"
        by == OWNER -> "你"
        by == primary -> name
        by == "template" -> "最初的样子"
        by.startsWith("agent:") -> helpers[by] ?: "帮手"
        else -> "系统"
    }

    // ---- 她记得你 ----------------------------------------------------------------------------------------------------------

    data class MemoryFile(val file: String, val content: String, val missing: Boolean, val by: String?, val at: Long?)

    fun memoryFiles(data: JSONObject?): List<MemoryFile> = data?.optJSONArray("files").objects().mapNotNull { o ->
        MemoryFile(o.str("file") ?: return@mapNotNull null, o.optString("content"), o.optBoolean("missing"), o.str("by"), o.long("at"))
    }

    private val BULLET = Regex("^(\\s*)(?:[-*+]|\\d+[.)])\\s+(.*)$")

    /** The memory file with the [index]th line that says [item] (as `HomeModel.groupMemory` shows it) replaced by [with], or removed when [with] is null.
     *  Null when the line is no longer there (the file changed meanwhile): nothing is written then. */
    fun editItem(markdown: String, item: String, with: String?): String? {
        val lines = markdown.split("\n").toMutableList()
        val at = lines.indexOfFirst { raw -> val l = raw.trimEnd('\r').trim(); !l.startsWith("#") && shown(l) == item }
        if (at < 0) return null
        if (with == null) lines.removeAt(at)
        else {
            val raw = lines[at].trimEnd('\r')
            val m = BULLET.find(raw)
            lines[at] = if (m != null) raw.substring(0, raw.length - m.groupValues[2].length) + with.trim() else with.trim()
        }
        return lines.joinToString("\n")
    }

    private fun shown(line: String) = line.replace(Regex("^(?:[-*+]|\\d+[.)])\\s+"), "").replace(Regex("\\*\\*(.+?)\\*\\*"), "$1")
        .replace(Regex("`([^`]+)`"), "$1").replace(Regex("\\[([^\\]]+)\\]\\([^)]*\\)"), "$1").trim()

    // ---- 日记 --------------------------------------------------------------------------------------------------------------

    data class Day(val date: String, val excerpt: String, val done: Boolean, val notes: Int)
    data class DayPage(val days: List<Day>, val nextBefore: String?)

    fun days(data: JSONObject?): DayPage = DayPage(data?.optJSONArray("days").objects().mapNotNull { o ->
        Day(o.str("date") ?: return@mapNotNull null, o.optString("excerpt"), o.optBoolean("done"), o.optInt("notes"))
    }, data.str("next_before"))

    /** A page after [old] (its next page [more]): days already shown are not shown twice. */
    fun moreDays(old: List<Day>, more: DayPage): DayPage = DayPage(old + more.days.filter { d -> old.none { it.date == d.date } }, more.nextBefore)

    /** One section of a diary day: its heading (empty for what comes before the first) and its lines, list marks taken off. */
    data class Part(val title: String, val lines: List<String>)

    /** A day's diary as the four parts the nightly review writes (or whatever headings it has); the title line and the done mark left out. */
    fun diaryParts(markdown: String): List<Part> {
        val parts = ArrayList<Pair<String, MutableList<String>>>()
        for (raw in markdown.split(Regex("\\r?\\n"))) {
            val l = raw.trim()
            if (l.isEmpty() || l.startsWith("<!--") || Regex("^#\\s").containsMatchIn(l)) continue
            val h = Regex("^#{2,6}\\s+(.*)$").find(l)
            if (h != null) { parts.add(h.groupValues[1].trim() to ArrayList()); continue }
            if (parts.isEmpty()) parts.add("" to ArrayList())
            parts.last().second.add(shown(l))
        }
        return parts.filter { it.second.isNotEmpty() }.map { Part(it.first, it.second) }
    }

    /** 「10 月 14 日 · 周二」, or 「今天」「昨天」. */
    fun dayTitle(date: String, today: String, yesterday: String): String {
        if (date == today) return "今天"
        if (date == yesterday) return "昨天"
        val d = runCatching { java.time.LocalDate.parse(date) }.getOrNull() ?: return date
        val week = "一二三四五六日"[d.dayOfWeek.value - 1]
        return "${d.monthValue} 月 ${d.dayOfMonth} 日 · 周$week"
    }

    // ---- 批注 --------------------------------------------------------------------------------------------------------------

    data class Note(val id: String, val about: String, val text: String, val by: String, val at: Long, val reply: String?, val repliedAt: Long?, val repliedBy: String?) {
        val answered get() = reply != null
    }

    fun notes(arr: JSONArray?): List<Note> = arr.objects().mapNotNull { o ->
        Note(o.str("id") ?: return@mapNotNull null, o.optString("about"), o.optString("text"), o.optString("by"), o.optLong("at"),
            o.str("reply"), o.long("replied_at"), o.str("replied_by"))
    }

    /** What a note is on, as the app's words: [about] is `diary:<date>`, `memory:<file>`, `identity:<file>`, `task:<id>`, `line:<id>` or `now`. */
    fun aboutText(about: String): String = when {
        about == "now" -> "她现在做的事"
        about.startsWith("diary:") -> "日记 ${about.removePrefix("diary:")}"
        about == "memory:USER.md" -> "她记得的关于你"
        about == "memory:MEMORY.md" -> "她的笔记"
        about == "memory:PROACTIVE.md" -> "什么事可以直接找你"
        about == "identity:SOUL.md" -> "她的性格"
        about == "identity:IDENTITY.md" -> "她的名片"
        about.startsWith("task:") -> "一件待办"
        about.startsWith("line:") -> "一条主线"
        else -> about
    }

    // ---- 她是谁：人格的变化 ----------------------------------------------------------------------------------------------------

    data class Version(val file: String, val version: String, val at: Long, val by: String, val reason: String)

    fun versions(data: JSONObject?): List<Version> = data?.optJSONArray("versions").objects().mapNotNull { o ->
        Version(o.str("file") ?: return@mapNotNull null, o.str("version") ?: return@mapNotNull null, o.optLong("approved_at"), o.optString("by"), o.optString("reason"))
    }
    data class Growth(val id: String, val title: String, val why: String, val did: String, val effect: String, val next: String, val evidence: List<String>, val at: Long, val by: String)
    fun growth(data: JSONObject?): List<Growth> = data?.optJSONArray("items").objects().mapNotNull { o ->
        val evidence = o.optJSONArray("evidence")
        Growth(o.str("id") ?: return@mapNotNull null, o.optString("title"), o.optString("why"), o.optString("did"), o.optString("effect"), o.optString("next"),
            if (evidence == null) emptyList() else (0 until evidence.length()).map { evidence.optString(it) }, o.optLong("at"), o.optString("by"))
    }

    /** A source's last successful snapshot survives an error. A second refresh is coalesced until the first ends. */
    class ReadSlot<T> {
        var value: T? = null; private set
        var error: String? = null; private set
        var busy = false; private set
        private var generation = 0
        private var again = false
        fun begin(): Int? {
            if (busy) { again = true; return null }
            busy = true
            return ++generation
        }
        fun accepts(ticket: Int) = busy && ticket == generation
        fun finish(ticket: Int, result: T?, failure: String? = null): Boolean {
            if (ticket != generation || !busy) return false
            busy = false
            if (failure == null && result != null) { value = result; error = null } else error = failure ?: "没能读取，请重试"
            return again.also { again = false }
        }
        fun cancel() { generation++; busy = false; again = false }
    }

}
