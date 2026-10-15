package ai.ash.ui

import android.animation.ValueAnimator
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Paint
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.text.method.LinkMovementMethod
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.DefaultItemAnimator
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import ai.ash.host.PresentRoutes
import ai.ash.R
import ai.ash.apps.Ui
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.Role
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * The chat, drawn natively (it was the web page's; it does what that page did). It reads and writes only through [port]:
 * the same words (`service:history window / current / activity.page`, `service:agents list`, `say`, the `ask` response) and
 * the same follow `sync`, which here only says "something changed" — the screen reads the newest window and the current state
 * again, once per burst. Older messages are read when the list is scrolled to the top. What the owner wrote waits in an outbox
 * (kept on the phone) until the kernel has it. Everything that moves is a small native view and redraws only itself.
 */
class ChatScreen(
    private val activity: Activity,
    private val port: HumanPort,
    private val files: ChatHooks.Files,
    private val home: ChatHooks.Home,
    private val onApps: () -> Unit,
    private val onCodex: () -> Unit = {},
) {
    private val ctx: Context = activity
    private val c = AshUi.p(ctx)
    private val main = Handler(Looper.getMainLooper())
    private fun dp(v: Int) = AshUi.dp(ctx, v)

    val view = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(c.bg) }
    private val avatar = OnboardingViews.avatar(ctx, "default", 36)
    private val nameLine = AshUi.text(ctx, "Ash", AshType(16f, 20f, 650, Role.INK))
    private val stateLine = AshUi.text(ctx, "", AshType(12f, 16f, 400, Role.TEXT_2))
    private val dots = Dots(ctx, c.her)
    private val banner = AshUi.text(ctx, "", AshType(12.5f, 17f, 400, Role.TEXT_2)).apply {
        background = AshUi.rounded(c.surface2, AshUi.dpF(ctx, 12f)); setPadding(dp(12), dp(8), dp(12), dp(8)); visibility = View.GONE
    }
    private val rowsAdapter = Rows()
    private val lm = LinearLayoutManager(ctx).apply { stackFromEnd = true }
    private val animator = DefaultItemAnimator().apply { supportsChangeAnimations = false; addDuration = AshTokens.Motion.message }
    /**
     * The conversation, laid out from its end as a chat is (`stackFromEnd`): when the list gets shorter (the keyboard is up,
     * the input grew) or a page of older messages comes in above, the list keeps the row at its bottom where it was, so the
     * reading place stays, and at the end the newest message stays right above the input. Rows are updated one by one
     * ([ChatRows.diff]): a refresh that changes nothing moves nothing. Only the owner's scrolling, 「回到底部」, sending, and a new
     * message arriving while the newest one is in sight move it ([paintList]).
     */
    private val list = RecyclerView(ctx).apply {
        layoutManager = lm; adapter = rowsAdapter; itemAnimator = animator
        // Every row stands 8 above the one under it (the first one's 8 is the list's top padding).
        setPadding(dp(14), 0, dp(14), PILL_ROOM); clipToPadding = false
        setItemViewCacheSize(12)
        addItemDecoration(object : RecyclerView.ItemDecoration() {
            override fun getItemOffsets(out: android.graphics.Rect, v: View, parent: RecyclerView, state: RecyclerView.State) { out.top = dp(8) }
        })
        addOnScrollListener(object : RecyclerView.OnScrollListener() {
            // A drag of the conversation puts the keyboard away; the list's own scrolling never does.
            override fun onScrollStateChanged(rv: RecyclerView, state: Int) { if (state == RecyclerView.SCROLL_STATE_DRAGGING) dropKeyboard() }
            override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                if (lm.findFirstVisibleItemPosition() in 0..2) loadOlder()
                paintToBottom()
            }
        })
    }
    /** Ids of the long messages the owner opened; kept here so a repaint or a page of older messages does not fold them again. */
    private val unfolded = HashSet<String>()
    /** New rows that came while the owner was reading further up: the 「回到底部」 button wears a dot until the bottom is reached. */
    private var unseenBelow = false
    private val toBottomDot = View(ctx).apply { background = AshUi.rounded(0xFFFF3B30.toInt(), AshUi.dpF(ctx, 5f)); visibility = View.GONE }
    private val toBottom = FrameLayout(ctx).apply {
        val s = dp(44)
        background = AshUi.rounded(c.surface, s / 2f, c.line, dp(1)); AshUi.cardShadow(this)
        isClickable = true; contentDescription = "回到最新消息"; alpha = 0f; visibility = View.GONE
        addView(View(ctx).apply { background = ctx.getDrawable(R.drawable.ash_ic_down)!!.mutate().apply { setTint(c.text) } }, FrameLayout.LayoutParams(dp(20), dp(20), Gravity.CENTER))
        addView(toBottomDot, FrameLayout.LayoutParams(dp(10), dp(10), Gravity.TOP or Gravity.END).apply { setMargins(0, dp(8), dp(8), 0) })
        setOnClickListener { if (rowsAdapter.itemCount > 0) list.smoothScrollToPosition(rowsAdapter.itemCount - 1) }
    }
    private val scrollHost = FrameLayout(ctx)
    private val deck = AshUi.vstack(ctx, 0)
    private val stage = FrameLayout(ctx).apply { clipChildren = true }
    /** While the owner has lent the screen: who, how long is left, and a tap takes it back. */
    private val leaseBar = AshUi.text(ctx, "", AshType(12.5f, 16f, 500, Role.TEXT)).apply {
        gravity = Gravity.CENTER; visibility = View.GONE; setPadding(dp(12), dp(7), dp(12), dp(7)); contentDescription = "屏幕授权中，点这里收回"
        background = AshUi.rounded(0xFFFFE2A8.toInt(), AshUi.dpF(ctx, 10f))
        setOnClickListener { LeaseState.revoke(ctx) }
    }
    private val onLease: () -> Unit = { paintLease() }
    private val pillSlot = FrameLayout(ctx)
    private val input = EditText(ctx)
    private val target = AshUi.text(ctx, "", AshType(12f, 16f, 500, Role.TEXT_2)).apply { visibility = View.GONE }
    /** Files chosen so far (photos, videos, files), sent with the next message. */
    private var picked = JSONArray()
    /** The send button shows stop; the turn a stop was asked for (hidden from the button until it ends or the stop fails). */
    private var stopMode = false
    private var stopping: String? = null
    /** Send, or stop while a turn runs (see [paintAction]); declared before `init`, which builds the composer with it. */
    private val action: FrameLayout by lazy {
        AshUi.iconButton(ctx, ctx.getDrawable(R.drawable.ash_ic_up)!!, "发送", filled = true) {
            val turn = runningTurn()
            if (stopMode && turn != null) { stopTurn(turn); return@iconButton }
            val t = input.text.toString().trim()
            if (t.isEmpty() && picked.length() == 0) return@iconButton
            if (!Uploads.fits(t, picked)) { toast("附件太大：一条消息最多带约 3 MB"); return@iconButton }
            send(t, picked)
        } as FrameLayout
    }
    private val pickedChip = AshUi.hstack(ctx, 2).apply {
        background = AshUi.rounded(c.youSoft, AshUi.dpF(ctx, 15f)); setPadding(dp(12), 0, dp(2), 0); visibility = View.GONE
    }

    /** The conversation as last read (only a successful read changes it). */
    private val window = ChatWindow()
    private var loadingOlder = false
    private val FOLD_LINES = 4
    private var current: JSONObject? = null
    private var refreshQueued = false
    /** One read of the newest window at a time; changes heard meanwhile make one more read after it. */
    private var reading = false
    private var readAgain = false
    private var lastTyping = 0L
    private var shown = false
    private var agents = JSONArray()
    private var chosen: String? = null
    /** Her name as her home page reads it from IDENTITY.md: the bar and the box's hint follow it. */
    private var herName = "Ash"
    private val outbox = ChatOutbox(ctx)
    /** What the owner typed and has not sent, per agent talked to; the box shows the one of [chosen]. */
    private val drafts = UiDrafts.get(ctx)
    private fun draftKey() = Drafts.chat(chosen)
    /** A message being stored (between the send tap and its being kept): a second tap does not store it twice. */
    private var storing = false
    /** Cards drawn from a plan (`show {a2ui}`, `form`): what the owner does on them is kept there across repaints. */
    private val cards by lazy { ChatCards(activity, port, { to, body -> post(to, body) }, ::toast) { refresh() } }
    private var flushing = false
    private val tick = object : Runnable { override fun run() { paintProgress(); paintLease(); if (shown) main.postDelayed(this, 1_000) } }
    private val onChange: () -> Unit = { refresh() }

    init {
        view.addView(header(), LinearLayout.LayoutParams(-1, dp(56)))
        view.addView(banner, LinearLayout.LayoutParams(-1, -2).apply { setMargins(dp(14), 0, dp(14), dp(4)) })
        view.addView(leaseBar, LinearLayout.LayoutParams(-1, -2).apply { setMargins(dp(14), 0, dp(14), dp(4)) })
        LeaseState.onChange(onLease)
        scrollHost.addView(list, FrameLayout.LayoutParams(-1, -1))
        scrollHost.addView(toBottom, FrameLayout.LayoutParams(dp(44), dp(44), Gravity.BOTTOM or Gravity.END).apply { setMargins(0, 0, dp(14), PILL_ROOM) })
        // The progress pill floats over the bottom of the conversation, in room the list always keeps for it: its coming and
        // going changes no layout, so the conversation never moves for it.
        scrollHost.addView(pillSlot, FrameLayout.LayoutParams(-2, -2, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply { bottomMargin = dp(6) })
        // The conversation and the input are one piece standing on the keyboard: [deck] holds them, and the keyboard moves it
        // (see [keyboard]); [stage] is the room under the header, so the piece slides under the header, not over it.
        deck.addView(scrollHost, LinearLayout.LayoutParams(-1, 0, 1f))
        deck.addView(composer(), LinearLayout.LayoutParams(-1, -2))
        stage.addView(deck, FrameLayout.LayoutParams(-1, -1))
        view.addView(stage, LinearLayout.LayoutParams(-1, 0, 1f))
        port.onChange(onChange)
        port.onLink { open ->
            // What was asked over the old link no longer counts (it is answered as failed, and dropped).
            window.invalidate(); reading = false
            paintPresence(); paintStatus()
            if (open) { loadAgents(); refresh(); flush() }
        }
        loadDraft()
        outbox.whenReady { paintList(); flush() }
    }

    fun close() { port.removeChange(onChange); LeaseState.removeChange(onLease); cards.close() }

    private fun paintLease() {
        val first = LeaseState.leases.firstOrNull()
        leaseBar.visibility = if (first == null) View.GONE else View.VISIBLE
        if (first != null) leaseBar.text = "屏幕授权中 · ${first.name} · 剩 ${first.clock()} · 点这里收回"
    }

    fun shown(visible: Boolean) {
        shown = visible
        port.presence(visible = visible)
        main.removeCallbacks(tick)
        if (visible) { refresh(); tick.run() }
    }

    // --- reading ---

    /**
     * Reads the newest window and the current state again; a burst of changes is one read, and one read is out at a time.
     * A failed read keeps what is shown and says so ([paintStatus]); an answer from before the link changed is dropped.
     */
    private fun refresh() {
        if (!port.open) return
        if (reading) { readAgain = true; return }
        if (refreshQueued) return
        refreshQueued = true
        main.postDelayed({
            refreshQueued = false
            if (!port.open) return@postDelayed
            reading = true
            val gen = window.begin()
            var win: JSONObject? = null
            var now: JSONObject? = null
            var answered = 0
            fun both() {
                if (++answered < 2) return
                if (gen != window.generation) return
                reading = false
                window.newest(gen, win, System.currentTimeMillis())
                now?.let { current = it }
                outbox.drop(window.clientIds(), window.ids())
                paintPresence(); paintProgress(); paintList(); paintStatus(); flush()
                if (readAgain) { readAgain = false; refresh() }
                else if (window.failedAt > 0 && shown) main.postDelayed({ refresh() }, 5_000)
            }
            port.call("service:history", "window", JSONObject().put("limit", PAGE)) { data, failure -> win = if (failure == null) data else null; both() }
            port.call("service:history", "current", JSONObject().put("limit", PAGE)) { data, failure -> now = if (failure == null) data else null; both() }
        }, 150)
    }

    private fun loadOlder() {
        if (!window.moreBefore || loadingOlder || !port.open || window.items.isEmpty()) return
        loadingOlder = true
        val before = window.items.firstKey()
        port.call("service:history", "window", JSONObject().put("limit", PAGE).put("before", before)) { data, failure ->
            loadingOlder = false
            if (failure != null) return@call
            window.older(data)
            paintList()
        }
    }

    private fun loadAgents() = port.call("service:agents", "list") { data, _ ->
        agents = data?.optJSONArray("agents") ?: JSONArray()
        paintTarget()
    }

    // --- writing ---

    /**
     * The send button (MOBILE-ARCH §3.5, §4.2): the message is stored first; only once it is kept do the words and the files
     * leave the box — and only those: what the owner typed meanwhile stays. Not kept (the disk refused): it all stays, and
     * the owner is told. The box keeps its focus and the keyboard stays up.
     */
    private fun send(text: String, attachments: JSONArray) {
        if (storing) return
        val key = draftKey()
        val body = JSONObject().put("text", text)
        if (attachments.length() > 0) body.put("attachments", attachments)
        storing = true
        post(chosen, body) { kept ->
            storing = false
            if (!kept) { toast("这条消息没能存下来，还在输入框里，再点一次发送试试"); return@post }
            if (draftKey() == key && input.text.toString().trim() == text) input.setText("")
            if (picked === attachments) { picked = JSONArray(); paintPicked(); keepPicked() }
        }
    }

    private fun say(text: String, option: Pair<String, String>? = null) {
        if (text.isBlank()) return
        val body = JSONObject().put("text", text)
        option?.let { body.put("in_reply_to", it.first).put("option_id", it.second) }
        post(chosen, body)
    }

    /** The owner's `say` [body] to [to] (null: the primary agent, decided when it goes), through the outbox (a card's action goes this way too). */
    private fun post(to: String?, body: JSONObject, kept: ((Boolean) -> Unit)? = null) {
        outbox.add(Pending(UUID.randomUUID().toString(), to, body, at = System.currentTimeMillis())) { ok ->
            if (ok) { paintList(toEnd = true); flush() } else if (kept == null) toast("没能存下这条消息，再试一次")
            kept?.invoke(ok)
        }
    }

    /** Sends what waits, oldest first, one at a time, each with its own client id however often it is tried; a lost connection leaves the rest for the next one. */
    private fun flush() {
        if (flushing || !port.open || !outbox.ready) return
        val next = outbox.next() ?: return
        // Written before the primary agent was known: it waits until it is.
        val request = next.request(port.primary) ?: return
        flushing = true
        port.send(request) { r ->
            flushing = false
            if (r.optBoolean("ok")) { outbox.taken(next.clientId, r.optJSONObject("message")?.optString("id")); refresh(); flush() }
            else {
                val code = r.optJSONObject("error")?.optString("code").orEmpty()
                if (code in RETRY) { outbox.mark(next.clientId, Pending.UNSENT); main.postDelayed({ flush() }, 3_000) }
                else outbox.mark(next.clientId, Pending.FAILED)
                paintList()
            }
        }
    }

    /** The owner's answer to [ask]: the same route and message as the island's and a notification's ([PresentRoutes.answer]). */
    private fun answer(ask: JSONObject, choice: String, text: String? = null) {
        val opts = ask.optJSONArray("options") ?: JSONArray()
        val offered = (0 until opts.length()).mapNotNull { opts.optJSONObject(it)?.optString("id") }.toSet()
        val route = runCatching {
            PresentRoutes.answer(ask.optString("id"), ask.optString("from"), offered, choice, text, ask.optBoolean("allow_custom"),
                ask.optLong("expires_at"), System.currentTimeMillis())
        }.getOrNull() ?: run { toast("这个问题已经结束了"); refresh(); return }
        port.send(PresentRoutes.answerMessage(route, PresentRoutes.answerClientId(ask.optString("id")))) { r ->
            if (!r.optBoolean("ok")) toast("没有送到，再点一次试试")
            refresh()
        }
    }

    // --- the screen ---

    private fun header(): View = AshUi.hstack(ctx, 10).apply {
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(14), 0, dp(6), 0)
        val who = AshUi.hstack(ctx, 10).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(avatar, LinearLayout.LayoutParams(dp(36), dp(36)))
            addView(AshUi.vstack(ctx).apply {
                addView(nameLine)
                addView(AshUi.hstack(ctx, 4).apply { gravity = Gravity.CENTER_VERTICAL; addView(stateLine); addView(dots, LinearLayout.LayoutParams(dp(20), dp(8))) })
            })
            setOnClickListener { home.open() }
            contentDescription = "打开她的主页"
        }
        addView(who, LinearLayout.LayoutParams(0, -2, 1f))
        addView(AshUi.button(ctx, "Codex", AshUi.Kind.GHOST, AshUi.BtnSize.SM) { onCodex() }.apply { contentDescription = "电脑上的 Codex" })
        addView(AshUi.iconButton(ctx, ctx.getDrawable(R.drawable.ash_ic_grid)!!, "应用") { onApps() })
    }

    private fun composer(): View = AshUi.vstack(ctx, 4).apply {
        setPadding(dp(12), dp(4), dp(12), dp(10))
        target.setOnClickListener { pickTarget() }
        addView(pickedChip, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = dp(52) })
        addView(AshUi.hstack(ctx, 8).apply {
            gravity = Gravity.BOTTOM
            addView(AshUi.iconButton(ctx, ctx.getDrawable(R.drawable.ash_ic_plus)!!, "加附件") {
                files.pick { chosen ->
                    // Files picked one choice after another add up until sent (at most 32); a new pick never drops the earlier ones.
                    for (i in 0 until chosen.length()) if (picked.length() < Uploads.MAX_ATTACHMENTS) picked.put(chosen.get(i))
                    paintPicked(); keepPicked()
                }
            })
            input.apply {
                hint = "跟 Ash 说…"
                AshUi.style(this, AshTokens.Type.chat, c.text)
                setHintTextColor(c.text3)
                background = AshUi.rounded(c.surface, AshUi.dpF(ctx, 20f), c.line, dp(1))
                setPadding(dp(14), dp(10), dp(14), dp(10))
                minHeight = dp(44); maxLines = 6
                imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, d: Int) {}
                    override fun onTextChanged(s: CharSequence?, a: Int, b: Int, d: Int) {}
                    override fun afterTextChanged(s: Editable?) {
                        if (restoring) return
                        drafts.keep(draftKey(), s?.toString().orEmpty())
                        val now = System.currentTimeMillis()
                        if (!s.isNullOrEmpty() && now - lastTyping > 3_000) { lastTyping = now; port.presence(typing = true) }
                        if (s?.toString() == "@") pickTarget()
                    }
                })
            }
            // Whom the message goes to sits in the row, beside the box: shown or not, it never changes the composer's height.
            addView(target, LinearLayout.LayoutParams(-2, -2).apply { bottomMargin = dp(12) })
            addView(input, LinearLayout.LayoutParams(0, -2, 1f))
            addView(action)
            input.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, d: Int) {}
                override fun onTextChanged(s: CharSequence?, a: Int, b: Int, d: Int) {}
                override fun afterTextChanged(s: Editable?) { paintAction() }
            })
        })
    }

    /** The turn the owner can stop from here: a front turn that has not ended (the same one the progress pill shows), else null. */
    private fun runningTurn(): String? {
        val p = current?.optJSONObject("progress") ?: return null
        if (p.optBoolean("background") || (p.has("ended") && !p.isNull("ended"))) return null
        return p.optString("id").takeIf { it.isNotEmpty() && it != stopping }
    }

    /** While a turn runs and nothing is typed or picked, the send button is a stop button; typing brings send back (to add to the task). */
    private fun paintAction() {
        val stop = runningTurn() != null && input.text.isNullOrBlank() && picked.length() == 0
        if (stop == stopMode) return
        stopMode = stop
        val icon = ctx.getDrawable(if (stop) R.drawable.ash_ic_stop else R.drawable.ash_ic_up)!!.mutate().apply { setTint(c.text) }
        action.getChildAt(0).background = icon
        action.contentDescription = if (stop) "停止" else "发送"
    }

    /** Stops the running turn with the hub's own stop word (what the island's stop sends); the button is back as send once the turn is over. */
    private fun stopTurn(turn: String) {
        stopping = turn; paintAction()
        port.send(JSONObject().put("to", "service:reflex").put("kind", "request").put("word", "task.stop")
            .put("body", JSONObject().put("turn", turn)).put("wait", true).put("client_id", java.util.UUID.randomUUID().toString())) { r ->
            val data = r.optJSONObject("response")?.takeIf { it.optBoolean("ok") }?.optJSONObject("result")?.optJSONObject("data")
            if (data?.optBoolean("cancelled") != true) { stopping = null; toast("没能停下，再点一次试试") }
            refresh()
        }
    }

    /** 「N 个附件」 with a ✕ to take them all off, above the text field while something is picked. */
    private fun paintPicked() {
        paintAction()
        pickedChip.removeAllViews()
        pickedChip.visibility = if (picked.length() == 0) View.GONE else View.VISIBLE
        if (picked.length() == 0) return
        pickedChip.addView(AshUi.text(ctx, "${picked.length()} 个附件", AshType(12.5f, 18f, 400, null), c.youText))
        pickedChip.addView(FrameLayout(ctx).apply {
            contentDescription = "移除附件"; isClickable = true
            addView(View(ctx).apply { background = ctx.getDrawable(R.drawable.ash_ic_x)!!.mutate().apply { setTint(c.youText) } }, FrameLayout.LayoutParams(dp(14), dp(14), Gravity.CENTER))
            setOnClickListener { picked = JSONArray(); paintPicked(); keepPicked() }
        }, LinearLayout.LayoutParams(dp(30), dp(30)))
    }

    private fun paintTarget() {
        val name = nameOf(chosen ?: port.primary)
        target.text = "$name ›"
        target.visibility = if (agents.length() > 1) View.VISIBLE else View.GONE
        input.hint = "跟 $name 说点什么…"
    }

    private fun nameOf(id: String?): String {
        if (id != null && id == port.primary) return herName
        for (i in 0 until agents.length()) agents.optJSONObject(i)?.let { if (it.optString("id") == id) return it.optString("name").ifEmpty { "Ash" } }
        return "Ash"
    }

    /** 「跟谁说」: Ash, or one of the helpers she runs. */
    private fun pickTarget() {
        if (agents.length() == 0) { loadAgents(); return }
        val names = (0 until agents.length()).map { i -> agents.optJSONObject(i).let { a ->
            val state = if (a.optBoolean("reachable", true).not()) "暂时用不了" else if (a.optString("state") == "starting") "启动中"
                else a.optString("summary").ifEmpty { if (a.optBoolean("primary")) "在线" else "就绪" }
            "${a.optString("name")} · $state"
        } }
        AlertDialog.Builder(ctx).setTitle("跟谁说").setItems(names.toTypedArray()) { _, i ->
            if (input.text.toString().startsWith("@")) input.setText(input.text.toString().removePrefix("@").trimStart())
            val next = agents.optJSONObject(i)?.optString("id")?.takeIf { it != port.primary }
            // Each agent has its own draft: switching puts this one away and brings that one back.
            if (next != chosen) { chosen = next; loadDraft() }
            paintTarget(); focusInput()
        }.show()
    }

    private fun paintPresence() {
        val presence = current?.optJSONObject("presence")
        val state = presence?.optString("state")
        val face = when (state) { "thinking" -> "thinking"; "working" -> "focused"; "waiting_you", "listening" -> "listening"; "resting" -> "resting"; "done" -> "success"; else -> "default" }
        avatar.image = OnboardingViews.face(ctx, face)
        avatar.state = when {
            !port.open -> AshUi.AvatarView.State.OFFLINE
            state == "thinking" || state == "listening" -> AshUi.AvatarView.State.THINKING
            state == "working" -> AshUi.AvatarView.State.WORKING
            state == "waiting_you" -> AshUi.AvatarView.State.WAITING
            else -> AshUi.AvatarView.State.ONLINE
        }
        val text = presence?.optString("text").orEmpty().ifEmpty {
            when (state) { "thinking" -> "正在想"; "working" -> "在忙"; "waiting_you" -> "等你一句话"; "listening" -> "在听"; "resting" -> "休息中"; null -> "状态待同步"; else -> "在线" }
        }
        stateLine.text = if (port.open) text else "连接中…"
        stateLine.setTextColor(when { !port.open -> c.text3; state == "waiting_you" -> c.warn; state in setOf("thinking", "working", "listening") -> c.her; else -> c.text2 })
        dots.visibility = if (port.open && state == "thinking") View.VISIBLE else View.GONE
    }

    /** The line above the conversation: the link is down, or the last read failed (what is shown may be behind). */
    private fun paintStatus() {
        val text = when {
            !port.open -> "暂时连不上 Ash。你写的消息会先存着，连上就发。"
            window.failedAt > 0 -> "没读到最新消息（${java.text.SimpleDateFormat("HH:mm", java.util.Locale.CHINA).format(java.util.Date(window.failedAt))}），稍后会再试。"
            else -> null
        }
        banner.text = text.orEmpty()
        banner.visibility = if (text == null) View.GONE else View.VISIBLE
    }

    private fun paintProgress() {
        pillSlot.removeAllViews()
        paintAction()
        val p = current?.optJSONObject("progress") ?: return
        if (p.optBoolean("background")) return
        val now = System.currentTimeMillis()
        val ended = if (p.has("ended") && !p.isNull("ended")) p.optLong("ended") else null
        if (ended != null && now - ended >= 60_000) return
        val steps = p.optJSONArray("steps") ?: JSONArray()
        val count = p.optInt("step_count", steps.length())
        if (ended != null && count == 0) return
        val seconds = ((minOf(now, ended ?: now) - p.optLong("started")) / 1000).coerceAtLeast(0)
        val label = if (ended != null) "做了 $count 步" else steps.optJSONObject(steps.length() - 1)?.optString("label").orEmpty().ifEmpty { "正在处理" }
        val pill = AshUi.progressPill(ctx, label, "$seconds 秒 ›", running = ended == null)
        pill.setOnClickListener { activitySheet(p) }
        pillSlot.addView(pill)
    }

    /** What she did in this turn (`activity.page`), newest last. */
    private fun activitySheet(p: JSONObject) = port.call("service:history", "activity.page", JSONObject().put("turn", p.optString("id")).put("limit", 100)) { data, _ ->
        val steps = data?.optJSONArray("items") ?: p.optJSONArray("steps") ?: JSONArray()
        val lines = (0 until steps.length()).mapNotNull { steps.optJSONObject(it) }.joinToString("\n") { s ->
            val mark = when (s.optString("state")) { "ok" -> "✓"; "failed" -> "✕"; else -> "…" }
            "$mark ${s.optString("label").ifEmpty { s.optString("summary") }}"
        }.ifEmpty { "还没有做什么。" }
        AlertDialog.Builder(ctx).setTitle("她在做的事").setMessage(lines).setPositiveButton("好", null).show()
    }

    /** The round 「回到底部」 button: up once the owner has scrolled more than a screen away from the newest message; its dot says something new came meanwhile. */
    private fun paintToBottom() {
        val away = list.computeVerticalScrollRange() - list.computeVerticalScrollOffset() - list.computeVerticalScrollExtent()
        val show = away > list.height
        if (!list.canScrollVertically(1)) unseenBelow = false
        toBottomDot.visibility = if (unseenBelow) View.VISIBLE else View.GONE
        val up = toBottom.visibility == View.VISIBLE && toBottom.tag == true
        if (show == up) return
        toBottom.tag = show
        if (show) { toBottom.visibility = View.VISIBLE; toBottom.animate().alpha(1f).setDuration(150).start() }
        else toBottom.animate().alpha(0f).setDuration(150).withEndAction { if (toBottom.tag != true) toBottom.visibility = View.GONE }.start()
    }

    /**
     * Hands the list its rows; only the rows that changed are drawn again. The list moves only when: [toEnd] (the owner sent),
     * a new row came at the end while the end was in sight (it stays in sight), or it is the first fill (it opens at the end,
     * without rows rising in). A new row at the end while the owner reads further up leaves the place alone and dots 「回到底部」.
     * [then] runs once the list has the rows.
     */
    private fun paintList(toEnd: Boolean = false, then: (() -> Unit)? = null) {
        val emptyText = when { !port.open -> "正在连接…"; window.failedAt > 0 -> "暂时读不到消息，稍后会再试。"; else -> "还没有消息，跟她说点什么吧。" }
        val next = ChatRows.build(window.items.values, outbox.items(), window.moreBefore, { note("往上翻看更早的消息") }, ::row, ::pending, outbox::sentAs)
            .ifEmpty { listOf(ChatRow(EMPTY, emptyText) { empty(emptyText) }) }
        val before = rowsAdapter.currentList
        val first = before.none { it.key != EMPTY } && next.first().key != EMPTY
        val atEnd = !list.canScrollVertically(1)
        val newAtEnd = !first && before.none { it.key == next.last().key }
        if (newAtEnd && !atEnd && !toEnd) unseenBelow = true
        if (first) {
            list.itemAnimator = null
            list.addOnLayoutChangeListener(object : View.OnLayoutChangeListener {
                override fun onLayoutChange(v: View, l: Int, t: Int, r: Int, b: Int, ol: Int, ot: Int, or: Int, ob: Int) {
                    v.removeOnLayoutChangeListener(this); list.itemAnimator = animator
                }
            })
        }
        rowsAdapter.submitList(next) {
            val back = if (first) restoreAnchor?.let { (key, offset) -> next.indexOfFirst { it.key == key }.takeIf { it >= 0 }?.let { it to offset } } else null
            if (first) restoreAnchor = null
            if (back != null && !toEnd) lm.scrollToPositionWithOffset(back.first, back.second)
            else if (toEnd || first || (newAtEnd && atEnd)) lm.scrollToPosition(next.size - 1)
            then?.invoke()
            paintToBottom()
        }
    }

    private fun empty(text: String): View = AshUi.text(ctx, text, AshTokens.Type.body, c.text3).apply { gravity = Gravity.CENTER; setPadding(0, dp(40), 0, 0) }

    /** Keeps [v]'s row's top where it is through the next layout (a bubble opening grows down, under the owner's finger). */
    private fun keepTop(v: View) {
        val row = list.findContainingItemView(v) ?: return
        val pos = list.getChildAdapterPosition(row).takeIf { it >= 0 } ?: return
        lm.scrollToPositionWithOffset(pos, lm.getDecoratedTop(row) - list.paddingTop)
    }

    private class Holder(val box: FrameLayout) : RecyclerView.ViewHolder(box)

    /** One holder per row on screen; binding draws the row with its own function ([ChatRow.make]), keeping the view's own size. */
    private inner class Rows : ListAdapter<ChatRow, Holder>(ChatRows.diff) {
        override fun onCreateViewHolder(parent: ViewGroup, type: Int) = Holder(FrameLayout(ctx).apply { layoutParams = RecyclerView.LayoutParams(-1, -2) })
        override fun onBindViewHolder(h: Holder, position: Int) {
            h.box.removeAllViews()
            val v = getItem(position).make() ?: return
            (v.parent as? ViewGroup)?.removeView(v)
            val lp = when (val own = v.layoutParams) {
                null -> FrameLayout.LayoutParams(-1, -2)
                is ViewGroup.MarginLayoutParams -> FrameLayout.LayoutParams(own)
                else -> FrameLayout.LayoutParams(own)
            }
            h.box.addView(v, lp)
        }
    }

    /** One item of the window (the projected conversation: `say`, `ask`, `card`, `failed`). */
    private fun row(item: JSONObject): View? = when (item.optString("type")) {
        "say" -> message(item)
        "ask" -> item.optJSONObject("ask")?.let { askCard(it) }
        "card" -> card(item)
        "failed" -> note("刚才这件事没做成。")
        else -> null
    }

    private fun message(item: JSONObject): View {
        val mine = item.optString("side") == "owner"
        val box = AshUi.vstack(ctx, 4).apply { gravity = if (mine) Gravity.END else Gravity.START }
        val text = item.opt("text").let { if (it is String) it else (it as? JSONObject)?.optString("text").orEmpty() }
        // Attachments stand above the words, as their own blocks; a message of attachments alone has no bubble.
        val attachments = item.optJSONArray("attachments") ?: JSONArray()
        for (i in 0 until attachments.length()) attachments.optJSONObject(i)?.let { a ->
            (files.attachment(item, a, mine) ?: AshUi.text(ctx, "📎 ${a.optString("name").ifEmpty { "附件" }}", AshTokens.Type.callout, c.text2))
                .let { box.addView(it, LinearLayout.LayoutParams(-2, -2).apply { gravity = if (mine) Gravity.END else Gravity.START }) }
        }
        if (text.isNotBlank()) {
            val bubble = AshUi.bubbleText(ctx, if (mine) text else Md.render(text, c.surface2, c.her) { files.openLink(it) }, mine)
            val side = LinearLayout.LayoutParams(-2, -2).apply { gravity = if (mine) Gravity.END else Gravity.START }
            box.addView(foldable(bubble, item.optString("id")), side)
        }
        val reactions = item.optJSONArray("reactions") ?: JSONArray()
        if (reactions.length() > 0) box.addView(AshUi.text(ctx, (0 until reactions.length()).joinToString(" ") { reactions.optJSONObject(it)?.optString("emoji").orEmpty() }, AshTokens.Type.callout),
            LinearLayout.LayoutParams(-2, -2).apply { gravity = if (mine) Gravity.END else Gravity.START })
        return box
    }

    /** A bubble longer than four lines shows four, fading out, with 「展开全文 ⌄」 under it ([FoldBubble], which decides it in one layout). */
    private fun foldable(bubble: TextView, id: String): View {
        val toggle = AshUi.text(ctx, "", AshTokens.Type.callout, bubble.currentTextColor).apply { alpha = 0.75f; setPadding(0, dp(4), 0, 0) }
        // The bubble's face (background, padding, shadow, outline) moves to the fold, which holds the text and, under it, the toggle.
        // Only an opened message is selectable (a selectable text takes the focus from the input); links work either way.
        fun selectable(open: Boolean) { bubble.setTextIsSelectable(open); bubble.movementMethod = LinkMovementMethod.getInstance() }
        val opened = id.isNotEmpty() && id in unfolded
        selectable(opened)
        val fold = FoldBubble(ctx, bubble, toggle, FOLD_LINES, dp(2), opened) { v, open ->
            if (id.isNotEmpty()) { if (open) unfolded.add(id) else unfolded.remove(id) }
            selectable(open)
            keepTop(v)
        }.apply {
            background = bubble.background
            setPadding(bubble.paddingLeft, bubble.paddingTop, bubble.paddingRight, bubble.paddingBottom)
            elevation = bubble.elevation; translationZ = bubble.translationZ; outlineProvider = bubble.outlineProvider
        }
        bubble.elevation = 0f; bubble.translationZ = 0f; bubble.outlineProvider = null
        bubble.background = null
        bubble.setPadding(0, 0, 0, 0)
        return fold
    }

    private fun pending(o: Pending): View {
        val body = o.body
        val box = AshUi.vstack(ctx, 2).apply { gravity = Gravity.END }
        val attached = body.optJSONArray("attachments") ?: JSONArray()
        for (i in 0 until attached.length()) attached.optJSONObject(i)?.let { a ->
            val kib = (Uploads.base64Size(a.optString("data")) + 1023) / 1024
            box.addView(AshUi.text(ctx, "${a.optString("name").ifEmpty { "附件" }} · $kib KiB", AshTokens.Type.callout, c.text2), LinearLayout.LayoutParams(-2, -2).apply { gravity = Gravity.END })
        }
        if (body.optString("text").isNotBlank() || attached.length() == 0)
            box.addView(AshUi.bubbleText(ctx, body.optString("text"), true).apply { alpha = 0.7f }, LinearLayout.LayoutParams(-2, -2).apply { gravity = Gravity.END })
        val status = when (o.status) { Pending.FAILED -> "没发出去 · 点这里删掉"; Pending.UNSENT -> "还没发出，连上就发"; else -> "发送中…" }
        box.addView(AshUi.text(ctx, status, AshType(11.5f, 15f, 400, Role.TEXT_3)).apply {
            if (o.status == Pending.FAILED) setOnClickListener { outbox.remove(o.clientId); paintList() }
        }, LinearLayout.LayoutParams(-2, -2).apply { gravity = Gravity.END })
        return box
    }

    private fun note(text: String): View = AshUi.text(ctx, text, AshType(12.5f, 16f, 400, Role.TEXT_3)).apply { gravity = Gravity.CENTER }

    private fun plainCard(label: String, title: String, body: String, tone: AshUi.Tone = AshUi.Tone.HER, icon: Int = R.drawable.ash_ic_ask): LinearLayout = AshUi.card(ctx).apply {
        if (label.isNotEmpty()) addView(AshUi.cardHeader(ctx, tone, ctx.getDrawable(icon)!!, label))
        if (title.isNotEmpty()) addView(AshUi.text(ctx, title, AshType(15f, 21f, 650, Role.INK)))
        if (body.isNotEmpty()) addView(AshUi.text(ctx, Md.render(body, c.surface2, c.her), AshTokens.Type.body, c.text2).apply { movementMethod = LinkMovementMethod.getInstance() })
    }

    private fun askCard(ask: JSONObject): View {
        val gate = ask.optString("from") == "service:gate"
        val name = if (gate) "需要你确认" else "${nameOf(ask.optString("from"))} 问你"
        return plainCard(name, ask.optString("title"), ask.optString("detail"), if (gate) AshUi.Tone.YOU else AshUi.Tone.HER, if (gate) R.drawable.ash_ic_shield else R.drawable.ash_ic_ask).apply {
            if (ask.has("original")) addView(AshUi.button(ctx, "查看完整原文", AshUi.Kind.GHOST, AshUi.BtnSize.SM) {
                AlertDialog.Builder(ctx).setTitle("完整原文").setMessage(ask.optString("original")).setPositiveButton("好", null).show()
            })
            val options = ask.optJSONArray("options") ?: JSONArray()
            val choice = ask.optString("choice").takeIf { it.isNotEmpty() && it != "null" }
            val pending = ask.optString("state") == "pending" && ask.optLong("expires_at") > System.currentTimeMillis()
            when {
                choice != null -> addView(AshUi.resolved(ctx, labelOf(options, choice, ask.optString("answer_text").ifEmpty { "已回答" }), ok = true))
                !pending -> addView(AshUi.resolved(ctx, if (ask.optString("state") == "expired") "已过期" else "已结束"))
                gate -> addView(AshUi.hstack(ctx, 8).apply {
                    for (i in 0 until options.length()) options.optJSONObject(i)?.let { o ->
                        val kind = when (o.optString("id")) { "deny", "no" -> AshUi.Kind.NEUTRAL; "always" -> AshUi.Kind.SECONDARY; else -> AshUi.Kind.PRIMARY }
                        addView(AshUi.button(ctx, o.optString("label"), kind, AshUi.BtnSize.MD) { answer(ask, o.optString("id")) }, LinearLayout.LayoutParams(0, dp(44), 1f))
                    }
                })
                else -> {
                    for (i in 0 until options.length()) options.optJSONObject(i)?.let { o -> addView(AshUi.option(ctx, o.optString("label")) { answer(ask, o.optString("id")) }) }
                    if (ask.optBoolean("allow_custom")) addView(custom { t -> answer(ask, PresentRoutes.CUSTOM, t) })
                }
            }
        }
    }

    private fun card(item: JSONObject): View? {
        val card = item.optJSONObject("card") ?: return null
        val chosenOption = item.optString("selected_option_id").takeIf { it.isNotEmpty() && it != "null" }
        return when (card.optString("type")) {
            "options" -> plainCard("${nameOf(port.primary)} 问你", card.optString("prompt").ifEmpty { "选一个" }, "").apply {
                val options = card.optJSONArray("options") ?: JSONArray()
                for (i in 0 until options.length()) options.optJSONObject(i)?.let { o ->
                    val id = o.optString("id")
                    addView(AshUi.option(ctx, o.optString("text"), selected = id == chosenOption, dimmed = chosenOption != null && id != chosenOption,
                        onClick = if (chosenOption == null) ({ say(o.optString("text"), option = item.optString("id") to id) }) else null))
                }
                if (chosenOption == null && card.optBoolean("allow_custom")) addView(custom { t -> say(t, option = item.optString("id") to "__custom") })
            }
            "file", "image" -> files.card(item, card) ?: plainCard(if (card.optString("type") == "image") "图片" else "文件", card.optString("name").ifEmpty { card.optString("alt") }, "", AshUi.Tone.MUTE, R.drawable.ash_ic_file)
            "link" -> plainCard("链接", card.optString("title").ifEmpty { card.optString("url") }, card.optString("summary"), AshUi.Tone.MUTE, R.drawable.ash_ic_link).apply {
                setOnClickListener { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(card.optString("url")))) } }
            }
            "a2ui" -> cards.view(item)
            "permission" -> plainCard("需要授权", "打开「${PERMISSIONS[card.optString("permission")] ?: "手机"}」权限", card.optString("why").ifEmpty { "需要授权" }, AshUi.Tone.YOU, R.drawable.ash_ic_lock).apply {
                addView(AshUi.button(ctx, "去授权", AshUi.Kind.PRIMARY, AshUi.BtnSize.SM) { ctx.startActivity(Intent(ctx, ConsoleActivity::class.java)) }, LinearLayout.LayoutParams(-2, -2))
            }
            "app" -> plainCard(card.optString("name"), "打开${card.optString("name")} · ${card.optString("title")}", card.optString("text"), AshUi.Tone.HER, R.drawable.ash_ic_grid).apply {
                setOnClickListener { runCatching { ctx.startActivity(Ui.appIntent(activity, card.optString("app"))) } }
            }
            else -> null
        }
    }

    /** 「自己说…」 under the options. */
    private fun custom(send: (String) -> Unit): View = AshUi.hstack(ctx, 8).apply {
        gravity = Gravity.CENTER_VERTICAL
        val field = EditText(ctx).apply {
            hint = "自己说…"; AshUi.style(this, AshTokens.Type.body, c.text); setHintTextColor(c.text3)
            background = AshUi.rounded(c.surface2, AshUi.dpF(ctx, 14f)); setPadding(dp(12), dp(8), dp(12), dp(8))
        }
        addView(field, LinearLayout.LayoutParams(0, -2, 1f))
        addView(AshUi.button(ctx, "发送", AshUi.Kind.SECONDARY, AshUi.BtnSize.SM) { field.text.toString().trim().takeIf { it.isNotEmpty() }?.let(send) })
    }

    private fun labelOf(options: JSONArray, id: String, fallback: String): String {
        for (i in 0 until options.length()) options.optJSONObject(i)?.let { if (it.optString("id") == id) return it.optString("label").ifEmpty { it.optString("text") } }
        return fallback
    }

    private fun toast(s: String) = android.widget.Toast.makeText(ctx, s, android.widget.Toast.LENGTH_SHORT).show()

    /** Setting the box from a stored draft: not a change of the draft. */
    private var restoring = false

    /** Brings back the draft of the agent talked to now: its words at once, its files once read from disk. */
    private fun loadDraft() {
        val key = draftKey()
        restoring = true
        input.setText(drafts.text(key)); input.setSelection(input.text.length)
        restoring = false
        picked = JSONArray(); paintPicked()
        UiDrafts.files(ctx, key) { files -> if (draftKey() == key && picked.length() == 0 && files.length() > 0) { picked = files; paintPicked() } }
    }

    /** The files picked for the draft go to disk (off the main thread), so they come back after the app is closed. */
    private fun keepPicked() = UiDrafts.keepFiles(ctx, draftKey(), picked)

    /** The agent talked to and where the conversation was read, for the activity to keep across its being made again. */
    fun save(out: android.os.Bundle) {
        chosen?.let { out.putString(STATE_TARGET, it) }
        anchor()?.let { (key, offset) -> out.putString(STATE_ANCHOR, key); out.putInt(STATE_OFFSET, offset) }
    }

    fun restore(saved: android.os.Bundle?) {
        saved ?: return
        val target = saved.getString(STATE_TARGET)
        if (target != chosen) { chosen = target; loadDraft(); paintTarget() }
        restoreAnchor = saved.getString(STATE_ANCHOR)?.let { it to saved.getInt(STATE_OFFSET) }
    }

    /** The row at the top of the conversation and how far below the list's top it starts; null at the newest message (it follows it). */
    private fun anchor(): Pair<String, Int>? {
        if (!list.canScrollVertically(1)) return null
        val pos = lm.findFirstVisibleItemPosition().takeIf { it >= 0 } ?: return null
        val row = lm.findViewByPosition(pos) ?: return null
        return rowsAdapter.currentList.getOrNull(pos)?.key?.let { it to (lm.getDecoratedTop(row) - list.paddingTop) }
    }

    /** Where to put the conversation once its rows are there again (after the activity was made again). */
    private var restoreAnchor: Pair<String, Int>? = null

    /** Her name changed (her home page read IDENTITY.md): the bar and the hint say it. */
    fun setName(name: String) { herName = name; nameLine.text = name; paintTarget() }

    /** Words from her home page go into the message box, which gets the cursor. */
    fun compose(text: String) { input.setText(text); input.setSelection(input.text.length); focusInput() }

    /** Shows message [id]: where it is when it is on screen, otherwise after reading the window around it. */
    fun jumpTo(id: String) {
        fun show() { rowsAdapter.currentList.indexOfFirst { it.id == id }.takeIf { it >= 0 }?.let { lm.scrollToPositionWithOffset(it, dp(60)) } }
        if (rowsAdapter.currentList.any { it.id == id }) { show(); return }
        port.call("service:history", "window", JSONObject().put("limit", PAGE).put("around_id", id)) { data, _ ->
            if (data == null) return@call
            window.older(data, keepMore = true)
            paintList(then = ::show)
        }
    }

    /**
     * The keyboard is moving and stands [px] above where the page's bottom is laid out: the conversation and the input ride on
     * it as one piece (a move of the drawing only, no layout). When it stops, the page is laid out for it and this is 0 again;
     * the conversation keeps its distance from the bottom through that layout, so nothing on screen changes.
     */
    fun keyboard(px: Int) { deck.translationY = -px.toFloat() }

    /** Put the keyboard away: the owner left the chat (another tab) or dragged the conversation, as in any chat app. */
    fun dropKeyboard() {
        if (!input.hasFocus()) return
        input.clearFocus()
        ctx.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(input.windowToken, 0)
    }

    /** Puts the cursor in the message box and raises the keyboard. */
    fun focusInput() {
        input.requestFocus()
        ctx.getSystemService(InputMethodManager::class.java)?.showSoftInput(input, 0)
    }

    /** The three dots after 「正在想」: a small view of its own, pulsing with a standard animator. */
    private class Dots(ctx: Context, color: Int) : View(ctx) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }
        private var t = 0f
        private val anim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 1_200; repeatCount = ValueAnimator.INFINITE; interpolator = android.view.animation.LinearInterpolator()
            addUpdateListener { t = it.animatedValue as Float; invalidate() }
        }
        override fun onVisibilityAggregated(isVisible: Boolean) {
            super.onVisibilityAggregated(isVisible)
            if (isVisible && AshUi.motionOn(context)) anim.start() else anim.cancel()
        }
        override fun onDraw(canvas: Canvas) {
            val r = height / 4f
            for (i in 0 until 3) {
                val phase = ((t - i * 0.17f) % 1f + 1f) % 1f
                paint.alpha = (255 * (0.25f + 0.75f * (1 - Math.abs(phase * 2 - 1)))).toInt()
                canvas.drawCircle(r + i * (r * 3.2f), height / 2f, r, paint)
            }
        }
    }

    /** Room the conversation always keeps at its bottom for the progress pill floating there (12 under the last row + the pill). */
    private val PILL_ROOM get() = dp(52)

    companion object {
        private const val PAGE = 60
        private const val EMPTY = "empty"
        private const val STATE_TARGET = "ai.ash.chat.target"
        private const val STATE_ANCHOR = "ai.ash.chat.anchor"
        private const val STATE_OFFSET = "ai.ash.chat.offset"
        private val RETRY = setOf("offline", "unavailable", "timeout", "result_unknown", "internal")
        private val PERMISSIONS = mapOf("calendar" to "日历", "notifications" to "通知", "battery" to "后台运行", "accessibility" to "无障碍",
            "photos" to "照片和文件", "all_files" to "所有文件", "usage" to "使用情况", "write_settings" to "系统设置", "overlay" to "悬浮窗")
    }
}
