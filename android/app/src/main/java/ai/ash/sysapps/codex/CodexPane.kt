package ai.ash.sysapps.codex

import ai.ash.ui.*
import ai.ash.link.LinkClient

import ai.ash.R
import ai.ash.sysapps.AppAccent
import ai.ash.sysapps.AppUi
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi
import android.app.Activity
import android.app.AlertDialog
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
 * sends words, through the shared human channel as the owner (`x.codex.*` on the computer), and keeps nothing of its own but the owner's drafts.
 *
 * Built as the chat is (MOBILE-ARCH §2, §4.4): a fixed header, and under it a clipped stage whose deck — the lists and the
 * box — rides the keyboard; the sessions and a session's turns are keyed lists updated row by row, so a poll that changes
 * one thing redraws that one thing and never the box being typed in. What it reads is held in [CodexState]. [view] goes into
 * CodexActivity; call [shown] as it comes and goes, [back] for the back key.
 */
class CodexPane(private val activity: Activity, private val title: android.widget.TextView, actions: LinearLayout, private val client: LinkClient, saved: Bundle? = null) : KeyboardDeck {
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
    private var computersChanged = true
    private var loading = false
    private var readAgain = false
    private var shown = false
    private var closed = false
    private var restoring = false
    private var loadedDraftKey: String? = null
    private val actors = LinkedHashMap<String, String>()
    private val readingPlaces = LinkedHashMap<String, Anchor>()
    private data class Snapshot(val detail: CodexModel.Detail, val at: Long)
    private data class ApprovalAt(val thread: String, val title: String, val approval: CodexModel.Approval)
    private val snapshots = LinkedHashMap<String, Snapshot>()
    private val approvalSnapshots = HashMap<String, List<ApprovalAt>>()
    private val approvalProblems = HashSet<String>()
    private val stopRequested = HashSet<String>()
    private var confirmedAt = 0L
    private var lastActorLine: String? = null
    private var rawRecord = false
    var destination: String = saved?.getString("codex.destination") ?: "now"; private set
    private var rootPlace: Anchor? = null
    val pageLabel: String get() = when { rawRecord -> "原始记录"; state.newIn != null -> "新工作"; state.inTalk -> if (state.detail?.session?.running == false && state.detail?.session?.waiting == false) "工作结果" else "电脑上的工作"; else -> "Codex" }
    val statusLine: String get() = state.problem ?: readProblem ?: if (!state.inTalk && state.device in approvalProblems) "审批暂时读不到 · 保留上次内容" else if (confirmedAt == 0L) "正在读取电脑会话" else listOfNotNull("最近确认 · " + java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date(confirmedAt)), lastActorLine).joinToString(" · ")
    val statusAction: String? get() = if (!state.inTalk) approvalSnapshots[state.device]?.takeIf { it.isNotEmpty() }?.let { (if (state.device in approvalProblems) "上次 " else "") + "${it.size}个待批准" } else null
    private fun identity(device: String?, thread: String) = "$device/$thread"
    private fun computerName() = state.deviceName ?: state.computers.firstOrNull { it.id == state.device }?.name ?: "电脑"
    private fun projectName(session: CodexModel.Session) = session.cwd?.trimEnd('/')?.substringAfterLast('/')?.ifEmpty { "/" }
    /** The route changed (a session opened or closed): the activity offers back to this page only inside a session. */
    var onRouteChange: (() -> Unit)? = null

    private val menuButton = AshUi.iconButton(activity, activity.getDrawable(R.drawable.ash_ic_slider)!!, "Codex选项") { options() }
    private val input = EditText(activity)
    private val sendButton = AshUi.iconButton(activity, activity.getDrawable(R.drawable.ash_ic_up)!!, "发送", filled = true) { sendTapped() }
    private val composer = composer()

    private val sessionRows = KeyedRowsAdapter(activity)
    private val sessionLm = LinearLayoutManager(activity)
    private val sessionList = RecyclerView(activity).apply {
        layoutManager = sessionLm; adapter = sessionRows; itemAnimator = null
        setPadding(d(16), 0, d(16), d(16)); clipToPadding = false
        addItemDecoration(gap(10))
    }
    private val talkRows = KeyedRowsAdapter(activity)
    private val resultRows = KeyedRowsAdapter(activity)
    private val resultList = RecyclerView(activity).apply {
        layoutManager = LinearLayoutManager(activity); adapter = resultRows; itemAnimator = null
        setPadding(d(16), 0, d(16), d(16)); clipToPadding = false; addItemDecoration(gap(12))
    }
    private val talkLm = LinearLayoutManager(activity).apply { stackFromEnd = true }
    private val talkList = RecyclerView(activity).apply {
        layoutManager = talkLm; adapter = talkRows
        setPadding(d(14), 0, d(14), d(12)); clipToPadding = false
        addItemDecoration(gap(10))
        // A drag of the session puts the keyboard away; its own scrolling never does (§4.3).
        addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrollStateChanged(rv: RecyclerView, st: Int) { if (st == RecyclerView.SCROLL_STATE_DRAGGING) dropKeyboard() }
        })
    }
    /** Where the session was read, to bring back once it is read again after the activity was made again. */
    private var place: Anchor? = null
    private var readProblem: String? = null
    private val deck = AshUi.vstack(activity, 0)

    private val tick = object : Runnable {
        override fun run() { if (!shown || closed) return; refresh(); main.postDelayed(this, if (state.thread != null) 2_500 else 4_000) }
    }

    init {
        val column = AshUi.vstack(activity)
        actions.addView(menuButton)
        val lists = FrameLayout(activity).apply {
            addView(sessionList, FrameLayout.LayoutParams(-1, -1))
            addView(talkList, FrameLayout.LayoutParams(-1, -1))
            addView(resultList, FrameLayout.LayoutParams(-1, -1))
        }
        deck.addView(lists, LinearLayout.LayoutParams(-1, 0, 1f))
        deck.addView(composer, LinearLayout.LayoutParams(-1, -2))
        // The header stays; the stage under it clips the deck as the keyboard moves it up.
        val stage = FrameLayout(activity).apply { clipChildren = true; addView(deck, FrameLayout.LayoutParams(-1, -1)) }
        column.addView(stage, LinearLayout.LayoutParams(-1, 0, 1f))
        view.addView(column, FrameLayout.LayoutParams(-1, -1))
        saved?.getBundle(STATE)?.let { b ->
            b.getBundle("places")?.let { savedPlaces -> savedPlaces.keySet().forEach { key ->
                savedPlaces.getBundle(key)?.let { value -> value.getString(PLACE)?.let { readingPlaces[key] = Anchor(it, value.getInt(OFFSET)) } }
            } }
            state.restore(b.keySet().filter { it != PLACE && it != OFFSET && it != "places" }.associateWith { b.getString(it).orEmpty() })
            place = b.getString(PLACE)?.let { Anchor(it, b.getInt(OFFSET)) }
            draftKey()?.let { key -> place?.let { readingPlaces.putIfAbsent(key, it) } }
        }
        moved()
        // Stored operations come back; one that was going out when the app went is shown as not sent (重发 keeps its id).
        ops.whenReady {
            ops.items().forEach { actors[it.to + ":" + it.clientId] = "你" }
            ops.items().filter { it.status == Pending.SENDING }.forEach { ops.mark(it.clientId, Pending.UNSENT) }
            paint()
        }
    }

    fun close() { closed = true; state.invalidate(); main.removeCallbacksAndMessages(null) }

    fun destination(id: String) {
        if (id !in setOf("now", "sessions") || (id == destination && !state.inTalk)) return
        rememberPlace(); dropKeyboard(); state.back(); destination = id; rawRecord = false
        rootPlace = null; sessionRows.submitList(null); moved(); refresh()
    }
    fun refreshNow() { computersChanged = true; refresh() }
    private fun options() {
        val labels = mutableListOf("刷新", "选择电脑")
        if (state.thread != null) labels += "在电脑打开原会话"
        labels += "从项目开始新工作"
        if (state.thread != null) labels += if (rawRecord) "回工作详情" else "查看原始记录"
        AlertDialog.Builder(activity).setTitle("Codex").setItems(labels.toTypedArray()) { _, index ->
            when (labels[index]) {
                "刷新" -> refreshNow()
                "选择电脑" -> AlertDialog.Builder(activity).setTitle("选择电脑").setItems(state.computers.map { it.name }.toTypedArray()) { _, i -> choose(state.computers[i].id) }.show()
                "在电脑打开原会话" -> state.device?.let { dev -> state.thread?.let { thread -> call(dev, "x.codex.open", JSONObject().put("thread", thread)) { _, f -> if (f != null) toast(CodexModel.failure(f.code, f.message)) else refresh() } } }
                "从项目开始新工作" -> {
                    val projects = CodexModel.projects(state.sessions.orEmpty()).filter { it.cwd != null }
                    if (projects.isEmpty()) { destination("sessions"); toast("先从会话里的真实项目选择新工作") }
                    else AlertDialog.Builder(activity).setTitle("选择原项目").setItems(projects.map { it.cwd.orEmpty() }.toTypedArray()) { _, i -> startNew(projects[i]) }.show()
                }
                else -> { rawRecord = !rawRecord; paint() }
            }
        }.show()
    }

    private fun call(to: String, word: String, body: JSONObject = JSONObject(), done: (JSONObject?, HumanPort.Failure?) -> Unit) =
        HumanCall.call(client, to, word, body, done)

    /** The shared ledger invalidates immediately; polling also reads Codex's changes on the computer. */
    fun changed(message: JSONObject) {
        val onComputer = message.optString("to") == state.device || message.optString("from") == state.device
        if (message.optString("word") == CodexModel.SEND) {
            val id = message.optJSONObject("body")?.optString("client_id").orEmpty()
            val actor = CodexOpen.actor(message)
            if (id.isNotEmpty() && actor != null) actors[message.optString("to") + ":" + id] = actor
            while (actors.size > 200) actors.remove(actors.keys.first())
        }
        val body = message.optJSONObject("body")
        val sameWork = !state.inTalk || (state.thread != null && body?.optString("thread") == state.thread) ||
            (state.newIn != null && body?.optString("cwd") == state.newIn?.cwd)
        if (onComputer && sameWork) CodexOpen.actorLine(message)?.let { lastActorLine = it }
        if (CodexOpen.affectsComputers(message)) { computersChanged = true; refresh() }
        else if (onComputer && CodexOpen.affectsSession(message)) refresh()
    }

    fun connected() { computersChanged = true; if (shown) refresh() }

    /** An application open may name a device and thread; saved state takes precedence on recreation. */
    fun openArg(arg: String?) {
        val route = CodexOpen.route(arg) ?: return
        val sameDevice = route.device == null || route.device == state.device
        if (sameDevice && route.thread == state.thread && (route.thread != null || !state.inTalk)) return
        rememberPlace(); dropKeyboard()
        if (route.device != null && route.thread == null) state.back()
        route.device?.let { state.choose(it) }
        route.thread?.let { state.open(it, null) }
        moved(); refresh()
    }

    /** The page comes to the front or goes: it reads again at once, and then every few seconds while it is there. */
    fun shown(visible: Boolean) {
        shown = visible
        main.removeCallbacks(tick)
        // Gone: what is being read no longer counts, and no read follows it.
        if (!visible) { dropKeyboard(); state.invalidate(); readAgain = false }
        if (visible && !closed) { paint(); refresh(); main.postDelayed(tick, 3_000) }
    }

    /** The back key: from a session to the list; false when the list itself is showing. */
    fun back(): Boolean {
        if (rawRecord) { rememberPlace(); rawRecord = false; paint(); return true }
        rememberPlace()
        if (!state.back()) return false
        dropKeyboard()
        computersChanged = true
        moved(); refresh()
        return true
    }

    /** Whether [back] would do something (the back gesture is offered to the page only then). */
    fun canGoBack() = state.inTalk

    fun save(out: Bundle) {
        rememberPlace()
        out.putBundle(STATE, Bundle().apply {
            state.route().forEach { (k, v) -> putString(k, v) }
            putBundle("places", Bundle().apply { readingPlaces.forEach { (key, anchor) ->
                putBundle(key, Bundle().apply { putString(PLACE, anchor.key); putInt(OFFSET, anchor.offset) })
            } })
            if (state.inTalk) Anchor.of(talkList, talkLm, talkRows)?.let { putString(PLACE, it.key); putInt(OFFSET, it.offset) }
        })
        out.putString("codex.destination", destination)
    }

    override fun keyboard(px: Int) { deck.translationY = -px.toFloat() }

    // ---- reading ----

    /** One read out at a time; asked again meanwhile, it reads once more when that one is back. */
    private fun refresh() {
        if (closed || !shown) return
        if (loading) { readAgain = true; return }
        if (!client.channelOpen("human")) { problem("还没连上 Ash"); return }
        val now = System.currentTimeMillis()
        // The computers are read again now and then, so one that comes online shows up beside the others.
        if (computersChanged || state.device == null || now - state.computersAt > 15_000) {
            loading = true
            val gen = state.generation
            computersChanged = false
            call("service:devices", "list") { data, failure ->
                loading = false
                if (gen != state.generation) { again(); return@call }
                val had = state.generation
                state.computersRead(data, failure?.code, System.currentTimeMillis())
                if (state.generation != had) moved() else paint()
                if (state.device != null) refresh() else again()
            }
            return
        }
        val gen = state.generation
        val dev = state.device ?: return
        val thread = state.thread
        loading = true
        val done: (JSONObject?, HumanPort.Failure?) -> Unit = letDone@ { data, failure ->
            loading = false
            val counted = if (thread == null) state.listRead(gen, data, failure?.code) else state.detailRead(gen, data, failure?.code)
            if (counted) {
                if (failure == null) { confirmedAt = System.currentTimeMillis(); readProblem = null }
                // Only the exact client id from this computer and session can replace its pending row.
                val d = state.detail
                if (thread != null && failure == null && d != null && ops.ready)
                    CodexModel.settled(ops.items(), dev, thread, d).forEach(ops::remove)
                if (thread != null && failure == null && d != null) rememberSnapshot(dev, d)
                paint()
                if (thread == null && failure == null) { overview(gen, dev); return@letDone }
            }
            again()
        }
        if (thread == null) call(dev, CodexModel.SESSIONS, JSONObject().put("limit", 50), done)
        else call(dev, CodexModel.SESSION, JSONObject().put("thread", thread).put("turns", 8).put("max_chars", 1200), done)
    }

    private fun again() { if (readAgain) { readAgain = false; refresh() } }

    private fun rememberSnapshot(dev: String, detail: CodexModel.Detail) {
        val key = identity(dev, detail.session.id)
        snapshots[key] = Snapshot(detail, System.currentTimeMillis())
        if (!detail.session.running) stopRequested.remove(key)
        while (snapshots.size > 32) snapshots.remove(snapshots.keys.first())
    }

    /** Existing device words only: approvals and two representative original sessions. Missing reads stay unknown. */
    private fun overview(gen: Int, dev: String) {
        loading = true
        call(dev, "x.codex.approvals") { data, failure ->
            if (closed || !shown || gen != state.generation) { loading = false; again(); return@call }
            if (failure == null && data?.optJSONArray("approvals") != null) {
                approvalProblems.remove(dev)
                val array = data.getJSONArray("approvals")
                approvalSnapshots[dev] = (0 until array.length()).mapNotNull { i ->
                    val a = array.optJSONObject(i) ?: return@mapNotNull null
                    val thread = a.optString("thread"); val id = a.optString("request_id")
                    if (thread.isBlank() || id.isBlank()) null else ApprovalAt(thread, a.optString("title"), CodexModel.Approval(id, a.optString("kind"), a.optString("summary")))
                }
            } else approvalProblems.add(dev)
            val sessions = state.sessions.orEmpty()
            val candidates = listOfNotNull(sessions.firstOrNull { it.running || it.waiting }, sessions.firstOrNull { !it.running && !it.waiting }).distinctBy { it.id }
            fun read(at: Int) {
                if (closed || !shown || gen != state.generation || at >= candidates.size) { loading = false; paint(); again(); return }
                val session = candidates[at]
                call(dev, CodexModel.SESSION, JSONObject().put("thread", session.id).put("turns", 8).put("max_chars", 1200)) { result, error ->
                    if (gen == state.generation && error == null) CodexModel.detail(result)?.takeIf { it.session.id == session.id }?.let { rememberSnapshot(dev, it) }
                    read(at + 1)
                }
            }
            read(0)
        }
    }

    private fun problem(text: String) { readProblem = text; onRouteChange?.invoke() }

    // ---- moving ----

    private fun choose(computer: String) {
        rememberPlace()
        val leftDetail = state.back()
        if (state.choose(computer) || leftDetail) { moved(); refresh() }
    }
    private fun startNew(p: CodexModel.Project) { rememberPlace(); state.startNew(p); moved(); input.requestFocus() }
    private fun open(s: CodexModel.Session) { rememberPlace(); state.open(s.id, s.title); moved(); refresh() }

    private fun rememberPlace() {
        if (!state.inTalk) { rootPlace = Anchor.of(sessionList, sessionLm, sessionRows); return }
        if (resultList.visibility == View.VISIBLE) return
        val key = draftKey() ?: return
        val anchor = Anchor.of(talkList, talkLm, talkRows)
        if (anchor == null) readingPlaces.remove(key) else readingPlaces[key] = anchor
        while (readingPlaces.size > 32) readingPlaces.remove(readingPlaces.keys.first())
    }

    /** The route changed: the lists are handed over anew and the box shows this conversation's own draft. */
    private fun moved() {
        lastActorLine = null; rawRecord = false; readProblem = null
        confirmedAt = state.thread?.let { snapshots[identity(state.device, it)]?.at } ?: 0L
        if (draftKey() != loadedDraftKey) place = draftKey()?.let(readingPlaces::get)
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
        val key = draftKey()
        if (key == loadedDraftKey) return
        loadedDraftKey = key
        restoring = true
        input.setText(key?.let(drafts::text).orEmpty()); input.setSelection(input.text.length)
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
        val intentGeneration = state.generation
        val op = Pending(UUID.randomUUID().toString(), dev, body, at = System.currentTimeMillis())
        ops.add(op) { kept ->
            storing = false
            if (!kept) { toast("没能存下来，还在输入框里，再点一次试试"); return@add }
            actors[dev + ":" + op.clientId] = "你"
            if (draftKey() == key && input.text.toString().trim() == text) input.setText("")
            place = null
            paintTalk(toEnd = true)
            go(op, intentGeneration)
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
    private fun go(op: Pending, navigationGeneration: Int = state.generation) {
        val to = op.to ?: return
        ops.mark(op.clientId, Pending.SENDING); paint()
        val b = op.body
        val new = b.optString("op") == "new"
        val word = if (new) CodexModel.NEW else CodexModel.SEND
        val req = if (new) JSONObject().put("cwd", b.optString("cwd")).put("text", b.optString("text"))
            else JSONObject().put("thread", b.optString("thread")).put("text", b.optString("text")).put("client_id", op.clientId)
        call(to, word, req) { data, failure ->
            when {
                failure == null && new -> {
                    // The session exists: the operation is done; the session opens if the owner is still on that new page.
                    ops.remove(op.clientId)
                    // store() already cleared only the submitted draft. A later draft belongs to the owner, not this reply.
                    val thread = CodexModel.created(data)
                    if (thread != null && navigationGeneration == state.generation && state.device == to && state.newIn?.cwd == b.optString("cwd")) { state.open(thread, null); moved(); main.postDelayed({ refresh() }, 600) }
                    else paint()
                }
                // A receipt is not the transcript: keep the row until the exact client id appears on the computer.
                failure == null -> { ops.mark(op.clientId, Pending.SENT); paint(); refresh() }
                else -> { ops.mark(op.clientId, if (failure.code == "result_unknown") Pending.UNSENT else Pending.FAILED); paint() }
            }
        }
    }

    private fun stopTurn(dev: String? = state.device, id: String? = state.thread, handoff: Boolean = false) {
        if (dev == null || id == null) return
        val session = if (state.device == dev && state.thread == id) state.detail?.session else state.sessions?.firstOrNull { it.id == id }
        if (session?.running != true) return
        if (handoff) {
            AlertDialog.Builder(activity).setTitle("停下后我接手")
                .setMessage("只请求停止这台电脑的当前一轮。等电脑实际确认停止后，你可以在原会话继续；这不会转交 IDE 控制权，也不会撤销已有改动。")
                .setNegativeButton("取消", null).setPositiveButton("请求停止本轮") { _, _ -> stopTurn(dev, id) }.show()
            return
        }
        val key = identity(dev, id)
        if (!stopRequested.add(key)) return
        paint()
        call(dev, CodexModel.STOP, JSONObject().put("thread", id)) { _, failure ->
            if (failure != null) { stopRequested.remove(key); toast(CodexModel.failure(failure.code, failure.message)) }
            // A stop receipt is not an observed stopped round, and never claims the work goal is complete.
            paint(); refresh()
        }
    }

    /** Answers one approval; only its own buttons wait meanwhile (§6.1). */
    private fun answer(a: CodexModel.Approval, decision: String, dev: String? = state.device, id: String? = state.thread) {
        if (dev == null || id == null || decision !in setOf("approve", "deny")) return
        val key = identity(dev, id) + "/" + a.requestId
        if (!answering.add(key)) return
        paint()
        call(dev, CodexModel.APPROVE, JSONObject().put("thread", id).put("request_id", a.requestId).put("decision", decision)) { _, failure ->
            answering.remove(key)
            if (failure != null) toast(CodexModel.failure(failure.code, failure.message))
            paint(); refresh()
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
            background = AshUi.rounded(c.surface, AshUi.dpF(activity, 12f), c.line, d(1))
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
        sendButton.background = AshUi.rounded(AshUi.withAlpha(AppAccent.BLUE.color(activity), 0.08f), d(12).toFloat())
        sendButton.getChildAt(0).background?.setTint(AppAccent.BLUE.color(activity))
        addView(sendButton)
    }

    private fun paint() {
        if (closed || !shown) return
        val talk = state.inTalk
        menuButton.getChildAt(0).background = activity.getDrawable(if (talk) R.drawable.ash_ic_more else R.drawable.ash_ic_slider)?.mutate()?.apply { setTint(c.text2) }
        val result = talk && !rawRecord && state.newIn == null && state.detail?.session?.let { !it.running && !it.waiting } == true
        composer.visibility = if (talk) View.VISIBLE else View.GONE
        sessionList.visibility = if (talk) View.GONE else View.VISIBLE
        talkList.visibility = if (talk && !result) View.VISIBLE else View.GONE
        resultList.visibility = if (result) View.VISIBLE else View.GONE
        if (result) paintResult(state.detail!!) else if (talk) paintTalk() else if (destination == "now") paintNow() else paintSessions()
        onRouteChange?.invoke()
    }

    private fun paintSessions() {
        title.text = "Codex"
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
        submitRoot(rows)
    }

    private fun submitRoot(rows: List<ChatRow>) {
        sessionRows.submitList(rows) {
            if (!state.inTalk && state.sessions != null) rootPlace?.let { anchor ->
                rootPlace = null; anchor.indexIn(rows)?.let { sessionLm.scrollToPositionWithOffset(it, anchor.offset) }
            }
        }
    }

    private fun sectionRow(key: String, label: String) = ChatRow(key, label) { AppUi.section(activity, label).apply { setPadding(0, d(10), 0, 0) } }
    private fun body(text: String, muted: Boolean = false) = AshUi.text(activity, text, AshTokens.Type.body, if (muted) c.text2 else c.text)
    private fun code(text: String) = AshUi.text(activity, text, AshTokens.Type.sub, c.text).apply {
        typeface = android.graphics.Typeface.MONOSPACE; setTextIsSelectable(true)
        background = AshUi.rounded(c.codeBg, d(12).toFloat()); setPadding(d(12), d(12), d(12), d(12))
    }

    private fun paintNow() {
        val rows = ArrayList<ChatRow>()
        val dev = state.device
        val sessions = state.sessions
        val approvals = approvalSnapshots[dev]
        val scope = computerName()
        if (sessions == null) rows += hintRow(state.problem ?: "正在读取电脑上的工作…")
        else {
            rows += ChatRow("scope", scope) { AshUi.text(activity, "$scope · 当前电脑", AshTokens.Type.sub, c.text2) }
            if (approvals != null && approvals.isEmpty() && dev !in approvalProblems) rows += ChatRow("quiet", "quiet") { body("本页当前没有需要你的决定", true).apply { setPadding(0, d(16), 0, d(14)) } }
            for (at in approvals.orEmpty()) {
                val session = sessions.firstOrNull { it.id == at.thread }
                val context = listOfNotNull(scope, session?.let(::projectName)).joinToString(" · ")
                val key = identity(dev, at.thread) + "/" + at.approval.requestId
                rows += ChatRow("approval:$key", at.approval.summary + context + (key in answering)) { approvalCard(at.approval, dev, at.thread, at.title, context) }
            }
            rows += sectionRow("work-title", "电脑上的工作")
            val active = sessions.filter { it.running || it.waiting }
            if (active.isEmpty()) rows += ChatRow("no-running", "none") { body("这台电脑当前没有运行中的会话", true) }
            for (session in active) {
                val snapshot = snapshots[identity(dev, session.id)]
                rows += ChatRow("work:" + identity(dev, session.id), "$session|$snapshot|${identity(dev, session.id) in stopRequested}") { workView(session, snapshot) }
            }
            val recent = sessions.firstOrNull { !it.running && !it.waiting }
            if (recent != null) {
                val snapshot = snapshots[identity(dev, recent.id)]
                rows += sectionRow("recent-title", if (snapshot?.detail?.turns?.lastOrNull()?.status == "completed") "最近结束的一轮" else "最近会话")
                rows += ChatRow("recent:" + identity(dev, recent.id), "$recent|$snapshot") {
                    AshUi.hstack(activity, 10).apply {
                        gravity = Gravity.CENTER_VERTICAL; minimumHeight = d(64)
                        addView(AppUi.icon(activity, R.drawable.ash_ic_file, c.text2, 24))
                        addView(AshUi.vstack(activity, 4).apply {
                            addView(AshUi.text(activity, recent.title, AshTokens.Type.headline))
                            addView(AshUi.text(activity, listOfNotNull(projectName(recent), snapshot?.let { CodexEvidence.roundLabel(it.detail) }, "检查明细未取得").joinToString(" · "), AshTokens.Type.sub, c.text2))
                        }, LinearLayout.LayoutParams(0, -2, 1f))
                        addView(AppUi.icon(activity, R.drawable.ash_ic_chev, c.text2, 20))
                        isClickable = true; isFocusable = true; contentDescription = recent.title
                        setOnClickListener { open(recent) }
                    }
                }
            }
            if (sessions.isEmpty()) rows += ChatRow("empty-work", "empty") { body("还没有可接续的会话。可在会话页选择已有项目开始新工作。", true) }
        }
        submitRoot(rows)
    }

    private fun workView(session: CodexModel.Session, snapshot: Snapshot?): View = AshUi.vstack(activity, 10).apply {
        setPadding(0, d(4), 0, d(14))
        addView(AshUi.hstack(activity, 10).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(AppUi.icon(activity, R.drawable.ash_ic_cpu, c.text, 22))
            addView(AshUi.vstack(activity, 3).apply {
                addView(AshUi.text(activity, session.title, AshTokens.Type.headline))
                addView(AshUi.text(activity, listOfNotNull(computerName(), projectName(session)).joinToString(" · "), AshTokens.Type.sub, c.text2))
            }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(AshUi.text(activity, if (session.waiting) "等本次批准" else "运行中", AshTokens.Type.sub, AppAccent.BLUE.color(activity)))
            minimumHeight = d(48); isClickable = true; isFocusable = true; contentDescription = session.title
            setOnClickListener { open(session) }
        })
        snapshot?.let { snap ->
            CodexEvidence.report(snap.detail)?.let { addView(body("Codex最近消息：$it")) }
            addView(AshUi.text(activity, java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date(snap.at)) + " 最后确认", AshTokens.Type.sub, c.text2))
        }
        if (session.running) addView(runningActions(state.device, session.id))
        addView(View(activity).apply { setBackgroundColor(c.line2) }, LinearLayout.LayoutParams(-1, d(1)))
    }

    private fun runningActions(dev: String?, thread: String): View = AshUi.vstack(activity, 6).apply {
        val pending = identity(dev, thread) in stopRequested
        if (pending) addView(body("停止请求已提交，等待电脑实际确认", true))
        addView(AshUi.hstack(activity, 8).apply {
            addView(AppUi.button(activity, if (pending) "等待停止确认" else "暂停本轮", AppAccent.BLUE, false) { stopTurn(dev, thread) }.apply { isEnabled = !pending }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(AppUi.button(activity, "停下后我接手", AppAccent.BLUE, false) { stopTurn(dev, thread, true) }.apply { isEnabled = !pending }, LinearLayout.LayoutParams(0, -2, 1f))
        })
    }

    private fun paintResult(detail: CodexModel.Detail) {
        val rows = ArrayList<ChatRow>()
        val meta = listOfNotNull(computerName(), projectName(detail.session), CodexEvidence.roundLabel(detail)).joinToString(" · ")
        rows += ChatRow("result-heading", "$meta|${detail.session.title}") { AshUi.vstack(activity, 14).apply {
            addView(AshUi.text(activity, meta, AshTokens.Type.sub, c.text2))
            addView(AshUi.text(activity, detail.session.title, AshTokens.Type.title))
            addView(body("先看实际留下的文件记录与原始汇报。"))
        } }
        val files = CodexEvidence.files(detail)
        if (files.isNotEmpty()) {
            rows += ChatRow("files-title", "files") { body("这轮记录到的文件", true) }
            rows += ChatRow("files", files.joinToString("\n")) { AppUi.surface(activity).apply { files.forEach { addView(code(it)) } } }
        }
        rows += ChatRow("checks", "unknown") { AshUi.vstack(activity, 4).apply {
            background = AshUi.rounded(c.surface2, d(16).toFloat()); setPadding(d(12), d(12), d(12), d(12))
            addView(AshUi.text(activity, "检查明细未取得", AshTokens.Type.headline))
            addView(body("当前返回的是文件与命令片段、原消息。没有完整差异或可独立核对的检查成绩。"))
        } }
        CodexEvidence.report(detail)?.let { report ->
            rows += ChatRow("report-title", "report") { body("Codex的原始汇报", true) }
            rows += ChatRow("report", report) { AppUi.surface(activity).apply { addView(body(report).apply { setTextIsSelectable(true) }) } }
        }
        rows += ChatRow("raw", "raw") { AppUi.button(activity, "打开这一轮的原始记录", AppAccent.BLUE, false) { rawRecord = true; paint(); place = draftKey()?.let(readingPlaces::get); paintTalk() } }
        rows += ChatRow("boundary", "boundary") { body("未取得合并/发布记录；工作结束不代表目标已经达成。", true) }
        for (op in ops.items()) if (op.to == state.device && op.body.optString("thread") == state.thread)
            rows += ChatRow(op.clientId, op.status + op.text) { opView(op) }
        input.hint = "告诉 Codex 要改哪里…"
        resultRows.submitList(rows)
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
            title.text = "新对话 · ${newIn.name}"; input.hint = "第一句话…"
            val mine = ops.items().filter { it.to == state.device && it.body.optString("op") == "new" && it.body.optString("cwd") == newIn.cwd }
            if (state.problem == null && mine.isEmpty()) rows += hintRow("在 ${newIn.cwd} 里开一个新的 Codex 会话，写下第一句话发出去。")
            for (op in mine) rows += ChatRow(op.clientId, op.status + "|" + op.text) { opView(op) }
        } else {
            title.text = state.title ?: "Codex"
            val dt = state.detail
            if (dt == null) { if (state.problem == null) rows += hintRow("正在读取…") }
            else {
                input.hint = if (dt.session.open) "跟 Codex 说…" else "跟 Codex 说…（会先在电脑上打开这个会话）"
                val meta = listOfNotNull(computerName(), projectName(dt.session), CodexEvidence.roundLabel(dt)).joinToString(" · ")
                rows += ChatRow("work-heading", meta + dt.session.title) { AshUi.vstack(activity, 8).apply {
                    addView(AshUi.text(activity, meta, AshTokens.Type.sub, c.text2))
                    addView(AshUi.text(activity, dt.session.title, AshTokens.Type.title))
                } }
                for (turn in dt.turns) turn.items.forEachIndexed { i, item ->
                    if (item.kind == "thinking" || (item.kind in setOf("user", "agent") && item.text.isBlank())) return@forEachIndexed
                    val actor = item.clientId?.let { actors[state.device + ":" + it] }
                        ?: if (ops.items().any { it.clientId == item.clientId && it.to == state.device }) "你" else "电脑上的消息"
                    rows += ChatRow(CodexModel.itemKey(turn, i), item.kind + "|" + item.text + "|" + actor) { itemView(item, actor) }
                }
                if (dt.session.running && dt.approvals.isEmpty()) rows += ChatRow("running", "running") { AshUi.text(activity, "在做事…", AshTokens.Type.caption, c.text3).apply { layoutParams = side(false) } }
                for (a in dt.approvals) rows += ChatRow("approval:" + a.requestId, a.summary + "|" + ((identity(state.device, dt.session.id) + "/" + a.requestId) in answering)) { approvalCard(a) }
                if (dt.session.running) rows += ChatRow("running-actions", "${identity(state.device, dt.session.id) in stopRequested}") { runningActions(state.device, dt.session.id) }
                if (dt.turns.isEmpty() && dt.approvals.isEmpty()) rows += hintRow("这个会话还没有内容")
            }
            // What waits keeps its client id as its key: the session's copy of it takes over the same row.
            val shown = rows.map { it.key }.toSet()
            for (op in ops.items()) if (op.to == state.device && op.body.optString("op") == "send" && op.body.optString("thread") == state.thread && op.clientId !in shown)
                rows += ChatRow(op.clientId, op.status + "|" + op.text) { opView(op) }
        }
        val read = newIn != null || state.detail != null
        FollowEnd.submit(talkList, talkLm, talkRows, rows, toEnd) {
            // Made again: back to the row that was at the top, if the session still shows it; else the newest.
            if (read) place?.let { a -> place = null; a.indexIn(rows)?.let { talkLm.scrollToPositionWithOffset(it, a.offset) } }
        }
    }

    private fun hintRow(s: String) = ChatRow("hint", s) {
        AshUi.text(activity, s, AshTokens.Type.callout, c.text3).apply { gravity = Gravity.CENTER; setPadding(d(8), d(24), d(8), d(8)) }
    }

    private fun side(mine: Boolean) = LinearLayout.LayoutParams(-2, -2).apply { gravity = if (mine) Gravity.END else Gravity.START }

    /** One bubble or tool line, on its own side of the row. */
    private fun itemView(i: CodexModel.Item, actor: String): View {
        val mine = i.kind == "user"
        val v = when (i.kind) {
            "user" -> AshUi.bubbleText(activity, i.text, true).apply { setTextIsSelectable(true) }
            "agent" -> AshUi.bubbleText(activity, Md.render(i.text, c.surface2, c.her), false).apply { setTextIsSelectable(true); movementMethod = LinkMovementMethod.getInstance() }
            else -> AshUi.text(activity, "▸ " + toolLabel(i), AshTokens.Type.sub, c.text2, maxLines = 2).apply {
                minimumHeight = d(48); gravity = Gravity.CENTER_VERTICAL; isClickable = true; isFocusable = true
                setOnClickListener { AlertDialog.Builder(activity).setTitle("本次返回的原文").setMessage(i.text).setPositiveButton("关闭", null).show() }
            }
        }
        return AshUi.vstack(activity, 2).apply {
            gravity = if (mine) Gravity.END else Gravity.START
            if (mine) addView(AshUi.text(activity, actor, AshTokens.Type.caption, c.text3), side(true))
            addView(v, side(mine))
        }
    }

    /** A message (or a new session) sent from here that the computer does not show yet: sending, sent, or not sent with 「重发」 and 「删掉」 (same client id). */
    private fun opView(op: Pending): View = AshUi.vstack(activity, 2).apply {
        gravity = Gravity.END
        addView(AshUi.bubbleText(activity, op.text, true).apply { alpha = 0.7f }, side(true))
        val status = when (op.status) {
            Pending.FAILED -> "没发出去"
            Pending.SENT -> "已发出，等待电脑显示"
            Pending.UNSENT -> "没有收到确认，可以重试"
            else -> if (op.body.optString("op") == "new") "正在电脑上开新会话…" else "发送中…"
        }
        addView(AshUi.hstack(activity, 12).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(AshUi.text(activity, status, AshTokens.Type.caption, c.text3))
            if (op.status in setOf(Pending.FAILED, Pending.UNSENT)) {
                addView(AshUi.button(activity, "重发", AshUi.Kind.GHOST, AshUi.BtnSize.SM) { ops.get(op.clientId)?.let { go(it) } })
                addView(AshUi.button(activity, "删掉", AshUi.Kind.GHOST, AshUi.BtnSize.SM) { ops.remove(op.clientId); paint() })
            }
        }, side(true))
    }

    private fun toolLabel(i: CodexModel.Item): String {
        val verb = when (i.kind) { "command" -> "运行"; "file" -> "改文件"; "tool" -> "调用"; "search" -> "搜索"; "plan" -> "计划"; else -> i.kind }
        return if (i.text.isBlank()) verb else "$verb ${i.text}"
    }

    private fun approvalCard(a: CodexModel.Approval, dev: String? = state.device, thread: String? = state.thread,
        workTitle: String = state.title.orEmpty(), context: String = listOfNotNull(computerName(), state.detail?.session?.let(::projectName)).joinToString(" · ")): View = AppUi.surface(activity, decision = true).apply {
        dividerDrawable = android.graphics.drawable.GradientDrawable().apply { setColor(android.graphics.Color.TRANSPARENT); setSize(0, d(8)) }
        addView(AshUi.hstack(activity, 8).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(AppUi.icon(activity, R.drawable.ash_ic_check, AppAccent.BLUE.color(activity)))
            addView(AshUi.text(activity, "需要你 · 本次操作", AshTokens.Type.sub, c.text2))
        })
        addView(AshUi.text(activity, workTitle.ifBlank { "允许本次操作？" }, AshTokens.Type.headline))
        addView(AshUi.text(activity, context, AshTokens.Type.sub, c.text2))
        addView(code(a.summary.ifEmpty { "请求说明未取得，请查看电脑上的原请求。" }))
        addView(AshUi.text(activity, "只允许本次操作；实际影响以原请求为准。", AshTokens.Type.sub, c.text2))
        val waiting = (identity(dev, thread.orEmpty()) + "/" + a.requestId) in answering
        addView(AshUi.hstack(activity, 8).apply {
            addView(AppUi.button(activity, if (waiting) "处理中…" else "仅本次允许", AppAccent.BLUE) { answer(a, "approve", dev, thread) }.apply { isEnabled = !waiting }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(AppUi.button(activity, "拒绝", AppAccent.BLUE, false) { answer(a, "deny", dev, thread) }.apply { isEnabled = !waiting }, LinearLayout.LayoutParams(0, -2, 1f))
        })
    }

    private fun gap(dp: Int) = object : RecyclerView.ItemDecoration() {
        override fun getItemOffsets(out: android.graphics.Rect, v: View, parent: RecyclerView, s: RecyclerView.State) { out.top = d(dp) }
    }

    companion object {
        const val STATE = "ai.ash.codex.route"
        private const val PLACE = "place"
        private const val OFFSET = "place.offset"
    }
}
