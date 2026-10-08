package ai.ash.widget

import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.View
import android.widget.AdapterView
import ai.ash.R
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * The numbers behind a card's preview picture (no Android types, so they are unit tested on the JVM): how big the widget
 * is on this phone, how far the picture is scaled down, and what the report to the core looks like.
 */
object PreviewPlan {
    /** The longer side of the picture sent to the agent, in pixels. */
    const val MAX_SIDE = 900
    /** The PNG must stay under this; the picture is drawn smaller until it does. */
    const val MAX_BYTES = 200 * 1024
    /** Scales tried in turn when the PNG is too large. */
    val SHRINK = floatArrayOf(1f, 0.8f, 0.64f, 0.5f)
    /** Everything (drawing the card, loading its lists, drawing the picture) must be done in this long, or the report says so. */
    const val TIMEOUT_MS = 6000L
    /** How long a card's scrolling lists get to load their rows before the picture is declared unready. */
    const val LISTS_MS = 2500L

    /**
     * Roughly the widget a launcher gives a card of [size] on a phone [screenWidthDp] wide, in dp (portrait): a 4-column grid
     * with 16 dp of screen padding on each side and 8 dp of margin around each widget, cells about 10% taller than wide.
     * A real launcher differs by a few dp either way; it is the right order of size for judging truncation and overflow.
     */
    fun sizeDp(size: String, screenWidthDp: Float): Pair<Float, Float> {
        val cols = if (size == "2x2") 2 else 4
        val rows = if (size == "4x4") 4 else 2
        val cellW = (screenWidthDp - 32f) / 4f
        val cellH = cellW * 1.1f
        return (cols * cellW - 16f) to (rows * cellH - 16f)
    }

    /** How much to scale a [wPx] x [hPx] widget so its longer side is at most [maxSide] (never enlarges). */
    fun scale(wPx: Int, hPx: Int, maxSide: Int = MAX_SIDE): Float = minOf(1f, maxSide.toFloat() / maxOf(wPx, hPx, 1))

    enum class Wait { READY, WAIT, LISTS_TIMED_OUT, NOT_APPLIED }

    /** Where picture-taking stands: the views applied, their lists loaded, and how long it has been waiting. Never waits past [LISTS_MS]. */
    fun wait(applied: Boolean, listsReady: Boolean, waitedMs: Long): Wait = when {
        applied && listsReady -> Wait.READY
        waitedMs > LISTS_MS -> if (applied) Wait.LISTS_TIMED_OUT else Wait.NOT_APPLIED
        else -> Wait.WAIT
    }

    fun scaled(px: Int, scale: Float): Int = maxOf(1, Math.round(px * scale))

    /** The scale at step [i] of [SHRINK] for the natural size, or null when the steps are used up. */
    fun step(wPx: Int, hPx: Int, i: Int): Float? = SHRINK.getOrNull(i)?.let { scale(wPx, hPx) * it }

    /** What the card's report entry carries for a good picture. [encode] is base64 without wraps (android.util.Base64 on the phone). */
    fun shot(png: ByteArray, width: Int, height: Int, night: Boolean, wDp: Float, hDp: Float, encode: (ByteArray) -> String): JSONObject =
        JSONObject().put("png", encode(png)).put("width", width).put("height", height).put("theme", if (night) "dark" else "light")
            .put("dp", JSONObject().put("width", Math.round(wDp)).put("height", Math.round(hDp)))
}

/** What came of drawing a card as a picture. */
sealed class PreviewResult {
    class Shot(val png: ByteArray, val width: Int, val height: Int, val night: Boolean, val wDp: Float, val hDp: Float) : PreviewResult()
    class Failed(val why: String) : PreviewResult()
}

/**
 * Draws a card as the home-screen widget would, but into a picture for the agent: the same RemoteViews that
 * [CardWidgetProvider] builds, applied under an [android.appwidget.AppWidgetHostView] in Ash's own process (no launcher
 * involved), laid out at the size a launcher gives this card's size on this phone (see [PreviewPlan.sizeDp]), in the theme
 * the system is in now. Scrolling lists are waited for (bounded) so their first rows are in the picture. Main thread only.
 */
object CardPreview {
    private val main = Handler(Looper.getMainLooper())

