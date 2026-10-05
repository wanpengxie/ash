package ai.ash.ui.island

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Choreographer
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import ai.ash.R
import ai.ash.host.AppState
import ai.ash.host.TaskStatus
import ai.ash.ui.HomeActivity
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The task island drawn natively. Android moves an overlay window before the app's next frame reaches the screen, so
 * an island whose window moves while it morphs shows off its place for a frame or more. With Ash's accessibility
 * service connected the island is drawn in a trusted accessibility overlay that never moves or resizes: a fixed band
 * across the top of the screen that takes no touch (trusted overlays pass touches through), with the island morphing
 * inside it; a transparent touch window follows the island and hands its touches over. Without the service, one app
 * overlay window wraps the island plus the reference's shadow inset and follows it frame by frame.
 */
internal object NativeIsland : IslandView.Actions {
    private val main = Handler(Looper.getMainLooper())
    private var app: Context? = null
    private var root: FrameLayout? = null
    private var island: IslandView? = null
    private var params: WindowManager.LayoutParams? = null
    private var attached = false
    /** Drawn in the accessibility service's trusted overlay (see the class note); decided at attach. */
    private var trusted = false
    private var host: WindowManager? = null
    private var pad: View? = null
    private var padParams: WindowManager.LayoutParams? = null
    private var islandW = 0; private var islandH = 0
    /** The window was taken away for a capture; coming back is a quiet fade, not an entrance. */
    private var capturedAway = false
    private var visible = false
    private var suppressed = 0
    private var passingTouches = 0
    @Volatile private var editing = false
    @Volatile private var screenBounds: Rect? = null
    private var snapshot: JSONObject? = null
    private var restore: (() -> Unit)? = null
    private var form = "compact"
    private var episode = ""
    private var centreX = -1
    /** How far the owner has dragged the island down from its place under the status bar. */
    private var offsetY = 0
    private var dragFromX = 0; private var dragFromY = 0
    private var maxCard = 0
    // host.js: the card shown, its local answer state, and the composer's state.
    private var selected: String? = null
    /** Answers sent from the island and not yet reflected by the agent (card id -> sending | answered | denied). */
    internal val submitted = mutableMapOf<String, String>()
    private var showOriginal = false
    private var customTarget: String? = null
    private var notice = ""
    private var sending = false
    private var attemptId = ""
    private var attemptText = ""

    /** The WebView island stays available behind a switch until the native one has been checked on phones. */
    fun enabled(ctx: Context) = !java.io.File(ctx.filesDir, "ash/island-web").exists()
    private fun switchText() = runCatching { app?.let { java.io.File(it.filesDir, "ash/island-native").readText() } }.getOrNull().orEmpty()
    fun ownsWindow(bounds: Rect) = screenBounds == bounds
    fun isEditing() = editing
    private fun dp(v: Float) = Math.round(v * (app?.resources?.displayMetrics?.density ?: 1f))
    private fun unlocked(ctx: Context) = !ctx.getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked &&
        ctx.getSystemService(android.os.PowerManager::class.java).isInteractive
    private fun allowed() = visible && suppressed == 0 && app?.let { unlocked(it) && !AppState.homeVisible && Settings.canDrawOverlays(it) } == true

