package ai.ash.ui

import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.AshUi.Kind
import ai.ash.ui.design.AshUi.Tone
import ai.ash.ui.design.Role
import org.json.JSONObject
import java.util.UUID

/** 等你的: the approvals and questions waiting for you, drawn as the same cards as in the conversation, and the decisions made lately. */
class HmWaiting(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "等你的"
    private val agent = arg ?: env.agent
    private var page: JSONObject? = null
    private var history: List<JSONObject>? = null
    private var loading = false
    /** The last read failed: what is shown is from before it (or nothing was ever read). */
    private var failed = false
    private val cards = AshUi.vstack(ctx, 14)
    private val paging = AshUi.hstack(ctx, 8)
    private val settledBox = AshUi.vstack(ctx)
    private val originals = HashMap<String, String>()   // ask id -> the full original, once read
    private val open = HashSet<String>()                // ask ids whose original is showing

    init { body.addView(cards); body.addView(paging); body.addView(settledBox); draw() }

    private fun asks(): List<HomeModel.Ask> = page?.list("items")?.mapNotNull { it.optJSONObject("ask")?.let(HomeModel::askOf) } ?: emptyList()

    override fun refresh() {
        load(null)
        call("service:gate", "history", JSONObject().put("limit", 100)) { r ->
            if (r.ok) { history = r.data.list("items").filter(HomeModel::validDecision).sortedByDescending { it.num("at") ?: 0 }; drawSettled() }
        }
    }
    override fun changed() { load(page?.num("after")?.let { JSONObject().put("before", it + 1) }) }

    private fun load(params: JSONObject?) {
        if (loading) return
        loading = true
        val b = JSONObject().put("limit", 40).also { o -> agent?.let { o.put("agent", it) }; params?.keys()?.forEach { k -> o.put(k, params.get(k)) } }
        call("service:history", "current", b) { r ->
            loading = false
            failed = !r.ok
            if (r.ok) { page = r.data; env.intents.answers.keys.retainAll(asks().map { it.id }.toSet()) }
            draw()
        }
    }

    private fun draw() {
        val items = HomeModel.waitingItems(asks()).filter { agent == null || it.ask.from == agent }
        wake("expiry", items.minOfOrNull { it.ask.expiresAt }) { draw() }
        cards.removeAllViews()
        // Only a successful read that is empty says there is nothing; before it, it is being read; a failure says so (§3.2).
        if (failed) cards.addView(Hk.note(ctx, if (page == null) "没读到要你决定的事，稍后再试。" else "没读到最新的，下面是上次读到的。"))
        if (items.isEmpty()) cards.addView(when {
            page == null && !failed -> Hk.note(ctx, "正在读取…")
            page == null -> View(ctx)
            else -> Hk.list(ctx, listOf(Hk.row(ctx, "check", "现在没有要你决定的事", "有事她会叫你", "ok")))
        })
        else items.forEach { cards.addView(card(it)) }
        paging.removeAllViews()
        if (page?.optBoolean("has_more_before") == true) paging.addView(AshUi.button(ctx, "更早的问题", Kind.GHOST, AshUi.BtnSize.SM) { load(JSONObject().put("before", page?.num("before"))) })
        if (page?.optBoolean("has_more_after") == true) paging.addView(AshUi.button(ctx, "更新的问题", Kind.GHOST, AshUi.BtnSize.SM) { load(JSONObject().put("after", page?.num("after"))) })
    }

    private fun drawSettled() {
        settledBox.removeAllViews()
        val h = history ?: return
        if (h.isEmpty()) return
        settledBox.addView(Hk.list(ctx, listOf(Hk.row(ctx, "check", "最近处理过 ${h.size} 件", "最近一件：${HomeModel.decisionText(h[0])}", "ok") { env.nav.go("settled") })))
    }

    /** The owner's answer: a gate approval through the gate's checks, anything else as a plain answer. */
    private fun answer(ask: HomeModel.Ask, choice: String, text: String?) {
        val fresh = asks().firstOrNull { it.id == ask.id }
        if (fresh == null || fresh.seq != ask.seq || fresh.state != "pending") return
        val old = env.intents.answers[ask.id]
        if (old != null && (old.choice != choice || old.text != text || old.status in listOf("pending", "confirmed", "rejected"))) return
        val custom = fresh.allowCustom && choice == "custom" && !text.isNullOrBlank()
        val valid = if (fresh.from == HomeModel.GATE) HomeModel.approvals(listOf(fresh)).firstOrNull()?.options?.any { it.id == choice } == true || (custom && fresh.humanKind == "question")
            else custom || fresh.options.any { it.id == choice }
        if (!valid) return
        val intent = old?.also { it.status = "pending" } ?: HomeIntents.Answer(choice, text, UUID.randomUUID().toString(), "pending").also { env.intents.answers[ask.id] = it }
        draw()
        val data = JSONObject().put("choice", if (custom) "custom" else choice).also { if (custom) it.put("text", text) }
        env.port.send(JSONObject().put("to", fresh.from).put("kind", "response").put("word", "ask").put("reply_to", fresh.id)
            .put("body", JSONObject().put("ok", true).put("result", JSONObject().put("data", data))).put("client_id", intent.clientId)) { r ->
            if (!alive) return@send
            val code = r.optJSONObject("error")?.str("code")
            intent.status = if (r.optBoolean("ok")) "confirmed" else if (code in setOf("offline", "unavailable", "timeout", "result_unknown", "internal")) "uncertain" else "rejected"
            draw()
        }
    }

    private fun card(w: HomeModel.Waiting): View {
        val a = w.ask
        val now = System.currentTimeMillis()
        val state = env.intents.answers[a.id]
        return AshUi.card(ctx).apply {
            addView(AshUi.cardHeader(ctx, if (w.approval) Tone.WARN else Tone.HER, Hk.icon(ctx, if (w.approval) "shield" else "ask"), if (w.approval) "需要你确认" else "她问你",
                if (w.approval) "${HomeModel.dayTime(a.expiresAt, now)} 前有效" else HomeModel.ago(a.ts, now)))
            addView(AshUi.text(ctx, a.title, AshType(16f, 23f, 600, Role.INK)))
            if (a.detail.isNotEmpty()) addView(AshUi.text(ctx, a.detail, AshTokens.Type.callout))
            addView(AshUi.hstack(ctx, 12).apply {
                addView(Hk.link(ctx, "查看对话 ›") { env.nav.jump(a.id) })
                if (w.approval && a.original != null) addView(Hk.link(ctx, if (a.id in open) "收起原文" else "查看完整原文 ›") { if (!open.add(a.id)) open.remove(a.id); draw(); if (a.id in open) readOriginal(a) })
            })
            if (w.approval && a.original != null && a.id in open) addView(Hk.pre(ctx, originals[a.id] ?: a.original))
            if (state?.status == "confirmed") {
                addView(AshUi.resolved(ctx, "已收到你的回答", ok = true))
                addView(AshUi.text(ctx, "事情本身做没做完，看她接下来的消息。", AshTokens.Type.caption))
                return@apply
            }
            val busy = state?.status == "pending" || state?.status == "rejected"
            if (w.approval) {
                fun by(id: String) = a.options.firstOrNull { it.id == id }
                fun btn(o: HomeModel.Opt?, kind: Kind, block: Boolean = false): View? = o?.let {
                    AshUi.button(ctx, it.label, kind, if (block) AshUi.BtnSize.MD else AshUi.BtnSize.MD, block) { answer(a, it.id, null) }.also { b -> if (busy || (state != null && state.choice != it.id)) AshUi.disable(b) }
                }
                btn(by("once"), Kind.PRIMARY, true)?.let { addView(it) }
                addView(AshUi.hstack(ctx, 8).apply {
                    btn(by("always"), Kind.SECONDARY)?.let { addView(it, LinearLayout.LayoutParams(0, -2, 1f)) }
                    btn(by("deny"), Kind.NEUTRAL)?.let { addView(it, LinearLayout.LayoutParams(0, -2, 1f)) }
                })
            } else {
                a.options.forEach { o ->
                    val picked = state?.choice == o.id
                    addView(AshUi.option(ctx, o.label, selected = picked, dimmed = state?.choice != null && !picked, onClick = if (busy) null else ({ answer(a, o.id, null) })))
                }
                if (a.allowCustom) {
                    val input = Hk.field(ctx, "自己说…")
                    addView(AshUi.hstack(ctx, 8).apply {
                        addView(input, LinearLayout.LayoutParams(0, -2, 1f))
                        addView(AshUi.button(ctx, "发送", Kind.SECONDARY, AshUi.BtnSize.SM) { input.text.toString().trim().takeIf { it.isNotEmpty() }?.let { answer(a, "custom", it) } }.also { if (busy) AshUi.disable(it) })
                    })
                }
            }
            when (state?.status) {
                "pending" -> addView(AshUi.text(ctx, "正在送出你的回答…", AshTokens.Type.caption))
                "uncertain" -> addView(AshUi.text(ctx, "还没确认你的回答送到了。再点一次「${a.options.firstOrNull { it.id == state.choice }?.label ?: "同一个选项"}」会原样重试。", AshTokens.Type.caption, c.warn))
                "rejected" -> addView(AshUi.text(ctx, "这次回答没有被接受；它可能已经过期，或这台设备不能回答。", AshTokens.Type.caption, c.warn))
            }
        }
    }

    /** The unabridged request, read in pieces from the blob store when it is opened. */
    private fun readOriginal(a: HomeModel.Ask) {
        val hash = a.originalFull ?: return
        if (originals.containsKey(a.id)) return
        fun piece(offset: Long, text: String, count: Int) {
            call("service:blobs", "read", JSONObject().put("hash", hash).put("offset", offset)) { r ->
                if (!r.ok) { originals[a.id] = "完整文字暂时无法读取，请收起后再试。"; draw(); return@call }
                val acc = text + (r.data.str("text") ?: "")
                val next = r.data.num("next_offset")
                if (next == null || count > 200) { originals[a.id] = acc; draw() } else piece(next, acc, count + 1)
            }
        }
        piece(0, "", 0)
    }
}

