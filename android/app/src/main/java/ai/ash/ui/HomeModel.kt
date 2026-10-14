package ai.ash.ui

import org.json.JSONArray
import org.json.JSONObject
import java.text.BreakIterator
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.Locale

/** A string field, or null when it is missing, null or not a string (org.json would say "null" for a JSON null). */
internal fun JSONObject.str(key: String): String? = opt(key) as? String
internal fun JSONObject.num(key: String): Long? = (opt(key) as? Number)?.takeIf { it.toDouble().isFinite() }?.toLong()
internal fun JSONObject.dbl(key: String): Double? = (opt(key) as? Number)?.toDouble()?.takeIf { it.isFinite() }
internal fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
internal fun JSONObject.list(key: String): List<JSONObject> = optJSONArray(key)?.objects() ?: emptyList()

/**
 * What the home pages say, worked out from the ledger and the services' answers (the web page's home-model / home-text / home-data /
 * clock / money): plain functions, no views, so they are checked without a phone.
 */
object HomeModel {
    const val DAY = 86_400_000L
    private val zone get() = ZoneId.systemDefault()
    private fun at(ts: Long) = Instant.ofEpochMilli(ts).atZone(zone)

    // ---- time
    fun startOfDay(ts: Long): Long = at(ts).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli()
    fun hhmm(ts: Long): String = at(ts).let { "%02d:%02d".format(it.hour, it.minute) }
    fun weekdayShort(ts: Long): String = "日一二三四五六"[at(ts).dayOfWeek.value % 7].toString()
    fun weekday(ts: Long) = "周" + weekdayShort(ts)
    fun dayOfMonth(ts: Long) = at(ts).dayOfMonth
    private fun dayDiff(ts: Long, now: Long) = ChronoUnit.DAYS.between(at(now).toLocalDate(), at(ts).toLocalDate()).toInt()

    /** "今天 09:12", "昨天 09:12", "明天 …", "10月9日 09:12" (with the year when it is not this year). */
    fun dayTime(ts: Long, now: Long = System.currentTimeMillis()): String {
        val time = hhmm(ts)
        return when (dayDiff(ts, now)) {
            0 -> "今天 $time"; -1 -> "昨天 $time"; 1 -> "明天 $time"
            else -> { val d = at(ts); val year = if (d.year == at(now).year) "" else "${d.year}年"; "$year${d.monthValue}月${d.dayOfMonth}日 $time" }
        }
    }

    /** "刚刚", "3 分钟前", "今天 09:12"… */
    fun ago(ts: Long, now: Long = System.currentTimeMillis()): String = when {
        now - ts < 60_000 -> "刚刚"
        now - ts < 3_600_000 -> "${(now - ts) / 60_000} 分钟前"
        else -> dayTime(ts, now)
    }

    /** "3 秒", "2 分钟", "1.5 小时". */
    fun duration(ms: Long): String = when {
        ms < 60_000 -> "${maxOf(1L, Math.round(ms / 1000.0))} 秒"
        ms < 3_600_000 -> "${Math.round(ms / 60_000.0)} 分钟"
        else -> { val v = Math.round(ms / 360_000.0) / 10.0; "${if (v == Math.floor(v)) v.toLong().toString() else v.toString()} 小时" }
    }

    /** "月日 时:分" as the devices and the keys say it. */
    fun clock(ts: Long): String = at(ts).let { "${it.monthValue}月${it.dayOfMonth}日 %02d:%02d".format(it.hour, it.minute) }

    fun dayLabel(day: Long, now: Long = System.currentTimeMillis()): String = when (dayDiff(day, now)) {
        0 -> "今天"; -1 -> "昨天"; else -> at(day).let { "${it.monthValue}月${it.dayOfMonth}日" }
    }

    // ---- money
    const val CNY_PER_USD = 6.74
    const val CNY_NOTE = "人民币按 1 美元 ≈ 6.74 元固定换算，仅供估算，不是账单。"
    private fun yuan(v: Double) = "¥" + String.format(Locale.US, if (v > 0 && v < 0.01) "%.4f" else "%.2f", v)
    fun usdToCny(v: Double?): String = if (v == null || !v.isFinite()) "—" else yuan(v * CNY_PER_USD)
    fun balanceText(b: JSONObject): String {
        val total = b.opt("total").let { (it as? Number)?.toDouble() ?: (it as? String)?.toDoubleOrNull() }
        if (total == null || !total.isFinite()) return "—"
        return when (b.str("currency")) { "CNY" -> yuan(total); "USD" -> "约 " + usdToCny(total); else -> "${b.opt("total")} ${b.opt("currency")}" }
    }
    fun tokens(n: Double) = if (n >= 1e6) String.format(Locale.US, "%.1fM", n / 1e6) else if (n >= 1e3) String.format(Locale.US, "%.1fk", n / 1e3) else n.toLong().toString()

