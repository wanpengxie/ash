package ai.ash.ui

import android.content.Intent
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.AshUi.Kind
import ai.ash.ui.design.AshUi.Tone
import ai.ash.ui.design.Role
import org.json.JSONArray
import org.json.JSONObject

/** Pause and resume (`service:admin`): pausing is at once, resuming asks once more. A lost answer keeps its request id, so the same request may be sent again. */
class HomePause(private val env: HomeEnv, private val ctx: android.app.Activity, kind: Kind = Kind.GHOST, private val call: (word: String, body: JSONObject, clientId: String?, done: (Reply) -> Unit) -> Unit) {
    private val c = AshUi.p(ctx)
    private var paused = false
    private var name = env.names.name
    private val feedback = Hk.note(ctx, "").apply { visibility = View.GONE }
    private val confirm = AshUi.vstack(ctx, 8).apply {
        background = AshUi.rounded(c.surface2, AshUi.dpF(ctx, AshTokens.Radius.md.toFloat())); setPadding(AshUi.dp(ctx, 14), AshUi.dp(ctx, 12), AshUi.dp(ctx, 14), AshUi.dp(ctx, 12)); visibility = View.GONE
    }
    private val confirmText = AshUi.text(ctx, "确定要恢复 $name 吗？", AshTokens.Type.sub)
    private val button: TextView = AshUi.button(ctx, "暂停 $name", kind, block = true) { if (paused) confirm.visibility = View.VISIBLE else run("pause") }
    private val yes: TextView = AshUi.button(ctx, "确认恢复", Kind.PRIMARY, AshUi.BtnSize.SM) { confirm.visibility = View.GONE; run("resume") }
    val root: LinearLayout = AshUi.vstack(ctx, 8)

    init {
        if (kind == Kind.GHOST) button.setTextColor(c.err)
        confirm.addView(confirmText)
        confirm.addView(AshUi.hstack(ctx, 8).apply { addView(yes); addView(AshUi.button(ctx, "取消", Kind.NEUTRAL, AshUi.BtnSize.SM) { confirm.visibility = View.GONE }) })
        root.addView(button); root.addView(confirm); root.addView(feedback)
    }

    private fun show(value: Boolean) {
        paused = value; name = env.names.name
        button.text = if (paused) "恢复 $name" else "暂停 $name"
        confirmText.text = "确定要恢复 $name 吗？"
    }

    private fun run(word: String) {
        button.isEnabled = false; yes.isEnabled = false
        feedback.text = "正在处理…"; feedback.visibility = View.VISIBLE
        val key = "pause:$word"
        call(word, if (word == "resume") JSONObject().put("confirmed", true) else JSONObject(), env.intents.id(key)) { r ->
            button.isEnabled = true; yes.isEnabled = true
            val done = r.ok && r.data.opt("paused") == (word == "pause")
            if (r.ok || !r.retryable) env.intents.drop(key)
            feedback.text = if (done) (if (word == "pause") "已暂停 $name" else "已恢复 $name") else "状态未确认，请检查连接后重试。"
            if (done) show(word == "pause")
        }
    }

    fun read() = call("status", JSONObject(), null) { r -> if (r.ok && r.data.has("paused")) show(r.data.optBoolean("paused")) }
}

