package ai.ash.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Shader
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.RemoteViews
import android.widget.Toast
import ai.ash.host.CoreClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The phone side of service:widgets: keeps the state the core pushes (POST /widgets), the card picked on the phone for
 * each "Ash 卡片" widget and what the owner toggled since; passes taps, toggles and picks back to the core as the owner,
 * and tells the core which cards it could not draw and why.
 */
object WidgetHost {
    private const val TAG = "ash.widgets"
    private const val PREFS = "ash.widgets"
    private const val STATE = "state"
    private const val LOCAL = "local:"
    private const val FILE = "widgets-state.json"
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var cached: WState? = null
    private val faces = HashMap<String, Bitmap>()
    /** What the owner changed on a card since its version updated_at: toggles and choices (dropped with a new version), tabs (kept). */
    private val locals = HashMap<String, Pair<Long, Local>>()
    /** The last word sent to the core per card: version and problem (null = drew fine). */
    private val reported = HashMap<String, Pair<Long, String?>>()
    private val unsent = LinkedHashMap<String, JSONObject>()

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun file(ctx: Context) = File(ctx.applicationContext.filesDir, FILE)

    fun state(ctx: Context): WState? = cached ?: run {
        // Cards may carry embedded images, so the state lives in a file (older versions kept it in preferences).
        val raw = runCatching { file(ctx).takeIf { it.isFile }?.readText() }.getOrNull() ?: prefs(ctx).getString(STATE, null)
        raw?.let { runCatching { WidgetPlan.parseState(JSONObject(it)) }.getOrNull() }
    }?.also { cached = it }

    fun localCard(ctx: Context, widgetId: Int): String? = prefs(ctx).getString(LOCAL + widgetId, null)

    fun local(card: WCard): Local = synchronized(locals) {
        val (version, local) = locals[card.id] ?: return Local()
        if (version == card.updatedAt) local else Local(tabs = local.tabs)
    }

    private fun changeLocal(card: WCard, change: (Local) -> Local) = synchronized(locals) { locals[card.id] = card.updatedAt to change(local(card)) }

    /**
     * The core's full state. Every widget redraws (checked in Ash's own process first), and so does a check of each card
     * not placed yet; the answer lists the Ash widgets on the home screen and, per card, whether it could be drawn.
     */
    fun accept(ctx: Context, body: JSONObject): Pair<Int, JSONObject> {
        val parsed = runCatching { WidgetPlan.parseState(body) }.getOrNull() ?: return 400 to JSONObject().put("error", "invalid_widgets")
        val app = ctx.applicationContext
        val stored = runCatching {
            val tmp = File(file(app).path + ".tmp")
            tmp.writeText(body.toString())
            tmp.renameTo(file(app))
        }.getOrDefault(false)
        if (!stored) return 500 to JSONObject().put("error", "store_failed")
        prefs(app).edit().remove(STATE).apply()
        cached = parsed
        val done = CountDownLatch(1)
        main.post {
            try {
                CardWidgetProvider.updateAll(app)
                checkUnplaced(app, parsed)
            } catch (e: Exception) { Log.w(TAG, "drawing widgets failed", e) }
            finally { done.countDown() }
        }
        // The core waits about three seconds for this answer; what is not checked by then is reported later.
        done.await(2, TimeUnit.SECONDS)
        return 200 to JSONObject().put("ok", true).put("widgets", placed(app)).put("rendered", drain())
    }

    /** Cards no widget shows yet are checked at their nominal size, so their creator learns about a problem before placing. */
    private fun checkUnplaced(ctx: Context, state: WState) {
        val shown = HashSet<String>()
        val manager = AppWidgetManager.getInstance(ctx)
        for (id in manager.getAppWidgetIds(ComponentName(ctx, CardWidgetProvider::class.java)))
            (state.bindings[id.toString()] ?: localCard(ctx, id))?.let { shown.add(it) }
        for (card in state.cards.values) {
            if (card.id in shown || synchronized(reported) { reported[card.id]?.first == card.updatedAt }) continue
            val render = card.render
            if (render == null) { report(ctx, card, card.problem ?: "卡片内容缺失"); continue }
            val (w, h) = WidgetPlan.nominal(card.size)
            val result = runCatching { CardWidgetProvider.render(ctx, 0, card, render, w, h) }.getOrElse { null to (it.message ?: it.javaClass.simpleName) }
            report(ctx, card, result.second)
        }
    }