    // ---- asks: what waits for the owner
    class Opt(val id: String, val label: String)
    class Ask(val id: String, val seq: Long, val from: String, val state: String, val title: String, val detail: String, val original: String?, val originalFull: String?,
              val expiresAt: Long, val ts: Long, val options: List<Opt>, val humanKind: String?, val allowCustom: Boolean, val optionsValid: Boolean)
    class Waiting(val approval: Boolean, val ask: Ask)

    const val GATE = "service:gate"
    private fun safeText(v: Any?, max: Int = 240) = if (v is String) v.take(max) else ""
    private val CHOICES = setOf("once", "always", "deny")

    fun askOf(j: JSONObject): Ask? {
        val id = j.str("id")?.takeIf { it.isNotEmpty() && it.length <= 256 } ?: return null
        val options = j.list("options").mapNotNull { o -> o.str("id")?.let { Opt(it, o.str("label") ?: "") } }
        return Ask(id, j.num("seq") ?: 0, j.str("from") ?: "", j.str("state") ?: "", j.str("title") ?: "", j.str("detail") ?: "", j.str("original"),
            j.str("original_full")?.takeIf { Regex("[a-f0-9]{64}").matches(it) }, j.num("expires_at") ?: 0, j.num("ts") ?: 0, options, j.str("human_kind"),
            j.optBoolean("allow_custom"), j.optBoolean("options_valid"))
    }

    /** The gate's pending asks as the owner may see them (approvals.js approvalSections), soonest to expire first. */
    fun approvals(asks: List<Ask>, now: Long = System.currentTimeMillis()): List<Ask> {
        val seen = HashSet<String>()
        return asks.filter { a ->
            if (!seen.add(a.id) || a.from != GATE) return@filter false
            if (a.seq < 1 || a.state != "pending" || !a.optionsValid || a.expiresAt <= now) return@filter false
            val q = a.humanKind == "question"
            a.options.isNotEmpty() && a.options.size <= (if (q) 8 else CHOICES.size) &&
                a.options.all { o -> o.label.isNotEmpty() && (if (q) o.id.isNotEmpty() else o.id in CHOICES) } && a.options.map { it.id }.toSet().size == a.options.size
        }.map { a -> Ask(a.id, a.seq, a.from, a.state, safeText(a.title).ifEmpty { "待确认的操作" }, safeText(a.detail, 1000), a.original, a.originalFull, a.expiresAt, a.ts,
            a.options.map { Opt(it.id, it.label.take(80)) }, a.humanKind, a.allowCustom, true) }.sortedWith(compareBy({ it.expiresAt }, { it.seq }))
    }

    /** Everything waiting for the owner: gate approvals first (soonest to expire first), then the questions members asked. */
    fun waitingItems(asks: List<Ask>, now: Long = System.currentTimeMillis()): List<Waiting> =
        approvals(asks, now).map { Waiting(true, it) } + asks.filter { it.from != GATE && it.state == "pending" && it.expiresAt > now && (it.optionsValid || it.allowCustom) }
            .sortedBy { it.seq }.map { Waiting(false, it) }

    fun actionLabel(word: String?, risk: String?): String = when (word) {
        "calendar.create" -> "创建日历事件"; "message.send" -> "发送消息"; "browser.click" -> "在网页上点击"; "browser.type" -> "在网页上输入"
        "shell.run" -> "执行命令"; "rules.set", "rules.revoke" -> "修改审批规则"; "mode.set" -> "修改审批档位"
        else -> when (risk) { "outward" -> "对外操作"; "structure" -> "修改资料"; else -> "受保护操作" }
    }

