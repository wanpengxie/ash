package ai.ash.apps

import ai.ash.BuildConfig
import ai.ash.R
import ai.ash.ui.design.AshPage
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi

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
    private lateinit var ash: Ash
    private var info: AppInfo? = null
    private var icon: Bitmap? = null
    private lateinit var root: LinearLayout
    private lateinit var titleBox: LinearLayout
    private lateinit var tabHost: FrameLayout
    private lateinit var content: FrameLayout
    private lateinit var notice: FrameLayout
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
        ash = Ash(this, id)
        surface = intent?.getStringExtra(Ui.EXTRA_SURFACE)?.takeIf { AppIds.validSurface(it) }
        build()
        Ui.taskCard(this, appId, null)
        load()
    }

    override fun onNewIntent(next: Intent) {
        super.onNewIntent(next)
        // The same app's task, brought back: keep the page as it is unless a page was asked for (another app always
        // gets a task of its own).
        if (AppIds.fromLink(next.dataString) != appId) { startActivity(next.setClass(this, OpenActivity::class.java).setFlags(0).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); return }
        val asked = next.getStringExtra(Ui.EXTRA_SURFACE)?.takeIf { AppIds.validSurface(it) } ?: return
        val a = info
        if (a == null) { surface = asked; return }
        if (asked != surface && a.surfaces.any { it.first == asked }) { surface = asked; renderTabs(); open(asked) }
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
        if (::ash.isInitialized) ash.close()
        super.onDestroy()
    }

    private fun d(v: Int) = Ui.dp(this, v)
    private fun theme() = if (Ui.night(this)) "dark" else "light"

    private fun build() {
        root = AshPage.screen(this)
        root.addView(buildBar(), 0)
        tabHost = FrameLayout(this).apply { visibility = View.GONE }
        root.addView(tabHost)
        content = FrameLayout(this)
        notice = FrameLayout(this)
        content.addView(notice, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        Ui.insets(root)
        paint()
        setContentView(root)
    }

    /** The frame's bar: back, who this is, 「更多」. Made again by [paint] (its icons take their colour when they are made). */
    private fun buildBar(): View {
        titleBox = AshUi.hstack(this, 8).apply { gravity = Gravity.CENTER }
        val more = AshUi.iconButton(this, AshPage.icon(this, R.drawable.ash_ic_more), "更多") { menu(titleBox) }
        return AshPage.navbar(this, null, "返回", trailing = more, center = titleBox) { moveTaskToBack(true) }
    }

    /** Everything the frame draws itself, in the colours of the system's light or dark now (also called when the system switches in place). */
    private fun paint() {
        Ui.systemBars(this)
        val bg = AshUi.p(this).bg
        window.statusBarColor = bg; window.navigationBarColor = bg; window.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(bg))
        root.setBackgroundColor(bg)
        content.setBackgroundColor(bg)
        if (root.childCount > 0 && root.getChildAt(0) !== tabHost) { root.removeViewAt(0); root.addView(buildBar(), 0) }
        paintTitle()
        renderTabs()
        if (notice.visibility == View.VISIBLE) drawNotice()
    }

    /** Who this is, always on show (so a page cannot pass itself off as Ash): the app's icon and its name. */
    private fun paintTitle() {
        titleBox.removeAllViews()
        titleBox.addView(AshPage.appIcon(this, icon, AshPage.AppTile.FRAME, shadow = false), LinearLayout.LayoutParams(d(AshPage.AppTile.FRAME.sizeDp), d(AshPage.AppTile.FRAME.sizeDp)))
        titleBox.addView(AshUi.text(this, info?.name ?: "", AshTokens.Type.headline, maxLines = 1))
    }

    private fun menu(anchor: View) {
        val m = PopupMenu(this, anchor)
        m.menu.add(0, 1, 0, "添加到桌面")
        m.menu.add(0, 2, 1, "重新加载")
        m.menu.add(0, 3, 2, "全部应用")
        m.setOnMenuItemClickListener {
            when (it.itemId) {
                1 -> Pin.request(this, appId, info?.name ?: appId, icon)
                2 -> load()
                3 -> Ash.openApps(this)
            }
            true
        }
        m.show()
    }

    /** Nothing to show: the empty state's own structure (what happened, why in plain words, what you can do), or a spinner while it opens. */
    private fun say(title: String?, body: String = "", button: String? = null, act: (() -> Unit)? = null) {
        drop()
        noticeNow = Notice(title, body, button, act)
        notice.visibility = View.VISIBLE
        drawNotice()
    }

    private class Notice(val title: String?, val body: String, val button: String?, val act: (() -> Unit)?)
    private var noticeNow: Notice? = null

    private fun drawNotice() {
        val n = noticeNow ?: return
        notice.removeAllViews()
        if (n.title == null) {
            notice.addView(AshUi.Spinner(this), FrameLayout.LayoutParams(d(AshTokens.Size.icon), d(AshTokens.Size.icon), Gravity.CENTER))
            return
        }
        val action = n.button?.let { AshUi.button(this, it, AshUi.Kind.PRIMARY) { n.act?.invoke() } }
        notice.addView(AshPage.empty(this, n.title, n.body, action), FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))
    }

    /** What Ash says about this app now; then its page. */
    private fun load() {
        say(null)
        Thread({
            val result = runCatching { ash.apps().firstOrNull { it.id == appId } }
            val bitmap = if (icon == null && result.getOrNull() != null) ash.icon(appId) else icon
            main.post {
                if (isDestroyed) return@post
                val error = result.exceptionOrNull()
                if (error != null) return@post say("连不上 Ash", error.message ?: "打开 Ash 后再试。", "打开 Ash") { Ash.open(this) }
                val a = result.getOrNull() ?: return@post say("Ash 里已经没有这个应用", "它可能被收回或删掉了。", "全部应用") { Ash.openApps(this) }
                info = a
                icon = bitmap
                paintTitle()
                Ui.taskCard(this, a.name, bitmap)
                if (!a.usable) return@post say(
                    if (!a.enabled) "「${a.name}」现在停着" else "「${a.name}」还没批准",
                    if (!a.enabled) "在 Ash 主页的「她的手和眼 · 应用」里重新打开就能用。" else "到应用页看看它要用什么，批准之后就能用。",
                    if (!a.enabled) "打开 Ash" else "全部应用") { if (!a.enabled) Ash.open(this) else Ash.openApps(this) }
                if (a.surfaces.isEmpty()) return@post say("这个应用没有页面", "「${a.name}」没有可以打开的页面。")
                if (surface == null || a.surfaces.none { it.first == surface }) surface = a.surfaces.first().first
                renderTabs()
                open(surface!!)
            }
        }, "app-load").start()
    }

    /** The app's pages as a segmented bar under the frame (only when it has more than one). */
    private fun renderTabs() {
        if (!::tabHost.isInitialized) return
        val a = info
        tabHost.removeAllViews()
        val surfaces = a?.surfaces.orEmpty()
        tabHost.visibility = if (a != null && a.usable && surfaces.size > 1) View.VISIBLE else View.GONE
        if (tabHost.visibility != View.VISIBLE) return
        tabHost.setPadding(d(AshTokens.Space.md), d(AshTokens.Space.xxs), d(AshTokens.Space.md), d(AshTokens.Space.sm))
        val seg = AshUi.segmented(this, surfaces.map { it.second }, surfaces.indexOfFirst { it.first == surface }) { i ->
            val id = surfaces[i].first
            if (id != surface) { surface = id; renderTabs(); open(id) }
        }
        tabHost.addView(seg)
        // The tabs are drawn 32dp high; they are tapped from 44dp.
        AshPage.widenTouch(tabHost, (0 until seg.childCount).map { seg.getChildAt(it) })
    }

    private fun open(surfaceId: String) {
        say(null)
        Thread({
            val result = runCatching { ash.surface(appId, surfaceId) }
            main.post {
                if (isDestroyed || surface != surfaceId) return@post
                result.onSuccess { show(it.html, it.csp) }
                    .onFailure { say("这一页没打开", it.message ?: "再试一次通常就好了。", "重新加载") { load() } }
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
        val host = McpHost(appId, info?.name ?: appId, BuildConfig.VERSION_NAME, csp, ash.backend(), hostUi(),
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
        web.setBackgroundColor(AshUi.p(this).bg)
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
                if (page === p) say("这一页出错停了", "重新加载一下通常就好了。", "重新加载") { load() } else runCatching { view.destroy() }
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
        override fun openLink(url: String) {
            main.post {
                try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                catch (e: ActivityNotFoundException) { Toast.makeText(this@AppActivity, "没有能打开这个链接的应用", Toast.LENGTH_LONG).show() }
            }
        }
        override fun openCheckup(part: String?) {
            main.post { startActivity(Intent(this@AppActivity, ai.ash.ui.ConsoleActivity::class.java).also { i -> part?.let { i.putExtra(ai.ash.ui.ConsoleActivity.EXTRA_PART, it) } }) }
        }
        override fun openHome(section: String, arg: String?) {
            if (section == "device") {
                main.post { startActivity(ai.ash.sysapps.SystemApps.intent(this@AppActivity, "devices", arg)) }
                return
            }
            main.post { startActivity(Intent(this@AppActivity, ai.ash.ui.HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra(ai.ash.ui.HomeActivity.EXTRA_HOME_PAGE, section).also { i -> arg?.let { i.putExtra(ai.ash.ui.HomeActivity.EXTRA_HOME_ARG, it) } }) }
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