    /** Note what drawing [card] came to; changes go to the core with the next answer, or on their own shortly. */
    fun report(ctx: Context, card: WCard, problem: String?) {
        synchronized(reported) {
            if (reported[card.id] == card.updatedAt to problem) return
            reported[card.id] = card.updatedAt to problem
        }
        synchronized(unsent) {
            unsent[card.id] = JSONObject().put("card", card.id).put("updated_at", card.updatedAt).apply { if (problem != null) put("problem", problem.take(1000)) }
        }
        val app = ctx.applicationContext
        // Within an accept() the answer carries it; otherwise (an image arrived or failed later) it goes by itself.
        main.removeCallbacks(flush)
        flushContext = app
        main.postDelayed(flush, 2500)
    }

    @Volatile private var flushContext: Context? = null
    private val flush = Runnable {
        val app = flushContext ?: return@Runnable
        val rendered = drain()
        if (rendered.length() == 0) return@Runnable
        Thread({ send(app, "widget.placed", JSONObject().put("widgets", placed(app)).put("rendered", rendered)) { ok, why -> if (!ok) Log.w(TAG, "report not sent: $why") } }, "ash-widgets-report").start()
    }

    private fun drain(): JSONArray = synchronized(unsent) { JSONArray(unsent.values.toList()).also { unsent.clear() } }

    fun placed(ctx: Context): JSONArray {
        val manager = AppWidgetManager.getInstance(ctx)
        val out = JSONArray()
        for (id in manager.getAppWidgetIds(ComponentName(ctx, AshWidgetProvider::class.java))) out.put(JSONObject().put("id", id.toString()).put("type", "ash"))
        for (id in manager.getAppWidgetIds(ComponentName(ctx, CardWidgetProvider::class.java))) out.put(JSONObject().put("id", id.toString()).put("type", "card"))
        return out
    }

    fun forget(ctx: Context, ids: IntArray) {
        val edit = prefs(ctx).edit()
        for (id in ids) edit.remove(LOCAL + id)
        edit.apply()
    }

    /** The owner picked a card for a widget: draw it now, and tell the core (which may also rebind it later). */
    fun pick(ctx: Context, widgetId: Int, card: String) {
        prefs(ctx).edit().putString(LOCAL + widgetId, card).commit()
        CardWidgetProvider.update(ctx, AppWidgetManager.getInstance(ctx), widgetId)
        val app = ctx.applicationContext
        Thread({
            send(app, "widget.bind", JSONObject().put("widget", widgetId.toString()).put("card", card)) { ok, why ->
                if (!ok) Log.w(TAG, "bind not confirmed ($why); the phone keeps the pick")
            }
        }, "ash-widget-bind").start()
    }

    fun reportPlaced(ctx: Context) {
        val app = ctx.applicationContext
        Thread({ send(app, "widget.placed", JSONObject().put("widgets", placed(app))) { _, _ -> } }, "ash-widgets-placed").start()
    }

    /** A button on a widget drawn before the full card format: only the event name. */
    fun tapLegacy(ctx: Context, card: String, action: String, done: () -> Unit) = tell(ctx, JSONObject().put("card", card).put("action", action), true, done)