    private val DECISIONS = mapOf("once" to "允许了", "always" to "以后都允许", "deny" to "拒绝了", "timeout" to "过期没回答：", "cancelled" to "取消了", "rule" to "按规则放行：",
        "review" to "她判断后放行：", "carry" to "刚允许过，沿用：", "hand_full" to "设备完全放开放行：", "declared_none" to "无影响，直接放行：", "assessed_none" to "评估无影响，直接放行：")
    val VERB = mapOf("once" to "仅这一次", "always" to "以后都允许", "deny" to "已拒绝", "timeout" to "过期没回答", "cancelled" to "已取消", "rule" to "按规则放行", "review" to "由她判断后放行",
        "carry" to "刚允许过，沿用", "hand_full" to "设备完全放开放行", "declared_none" to "无影响，直接放行", "assessed_none" to "评估无影响，直接放行")
    fun itemLabel(item: JSONObject) = item.str("label")?.takeIf { it.isNotEmpty() } ?: actionLabel(item.str("word"), item.str("risk"))
    fun decisionText(item: JSONObject) = "${DECISIONS[item.str("decision")] ?: "已记录："}「${itemLabel(item)}」"
    fun validDecision(item: JSONObject) = !item.str("id").isNullOrEmpty() && item.num("at") != null

    private val EFFECTS = mapOf("read" to "读", "act" to "操作", "write" to "改数据", "send" to "对外发送", "execute" to "执行命令", "structure" to "改结构")
    private val DECIDED_BY = mapOf("hand_full" to "设备完全放开", "device_full" to "设备完全放开", "declared_none" to "本来就不需要审批", "assessed_none" to "评估后无影响，直接放行", "rule" to "你定的规则",
        "review" to "裁判（模型判断）", "carry" to "沿用你几分钟前的允许", "owner" to "你", "timeout" to "没人回答，过期", "cancelled" to "取消了", "waiting" to "还在等")
    private val ANSWERS = mapOf("once" to "允许这一次", "always" to "以后都允许", "deny" to "不允许")

    /** One decision's evidence (approvals.js renderEvidence): label and value pairs. */
    fun evidence(e: JSONObject, now: Long, name: String, primary: String?): List<Pair<String, String>> {
        val rows = ArrayList<Pair<String, String>>()
        fun row(label: String, v: String?) { if (!v.isNullOrEmpty()) rows.add(label to v) }
        val effect = EFFECTS[e.str("effect")] ?: safeText(e.opt("effect"), 40)
        val requester = e.str("requester") ?: ""
        row("谁要做", if (requester == primary) name else if (requester.startsWith("agent:")) "一个帮手" else "系统")
        val what = if (e.str("member") == GATE) actionLabel(e.str("word"), e.str("risk")) else safeText(e.opt("label"), 120).ifEmpty { safeText(e.opt("word"), 80) }
        row("要做什么", "$what${if (effect.isNotEmpty()) "（$effect）" else ""}")
        row("具体内容", safeText(e.opt("content"), 1200))
        e.optJSONObject("facts")?.let { f ->
            val said = (f.optJSONArray("owner_said") ?: JSONArray()).let { a -> (0 until a.length()).mapNotNull { (a.opt(it) as? String)?.let { s -> "「${safeText(s, 300)}」" } } }
            row("裁判看到你说的", if (said.isNotEmpty()) said.joinToString("\n") else "这一轮你没有说话")
            val steps = (f.optJSONArray("context") ?: JSONArray()).let { a -> (0 until a.length()).mapNotNull { (a.opt(it) as? String)?.let { s -> safeText(s, 200) } } }
            if (steps.isNotEmpty()) row("裁判看到的前几步", steps.joinToString("\n"))
        }
        val review = e.optJSONObject("review")
        if (review != null) {
            val ms = review.num("ms")?.let { "，用了 ${String.format(Locale.US, "%.1f", it / 1000.0)} 秒" } ?: ""
            if (review.str("decision") == "unavailable") row("裁判结论", "没判出来（${safeText(review.opt("error"), 200)}）$ms，所以问你")
            else row("裁判结论", "${if (review.str("decision") == "allow") "可以直接做" else "要问你"}$ms${safeText(review.opt("reason"), 400).let { if (it.isNotEmpty()) "：$it" else "" }}")
        }
        e.optJSONObject("card")?.let { c ->
            row("卡片上写的", listOf(safeText(c.opt("title")), safeText(c.opt("detail"), 1000)).filter { it.isNotEmpty() }.joinToString("\n"))
            if (c.optBoolean("forced")) row("为什么一定问你", "改审批规则和档位，写死必须由你决定")
        }
        ANSWERS[e.str("decision")]?.let { row("你的回答", it + (e.num("answered_at")?.let { t -> " · ${dayTime(t, now)}" } ?: "")) }
        row("谁做的决定", DECIDED_BY[e.str("decided_by")] ?: safeText(e.opt("decided_by"), 40))
        if (e.str("decided_by") != "review" && e.str("decided_by") != "carry" && safeText(e.opt("reason"), 400).isNotEmpty() && review == null) row("理由", safeText(e.opt("reason"), 400))
        val executed = e.optJSONObject("executed")
        val decision = e.str("decision")
        row("最后", if (executed != null) { if (executed.optBoolean("ok")) "做成了" else if (decision == "deny") "没有做" else "没做成（${safeText(executed.opt("message"), 200).ifEmpty { safeText(executed.opt("error"), 60) }}）" }
            else if (decision in listOf("deny", "timeout", "cancelled")) "没有做" else "还没有结果")
        return rows
    }

