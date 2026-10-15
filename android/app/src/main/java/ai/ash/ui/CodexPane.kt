package ai.ash.ui

import ai.ash.R
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi
import android.app.Activity
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.text.method.LinkMovementMethod
import android.view.Gravity
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.Toast
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import org.json.JSONObject
import java.util.UUID

/**
 * 「Codex」: the Codex app on the owner's computer, seen and driven from the phone. A list of its sessions (the running ones
 * marked); a session opens to what it did, a box to say something to it, a button to stop the turn, and the approvals it is
 * waiting for, to approve or refuse where they stand. The sessions stay in the Codex app on the computer; this reads them and
 * sends words, through [port] as the owner (`x.codex.*` on the computer), and keeps nothing of its own but the owner's drafts.
 *
 * Built as the chat is (MOBILE-ARCH §2, §4.4): a fixed header, and under it a clipped stage whose deck — the lists and the
 * box — rides the keyboard; the sessions and a session's turns are keyed lists updated row by row, so a poll that changes
 * one thing redraws that one thing and never the box being typed in. What it reads is held in [CodexState]. [view] goes into
 * the home screen's content area; call [shown] as it comes and goes, [back] for the back key (false: go to the chat).
 */
class CodexPane(private val activity: Activity, private val port: HumanPort, saved: Bundle? = null, private val toChat: () -> Unit) : KeyboardDeck {
    val view = FrameLayout(activity)
    private val c = AshUi.p(activity)
    private val main = Handler(Looper.getMainLooper())
    private fun d(v: Int) = AshUi.dp(activity, v)

    private val state = CodexState()
    private val drafts = UiDrafts.get(activity)
    /** What the owner sent from here that the session does not show yet. */
    private var sends: List<CodexSend> = emptyList()
    /** Approvals being answered (their buttons wait). */
    private val answering = HashSet<String>()
    private var creating = false
    private var loading = false
    private var readAgain = false
    private var shown = false
    private var closed = false
    private var restoring = false
    /** The route changed (a session opened or closed): the activity offers back to this page only inside a session. */
    var onRouteChange: (() -> Unit)? = null

    private val title = AshUi.text(activity, "Codex", AshTokens.Type.listTitle)
    private val stop = AshUi.iconButton(activity, activity.getDrawable(R.drawable.ash_ic_stop)!!, "停止这一轮") { stopTurn() }.apply { visibility = View.GONE }
    private val input = EditText(activity)
    private val sendButton = AshUi.iconButton(activity, activity.getDrawable(R.drawable.ash_ic_up)!!, "发送", filled = true) { sendTapped() }
    private val composer = composer()