/** 处理过的事: the decisions made lately, newest first; 「查看依据」 opens what the gate saw and said. */
class HmSettled(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "处理过的事"
    private var items: List<JSONObject>? = null
    private var failed = false
    private class Ev(val status: String, val rows: List<Pair<String, String>> = emptyList())
    private val evidence = HashMap<String, Ev>()
    init { body.addView(Hk.note(ctx, "正在读取…")) }

    override fun refresh() = call("service:gate", "history", JSONObject().put("limit", 100)) { r ->
        failed = !r.ok
        if (r.ok) items = r.data.list("items").filter(HomeModel::validDecision).sortedByDescending { it.num("at") ?: 0 }
        draw()
    }

    private fun draw(): Unit = redraw {
        val list = items
        if (failed || list == null) { addView(Hk.note(ctx, "暂时读不到审批记录（不代表没有）。", "warn")); return@redraw }
        if (list.isEmpty()) { addView(Hk.list(ctx, listOf(Hk.row(ctx, "check", "还没有审批记录")))); return@redraw }
        val now = System.currentTimeMillis()
        val rows = list.take(40).map { item ->
            val id = item.str("request_id")
            val shown = id?.let { evidence[it] }
            val deny = item.str("decision") == "deny"
            val row = Hk.row(ctx, if (deny) "x" else "check", HomeModel.itemLabel(item), "${HomeModel.VERB[item.str("decision")] ?: "已记录"} · ${HomeModel.dayTime(item.num("at") ?: 0, now)}",
                if (deny) "err" else "ok", trailing = id?.let { Hk.link(ctx, if (shown != null) "收起" else "查看依据") { toggle(it) } }, chev = false)
            if (shown == null) return@map row
            AshUi.vstack(ctx).apply {
                addView(row)
                addView(AshUi.vstack(ctx, 8).apply {
                    setPadding(dp(54), 0, dp(14), dp(12))
                    when (shown.status) {
                        "loading" -> addView(Hk.note(ctx, "正在读取…"))
                        "missing" -> addView(Hk.note(ctx, "这条没有留下依据（多半是证据记录上线之前的）。"))
                        "failed" -> addView(Hk.note(ctx, "暂时读不到依据（不代表没有），稍后再点一次。", "warn"))
                        else -> addView(AshUi.vstack(ctx, 8).apply {
                            background = AshUi.rounded(c.surface2, AshUi.dpF(ctx, 12f)); setPadding(dp(12), dp(12), dp(12), dp(12))
                            shown.rows.forEach { (label, value) -> addView(AshUi.vstack(ctx, 2).apply { addView(AshUi.text(ctx, label, AshType(12f, 16f, 400, Role.TEXT_3))); addView(AshUi.text(ctx, value, AshType(13.5f, 20f, 400, Role.TEXT)).apply { setTextIsSelectable(true) }) }) }
                        })
                    }
                })
            }
        }
        addView(Hk.section(ctx, "最近的决定", null, null, Hk.list(ctx, rows)))
    }

    private fun toggle(id: String) {
        if (evidence.remove(id) != null) { draw(); return }
        evidence[id] = Ev("loading"); draw()
        call("service:gate", "audit", JSONObject().put("request_id", id).put("limit", 1)) { r ->
            if (!evidence.containsKey(id)) return@call
            val entry = if (r.ok) r.data.list("entries").firstOrNull { it.str("request_id") == id } else null
            evidence[id] = when { !r.ok -> Ev("failed"); entry == null -> Ev("missing"); else -> Ev("ready", HomeModel.evidence(entry, System.currentTimeMillis(), env.names.name, env.port.primary)) }
            draw()
        }
    }
}
