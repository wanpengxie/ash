package ai.ash.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Rect
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Choreographer
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.widget.FrameLayout
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import ai.ash.BuildConfig
import ai.ash.R
import ai.ash.host.AppState
import ai.ash.host.TaskFrame
import ai.ash.host.TaskStatus
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** One reusable, local-only WebView in a tightly measured native overlay window. */
object TaskCapsule {
    private const val ORIGIN = "https://appassets.androidplatform.net"
    private const val PAGE = "$ORIGIN/assets/ash-island/index.html"
    private val main = Handler(Looper.getMainLooper())
    private var app: Context? = null
    private var root: FrameLayout? = null
    private var web: WebView? = null
    private var params: WindowManager.LayoutParams? = null
    private var attached = false
    private var ready = false
    private var visible = false
    private var model: JSONObject? = null
    private var lastModel = ""
    private var maxHeight = 700
    private var dragged = false
    private var dragX = 0; private var dragY = 0
    private var suppressed = 0
    private var passingTouches = 0
    @Volatile private var editing = false
    @Volatile private var screenBounds: Rect? = null
    private var restore: (() -> Unit)? = null
    private val submitted = mutableMapOf<String, String>()
    private var sending = false
    private var attemptId = ""
    private var attemptText = ""
    private var attemptTarget: String? = null

    fun ownsWindow(bounds: Rect): Boolean = screenBounds == bounds
    fun isEditing(): Boolean = editing
    private fun dp(n: Double) = (n * (app?.resources?.displayMetrics?.density ?: 1f)).toInt()
    private fun unlocked(ctx: Context) = !ctx.getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked &&
        ctx.getSystemService(android.os.PowerManager::class.java).isInteractive
    private fun allowed() = visible && suppressed == 0 && app?.let { unlocked(it) && !AppState.homeVisible && Settings.canDrawOverlays(it) } == true
    private fun js(code: String) { if (ready) web?.evaluateJavascript(code, null) }

