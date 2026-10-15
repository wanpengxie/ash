package ai.ash.ui

import ai.ash.link.PresentOutcome
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi
import android.content.Context
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.ContextThemeWrapper
import android.view.View
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * A conversation card as a picture, for the agent that made it (`chat` present `card.preview {card, theme}`): drawn off screen
 * by the chat's own renderer ([ChatCards]), 330 dp wide, in the theme asked for, without the 👍 / 👎 footer and with its inputs
 * as they are; answered as an image part (a PNG of at most 900 px on its longer side, under 300 KB). Nothing comes to the front.
 */
object ChatCardPreview {
    private const val TAG = "ash.cards"
    private val main = Handler(Looper.getMainLooper())
    /** How long pictures inside the card get to arrive before it is drawn without them. */
    private const val IMAGES_MS = 3000L
    private const val TIMEOUT_MS = 8000L

    /** Runs on a worker thread. */
    fun present(ctx: Context, body: JSONObject): PresentOutcome {
        val card = body.optJSONObject("card") ?: return PresentOutcome(false, null, "bad_request", "card.preview needs a card")
        if (card.optString("type").ifEmpty { "a2ui" } != "a2ui" || ChatCardModel.plan(card.optJSONObject("plan")) == null)
            return PresentOutcome(false, null, "bad_request", "only a card with a plan (type a2ui) can be drawn")
        val app = ctx.applicationContext
        val dark = when (body.optString("theme")) { "dark" -> true; "light" -> false; else -> AshUi.night(app) }
        val done = CountDownLatch(1)
        var result: PresentOutcome? = null
        main.post {
            take(app, card, dark) { result = it; done.countDown() }
        }
        if (!done.await(TIMEOUT_MS, TimeUnit.MILLISECONDS)) return PresentOutcome(false, null, "timeout", "the card was not drawn in time")
        return result ?: PresentOutcome(false, null, "failed", "the card was not drawn")
    }

    /** The app's context in [dark] or light, whatever the system is in now. */
    private fun themed(app: Context, dark: Boolean): Context {
        val conf = Configuration(app.resources.configuration)
        conf.uiMode = (conf.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or (if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
        return ContextThemeWrapper(app.createConfigurationContext(conf),
            if (dark) android.R.style.Theme_DeviceDefault_NoActionBar else android.R.style.Theme_DeviceDefault_Light_NoActionBar)
    }

    /** Main thread; [done] runs once. */
    private fun take(app: Context, card: JSONObject, dark: Boolean, done: (PresentOutcome) -> Unit) {
        var finished = false
        val ctx = themed(app, dark)
        val cards = try {
            ChatCards(ctx, null, { _, _ -> }, {}, preview = true) {}
        } catch (e: Exception) { return done(failed(e)) }
        fun finish(r: PresentOutcome) { if (!finished) { finished = true; runCatching { cards.close() }; done(r) } }
        try {
            val view = cards.view(JSONObject().put("type", "card").put("id", card.optString("id")).put("card", card))
            val wPx = AshUi.dp(ctx, ChatCardModel.PREVIEW_DP)
            val started = SystemClock.uptimeMillis()
            fun layout() {
                view.measure(View.MeasureSpec.makeMeasureSpec(wPx, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
                view.layout(0, 0, view.measuredWidth, view.measuredHeight)
            }
            fun shoot() {
                if (finished) return
                try {
                    layout()
                    // Pictures on their way: drawn again until they are in (bounded); one more pass so they are laid out.
                    if (cards.waitingImages() > 0 && SystemClock.uptimeMillis() - started < IMAGES_MS) {
                        main.postDelayed({ if (!finished) { runCatching { cards.redraw() }; shoot() } }, 150)
                        return
                    }
                    layout()
                    finish(draw(view, AshTokens.palette(dark).bg))
                } catch (e: Exception) { finish(failed(e)) }
            }
            main.post { shoot() }
        } catch (e: Exception) { finish(failed(e)) }
    }

    private fun failed(e: Throwable): PresentOutcome {
        Log.w(TAG, "card preview failed", e)
        return PresentOutcome(false, null, "failed", "the card could not be drawn (${e.javaClass.simpleName}: ${e.message?.take(200).orEmpty()})")
    }

    /** The laid-out card on the chat's background, scaled to the picture size, as a PNG small enough. */
    private fun draw(view: View, background: Int): PresentOutcome {
        val wPx = view.width; val hPx = view.height
        if (wPx <= 0 || hPx <= 0) return PresentOutcome(false, null, "failed", "the card has no size")
        var step = 0
        while (true) {
            val (w, h) = ChatCardModel.previewSize(wPx, hPx, step)
                ?: return PresentOutcome(false, null, "failed", "the picture stays over ${ChatCardModel.PREVIEW_BYTES / 1024} KB")
            val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val out = ByteArrayOutputStream()
            try {
                val canvas = Canvas(bitmap)
                canvas.drawColor(background)
                canvas.scale(w.toFloat() / wPx, h.toFloat() / hPx)
                view.draw(canvas)
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            } finally { bitmap.recycle() }
            if (out.size() <= ChatCardModel.PREVIEW_BYTES)
                return PresentOutcome(true, ChatCardModel.previewPart(out.toByteArray(), w, h) { Base64.encodeToString(it, Base64.NO_WRAP) })
            step++
        }
    }
}
