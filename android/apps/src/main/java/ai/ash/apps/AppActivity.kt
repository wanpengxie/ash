package ai.ash.apps

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
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
import android.widget.Button
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.security.SecureRandom
import java.util.TimeZone
import java.util.concurrent.Executors

/**
 * One app, in a task of its own: a slim bar that always shows which app this is (its name and icon, so a page cannot
 * pass itself off as Ash), tabs for its pages, and the page itself in a sandboxed WebView (its own origin, the CSP it
 * declared and nothing more, no files, no JS objects; it talks to the host only over a WebMessagePort).
 */
class AppActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newCachedThreadPool { Thread(it, "app-call") }
    private lateinit var appId: String
    private var info: AppInfo? = null
    private var icon: Bitmap? = null
    private lateinit var root: LinearLayout
    private lateinit var bar: LinearLayout
    private lateinit var iconView: ImageView
    private lateinit var nameView: TextView
    private lateinit var tabs: LinearLayout
    private lateinit var tabScroll: HorizontalScrollView
    private lateinit var content: FrameLayout
    private lateinit var notice: LinearLayout
    private lateinit var noticeText: TextView
    private lateinit var noticeButton: Button
    private var surface: String? = null
    private var page: Page? = null

    /** One loaded page: its WebView, its host, and the port its view talks on. */
    private inner class Page(val web: WebView, val host: McpHost, val token: String, val origin: String) {
        var port: WebMessagePort? = null
        var offered = 0
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val id = AppIds.fromLink(intent?.dataString)
        if (id == null) { finish(); return }
        appId = id
        build()
        Ui.taskCard(this, appId, null)
        load()
    }

    override fun onNewIntent(next: Intent) {
        super.onNewIntent(next)
        // The same app's task, brought back: keep the page as it is (another app always gets a task of its own).
        if (AppIds.fromLink(next.dataString) != appId) startActivity(next.setClass(this, OpenActivity::class.java).setFlags(0).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { moveTaskToBack(true) }

    override fun onConfigurationChanged(c: Configuration) {
        super.onConfigurationChanged(c)
        paint()
        page?.host?.contextChanged(JSONObject().put("theme", theme()))
    }

    override fun onDestroy() {
        drop()
        worker.shutdown()
        super.onDestroy()
    }

    private fun d(v: Int) = Ui.dp(this, v)
    private fun theme() = if (Ui.night(this)) "dark" else "light"

    private fun build() {
        root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(d(4), d(4), d(4), d(4)) }
        bar.addView(TextView(this).apply {
            text = "←"; textSize = 20f; gravity = Gravity.CENTER; contentDescription = "返回"
            setOnClickListener { moveTaskToBack(true) }
        }, LinearLayout.LayoutParams(d(44), d(44)))
        iconView = ImageView(this).apply { setImageResource(R.drawable.ic_launcher); scaleType = ImageView.ScaleType.FIT_CENTER }
        bar.addView(iconView, LinearLayout.LayoutParams(d(26), d(26)))
        nameView = TextView(this).apply { text = appId; textSize = 16f; typeface = Typeface.DEFAULT_BOLD; setPadding(d(10), 0, d(8), 0); maxLines = 1 }
        bar.addView(nameView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(TextView(this).apply {
            text = "⋯"; textSize = 20f; gravity = Gravity.CENTER; contentDescription = "更多"
            setOnClickListener { v -> menu(v) }
        }, LinearLayout.LayoutParams(d(44), d(44)))
        root.addView(bar)
        tabs = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(d(8), 0, d(8), d(4)) }
        tabScroll = HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(tabs); visibility = View.GONE }
        root.addView(tabScroll)
        content = FrameLayout(this)
        notice = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(d(32), d(32), d(32), d(32)) }
        noticeText = TextView(this).apply { textSize = 15f; gravity = Gravity.CENTER; text = "正在打开…" }
        noticeButton = Button(this).apply { visibility = View.GONE }
        notice.addView(noticeText)
        notice.addView(noticeButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = d(16) })
        content.addView(notice, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        Ui.insets(root)
        paint()
        setContentView(root)
    }

    private fun paint() {
        Ui.systemBars(this)
        root.setBackgroundColor(Ui.bar(this))
        bar.setBackgroundColor(Ui.bar(this))
        content.setBackgroundColor(Ui.page(this))
        nameView.setTextColor(Ui.text(this))
        noticeText.setTextColor(Ui.muted(this))
        for (i in 0 until bar.childCount) (bar.getChildAt(i) as? TextView)?.setTextColor(Ui.text(this))
        renderTabs()
    }

    private fun menu(anchor: View) {
        val m = PopupMenu(this, anchor)
        m.menu.add(0, 1, 0, "添加到桌面")
        m.menu.add(0, 2, 1, "重新加载")
        m.menu.add(0, 3, 2, "全部应用")
        m.setOnMenuItemClickListener {
            when (it.itemId) {
                1 -> Ui.pin(this, appId, info?.name ?: appId, icon)
                2 -> load()
                3 -> startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            true
        }
        m.show()
    }

    private fun say(text: String, button: String? = null, act: (() -> Unit)? = null) {
        drop()
        notice.visibility = View.VISIBLE
        noticeText.text = text
        noticeButton.visibility = if (button != null) View.VISIBLE else View.GONE
        noticeButton.text = button ?: ""
        noticeButton.setOnClickListener { act?.invoke() }
    }

    /** What Ash says about this app now; then its page. */
    private fun load() {
        say("正在打开…")
        Thread({
            val result = runCatching { Ash.apps(this).firstOrNull { it.id == appId } }
            val bitmap = if (icon == null && result.getOrNull() != null) Ash.icon(this, appId) else icon
            main.post {
                if (isDestroyed) return@post
                val error = result.exceptionOrNull()
                if (error != null) return@post say(error.message ?: "连不上 Ash", "打开 Ash") { Ash.open(this) }
                val a = result.getOrNull() ?: return@post say("Ash 里没有这个应用（$appId）", "全部应用") {
                    startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                }
                info = a
                icon = bitmap
                nameView.text = a.name
                if (bitmap != null) iconView.setImageBitmap(bitmap)
                Ui.taskCard(this, a.name, bitmap)
                if (!a.usable) return@post say(if (!a.enabled) "「${a.name}」已在 Ash 里停用。" else "「${a.name}」在 Ash 里批准后可用。", "打开 Ash") { Ash.open(this) }
                if (a.surfaces.isEmpty()) return@post say("「${a.name}」没有可以打开的页面。")
                if (surface == null || a.surfaces.none { it.first == surface }) surface = a.surfaces.first().first
                renderTabs()
                open(surface!!)
            }
        }, "app-load").start()
    }

    private fun renderTabs() {
        if (!::tabs.isInitialized) return
        val a = info
        tabs.removeAllViews()
        tabScroll.visibility = if (a != null && a.usable && a.surfaces.size > 1) View.VISIBLE else View.GONE
        tabScroll.setBackgroundColor(Ui.bar(this))
        for ((id, title) in a?.surfaces.orEmpty()) tabs.addView(TextView(this).apply {
            text = title; textSize = 14f; setPadding(d(14), d(6), d(14), d(6))
            val on = id == surface
            setTextColor(if (on) Ui.ACCENT else Ui.muted(this@AppActivity))
            typeface = if (on) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
            setOnClickListener { if (id != surface) { surface = id; renderTabs(); open(id) } }
        })
    }

    private fun open(surfaceId: String) {
        say("正在打开…")
        Thread({
            val result = runCatching { Ash.surface(this, appId, surfaceId) }
            main.post {
                if (isDestroyed || surface != surfaceId) return@post
                result.onSuccess { (html, csp) -> show(html, csp) }
                    .onFailure { say(it.message ?: "打不开这一页", "重新加载") { load() } }
            }
        }, "app-surface").start()
    }

    /** The page, in a fresh WebView: nothing carries over from the previous page but the app's own storage. */
    private fun show(html: String, csp: Csp) {
        drop()
        val origin = AppIds.origin(appId)
        Log.i(TAG, "$appId/$surface CSP: ${csp.header()}")
        val web = WebView(this)
        val token = randomToken()
        lateinit var p: Page
        val host = McpHost(appId, info?.name ?: appId, BuildConfig.VERSION_NAME, csp, Ash.backend(applicationContext), hostUi(),
            context = { hostContext(web) },
            send = { text -> main.post { if (page === p) runCatching { p.port?.postMessage(WebMessage(text)) } } },
            worker = worker)
        p = Page(web, host, token, origin)
        page = p
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION") allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION") allowUniversalAccessFromFileURLs = false
            setGeolocationEnabled(false)
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            safeBrowsingEnabled = true
            @Suppress("DEPRECATION") saveFormData = false
        }
        web.setBackgroundColor(Ui.page(this))
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // The page never navigates away; a link the owner tapped may open in the browser, after asking.
                val url = request.url.toString()
                if (request.isForMainFrame && request.hasGesture() && McpHost.webLink(url)) hostUi().confirmLink(url) { yes -> if (yes) hostUi().openLink(url) }
                return true
            }
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url.toString()
                // Local content (the page itself, data:, blob:) is the CSP's to judge; the network only for declared origins.
                if (request.url.scheme in setOf("data", "blob", "about")) return null
                if (request.isForMainFrame && url == "$origin/") return null
                return if (!url.startsWith("$origin/") && csp.allows(url)) null else refused()
            }
            override fun onPageCommitVisible(view: WebView, url: String?) { offerPort(p) }
            override fun onPageFinished(view: WebView, url: String?) { offerPort(p) }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                if (page === p) say("页面出错停止了", "重新加载") { load() } else runCatching { view.destroy() }
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) { request.deny() }
            override fun onGeolocationPermissionsShowPrompt(origin: String?, callback: GeolocationPermissions.Callback) { callback.invoke(origin, false, false) }
            override fun onShowFileChooser(w: WebView?, cb: ValueCallback<Array<Uri>>?, params: FileChooserParams?): Boolean { cb?.onReceiveValue(null); return true }
        }
        notice.visibility = View.GONE
        content.addView(web, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        web.loadDataWithBaseURL("$origin/", HostPage.build(html, csp, token), "text/html", "utf-8", null)
    }

    /** Hands the page its end of a new channel (the shim keeps the first and closes any later one). */
    private fun offerPort(p: Page) {
        if (page !== p || p.offered >= 2) return
        p.offered++
        runCatching {
            val (mine, theirs) = p.web.createWebMessageChannel()
            mine.setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                override fun onMessage(port: WebMessagePort, message: WebMessage) {
                    if (page !== p) return
                    p.port = mine
                    p.host.handle(message.data ?: return)
                }
            }, main)
            p.web.postWebMessage(WebMessage(p.token, arrayOf(theirs)), Uri.parse(p.origin))
        }.onFailure { Log.w(TAG, "could not connect the page", it) }
    }

    private fun drop() {
        val p = page ?: return
        page = null
        runCatching { p.port?.close() }
        content.removeView(p.web)
        runCatching { p.web.destroy() }
    }

    private fun hostContext(web: WebView): JSONObject {
        val density = resources.displayMetrics.density
        val o = JSONObject().put("theme", theme()).put("locale", "zh-CN").put("timeZone", TimeZone.getDefault().id)
        if (web.width > 0 && web.height > 0)
            o.put("containerDimensions", JSONObject().put("width", (web.width / density).toInt()).put("height", (web.height / density).toInt()))
        return o
    }

    private fun hostUi() = object : HostUi {
        override fun confirmLink(url: String, answer: (Boolean) -> Unit) {
            main.post { ask("「${info?.name ?: appId}」想打开链接", url, "打开", answer) }
        }
        override fun confirmMessage(text: String, answer: (Boolean) -> Unit) {
            main.post { ask("「${info?.name ?: appId}」想替你发给 Ash", text, "发送", answer) }
        }
        override fun openLink(url: String) {
            main.post {
                try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                catch (e: ActivityNotFoundException) { Toast.makeText(this@AppActivity, "没有能打开这个链接的应用", Toast.LENGTH_LONG).show() }
            }
        }
        override fun log(level: String, data: String) { Log.i(TAG, "$appId [$level] ${data.take(500)}") }
    }

    /** The owner decides; closing the dialog any way but the button is a no. */
    private fun ask(title: String, body: String, yes: String, answer: (Boolean) -> Unit) {
        if (isFinishing || isDestroyed) return answer(false)
        var answered = false
        fun reply(v: Boolean) { if (!answered) { answered = true; answer(v) } }
        AlertDialog.Builder(this).setTitle(title).setMessage(body.take(2000))
            .setPositiveButton(yes) { _, _ -> reply(true) }
            .setNegativeButton("取消") { _, _ -> reply(false) }
            .setOnDismissListener { reply(false) }
            .show()
    }

    companion object {
        private const val TAG = "ash.apps"
        private fun refused() = WebResourceResponse("text/plain", "utf-8", 403, "Blocked", mapOf("cache-control" to "no-store"), ByteArrayInputStream(ByteArray(0)))
        private fun randomToken(): String {
            val b = ByteArray(18).also { SecureRandom().nextBytes(it) }
            return android.util.Base64.encodeToString(b, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
        }
    }
}
