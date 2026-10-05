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
    private var sending = false
    private var attemptId = ""

    fun enabled(ctx: Context) = java.io.File(ctx.filesDir, "ash/island-native").exists()
    fun ownsWindow(bounds: Rect) = screenBounds == bounds
    fun isEditing() = editing
    private fun dp(v: Float) = Math.round(v * (app?.resources?.displayMetrics?.density ?: 1f))
    private fun unlocked(ctx: Context) = !ctx.getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked &&
        ctx.getSystemService(android.os.PowerManager::class.java).isInteractive
    private fun allowed() = visible && suppressed == 0 && app?.let { unlocked(it) && !AppState.homeVisible && Settings.canDrawOverlays(it) } == true

    private fun ensure(ctx: Context) {
        if (island != null) return
        app = ctx.applicationContext
        val view = IslandView(app!!, this)
        val box = FrameLayout(app!!).apply { clipChildren = false; clipToPadding = false; contentDescription = "AshTaskCapsule" }
        box.addView(view.shell, FrameLayout.LayoutParams(dp(IslandTokens.SIZE_COMPACT_W), dp(IslandTokens.SIZE_COMPACT_H)).apply {
            leftMargin = dp(IslandTokens.SIZE_WINDOW_INSET_SIDE); topMargin = dp(IslandTokens.SIZE_WINDOW_INSET_TOP)
        })
        @SuppressLint("ClickableViewAccessibility")
        view.input.setOnTouchListener { _, e -> if (e.action == MotionEvent.ACTION_DOWN) setEditing(true); false }
        view.onFrame = { w, h -> follow(w, h) }
        root = box; island = view
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
            val left = centreX - w / 2
            if (lp.leftMargin != left || lp.topMargin != top) { lp.leftMargin = left; lp.topMargin = top; shell.layoutParams = lp }
            placePad(ctx, left, top, w, h)
            return
        }
        if (lp.leftMargin != side || lp.topMargin != top) { lp.leftMargin = side; lp.topMargin = top; shell.layoutParams = lp }
        p.width = w + 2 * side
        p.height = h + top + dp(IslandTokens.SIZE_WINDOW_INSET_BOTTOM)
        p.x = centreX - p.width / 2
        if (attached) runCatching { host?.updateViewLayout(root, p) }
    }
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
        ctx.resources.displayMetrics.widthPixels, (ctx.resources.displayMetrics.heightPixels * 0.9f).toInt(),
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
        y = if (trusted) statusBar(ctx) else 0
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

    /** A projected frame from [ai.ash.ui.IslandPresentation]. */
    fun update(ctx: Context, model: JSONObject, restoreWith: () -> Unit) {
        ensure(ctx)
        val prev = snapshot; snapshot = model; restore = restoreWith; visible = true
        val newTurn = prev?.optString("turn") != model.optString("turn") || prev?.optString("session") != model.optString("session")
        val kind = displayKind(model)
        val ended = kind in setOf("reply", "result", "ask", "in_app", "incomplete", "stopped")
        val reply = model.optString("reply")
        val incoming = firstWaiting(model)?.optString("id").orEmpty()
        if (newTurn && reply.isEmpty() && incoming.isEmpty()) form = "compact"
        val next = listOf(model.optString("session"), model.optString("turn"), if (ended) "ended" else kind, incoming, reply).joinToString("|")
        if (next != episode && (incoming.isNotEmpty() || reply.isNotEmpty() || ended)) form = "card"
        episode = next
        island?.reduceMotion = Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        island?.setCardWidth(minOf(IslandTokens.SIZE_CARD_W, ctx.resources.displayMetrics.widthPixels / ctx.resources.displayMetrics.density - 24f))
        render()
        if (!allowed()) { if (!unlocked(ctx) || AppState.homeVisible) setEditing(false); detach(); return }
        // The accessibility service can connect or go away while the island is up: move to the matching window.
        if (attached && trusted != (ai.ash.host.a11y.A11yService.instance != null) && !editing) detach()
        attach()
    }

    private fun firstWaiting(model: JSONObject): JSONObject? {
        val cards = model.optJSONArray("cards") ?: return null
        for (i in 0 until cards.length()) cards.optJSONObject(i)?.takeIf { it.optString("state") == "waiting" && it.optString("localState").isEmpty() }?.let { return it }
        return null
    }
    private fun displayKind(model: JSONObject): String {
        if (model.optBoolean("stale")) return "stale"
        val card = firstWaiting(model)
        return if (card != null) (if (card.optString("kind") == "approval") "approval" else "ask") else model.optString("kind")
    }
    private fun render() {
        val model = snapshot ?: return; val view = island ?: return
        val card = firstWaiting(model)
        val body = if (card != null) listOf(card.optString("title"), card.optString("detail")).filter { it.isNotBlank() }.joinToString("\n\n")
            else IslandText.plain(model.optString("reply"))
        view.render(IslandModel(kind = displayKind(model), form = form, elapsedSec = model.optLong("elapsed"),
            activity = model.optString("activity"), body = body, canStop = model.optBoolean("canStop") && model.optBoolean("interactive")))
        // Development check of the layout against the reference (switch file says "dump").
        if (app?.let { java.io.File(it.filesDir, "ash/island-native").readText().contains("dump") } == true)
            view.shell.postDelayed({ android.util.Log.i("ash.island.dump", JSONObject().put("kind", displayKind(model)).put("form", form).put("bounds", view.debugBounds()).toString()) }, 2500)
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
            // Back after a capture: fade in rather than pop (reference §2).
            box.alpha = 0f; box.animate().alpha(1f).setDuration(180).start()
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
    fun hide() { main.post { visible = false; setEditing(false); detach(); restore = null } }
    fun release() { main.post { visible = false; setEditing(false); detach(); root = null; island = null; params = null; snapshot = null; restore = null; episode = ""; form = "compact" } }

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
    override fun send(text: String) {
        if (sending || text.length > 4000) return
        if (attemptId.isBlank()) attemptId = UUID.randomUUID().toString()
        sending = true
        TaskStatus.sendInput(text, attemptId) { ok, message ->
            main.post {
                sending = false
                if (ok) { attemptId = ""; island?.clearInput(); setEditing(false) }
                app?.let { android.widget.Toast.makeText(it, message, android.widget.Toast.LENGTH_SHORT).show() }
                restore?.invoke()
            }
        }
    }

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
            entered = true; suppressed++; detach()
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