    // ---- activity
    private val RAW_ROUTE = Regex("\\b(?:agent|worker|device|service|person):[A-Za-z0-9_-]+\\b|\\b[a-z][a-z0-9_-]*(?:\\.[a-z][a-z0-9_-]*)+\\b", RegexOption.IGNORE_CASE)
    private val WEB_DETAIL = Regex("^(?:在看网页|在搜索) · [^\\n]{1,61}$")
    private val TURN_ID = Regex("[A-Za-z0-9_-]{1,128}")

    class Turn(val id: String, val title: String, val background: Boolean, val started: Long, val ended: Long?, val outcome: String?, val agent: String?, val messageId: String?)
    class Step(val label: String, val ts: Long?, val ended: Long?, val state: String?, val tool: Boolean, val requestId: String?, val summary: Boolean)

    fun turnOf(j: JSONObject): Turn? {
        val id = j.str("id")?.takeIf { TURN_ID.matches(it) } ?: return null
        val started = j.num("started") ?: return null
        return Turn(id, j.str("title")?.takeIf { it.isNotEmpty() } ?: if (j.optBoolean("background")) "后台任务" else "对话", j.optBoolean("background"), started, j.num("ended"),
            j.str("outcome")?.takeIf { it in listOf("completed", "cancelled", "error") }, j.str("agent"), j.str("message_id"))
    }

    /** Only ledger-derived, human-facing status steps enter the activity page. */
    fun stepsOf(items: List<JSONObject>): List<Step> = items.mapNotNull { s ->
        val label = s.str("label")?.takeIf { it.length <= 180 } ?: return@mapNotNull null
        val tool = s.opt("tool").let { it != null && it != JSONObject.NULL && it != false && it != "" }
        val summary = s.optBoolean("summary")
        if (!(tool || summary || WEB_DETAIL.matches(label) || !RAW_ROUTE.containsMatchIn(label))) return@mapNotNull null
        Step(label, s.num("ts"), s.num("ended"), s.str("state"), tool, s.str("requestId") ?: s.str("id"), summary)
    }

    class Day(val day: Long, val front: List<Turn>, val back: List<Turn>)
    fun activityByDay(turns: List<Turn>): List<Day> =
        turns.sortedByDescending { it.started }.groupBy { startOfDay(it.started) }.map { (day, list) -> Day(day, list.filter { !it.background }, list.filter { it.background }) }.sortedByDescending { it.day }

    /** The ending of a turn in plain words: (key, label). */
    fun outcomeText(t: Turn): Pair<String, String> {
        val end = t.ended ?: return "running" to "还在做…"
        val took = if (end >= t.started) " · 用时 ${duration(end - t.started)}" else ""
        return when (t.outcome) { "completed" -> "completed" to "完成了$took"; "cancelled" -> "cancelled" to "被打断了$took"; "error" -> "error" to "没做完$took"; else -> "ended" to "结束了$took" }
    }

    // ---- memory
    class MemGroup(val title: String, val items: List<String>)
    private fun plain(v: String) = v.replace(Regex("\\*\\*(.+?)\\*\\*"), "$1").replace(Regex("`([^`]+)`"), "$1").replace(Regex("\\[([^\\]]+)\\]\\([^)]*\\)"), "$1").trim()

    /** USER.md / MEMORY.md as the memory page shows them: one group per second-level heading, one row per line of it. */
    fun groupMemory(markdown: String?): List<MemGroup> {
        class G(val title: String, val items: MutableList<String> = ArrayList())
        val groups = ArrayList<G>()
        var current: G? = null
        for (raw in (markdown ?: "").split(Regex("\\r?\\n"))) {
            val line = raw.trim()
            if (line.isEmpty()) continue
            val heading = Regex("^(#{1,6})\\s+(.*)$").find(line)
            if (heading != null) {
                if (heading.groupValues[1].length == 1) { current = null; continue }
                current = G(plain(heading.groupValues[2])).also { groups.add(it) }
                continue
            }
            if (Regex("^---+$|^<!--").containsMatchIn(line)) continue
            val text = plain(line.replace(Regex("^(?:[-*+]|\\d+[.)])\\s+"), ""))
            if (text.isEmpty()) continue
            if (current == null) current = G("").also { groups.add(it) }
            current.items.add(text)
        }
        return groups.filter { it.items.isNotEmpty() }.map { MemGroup(it.title, it.items) }
    }

