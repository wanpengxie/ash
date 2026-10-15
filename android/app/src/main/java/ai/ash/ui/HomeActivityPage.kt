package ai.ash.ui

import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.AshUi.Kind
import ai.ash.ui.design.Role
import org.json.JSONObject

/** 她做过的事: a timeline of her turns by day (a chip per day), the steps of a turn, and the background work as one row. */
class HmActivity(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "她做过的事"
    private val agent = arg ?: env.agent
    /** [failed]: the read did not work; it is not read again by itself (a draw must never ask again), only when the turn is opened anew. */
    private class StepPage(val steps: List<HomeModel.Step>, val raw: JSONObject, val loading: Boolean = false, val failed: Boolean = false)
    private class Detail(var open: Boolean = false, var text: String = "", var next: Long? = 0, var loading: Boolean = false)
    private var turns: List<HomeModel.Turn> = emptyList()
    private var page: JSONObject? = null
    private var loaded = false
    private var failed = false
    private val stepPages = HashMap<String, StepPage>()
    private val open = HashSet<String>()
    private val seen = HashSet<String>()
    private val details = HashMap<String, Detail>()
    private var day: Long? = null
    private var bgOpen = false
    private var loading = false
    private val names = HashMap<String, String>()
    private val chips = Hk.strip(ctx, 8, emptyList())
    private val timeline = AshUi.vstack(ctx)
    private val pages = AshUi.hstack(ctx, 8)

    init {
        body.addView(AshUi.vstack(ctx, 12).apply { addView(chips); addView(timeline); addView(pages) })
        every(5000) { if (turns.any { it.ended == null }) draw() }
        draw()
    }

    override fun refresh() {
        load(null)
        call("service:agents", "list") { r -> if (r.ok) { r.data.list("agents").forEach { a -> a.str("id")?.let { id -> names[id] = a.str("name") ?: "" } }; draw() } }
    }
    override fun changed() { load(page?.num("after")?.let { JSONObject().put("before", it + 1) }) }

    private fun load(params: JSONObject?) {
        if (loading) return
        loading = true
        val b = JSONObject().put("limit", 30).also { o -> agent?.let { o.put("agent", it) }; params?.keys()?.forEach { k -> o.put(k, params.get(k)) } }
        call("service:history", "activity.page", b) { r ->
            loading = false
            if (!r.ok) { if (!loaded) { failed = true; draw() }; return@call }
            page = r.data; loaded = true; failed = false
            turns = r.data.list("items").mapNotNull(HomeModel::turnOf)
            val ids = turns.map { it.id }.toSet()
            stepPages.keys.retainAll(ids); open.retainAll(ids); seen.retainAll(ids)
            draw()
        }
    }

    private fun loadSteps(id: String, params: JSONObject? = null) {
        call("service:history", "activity.page", JSONObject().put("turn", id).put("limit", 40).also { o -> params?.keys()?.forEach { k -> o.put(k, params.get(k)) } }) { r ->
            if (!r.ok) { if (stepPages[id]?.steps.isNullOrEmpty()) stepPages[id] = StepPage(emptyList(), JSONObject(), failed = true); draw(); return@call }
            if (turns.none { it.id == id }) return@call
            stepPages[id] = StepPage(HomeModel.stepsOf(r.data.list("items")), r.data)
            draw()
        }
    }

    private fun titleOf(t: HomeModel.Turn) = if (t.background) "${names[t.agent ?: ""]?.ifEmpty { null } ?: HomeModel.HELPER} 在后台工作" else t.title

    private fun tone(key: String) = when (key) { "running" -> "her"; "completed" -> "ok"; "error" -> "err"; else -> "3" }

    private fun dot(key: String): View = View(ctx).apply {
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            when (key) { "running" -> { setColor(0); setStroke(dp(2), c.herFill) }; "completed" -> setColor(c.okFill); "error" -> setColor(c.errFill); else -> setColor(c.text3) }
        }
        layoutParams = LinearLayout.LayoutParams(dp(10), dp(10)).apply { topMargin = dp(5) }
    }

    private fun stepRow(step: HomeModel.Step, turn: HomeModel.Turn, now: Long): View {
        val ended = turn.ended != null
        val waiting = step.state == "waiting_owner"
        val running = !waiting && ((step.state == "pending" && !ended) || step.state == "accepted")
        val lead: View = when {
            running || waiting -> AshUi.Spinner(ctx).apply { layoutParams = LinearLayout.LayoutParams(dp(12), dp(12)) }
            step.state == "failed" -> Hk.tint(ctx, "x", c.err, AshTokens.Size.iconXs)
            step.state == "ok" || step.summary -> Hk.tint(ctx, "check", c.ok, AshTokens.Size.iconXs)
            else -> Hk.tint(ctx, "alert", c.text3, AshTokens.Size.iconXs)
        }
        val tail: String? = when {
            waiting -> "还没执行"; step.state == "unconfirmed" -> "记录不完整"; step.state == "pending" && ended -> "结果未确认"
            step.tool && step.ts != null -> HomeModel.duration(maxOf(0L, (step.ended ?: turn.ended ?: now) - step.ts)); else -> null
        }
        val warn = waiting || step.state == "unconfirmed" || (step.state == "pending" && ended)
        return AshUi.vstack(ctx, 2).apply {
            addView(AshUi.hstack(ctx, 8).apply {
                addView(lead)
                addView(AshUi.text(ctx, if (waiting) "等你确认：${step.label}" else step.label.ifEmpty { "处理了一步" }, AshType(13f, 19f, 400, Role.TEXT)), LinearLayout.LayoutParams(0, -2, 1f))
                tail?.let { addView(AshUi.text(ctx, it, AshTokens.Type.caption, if (warn) c.warn else null)) }
            })
            if (!step.requestId.isNullOrEmpty()) addView(detail(step.requestId))
        }
    }

    private fun detail(id: String): View {
        val d = details.getOrPut(id) { Detail() }
        return AshUi.vstack(ctx, 4).apply {
            setPadding(dp(20), 0, 0, 0)
            addView(AshUi.text(ctx, if (d.open) "收起调用与结果" else "查看调用与结果", AshType(12f, 16f, 400, Role.TEXT_3)).apply {
                minHeight = dp(28); gravity = Gravity.CENTER_VERTICAL; isClickable = true
                setOnClickListener { d.open = !d.open; if (d.open && d.text.isEmpty()) loadDetail(id, d); draw() }
            })
            if (d.open) {
                if (d.text.isNotEmpty()) addView(Hk.pre(ctx, d.text))
                if (d.next != null && !d.loading && d.text.isNotEmpty()) addView(AshUi.button(ctx, "继续查看", Kind.GHOST, AshUi.BtnSize.SM) { loadDetail(id, d) })
                if (d.loading) addView(Hk.note(ctx, "正在读取…"))
                addView(AshUi.text(ctx, "敏感字段已隐藏；这里展示执行记录，不是审批按钮。", AshTokens.Type.caption))
            }
        }
    }

    private fun loadDetail(id: String, d: Detail) {
        val offset = d.next ?: return
        if (d.loading) return
        d.loading = true; draw()
        call("service:history", "activity", JSONObject().put("id", id).put("offset", offset)) { r ->
            d.loading = false
            if (r.ok) { d.text += r.data.list("items").mapNotNull { it.str("text") }.joinToString("\n"); d.next = r.data.num("next_offset") } else d.text += "\n详情暂时无法读取"
            draw()
        }
    }

    private fun turnView(turn: HomeModel.Turn, now: Long, askable: Boolean, latest: String?): View {
        val (key, label) = HomeModel.outcomeText(turn)
        val isOpen = turn.id in open || (turn.id !in seen && (key == "running" || turn.id == latest))
        val sp = stepPages[turn.id]
        if (isOpen && sp == null) { stepPages[turn.id] = StepPage(emptyList(), JSONObject(), true); loadSteps(turn.id) }
        val steps = sp?.steps ?: emptyList()
        val outcome = AshUi.text(ctx, label, AshTokens.Type.caption, Hk.strong(c, tone(key)))
        val bodyCol = AshUi.vstack(ctx, 6).apply {
            setPadding(0, 0, 0, dp(18))
            addView(AshUi.text(ctx, titleOf(turn), AshType(15f, 22f, 600, Role.INK)).apply {
                minHeight = dp(28); gravity = Gravity.CENTER_VERTICAL; isClickable = true
                setOnClickListener {
                    if (!open.remove(turn.id)) { open.add(turn.id); if (stepPages[turn.id]?.failed == true) stepPages.remove(turn.id) }
                    seen.add(turn.id); draw()
                }
            })
            if (isOpen && steps.isNotEmpty()) {
                addView(AshUi.vstack(ctx, 6).apply {
                    background = AshUi.rounded(c.surface, AshUi.dpF(ctx, 14f)); AshUi.cardShadow(this); setPadding(dp(12), dp(10), dp(12), dp(10))
                    steps.forEach { addView(stepRow(it, turn, now)) }
                })
            }
            if (isOpen && sp?.failed == true) addView(Hk.note(ctx, "步骤暂时读不到，收起再展开可以重试"))
            addView(outcome)
            if (isOpen && sp?.raw?.optBoolean("has_more_before") == true) addView(AshUi.button(ctx, "更早的步骤", Kind.GHOST, AshUi.BtnSize.SM) { loadSteps(turn.id, JSONObject().put("before", sp?.raw?.num("before"))) })
            if (isOpen && sp?.raw?.optBoolean("has_more_after") == true) addView(AshUi.button(ctx, "更新的步骤", Kind.GHOST, AshUi.BtnSize.SM) { loadSteps(turn.id, JSONObject().put("after", sp?.raw?.num("after"))) })
            if (isOpen && askable) addView(AshUi.hstack(ctx, 6).apply {
                addView(Hk.tint(ctx, "chat", c.youText, AshTokens.Size.iconXs)); addView(Hk.link(ctx, "问问她这件事") { env.nav.compose("关于${turn.title.ifEmpty { "这件事" }}，", turn.id) })
            })
            if (isOpen && turn.messageId != null) addView(Hk.link(ctx, "查看对话 ›") { env.nav.jump(turn.messageId) })
        }
        return AshUi.hstack(ctx, 12).apply {
            gravity = Gravity.TOP
            addView(AshUi.text(ctx, HomeModel.hhmm(turn.started), AshTokens.Type.caption).apply { gravity = Gravity.END; setPadding(0, dp(3), 0, 0) }, LinearLayout.LayoutParams(dp(38), -2))
            addView(AshUi.vstack(ctx).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                addView(dot(key)); addView(View(ctx).apply { setBackgroundColor(c.line) }, LinearLayout.LayoutParams(maxOf(1, dp(1.5f)), 0, 1f))
            }, LinearLayout.LayoutParams(-2, -1))
            addView(bodyCol, LinearLayout.LayoutParams(0, -2, 1f))
        }
    }

    private fun dp(v: Float) = AshUi.dp(ctx, v)

    private fun draw() {
        val now = System.currentTimeMillis()
        val days = HomeModel.activityByDay(turns)
        val row = chips.getChildAt(0) as LinearLayout
        row.removeAllViews(); timeline.removeAllViews(); pages.removeAllViews()
        if (!loaded) {
            timeline.addView(Hk.note(ctx, if (failed) "暂时读不到活动记录（不代表没有）。" else "正在读取…", if (failed) "warn" else null))
            if (failed) timeline.addView(AshUi.button(ctx, "重试", Kind.NEUTRAL, AshUi.BtnSize.SM) { failed = false; draw(); load(null) })
            return
        }
        if (days.isEmpty()) { timeline.addView(Hk.note(ctx, "还没有活动记录。她做过的事会按天出现在这里。")); }
        else {
            if (day == null || days.none { it.day == day }) day = days[0].day
            val latest = days.firstOrNull { it.day == day }?.front?.firstOrNull()?.id ?: days[0].front.firstOrNull()?.id
            days.take(14).forEach { d ->
                val on = d.day == day
                row.addView(AshUi.text(ctx, "${HomeModel.dayLabel(d.day, now)} · ${d.front.size + d.back.size}", AshType(13.5f, 18f, if (on) 600 else 400, null), if (on) c.onInk else c.text2).apply {
                    gravity = Gravity.CENTER; setPadding(dp(14), 0, dp(14), 0); minHeight = dp(AshTokens.Size.segH - 4)
                    background = AshUi.rounded(if (on) c.ink else c.surface2, AshUi.dpF(ctx, 17f))
                    isClickable = true; setOnClickListener { day = d.day; draw() }
                })
            }
            val sel = days.first { it.day == day }
            sel.front.forEach { timeline.addView(turnView(it, now, true, latest)) }
            if (sel.back.isNotEmpty()) {
                val shownNames = sel.back.map { titleOf(it) }.distinct().take(2).joinToString(" · ")
                timeline.addView(AshUi.hstack(ctx, 10).apply {
                    background = AshUi.rounded(c.herSoft, AshUi.dpF(ctx, 16f)); setPadding(dp(14), dp(12), dp(14), dp(12)); isClickable = true
                    setOnClickListener { bgOpen = !bgOpen; draw() }
                    addView(Hk.tint(ctx, "moon", c.her, AshTokens.Size.iconSm))
                    addView(AshUi.vstack(ctx).apply { addView(AshUi.text(ctx, "后台做的 ${sel.back.size} 件", AshType(14f, 20f, 600, Role.INK))); addView(AshUi.text(ctx, shownNames, AshTokens.Type.caption)) }, LinearLayout.LayoutParams(0, -2, 1f))
                    addView(Hk.tint(ctx, if (bgOpen) "up" else "down", c.text3, AshTokens.Size.iconSm))
                }, Hk.lp(ctx, -1, -2, 4))
                if (bgOpen) timeline.addView(AshUi.vstack(ctx).apply { setPadding(0, dp(14), 0, 0); sel.back.forEach { addView(turnView(it, now, false, latest)) } })
            }
        }
        if (page?.optBoolean("has_more_before") == true) pages.addView(AshUi.button(ctx, "更早的记录", Kind.GHOST, AshUi.BtnSize.SM) { load(JSONObject().put("before", page?.num("before"))) })
        if (page?.optBoolean("has_more_after") == true) pages.addView(AshUi.button(ctx, "更新的记录", Kind.GHOST, AshUi.BtnSize.SM) { load(JSONObject().put("after", page?.num("after"))) })
    }
}
