package ai.ash.host.browser

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * The agent's own browser: one WebView, hidden until the owner is asked to look at it. It keeps its own cookie
 * profile where the platform supports one, exposes no bridge to the page, and refuses anything off the public web.
 * Callers run on a bridge worker thread; every WebView call is hopped to the main thread.
 */
object BrowserSession {
    private const val LOAD_TIMEOUT_MS = 25_000L
    private const val SCRIPT_TIMEOUT_MS = 8_000L
    private const val SETTLE_MS = 700L
    private const val PROFILE = "agent-browser"
    private const val WIDTH = 1080
    private const val HEIGHT = 1920

    private val main = Handler(Looper.getMainLooper())
    private var view: WebView? = null
    @Volatile private var loadLatch: CountDownLatch? = null
    @Volatile private var loadError: String? = null

    class Failure(message: String) : RuntimeException(message)

    private fun <T> onMain(timeoutMs: Long = SCRIPT_TIMEOUT_MS, block: () -> T): T {
        if (Looper.myLooper() == Looper.getMainLooper()) return block()
        val result = AtomicReference<Any?>()
        val error = AtomicReference<Throwable?>()
        val done = CountDownLatch(1)
        main.post { try { result.set(block()) } catch (t: Throwable) { error.set(t) } finally { done.countDown() } }
        if (!done.await(timeoutMs, TimeUnit.MILLISECONDS)) throw Failure("the browser did not answer in time")
        error.get()?.let { throw it }
        @Suppress("UNCHECKED_CAST") return result.get() as T
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensure(ctx: Context): WebView {
        view?.let { return it }
        val webView = WebView(ctx.applicationContext)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
            try { WebViewCompat.setProfile(webView, PROFILE) } catch (_: Throwable) { /* shares the default profile */ }
        }
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = userAgentString.replace("; wv", "")
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        webView.setDownloadListener { _, _, _, _, _ -> /* downloads are not the agent's business */ }
        webView.webChromeClient = WebChromeClient()
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                // Redirects and links are checked like the first address: no loopback, no private networks, no app links.
                // No DNS lookup here (this is the main thread): literal addresses and local names are caught,
                // names that resolve to private addresses were already refused when the page was opened.
                return try { BrowserArguments.navigable(request.url.toString()); false } catch (_: Exception) { true }
            }
            override fun onPageFinished(v: WebView, url: String?) { flushCookies(); loadLatch?.countDown() }
            override fun onReceivedError(v: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) { loadError = error.description?.toString() ?: "the page could not be loaded"; loadLatch?.countDown() }
            }
        }
        layout(webView)
        view = webView
        return webView
    }

    /** Logins live in cookies; write them to disk now rather than whenever Android gets around to it. */
    private fun flushCookies() {
        try {
            val own = if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) ProfileStore.getInstance().getProfile(PROFILE) else null
            (own?.cookieManager ?: CookieManager.getInstance()).flush()
        } catch (_: Throwable) { /* best effort */ }
    }

    private fun layout(webView: WebView) {
        webView.measure(View.MeasureSpec.makeMeasureSpec(WIDTH, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(HEIGHT, View.MeasureSpec.EXACTLY))
        webView.layout(0, 0, WIDTH, HEIGHT)
    }

    /** Runs a script and returns its JSON-text result as an object. */
    private fun script(ctx: Context, source: String): JSONObject {
        val answer = AtomicReference<String?>()
        val done = CountDownLatch(1)
        onMain { ensure(ctx).evaluateJavascript(source) { value -> answer.set(value); done.countDown() } }
        if (!done.await(SCRIPT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) throw Failure("the page did not answer in time")
        val raw = answer.get() ?: throw Failure("the page returned nothing")
        val text = JSONTokener(raw).nextValue() as? String ?: throw Failure("the page returned nothing")
        return JSONObject(text)
    }

    fun open(ctx: Context, url: String): JSONObject {
        val checked = BrowserArguments.url(url)
        loadError = null
        val latch = CountDownLatch(1)
        loadLatch = latch
        onMain { ensure(ctx).loadUrl(checked) }
        if (!latch.await(LOAD_TIMEOUT_MS, TimeUnit.MILLISECONDS)) throw Failure("the page took too long to load")
        loadError?.let { throw Failure(it) }
        Thread.sleep(SETTLE_MS)
        return read(ctx)
    }

    fun read(ctx: Context): JSONObject {
        if (view == null) throw Failure("no page is open; use browser.open first")
        return script(ctx, BrowserScripts.READ)
    }

    private fun describe(ctx: Context, ref: Int, site: String, label: String): JSONObject {
        val found = script(ctx, BrowserScripts.describe(ref))
        if (!found.optBoolean("found")) throw Failure("element $ref is not on the page; use browser.read again")
        if (!BrowserArguments.sameSite(site, found.optString("host"))) throw Failure("the page is now on ${found.optString("host")}, not $site; use browser.read again")
        if (!BrowserArguments.labelMatches(label, found.optString("text"))) throw Failure("element $ref is \"${found.optString("text")}\", not \"$label\"; use browser.read again")
        if (found.optBoolean("disabled")) throw Failure("element $ref is disabled")
        return found
    }

    fun click(ctx: Context, ref: Int, site: String, label: String): JSONObject {
        describe(ctx, ref, site, label)
        loadError = null
        val latch = CountDownLatch(1)
        loadLatch = latch
        script(ctx, BrowserScripts.click(ref))
        latch.await(3_000, TimeUnit.MILLISECONDS) // a click that navigates gets a moment to finish; most do not
        Thread.sleep(SETTLE_MS)
        return read(ctx)
    }

    fun type(ctx: Context, ref: Int, site: String, label: String, text: String, submit: Boolean): JSONObject {
        val found = describe(ctx, ref, site, label)
        if (!BrowserArguments.typable(found.optString("tag"), found.optString("type").ifEmpty { null }) && !found.optBoolean("editable"))
            throw Failure("element $ref cannot take typed text (passwords and files are for the owner; use browser.show)")
        val latch = CountDownLatch(1)
        loadLatch = latch
        script(ctx, BrowserScripts.type(ref, text, submit))
        if (submit) latch.await(3_000, TimeUnit.MILLISECONDS)
        Thread.sleep(SETTLE_MS)
        return read(ctx)
    }

    fun scroll(ctx: Context, down: Boolean): JSONObject {
        if (view == null) throw Failure("no page is open; use browser.open first")
        script(ctx, BrowserScripts.scroll(if (down) 1 else -1))
        return read(ctx)
    }

    fun back(ctx: Context): JSONObject {
        val webView = view ?: throw Failure("no page is open; use browser.open first")
        val latch = CountDownLatch(1)
        loadLatch = latch
        if (!onMain { if (webView.canGoBack()) { webView.goBack(); true } else false }) throw Failure("there is no earlier page")
        latch.await(LOAD_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        Thread.sleep(SETTLE_MS)
        return read(ctx)
    }

    /** A JPEG of what the page looks like, scaled down. */
    fun screenshot(ctx: Context): String {
        val webView = view ?: throw Failure("no page is open; use browser.open first")
        return onMain {
            val full = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888)
            webView.draw(Canvas(full))
            val small = Bitmap.createScaledBitmap(full, WIDTH / 2, HEIGHT / 2, true)
            val out = ByteArrayOutputStream()
            small.compress(Bitmap.CompressFormat.JPEG, 70, out)
            full.recycle(); small.recycle()
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        }
    }

    fun current(): Pair<String, String>? = view?.let { v -> onMain { (v.url ?: "") to (v.title ?: "") } }

    /** Gives the page to a visible screen (the owner logs in or solves a check there). Returns the view to detach later. */
    fun attachTo(parent: ViewGroup, ctx: Context): Boolean {
        val webView = onMain { ensure(ctx) }
        onMain {
            (webView.parent as? ViewGroup)?.removeView(webView)
            parent.addView(webView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        return true
    }

    fun detach() {
        val webView = view ?: return
        flushCookies()
        onMain {
            (webView.parent as? ViewGroup)?.removeView(webView)
            layout(webView)
        }
    }

    fun close() {
        val webView = view ?: return
        flushCookies()
        onMain {
            (webView.parent as? ViewGroup)?.removeView(webView)
            webView.stopLoading(); webView.loadUrl("about:blank"); webView.clearHistory(); webView.destroy()
            view = null
        }
    }
}