    fun memoryCount(groups: List<MemGroup>) = groups.sumOf { it.items.size }
    fun urgentGroup(title: String) = Regex("要紧|重要|注意|禁忌|过敏|务必").containsMatchIn(title)

    private const val CHIP_LIMIT = 12
    private fun graphemes(s: String): List<String> {
        val it = BreakIterator.getCharacterInstance(); it.setText(s)
        val out = ArrayList<String>(); var start = it.first(); var end = it.next()
        while (end != BreakIterator.DONE) { out.add(s.substring(start, end)); start = end; end = it.next() }
        return out
    }

    /** A memory line as a short label (see DESIGN-DECISIONS 2): the half before its first "：" or ":" (not between digits), else up to its first "，。；、"; over 12 keeps 11 and "…". */
    fun memoryChip(line: String): String {
        var full = line.trim()
        var head = ""
        var i = 0
        while (i < full.length) {
            val ch = full[i]
            val digits = i > 0 && i + 1 < full.length && full[i - 1] in '0'..'9' && full[i + 1] in '0'..'9'
            if (ch == '：' || (ch == ':' && !digits)) {
                head = full.substring(0, i).trim()
                if (head.isEmpty()) full = full.substring(i + 1).trim()
                break
            }
            i++
        }
        if (head.isEmpty()) head = Regex("[，。；、]").find(full)?.let { full.substring(0, it.range.first).trim() } ?: full
        if (head.isEmpty()) head = full
        val chars = graphemes(head)
        return if (chars.size > CHIP_LIMIT) chars.take(CHIP_LIMIT - 1).joinToString("") + "…" else head
    }

    class Chips(val chips: List<Pair<String, Boolean>>, val more: Int)
    /** The labels of the home page's 「她记得你」: at most [limit], the urgent lines first, the last one saying how many are left out. */
    fun memoryChips(groups: List<MemGroup>, limit: Int = 5): Chips {
        val all = groups.flatMap { g -> g.items.map { memoryChip(it) to urgentGroup(g.title) } }.sortedByDescending { it.second }
        val shown = if (all.size > limit) limit - 1 else all.size
        return Chips(all.take(shown), all.size - shown)
    }

    // ---- clock
    class Timer(val id: String, val next: Long, val every: Long?, val to: String?, val by: String?, val label: String, val blocked: Boolean)
    private fun human(v: Any?) = v == null || v == JSONObject.NULL || (v is String && v.length <= 160 && !RAW_ROUTE.containsMatchIn(v))

    /** The timers of a `service:clock/list` answer, checked; null when it is malformed (never an empty list in its place). */
    fun normalizeClock(data: JSONObject?): List<Timer>? {
        val arr = data?.optJSONArray("timers") ?: return null
        val out = ArrayList<Timer>()
        for (i in 0 until arr.length()) {
            val t = arr.optJSONObject(i) ?: return null
            val id = t.str("id")?.takeIf { it.isNotEmpty() } ?: return null
            val next = t.num("next")?.takeIf { it >= 0 } ?: return null
            val everyRaw = t.opt("every")
            if (everyRaw != null && everyRaw != JSONObject.NULL && ((everyRaw as? Number)?.toLong()?.let { it < 60 } != false)) return null
            if (!human(t.opt("label")) || !human(t.opt("blocked"))) return null
            out.add(Timer(id, next, (everyRaw as? Number)?.toLong(), t.str("to"), t.str("created_by"), t.str("label") ?: "", t.str("blocked") != null))
        }
        return out
    }

    /** The plans the system makes for its own upkeep are not the owner's to read or delete. */
    fun isSystemPlan(t: Timer): Boolean {
        if ((t.by ?: "").startsWith("service:") || (t.to ?: "").startsWith("service:")) return true
        if (t.by != null || t.to != null) return false
        return Regex("^[a-z][a-z0-9_-]*(:[^\\s:]+)+$", RegexOption.IGNORE_CASE).matches(t.label) || Regex("^[\\x21-\\x7e]*\\d{9,}[\\x21-\\x7e]*$").matches(t.label)
    }
    fun userPlans(t: List<Timer>) = t.filter { !isSystemPlan(it) }

