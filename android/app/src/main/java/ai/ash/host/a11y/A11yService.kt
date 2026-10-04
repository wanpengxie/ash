package ai.ash.host.a11y

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock

/**
 * The accessibility service: lets ash see the screen (node tree, screenshots) and operate it
 * (node actions, typing, scrolling, global actions, arbitrary multi-finger gestures).
 *
 * There is no server here: capabilities ([ai.ash.host.cap.ScreenCapabilities]) call [instance]
 * in-process from bridge worker threads. Every public method is thread-safe and may block (it waits
 * for gesture / screenshot callbacks, which are delivered on a private handler thread — never on the
 * main thread, so a worker waiting for a callback can never deadlock against a lifecycle callback).
 * Public methods must NOT be called on the main thread.
 *
 * Results are JSON objects `{ok: true, …}` or `{ok: false, error: "…"}` (errors are written for the model).
 *
 * Touch gesture engine (ported from v1.7.3 of the old host):
 *  - multi-stroke timeline: one request may hold down/move/up/tap/swipe/hold/wait ops, all injected
 *    together as one gesture (real multi-touch);
 *  - held fingers: a finger that goes `down` and is not lifted stays pressed (willContinue) across
 *    requests — "left thumb holds the joystick while the right one taps a skill" is down(0) then tap(1);
 *  - fractional coordinates: every coordinate accepts fx/fy (0..1 of the screen), immune to screenshot scaling;
 *  - safety net: held fingers are auto-released after [HOLD_TIMEOUT_MS], the same finger index is
 *    overridden, release_all resets everything, and a failed gesture / disconnected service resets all fingers.
 */
class A11yService : AccessibilityService() {

    companion object {
        private const val TAG = "ash.a11y"

        /** The connected service, or null when accessibility is off for ash. */
        @Volatile
        var instance: A11yService? = null
            private set

        /** Package of the last window that changed state (fallback when the root node is unavailable). */
        @Volatile
        var activePackage: String = ""
            private set

        const val MAX_NODES = 250
        const val MAX_DEPTH = 40
        const val MAX_TEXT_LEN = 120

        /** Gesture engine: finger slots (devices allow ≥ 10 strokes per gesture). */
        const val MAX_FINGERS = 8

        /** A held finger is lifted automatically after this long, so a runaway agent can't keep pressing the screen. */
        const val HOLD_TIMEOUT_MS = 30_000L

        val canScreenshot: Boolean get() = Build.VERSION.SDK_INT >= 30

        fun err(msg: String): JSONObject = JSONObject().put("ok", false).put("error", msg)
    }

    // ------------------------------------------------------------------ lifecycle