    private fun ensure(ctx: Context) {
        if (island != null) return
        app = ctx.applicationContext
        IslandAvatar.preload(app!!)
        val view = IslandView(app!!, this)
        val box = FrameLayout(app!!).apply { clipChildren = false; clipToPadding = false; contentDescription = "AshTaskCapsule" }
        box.addView(view.shell, FrameLayout.LayoutParams(dp(IslandTokens.SIZE_COMPACT_W), dp(IslandTokens.SIZE_COMPACT_H)).apply {
            leftMargin = dp(IslandTokens.SIZE_WINDOW_INSET_SIDE); topMargin = dp(IslandTokens.SIZE_WINDOW_INSET_TOP)
        })
        @SuppressLint("ClickableViewAccessibility")
        view.input.setOnTouchListener { _, e -> if (e.action == MotionEvent.ACTION_DOWN) setEditing(true); false }
        view.onFrame = { w, h -> follow(w, h) }
        view.onReserve = { h -> fitBand(h, grow = true) }
        view.onSettled = { h -> fitBand(h, grow = false) }
        view.input.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            // A draft started under an open question belongs to it, even if the question closes before it is sent.
            override fun afterTextChanged(s: android.text.Editable?) { if (customTarget == null && !s.isNullOrEmpty()) customTarget = answering() }
        })
        // The card is never taller than the screen below it (the keyboard included); its middle scrolls instead.
        box.viewTreeObserver.addOnGlobalLayoutListener { if (attached && fitCard()) render() }
        root = box; island = view
        val prefs = app!!.getSharedPreferences("ash_capsule_input", Context.MODE_PRIVATE)
        attemptId = prefs.getString("pending_id", "").orEmpty(); attemptText = prefs.getString("pending_text", "").orEmpty()
        customTarget = prefs.getString("pending_question", null)
        if (attemptText.isNotEmpty()) view.input.setText(attemptText)
        pad = object : View(app!!) {
            @SuppressLint("ClickableViewAccessibility")
            override fun onTouchEvent(event: MotionEvent): Boolean {
                val band = params ?: return false; val at = padParams ?: return false
                val forwarded = MotionEvent.obtain(event)
                forwarded.offsetLocation((at.x - band.x).toFloat(), (at.y - band.y).toFloat())
                box.dispatchTouchEvent(forwarded); forwarded.recycle()
                return true
            }
        }.apply { contentDescription = "AshTaskCapsule"; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO }
    }

    /** Places the island for its size this frame: inside the fixed band (trusted), or by moving its own window. */
    private fun follow(w: Int, h: Int) {
        val ctx = app ?: return; val p = windowParams(ctx)
        val screen = ctx.resources.displayMetrics.widthPixels
        if (centreX < 0) centreX = screen / 2
        islandW = w; islandH = h
        val side = dp(IslandTokens.SIZE_WINDOW_INSET_SIDE); val top = dp(IslandTokens.SIZE_WINDOW_INSET_TOP)
        val shell = island?.shell ?: return
        val lp = shell.layoutParams as FrameLayout.LayoutParams
        if (trusted) {
            // The band never changes; only the island moves and resizes in it, in the band's own frame.
            val left = (centreX - w / 2).coerceIn(0, (screen - w).coerceAtLeast(0))
            if (lp.leftMargin != left || lp.topMargin != top) { lp.leftMargin = left; lp.topMargin = top; shell.layoutParams = lp }
            placePad(ctx, left, top, w, h)
            return
        }
        if (lp.leftMargin != side || lp.topMargin != top) { lp.leftMargin = side; lp.topMargin = top; shell.layoutParams = lp }
        p.width = w + 2 * side
        p.height = h + top + dp(IslandTokens.SIZE_WINDOW_INSET_BOTTOM)
        p.x = (centreX - p.width / 2).coerceIn(-side, (screen - p.width + side).coerceAtLeast(-side))
        p.y = offsetY
        if (attached) runCatching { host?.updateViewLayout(root, p) }
    }
    /**
     * The trusted band is as tall as the island needs, plus room for a spring's overshoot: never moved sideways, it
     * grows before a transition needs the room and shrinks once the island has settled (top-anchored, so a change of
     * height never shifts what is drawn). A band the height of the screen costs composition on every frame.
     */
    private fun fitBand(islandHeight: Int, grow: Boolean) {
        if (!trusted) return
        val ctx = app ?: return; val p = windowParams(ctx)
        val need = islandHeight + dp(IslandTokens.SIZE_WINDOW_INSET_TOP) + dp(IslandTokens.SIZE_WINDOW_INSET_BOTTOM) + dp(BAND_HEADROOM)
        if (grow && p.height >= need) return
        if (p.height == need) return
        p.height = need
        if (attached) runCatching { host?.updateViewLayout(root, p) }
    }
    private const val BAND_HEADROOM = 24f

    /** The touch window over the island (trusted mode); it draws nothing, so its own moves are never seen. */
    private fun placePad(ctx: Context, left: Int, top: Int, w: Int, h: Int) {
        val band = params ?: return
        val t = padParams ?: WindowManager.LayoutParams(w, h, overlayType(),
            // Screen coordinates, like the band: the touch window sits exactly over the island.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT).apply { gravity = Gravity.TOP or Gravity.LEFT; windowAnimations = R.style.CapsuleWindowAnimation; setTitle("AshTaskCapsule") }.also { padParams = it }
        t.width = w; t.height = h; t.x = band.x + left; t.y = band.y + top
        if (attached && pad?.isAttachedToWindow == true) runCatching { ctx.getSystemService(WindowManager::class.java).updateViewLayout(pad, t) }
    }
    private fun overlayType() = if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

    private fun windowParams(ctx: Context): WindowManager.LayoutParams = params ?: (if (trusted) WindowManager.LayoutParams(
        // The band: the screen's width, and tall enough for the tallest card with its inset. It never changes.
        ctx.resources.displayMetrics.widthPixels,
        dp(IslandTokens.SIZE_COMPACT_H + IslandTokens.SIZE_WINDOW_INSET_TOP + IslandTokens.SIZE_WINDOW_INSET_BOTTOM + BAND_HEADROOM),
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED, PixelFormat.TRANSLUCENT)
    else WindowManager.LayoutParams(
        dp(IslandTokens.SIZE_COMPACT_W + 2 * IslandTokens.SIZE_WINDOW_INSET_SIDE),
        dp(IslandTokens.SIZE_COMPACT_H + IslandTokens.SIZE_WINDOW_INSET_TOP + IslandTokens.SIZE_WINDOW_INSET_BOTTOM),
        overlayType(),
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
        PixelFormat.TRANSLUCENT)).apply {
        gravity = Gravity.TOP or Gravity.LEFT
        // The window's own 8dp top inset keeps the island 8dp below the status bar (tokens: topBelowStatusBar).
        x = if (trusted) 0 else (ctx.resources.displayMetrics.widthPixels - width) / 2
        y = if (trusted) statusBar(ctx) + offsetY else offsetY
        softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        windowAnimations = R.style.CapsuleWindowAnimation
        setTitle("AshTaskCapsule")
    }.also { params = it }

    fun prewarm(ctx: Context) { main.post { ensure(ctx) } }
    /** The trusted band is laid out in the whole screen; app overlays already start below the status bar. */
    private fun statusBar(ctx: Context): Int {
        val id = ctx.resources.getIdentifier("status_bar_height", "dimen", "android")
        return if (id > 0) ctx.resources.getDimensionPixelSize(id) else 0
    }

    /** A projected frame from [ai.ash.ui.IslandPresentation] (with [submitted]); host.js `receive`. */
    fun update(ctx: Context, model: JSONObject, restoreWith: () -> Unit) {
        ensure(ctx)
        val prev = snapshot; restore = restoreWith; visible = true
        val newTurn = prev?.optString("turn") != model.optString("turn") || prev?.optString("session") != model.optString("session")
        val cards = cards(model)
        val incoming = cards.firstOrNull { pending(it) && it.optString("localState").isEmpty() }
        // A turn's end is one episode however it is labelled: a verdict arriving later re-labels the card but must not
        // pop it open again after the owner collapsed it.
        val ended = model.optString("kind") in ENDED
        val reply = model.optString("reply")
        val next = listOf(model.optString("session"), model.optString("turn"), if (ended) "ended" else model.optString("kind"), incoming?.optString("id").orEmpty(), reply).joinToString("|")
        if (newTurn) { selected = null; showOriginal = false; island?.resetMore(); if (!sending) notice = ""; if (reply.isEmpty() && incoming == null) form = "compact" }
        val current = cards.firstOrNull { it.optString("id") == selected }
        if (incoming != null && (current == null || !pending(current) || current.optString("localState").isNotEmpty())) selected = incoming.optString("id")
        else if (incoming == null && ((reply.isNotEmpty() && ended) || (model.optBoolean("canStop") && cards.none { pending(it) }))) selected = null
        else if (current == null) selected = (incoming ?: cards.lastOrNull())?.optString("id")
        if (next != episode && (incoming != null || reply.isNotEmpty() || ended)) form = "card"
        episode = next
        snapshot = model
        // Answers the agent has taken up are no longer local.
        submitted.keys.retainAll(cards.filter { pending(it) }.map { it.optString("id") }.toSet())
        island?.reduceMotion = Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        island?.traceMotion = switchText().contains("motion")
        island?.setCardWidth(minOf(IslandTokens.SIZE_CARD_W, ctx.resources.displayMetrics.widthPixels / ctx.resources.displayMetrics.density - 24f))
        fitCard()
        render()
        if (!allowed()) { if (!unlocked(ctx) || AppState.homeVisible) setEditing(false); detach(); return }
        // The accessibility service can connect or go away while the island is up: move to the matching window.
        if (attached && trusted != (ai.ash.host.a11y.A11yService.instance != null) && !editing) detach()
        attach()
    }
    private val ENDED = setOf("reply", "result", "ask", "in_app", "incomplete", "stopped")
    private fun cards(model: JSONObject): List<JSONObject> = model.optJSONArray("cards")?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
    private fun pending(card: JSONObject) = card.optString("state") == "waiting"
    private fun active(): JSONObject? = snapshot?.let { m -> cards(m).firstOrNull { it.optString("id") == selected } }
    /** While a question that takes free-form answers is open, what the owner types answers it. */
    private fun openQuestion(c: JSONObject?) = c != null && c.optString("kind") != "approval" && c.optBoolean("allow_custom") && pending(c) && c.optString("localState").isEmpty()
    private fun answering(): String? = customTarget ?: active()?.takeIf { openQuestion(it) }?.optString("id")

    /** host.js `display` + `decorate`: the model the view draws. */
    private fun render() {
        val model = snapshot ?: return; val view = island ?: return
        val c = active()
        val stale = model.optBoolean("stale")
        val interactive = model.optBoolean("interactive")
        val pager = if (c != null && !stale && cards(model).size > 1) "${cards(model).indexOf(c) + 1} / ${cards(model).size}" else ""
        val base = IslandModel(kind = model.optString("kind"), form = form, elapsedSec = model.optLong("elapsed"), activity = model.optString("activity"),
            body = IslandText.plain(model.optString("reply")), canStop = model.optBoolean("canStop"), interactive = interactive,
            pager = pager, notice = notice.ifEmpty { model.optString("notice") }, busy = sending,
            placeholder = if (answering() != null) IslandKind.of("ask").placeholder.orEmpty() else "回复 Ash…")
        val shown = when {
            stale -> base.copy(kind = "stale")
            c == null -> base
            else -> {
                val approval = c.optString("kind") == "approval"
                val state = c.optString("localState").ifEmpty { c.optString("state") }
                val ap = when (state) { "waiting", "sending" -> "pending"; "answered" -> "approved"; "denied" -> "denied"; "expired" -> "expired"; else -> "settled" }
                val title = c.optString("title"); val detail = c.optString("detail")
                val live = pending(c) && c.optString("localState").isEmpty()
                val options = c.optJSONArray("options")?.let { a -> (0 until a.length()).map { a.optJSONObject(it)?.optString("label").orEmpty() } }.orEmpty()
                // How a question, or an approval the agent has since acted on, ended.
                val status = if ((!pending(c) && !approval) || (approval && ap == "settled")) when (c.optString("state")) {
                    "answered" -> "已回答"; "withdrawn" -> "已撤回"; "skipped" -> "未执行"; "redeemed" -> "已提交执行，结果见后续回复"
                    "expired" -> "已过期"; "denied" -> "已拒绝"; else -> "已处理"
                } else ""
                base.copy(kind = if (approval) "approval" else "ask",
                    // An approval reads as the reference lays it out: what Ash wants to do, then exactly what it would send, quoted.
                    body = if (approval) title else IslandText.plain(listOf(title, detail).filter { it.isNotBlank() }.joinToString("\n\n")),
                    quote = if (approval && detail.isNotBlank() && detail != title) detail else "",
                    approval = if (approval) ap else "", options = if (live) options else emptyList(), status = status,
                    original = c.optString("original"), showOriginal = approval && showOriginal, actionable = live)
            }
        }
        view.render(shown)
        // Development check of the layout against the reference (switch file says "dump").
        if (switchText().contains("dump"))
            view.shell.postDelayed({ android.util.Log.i("ash.island.dump", JSONObject().put("kind", shown.kind).put("form", form).put("bounds", view.debugBounds()).toString()) }, 2500)
    }
    /** The card's limit: the screen below the island, above the keyboard. True when it changed. */
    private fun fitCard(): Boolean {
        val ctx = app ?: return false; val box = root ?: return false
        val frame = Rect()
        val bottom = if (attached) { box.getWindowVisibleDisplayFrame(frame); frame.bottom } else ctx.resources.displayMetrics.heightPixels
        val top = (if (trusted || !attached) statusBar(ctx) else 0) + offsetY + dp(IslandTokens.SIZE_WINDOW_INSET_TOP)
        val limit = (bottom - top - dp(IslandSpec.CARD_BOTTOM_ROOM)).coerceAtLeast(dp(IslandSpec.CARD_MIN_LIMIT))
        if (limit == maxCard) return false
        maxCard = limit; island?.setMaxCardHeight(limit)
        return true
    }

    private fun attach() {
        if (attached || !allowed()) return
        val ctx = app ?: return; val box = root ?: return
        val service = ai.ash.host.a11y.A11yService.instance
        if (trusted != (service != null)) { trusted = service != null; params = null; padParams = null }
        host = service?.getSystemService(WindowManager::class.java) ?: ctx.getSystemService(WindowManager::class.java)
        runCatching {
            box.visibility = View.VISIBLE; box.alpha = 1f
            host!!.addView(box, windowParams(ctx))
            attached = true
            follow(islandW.takeIf { it > 0 } ?: dp(IslandTokens.SIZE_COMPACT_W), islandH.takeIf { it > 0 } ?: dp(IslandTokens.SIZE_COMPACT_H))
            if (trusted) padParams?.let { ctx.getSystemService(WindowManager::class.java).addView(pad, it) }
            applyTouchMode()
            box.post { rememberBounds() }
            if (capturedAway) { capturedAway = false; box.alpha = 0f; box.animate().alpha(1f).setDuration(180).start() }
            else box.post { island?.appear() }
        }.onFailure { android.util.Log.w("ash.island", "could not attach island", it) }
    }
    private fun rememberBounds() {
        if (!attached) { screenBounds = null; return }
        val box = root ?: return; val at = IntArray(2); box.getLocationOnScreen(at)
        screenBounds = Rect(at[0], at[1], at[0] + box.width, at[1] + box.height)
    }
    private fun detach() {
        if (!attached) return
        val ctx = app ?: return; val box = root ?: return
        box.visibility = View.INVISIBLE
        ctx.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(box.windowToken, 0)
        pad?.takeIf { it.isAttachedToWindow }?.let { runCatching { ctx.getSystemService(WindowManager::class.java).removeViewImmediate(it) } }
        runCatching { host?.removeViewImmediate(box) }
        attached = false; screenBounds = null
    }
    fun hide() { main.post {
        visible = false; setEditing(false); restore = null
        val view = island
        if (attached && view != null) view.leave { if (!visible) detach() } else detach()
    } }
    fun release() { main.post {
        visible = false; setEditing(false); detach(); root = null; island = null; params = null; padParams = null; snapshot = null; restore = null
        episode = ""; form = "compact"; selected = null; submitted.clear(); showOriginal = false; notice = ""; maxCard = 0
    } }

    private fun setEditing(value: Boolean) {
        if (value && (!allowed() || passingTouches > 0)) return
        if (editing == value) return
        editing = value
        applyTouchMode()
        val input = island?.input ?: return
        val ime = app?.getSystemService(InputMethodManager::class.java)
        if (value) input.post { input.requestFocus(); ime?.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT) }
        else { ime?.hideSoftInputFromWindow(input.windowToken, 0); input.clearFocus() }
    }
    private fun applyTouchMode() {
        val p = params ?: return
        val focus = if (editing) p.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv() and WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM.inv()
            else p.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        // The trusted band never takes touch; the single app window does unless the agent's gestures pass through.
        val flags = if (trusted || passingTouches > 0) focus or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE else focus and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        val alpha = if (passingTouches > 0) 0.7f else 1f
        if (p.flags != flags || p.alpha != alpha) {
            p.flags = flags; p.alpha = alpha
            if (attached) runCatching { host?.updateViewLayout(root, p) }
        }
        // In the trusted band, touch comes through the pad; the agent's own gestures pass under it.
        val t = padParams ?: return
        val padFlags = if (passingTouches > 0) t.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE else t.flags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        if (t.flags != padFlags) { t.flags = padFlags; if (attached && pad?.isAttachedToWindow == true) runCatching { app?.getSystemService(WindowManager::class.java)?.updateViewLayout(pad, t) } }
    }

    // ---- owner actions ----
    override fun tap() { if (form != "card") { form = "card"; render() } }
    override fun collapse() { setEditing(false); if (form != "compact") { form = "compact"; render() } }
    override fun close() {
        val model = snapshot ?: return
        if (model.optBoolean("mayClose")) TaskStatus.dismiss(model.getString("turn")) else collapse()
    }
    override fun open() {
        setEditing(false)
        app?.startActivity(Intent(app, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
    }
    override fun stop() {
        val model = snapshot ?: return
        if (model.optBoolean("canStop") && model.optBoolean("interactive")) TaskStatus.stop(model.getString("turn"))
    }
    override fun focus(editing: Boolean) { if (!editing) setEditing(false) }
    override fun choose(index: Int) {
        val c = active() ?: return
        c.optJSONArray("options")?.optJSONObject(index)?.optString("id")?.takeIf { it.isNotEmpty() }?.let { answer(c, it) }
    }
    override fun allow() { active()?.let { answer(it, "once") } }
    override fun deny() { active()?.let { answer(it, "deny") } }
    private fun answer(c: JSONObject, choice: String) {
        val id = c.optString("id")
        if (snapshot?.optBoolean("interactive") != true || !pending(c) || submitted.containsKey(id)) return
        submitted[id] = "sending"; restore?.invoke()
        TaskStatus.answerCard(id, choice) { ok, message ->
            main.post {
                if (ok) submitted[id] = if (choice == "deny") "denied" else "answered" else submitted.remove(id)
                restore?.invoke(); toast(message)
            }
        }
    }
    override fun toggleOriginal() { showOriginal = !showOriginal; render() }
    override fun page(delta: Int) {
        val all = snapshot?.let { cards(it) } ?: return
        if (all.size < 2) return
        val i = all.indexOfFirst { it.optString("id") == selected }
        selected = all[((i + delta) % all.size + all.size) % all.size].optString("id")
        showOriginal = false; island?.resetMore(); render()
    }
    override fun drag(phase: String, dx: Float, dy: Float) {
        val ctx = app ?: return
        when (phase) {
            "start" -> { dragFromX = centreX; dragFromY = offsetY }
            "move" -> {
                val screen = ctx.resources.displayMetrics.widthPixels
                centreX = (dragFromX + dx.toInt()).coerceIn(islandW / 2, (screen - islandW / 2).coerceAtLeast(islandW / 2))
                val room = ctx.resources.displayMetrics.heightPixels - statusBar(ctx) - islandH - dp(48f)
                offsetY = (dragFromY + dy.toInt()).coerceIn(0, room.coerceAtLeast(0))
                val p = params ?: return
                if (trusted && p.y != statusBar(ctx) + offsetY) { p.y = statusBar(ctx) + offsetY; if (attached) runCatching { host?.updateViewLayout(root, p) } }
                follow(islandW, islandH)
            }
            "end" -> { if (fitCard()) render(); root?.post { rememberBounds() } }
        }
    }
    override fun send(text: String) {
        if (sending || text.isBlank() || text.length > 4000) return
        val ctx = app ?: return
        val target = answering()
        if (text != attemptText || attemptId.isBlank()) { attemptText = text; attemptId = UUID.randomUUID().toString() }
        // A send that may have reached Ash is remembered, so a retry after a crash reuses its id.
        val prefs = ctx.getSharedPreferences("ash_capsule_input", Context.MODE_PRIVATE)
        if (!prefs.edit().putString("pending_id", attemptId).putString("pending_text", text).putString("pending_question", target).commit()) {
            notice = "无法保存发送状态，请重试"; render(); return
        }
        customTarget = target; sending = true; notice = "正在发送…"; render()
        val done: (Boolean, String) -> Unit = { ok, message ->
            main.post {
                sending = false; notice = message
                if (ok) {
                    prefs.edit().remove("pending_id").remove("pending_text").remove("pending_question").commit()
                    attemptId = ""; attemptText = ""; customTarget = null
                    if (target != null) submitted[target] = "answered"
                    island?.clearInput(); setEditing(false)
                }
                // A question that closed under the draft refuses it once, with this notice; sending again is an ordinary message.
                else if (customTarget != null && !openQuestion(snapshot?.let { m -> cards(m).firstOrNull { it.optString("id") == customTarget } })) customTarget = null
                restore?.invoke() ?: render()
            }
        }
        if (target == null) TaskStatus.sendInput(text, attemptId, done) else TaskStatus.answerCard(target, "custom", text, done)
    }
    private fun toast(text: String) { app?.let { android.widget.Toast.makeText(it, text, android.widget.Toast.LENGTH_SHORT).show() } }

    // ---- shared with the agent's own screen work ----
    fun <T> withTouchPassthrough(action: () -> T): T {
        val latch = CountDownLatch(1); var applied = false; var entered = false
        main.post {
            if (editing) { latch.countDown(); return@post }
            entered = true; passingTouches++
            runCatching { applyTouchMode(); applied = true }
            Choreographer.getInstance().postFrameCallback { Choreographer.getInstance().postFrameCallback { main.postDelayed({ latch.countDown() }, 100) } }
        }
        try {
            if (!latch.await(1000, TimeUnit.MILLISECONDS) || !applied) throw IllegalStateException("owner_input_busy: owner is entering a message; do not take input focus")
            return action()
        } finally { main.postDelayed({ if (entered) passingTouches = (passingTouches - 1).coerceAtLeast(0); applyTouchMode() }, 120) }
    }
    fun <T> withoutOverlay(action: () -> T): T {
        val latch = CountDownLatch(1); var entered = false
        main.post {
            if (editing) { latch.countDown(); return@post }
            entered = true; suppressed++; if (attached) capturedAway = true; detach()
            Choreographer.getInstance().postFrameCallback { Choreographer.getInstance().postFrameCallback { latch.countDown() } }
        }
        try {
            if (!latch.await(1000, TimeUnit.MILLISECONDS) || !entered) throw IllegalStateException("owner_input_busy: owner is entering a message; defer screen capture")
            return action()
        } finally { main.postDelayed({ if (entered) suppressed = (suppressed - 1).coerceAtLeast(0); restore?.invoke() }, 120) }
    }
}

/** The agent's Markdown as the reference's plain text (host.js `plain`). */
internal object IslandText {
    fun plain(text: String): String = text.split('\n').filterNot { Regex("^\\s*(```|\\|?\\s*:?-{3,})").containsMatchIn(it) }.joinToString("\n") { line ->
        var l = line.replace(Regex("^\\s*#{1,6}\\s+"), "").replace(Regex("^\\s*>\\s?"), "").replace(Regex("^(\\s*)[-*+]\\s+"), "$1• ")
        Regex("^\\s*\\|(.*)\\|\\s*$").find(l)?.let { m -> l = m.groupValues[1].split('|').map { it.trim() }.filter { it.isNotEmpty() }.joinToString(" · ") }
        l.replace(Regex("!?\\[([^\\]]*)\\]\\([^)]*\\)"), "$1").replace(Regex("(\\*\\*|__)(.+?)\\1"), "$2").replace(Regex("`([^`]*)`"), "$1")
    }.replace(Regex("\n{3,}"), "\n\n").trim()
}