    fun repeatText(every: Long?): String {
        if (every == null || every < 60) return "只一次"
        return when {
            every % 604_800 == 0L -> if (every == 604_800L) "每周" else "每 ${every / 604_800} 周"
            every % 86_400 == 0L -> if (every == 86_400L) "每天" else "每 ${every / 86_400} 天"
            every % 3_600 == 0L -> if (every == 3_600L) "每小时" else "每 ${every / 3_600} 小时"
            every % 60 == 0L -> "每 ${every / 60} 分钟"
            else -> "每 $every 秒"
        }
    }

    /** The times a timer fires in [from, to): its next time, and every repeat of it. */
    fun occurrences(t: Timer, from: Long, to: Long): List<Long> {
        val out = ArrayList<Long>()
        val step = if (t.every != null && t.every >= 60) t.every * 1000 else 0L
        var at = t.next
        if (step > 0 && at < from) at += Math.ceil((from - at).toDouble() / step).toLong() * step
        var n = 0
        while (at < to && n < 500) { if (at >= from) out.add(at); if (step == 0L) break; at += step; n++ }
        return out
    }
    private fun nextDay(day: Long) = at(day).toLocalDate().plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
    class WeekDay(val day: Long, val count: Int)
    fun weekStrip(timers: List<Timer>, now: Long = System.currentTimeMillis()): List<WeekDay> {
        val today = at(now).toLocalDate()
        return (0 until 7).map { i ->
            val day = today.plusDays(i.toLong()).atStartOfDay(zone).toInstant().toEpochMilli()
            val to = nextDay(day)
            WeekDay(day, timers.sumOf { occurrences(it, day, to).size })
        }
    }
    fun dayItems(timers: List<Timer>, day: Long): List<Pair<Long, Timer>> = timers.flatMap { t -> occurrences(t, day, nextDay(day)).map { it to t } }.sortedBy { it.first }
    fun nextUp(timers: List<Timer>, limit: Int = 5) = timers.sortedBy { it.next }.take(limit)

    // ---- the persona
    const val DEFAULT_NAME = "Ash"
    /** The display name is one field of IDENTITY.md. */
    fun nameFromIdentity(content: String?): String? {
        if (content == null || content.length > 65_536) return null
        val names = content.split(Regex("\\r?\\n")).filter { Regex("^\\s*[-*]\\s*(?:名字|Name)\\s*[：:]", RegexOption.IGNORE_CASE).containsMatchIn(it) }
        if (names.size != 1) return null
        val m = Regex("^\\s*[-*]\\s*(?:名字|Name)\\s*[：:]\\s*(.*?)\\s*$", RegexOption.IGNORE_CASE).find(names[0]) ?: return null
        val name = m.groupValues[1].trim().removeSuffix("（初次见面时可以换成你喜欢的名字）").trim()
        if (name.isEmpty() || name.codePointCount(0, name.length) > 32 || name.any { it.code <= 0x1f || it.code == 0x7f || it == '<' || it == '>' }) return null
        return name
    }

    /** The one-line card of IDENTITY.md under the name: its other fields. */
    fun identitySub(content: String?): String {
        val sub = (content ?: "").split(Regex("\\r?\\n")).mapNotNull { Regex("^\\s*[-*]\\s*([^：:]{1,12})[：:]\\s*(.+?)\\s*$").find(it) }
            .filter { !Regex("^(名字|Name)$", RegexOption.IGNORE_CASE).matches(it.groupValues[1].trim()) }
            .joinToString(" · ") { if (it.groupValues[1] == "称呼主人") "叫你「${it.groupValues[2]}」" else it.groupValues[2] }
        return sub.codePoints().limit(44).toArray().let { String(it, 0, it.size) }
    }

    /** The first few lines of her soul as a quote: no headings, no list marks, about [max] characters. */
    fun quoteOf(markdown: String?, max: Int = 90): String {
        val text = (markdown ?: "").split(Regex("\\r?\\n")).map { it.trim() }.filter { it.isNotEmpty() && !Regex("^#{1,6}\\s").containsMatchIn(it) && !Regex("^---+$").matches(it) }
            .joinToString("") { it.replace(Regex("^(?:[-*+]|\\d+[.)])\\s+"), "").replace(Regex("\\*\\*(.+?)\\*\\*"), "$1").replace(Regex("`([^`]+)`"), "$1") }
        val cps = text.codePoints().toArray()
        return if (cps.size > max) String(cps, 0, max) + "…" else text
    }

