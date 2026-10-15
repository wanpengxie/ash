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
    /**
     * What the owner sent or asked for from here (a message to a session, a new session) that the computer has not shown
     * yet (MOBILE-ARCH §3.5, §6.2): stored before it leaves the box, each with its computer, its session (or project) and
     * its client id fixed, so a retry — also after the app was closed — goes to the same place with the same id.
     */
    private val ops = ChatOutbox(activity, "codex-outbox")
    /** Approvals being answered (their buttons wait). */
    private val answering = HashSet<String>()
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
    }
    /** When to move the session (decided as its rows land, §2.4); a drag puts the keyboard away (§4.3) and gives up a place being restored. */
    private val follow = FollowEnd(talkList, talkLm, talkRows) { dropKeyboard(); talkPlace.cancel() }
    /** Reading places to bring back after the activity was made again: in the list of sessions, and in the session. */
    private var listPlace = AnchorRestore(null)
    private var talkPlace = AnchorRestore(null)
    /**
     * Why the last read failed, floating over the top of the lists (§1.2): it covers their top — the oldest rows — while it
     * shows, and lays nothing out coming and going.
     */
    private val problemLine = AshUi.text(activity, "", AshTokens.Type.callout, c.text2).apply {
        gravity = Gravity.CENTER; setPadding(d(14), d(6), d(14), d(6)); setBackgroundColor(c.bg); visibility = View.GONE
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
        saved?.getBundle(STATE)?.let { b ->
            state.restore(b.keySet().filter { !it.startsWith("place.") }.associateWith { b.getString(it).orEmpty() })
            listPlace = AnchorRestore(placeOf(b, "place.list"))
            talkPlace = AnchorRestore(placeOf(b, "place.talk"))
        }
        sessionList.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrollStateChanged(rv: RecyclerView, st: Int) { if (st == RecyclerView.SCROLL_STATE_DRAGGING) listPlace.cancel() }
        })
        moved()
        // Stored operations come back: one that was going out when the app went is not known to have arrived (§6.2).
        ops.whenReady {
            CodexModel.interrupted(ops.items()).forEach { ops.mark(it, Pending.UNKNOWN) }
            paint()
        }
    }

    private fun placeOf(b: Bundle, k: String) = b.getString("$k.key")?.let { AnchorRestore.Anchor(it, null, b.getInt("$k.offset")) }

    fun close() { closed = true; main.removeCallbacksAndMessages(null) }

    /** The page comes to the front or goes: it reads again at once, and then every few seconds while it is there. */
    fun shown(visible: Boolean) {
        shown = visible
        main.removeCallbacks(tick)
        // Gone: what is being read no longer counts, and no read follows it.
        if (!visible) { dropKeyboard(); state.invalidate(); readAgain = false }
        if (visible && !closed) { refresh(); main.postDelayed(tick, 3_000) }
    }

    /** The back key: from a session to the list; false when the list itself is showing. */
    fun back(): Boolean {
        if (!state.back()) return false
        dropKeyboard()
        moved(); refresh()
        return true
    }

    /** Whether [back] would do something (the back gesture is offered to the page only then). */
    fun canGoBack() = state.inTalk

    fun save(out: Bundle) {
        out.putBundle(STATE, Bundle().apply {
            state.route().forEach { (k, v) -> putString(k, v) }
            fun place(k: String, list: RecyclerView, lm: LinearLayoutManager, rows: KeyedRowsAdapter, atEndIsNone: Boolean) {
                if (atEndIsNone && !list.canScrollVertically(1)) return
                if (!atEndIsNone && !list.canScrollVertically(-1)) return
                val pos = lm.findFirstVisibleItemPosition().takeIf { it >= 0 } ?: return
                val row = lm.findViewByPosition(pos) ?: return
                putString("$k.key", rows.currentList.getOrNull(pos)?.key ?: return); putInt("$k.offset", lm.getDecoratedTop(row) - list.paddingTop)
            }
            if (state.inTalk) place("place.talk", talkList, talkLm, talkRows, atEndIsNone = true)
            place("place.list", sessionList, sessionLm, sessionRows, atEndIsNone = false)
        })
    }

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
                // A message the session now shows (by its client id) is no longer shown apart: its row becomes the session's.
                val d = state.detail
                if (t.thread != null && failure == null && d != null && ops.ready)
                    CodexModel.settled(ops.items(), dev, t.thread, CodexModel.clientIds(d)).forEach(ops::remove)
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

    /**
     * A new session or a message (MOBILE-ARCH §3.5): stored first, with its computer, its session (or project) and its client
     * id; only once it is kept do the words leave the box. Then it goes out, and waits as its own row until the computer
     * shows what it became.
     */
    private fun store(body: JSONObject, text: String) {
        val dev = state.device ?: return
        if (storing) return
        storing = true
        val key = draftKey()
        val op = Pending(UUID.randomUUID().toString(), dev, body, at = System.currentTimeMillis())
        ops.add(op) { kept ->
            storing = false
            if (!kept) { toast("没能存下来，还在输入框里，再点一次试试"); return@add }
            if (draftKey() == key && input.text.toString().trim() == text) input.setText("")
            talkPlace.cancel()
            paintTalk(toEnd = true)
            go(op)
        }
    }
    private var storing = false

    private fun create(text: String) {
        val p = state.newIn ?: return
        val cwd = p.cwd ?: return
        store(JSONObject().put("op", "new").put("cwd", cwd).put("name", p.name).put("text", text), text)
    }

    private fun say(text: String) {
        val id = state.thread ?: return
        store(JSONObject().put("op", "send").put("thread", id).put("text", text), text)
    }

    /** Sends [op] to the computer it was stored for, with its own client id — the same on every try (§6.2). */
    private fun go(op: Pending) {
        val to = op.to ?: return
        ops.mark(op.clientId, Pending.SENDING); paint()
        val b = op.body
        val new = b.optString("op") == "new"
        val word = if (new) CodexModel.NEW else CodexModel.SEND
        val req = if (new) JSONObject().put("cwd", b.optString("cwd")).put("text", b.optString("text")).put("client_id", op.clientId)
            else JSONObject().put("thread", b.optString("thread")).put("text", b.optString("text")).put("client_id", op.clientId)
        port.call(to, word, req) { data, failure ->
            when {
                failure == null && new -> {
                    // The session exists: the operation is done; the session opens if the owner is still on that new page.
                    ops.remove(op.clientId)
                    // store() already cleared only the submitted draft. A later draft belongs to the owner, not this reply.
                    val thread = CodexModel.created(data)
                    if (thread != null && state.device == to && state.newIn?.cwd == b.optString("cwd")) { state.open(thread, null); moved(); main.postDelayed({ refresh() }, 600) }
                    else paint()
                }
                failure == null -> { ops.mark(op.clientId, Pending.SENT); paint(); main.postDelayed({ refresh() }, 600) }
                failure.code == "result_unknown" -> { ops.mark(op.clientId, Pending.UNKNOWN); paint() }
                else -> { ops.mark(op.clientId, Pending.FAILED); paint() }
            }
        }
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
        if (p != null) problemLine.text = p
        if (talk) paintTalk() else paintSessions()
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
        sessionRows.submitList(rows) {
            when (val step = listPlace.onRows(rows.map { it.key }, read = state.sessions != null, canFetch = false)) {
                is AnchorRestore.Step.Go -> sessionLm.scrollToPositionWithOffset(step.index, step.offset)
                else -> {}
            }
        }
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
            val mine = ops.items().filter { it.to == state.device && it.body.optString("op") == "new" && it.body.optString("cwd") == newIn.cwd }
            if (state.problem == null && mine.isEmpty()) rows += hintRow("在 ${newIn.cwd} 里开一个新的 Codex 会话，写下第一句话发出去。")
            for (op in mine) rows += ChatRow(op.clientId, op.status + "|" + op.text) { opView(op) }
        } else {
            title.text = state.title ?: "Codex"
            val dt = state.detail
            if (dt == null) { if (state.problem == null) rows += hintRow("正在读取…") }
            else {
                stop.visibility = if (dt.session.running || dt.session.waiting) View.VISIBLE else View.GONE
                input.hint = if (dt.session.open) "跟 Codex 说…" else "跟 Codex 说…（会先在电脑上打开这个会话）"
                for (turn in dt.turns) turn.items.forEachIndexed { i, item ->
                    if (item.kind == "thinking" || (item.kind in setOf("user", "agent") && item.text.isBlank())) return@forEachIndexed
                    rows += ChatRow(CodexModel.itemKey(turn.id, item, i), item.kind + "|" + item.text) { itemView(item) }
                }
                if (dt.session.running && dt.approvals.isEmpty()) rows += ChatRow("running", "running") { AshUi.text(activity, "在做事…", AshTokens.Type.caption, c.text3).apply { layoutParams = side(false) } }
                for (a in dt.approvals) rows += ChatRow("approval:" + a.requestId, a.summary + "|" + (a.requestId in answering)) { approvalCard(a) }
                if (dt.turns.isEmpty() && dt.approvals.isEmpty()) rows += hintRow("这个会话还没有内容")
            }
            // What waits keeps its client id as its key: the session's copy of it takes over the same row.
            val shown = rows.map { it.key }.toSet()
            for (op in ops.items()) if (op.to == state.device && op.body.optString("op") == "send" && op.body.optString("thread") == state.thread && op.clientId !in shown)
                rows += ChatRow(op.clientId, op.status + "|" + op.text) { opView(op) }
        }
        val readNow = if (newIn != null) true else state.detail != null
        follow.submit(rows, toEnd, hold = { talkPlace.pending }) {
            when (val step = talkPlace.onRows(rows.map { it.key }, readNow, canFetch = false)) {
                is AnchorRestore.Step.Go -> talkLm.scrollToPositionWithOffset(step.index, step.offset)
                // Further back than the turns shown: stay at the oldest there is, not at the newest.
                AnchorRestore.Step.Oldest -> talkLm.scrollToPositionWithOffset(0, 0)
                else -> {}
            }
        }
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

    /** A message (or a new session) sent from here that the computer does not show yet: sending, sent, or not sent with 「重发」 and 「删掉」 (same client id). */
    private fun opView(op: Pending): View = AshUi.vstack(activity, 2).apply {
        gravity = Gravity.END
        addView(AshUi.bubbleText(activity, op.text, true).apply { alpha = 0.7f }, side(true))
        val status = when (op.status) {
            Pending.FAILED -> "没发出去"
            Pending.UNKNOWN -> "不确定发出去没有，先看看上面再决定"
            Pending.SENT -> "已发出"
            else -> if (op.body.optString("op") == "new") "正在电脑上开新会话…" else "发送中…"
        }
        addView(AshUi.hstack(activity, 12).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(AshUi.text(activity, status, AshTokens.Type.caption, c.text3))
            if (op.status == Pending.FAILED || op.status == Pending.UNKNOWN) {
                addView(AshUi.button(activity, "重发", AshUi.Kind.GHOST, AshUi.BtnSize.SM) { ops.get(op.clientId)?.let(::go) })
                addView(AshUi.button(activity, "删掉", AshUi.Kind.GHOST, AshUi.BtnSize.SM) { ops.remove(op.clientId); paint() })
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
