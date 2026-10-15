package ai.ash.ui

import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.Role
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.security.SecureRandom

/**
 * A card's mini app (its Html component) on the phone (MOBILE-ARCH §12.4, §12.5, §12.3): the page an app's own pages get —
 * its app's origin (or the sandbox of cards without an app), the CSP before load, the port shim — in a [box] of the node's
 * height. No JS objects: the page talks over a WebMessagePort the host hands it ([MiniGate] checks every message). Off screen
 * or the card not active: the port is closed and nothing is taken. Dormant, gone for long, or one too many alive: the WebView
 * is destroyed and the box keeps its height; back on screen it loads again. A crashed renderer leaves a quiet line to reload,
 * and nothing it asked for is done again.
 */
internal class CardMini(
    private val ctx: Context,
    card: String,
    component: String,
    app: String?,
    /** `ash.send`: an event, as a Button's. */
    private val onSend: (String, JSONObject) -> Unit,
    /** `ash.call / ask / tell`: [MiniGate.actBody] to the hub, the answer `{state, text, result?}` back. */
    private val onAct: (MiniGate, JSONObject, (JSONObject) -> Unit) -> Unit,
) {
    val gate = MiniGate(card, component, app)
    private val main = Handler(Looper.getMainLooper())
    /** Where the page is; its height is the node's, with or without a page in it. */
    val box = FrameLayout(ctx)
    private var html = ""
    private var vars: Map<String, String> = emptyMap()
    private var dark = false
    private var life = "active"
    private var web: WebView? = null
    private var port: WebMessagePort? = null
    private var ticket: MiniGate.Ticket? = null
    private var token = ""
    /** Ports handed to the page now (the first is `token`, the next ones `token#n`). */
    private var handed = 0
    private var ready = false
    private var attached = false
    private var note: TextView? = null
    private val dropLater = Runnable { if (!attached) drop() }

    init {
        box.addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
            override fun onViewAttachedToWindow(v: View) { attached = true; main.removeCallbacks(dropLater); wake() }
            override fun onViewDetachedFromWindow(v: View) {
                attached = false; pause()
                main.removeCallbacks(dropLater); main.postDelayed(dropLater, DETACHED_DROP_MS)
            }
        })
    }

    /** What the node says now: a page is loaded again only when its [html] (or the theme) changed. */
    fun set(html: String, vars: Map<String, String>, dark: Boolean, life: String) {
        val changed = html != this.html || vars != this.vars || dark != this.dark
        this.html = html; this.vars = vars; this.dark = dark; this.life = life
        when {
            life == "dormant" -> { drop(); quiet("小应用休眠中", null) }
            changed && web != null -> if (attached) load() else drop()
            else -> wake()
        }
    }

    /** On screen, the card active: a page (loaded if there is none) and its port. */
    private fun wake() {
        if (!attached || life == "dormant") return
        if (life != "active" && life.isNotEmpty()) { pause(); return }
        val w = web
        if (w == null) { if (note == null || note?.tag != CRASHED) load(); return }
        budget(this)
        if (port == null && ready) hand(w)
    }

    /** Off screen or not active: the port closed; the page stays as it is. */
    private fun pause() {
        gate.pause()
        runCatching { port?.close() }
        port = null; ticket = null
    }

    /** The WebView let go (its port and callbacks with it); the box keeps its height. */
    fun drop() {
        pause()
        main.removeCallbacks(dropLater)
        live.gone(this)
        web?.let { w -> box.removeView(w); runCatching { w.destroy() } }
        web = null; ready = false
        if (life != "dormant") quiet("小应用 · 点一下打开", ::load)
    }

    /** For good (the card is gone from the chat). */
    fun destroy() { life = "dormant"; drop(); box.removeAllViews(); note = null }

    @SuppressLint("SetJavaScriptEnabled")
    private fun load() {
        pause()
        web?.let { w -> box.removeView(w); runCatching { w.destroy() } }
        note?.let { box.removeView(it) }; note = null
        val generation = gate.load()
        token = randomToken()
        handed = 0; ready = false
        val origin = gate.origin
        val w = WebView(ctx)
        web = w
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = false
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION") allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION") allowUniversalAccessFromFileURLs = false
            setGeolocationEnabled(false)
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            cacheMode = WebSettings.LOAD_NO_CACHE
            @Suppress("DEPRECATION") saveFormData = false
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(w, false)
        w.setBackgroundColor(Color.TRANSPARENT)
        w.isVerticalScrollBarEnabled = false
        w.webViewClient = object : WebViewClient() {
            // Never navigates, never opens anything.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
            // Only the page itself, data: and blob:; no network, no files.
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val scheme = request.url.scheme
                if (scheme == "data" || scheme == "blob") return null
                if (request.isForMainFrame && request.url.toString() == "$origin/") return null
                return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", mapOf("cache-control" to "no-store"), ByteArrayInputStream(ByteArray(0)))
            }
            override fun onPageCommitVisible(view: WebView, url: String?) = loaded(view, generation)
            override fun onPageFinished(view: WebView, url: String?) = loaded(view, generation)
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (view === web) crashed() else runCatching { view.destroy() }
                return true
            }
        }
        w.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
            override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) { callback.invoke(origin, false, false) }
            override fun onShowFileChooser(w: WebView?, cb: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean { cb?.onReceiveValue(null); return true }
        }
        box.addView(w, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        budget(this)
        w.loadDataWithBaseURL("$origin/", gate.document(html, vars, dark, token), "text/html", "utf-8", null)
    }

    private fun loaded(view: WebView, generation: Long) {
        if (view !== web || generation != gate.generation) return
        ready = true
        if (attached && port == null && (life == "active" || life.isEmpty())) hand(view)
    }

    /** Hands the page a new port (listening on ours first), to its origin only: the main frame. */
    private fun hand(w: WebView) {
        runCatching {
            val (mine, theirs) = w.createWebMessageChannel()
            val t = gate.ticket()
            mine.setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                override fun onMessage(p: WebMessagePort, message: WebMessage) = heard(t, message.data)
            }, main)
            port = mine; ticket = t
            w.postWebMessage(WebMessage(if (handed == 0) token else "$token#$handed", arrayOf(theirs)), Uri.parse(gate.origin))
            handed++
        }.onFailure { Log.w(TAG, "could not connect the mini app", it); pause() }
    }

    private fun heard(t: MiniGate.Ticket, raw: String?) {
        when (val v = gate.check(t, raw, SystemClock.uptimeMillis())) {
            is MiniGate.Verdict.Send -> onSend(v.action, v.context)
            is MiniGate.Verdict.Act -> onAct(gate, v.request) { answer -> say(t, gate.reply(v.id, answer)) }
            is MiniGate.Verdict.Refuse -> v.id?.let { say(t, gate.refusal(it, v.reason)) }
        }
    }

    /** To the page, only on the port it spoke on, while that is still the page's port. */
    private fun say(t: MiniGate.Ticket, text: String) {
        if (!gate.live(t) || ticket !== t) return
        runCatching { port?.postMessage(WebMessage(text)) }
    }

    private fun crashed() {
        pause()
        live.gone(this)
        web?.let { w -> box.removeView(w); runCatching { w.destroy() } }
        web = null; ready = false
        quiet("这个小应用停了 · 重新加载", ::load)
        note?.tag = CRASHED
    }

    /** A quiet line in the box (its height stays); a tap does [act]. */
    private fun quiet(text: String, act: (() -> Unit)?) {
        note?.let { box.removeView(it) }
        val c = AshUi.p(ctx)
        note = AshUi.text(ctx, text, AshType(13f, 18f, 400, Role.TEXT_3)).apply {
            gravity = Gravity.CENTER
            background = AshUi.rounded(c.surface2, AshUi.dpF(ctx, 12f))
            if (act != null) { isClickable = true; setOnClickListener { act() } }
        }
        box.addView(note, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    companion object {
        private const val TAG = "ash.cards"
        private const val CRASHED = "crashed"
        /** A mini app off screen this long is let go. */
        private const val DETACHED_DROP_MS = 60_000L
        /** At most this many alive in the app. */
        const val MAX_LIVE = 3
        private val live = MiniBudget<CardMini>(MAX_LIVE)

        private fun budget(m: CardMini) { for (old in live.seen(m)) if (old !== m) old.drop() }

        private fun randomToken(): String {
            val b = ByteArray(18).also { SecureRandom().nextBytes(it) }
            return Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        }
    }
}
