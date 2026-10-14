package ai.ash.ui

import ai.ash.R
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi
import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.text.method.LinkMovementMethod
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.util.UUID

/**
 * 「Codex」: the Codex app on the owner's computer, seen and driven from the phone. A list of its sessions (the running ones
 * marked); a session opens to what it did, a box to say something to it, a button to stop the turn, and the approvals it is
 * waiting for, to approve or refuse where they stand. The sessions stay in the Codex app on the computer; this reads them and
 * sends words, through [port] as the owner (`x.codex.*` on the computer), and keeps nothing of its own. [view] goes into the
 * home screen's content area; call [shown] as it comes and goes, [back] for the back key (false: go to the chat).
 */
class CodexPane(private val activity: Activity, private val port: HumanPort, private val toChat: () -> Unit) {
    val view = FrameLayout(activity)
    private val c = AshUi.p(activity)
    private val main = Handler(Looper.getMainLooper())
    private fun d(v: Int) = AshUi.dp(activity, v)

    private val title = AshUi.text(activity, "Codex", AshTokens.Type.listTitle)
    private val stop = AshUi.iconButton(activity, activity.getDrawable(R.drawable.ash_ic_stop)!!, "停止这一轮") { stopTurn() }.apply { visibility = View.GONE }
    private val content = AshUi.vstack(activity, 10).apply { setPadding(d(14), d(4), d(14), d(16)) }
    private val scroll = ScrollView(activity).apply { isFillViewport = true; addView(content, FrameLayout.LayoutParams(-1, -2)) }
    private val input = EditText(activity)
    private val composer = composer()

    /** The computer's id (`device:…`), once found. */
    private var device: String? = null
    private var sessions: List<CodexModel.Session>? = null
    private var detailId: String? = null
    private var detail: CodexModel.Detail? = null
    private var note: String? = null
    private var loading = false
    private var busy = false
    private var shown = false
    private var closed = false
    private val tick = object : Runnable {
        override fun run() { if (!shown || closed) return; refresh(); main.postDelayed(this, if (detailId != null) 2_500 else 4_000) }
    }

    init {
        val column = AshUi.vstack(activity)
        column.addView(AshUi.hstack(activity, 6).apply {
            gravity = Gravity.CENTER_VERTICAL; setPadding(d(6), 0, d(6), 0)
            addView(AshUi.iconButton(activity, activity.getDrawable(R.drawable.ash_ic_back)!!, "返回") { if (!back()) toChat() })
            addView(title, LinearLayout.LayoutParams(0, -2, 1f))
            addView(stop)
        }, LinearLayout.LayoutParams(-1, d(56)))
        column.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        column.addView(composer, LinearLayout.LayoutParams(-1, -2))
        view.addView(column, FrameLayout.LayoutParams(-1, -1))
        render()
    }

    fun close() { closed = true; main.removeCallbacksAndMessages(null) }

    /** The page comes to the front or goes: it reads again at once, and then every few seconds while it is there. */
    fun shown(visible: Boolean) {
        shown = visible
        main.removeCallbacks(tick)
        if (visible && !closed) { refresh(); main.postDelayed(tick, 3_000) }
    }

    /** The back key: from a session to the list; false when the list itself is showing. */
    fun back(): Boolean {
        if (detailId == null) return false
        detailId = null; detail = null; note = null; stop.visibility = View.GONE
        render(); refresh()
        return true
    }

    // ---- reading ----

    private fun refresh() {
        if (loading || closed) return
        if (!port.open) { note = "还没连上 Ash"; render(); return }
        val dev = device
        if (dev == null) {
            loading = true
            port.call("service:devices", "list") { data, failure ->
                loading = false
                device = CodexModel.computer(data)
                if (device == null) { sessions = null; note = failure?.let { CodexModel.unreachable(it.code) } ?: "没有在线的电脑。电脑上的 Ash 连上以后，这里就能看到 Codex。"; render() }
                else refresh()
            }
            return
        }
        loading = true
        val id = detailId
        val done: (JSONObject?, HumanPort.Failure?) -> Unit = { data, failure ->
            loading = false
            when {
                failure != null -> { device = null; note = CodexModel.unreachable(failure.code); if (id == null) sessions = null }
                id == null -> { sessions = CodexModel.sessions(data); note = null }
                id == detailId -> { detail = CodexModel.detail(data); note = null }
            }
            render()
        }
        if (id == null) port.call(dev, CodexModel.SESSIONS, JSONObject().put("limit", 50), done)
        else port.call(dev, CodexModel.SESSION, JSONObject().put("thread", id).put("turns", 8).put("max_chars", 1200), done)
    }

    private fun open(s: CodexModel.Session) {
        detailId = s.id; detail = null; note = null; title.text = s.title
        render(); refresh()
    }

    // ---- acting ----

    private fun say(text: String) {
        val dev = device ?: return
        val id = detailId ?: return
        if (busy) return
        busy = true
        port.call(dev, CodexModel.SEND, JSONObject().put("thread", id).put("text", text).put("client_id", UUID.randomUUID().toString())) { _, failure ->
            busy = false
            if (failure != null) { toast(CodexModel.failure(failure.code, failure.message)); input.setText(text) }
            else main.postDelayed({ refresh() }, 600)
        }
        input.setText("")
    }

    private fun stopTurn() {
        val dev = device ?: return
        val id = detailId ?: return
        port.call(dev, CodexModel.STOP, JSONObject().put("thread", id)) { _, failure ->
            if (failure != null) toast(CodexModel.failure(failure.code, failure.message)) else main.postDelayed({ refresh() }, 600)
        }
    }