    /** Prewarm once. Capture and transient hiding only detach, never recreate this view. */
    fun prewarm(ctx: Context) { main.post { ensureView(ctx.applicationContext) } }

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensureView(ctx: Context) {
        if (web != null) return
        app = ctx.applicationContext
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        if (BuildConfig.ISOLATED_PROBE) WebView.setWebContentsDebuggingEnabled(true)
        val box = FrameLayout(ctx).apply { contentDescription = "AshTaskCapsule"; setBackgroundColor(Color.TRANSPARENT) }
        val browser = object : WebView(ctx) {
            override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
                super.onWindowFocusChanged(hasWindowFocus)
                if (hasWindowFocus && editing) post { showKeyboard() }
            }
            override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
                if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP && editing) { setEditing(false); return true }
                return super.onKeyPreIme(keyCode, event)
            }
        }.apply {
            setBackgroundColor(Color.TRANSPARENT)
            isVerticalScrollBarEnabled = false; isHorizontalScrollBarEnabled = false
            settings.apply {
                javaScriptEnabled = true; domStorageEnabled = false
                allowFileAccess = false; allowContentAccess = false
                @Suppress("DEPRECATION")
                allowFileAccessFromFileURLs = false
                @Suppress("DEPRECATION")
                allowUniversalAccessFromFileURLs = false
                setSupportMultipleWindows(false); setSupportZoom(false); textZoom = 100
            }
        }
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(ctx)).build()
        browser.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest) = true
            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse {
                val uri = req.url
                if (uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.port == -1 && uri.query == null && uri.fragment == null &&
                    Regex("^/assets/ash-island/(index\\.html|component\\.(css|js)|host\\.(css|js)|avatars/(default|focused|listening|resting|success|thinking)\\.webp)$").matches(uri.encodedPath.orEmpty())) {
                    loader.shouldInterceptRequest(uri)?.let { return it }
                }
                return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }
            override fun onPageStarted(view: WebView, url: String, icon: android.graphics.Bitmap?) {
                ready = false
                if (url != PAGE) view.stopLoading()
            }
        }
        WebViewCompat.addWebMessageListener(browser, "AshIslandNative", setOf(ORIGIN)) { _, message, origin, mainFrame, _ ->
            if (!mainFrame || origin.toString() != ORIGIN || browser.url != PAGE) return@addWebMessageListener
            val text = message.data ?: return@addWebMessageListener
            if (text.length > 16384) return@addWebMessageListener
            val body = runCatching { JSONObject(text) }.getOrNull() ?: return@addWebMessageListener
            handle(body)
        }
        box.addView(browser, FrameLayout.LayoutParams(-1, -1))
        box.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> rememberBounds() }
        box.viewTreeObserver.addOnPreDrawListener { rememberBounds(); true }
        box.viewTreeObserver.addOnGlobalLayoutListener {
            if (!attached) return@addOnGlobalLayoutListener
            val frame = Rect(); box.getWindowVisibleDisplayFrame(frame)
            val top = IntArray(2); box.getLocationOnScreen(top)
            // The page keeps 8dp above the island and 32dp below it for its shadow (ash-island/host.css).
            val available = ((frame.bottom - top[1] - dp(40.0)) / ctx.resources.displayMetrics.density).toInt().coerceAtLeast(220)
            if (available != maxHeight) { maxHeight = available; push() }
        }
        root = box; web = browser
        val prefs = ctx.getSharedPreferences("ash_capsule_input", Context.MODE_PRIVATE)
        attemptId = prefs.getString("pending_id", "").orEmpty(); attemptText = prefs.getString("pending_text", "").orEmpty()
        attemptTarget = prefs.getString("pending_question", null)
        browser.loadUrl(PAGE)
    }

    internal fun update(ctx: Context, frame: TaskFrame, elapsed: Long, stale: Boolean, interactive: Boolean, canStop: Boolean, notice: String?) {
        check(Looper.myLooper() == Looper.getMainLooper())
        ensureView(ctx.applicationContext)
        model = IslandPresentation.project(frame, elapsed, stale, interactive, canStop, notice, submitted, System.currentTimeMillis())
        restore = { update(ctx, frame, elapsed, stale, interactive, canStop, notice) }
        visible = true
        if (!allowed()) { if (!unlocked(ctx) || AppState.homeVisible) setEditing(false); detach(); return }
        attach(); rememberBounds(); push()
    }
    private fun push() {
        val value = model ?: return
        val ctx = app ?: return
        value.put("cardWidth", minOf(362, (ctx.resources.displayMetrics.widthPixels / ctx.resources.displayMetrics.density).toInt() - 24))
            .put("maxHeight", maxHeight).put("reduceMotion", Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f)
        val json = value.toString()
        if (ready && json != lastModel) { lastModel = json; js("window.AshIsland.receive(${JSONObject.quote(json)})") }
    }
    private fun attach() {
        if (attached || !allowed()) return
        val ctx = app ?: return; val box = root ?: return
        val p = params ?: WindowManager.LayoutParams(dp(260.0), dp(64.0),
            if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.LEFT
            // The island sits 8dp below the status bar; that gap is the page's own top padding.
            x = (ctx.resources.displayMetrics.widthPixels - width) / 2; y = 0
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
            windowAnimations = R.style.CapsuleWindowAnimation
            setTitle("AshTaskCapsule")
        }.also { params = it }
        runCatching {
            box.visibility = View.VISIBLE
            ctx.getSystemService(WindowManager::class.java).addView(box, p)
            attached = true; applyTouchMode(); rememberBounds(); js("window.AshIsland.restored()")
        }.onFailure { android.util.Log.w("ash.capsule", "could not attach island", it) }
    }
    private fun rememberBounds() {
        if (!attached) { screenBounds = null; return }
        val box = root ?: return; val at = IntArray(2); box.getLocationOnScreen(at)
        screenBounds = Rect(at[0], at[1], at[0] + box.width, at[1] + box.height)
    }
    private fun detach() {
        if (!attached) return
        val ctx = app ?: return; val box = root ?: return
        // WindowManager may keep an exiting Surface alive for its own animation, independently
        // of WebView/View visibility. Make that surface transparent before removing the window.
        params?.let { p -> p.alpha = 0f; runCatching { ctx.getSystemService(WindowManager::class.java).updateViewLayout(box, p) } }
        box.visibility = View.INVISIBLE
        ctx.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(box.windowToken, 0)
        runCatching { ctx.getSystemService(WindowManager::class.java).removeViewImmediate(box) }
            .onFailure { android.util.Log.w("ash.capsule", "could not detach island", it) }
        attached = false; screenBounds = null
    }
    fun hide() { main.post { visible = false; setEditing(false); detach(); restore = null } }
    fun release() { main.post {
        visible = false; setEditing(false); detach(); web?.destroy(); root = null; web = null; params = null
        ready = false; lastModel = ""; model = null; restore = null; submitted.clear()
    } }
    private fun setEditing(value: Boolean) {
        if (value && (!allowed() || passingTouches > 0)) return
        editing = value
        if (!value) {
            js("window.AshIsland.blurInput()")
            web?.let { app?.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(it.windowToken, 0); it.clearFocus() }
        }
        applyTouchMode()
        if (value) web?.post { showKeyboard() }
    }
    private fun showKeyboard() {
        if (!editing || !attached || !allowed()) return
        val browser = web ?: return
        browser.requestFocus(); js("window.AshIsland.focusInput()")
        app?.getSystemService(InputMethodManager::class.java)?.showSoftInput(browser, InputMethodManager.SHOW_IMPLICIT)
    }
    private fun handle(body: JSONObject) {
        val action = body.optString("action")
        if (action == "ready") {
            ready = true; lastModel = ""; push()
            if (attemptText.isNotBlank()) js("window.AshIsland.restoreDraft(${JSONObject.quote(attemptText)},${JSONObject.quote(attemptTarget)})")
            return
        }
        val value = model ?: return
        if (body.optString("turn") != value.optString("turn")) {
            if (action == "send" && !sending) js("window.AshIsland.sent(false,'状态已更新，请核对后重试')")
            return
        }
        if (action == "size") {
            val ctx = app ?: return; val p = params ?: return
            val width = body.optDouble("width"); val height = body.optDouble("height")
            if (!width.isFinite() || !height.isFinite() || width !in 64.0..450.0 || height !in 32.0..2000.0) return
            val oldWidth = p.width
            p.width = dp(width).coerceAtMost(ctx.resources.displayMetrics.widthPixels)
            p.height = dp(height).coerceAtMost(ctx.resources.displayMetrics.heightPixels)
            p.x = (if (dragged) p.x + (oldWidth - p.width) / 2 else (ctx.resources.displayMetrics.widthPixels - p.width) / 2)
                .coerceIn(0, (ctx.resources.displayMetrics.widthPixels - p.width).coerceAtLeast(0))
            p.y = p.y.coerceIn(0, (ctx.resources.displayMetrics.heightPixels - p.height - dp(48.0)).coerceAtLeast(0))
            if (attached) ctx.getSystemService(WindowManager::class.java).updateViewLayout(root, p)
            return
        }
        if (!attached || !allowed() || passingTouches > 0) return
        when (action) {
            "focus" -> setEditing(body.optBoolean("value"))
            "open" -> { setEditing(false); app?.startActivity(Intent(app, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
            "dismiss" -> if (value.optBoolean("mayClose")) TaskStatus.dismiss(value.getString("turn"))
            "stop" -> if (value.optBoolean("canStop") && value.optBoolean("interactive")) TaskStatus.stop(value.getString("turn"))
            "answer" -> {
                val id = body.optString("requestId"); val choice = body.optString("choice")
                if (!value.optBoolean("interactive") || submitted.containsKey(id)) return
                submitted[id] = "sending"; restore?.invoke()
                TaskStatus.answerCard(id, choice) { ok, message ->
                    if (ok) submitted[id] = if (choice == "deny") "denied" else "answered" else submitted.remove(id)
                    restore?.invoke(); toast(message)
                }
            }
            "send" -> send(body.optString("text"), body.optString("requestId").takeIf { it.isNotBlank() && it != "null" })
            "drag" -> {
                val p = params ?: return; val ctx = app ?: return
                if (body.optString("phase") == "start") { dragged = true; dragX = p.x; dragY = p.y }
                if (body.optString("phase") == "move") {
                    p.x = (dragX + dp(body.optDouble("dx", 0.0))).coerceIn(0, (ctx.resources.displayMetrics.widthPixels - p.width).coerceAtLeast(0))
                    p.y = (dragY + dp(body.optDouble("dy", 0.0))).coerceIn(0, (ctx.resources.displayMetrics.heightPixels - p.height - dp(48.0)).coerceAtLeast(0))
                    ctx.getSystemService(WindowManager::class.java).updateViewLayout(root, p)
                }
            }
        }
    }
    private fun toast(text: String) { app?.let { android.widget.Toast.makeText(it, text, android.widget.Toast.LENGTH_SHORT).show() } }
    private fun send(text: String, target: String?) {
        if (sending || text.isBlank() || text.length > 4000) return
        val ctx = app ?: return
        if (text != attemptText || target != attemptTarget || attemptId.isBlank()) {
            attemptText = text; attemptTarget = target; attemptId = UUID.randomUUID().toString()
        }
        val prefs = ctx.getSharedPreferences("ash_capsule_input", Context.MODE_PRIVATE)
        if (!prefs.edit().putString("pending_id", attemptId).putString("pending_text", text).putString("pending_question", target).commit()) {
            js("window.AshIsland.sent(false,'无法保存发送状态，请重试')"); return
        }
        sending = true
        val done: (Boolean, String) -> Unit = { ok, message ->
            sending = false
            if (ok) {
                prefs.edit().remove("pending_id").remove("pending_text").remove("pending_question").commit()
                attemptId = ""; attemptText = ""; attemptTarget = null
                if (target != null) submitted[target] = "answered"
                setEditing(false)
            }
            js("window.AshIsland.sent($ok,${JSONObject.quote(message)})"); restore?.invoke()
        }
        if (target == null) TaskStatus.sendInput(text, attemptId, done) else TaskStatus.answerCard(target, "custom", text, done)
    }
    private fun applyTouchMode() {
        val p = params ?: return
        val focusFlags = if (editing) p.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv() and WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM.inv()
            else p.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        val flags = if (passingTouches > 0) focusFlags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE else focusFlags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        val alpha = if (passingTouches > 0) 0.7f else 1f
        if (p.flags != flags || p.alpha != alpha) {
            p.flags = flags; p.alpha = alpha
            if (attached) app?.getSystemService(WindowManager::class.java)?.updateViewLayout(root, p)
        }
    }
    /** Model gestures never type into the owner's composer. */
    fun <T> withTouchPassthrough(action: () -> T): T {
        val latch = CountDownLatch(1); var applied = false; var entered = false
        main.post {
            if (editing) { latch.countDown(); return@post }
            entered = true; passingTouches++
            runCatching { applyTouchMode(); applied = true }
            Choreographer.getInstance().postFrameCallback {
                Choreographer.getInstance().postFrameCallback { main.postDelayed({ latch.countDown() }, 100) }
            }
        }
        try {
            if (!latch.await(1000, TimeUnit.MILLISECONDS) || !applied) throw IllegalStateException("owner_input_busy: owner is entering a message; do not take input focus")
            return action()
        } finally { main.postDelayed({ if (entered) passingTouches = (passingTouches - 1).coerceAtLeast(0); applyTouchMode() }, 120) }
    }
    /** Remove the actual window immediately, then wait two compositor frames. Keep WebView alive. */
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