    /** One tap, toggle, choice or tab from [WidgetActionReceiver]. */
    fun act(ctx: Context, cardId: String, component: String, uri: Uri, intent: Intent, done: () -> Unit) {
        val app = ctx.applicationContext
        val card = state(app)?.cards?.get(cardId)
        val node = card?.render?.let { WidgetPlan.find(it, component) }
        if (card == null || node == null) { done(); return }
        val tells = node.action is CAction.Event || node.bound
        when (uri.getQueryParameter("k")) {
            "send" -> tell(app, JSONObject().put("card", cardId).put("component", component), true, done)
            "open" -> {
                val target = node.action
                if (target != null && target !is CAction.Event) runCatching { app.startActivity(WidgetActions.openIntent(app, target)) }
                    .onFailure { main.post { Toast.makeText(app, "打不开：${it.message ?: ""}", Toast.LENGTH_SHORT).show() } }
                done()
            }
            "toggle" -> {
                val was = uri.getQueryParameter("ck") == "true"
                val checked = if (intent.hasExtra(RemoteViews.EXTRA_CHECKED)) intent.getBooleanExtra(RemoteViews.EXTRA_CHECKED, !was) else !was
                changeLocal(card) { it.copy(checked = it.checked + (component to checked)) }
                main.post { CardWidgetProvider.updateCard(app, cardId) }
                if (tells) tell(app, JSONObject().put("card", cardId).put("component", component).put("checked", checked), false, done) else done()
            }
            "choose" -> {
                val value = uri.getQueryParameter("v") ?: return done()
                val now = local(card).chosen[component] ?: node.options.filter { it.checked }.map { it.value }
                val on = if (intent.hasExtra(RemoteViews.EXTRA_CHECKED)) intent.getBooleanExtra(RemoteViews.EXTRA_CHECKED, value !in now) else value !in now
                val next = if (!node.multiple) listOf(value) else if (on) (now + value).distinct() else now - value
                changeLocal(card) { it.copy(chosen = it.chosen + (component to next)) }
                main.post { CardWidgetProvider.updateCard(app, cardId) }
                if (tells) tell(app, JSONObject().put("card", cardId).put("component", component).put("value", JSONArray(next)), false, done) else done()
            }
            "tab" -> {
                val index = uri.getQueryParameter("i")?.toIntOrNull() ?: return done()
                changeLocal(card) { it.copy(tabs = it.tabs + (component to index)) }
                main.post { CardWidgetProvider.updateCard(app, cardId); done() }
            }
            else -> done()
        }
    }

    private fun tell(app: Context, body: JSONObject, toast: Boolean, done: () -> Unit) {
        Thread({
            send(app, "widget.tap", body) { ok, why ->
                main.post {
                    if (toast || !ok) Toast.makeText(app, if (ok) "已告诉 Ash" else "Ash 没有响应，请打开 Ash 看看", Toast.LENGTH_SHORT).show()
                    if (!ok) Log.w(TAG, "tap not delivered: $why")
                    done()
                }
            }
        }, "ash-widget-tap").start()
    }

    /** Same authenticated owner path as notification replies; waits for the core's answer. Call off the main thread. */
    private fun send(ctx: Context, word: String, body: JSONObject, done: (Boolean, String) -> Unit) {
        val result = runCatching {
            val out = CoreClient(ctx).sendPresentAction(JSONObject().put("to", "service:widgets").put("kind", "request").put("word", word)
                .put("body", body).put("wait", true).put("client_id", "widget:${UUID.randomUUID()}"))
            val reply = out.optJSONObject("reply")?.optJSONObject("body")
            (reply?.optBoolean("ok") == true) to (reply?.optJSONObject("error")?.optString("message") ?: "")
        }.getOrElse { false to (it.message ?: "") }
        done(result.first, result.second)
    }

    /** Ash's face for a state (the island's avatars), round, small enough for a widget. */
    fun face(ctx: Context, name: String): Bitmap? = synchronized(faces) {
        faces[name] ?: runCatching {
            val src = runCatching { ctx.assets.open("ash-island/avatars/$name.webp").use { BitmapFactory.decodeStream(it) } }.getOrNull()
                ?: ctx.assets.open("ash-island/avatars/default.webp").use { BitmapFactory.decodeStream(it) }
            val size = 144
            val scaled = Bitmap.createScaledBitmap(src, size, size, true)
            val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { shader = BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP) }
            Canvas(out).drawCircle(size / 2f, size / 2f, size / 2f, paint)
            out
        }.getOrNull()?.also { faces[name] = it }
    }
}