    private val sessionRows = KeyedRowsAdapter(activity)
    private val sessionLm = LinearLayoutManager(activity)
    private val sessionList = RecyclerView(activity).apply {
        layoutManager = sessionLm; adapter = sessionRows; itemAnimator = null
        setPadding(d(14), 0, d(14), d(16)); clipToPadding = false
        addItemDecoration(gap(10))
    }
    private val talkRows = KeyedRowsAdapter(activity)
    private val talkLm = LinearLayoutManager(activity).apply { stackFromEnd = true }
    private val talkList = RecyclerView(activity).apply {
        layoutManager = talkLm; adapter = talkRows
        setPadding(d(14), 0, d(14), d(12)); clipToPadding = false
        addItemDecoration(gap(10))
        // A drag of the session puts the keyboard away; its own scrolling never does (§4.3).
        addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrollStateChanged(rv: RecyclerView, s: Int) { if (s == RecyclerView.SCROLL_STATE_DRAGGING) dropKeyboard() }
        })
    }
    /** Why the last read failed, floating over the top of the lists (their top padding keeps clear of it; §1.2). */
    private val problemLine = AshUi.text(activity, "", AshTokens.Type.callout, c.text2).apply {
        gravity = Gravity.CENTER; setPadding(d(14), d(6), d(14), d(6)); setBackgroundColor(c.bg); visibility = View.GONE
        addOnLayoutChangeListener { _, _, t, _, b, _, _, _, _ -> keepClear(if (visibility == View.VISIBLE) b - t else 0) }
    }
    private val deck = AshUi.vstack(activity, 0)

    private val tick = object : Runnable {
        override fun run() { if (!shown || closed) return; refresh(); main.postDelayed(this, if (state.thread != null) 2_500 else 4_000) }
    }

    init {
        val column = AshUi.vstack(activity)
        column.addView(AshUi.hstack(activity, 6).apply {
            gravity = Gravity.CENTER_VERTICAL; setPadding(d(6), 0, d(6), 0)
            addView(AshUi.iconButton(activity, activity.getDrawable(R.drawable.ash_ic_back)!!, "返回") { if (!back()) toChat() })
            addView(title, LinearLayout.LayoutParams(0, -2, 1f))
            addView(stop)
        }, LinearLayout.LayoutParams(-1, d(56)))
        val lists = FrameLayout(activity).apply {
            addView(sessionList, FrameLayout.LayoutParams(-1, -1))
            addView(talkList, FrameLayout.LayoutParams(-1, -1))
            addView(problemLine, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
        }
        deck.addView(lists, LinearLayout.LayoutParams(-1, 0, 1f))
        deck.addView(composer, LinearLayout.LayoutParams(-1, -2))
        // The header stays; the stage under it clips the deck as the keyboard moves it up.
        val stage = FrameLayout(activity).apply { clipChildren = true; addView(deck, FrameLayout.LayoutParams(-1, -1)) }
        column.addView(stage, LinearLayout.LayoutParams(-1, 0, 1f))
        view.addView(column, FrameLayout.LayoutParams(-1, -1))
        saved?.getBundle(STATE)?.let { b -> state.restore(b.keySet().associateWith { b.getString(it).orEmpty() }) }
        moved()
    }

    fun close() { closed = true; main.removeCallbacksAndMessages(null) }

    /** The page comes to the front or goes: it reads again at once, and then every few seconds while it is there. */
    fun shown(visible: Boolean) {
        shown = visible
        main.removeCallbacks(tick)
        if (!visible) dropKeyboard()
        if (visible && !closed) { refresh(); main.postDelayed(tick, 3_000) }
    }

    /** The back key: from a session to the list; false when the list itself is showing. */
    fun back(): Boolean {
        if (!state.back()) return false
        moved(); refresh()
        return true
    }

    /** Whether [back] would do something (the back gesture is offered to the page only then). */
    fun canGoBack() = state.inTalk

    fun save(out: Bundle) { out.putBundle(STATE, Bundle().apply { state.route().forEach { (k, v) -> putString(k, v) } }) }

    override fun keyboard(px: Int) { deck.translationY = -px.toFloat() }

    // ---- reading ----

    /** One read out at a time; asked again meanwhile, it reads once more when that one is back. */
    private fun refresh() {
        if (closed) return
        if (loading) { readAgain = true; return }
        if (!port.open) { problem("还没连上 Ash"); return }
        val now = System.currentTimeMillis()
        // The computers are read again now and then, so one that comes online shows up beside the others.
        if (state.device == null || now - state.computersAt > 15_000) {
            loading = true
            port.call("service:devices", "list") { data, failure ->
                loading = false
                val had = state.generation
                state.computersRead(data, failure?.code, System.currentTimeMillis())
                if (state.generation != had) moved() else paint()
                if (state.device != null) refresh() else again()
            }
            return
        }
        val t = state.ticket()
        val dev = t.device ?: return
        loading = true
        val done: (JSONObject?, HumanPort.Failure?) -> Unit = { data, failure ->
            loading = false
            val counted = if (t.thread == null) state.listRead(t, data, failure?.code) else state.detailRead(t, data, failure?.code)
            if (counted) {
                // What the session now shows, the phone no longer shows apart.
                if (t.thread != null && failure == null) sends = sends.filterNot { it.thread == t.thread && it.status == CodexSend.SENT }
                paint()
            }
            again()
        }
        if (t.thread == null) port.call(dev, CodexModel.SESSIONS, JSONObject().put("limit", 50), done)
        else port.call(dev, CodexModel.SESSION, JSONObject().put("thread", t.thread).put("turns", 8).put("max_chars", 1200), done)
    }

    private fun again() { if (readAgain) { readAgain = false; refresh() } }

    private fun problem(text: String) { problemLine.text = text; problemLine.visibility = View.VISIBLE }

    // ---- moving ----

    private fun choose(computer: String) { if (state.choose(computer)) { moved(); refresh() } }
    private fun startNew(p: CodexModel.Project) { state.startNew(p); moved(); input.requestFocus() }
    private fun open(s: CodexModel.Session) { state.open(s.id, s.title); moved(); refresh() }

    /** The route changed: the lists are handed over anew and the box shows this conversation's own draft. */
    private fun moved() {
        talkRows.submitList(null)
        loadDraft()
        paint()
        onRouteChange?.invoke()
    }

    private fun draftKey(): String? {
        val dev = state.device ?: state.chosen ?: return null
        return state.thread?.let { Drafts.codex(dev, it) } ?: state.newIn?.cwd?.let { Drafts.codexNew(dev, it) }
    }

    private fun loadDraft() {
        restoring = true
        input.setText(draftKey()?.let(drafts::text).orEmpty()); input.setSelection(input.text.length)
        restoring = false
    }

    // ---- acting ----

    private fun sendTapped() {
        val t = input.text.toString().trim()
        if (t.isEmpty()) return
        if (state.newIn != null) create(t) else say(t)
    }

    /** A new session: the words stay in the box until the computer has made it (then the session opens, empty box). */
    private fun create(text: String) {
        val dev = state.device ?: return
        val p = state.newIn ?: return
        val cwd = p.cwd ?: return
        if (creating) return
        creating = true
        val key = draftKey()
        problem("正在电脑上开新会话…")
        port.call(dev, CodexModel.NEW, JSONObject().put("cwd", cwd).put("text", text)) { data, failure ->
            creating = false
            val id = CodexModel.created(data)
            if (failure != null || id == null) {
                // The words are still in the box: nothing to put back.
                problemLine.visibility = View.GONE
                toast(failure?.let { CodexModel.failure(it.code, it.message) } ?: "没能开新会话")
                return@call
            }
            key?.let(drafts::clear)
            if (state.newIn == p) { state.open(id, null); moved(); main.postDelayed({ refresh() }, 600) }
        }
    }

    /** A message to the session: it leaves the box at once and waits as its own row; failing, it stays there to send again (§4.2). */
    private fun say(text: String) {
        val id = state.thread ?: return
        val s = CodexSend(UUID.randomUUID().toString(), id, text, CodexSend.SENDING)
        sends = sends + s
        input.setText("")
        paintTalk(toEnd = true)
        go(s)
    }

    /** Sends [s] with its own client id (the same on every try). */
    private fun go(s: CodexSend) {
        val dev = state.device ?: return set(s, CodexSend.FAILED)
        set(s, CodexSend.SENDING)
        port.call(dev, CodexModel.SEND, JSONObject().put("thread", s.thread).put("text", s.text).put("client_id", s.clientId)) { _, failure ->
            when {
                failure == null -> { set(s, CodexSend.SENT); main.postDelayed({ refresh() }, 600) }
                failure.code == "result_unknown" -> set(s, CodexSend.UNKNOWN)
                else -> set(s, CodexSend.FAILED)
            }
        }
    }

    private fun set(s: CodexSend, status: String) {
        sends = sends.map { if (it.clientId == s.clientId) it.copy(status = status) else it }
        paintTalk()
    }

    private fun stopTurn() {
        val dev = state.device ?: return
        val id = state.thread ?: return
        port.call(dev, CodexModel.STOP, JSONObject().put("thread", id)) { _, failure ->
            if (failure != null) toast(CodexModel.failure(failure.code, failure.message)) else main.postDelayed({ refresh() }, 600)
        }
    }

    /** Answers one approval; only its own buttons wait meanwhile (§6.1). */
    private fun answer(a: CodexModel.Approval, decision: String) {
        val dev = state.device ?: return
        val id = state.thread ?: return
        if (!answering.add(a.requestId)) return
        paintTalk()
        port.call(dev, CodexModel.APPROVE, JSONObject().put("thread", id).put("request_id", a.requestId).put("decision", decision)) { _, failure ->
            answering.remove(a.requestId)
            if (failure != null) toast(CodexModel.failure(failure.code, failure.message))
            paintTalk(); refresh()
        }
    }

    private fun toast(s: String) = Toast.makeText(activity, s, Toast.LENGTH_SHORT).show()

    private fun dropKeyboard() {
        if (!input.hasFocus()) return
        input.clearFocus()
        activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java)?.hideSoftInputFromWindow(input.windowToken, 0)
    }

    // ---- drawing ----

    private fun composer(): View = AshUi.hstack(activity, 8).apply {
        gravity = Gravity.BOTTOM; visibility = View.GONE
        setPadding(d(12), d(4), d(12), d(10))
        input.apply {
            id = View.generateViewId()
            hint = "跟 Codex 说…"
            AshUi.style(this, AshTokens.Type.chat, c.text)
            setHintTextColor(c.text3)
            background = AshUi.rounded(c.surface, AshUi.dpF(activity, 20f), c.line, d(1))
            setPadding(d(14), d(10), d(14), d(10))
            minHeight = d(AshTokens.Size.touch); maxLines = 6
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, n: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, n: Int) {}
                override fun afterTextChanged(s: Editable?) { if (!restoring) draftKey()?.let { drafts.keep(it, s?.toString().orEmpty()) } }
            })
        }
        addView(input, LinearLayout.LayoutParams(0, -2, 1f))
        addView(sendButton)
    }

    private fun paint() {
        if (closed) return
        val talk = state.inTalk
        composer.visibility = if (talk) View.VISIBLE else View.GONE
        sessionList.visibility = if (talk) View.GONE else View.VISIBLE
        talkList.visibility = if (talk) View.VISIBLE else View.GONE
        val p = state.problem
        problemLine.visibility = if (p == null) View.GONE else View.VISIBLE
        if (p != null) problemLine.text = p else keepClear(0)
        if (talk) paintTalk() else paintSessions()
    }

    /** The lists keep their top clear of the problem line while it shows (set after this layout, never inside it). */
    private fun keepClear(height: Int) {
        for (l in listOf(sessionList, talkList)) if (l.paddingTop != height) l.post { l.setPadding(l.paddingLeft, height, l.paddingRight, l.paddingBottom) }
    }

    private fun paintSessions() {
        title.text = "Codex"; stop.visibility = View.GONE
        val rows = ArrayList<ChatRow>()
        val computers = state.computers
        // Several computers: which one's Codex is shown.
        if (computers.size > 1) {
            val at = computers.indexOfFirst { it.id == state.device }.coerceAtLeast(0)
            rows += ChatRow("computers", computers.joinToString { it.id + it.name } + "@" + at) { AshUi.segmented(activity, computers.map { it.name }, at) { choose(computers[it].id) } }
        }
        val list = state.sessions
        when {
            list == null -> if (state.problem == null) rows += hintRow("正在读取…")
            list.isEmpty() -> rows += hintRow("Codex 里还没有会话")
            else -> {
                val now = System.currentTimeMillis()
                for (p in CodexModel.projects(list)) {
                    val ago = p.sessions.joinToString { s -> s.updatedAt?.let { CodexModel.ago(it, now) }.orEmpty() }
                    rows += ChatRow("p:" + (p.cwd ?: ""), "$p|$ago") { projectView(p, now) }
                }
            }
        }
        sessionRows.submitList(rows)
    }

    private fun projectView(p: CodexModel.Project, now: Long): View {
        val items = mutableListOf<View>()
        if (p.cwd != null) items += AshUi.row(activity, "＋ 新对话", null, null, AshUi.Tone.MUTE) { startNew(p) }
        items += p.sessions.map { s ->
            val tone = when { s.waiting -> AshUi.Tone.WARN; s.running -> AshUi.Tone.OK; else -> AshUi.Tone.MUTE }
            AshUi.row(activity, s.title, s.updatedAt?.let { CodexModel.ago(it, now) }, null, AshUi.Tone.MUTE,
                trailing = AshUi.tag(activity, CodexModel.stateLabel(s), tone, dot = s.running)) { open(s) }
        }
        return AshUi.group(activity, title = p.name, rows = items, iconInset = false)
    }

    private fun paintTalk(toEnd: Boolean = false) {
        if (!state.inTalk) return
        val rows = ArrayList<ChatRow>()
        val newIn = state.newIn
        if (newIn != null) {
            title.text = "新对话 · ${newIn.name}"; stop.visibility = View.GONE; input.hint = "第一句话…"
            if (state.problem == null) rows += hintRow("在 ${newIn.cwd} 里开一个新的 Codex 会话，写下第一句话发出去。")
        } else {
            title.text = state.title ?: "Codex"
            val dt = state.detail
            if (dt == null) { if (state.problem == null) rows += hintRow("正在读取…") }
            else {
                stop.visibility = if (dt.session.running || dt.session.waiting) View.VISIBLE else View.GONE
                input.hint = if (dt.session.open) "跟 Codex 说…" else "跟 Codex 说…（会先在电脑上打开这个会话）"
                // The computer gives its items no ids; within a turn they only ever add up, so turn and place name one.
                for (turn in dt.turns) turn.items.forEachIndexed { i, item ->
                    if (item.kind == "thinking" || (item.kind in setOf("user", "agent") && item.text.isBlank())) return@forEachIndexed
                    rows += ChatRow("${turn.id}:$i", item.kind + "|" + item.text) { itemView(item) }
                }
                if (dt.session.running && dt.approvals.isEmpty()) rows += ChatRow("running", "running") { AshUi.text(activity, "在做事…", AshTokens.Type.caption, c.text3).apply { layoutParams = side(false) } }
                for (a in dt.approvals) rows += ChatRow("approval:" + a.requestId, a.summary + "|" + (a.requestId in answering)) { approvalCard(a) }
                if (dt.turns.isEmpty() && dt.approvals.isEmpty()) rows += hintRow("这个会话还没有内容")
            }
            for (s in sends) if (s.thread == state.thread) rows += ChatRow("send:" + s.clientId, s.status) { sendView(s) }
        }
        FollowEnd.submit(talkList, talkLm, talkRows, rows, toEnd)
    }

    private fun hintRow(s: String) = ChatRow("hint", s) {
        AshUi.text(activity, s, AshTokens.Type.callout, c.text3).apply { gravity = Gravity.CENTER; setPadding(d(8), d(24), d(8), d(8)) }
    }

    private fun side(mine: Boolean) = LinearLayout.LayoutParams(-2, -2).apply { gravity = if (mine) Gravity.END else Gravity.START }

    /** One bubble or tool line, on its own side of the row. */
    private fun itemView(i: CodexModel.Item): View {
        val mine = i.kind == "user"
        val v = when (i.kind) {
            "user" -> AshUi.bubbleText(activity, i.text, true).apply { setTextIsSelectable(true) }
            "agent" -> AshUi.bubbleText(activity, Md.render(i.text, c.surface2, c.her), false).apply { setTextIsSelectable(true); movementMethod = LinkMovementMethod.getInstance() }
            else -> AshUi.text(activity, "▸ " + toolLabel(i), AshTokens.Type.caption, c.text3, maxLines = 2)
        }
        return LinearLayout(activity).apply { gravity = if (mine) Gravity.END else Gravity.START; addView(v, side(mine)) }
    }

    /** A message sent from here that the session does not show yet: sending, sent, or not sent with 「重发」 and 「删掉」 beside it. */
    private fun sendView(s: CodexSend): View = AshUi.vstack(activity, 2).apply {
        gravity = Gravity.END
        addView(AshUi.bubbleText(activity, s.text, true).apply { alpha = 0.7f }, side(true))
        val status = when (s.status) {
            CodexSend.FAILED -> "没发出去"
            CodexSend.UNKNOWN -> "不确定发出去没有，先看看上面"
            CodexSend.SENT -> "已发出"
            else -> "发送中…"
        }
        addView(AshUi.hstack(activity, 12).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(AshUi.text(activity, status, AshTokens.Type.caption, c.text3))
            if (s.status == CodexSend.FAILED || s.status == CodexSend.UNKNOWN) {
                addView(AshUi.button(activity, "重发", AshUi.Kind.GHOST, AshUi.BtnSize.SM) { go(s) })
                addView(AshUi.button(activity, "删掉", AshUi.Kind.GHOST, AshUi.BtnSize.SM) { sends = sends.filterNot { it.clientId == s.clientId }; paintTalk() })
            }
        }, side(true))
    }

    private fun toolLabel(i: CodexModel.Item): String {
        val verb = when (i.kind) { "command" -> "运行"; "file" -> "改文件"; "tool" -> "调用"; "search" -> "搜索"; "plan" -> "计划"; else -> i.kind }
        return if (i.text.isBlank()) verb else "$verb ${i.text}"
    }

    private fun approvalCard(a: CodexModel.Approval): View = AshUi.card(activity).apply {
        addView(AshUi.cardHeader(activity, AshUi.Tone.WARN, activity.getDrawable(R.drawable.ash_ic_shield)!!, "Codex 等你批准"))
        addView(AshUi.text(activity, a.summary.ifEmpty { "一个请求" }, AshTokens.Type.body, c.text, maxLines = 8))
        val waiting = a.requestId in answering
        addView(AshUi.hstack(activity, 8).apply {
            addView(AshUi.button(activity, if (waiting) "处理中…" else "批准", AshUi.Kind.PRIMARY, AshUi.BtnSize.SM) { answer(a, "approve") }.apply { isEnabled = !waiting })
            addView(AshUi.button(activity, "拒绝", AshUi.Kind.NEUTRAL, AshUi.BtnSize.SM) { answer(a, "deny") }.apply { isEnabled = !waiting })
        })
    }

    private fun gap(dp: Int) = object : RecyclerView.ItemDecoration() {
        override fun getItemOffsets(out: android.graphics.Rect, v: View, parent: RecyclerView, s: RecyclerView.State) { out.top = d(dp) }
    }

    companion object { const val STATE = "ai.ash.codex.route" }
}
