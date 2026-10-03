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
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * The agent's own browser: up to [MAX_SPACES] WebViews ("spaces", one per task), hidden until the owner looks at one.
 * Every space uses the same cookie profile (one login serves them all), exposes no bridge to the page and refuses
 * anything off the public web. Callers run on a bridge worker thread; every WebView call and every look at the set of
 * spaces is hopped to the main thread, so the set needs no lock.
 */
object BrowserSession {
    const val MAX_SPACES = 4
    private const val LOAD_TIMEOUT_MS = 25_000L
    private const val SCRIPT_TIMEOUT_MS = 8_000L
    private const val SETTLE_MS = 700L
    private const val WAIT_TEXT_MS = 10_000L
    private const val PROFILE = "agent-browser"
    private const val WIDTH = 1080
    private const val HEIGHT = 1920

    /** One open space. [serial] tells a space apart from a later one with the same id. */
    private class Space(val id: String, val view: WebView, val serial: Long) {
        @Volatile var loadLatch: CountDownLatch? = null
        @Volatile var loadError: String? = null
        @Volatile var lastUsed: Long = System.currentTimeMillis()
        @Volatile var closed = false
    }

    /** What the owner and the agent see of a space. */
    data class Info(val id: String, val url: String, val title: String, val lastUsed: Long) {
        val site: String get() = BrowserArguments.host(url)?.removePrefix("www.") ?: url
    }

    private val main = Handler(Looper.getMainLooper())
    private val spaces = LinkedHashMap<String, Space>() // main thread only
    private var serials = 0L
    @Volatile private var appContext: Context? = null
    private val listeners = CopyOnWriteArrayList<() -> Unit>()

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

    /** Called on the main thread whenever a space opens, closes or finishes loading a page (the owner's view and notification follow it). */
    fun addListener(listener: () -> Unit) { listeners.add(listener) }
    fun removeListener(listener: () -> Unit) { listeners.remove(listener) }

    private fun changed() {
        main.post {
            appContext?.let { ctx -> try { ai.ash.host.Notifications.browsing(ctx, latestOnMain(), spaces.size) } catch (_: Throwable) { /* best effort */ } }
            for (listener in listeners) try { listener() } catch (_: Throwable) { /* a closed screen */ }
        }
    }

    private fun infoOf(space: Space) = Info(space.id, space.view.url ?: "", space.view.title ?: "", space.lastUsed)
    private fun latestOnMain(): Info? = spaces.values.maxByOrNull { it.lastUsed }?.let { infoOf(it) }

    /** The open space with this id, or a failure that tells the agent to open one. */
    private fun existing(id: String): Space =
        onMain { spaces[id] }?.also { it.lastUsed = System.currentTimeMillis() } ?: throw Failure("no page is open in space $id; use browser.open first")