    private fun night(ctx: Context) = (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    /** [done] runs once, on the main thread: a picture, or why there is none. */
    fun take(ctx: Context, card: WCard, render: CardRender?, done: (PreviewResult) -> Unit) {
        var finished = false
        fun finish(r: PreviewResult) { if (!finished) { finished = true; done(r) } }
        main.postDelayed({ finish(PreviewResult.Failed("预览没能在 ${PreviewPlan.TIMEOUT_MS / 1000} 秒内画好")) }, PreviewPlan.TIMEOUT_MS)
        try {
            if (render == null) return finish(PreviewResult.Failed(card.problem ?: "卡片内容缺失"))
            if (card.expiresAt != null && card.expiresAt <= System.currentTimeMillis()) return finish(PreviewResult.Failed("卡片已过期，桌面上显示的是「已过期」"))
            val dm = ctx.resources.displayMetrics
            val (wDp, hDp) = PreviewPlan.sizeDp(card.size, dm.widthPixels / dm.density)
            val dark = night(ctx)
            var built: CardViews.Built? = null
            CardWidgetProvider.render(ctx, 0, card, render, wDp, hDp, single = true, onBuilt = { built = it }) { rv, problem ->
                val b = built
                if (rv == null || b == null) finish(PreviewResult.Failed(problem ?: "画不出来"))
                else capture(ctx, b, (wDp * dm.density).toInt(), (hDp * dm.density).toInt(), wDp, hDp, dark) { finish(it) }
            }
        } catch (e: Exception) {
            finish(PreviewResult.Failed("预览出错（${e.javaClass.simpleName}: ${e.message?.take(200) ?: ""}）"))
        }
    }

    private fun capture(ctx: Context, built: CardViews.Built, wPx: Int, hPx: Int, wDp: Float, hDp: Float, dark: Boolean, finish: (PreviewResult) -> Unit) {
        val started = System.currentTimeMillis()
        val host = CardCheck.host(ctx, built.views)
        fun layout(root: View) {
            root.measure(View.MeasureSpec.makeMeasureSpec(wPx, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(hPx, View.MeasureSpec.EXACTLY))
            root.layout(0, 0, wPx, hPx)
        }
        fun listsReady(root: View) = built.lists.all { (id, rows) -> rows <= 0 || ((root.findViewById<View>(id) as? AdapterView<*>)?.adapter?.count ?: 0) > 0 }
        fun look() {
            val root = host.getChildAt(0)
            val applied = root != null && root.findViewById<View>(R.id.card_root) != null
            val waited = System.currentTimeMillis() - started
            when (PreviewPlan.wait(applied, applied && listsReady(root!!), waited)) {
                PreviewPlan.Wait.READY -> {
                    // One more pass after the rows exist, so the list lays out its children; then draw.
                    layout(root)
                    main.post { runCatching { layout(root); finish(draw(root, wPx, hPx, wDp, hDp, dark)) }
                        .onFailure { finish(PreviewResult.Failed("预览排版出错（${it.javaClass.simpleName}: ${it.message?.take(200) ?: ""}）")) } }
                }
                PreviewPlan.Wait.LISTS_TIMED_OUT -> finish(PreviewResult.Failed("列表里的内容没能在 ${PreviewPlan.LISTS_MS / 1000} 秒内加载出来，预览不画（桌面上也可能是空的）"))
                PreviewPlan.Wait.NOT_APPLIED -> finish(PreviewResult.Failed("安卓没有把这张卡片画出来"))
                PreviewPlan.Wait.WAIT -> { if (applied) layout(root!!); main.postDelayed({ look() }, 50) }
            }
        }
        main.post { look() }
    }

    /** Draw the laid-out [root] on a backdrop (the corners of the widget's rounded shape stay visible), scaled to the picture size, as a PNG. */
    private fun draw(root: View, wPx: Int, hPx: Int, wDp: Float, hDp: Float, dark: Boolean): PreviewResult {
        var step = 0
        while (true) {
            val scale = PreviewPlan.step(wPx, hPx, step) ?: return PreviewResult.Failed("预览的 PNG 超过 ${PreviewPlan.MAX_BYTES / 1024} KB，不发送")
            val w = PreviewPlan.scaled(wPx, scale); val h = PreviewPlan.scaled(hPx, scale)
            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val out = ByteArrayOutputStream()
            try {
                val canvas = Canvas(bitmap)
                canvas.drawColor(if (dark) BACKDROP_DARK else BACKDROP_LIGHT)
                canvas.scale(w.toFloat() / wPx, h.toFloat() / hPx)
                root.draw(canvas)
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            } finally { bitmap.recycle() }
            if (out.size() <= PreviewPlan.MAX_BYTES) return PreviewResult.Shot(out.toByteArray(), w, h, dark, wDp, hDp)
            step++
        }
    }

    /** Stands in for the wallpaper behind a widget: neutral greys that show the card's edge in either theme. */
    private const val BACKDROP_DARK = 0xFF2B2D31.toInt()
    private const val BACKDROP_LIGHT = 0xFFD9DCE1.toInt()

    /** The report entry's picture fields for [r]. */
    fun report(r: PreviewResult): Pair<String, Any> = when (r) {
        is PreviewResult.Shot -> "preview" to PreviewPlan.shot(r.png, r.width, r.height, r.night, r.wDp, r.hDp) { Base64.encodeToString(it, Base64.NO_WRAP) }
        is PreviewResult.Failed -> "preview_problem" to r.why.take(500)
    }
}
