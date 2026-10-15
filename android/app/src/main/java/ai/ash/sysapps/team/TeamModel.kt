package ai.ash.sysapps.team

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/** Team snapshots and refresh rules; no Android state or Views (MOBILE-ARCH §1.4, §3.2). */
object TeamModel {
    private fun JSONObject.text(key: String) = opt(key) as? String ?: ""
    private fun JSONObject.strings(key: String): List<String> = optJSONArray(key)?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? String } }.orEmpty()
    private fun JSONObject.objects(key: String): List<JSONObject> = optJSONArray(key)?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()

    data class Member(
        val id: String, val name: String, val role: String, val brief: String, val kind: String, val model: String,
        val state: String, val primary: Boolean, val doing: String, val waiting: List<String>,
        val tools: List<String>?, val words: List<String>?, val userMemory: Boolean,
    ) {
        fun status(names: Map<String, String>): String = when {
            state == "stopped" -> "已停下"
            state == "error" -> "启动失败"
            state == "starting" -> "正在启动"
            waiting.isNotEmpty() -> "在等 " + waiting.joinToString("、") { names[it] ?: it.removePrefix("agent:") }
            state == "working" -> if (doing.isBlank()) "正在工作" else "在做：$doing"
            else -> "空闲"
        }
    }
    data class Cost(val usd: Double, val unpriced: Int) {
        fun label() = String.format(Locale.US, "今天 $%.4f", usd) + if (unpriced > 0) " · $unpriced 次未计价" else ""
    }
    data class Answer(val seq: Long, val ts: Long, val text: String, val error: String)
    data class Exchange(val id: String, val seq: Long, val ts: Long, val from: String, val to: String, val word: String, val text: String, val state: String, val answer: Answer?) {
        val status get() = when (state) { "answered" -> "已回答"; "failed" -> if (answer?.error?.startsWith("结果未知：") == true) "结果未知" else "没有完成"; "sent" -> "已送达"; else -> "等回答" }
        fun preview(open: Boolean): String = if (open || text.length <= 180) text else text.take(180) + "…"
    }
    fun members(data: JSONObject): List<Member> {
        require(data.optJSONArray("agents") != null) { "成员列表格式不完整" }
        return data.objects("agents").map { a ->
            val runtime = a.optJSONObject("runtime") ?: JSONObject()
            Member(a.text("id"), a.text("name"), a.text("summary"), a.text("brief"), runtime.text("kind"), runtime.text("model"), a.text("state"), a.optBoolean("primary"),
                a.optJSONObject("doing")?.text("about").orEmpty(), a.strings("waiting_on"),
                if (a.optJSONArray("tools") != null) a.strings("tools") else null,
                if (a.optJSONArray("words") != null) a.strings("words") else null,
                a.isNull("modules") || "user" in a.strings("modules"))
        }.onEach { require(it.id.startsWith("agent:")) }.sortedWith(compareByDescending<Member> { it.primary }.thenBy { it.name }.thenBy { it.id })
    }
    fun costs(data: JSONObject): Map<String, Cost> {
        require(data.optJSONArray("by_caller_today") != null) { "用量接口尚未支持按成员统计今天花费" }
        return data.objects("by_caller_today").associate { a -> a.text("caller") to Cost(a.optDouble("cost_usd", 0.0), a.optInt("unpriced_calls")) }
    }
    data class Page(val items: List<Exchange>, val before: Long?)
    fun exchanges(data: JSONObject): Page {
        require(data.optJSONArray("items") != null) { "往来列表格式不完整" }
        val items = data.objects("items").map { e ->
            val rawAnswer = e.optJSONObject("answer")
            val answer = rawAnswer?.let {
                Answer(it.optLong("seq"), it.optLong("ts"), it.text("text"), it.text("error"))
            }
            Exchange(e.text("id"), e.optLong("seq"), e.optLong("ts"), e.text("from"), e.text("to"), e.text("word"), e.text("text"), e.text("state"), answer)
        }
        items.forEach { require(it.id.isNotBlank() && it.seq > 0) }
        return Page(items, (data.opt("next_before") as? Number)?.toLong())
    }

    /** Keep older loaded pages when the newest page changes; a question keeps its identity when its answer arrives. */
    fun merge(old: List<Exchange>, page: List<Exchange>) = (old.associateBy { it.id } + page.associateBy { it.id }).values.sortedByDescending { it.seq }

    /** Each source serializes reads; a late answer after navigation never clears or overwrites a newer snapshot. */
    class Read<T> {
        var value: T? = null; private set
        var error: String? = null; private set
        private var generation = 0
        var busy = false; private set
        fun begin(): Int? = if (busy) null else (++generation).also { busy = true }
        fun invalidate() { generation++; busy = false }
        fun finish(ticket: Int, value: T?, error: String? = null): Boolean {
            if (ticket != generation) return false
            busy = false
            if (value != null) this.value = value
            this.error = error
            return true
        }
    }
    data class Refresh(val members: Boolean = false, val exchanges: Boolean = false, val costs: Boolean = false, val by: String? = null)
    fun refresh(m: JSONObject): Refresh {
        val from = m.text("from"); val to = m.text("to"); val word = m.text("word")
        val body = m.optJSONObject("body")
        return when {
            from == "service:agents" && word == "agent.changed" -> Refresh(members = true, by = body?.text("by")?.ifBlank { null })
            word == "usage.recorded" -> Refresh(costs = true)
            from.startsWith("agent:") && word in setOf("turn.started", "turn.ended") -> Refresh(members = true, exchanges = true)
            word in setOf("ask", "tell", "spawn", "answer") && (from.startsWith("agent:") || to?.startsWith("agent:") == true || from == "service:agents" || to == "service:agents") -> Refresh(members = true, exchanges = true)
            else -> Refresh()
        }
    }
    fun label(id: String, members: List<Member>) = if (id == "person:owner") "你" else members.firstOrNull { it.id == id }?.name ?: id.removePrefix("agent:")

    /** Raw request / response text, or a blob reference that the view reads through service:blobs/read. */
    data class TextSource(val text: String, val hash: String? = null, val json: Boolean = false, val path: List<String> = emptyList())
    fun source(raw: JSONObject, response: Boolean, word: String): TextSource {
        val path = if (response && raw.optString("kind") != "request") listOf("result", "data", "answer") else listOf(if (word == "spawn") "task" else "text")
        var current: Any? = raw.opt("body")
        for (i in 0..path.size) {
            if (current is JSONObject && current.opt("\$blob") is String) return TextSource(current.text("summary"), current.text("\$blob"), current.text("mime") == "application/json", path.drop(i))
            if (i == path.size) break
            current = (current as? JSONObject)?.opt(path[i])
        }
        if (response && current !is String) return TextSource(raw.optJSONObject("body")?.optJSONObject("error")?.text("message").orEmpty())
        return TextSource(current as? String ?: "")
    }
}