    /** Opens space [id] if needed; the least recently used one is closed to make room for a fifth. */
    @SuppressLint("SetJavaScriptEnabled")
    private fun ensure(ctx: Context, id: String): Space = onMain {
        spaces[id]?.let { it.lastUsed = System.currentTimeMillis(); return@onMain it }
        while (spaces.size >= MAX_SPACES) spaces.values.minByOrNull { it.lastUsed }?.let { destroy(it) } ?: break
        appContext = ctx.applicationContext
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
        val space = Space(id, webView, ++serials)
        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                // Redirects and links are checked like the first address: no loopback, no private networks, no app links.
                // No DNS lookup here (this is the main thread): literal addresses and local names are caught,
                // names that resolve to private addresses were already refused when the page was opened.
                return try { BrowserArguments.navigable(request.url.toString()); false } catch (_: Exception) { true }
            }
            override fun onPageFinished(v: WebView, url: String?) {
                flushCookies(); space.loadLatch?.countDown()
                if (!space.closed) changed()
            }
            override fun onReceivedError(v: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) { space.loadError = error.description?.toString() ?: "the page could not be loaded"; space.loadLatch?.countDown() }
            }
        }
        layout(webView)
        spaces[id] = space
        changed()
        space
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

    /** Runs a script in a space and returns its JSON-text result as an object. */
    private fun script(space: Space, source: String): JSONObject {
        val answer = AtomicReference<String?>()
        val done = CountDownLatch(1)
        onMain {
            if (space.closed) throw Failure("space ${space.id} was closed")
            space.view.evaluateJavascript(source) { value -> answer.set(value); done.countDown() }
        }
        if (!done.await(SCRIPT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) throw Failure("the page did not answer in time")
        val raw = answer.get() ?: throw Failure("the page returned nothing")
        val text = JSONTokener(raw).nextValue() as? String ?: throw Failure("the page returned nothing")
        return JSONObject(text)
    }

    /** The page in [space] as data (text and numbered controls), marked with the space it is in. */
    private fun page(space: Space): JSONObject = script(space, BrowserScripts.READ).put("space", space.id)

    /**
     * Does one action in space [id] and returns the page afterwards. Every rule lives on this path, so browser.run and
     * the single capabilities enforce the same ones. Capture is not a page action; use [screenshot].
     */
    fun perform(ctx: Context, id: String, step: BrowserStep): JSONObject = when (step) {
        is BrowserStep.Open -> open(ctx, id, step.url)
        BrowserStep.Read -> page(existing(id))
        is BrowserStep.Click -> click(existing(id), step)
        is BrowserStep.Type -> type(existing(id), step)
        is BrowserStep.Scroll -> existing(id).let { script(it, BrowserScripts.scroll(if (step.down) 1 else -1)); page(it) }
        BrowserStep.Back -> back(existing(id))
        is BrowserStep.WaitMs -> existing(id).let { Thread.sleep(step.ms); page(it) }
        is BrowserStep.WaitText -> waitFor(existing(id), step.text)
        BrowserStep.Capture -> throw IllegalArgumentException("capture returns a picture; use screenshot")
    }

    private fun open(ctx: Context, id: String, url: String): JSONObject {
        val checked = BrowserArguments.url(url)
        val space = ensure(ctx, id)
        space.loadError = null
        val latch = CountDownLatch(1)
        space.loadLatch = latch
        onMain { space.view.loadUrl(checked) }
        if (!latch.await(LOAD_TIMEOUT_MS, TimeUnit.MILLISECONDS)) throw Failure("the page took too long to load")
        if (space.closed) throw Failure("space $id was closed")
        space.loadError?.let { throw Failure(it) }
        Thread.sleep(SETTLE_MS)
        return page(space)
    }

    private fun describe(space: Space, ref: Int, site: String, label: String): JSONObject {
        val found = script(space, BrowserScripts.describe(ref))
        if (!found.optBoolean("found")) throw Failure("element $ref is not on the page; use browser.read again")
        if (!BrowserArguments.sameSite(site, found.optString("host"))) throw Failure("the page is now on ${found.optString("host")}, not $site; use browser.read again")
        if (!BrowserArguments.labelMatches(label, found.optString("text"))) throw Failure("element $ref is \"${found.optString("text")}\", not \"$label\"; use browser.read again")
        if (found.optBoolean("disabled")) throw Failure("element $ref is disabled")
        return found
    }

    private fun click(space: Space, step: BrowserStep.Click): JSONObject {
        describe(space, step.ref, step.site, step.label)
        space.loadError = null
        val latch = CountDownLatch(1)
        space.loadLatch = latch
        script(space, BrowserScripts.click(step.ref))
        latch.await(3_000, TimeUnit.MILLISECONDS) // a click that navigates gets a moment to finish; most do not
        Thread.sleep(SETTLE_MS)
        return page(space)
    }

    private fun type(space: Space, step: BrowserStep.Type): JSONObject {
        val found = describe(space, step.ref, step.site, step.label)
        if (!BrowserArguments.typable(found.optString("tag"), found.optString("type").ifEmpty { null }) && !found.optBoolean("editable"))
            throw Failure("element ${step.ref} cannot take typed text (passwords and files are for the owner; use browser.show)")
        val latch = CountDownLatch(1)
        space.loadLatch = latch
        script(space, BrowserScripts.type(step.ref, step.text, step.submit))
        if (step.submit) latch.await(3_000, TimeUnit.MILLISECONDS)
        Thread.sleep(SETTLE_MS)
        return page(space)
    }

    private fun back(space: Space): JSONObject {
        val latch = CountDownLatch(1)
        space.loadLatch = latch
        if (!onMain { if (!space.closed && space.view.canGoBack()) { space.view.goBack(); true } else false }) throw Failure("there is no earlier page")
        latch.await(LOAD_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        Thread.sleep(SETTLE_MS)
        return page(space)
    }

    private fun waitFor(space: Space, text: String): JSONObject {
        val until = System.currentTimeMillis() + WAIT_TEXT_MS
        while (true) {
            if (script(space, BrowserScripts.contains(text)).optBoolean("found")) return page(space)
            if (System.currentTimeMillis() >= until) throw Failure("\"$text\" did not appear on the page within ${WAIT_TEXT_MS / 1000} s")
            Thread.sleep(400)
        }
    }

    /** A JPEG of what the page in space [id] looks like, scaled down. */
    fun screenshot(id: String): String {
        val space = existing(id)
        return onMain {
            if (space.closed) throw Failure("space $id was closed")
            val full = Bitmap.createBitmap(WIDTH, HEIGHT, Bitmap.Config.ARGB_8888)
            space.view.draw(Canvas(full))
            val small = Bitmap.createScaledBitmap(full, WIDTH / 2, HEIGHT / 2, true)
            val out = ByteArrayOutputStream()
            small.compress(Bitmap.CompressFormat.JPEG, 70, out)
            full.recycle(); small.recycle()
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        }
    }

    /** The open space with this id, or null. */
    fun info(id: String): Info? = onMain { spaces[id]?.let { infoOf(it) } }

    /** Every open space, most recently used first. */
    fun list(): List<Info> = onMain { spaces.values.sortedByDescending { it.lastUsed }.map { infoOf(it) } }

    /** Tells one opening of a space from the next: null when it is not open. browser.run stops if this changes under it. */
    fun serial(id: String): Long? = onMain { spaces[id]?.serial }

    /** Gives space [id] to a visible screen (the owner watches, logs in or takes over there). False when it is not open. */
    fun attachTo(parent: ViewGroup, id: String): Boolean = onMain {
        val space = spaces[id] ?: return@onMain false
        (space.view.parent as? ViewGroup)?.removeView(space.view)
        parent.addView(space.view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        true
    }

    /** Takes space [id] back from a screen; it stays open with its cookies. */
    fun detach(id: String) {
        flushCookies()
        onMain {
            val space = spaces[id] ?: return@onMain
            (space.view.parent as? ViewGroup)?.removeView(space.view)
            layout(space.view)
        }
    }

    /** Forgets every login and everything else the agent's browser stored. Returns whether it is now empty. */
    fun clearLogins(ctx: Context): Boolean {
        close(BrowserArguments.ALL_SPACES)
        val done = CountDownLatch(1)
        val removed = AtomicReference(false)
        try {
            onMain {
                val own = if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) ProfileStore.getInstance().getProfile(PROFILE) else null
                val cookies = own?.cookieManager ?: CookieManager.getInstance()
                (own?.webStorage ?: android.webkit.WebStorage.getInstance()).deleteAllData()
                cookies.removeAllCookies { value -> removed.set(true); done.countDown(); cookies.flush(); if (value == false) removed.set(true) }
            }
        } catch (_: Throwable) { return false }
        // Without a separate profile the jar is shared with Ash's own page, which only holds its own origin's cookie.
        return done.await(5, TimeUnit.SECONDS) && removed.get()
    }

    private fun destroy(space: Space) {
        space.closed = true
        spaces.remove(space.id)
        space.loadLatch?.countDown() // a load someone is waiting for will not finish now
        (space.view.parent as? ViewGroup)?.removeView(space.view)
        space.view.stopLoading(); space.view.loadUrl("about:blank"); space.view.clearHistory(); space.view.destroy()
        changed()
    }

    /** Closes space [id] (or every space for "*"). Returns the ids that were open. */
    fun close(id: String): List<String> {
        flushCookies()
        return onMain {
            val targets = if (id == BrowserArguments.ALL_SPACES) spaces.values.toList() else listOfNotNull(spaces[id])
            targets.forEach { destroy(it) }
            targets.map { it.id }
        }
    }
}