/** 她的主页: who she is right now, what waits for you, what is coming, what she remembers, what you agreed, her hands and eyes, who she is, her files and the backstage. Every block opens a page of its own. */
class HmHome(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = ""
    private val agent = env.agent
    private val her = agent == null
    private val port = env.port

    // what the blocks show; null is "not read yet"
    private var current: JSONObject? = null
    private var todayCount: Long? = null
    private var usage: JSONObject? = null
    private var agents: List<JSONObject>? = null
    private var timers: List<HomeModel.Timer>? = null
    private var memory: List<HomeModel.MemGroup>? = null
    private var quiet: String? = null; private var quietRead = false
    private var mode: String? = null; private var rules: Int? = null
    private var proactive: String? = null
    private var devices: List<JSONObject>? = null; private var pairsWaiting = 0; private var devicesRead = false
    private var apps: List<JSONObject>? = null
    private var soul: String? = null; private var soulRead = false
    private var files: List<JSONObject>? = null
    private var keys: Pair<String, String>? = null; private var provider = ""
    private var todo = 0
    private var off: () -> Unit = {}

    // ---- the hero
    private var avatar: AshUi.AvatarView? = null
    private var avatarKey = ""
    private val avatarSlot = FrameLayout(ctx).apply { clipChildren = false }
    private val nameView = AshUi.text(ctx, env.names.name, AshType(28f, 36f, 700, Role.INK))
    private val pillSlot = FrameLayout(ctx)
    private var pillKey = ""
    private val statDone = stat("—", "今天做的事") { env.nav.go("activity", agent) }
    private val statWait = stat("—", "等你") { env.nav.go("waiting", agent) }
    private val statSpent = stat("—", "今天花的") { env.nav.go("backstage") }
    private val hero = AshUi.vstack(ctx, 8).apply {
        gravity = Gravity.CENTER_HORIZONTAL
        setPadding(dp(4), dp(8), dp(4), dp(22)); clipChildren = false
        addView(avatarSlot, LinearLayout.LayoutParams(-2, -2))
        addView(nameView, Hk.lp(ctx, -2, -2, 6))
        addView(pillSlot, LinearLayout.LayoutParams(-2, -2))
        addView(AshUi.hstack(ctx, 8).apply { gravity = Gravity.TOP; listOf(statDone, statWait, statSpent).forEach { addView(it.first, LinearLayout.LayoutParams(0, -2, 1f)) } }, Hk.lp(ctx, -1, -2, 14))
    }

    private fun stat(value: String, label: String, open: () -> Unit): Pair<LinearLayout, TextView> {
        val num = AshUi.text(ctx, value, AshType(22f, 28f, 700, Role.INK))
        val cell = Hk.cell(ctx, 18) { open() }.apply {
            gravity = Gravity.CENTER_HORIZONTAL; minimumHeight = dp(AshTokens.Size.touch); setPadding(dp(10), dp(12), dp(10), dp(12))
            addView(num); addView(AshUi.text(ctx, label, AshTokens.Type.caption))
        }
        return cell to num
    }

    private val waitingBox = AshUi.vstack(ctx)
    private val upcomingBox = AshUi.vstack(ctx)
    private val memoryBox = AshUi.vstack(ctx)
    private val promisesBox = AshUi.vstack(ctx)
    private val handsBox = AshUi.vstack(ctx)
    private val whoBox = AshUi.vstack(ctx)
    private val filesBox = AshUi.vstack(ctx)
    private val backBox = AshUi.vstack(ctx)
    private val pause = HomePause(env, ctx, Kind.GHOST) { word, b, id, done -> call("service:admin", word, b, id, done) }
    private val blocks = AshUi.vstack(ctx, 26)

    override fun content(): View = FrameLayout(ctx).apply {
        if (her) addView(Glow(ctx), FrameLayout.LayoutParams(dp(AshTokens.Size.glowW), dp(AshTokens.Size.glowH), Gravity.TOP or Gravity.CENTER_HORIZONTAL))
        addView(AshUi.vstack(ctx).apply { clipChildren = false; addView(hero); addView(blocks) })
    }

    init {
        (listOf(waitingBox, upcomingBox) + if (her) listOf(memoryBox, promisesBox, handsBox, whoBox, filesBox, backBox) else emptyList()).forEach { blocks.addView(it) }
        off = env.names.listen { if (alive) { drawHero(); drawBackstage() } }
        drawAll()
        every(1000) { if (since() != null) drawHero() }
        every(15_000) { readAll() }
        every(60_000) { readCheckup() }
    }

    override fun onDispose() { off() }
    private fun online() = port.open
    private fun asks(): List<HomeModel.Ask> = current?.list("items")?.mapNotNull { it.optJSONObject("ask")?.let(HomeModel::askOf) } ?: emptyList()
    private fun waitingCount(): Long? = current?.num("total_count")
    private fun name() = if (her) env.names.name else agents?.firstOrNull { it.str("id") == agent }?.str("name") ?: HomeModel.HELPER
    private fun presence() = current?.optJSONObject("presence")
    private fun since(): Long? {
        val s = presence()?.str("state")
        return if (online() && (s == "working" || s == "thinking")) current?.optJSONObject("progress")?.takeIf { !it.has("ended") || it.isNull("ended") }?.num("started") else null
    }

    private class Hero(val state: String, val face: String, val text: String, val tone: String)
    private fun heroState(): Hero {
        if (!online()) return Hero("resting", "resting", "离线", "mute")
        val p = presence()
        return when (p?.str("state")) {
            "working" -> Hero("working", "focused", p.str("text")?.ifEmpty { null } ?: "在忙", "her")
            "thinking" -> Hero("thinking", "thinking", "在想", "her")
            "waiting_you" -> Hero("waiting_you", "listening", "等你一句话", "warn")
            else -> Hero("idle", "default", "在线", "ok")
        }
    }

    private fun drawHero() {
        val h = heroState()
        val name = name()
        nameView.text = name
        // her face and its ring: only touched when the state changes; a helper has a letter instead
        val key = "${h.state}/${her}/$name"
        if (key != avatarKey) {
            avatarKey = key
            avatarSlot.removeAllViews()
            if (her) {
                val state = when (h.state) { "working" -> AshUi.AvatarView.State.WORKING; "thinking" -> AshUi.AvatarView.State.THINKING; "waiting_you" -> AshUi.AvatarView.State.WAITING
                    "resting" -> AshUi.AvatarView.State.OFFLINE; else -> AshUi.AvatarView.State.ONLINE }
                val a = OnboardingViews.avatar(ctx, h.face, AshTokens.Size.avatarHome, state)
                avatar = a
                avatarSlot.addView(a)
            } else avatarSlot.addView(AshUi.letterAvatar(ctx, name, AshTokens.Size.avatarHome))
        }
        val since = since()?.let { " · ${HomeModel.duration(maxOf(0L, System.currentTimeMillis() - it))}" } ?: ""
        val busy = h.state == "working" || h.state == "thinking"
        val pk = "${h.tone}/$busy"
        if (pk != pillKey) { pillKey = pk; pillSlot.removeAllViews(); pillSlot.addView(Hk.statePill(ctx, h.text + since, h.tone, busy)) }
        else ((pillSlot.getChildAt(0) as LinearLayout).let { it.getChildAt(it.childCount - 1) as TextView }).text = h.text + since

        statDone.second.text = todayCount?.toString() ?: "—"
        val w = waitingCount()
        statWait.second.text = w?.toString() ?: "—"
        statWait.second.setTextColor(if (w != null && w > 0) c.warn else c.ink)
        statSpent.second.text = HomeModel.usdToCny(usage?.optJSONObject("periods")?.optJSONObject("today")?.dbl("cost_usd"))
    }

    // ---- 等你的
    private fun drawWaiting(): Unit = redraw(waitingBox) {
        val items = HomeModel.waitingItems(asks()).filter { agent == null || it.ask.from == agent }
        wake("expiry", items.minOfOrNull { it.ask.expiresAt }) { drawWaiting(); drawHero() }
        val now = System.currentTimeMillis()
        val rows = items.take(3).map { w ->
            val a = w.ask
            Hk.row(ctx, if (w.approval) "shield" else "ask", a.title, tone = if (w.approval) "warn" else "her", tall = true,
                sub = if (w.approval) "${HomeModel.firstLine(a.detail).take(24)}${if (a.detail.isNotEmpty()) " · " else ""}${HomeModel.dayTime(a.expiresAt, now)} 前有效" else "${if (agent != null) "" else "她"}问你 · ${HomeModel.ago(a.ts, now)}") { env.nav.go("waiting", agent) }
        }
        val total = if (agent != null && current == null) null else waitingCount() ?: items.size.toLong()
        addView(Hk.section(ctx, "等你的", total?.takeIf { it > 0 }?.let { "$it 件" }, null,
            if (rows.isNotEmpty()) Hk.list(ctx, rows) else if (total == null) Hk.note(ctx, "正在读取…") else Hk.list(ctx, listOf(Hk.row(ctx, "check", "没有要你决定的事", "有事她会在这里和对话里叫你", "ok")))))
    }

    // ---- 接下来
    private fun drawUpcoming(): Unit = redraw(upcomingBox) {
        val t = timers
        val items = if (t == null) emptyList() else HomeModel.nextUp(t.filter { agent == null || it.to == agent }, 6)
        val now = System.currentTimeMillis()
        val cards = items.map { timer ->
            val diff = (HomeModel.startOfDay(timer.next) - HomeModel.startOfDay(now)) / HomeModel.DAY
            Hk.cell(ctx, 20) { env.nav.go("upcoming") }.apply {
                setPadding(dp(14), dp(14), dp(14), dp(14))
                addView(AshUi.text(ctx, if (diff == 0L) "今天" else if (diff == 1L) "明天" else HomeModel.weekday(timer.next), AshTokens.Type.caption))
                addView(AshUi.text(ctx, HomeModel.hhmm(timer.next), AshType(26f, 32f, 700, Role.INK)), Hk.lp(ctx, -2, -2, 4))
                addView(AshUi.text(ctx, timer.label.ifEmpty { "没有名字的计划" }, AshType(14f, 20f, 400, Role.TEXT), maxLines = 1), Hk.lp(ctx, -1, -2, 4))
                addView(AshUi.hstack(ctx, 3).apply { if (timer.every != null) addView(Hk.tint(ctx, "repeat", c.text3, 12)); addView(AshUi.text(ctx, HomeModel.repeatText(timer.every), AshTokens.Type.caption)) }, Hk.lp(ctx, -2, -2, 4))
                layoutParams = LinearLayout.LayoutParams(dp(150), -2)
            }
        }
        addView(Hk.section(ctx, "接下来", if (t != null) "全部" else null, if (t != null) ({ env.nav.go("upcoming") }) else null,
            if (t == null) Hk.note(ctx, "正在读取…") else if (cards.isNotEmpty()) Hk.strip(ctx, 10, cards) else Hk.list(ctx, listOf(Hk.row(ctx, "clock", "暂时没有计划", "她答应到点做的事会出现在这里")))))
    }

    // ---- 她记得你
    private fun drawMemory(): Unit = redraw(memoryBox) {
        val g = memory
        val total = g?.let { HomeModel.memoryCount(it) } ?: 0
        val shown = g?.let { HomeModel.memoryChips(it) }
        val content: View = when {
            g == null -> Hk.note(ctx, "正在读取…")
            shown != null && (shown.chips.isNotEmpty()) -> AshUi.card(ctx).apply {
                addView(Flow(ctx, dp(8), dp(8)).also { f ->
                    shown.chips.forEach { (text, urgent) -> f.addView(Hk.chip(ctx, text, if (urgent) c.err else c.text, if (urgent) c.errSoft else c.surface2)) }
                    if (shown.more > 0) f.addView(Hk.chip(ctx, "还有 ${shown.more} 条", c.text3, c.surface2))
                })
            }
            else -> Hk.list(ctx, listOf(Hk.row(ctx, "pen", "她还没记下关于你的事", "聊得多了，她会自己整理在这里")))
        }
        addView(Hk.section(ctx, "她记得你", if (g != null && total > 0) "$total 条" else null, { env.nav.go("memory") }, content))
    }

    // ---- 你们的约定
    private fun drawPromises(): Unit = redraw(promisesBox) {
        val rows = ArrayList<View>()
        val q = quiet
        rows.add(Hk.row(ctx, "moon", if (!quietRead) "正在读取…" else if (!q.isNullOrEmpty()) words(c, "每天 ", Hl(q.substringBefore("-")), " 到 ", Hl(q.substringAfter("-")), " 不主动找你") else "没有设置免打扰，她随时可能找你",
            tall = true, chev = false) { env.nav.go("promises") })
        rows.add(Hk.row(ctx, "shield", if (mode == "always") words(c, Hl("每次都"), "先问你再做事") else words(c, "做", Hl("有影响的事"), "之前先问你"),
            sub = rules?.takeIf { it > 0 }?.let { "$it 件事你说过以后都可以" }, tall = true, chev = false) { env.nav.go("promises") })
        val p = proactive
        val line = p?.let { HomeModel.firstLine(it) }
        rows.add(Hk.row(ctx, "bell", if (p == null) "正在读取…" else line?.ifEmpty { null } ?: "关于你的偏好，还没写", titleTone = if (!line.isNullOrEmpty()) null else "3",
            sub = if (!line.isNullOrEmpty()) p.split(Regex("\\r?\\n")).map { it.trim() }.filter { it.isNotEmpty() }.getOrNull(1) else null,
            trailing = if (p == null || !line.isNullOrEmpty()) null else AshUi.text(ctx, "写一句", AshTokens.Type.sub, c.youText), chev = false, tall = true) { env.nav.go("promises", "proactive") })
        addView(Hk.section(ctx, "你们的约定", null, null, Hk.list(ctx, rows)))
    }

    // ---- 她的手和眼
    private fun cell(icon: String, title: String, sub: String, tone: String? = null, subTone: String? = null, onClick: () -> Unit): LinearLayout = Hk.cell(ctx, 20, onClick).apply {
        setPadding(dp(14), dp(14), dp(14), dp(14)); minimumHeight = dp(AshTokens.Size.touch)
        addView(android.widget.FrameLayout(ctx).apply {
            background = AshUi.rounded(Hk.soft(c, tone), AshUi.dpF(ctx, 11f))
            addView(Hk.tint(ctx, icon, if (tone == null) c.text else Hk.strong(c, tone), AshTokens.Size.iconSm), FrameLayout.LayoutParams(dp(AshTokens.Size.iconSm), dp(AshTokens.Size.iconSm), Gravity.CENTER))
        }, LinearLayout.LayoutParams(dp(34), dp(34)))
        addView(AshUi.text(ctx, title, AshType(15f, 21f, 600, Role.INK), maxLines = 1), Hk.lp(ctx, -1, -2, 10))
        addView(AshUi.text(ctx, sub, AshTokens.Type.caption, subTone?.let { Hk.strong(c, it) }, maxLines = 1))
    }

    private fun drawHands(): Unit = redraw(handsBox) {
        val live = devices?.filter { it.num("revoked_at") == null && it.str("kind") != "browser" } ?: emptyList()
        val online = live.count { it.optBoolean("online") }
        val cells = ArrayList<View>()
        cells.add(cell("phone", "这台手机", if (todo > 0) "$todo 项要处理" else "状态良好", if (todo > 0) "warn" else null, if (todo > 0) "warn" else "ok") { openCheckup(null) })
        cells.add(cell("laptop", if (live.size == 1) live[0].str("name") ?: "电脑" else "电脑",
            if (pairsWaiting > 0) "$pairsWaiting 台等你批准" else if (live.isNotEmpty()) (if (online > 0) "$online 台在线" else "都不在线") else "还没有连接",
            if (pairsWaiting > 0) "warn" else null, if (pairsWaiting > 0) "warn" else if (online > 0) "ok" else null) { env.nav.go("hands") })
        cells.add(cell("laptop", "电脑会话", "读取、回复或新建") { env.nav.go("coworker") })
        cells.add(cell("globe", "她的浏览器", "登录过的网站") { env.nav.go("browser") })
        cells.add(cell("grid", "应用", apps?.let { HomeModel.appsSummary(it).replace(Regex("^\\d+ 个应用 · "), "") } ?: "—") { env.nav.apps() })
        val tag: View? = if (todo > 0) AshUi.tag(ctx, "$todo 项要处理", Tone.WARN) else if (pairsWaiting > 0) AshUi.tag(ctx, "$pairsWaiting 个等你批准", Tone.WARN) else null
        addView(Hk.section(ctx, "她的手和眼", null, null, Hk.grid(ctx, 2, 10, cells), rightView = tag))
    }

    // ---- 她是谁
    private fun drawWho(): Unit = redraw(whoBox) {
        val quote = soul?.let { HomeModel.quoteOf(it) }
        addView(Hk.section(ctx, "她是谁", "性格 · 名片", { env.nav.go("identity") }, AshUi.card(ctx, 10).apply {
            setPadding(dp(18), dp(18), dp(18), dp(16))
            addView(AshUi.text(ctx, "“", AshType(40f, 40f, 700, null), c.herFill), Hk.lp(ctx, -2, -2).apply { bottomMargin = -dp(26) })
            addView(AshUi.text(ctx, if (!soulRead) "正在读取…" else quote?.ifEmpty { null } ?: "她的性格还没写下来。", AshType(15.5f, 26f, 400, Role.TEXT)))
            addView(AshUi.text(ctx, "想给她换个名字？直接跟她说。", AshTokens.Type.caption).apply { minHeight = dp(28); gravity = Gravity.CENTER_VERTICAL; isClickable = true; setOnClickListener { env.nav.compose("我想给你换个名字，以后叫你") } })
        }))
    }

    // ---- 她的文件
    private fun drawFiles(): Unit = redraw(filesBox) {
        val entries = files
        val shown = entries?.filter { it.str("type") != "directory" && !HomeModel.isSystemEntry(it.str("name") ?: "", false) }?.take(2) ?: emptyList()
        addView(Hk.section(ctx, "她的文件", "全部", { env.nav.go("files") },
            if (entries == null) Hk.note(ctx, "正在读取…") else if (shown.isNotEmpty()) Hk.list(ctx, shown.map { f ->
                Hk.row(ctx, "file", f.str("name") ?: "", f.num("size")?.let { HomeModel.sizeText(it) }, "you") { env.nav.go("files", f.str("name")) }
            }) else Hk.list(ctx, listOf(Hk.row(ctx, "file", "还没有文件", "她做出来的文档会放在这里") { env.nav.go("files") }))))
    }

    // ---- 幕后
    private fun drawBackstage(): Unit = redraw(backBox) {
        val k = keys
        val keyText = k?.let { if (it.first.isNotEmpty()) it.first else if (it.second.isNotEmpty()) "${it.second}还没设" else "已保存" } ?: ""
        val model = agents?.firstOrNull { it.optBoolean("primary") }?.optJSONObject("runtime")?.str("model")
        val week = usage?.optJSONObject("periods")?.optJSONObject("7d")?.dbl("cost_usd")
        fun tail(text: String, tone: String? = null) = AshUi.hstack(ctx, 6).apply { if (text.isNotEmpty()) addView(Hk.value(ctx, text, tone)); addView(Hk.chev(ctx)) }
        addView(AshUi.text(ctx, "幕后", AshType(13f, 19f, 600, Role.TEXT_2)).apply { setPadding(dp(4), 0, dp(4), 0) })
        addView(Hk.list(ctx, listOf(
            Hk.row(ctx, "key", "密钥", trailing = tail(keyText, if (k != null && (k.first.isNotEmpty() || k.second.isNotEmpty())) "warn" else null), chev = false) { env.nav.go("keys") },
            Hk.row(ctx, "cpu", "模型", trailing = tail(if (model != null) HomeModel.providerName(model) else provider), chev = false) { env.nav.go("model") },
            Hk.row(ctx, "coin", "花了多少", trailing = tail(week?.let { "近 7 天 ${HomeModel.usdToCny(it)}" } ?: ""), chev = false) { env.nav.go("usage") },
            Hk.row(ctx, "slider", "高级") { env.nav.go("advanced") })), Hk.lp(ctx, -1, -2, 10))
        addView(pause.root, Hk.lp(ctx, -1, -2, 10))
    }

    private fun drawAll() { drawHero(); drawWaiting(); drawUpcoming(); if (her) { drawMemory(); drawPromises(); drawHands(); drawWho(); drawFiles(); drawBackstage() } }

    private fun openCheckup(part: String?) {
        ctx.startActivity(Intent(ctx, ConsoleActivity::class.java).also { i -> part?.let { i.putExtra(ConsoleActivity.EXTRA_PART, it) } })
    }

    // ---- reading
    override fun refresh() { env.names.refresh(); readAll(); readCheckup(); pause.read() }
    override fun changed() { readCurrent(); countToday() }

    private fun readAll() {
        readCurrent(); countToday()
        call("service:cost", "usage.get", JSONObject().put("days", 7)) { r -> if (r.ok) { usage = r.data; drawHero(); drawBackstage() } }
        call("service:agents", "list") { r -> if (r.ok) { agents = r.data.list("agents").filter { it.str("id") != null }; drawHero(); drawBackstage() } }
        call("service:clock", "list") { r -> if (r.ok) HomeModel.normalizeClock(r.data)?.let { timers = HomeModel.userPlans(it); drawUpcoming() } }
        if (!her) return
        readFile("USER.md") { f -> if (f.ok) { memory = HomeModel.groupMemory(f.text); drawMemory() } }
        call("service:admin", "settings.get", JSONObject().put("keys", JSONArray().put(HomeModel.QUIET_KEY))) { r -> if (r.ok) HomeModel.quietOf(r.data.optJSONObject("settings"))?.let { quiet = it; quietRead = true; drawPromises() } }
        call("service:gate", "rules.list", JSONObject().put("limit", 100)) { r ->
            if (r.ok) {
                val now = System.currentTimeMillis()
                mode = r.data.str("mode")?.takeIf { it == "always" || it == "auto" }
                rules = r.data.list("rules").count { it.str("id") != null && it.num("revoked_at") == null && (it.num("expires_at") ?: 0) > now }
                drawPromises()
            }
        }
        readFile("PROACTIVE.md") { f -> if (f.ok) { proactive = f.text ?: ""; drawPromises() } }
        call("service:devices", "list") { r -> if (r.ok) { devices = r.data.list("devices").filter { it.str("device") != null && it.str("name") != null }; devicesRead = true; drawHands() } }
        call("service:devices", "pair_pending") { r -> if (r.ok) { pairsWaiting = r.data.list("pairs").count { it.str("state") == "requested" }; drawHands() } }
        call("service:apps", "apps.list") { r -> if (r.ok) { apps = r.data.list("apps"); drawHands() } }
        call("service:persona", "get", JSONObject().put("file", "SOUL.md")) { r -> if (r.ok) { soul = r.data.list("files").firstOrNull { it.str("file") == "SOUL.md" }?.str("content") ?: ""; soulRead = true; drawWho() } }
        call("body:main", "workspace.ls") { r -> if (r.ok) { files = r.data.list("entries").sortedBy { it.str("name") ?: "" }; drawFiles() } }
        call("service:vault", "list") { v ->
            if (!v.ok) return@call
            call("service:llm", "keys.status") { s ->
                val entries = v.data.list("entries"); val health = s.data.list("keys")
                fun saved(ref: String) = entries.any { it.str("ref") == ref && it.optBoolean("configured") }
                fun standing(ref: String) = health.firstOrNull { it.str("ref") == ref && it.optBoolean("configured") }?.str("status")
                val problem = HomeModel.KEYS.firstOrNull { saved(it.ref) && standing(it.ref) in listOf("rejected", "low_balance") }
                val missing = HomeModel.KEYS.firstOrNull { !saved(it.ref) }
                provider = if (saved("DEEPSEEK_API_KEY")) "DeepSeek" else ""
                keys = (problem?.let { "${it.title} ${if (standing(it.ref) == "rejected") "已失效" else "余额不足"}" } ?: "") to (missing?.let { if (it.provider == "deepseek") "对话" else "快速判断" } ?: "")
                drawBackstage()
            }
        }
    }

    private fun readCheckup() { Thread { val t = runCatching { Checkup.summary(ctx).todo }.getOrNull(); if (t != null) ctx.runOnUiThread { if (alive) { todo = t; drawHands() } } }.start() }

    private fun readCurrent() {
        call("service:history", "current", JSONObject().put("limit", 40).also { o -> agent?.let { o.put("agent", it) } }) { r -> if (r.ok) { current = r.data; drawHero(); drawWaiting() } }
    }

    private var counting = false; private var recount = false
    private fun countToday() {
        if (counting) { recount = true; return }
        counting = true
        val since = HomeModel.startOfDay(System.currentTimeMillis())
        call("service:history", "activity.page", JSONObject().put("limit", 1).put("since_ts", since).put("until_ts", since + HomeModel.DAY).also { o -> agent?.let { o.put("agent", it) } }) { r ->
            counting = false
            if (r.ok) r.data.num("total_count")?.let { todayCount = it; drawHero() }
            if (recount) { recount = false; countToday() }
        }
    }
}