    @Volatile private var lastEventAt = 0L
    val screenEpoch = ai.ash.host.AppState.screenEpoch
    private var cbThread: HandlerThread? = null
    @Volatile private var cbHandler: Handler? = null
    private var timer: ScheduledThreadPoolExecutor? = null
    private var expiryTask: ScheduledFuture<*>? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        val t = HandlerThread("ash-a11y-cb").apply { start() }
        cbThread = t
        cbHandler = Handler(t.looper)
        timer = ScheduledThreadPoolExecutor(1) { r -> Thread(r, "ash-a11y-timer").apply { isDaemon = true } }
        instance = this
        Log.i(TAG, "accessibility service connected")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return
        lastEventAt = SystemClock.uptimeMillis()
        if (event.eventType in setOf(AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED, AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED, AccessibilityEvent.TYPE_WINDOWS_CHANGED,
                AccessibilityEvent.TYPE_VIEW_CLICKED, AccessibilityEvent.TYPE_VIEW_SCROLLED, AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED,
                AccessibilityEvent.TYPE_TOUCH_INTERACTION_START)) screenEpoch.incrementAndGet()
        // Only window-state changes name the foreground app; content changes also come from the
        // status bar, IME, toasts … and would make activePackage flicker.
        if (event.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            event.packageName?.let { activePackage = it.toString() }
        }
    }

    override fun onInterrupt() {
        Log.w(TAG, "accessibility service interrupted")
        releaseAllFingersFromLifecycle()
    }

    override fun onUnbind(intent: Intent?): Boolean {
        if (instance === this) instance = null
        releaseAllFingersFromLifecycle()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        try { timer?.shutdownNow() } catch (_: Throwable) {}
        timer = null
        try { cbThread?.quitSafely() } catch (_: Throwable) {}
        cbThread = null
        cbHandler = null
        super.onDestroy()
    }

    // ------------------------------------------------------------------ screen / coordinates

    /** Real screen size in physical pixels, current rotation (same coordinate space as screenshots and gestures). */
    @Suppress("DEPRECATION")
    fun screenSize(): IntArray = try {
        val wm = getSystemService(WINDOW_SERVICE) as WindowManager
        val dm = DisplayMetrics()
        wm.defaultDisplay.getRealMetrics(dm)
        intArrayOf(dm.widthPixels, dm.heightPixels)
    } catch (t: Throwable) {
        try {
            val dm = resources.displayMetrics
            intArrayOf(dm.widthPixels, dm.heightPixels)
        } catch (t2: Throwable) {
            intArrayOf(0, 0)
        }
    }

    /** Coordinate from JSON: fraction key (0..1 of the screen) wins, pixel key is the fallback; -1 if absent. */
    fun resolveCoord(o: JSONObject, fracKey: String, pxKey: String, screenLen: Int): Int {
        try {
            if (o.has(fracKey) && !o.isNull(fracKey)) {
                val f = o.optDouble(fracKey, -1.0)
                if (f in 0.0..1.0) return Math.round(f * screenLen).toInt()
            }
            if (o.has(pxKey) && !o.isNull(pxKey)) {
                val p = o.optDouble(pxKey, -1.0)
                if (!p.isNaN()) return Math.round(p).toInt()
            }
        } catch (_: Throwable) {
        }
        return -1
    }

    /** Package of the foreground app. */
    fun foregroundPackage(): String =
        try { rootInActiveWindow?.packageName?.toString() } catch (_: Throwable) { null } ?: activePackage

    /**
     * Waits until no accessibility event arrived for [quietMs] (the UI settled after an action or a
     * transition), at most [maxMs]. Animated / constantly refreshing screens just hit the cap.
     */
    fun awaitIdle(quietMs: Long = 300, maxMs: Long = 1200) {
        val deadline = SystemClock.uptimeMillis() + maxMs
        while (true) {
            val now = SystemClock.uptimeMillis()
            if (now - lastEventAt >= quietMs || now >= deadline) return
            SystemClock.sleep(50)
        }
    }

    // ------------------------------------------------------------------ node tree

    /**
     * Root of the active window. getRootInActiveWindow() transiently returns null during window
     * transitions (real devices, right after an app switch), so retry a few times before giving up.
     */
    fun root(): AccessibilityNodeInfo? {
        for (i in 0 until 3) {
            val r = try { rootInActiveWindow } catch (_: Throwable) { null }
            if (r != null) return r
            SystemClock.sleep(150)
        }
        return null
    }

    /**
     * Pre-order walk (depth-capped). [visit] returns false to stop the whole walk.
     * Nodes are deliberately not recycle()d: the old walker recycled every child after visiting it,
     * which could hand back already-recycled nodes as "best match" to click. recycle() is a no-op on
     * API 33+ and only a pool optimisation below it; the GC handles the rest.
     */
    private fun walk(node: AccessibilityNodeInfo?, depth: Int = 0, visit: (AccessibilityNodeInfo, Int) -> Boolean): Boolean {
        if (node == null || depth > MAX_DEPTH) return true
        if (!visit(node, depth)) return false
        val n = try { node.childCount } catch (_: Throwable) { 0 }
        for (i in 0 until n) {
            val child = try { node.getChild(i) } catch (_: Throwable) { null } ?: continue
            if (!walk(child, depth + 1, visit)) return false
        }
        return true
    }

    private fun cs(c: CharSequence?): String = c?.toString()?.trim() ?: ""

    private fun isInput(node: AccessibilityNodeInfo): Boolean =
        node.isEditable || node.className?.toString() == "android.widget.EditText"

    private fun shortId(node: AccessibilityNodeInfo): String {
        val id = try { node.viewIdResourceName } catch (_: Throwable) { null } ?: return ""
        val i = id.indexOf(":id/")
        return if (i >= 0) id.substring(i + 4) else id
    }

    /**
     * Screen element list. Filter: keep only nodes with text / description, or clickable / editable /
     * scrollable ones, with a non-empty on-screen box; at most [MAX_NODES], texts cut to [MAX_TEXT_LEN].
     */
    fun dump(): JSONObject {
        val size = screenSize()
        val o = JSONObject().put("ok", true).put("screenW", size[0]).put("screenH", size[1])
        val root = root()
        if (root == null) {
            return o.put("package", activePackage).put("count", 0).put("truncated", false).put("nodes", JSONArray())
                .put("note", "No readable active window (lock screen or a secure page?).")
        }
        val nodes = JSONArray()
        var emitted = 0
        var truncated = false
        walk(root) { node, depth ->
            if (emitted >= MAX_NODES) {
                truncated = true
                return@walk false
            }
            try {
                var text = cs(node.text)
                var desc = cs(node.contentDescription)
                val clickable = node.isClickable
                val input = isInput(node)
                val scrollable = node.isScrollable
                if (text.isEmpty() && desc.isEmpty() && !clickable && !input && !scrollable) return@walk true
                val b = Rect()
                node.getBoundsInScreen(b)
                if (b.width() <= 0 || b.height() <= 0) return@walk true
                if (text.length > MAX_TEXT_LEN) text = text.substring(0, MAX_TEXT_LEN) + "…"
                if (desc.length > MAX_TEXT_LEN) desc = desc.substring(0, MAX_TEXT_LEN) + "…"
                nodes.put(JSONObject()
                    .put("text", text)
                    .put("desc", desc)
                    .put("id", shortId(node))
                    .put("cls", node.className?.toString() ?: "")
                    .put("x", b.left).put("y", b.top).put("w", b.width()).put("h", b.height())
                    .put("clickable", clickable)
                    .put("input", input)
                    .put("checked", node.isChecked)
                    .put("selected", node.isSelected)
                    .put("scrollable", scrollable)
                    .put("depth", depth))
                emitted++
            } catch (_: Throwable) {
            }
            true
        }
        o.put("package", root.packageName?.toString() ?: activePackage)
        o.put("count", emitted).put("truncated", truncated).put("nodes", nodes)
        // No readable nodes (Unity games / custom-drawn UIs): steer the model to screenshots + fractions.
        if (emitted == 0) {
            o.put("hint", "This screen exposes no readable elements (common for games / Unity / custom-drawn UIs). " +
                "Use screen.see to look at it and act with fractional coordinates (fx/fy, 0..1): screenshots are " +
                "scaled for the model, so pixel coordinates read off the image land in the wrong place.")
        }
        return o
    }

    /**
     * Nearest clickable+enabled ancestor (self included), or null.
     * Buttons often wrap non-clickable child TextViews: ACTION_CLICK on the deepest (text) node fails and
     * we'd fall back to a gesture — which floating windows (remote-control bubbles, freeform windows …)
     * swallow. Clicking the clickable ancestor sidesteps that.
     */
    private fun closestClickable(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val nb = Rect()
        try { node.getBoundsInScreen(nb) } catch (_: Throwable) { return null }
        val nArea = maxOf(1, nb.width()).toLong() * maxOf(1, nb.height())
        var cur: AccessibilityNodeInfo? = node
        var i = 0
        while (i < 12 && cur != null) {
            try {
                if (cur.isClickable && cur.isEnabled) {
                    if (i == 0) return cur
                    // Area guard: an ancestor far bigger than the node (a WebView / whole-page container)
                    // must not be the target — ACTION_CLICK would land in *its* centre (wrong place).
                    // Better return null and let the caller use a gesture.
                    val cb = Rect()
                    cur.getBoundsInScreen(cb)
                    val cArea = maxOf(1, cb.width()).toLong() * maxOf(1, cb.height())
                    return if (cArea <= nArea * 6) cur else null
                }
                cur = cur.parent
            } catch (_: Throwable) {
                return null
            }
            i++
        }
        return null
    }

    private class Match(val target: AccessibilityNodeInfo, val matched: AccessibilityNodeInfo, val rank: Int)

    /**
     * Element by text/description (case-insensitive; exact beats contains) and/or view id
     * ("name" or "pkg:id/name"). Rank: 4 = exact & clickable, 3 = partial & clickable, 2 = exact, 1 = partial.
     * The target is the closest clickable ancestor when there is one, else the matched node itself.
     */
    private fun findNode(query: String?, id: String?): Match? {
        val q = query?.trim()?.lowercase() ?: ""
        val idq = id?.trim() ?: ""
        if (q.isEmpty() && idq.isEmpty()) return null
        val root = root() ?: return null
        var best: Match? = null
        walk(root) { node, _ ->
            val exact: Boolean
            val partial: Boolean
            if (idq.isNotEmpty()) {
                val full = try { node.viewIdResourceName } catch (_: Throwable) { null } ?: ""
                val idOk = full.isNotEmpty() && (full == idq || full.endsWith(":id/$idq"))
                if (!idOk) return@walk true
                if (q.isEmpty()) {
                    exact = true; partial = false
                } else {
                    val text = cs(node.text).lowercase()
                    val desc = cs(node.contentDescription).lowercase()
                    exact = text == q || desc == q
                    partial = !exact && (text.contains(q) || desc.contains(q))
                }
            } else {
                val text = cs(node.text).lowercase()
                val desc = cs(node.contentDescription).lowercase()
                exact = text == q || desc == q
                partial = !exact && ((text.isNotEmpty() && text.contains(q)) || (desc.isNotEmpty() && desc.contains(q)))
            }
            if (!exact && !partial) return@walk true
            val clickable = closestClickable(node)
            val rank = if (exact) (if (clickable != null) 4 else 2) else (if (clickable != null) 3 else 1)
            val bestRank = best?.rank ?: -1
            if (clickable != null) {
                if (rank > bestRank) best = Match(clickable, node, rank)
            } else if (best == null && rank > bestRank) {
                best = Match(node, node, rank)
            }
            rank != 4 // exact + clickable: can't do better
        }
        return best
    }

    /** Deepest clickable node containing the point (falls back to the deepest node). */
    private fun findNodeByPoint(x: Int, y: Int): AccessibilityNodeInfo? {
        val root = root() ?: return null
        var best: AccessibilityNodeInfo? = null
        var bestDepth = -1
        walk(root) { node, depth ->
            val b = Rect()
            try { node.getBoundsInScreen(b) } catch (_: Throwable) { return@walk true }
            if (!b.contains(x, y)) return@walk true
            val clickable = closestClickable(node)
            if (clickable == null) {
                if (best == null && depth > bestDepth) { bestDepth = depth; best = node }
            } else if (depth >= bestDepth) {
                bestDepth = depth; best = clickable
            }
            true
        }
        return best
    }

    // ------------------------------------------------------------------ tap / type / scroll / global

    /**
     * Tap an element. With [query]/[id]: find it and ACTION_CLICK (ACTION_LONG_CLICK when [long]).
     * With coordinates only: ACTION_CLICK on the deepest clickable node at the point.
     * If the node action fails: a gesture at the given coordinates, or at the matched element's centre.
     */
    fun tap(query: String?, id: String?, x: Int, y: Int, long: Boolean): JSONObject {
        val action = if (long) AccessibilityNodeInfo.ACTION_LONG_CLICK else AccessibilityNodeInfo.ACTION_CLICK
        val byNode = !query.isNullOrBlank() || !id.isNullOrBlank()
        var target: AccessibilityNodeInfo? = null
        var matched: AccessibilityNodeInfo? = null
        val method: String
        if (byNode) {
            val m = findNode(query, id)
            target = m?.target
            matched = m?.matched
            method = "node-text"
        } else if (x >= 0 && y >= 0) {
            target = findNodeByPoint(x, y)
            method = "node-coord"
        } else {
            return err("tap needs text/desc/id or x/y (or fx/fy)")
        }
        val o = JSONObject().put("ok", true)
        if (target != null && try { target.performAction(action) } catch (_: Throwable) { false }) {
            return o.put("found", true).put("method", method)
        }
        var gx = x
        var gy = y
        if ((gx < 0 || gy < 0) && matched != null) {
            // Matched but not clickable through accessibility (e.g. a text inside a custom view): press its centre.
            val b = Rect()
            try { matched.getBoundsInScreen(b) } catch (_: Throwable) {}
            if (b.width() > 0 && b.height() > 0) { gx = b.centerX(); gy = b.centerY() }
        }
        if (gx >= 0 && gy >= 0) {
            val op = JSONObject().put("kind", if (long) "hold" else "tap").put("x", gx).put("y", gy)
            if (long) op.put("durationMs", 650)
            val r = gesture(JSONArray().put(op))
            if (!r.optBoolean("ok")) return err("no node action worked and the fallback gesture failed: ${r.optString("error")}")
            return o.put("found", true).put("method", "gesture").put("x", gx).put("y", gy)
        }
        return err(if (byNode) "no element matches ${listOfNotNull(query?.takeIf { it.isNotBlank() }?.let { "text \"$it\"" }, id?.takeIf { it.isNotBlank() }?.let { "id \"$it\"" }).joinToString(" and ")} on the current screen"
            else "nothing clickable at ($x,$y)")
    }

    /**
     * Type into an input field. The target is the field matching [field] (text/hint/description/id of an
     * editable node), else the input-focused node, else the first editable node, else (old behaviour, last
     * resort) the first focusable node. It is focused first.
     *
     * [mode] "set" (default): ACTION_SET_TEXT — replaces the whole content; right for native EditTexts.
     * [mode] "paste": put [text] on the clipboard and ACTION_PASTE at the cursor — for WebView /
     * contenteditable fields, where setText only changes the accessibility node and never fires the page's
     * input event (the UI doesn't update). Each mode falls back to the other when its action is refused.
     */
    fun type(text: String, mode: String, field: String?): JSONObject {
        val root = root() ?: return err("no active window")
        var target: AccessibilityNodeInfo? = null
        if (!field.isNullOrBlank()) {
            val q = field.trim().lowercase()
            var partial: AccessibilityNodeInfo? = null
            walk(root) { node, _ ->
                if (!isInput(node)) return@walk true
                val hint = if (Build.VERSION.SDK_INT >= 26) cs(node.hintText).lowercase() else ""
                val keys = listOf(cs(node.text).lowercase(), cs(node.contentDescription).lowercase(), hint, shortId(node).lowercase())
                if (keys.any { it == q }) { target = node; return@walk false }
                if (partial == null && keys.any { it.isNotEmpty() && it.contains(q) }) partial = node
                true
            }
            if (target == null) target = partial
            if (target == null) return err("no input field matches \"$field\"")
        }
        if (target == null) target = try { root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) } catch (_: Throwable) { null }
        if (target == null) {
            var editable: AccessibilityNodeInfo? = null
            var focusable: AccessibilityNodeInfo? = null
            walk(root) { node, _ ->
                if (node.isEditable) { editable = node; return@walk false }
                if (focusable == null && node.isFocusable) focusable = node
                true
            }
            target = editable ?: focusable
        }
        val t = target ?: return err("no input field found (tap the field first, or pass field)")
        if (!t.isFocused) try { t.performAction(AccessibilityNodeInfo.ACTION_FOCUS) } catch (_: Throwable) {}

        val order = if (mode == "paste" && text.isNotEmpty()) listOf("paste", "set") else listOf("set", "paste")
        var used = ""
        for (m in order) {
            if (m == "paste" && text.isEmpty()) continue // pasting nothing can't clear a field
            val ok = try { if (m == "set") setText(t, text) else paste(t, text) } catch (e: Throwable) { Log.w(TAG, "type $m failed", e); false }
            if (ok) { used = m; break }
        }
        try { t.refresh() } catch (_: Throwable) {}
        val o = JSONObject().put("focused", try { t.isFocused } catch (_: Throwable) { false })
        if (used.isEmpty()) return o.put("ok", false).put("error", "the field refused both setText and paste")
        return o.put("ok", true).put("method", used).put("fallback", used != order[0])
    }

    private fun setText(node: AccessibilityNodeInfo, text: String): Boolean {
        val args = Bundle()
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) return false
        // Some apps leave the cursor at 0 after setText, so later keyboard input would land in front: move it to the end.
        try {
            val sel = Bundle()
            sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, text.length)
            sel.putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, text.length)
            node.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, sel)
        } catch (_: Throwable) {
        }
        return true
    }

    private fun paste(node: AccessibilityNodeInfo, text: String): Boolean {
        val cm = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("ash-input", text))
        return node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
    }

    /**
     * Scroll up/down/left/right. Prefers a scrollable node exposing the matching directional action
     * (API 23+, so "left" doesn't scroll a vertical list), then the first scrollable node with
     * forward/backward (old behaviour), then a swipe gesture across the middle of the screen
     * (WebViews, games and custom lists often expose no scrollable node at all).
     */
    fun scroll(direction: String): JSONObject {
        val fb = when (direction) {
            "up", "left" -> AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
            "down", "right" -> AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
            else -> return err("direction must be up/down/left/right")
        }
        val o = JSONObject().put("ok", true).put("direction", direction)
        val root = root()
        if (root != null) {
            if (Build.VERSION.SDK_INT >= 23) {
                val dirId = when (direction) {
                    "up" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_UP.id
                    "down" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_DOWN.id
                    "left" -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_LEFT.id
                    else -> AccessibilityNodeInfo.AccessibilityAction.ACTION_SCROLL_RIGHT.id
                }
                var directional: AccessibilityNodeInfo? = null
                walk(root) { node, _ ->
                    if (node.isScrollable && node.actionList.any { it.id == dirId }) { directional = node; false } else true
                }
                if (directional?.performAction(dirId) == true) return o.put("method", "node")
            }
            var scroller: AccessibilityNodeInfo? = null
            walk(root) { node, _ -> if (node.isScrollable) { scroller = node; false } else true }
            if (scroller?.performAction(fb) == true) return o.put("method", "node")
        }
        // Gesture fallback: the finger moves against the scroll direction (to see content below, swipe up).
        val (a, b) = 0.3 to 0.7
        val op = JSONObject().put("kind", "swipe").put("durationMs", 350)
        when (direction) {
            "down" -> op.put("fx", 0.5).put("fy", b).put("fx2", 0.5).put("fy2", a)
            "up" -> op.put("fx", 0.5).put("fy", a).put("fx2", 0.5).put("fy2", b)
            "right" -> op.put("fx", 0.75).put("fy", 0.5).put("fx2", 0.25).put("fy2", 0.5)
            else -> op.put("fx", 0.25).put("fy", 0.5).put("fx2", 0.75).put("fy2", 0.5)
        }
        val r = gesture(JSONArray().put(op))
        if (!r.optBoolean("ok")) return err("no scrollable area found and the fallback swipe failed: ${r.optString("error")}")
        return o.put("method", "gesture")
    }

    /** performGlobalAction wrapper (back / home / recents / notifications …). */
    fun global(action: Int): Boolean = try { performGlobalAction(action) } catch (_: Throwable) { false }

    // ------------------------------------------------------------------ touch gesture engine

    private class Stroke(val path: Path, val start: Long, val duration: Long, val willContinue: Boolean)

    private val gestureLock = ReentrantLock()
    private val fingerDown = BooleanArray(MAX_FINGERS)
    private val fingerX = FloatArray(MAX_FINGERS)
    private val fingerY = FloatArray(MAX_FINGERS)
    private val fingerDownAt = LongArray(MAX_FINGERS)
    @Volatile private var screenW = 0
    @Volatile private var screenH = 0

    /** Longest gesture the platform accepts (60 s on AOSP; the builder throws beyond it). */
    private val maxGestureMs: Long get() = try { GestureDescription.getMaxGestureDuration() } catch (_: Throwable) { 60_000L }
    private val maxStrokes: Int get() = try { GestureDescription.getMaxStrokeCount() } catch (_: Throwable) { MAX_FINGERS + 2 }

    private fun heldJson(withElapsed: Boolean): JSONArray {
        val held = JSONArray()
        val now = System.currentTimeMillis()
        for (f in 0 until MAX_FINGERS) {
            if (!fingerDown[f]) continue
            val h = JSONObject().put("finger", f).put("x", fingerX[f].toInt()).put("y", fingerY[f].toInt())
                .put("fx", if (screenW > 0) fingerX[f].toDouble() / screenW else 0.0)
                .put("fy", if (screenH > 0) fingerY[f].toDouble() / screenH else 0.0)
            if (withElapsed) h.put("elapsedMs", now - fingerDownAt[f])
            held.put(h)
        }
        return held
    }

    /** Held fingers, screen size and limits. */
    fun touchStatus(): JSONObject {
        val size = screenSize()
        gestureLock.lock()
        try {
            return JSONObject().put("ok", true).put("screenW", size[0]).put("screenH", size[1])
                .put("maxFingers", MAX_FINGERS).put("holdTimeoutMs", HOLD_TIMEOUT_MS).put("held", heldJson(true))
        } finally {
            gestureLock.unlock()
        }
    }

    /** Lift every held finger. */
    fun releaseAll(): JSONObject {
        gestureLock.lock()
        try {
            releaseAllFingersUnlocked()
            return JSONObject().put("ok", true).put("held", JSONArray())
        } finally {
            gestureLock.unlock()
        }
    }

    /** Lifecycle callbacks run on the main thread: never wait long for the lock there. */
    private fun releaseAllFingersFromLifecycle() {
        try {
            if (gestureLock.tryLock(200, TimeUnit.MILLISECONDS)) {
                try { releaseAllFingersUnlocked() } finally { gestureLock.unlock() }
            }
        } catch (_: Throwable) {
        }
    }

    /**
     * Lift all held fingers (caller holds gestureLock). A fresh gesture cancels whatever gesture is in
     * progress (which releases the willContinue pointers), then a short stroke lifts at each spot.
     * Only fingers that were actually held get a stroke (the old code also "released" never-used slots,
     * i.e. tapped at (0,0)).
     */
    private fun releaseAllFingersUnlocked() {
        val strokes = ArrayList<Stroke>()
        for (f in 0 until MAX_FINGERS) {
            if (!fingerDown[f]) continue
            fingerDown[f] = false
            val p = Path()
            p.moveTo(fingerX[f], fingerY[f])
            strokes.add(Stroke(p, 0, 80, false))
        }
        expiryTask?.cancel(false)
        expiryTask = null
        if (strokes.isEmpty()) return
        try {
            val gb = GestureDescription.Builder()
            for (s in strokes) gb.addStroke(GestureDescription.StrokeDescription(s.path, s.start, s.duration, s.willContinue))
            dispatchGesture(gb.build(), null, cbHandler)
        } catch (t: Throwable) {
            Log.w(TAG, "release all failed", t)
        }
    }

    /** Arms the auto-release for the earliest held finger (caller holds gestureLock). */
    private fun scheduleExpiryUnlocked() {
        expiryTask?.cancel(false)
        expiryTask = null
        var earliest = Long.MAX_VALUE
        for (f in 0 until MAX_FINGERS) if (fingerDown[f]) earliest = minOf(earliest, fingerDownAt[f])
        if (earliest == Long.MAX_VALUE) return
        val delay = maxOf(0L, earliest + HOLD_TIMEOUT_MS - System.currentTimeMillis()) + 100
        expiryTask = try { timer?.schedule({ expireHeld() }, delay, TimeUnit.MILLISECONDS) } catch (_: Throwable) { null }
    }

    /** Timer thread: lift fingers held past [HOLD_TIMEOUT_MS] (the others stay held). */
    private fun expireHeld() {
        gestureLock.lock()
        try {
            val now = System.currentTimeMillis()
            var anyExpired = false
            var anyAlive = false
            for (f in 0 until MAX_FINGERS) {
                if (!fingerDown[f]) continue
                if (now - fingerDownAt[f] > HOLD_TIMEOUT_MS) anyExpired = true else anyAlive = true
            }
            if (!anyExpired) { scheduleExpiryUnlocked(); return }
            if (!anyAlive) releaseAllFingersUnlocked()
            else gestureUnlocked(JSONArray().put(JSONObject().put("kind", "wait").put("ms", 1))) // lifts expired, re-holds the rest
        } catch (t: Throwable) {
            Log.w(TAG, "hold expiry failed", t)
        } finally {
            gestureLock.unlock()
        }
    }

    /**
     * Run a timeline of gesture ops, all injected together as one gesture. Op shape:
     *   { "kind": "down"|"move"|"up"|"tap"|"swipe"|"hold"|"wait",
     *     "finger": 0..7,
     *     "x"/"y" or "fx"/"fy" (0..1 fractions),
     *     "x2"/"y2" or "fx2"/"fy2" (swipe end),
     *     "durationMs": stroke length (tap 60, swipe 300, hold 500, move 100, up 100 by default),
     *     "ms": wait length }
     * A finger that goes down and isn't lifted stays held after the call (and is carried into the next call).
     * Blocks until the gesture completes. Returns {ok, durationMs, held[]}.
     */
    fun gesture(ops: JSONArray?): JSONObject {
        gestureLock.lock()
        try {
            return gestureUnlocked(ops)
        } finally {
            gestureLock.unlock()
        }
    }

    private fun gestureUnlocked(ops: JSONArray?): JSONObject {
        try {
            val size = screenSize()
            if (size[0] <= 0 || size[1] <= 0) return err("cannot read the screen size")
            // Screen size changed (rotation / resolution switch) → held coordinates are meaningless: reset.
            if (screenW != 0 && (size[0] != screenW || size[1] != screenH)) releaseAllFingersUnlocked()
            screenW = size[0]
            screenH = size[1]

            val n = ops?.length() ?: 0
            if (ops == null || n == 0) return err("the gesture has no strokes")

            // ===== pass 1: parse + validate + timeline (no real state is touched) =====
            val now = System.currentTimeMillis()
            // Fingers held past the timeout are lifted by this gesture and count as not held.
            val expired = BooleanArray(MAX_FINGERS) { fingerDown[it] && now - fingerDownAt[it] > HOLD_TIMEOUT_MS }
            // Virtual finger state: how this request's down/move/up evolve the fingers (for validation only).
            val virtualDown = BooleanArray(MAX_FINGERS) { fingerDown[it] && !expired[it] }
            val kinds = arrayOfNulls<String>(n)
            val fings = IntArray(n)
            val xs = IntArray(n)
            val ys = IntArray(n)
            val x2s = IntArray(n)
            val y2s = IntArray(n)
            val starts = LongArray(n)
            val ends = LongArray(n)
            // Held fingers taken over by an op in this request → when their first op starts
            // (they get a "keep holding until then" stroke).
            val firstOpStart = LongArray(MAX_FINGERS) { -1 }
            var t = 0L
            for (i in 0 until n) {
                val op = ops.optJSONObject(i) ?: return err("stroke $i is not an object")
                val kind = op.optString("kind", "")
                val finger = if (op.has("finger")) op.optInt("finger", -1) else -1
                val x = resolveCoord(op, "fx", "x", screenW)
                val y = resolveCoord(op, "fy", "y", screenH)
                val x2 = resolveCoord(op, "fx2", "x2", screenW)
                val y2 = resolveCoord(op, "fy2", "y2", screenH)
                // A zero/negative duration would make StrokeDescription throw: treat it as "use the default".
                val dur = op.optLong("durationMs", -1).let { if (it > 0) it else -1 }
                val validFinger = finger in 0 until MAX_FINGERS
                val held = validFinger && virtualDown[finger]
                val seg: Long
                when (kind) {
                    "wait" -> seg = maxOf(0L, op.optLong("ms", op.optLong("durationMs", 0)))
                    "down" -> {
                        seg = 40
                        if (!validFinger) return err("down: finger must be 0..${MAX_FINGERS - 1}")
                        if (x < 0 || y < 0) return err("down needs x/y or fx/fy")
                        if (held && firstOpStart[finger] < 0) firstOpStart[finger] = t
                        virtualDown[finger] = true
                    }
                    "move" -> {
                        seg = if (dur > 0) dur else 100
                        if (!validFinger) return err("move: finger must be 0..${MAX_FINGERS - 1}")
                        if (!held) return err("move: finger $finger is not held" + (if (expired[finger]) " (auto-released after ${HOLD_TIMEOUT_MS / 1000}s; put it down again)" else " (down first)"))
                        if (x < 0 || y < 0) return err("move needs x/y or fx/fy")
                        if (firstOpStart[finger] < 0) firstOpStart[finger] = t
                    }
                    "up" -> {
                        seg = if (dur > 0) dur else 100
                        if (!validFinger) return err("up: finger must be 0..${MAX_FINGERS - 1}")
                        if (!held) return err("up: finger $finger is not held" + (if (expired[finger]) " (already auto-released after ${HOLD_TIMEOUT_MS / 1000}s)" else ""))
                        if (firstOpStart[finger] < 0) firstOpStart[finger] = t
                        virtualDown[finger] = false
                    }
                    "tap", "hold" -> {
                        seg = if (dur > 0) dur else if (kind == "tap") 60 else 500
                        if (x < 0 || y < 0) return err("$kind needs x/y or fx/fy")
                        if (held) {
                            if (firstOpStart[finger] < 0) firstOpStart[finger] = t
                            virtualDown[finger] = false
                        }
                    }
                    "swipe" -> {
                        seg = if (dur > 0) dur else 300
                        if (x < 0 || y < 0 || x2 < 0 || y2 < 0) return err("swipe needs a start (x/y or fx/fy) and an end (x2/y2 or fx2/fy2)")
                        if (held) {
                            if (firstOpStart[finger] < 0) firstOpStart[finger] = t
                            virtualDown[finger] = false
                        }
                    }
                    else -> return err("unknown stroke kind: \"$kind\"")
                }
                kinds[i] = kind
                fings[i] = finger
                xs[i] = x; ys[i] = y; x2s[i] = x2; y2s[i] = y2
                starts[i] = t
                ends[i] = t + seg
                t += seg
            }
            val totalT = t
            if (totalT <= 0) return err("the gesture timeline is empty")
            val maxMs = maxGestureMs
            if (totalT > maxMs) return err("gesture too long (> ${maxMs / 1000}s); to press for long, use down and keep the finger held instead of long waits")

            // ===== pass 2: build strokes (validation passed; no early returns from here) =====
            val strokes = ArrayList<Stroke>()
            // Currently held fingers:
            //  - expired        → lift in place;
            //  - not taken over → keep holding for the whole gesture;
            //  - taken over     → keep holding until its first op starts (then the op's stroke takes over,
            //                     so the system doesn't lift it while we wait).
            for (f in 0 until MAX_FINGERS) {
                if (!fingerDown[f]) continue
                val p = Path()
                p.moveTo(fingerX[f], fingerY[f])
                when {
                    expired[f] -> { strokes.add(Stroke(p, 0, 80, false)); fingerDown[f] = false }
                    firstOpStart[f] < 0 -> strokes.add(Stroke(p, 0, totalT, true))
                    firstOpStart[f] > 0 -> strokes.add(Stroke(p, 0, firstOpStart[f], true))
                    // firstOpStart == 0: the op's stroke starts at 0, no holding stroke needed
                }
            }

            val curX = fingerX.copyOf()
            val curY = fingerY.copyOf()
            for (i in 0 until n) {
                val kind = kinds[i]
                val finger = fings[i]
                val x = xs[i].toFloat()
                val y = ys[i].toFloat()
                val start = starts[i]
                val seg = ends[i] - start
                val held = finger in 0 until MAX_FINGERS && fingerDown[finger]
                when (kind) {
                    "wait" -> {} // no stroke, only time
                    "down" -> {
                        val p = Path()
                        if (held) {
                            // Already held → slide to the new spot and keep holding.
                            p.moveTo(curX[finger], curY[finger]); p.lineTo(x, y)
                            strokes.add(Stroke(p, start, seg, true))
                        } else {
                            p.moveTo(x, y)
                            strokes.add(Stroke(p, start, totalT - start, true))
                            fingerDownAt[finger] = now
                        }
                        fingerDown[finger] = true
                        fingerX[finger] = x; fingerY[finger] = y
                        curX[finger] = x; curY[finger] = y
                    }
                    "move" -> {
                        val p = Path()
                        p.moveTo(curX[finger], curY[finger]); p.lineTo(x, y)
                        strokes.add(Stroke(p, start, seg, true))
                        fingerX[finger] = x; fingerY[finger] = y
                        curX[finger] = x; curY[finger] = y
                    }
                    "up" -> {
                        val p = Path()
                        p.moveTo(curX[finger], curY[finger])
                        if (xs[i] >= 0 && ys[i] >= 0) {
                            p.lineTo(x, y) // slide to the given spot, then lift
                            fingerX[finger] = x; fingerY[finger] = y
                        }
                        strokes.add(Stroke(p, start, seg, false))
                        fingerDown[finger] = false
                    }
                    "tap", "hold" -> {
                        val p = Path()
                        if (held) {
                            // Held finger: slide to the target and lift (hold: stay there for the duration first).
                            p.moveTo(curX[finger], curY[finger]); p.lineTo(x, y)
                            fingerDown[finger] = false
                            fingerX[finger] = x; fingerY[finger] = y
                        } else {
                            p.moveTo(x, y) // new finger: press → (hold) → lift
                        }
                        strokes.add(Stroke(p, start, seg, false))
                    }
                    "swipe" -> {
                        val ex = x2s[i].toFloat()
                        val ey = y2s[i].toFloat()
                        val p = Path()
                        if (held) {
                            // Held finger: from where it is to the end point, then lift.
                            p.moveTo(curX[finger], curY[finger]); p.lineTo(ex, ey)
                            fingerDown[finger] = false
                            fingerX[finger] = ex; fingerY[finger] = ey
                        } else {
                            p.moveTo(x, y); p.lineTo(ex, ey)
                        }
                        strokes.add(Stroke(p, start, seg, false))
                    }
                }
            }

            if (strokes.isEmpty()) {
                // e.g. only waits and no finger held: nothing to inject, just take the time.
                SystemClock.sleep(totalT)
                return JSONObject().put("ok", true).put("durationMs", totalT).put("held", heldJson(false))
            }
            val limit = maxStrokes
            if (strokes.size > limit) {
                releaseAllFingersUnlocked()
                return err("too many strokes in one gesture (max $limit, held fingers included); all fingers were released")
            }
            val gb = GestureDescription.Builder()
            for (s in strokes) gb.addStroke(GestureDescription.StrokeDescription(s.path, s.start, s.duration, s.willContinue))
            val g = gb.build()

            val latch = CountDownLatch(1)
            var success = false
            val dispatched = dispatchGesture(g, object : GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription?) { success = true; latch.countDown() }
                override fun onCancelled(gestureDescription: GestureDescription?) { latch.countDown() }
            }, cbHandler)
            if (!dispatched) {
                releaseAllFingersUnlocked()
                return err("the system refused the gesture (accessibility service not ready?); all fingers were reset")
            }
            if (!latch.await(totalT + 5000, TimeUnit.MILLISECONDS)) {
                releaseAllFingersUnlocked()
                return err("the gesture timed out; all fingers were reset")
            }
            if (!success) {
                releaseAllFingersUnlocked()
                return err("the system cancelled the gesture (interrupted by another gesture or a real touch?); all fingers were reset")
            }
            scheduleExpiryUnlocked()
            return JSONObject().put("ok", true).put("durationMs", totalT).put("held", heldJson(false))
        } catch (t: Throwable) {
            releaseAllFingersUnlocked()
            return err("gesture error: ${t.message ?: t.javaClass.simpleName}")
        }
    }

    // ------------------------------------------------------------------ screenshot

    /**
     * Screenshot of a display (default: the main one; a virtual display id works too) as a mutable
     * software ARGB_8888 bitmap at native resolution. API 30+ (no MediaProjection prompt).
     * Throws with a model-readable message on failure.
     */
    fun screenshot(displayId: Int = Display.DEFAULT_DISPLAY): Bitmap {
        if (Build.VERSION.SDK_INT < 30) throw IllegalStateException("screenshots need Android 11+ (this is API ${Build.VERSION.SDK_INT}); use screen.read for the element tree")
        val handler = cbHandler ?: throw IllegalStateException("accessibility service is not connected")
        val executor = Executor { r -> handler.post(r) }
        var attempt = 0
        while (true) {
            val latch = CountDownLatch(1)
            var bmp: Bitmap? = null
            var code = 0
            var failure: String? = null
            takeScreenshot(displayId, executor, object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    try {
                        // ScreenshotResult carries a HardwareBuffer (+ColorSpace): wrap it, then copy to a
                        // software bitmap (mutable: the grid overlay draws on it with a Canvas).
                        val hb = result.hardwareBuffer
                        val hw = Bitmap.wrapHardwareBuffer(hb, result.colorSpace)
                        if (hw == null) {
                            failure = "the screenshot bitmap is empty"
                        } else {
                            bmp = hw.copy(Bitmap.Config.ARGB_8888, true)
                            hw.recycle()
                        }
                        hb.close()
                    } catch (t: Throwable) {
                        failure = "could not read the screenshot: ${t.message}"
                    } finally {
                        latch.countDown()
                    }
                }

                override fun onFailure(errorCode: Int) {
                    code = errorCode
                    latch.countDown()
                }
            })
            if (!latch.await(6000, TimeUnit.MILLISECONDS)) throw IllegalStateException("the screenshot timed out")
            bmp?.let { return it }
            failure?.let { throw IllegalStateException(it) }
            // 3 = ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT: the platform rate-limits screenshots
            // (about one every 333 ms, stricter on some ROMs) — wait and retry.
            if (code == 3 && attempt < 3) {
                attempt++
                SystemClock.sleep(400L * attempt)
                continue
            }
            throw IllegalStateException(when (code) {
                1 -> "screenshot failed (internal error; secure pages such as payment or password screens can't be captured)"
                2 -> "screenshot failed: this accessibility service may not take screenshots"
                3 -> "screenshot failed: too many screenshots in a short time, try again in a second"
                4 -> "screenshot failed: invalid display $displayId"
                else -> "screenshot failed (error $code; secure pages can't be captured)"
            })
        }
    }
}
