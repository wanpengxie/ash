package ai.ash.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.MimeTypeMap
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import ai.ash.R
import ai.ash.BuildConfig
import ai.ash.host.CoreEndpoint
import ai.ash.host.CoreProcess
import ai.ash.host.CoreService
import ai.ash.host.Paths
import ai.ash.host.Permissions
import ai.ash.host.Secrets
import ai.ash.ui.transport.CoreCancellation
import ai.ash.ui.transport.CoreUiRequest
import ai.ash.ui.transport.FixedCoreClient
import ai.ash.ui.transport.ownerBearerFromPrivateUiUrl
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.URI
import java.util.concurrent.ConcurrentHashMap

/**
 * Opening the app opens Ash: the packaged UI in a WebView; native code talks to core. While
 * the core is installing or starting, a native status screen shows what is happening.
 */
class HomeActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var cover: LinearLayout
    private lateinit var status: TextView
    private lateinit var action: Button
    private val ui = Handler(Looper.getMainLooper())
    private var loaded = false
    private var pageEpoch = 0L
    private var coreUi: FixedCoreClient? = null
    private val requests = ConcurrentHashMap<String, CoreCancellation>()
    /** The web page's pending <input type=file> request; answered exactly once (null = cancelled). */
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    private val night get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        // A WebView's prefers-color-scheme follows the theme's isLightTheme only, not the system
        // night mode — so the theme is chosen here to make the ash UI follow the system.
        setTheme(if (night) R.style.Ash_Dark else R.style.Ash_Light)
        super.onCreate(savedInstanceState)
        CoreService.start(this)

        // Browser cookies are not port-scoped. This WebView never receives the core owner token.
        CookieManager.getInstance().setAcceptCookie(false)
        if (BuildConfig.ISOLATED_PROBE) WebView.setWebContentsDebuggingEnabled(true)
        web = WebView(this)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setSupportZoom(false)
            userAgentString = "$userAgentString AshApp/0.2"
        }
        web.setBackgroundColor(if (night) 0xFF141415.toInt() else 0xFFF7F7F5.toInt())
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.scheme == "ash" && u.host == "console") {
                    startActivity(Intent(this@HomeActivity, ConsoleActivity::class.java))
                    return true
                }
                if (u.scheme == "ash" && u.host == "permission") {
                    Permissions.all.find { it.key == u.pathSegments.singleOrNull() }?.open(this@HomeActivity)
                    return true
                }
                if (u.toString() == UI_ASSET_URL) return false
                if ((u.scheme == "http" || u.scheme == "https") && u.host != "127.0.0.1" && u.host != "localhost")
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }

            override fun shouldInterceptRequest(view: WebView, req: WebResourceRequest): WebResourceResponse? {
                val u = req.url
                if (u.scheme == "https" && u.host == "appassets.androidplatform.net" && u.port == -1 &&
                    u.encodedPath?.startsWith("/assets/ash-ui/") == true && u.encodedPath?.contains("..") != true &&
                    u.query == null && u.fragment == null) {
                    assetLoader.shouldInterceptRequest(u)?.let { return it }
                }
                return forbidden()
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                ai.ash.host.AppState.homePageLive = false
                super.onPageStarted(view, url, favicon)
                requests.values.forEach { it.cancel() }
                requests.clear()
                coreUi?.invalidate()
                pageEpoch = if (url == UI_ASSET_URL) coreUi?.beginPage(true) ?: 0L else 0L
                if (pageEpoch == 0L) { loaded = false; cover.visibility = View.VISIBLE; view.stopLoading() }
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                ai.ash.host.AppState.homePageLive = url == UI_ASSET_URL && pageEpoch != 0L
            }

            override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                if (req.isForMainFrame) {
                    loaded = false
                    cover.visibility = View.VISIBLE
                }
            }
        }

        val bridgeSupported = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
        if (bridgeSupported) {
            WebViewCompat.addWebMessageListener(web, "AshNative", setOf(UI_ASSET_ORIGIN)) { _, message, origin, mainFrame, reply ->
                if (!mainFrame || origin.toString() != UI_ASSET_ORIGIN || pageEpoch == 0L) return@addWebMessageListener
                val input = runCatching { JSONObject(message.data ?: "") }.getOrNull() ?: return@addWebMessageListener
                when (input.optString("type")) {
                    "hello" -> reply.postMessage(JSONObject().put("type", "ready")
                        .put("endpoint", "http://127.0.0.1:${BuildConfig.CORE_PORT}").toString())
                    "cancel" -> requests.remove(input.optString("id"))?.cancel()
                    "request" -> handleNativeRequest(input, reply)
                    "gateway_config" -> handleGatewaySetting(input, reply)
                    "browser_logins" -> handleBrowserLogins(input, reply)
                }
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, cb: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean =
                chooseFiles(cb, params)
        }

        val fg = if (night) Color.rgb(236, 236, 238) else Color.rgb(28, 28, 30)
        status = TextView(this).apply { textSize = 15f; setTextColor(fg); gravity = Gravity.CENTER; setPadding(48, 24, 48, 24) }
        action = Button(this).apply { text = "诊断"; setOnClickListener { startActivity(Intent(this@HomeActivity, ConsoleActivity::class.java)) } }
        cover = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(if (night) 0xFF141415.toInt() else 0xFFF7F7F5.toInt())
            addView(TextView(context).apply { text = "Ash"; textSize = 28f; setTextColor(fg); gravity = Gravity.CENTER })
            addView(ProgressBar(context).apply { isIndeterminate = true })
            addView(status)
            addView(action, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        setContentView(FrameLayout(this).apply {
            addView(web, FrameLayout.LayoutParams(-1, -1))
            addView(cover, FrameLayout.LayoutParams(-1, -1))
        })
        if (!bridgeSupported) { status.text = "当前 WebView 不支持 Ash 安全通信"; return }
        poll()
        OnboardingActivity.showOnce(this)
    }

    private fun poll() {
        if (isFinishing || isDestroyed) return
        val p = Paths(this)
        val st = CoreService.state
        status.text = when {
            st == "installing" -> "正在安装运行环境… ${CoreService.installProgress.takeIf { it >= 0 }?.let { "$it%" } ?: ""}\n（首次安装或升级后需要一两分钟）"
            st == "preparing" -> "正在准备 Ash 的工作环境… ${CoreService.installProgress.takeIf { it >= 0 }?.let { "$it%" } ?: ""}\n（首次安装或升级后需要一两分钟）"
            st == "stopped" -> "Ash 已停止"
            st.startsWith("error") -> "出错了：${st.removePrefix("error: ")}"
            else -> "正在启动…"
        }
        action.visibility = if (st == "stopped" || st.startsWith("error")) View.VISIBLE else View.GONE
        if (!loaded && p.uiUrl.exists() && (!BuildConfig.ISOLATED_PROBE || st == "running")) {
            Thread {
                val ok = CoreProcess(this).portOpen(1000)
                if (ok) ui.post { load(p.uiUrl.readText().trim()) }
            }.start()
        }
        ui.postDelayed({ poll() }, 1000)
    }

    override fun onResume() {
        super.onResume()
        ai.ash.host.AppState.homeVisible = true
        CoreService.start(this, CoreService.ACTION_APP_OPEN)
    }

    override fun onPause() {
        ai.ash.host.AppState.homeVisible = false
        CoreService.start(this, CoreService.ACTION_APP_LEFT)
        super.onPause()
    }

    private fun load(url: String) {
        if (loaded) return
        if (!CoreEndpoint.acceptsUiUrl(url, BuildConfig.CORE_PORT)) {
            status.text = "核心地址不匹配"
            cover.visibility = View.VISIBLE
            return
        }
        val token = try { ownerBearerFromPrivateUiUrl(url, BuildConfig.CORE_PORT) }
            catch (_: Exception) { status.text = "核心凭据不可用"; return }
        val nativeProof = java.security.MessageDigest.getInstance("SHA-256")
            .digest("${Secrets(this).hostToken}:home".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        coreUi = FixedCoreClient(BuildConfig.CORE_PORT, bearer = { token }, nativeUiToken = nativeProof)
        loaded = true
        web.loadUrl(UI_ASSET_URL)
        ui.postDelayed({ cover.visibility = View.GONE }, 400)
    }

    private fun handleNativeRequest(input: JSONObject, reply: androidx.webkit.JavaScriptReplyProxy) {
        val client = coreUi ?: return
        val epoch = pageEpoch
        val id = input.optString("id")
        if (!Regex("[1-9][0-9]{0,11}").matches(id) || requests.containsKey(id)) return
        val path = input.optString("path")
        val method = input.optString("method")
        // Which requests are allowed is the core's decision; the page can only reach the core's own address.
        if (path.length > 1024 || method !in setOf("GET", "POST", "PUT", "DELETE")) return
        val headersJson = input.optJSONObject("headers") ?: JSONObject()
        val headers = headersJson.keys().asSequence().associateWith { headersJson.optString(it) }
        val rawBody = input.opt("body")
        if (rawBody != JSONObject.NULL && rawBody != null && rawBody !is String) return
        if (rawBody is String && rawBody.length > 28 * 1024 * 1024) return
        val request = CoreUiRequest(method, path, headers, (rawBody as? String)?.toByteArray(Charsets.UTF_8))
        val cancellation = CoreCancellation()
        requests[id] = cancellation
        val live = path.startsWith("/api/stream?") && path.contains("follow=true")
        fun respond(message: JSONObject) {
            ui.post { if (pageEpoch == epoch && !cancellation.cancelled) runCatching { reply.postMessage(message.put("id", id).toString()) } }
        }
        if (live) respond(JSONObject().put("type", "started"))
        Thread {
            try {
                val result = client.execute(epoch, request, cancellation) { chunk ->
                    respond(JSONObject().put("type", "chunk").put("body", Base64.encodeToString(chunk, Base64.NO_WRAP)))
                }
                respond(JSONObject().put("type", "done").put("status", result.status)
                    .put("content_type", result.contentType)
                    .put("body", Base64.encodeToString(result.body, Base64.NO_WRAP)))
            } catch (_: Exception) { respond(JSONObject().put("type", "error")) }
            finally { requests.remove(id, cancellation) }
        }.start()
    }

    private fun handleBrowserLogins(input: JSONObject, reply: androidx.webkit.JavaScriptReplyProxy) {
        val id = input.optString("id")
        if (!Regex("[1-9][0-9]{0,11}").matches(id) || input.optString("operation") != "clear") return
        val epoch = pageEpoch
        Thread {
            val ok = ai.ash.host.browser.BrowserSession.clearLogins(applicationContext)
            runOnUiThread { if (pageEpoch == epoch) reply.postMessage(JSONObject().put("type", "browser_logins_result").put("id", id).put("ok", ok).toString()) }
        }.start()
    }

    private fun handleGatewaySetting(input: JSONObject, reply: androidx.webkit.JavaScriptReplyProxy) {
        val id = input.optString("id")
        if (!Regex("[1-9][0-9]{0,11}").matches(id)) return
        val epoch = pageEpoch
        val paths = Paths(this)
        val result = when (input.optString("operation")) {
            "status" -> JSONObject().put("ok", true)
            "save" -> {
                val rawUrl = input.opt("url") as? String
                val rawSecret = input.opt("secret") as? String
                val url = rawUrl?.trim()
                val secret = rawSecret?.trim()
                val normalized = if (url.isNullOrEmpty()) "" else runCatching {
                    val parsed = URI(url)
                    require(parsed.scheme == "https" && !parsed.host.isNullOrBlank() && parsed.userInfo == null &&
                        parsed.query == null && parsed.fragment == null && (parsed.path.isNullOrEmpty() || parsed.path == "/") &&
                        (parsed.port == -1 || parsed.port in 1..65535))
                    URI("https", null, parsed.host, parsed.port, null, null, null).toString()
                }.getOrNull()
                val saved = if (url == null || secret == null || secret.length > 1024 || normalized == null) false else runCatching {
                    paths.state.mkdirs()
                    if (normalized.isEmpty()) {
                        if (paths.gateway.exists()) check(paths.gateway.delete())
                        if (paths.gatewayBootstrap.exists()) check(paths.gatewayBootstrap.delete())
                    } else {
                        if (secret.isNotEmpty()) paths.gatewayBootstrap.writeText(secret)
                        else if (paths.gatewayBootstrap.exists()) check(paths.gatewayBootstrap.delete())
                        paths.gateway.writeText(JSONObject().put("url", normalized).toString())
                    }
                    CoreService.start(this, CoreService.ACTION_RESTART)
                    true
                }.getOrDefault(false)
                JSONObject().put("ok", saved)
            }
            else -> return
        }
        val configuredUrl = runCatching { JSONObject(paths.gateway.readText()).optString("url") }.getOrDefault("")
        result.put("type", "gateway_config_result").put("id", id)
            .put("configured", configuredUrl.isNotEmpty()).put("url", configuredUrl)
        if (pageEpoch == epoch) reply.postMessage(result.toString())
    }

    private fun forbidden() = WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    /** Opens the system picker for the web UI's attachment button (images or any file, several at once). */
    private fun chooseFiles(cb: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
        answerFiles(null) // a request still open (should not happen) is cancelled, not dropped
        fileCallback = cb
        val pick = try { params.createIntent() } catch (e: Throwable) { null }
            ?: Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
        // createIntent() only uses the first accept type; "image/*,.pdf" must offer both.
        val mimes = params.acceptTypes.orEmpty().flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
            .map { if (it.startsWith('.')) MimeTypeMap.getSingleton().getMimeTypeFromExtension(it.substring(1)) ?: "*/*" else it }.distinct()
        if (mimes.size > 1 && "*/*" !in mimes) {
            pick.type = "*/*"
            pick.putExtra(Intent.EXTRA_MIME_TYPES, mimes.toTypedArray())
        } else if (pick.type.isNullOrEmpty() || "*/*" in mimes || pick.type?.startsWith(".") == true) pick.type = "*/*"
        if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        try {
            startActivityForResult(Intent.createChooser(pick, "选择文件"), REQ_FILES)
        } catch (e: ActivityNotFoundException) {
            answerFiles(null)
        }
        return true
    }

    private fun answerFiles(uris: Array<Uri>?) {
        val cb = fileCallback ?: return
        fileCallback = null
        try { cb.onReceiveValue(uris) } catch (_: Throwable) {}
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != REQ_FILES) return super.onActivityResult(requestCode, resultCode, data)
        val uris = LinkedHashSet<Uri>()
        if (resultCode == RESULT_OK && data != null) {
            // Several files come as ClipData; a single one may come as data (or both, on some pickers).
            data.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let { uris.add(it) } }
            data.data?.let { uris.add(it) }
        }
        answerFiles(if (uris.isEmpty()) null else uris.toTypedArray())
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if ((newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) != (if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)) recreate()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else moveTaskToBack(true) // Ash keeps running
    }

    override fun onDestroy() {
        ai.ash.host.AppState.homePageLive = false
        ui.removeCallbacksAndMessages(null)
        requests.values.forEach { it.cancel() }
        requests.clear()
        coreUi?.invalidate()
        answerFiles(null)
        web.destroy()
        super.onDestroy()
    }

    @Suppress("unused")
    private fun open(u: String) = startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u)))

    companion object {
        private const val UI_ASSET_ORIGIN = "https://appassets.androidplatform.net"
        private const val UI_ASSET_URL = "$UI_ASSET_ORIGIN/assets/ash-ui/index.html"
        private const val REQ_FILES = 7101
    }
}