    private fun answer(a: CodexModel.Approval, decision: String) {
        val dev = device ?: return
        val id = detailId ?: return
        if (busy) return
        busy = true
        port.call(dev, CodexModel.APPROVE, JSONObject().put("thread", id).put("request_id", a.requestId).put("decision", decision)) { _, failure ->
            busy = false
            if (failure != null) toast(CodexModel.failure(failure.code, failure.message))
            refresh()
        }
    }

    private fun toast(s: String) = Toast.makeText(activity, s, Toast.LENGTH_SHORT).show()

    // ---- drawing ----

    private fun composer(): View = AshUi.hstack(activity, 8).apply {
        gravity = Gravity.BOTTOM; visibility = View.GONE
        setPadding(d(12), d(4), d(12), d(10))
        input.apply {
            hint = "跟 Codex 说…"
            AshUi.style(this, AshTokens.Type.chat, c.text)
            setHintTextColor(c.text3)
            background = AshUi.rounded(c.surface, AshUi.dpF(activity, 20f), c.line, d(1))
            setPadding(d(14), d(10), d(14), d(10))
            minHeight = d(44); maxLines = 6
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
        }
        addView(input, LinearLayout.LayoutParams(0, -2, 1f))
        addView(AshUi.iconButton(activity, activity.getDrawable(R.drawable.ash_ic_up)!!, "发送", filled = true) {
            val t = input.text.toString().trim()
            if (t.isNotEmpty()) say(t)
        })
    }

    private fun render() {
        if (closed) return
        val inDetail = detailId != null
        val atBottom = content.height - (scroll.height + scroll.scrollY) < d(80)
        content.removeAllViews()
        composer.visibility = if (inDetail) View.VISIBLE else View.GONE
        if (!inDetail) { title.text = "Codex"; stop.visibility = View.GONE }
        note?.let { content.addView(AshUi.text(activity, it, AshTokens.Type.callout, c.text2).apply { gravity = Gravity.CENTER; setPadding(d(8), d(24), d(8), d(8)) }) }
        if (inDetail) drawDetail(atBottom || detail == null) else drawList()
    }

    private fun drawList() {
        val list = sessions ?: run { if (note == null) content.addView(hint("正在读取…")); return }
        if (list.isEmpty()) { content.addView(hint("Codex 里还没有会话")); return }
        val now = System.currentTimeMillis()
        content.addView(AshUi.group(activity, rows = list.map { s ->
            val tone = when { s.waiting -> AshUi.Tone.WARN; s.running -> AshUi.Tone.OK; else -> AshUi.Tone.MUTE }
            AshUi.row(activity, s.title, CodexModel.subtitle(s, now).ifEmpty { null }, null, AshUi.Tone.MUTE,
                trailing = AshUi.tag(activity, CodexModel.stateLabel(s), tone, dot = s.running)) { open(s) }
        }, iconInset = false))
    }

    private fun drawDetail(toBottom: Boolean) {
        val dt = detail
        if (dt == null) { if (note == null) content.addView(hint("正在读取…")); return }
        title.text = dt.session.title
        stop.visibility = if (dt.session.running || dt.session.waiting) View.VISIBLE else View.GONE
        input.hint = if (dt.session.open) "跟 Codex 说…" else "跟 Codex 说…（会先在电脑上打开这个会话）"
        for (turn in dt.turns) for (item in turn.items) item(item)?.let { content.addView(it, side(item.kind == "user")) }
        if (dt.session.running && dt.approvals.isEmpty()) content.addView(AshUi.text(activity, "在做事…", AshTokens.Type.caption, c.text3), side(false))
        for (a in dt.approvals) content.addView(approvalCard(a))
        if (dt.turns.isEmpty() && dt.approvals.isEmpty()) content.addView(hint("这个会话还没有内容"))
        if (toBottom) scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun side(mine: Boolean) = LinearLayout.LayoutParams(-2, -2).apply { gravity = if (mine) Gravity.END else Gravity.START }

    private fun hint(s: String): View = AshUi.text(activity, s, AshTokens.Type.callout, c.text3).apply { gravity = Gravity.CENTER; setPadding(d(8), d(24), d(8), d(8)) }

    private fun item(i: CodexModel.Item): View? = when (i.kind) {
        "user" -> if (i.text.isBlank()) null else AshUi.bubbleText(activity, i.text, true).apply { setTextIsSelectable(true) }
        "agent" -> if (i.text.isBlank()) null else AshUi.bubbleText(activity, Md.render(i.text, c.surface2, c.her), false).apply { setTextIsSelectable(true); movementMethod = LinkMovementMethod.getInstance() }
        "thinking" -> null
        else -> AshUi.text(activity, "▸ " + toolLabel(i), AshTokens.Type.caption, c.text3, maxLines = 2)
    }

    private fun toolLabel(i: CodexModel.Item): String {
        val verb = when (i.kind) { "command" -> "运行"; "file" -> "改文件"; "tool" -> "调用"; "search" -> "搜索"; "plan" -> "计划"; else -> i.kind }
        return if (i.text.isBlank()) verb else "$verb ${i.text}"
    }

    private fun approvalCard(a: CodexModel.Approval): View = AshUi.card(activity).apply {
        addView(AshUi.cardHeader(activity, AshUi.Tone.WARN, activity.getDrawable(R.drawable.ash_ic_shield)!!, "Codex 等你批准"))
        addView(AshUi.text(activity, a.summary.ifEmpty { "一个请求" }, AshTokens.Type.body, c.text, maxLines = 8))
        addView(AshUi.hstack(activity, 8).apply {
            addView(AshUi.button(activity, "批准", AshUi.Kind.PRIMARY, AshUi.BtnSize.SM) { answer(a, "approve") })
            addView(AshUi.button(activity, "拒绝", AshUi.Kind.NEUTRAL, AshUi.BtnSize.SM) { answer(a, "deny") })
        })
    }
}