    fun firstLine(text: String?): String = (text ?: "").split(Regex("\\r?\\n")).map { it.trim() }.firstOrNull { it.isNotEmpty() && !Regex("^#{1,6}\\s").containsMatchIn(it) } ?: ""

    // ---- quiet hours, keys, models
    const val QUIET_KEY = "delivery.quiet_hours"
    const val QUIET_DEFAULT = "21:30-09:00"
    val QUIET_FORMAT = Regex("^([01]\\d|2[0-3]):[0-5]\\d-([01]\\d|2[0-3]):[0-5]\\d$")
    /** The time a quiet-hours setting names: "HH:MM-HH:MM", "" for none, or null when it cannot be read. */
    fun quietOf(settings: JSONObject?): String? {
        val v = settings?.opt(QUIET_KEY)
        return when { v == null -> QUIET_DEFAULT; v == "" -> ""; v is String && QUIET_FORMAT.matches(v) -> v; else -> null }
    }

    class KeyInfo(val ref: String, val provider: String, val title: String, val lost: String, val account: String, val effect: String, val use: String, val hint: String)
    val KEYS = listOf(
        KeyInfo("DEEPSEEK_API_KEY", "deepseek", "DeepSeek Key", "对话模型的 DeepSeek Key", "对话模型的 DeepSeek 账户", "她暂时无法对话", "跟你对话用", "没有它，她没法跟你说话。"),
        KeyInfo("OPENROUTER_API_KEY", "openrouter", "OpenRouter Key", "快速判断的 OpenRouter Key", "快速判断的 OpenRouter 账户", "快速判断只能靠关键词", "快速判断要不要问你", "没有它，快速判断只能靠关键词。"))

    fun keyStateText(health: JSONObject?): String = when (health?.str("status")) {
        "ok" -> "已保存，已验证可用。"
        "low_balance" -> "已验证，但余额不足，她暂时无法对话。"
        "rejected" -> "已失效（${health.str("reason")?.ifEmpty { null } ?: "无效"}），请换一把新的 Key。"
        "unknown" -> "已保存，暂时没验证上${health.str("reason")?.takeIf { it.isNotEmpty() }?.let { "（$it）" } ?: ""}。"
        else -> "已保存。"
    }

    /** The saved keys that do not work, one plain sentence each. */
    fun keyProblems(keys: List<JSONObject>): List<String> = KEYS.flatMap { k ->
        val h = keys.firstOrNull { it.str("provider") == k.provider }
        if (h == null || !h.optBoolean("configured")) emptyList()
        else when (h.str("status")) {
            "rejected" -> listOf("${k.lost} 已失效（${h.str("reason")?.ifEmpty { null } ?: "无效"}），${k.effect}。")
            "low_balance" -> listOf("${k.account}余额不足，${k.effect}。")
            else -> emptyList()
        }
    }

    fun providerName(model: String?): String {
        val code = model ?: ""
        fun starts(re: String) = Regex("^(?:$re)", RegexOption.IGNORE_CASE).containsMatchIn(code)
        return when {
            starts("deepseek") -> "DeepSeek"; starts("gpt|o\\d|chatgpt") -> "OpenAI"; starts("claude") -> "Claude"; starts("gemini") -> "Gemini"
            starts("qwen|qwq") -> "通义千问"; starts("kimi|moonshot") -> "Kimi"; starts("glm") -> "智谱"; else -> code
        }
    }
    fun pluginName(name: String) = name.replace(Regex("^@[^/]+/"), "").replace(Regex("^(?:dsh|cordis)-(?:plugin-)?"), "").replace(Regex("[-_/:]+"), " ").trim().ifEmpty { name }

    const val HELPER = "一个帮手"
    private val SYSTEM_FILES = listOf("AGENTS.md", "SOUL.md", "IDENTITY.md", "PULSE.md", "USER.md", "MEMORY.md", "PROACTIVE.md")
    private val SYSTEM_FOLDERS = listOf("skills", "memory")
    /** What the system itself keeps in her work folder, so it is not 「her files」. */
    fun isSystemEntry(name: String, directory: Boolean) = name.startsWith(".") ||
        (if (directory) name in SYSTEM_FOLDERS else SYSTEM_FILES.any { it.equals(name, ignoreCase = true) })

