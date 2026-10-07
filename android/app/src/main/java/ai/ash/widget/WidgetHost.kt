package ai.ash.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Shader
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import ai.ash.host.CoreClient
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * The phone side of service:widgets: keeps the state the core pushes (POST /widgets), the card picked on the phone for
 * each "Ash 卡片" widget, and passes the owner's taps and picks back to the core as the owner.
 */
object WidgetHost {
    private const val TAG = "ash.widgets"
    private const val PREFS = "ash.widgets"
    private const val STATE = "state"
    private const val LOCAL = "local:"
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var cached: WState? = null
    private val faces = HashMap<String, Bitmap>()

    private fun prefs(ctx: Context) = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun state(ctx: Context): WState? = cached ?: prefs(ctx).getString(STATE, null)?.let { raw ->
        runCatching { WidgetPlan.parseState(JSONObject(raw)) }.getOrNull()
    }?.also { cached = it }

    fun localCard(ctx: Context, widgetId: Int): String? = prefs(ctx).getString(LOCAL + widgetId, null)

    /** The core's full state; answers with the Ash widgets placed now, so the core knows what is on the home screen. */
    fun accept(ctx: Context, body: JSONObject): Pair<Int, JSONObject> {
        val parsed = runCatching { WidgetPlan.parseState(body) }.getOrNull() ?: return 400 to JSONObject().put("error", "invalid_widgets")
        if (!prefs(ctx).edit().putString(STATE, body.toString()).commit()) return 500 to JSONObject().put("error", "store_failed")
        cached = parsed
        CardWidgetProvider.updateAll(ctx)
        return 200 to JSONObject().put("ok", true).put("widgets", placed(ctx))
    }

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

    fun tap(ctx: Context, card: String, action: String, done: () -> Unit) {
        val app = ctx.applicationContext
        Thread({
            send(app, "widget.tap", JSONObject().put("card", card).put("action", action)) { ok, _ ->
                main.post { Toast.makeText(app, if (ok) "已告诉 Ash" else "Ash 没有响应，请打开 Ash 看看", Toast.LENGTH_SHORT).show(); done() }
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
            val src = ctx.assets.open("ash-island/avatars/$name.webp").use { BitmapFactory.decodeStream(it) }
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