    // ---- devices and the relay
    val KIND_NAMES = mapOf("computer" to "电脑", "laptop" to "电脑", "server" to "服务器", "browser" to "浏览器")
    fun handOf(device: String) = device.removePrefix("device:")
    class DeviceLine(val text: String, val ok: Boolean)
    fun deviceLine(d: JSONObject): DeviceLine {
        val kind = KIND_NAMES[d.str("kind")] ?: "设备"
        if (d.num("revoked_at") != null) return DeviceLine("$kind · 已移除，连不上了", false)
        val online = d.optBoolean("online")
        val seen = if (!online) d.num("last_seen")?.let { " · 上次在线 ${clock(it)}" } ?: "" else ""
        return DeviceLine("$kind · ${if (online) "在线" else "离线"}$seen${if (d.str("via") == "gateway") " · 经中转站" else ""}", online)
    }

    fun deviceDiagnosis(device: JSONObject, connections: Int, diagnosis: JSONObject?): String {
        val lines = ArrayList<String>()
        lines.add("${if (device.optBoolean("online")) "在线" else "离线"}${when (device.str("via")) { "gateway" -> "（经中转站）"; "local" -> "（和这台手机直连）"; else -> "" }}。")
        if (!device.optBoolean("online")) device.num("last_seen")?.let { lines.add("上次在线：${clock(it)}。") }
        if (connections > 0) lines.add("现在有 $connections 条连接。")
        if (diagnosis != null) {
            val findings = diagnosis.list("findings").mapNotNull { it.str("message") }
            if (diagnosis.optBoolean("ok") && findings.isEmpty()) lines.add("没有发现问题。")
            else { lines.add(if (diagnosis.optBoolean("ok")) "提醒：" else "发现这些问题："); findings.forEach { lines.add("· $it") } }
        }
        return lines.joinToString("\n")
    }

    fun relayText(s: JSONObject?): String {
        if (s == null || !s.optBoolean("configured")) return "还没有设置中转站，其他设备暂时连不上。"
        val where = s.str("url")?.takeIf { it.isNotEmpty() }?.let { "（$it）" } ?: ""
        if (s.optBoolean("connected")) return "中转站已连接$where${s.str("account_email")?.takeIf { it.isNotEmpty() }?.let { "，账号 $it" } ?: ""}。"
        val why = s.str("last_error")?.takeIf { it.isNotEmpty() }?.let { "：$it" } ?: ""
        return "中转站暂时连不上$where$why。会自动重试，也请检查网络和地址。"
    }

    private val PROVIDER_NAMES = mapOf("deepseek" to "DeepSeek", "openrouter" to "OpenRouter")
    fun balanceSentence(data: JSONObject?): String {
        val parts = ArrayList<String>(); var unavailable = false
        for (e in data?.list("balances") ?: emptyList()) {
            val b = e.optJSONObject("balance") ?: continue
            if (b.opt("available") == false) unavailable = true
            val label = PROVIDER_NAMES[e.str("provider")] ?: e.str("provider") ?: ""
            for (item in b.list("balances")) parts.add("${if (label.isNotEmpty()) "$label " else ""}${balanceText(item)}")
        }
        val failed = data?.optJSONObject("errors")?.keys()?.asSequence()?.map { PROVIDER_NAMES[it] ?: it }?.toList() ?: emptyList()
        return "账户余额：${parts.joinToString("，").ifEmpty { "无数据" }}${if (unavailable) "（账户当前不可用）" else ""}${if (failed.isNotEmpty()) "（${failed.joinToString("、")} 暂时读不到）" else ""}"
    }

    // ---- apps (the grid itself is the native AppsPane; the home page only counts them)
    fun appsSummary(apps: List<JSONObject>): String {
        if (apps.isEmpty()) return "还没有应用"
        val on = apps.count { it.optBoolean("granted") && it.optBoolean("enabled") }
        return "${apps.size} 个应用 · ${if (on > 0) "$on 个已启用" else "都没启用"}"
    }

    // ---- files
    val IMAGES = listOf("png", "jpg", "jpeg", "gif", "webp")
    val TEXTS = listOf("md", "markdown", "txt", "json", "csv", "log", "js", "ts", "css", "py", "yaml", "yml", "xml", "html", "htm")
    fun sizeText(bytes: Long) = if (bytes >= 1_048_576) String.format(Locale.US, "%.1f MB", bytes / 1_048_576.0) else "${maxOf(1L, Math.ceil(bytes / 1024.0).toLong())} KB"
}
