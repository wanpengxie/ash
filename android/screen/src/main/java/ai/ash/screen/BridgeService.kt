package ai.ash.screen

import ai.ash.bridge.Bridge
import ai.ash.bridge.IAshHost
import ai.ash.bridge.IScreenBridge
import ai.ash.host.cap.CapResult
import ai.ash.screen.a11y.A11yService
import ai.ash.screen.island.NativeIsland
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Where Ash connects. It runs the accessibility service's tools for Ash and draws the island Ash describes; the owner's
 * actions on the island go back to Ash. Every call is refused unless the caller is signed like this app.
 */
class BridgeService : Service() {
    override fun onCreate() { super.onCreate(); AshLink.app = applicationContext }
    override fun onBind(intent: Intent): IBinder = binder

    private val binder = object : IScreenBridge.Stub() {
        private fun check() { if (!Bridge.sameSigner(this@BridgeService, Binder.getCallingUid())) throw SecurityException("only Ash may use the screen helper") }
        override fun protocol(): Int { check(); return Bridge.PROTOCOL }
        override fun status(): String { check(); return AshLink.status().toString() }
        override fun manifest(): String {
            check()
            val ctx = this@BridgeService
            val caps = JSONArray()
            for (c in ScreenCapabilities.list) if (runCatching { c.available(ctx) }.getOrDefault(false))
                caps.put(JSONObject().put("name", c.name).put("description", c.description).put("input_schema", c.schema).apply { if (c.confirm) put("confirm", true) })
            return caps.toString()
        }
        override fun call(capability: String, args: String): ParcelFileDescriptor {
            check()
            return Bridge.pipe(run(this@BridgeService, capability, runCatching { JSONObject(args) }.getOrDefault(JSONObject())).toJson().toString())
        }
        override fun screenState(settle: Boolean): String {
            check()
            val service = A11yService.instance
            if (settle) service?.awaitIdle(250, 1000)
            return JSONObject().put("foreground_package", service?.foregroundPackage().orEmpty()).put("epoch", A11yService.screenEpoch.get()).toString()
        }
        override fun guard(token: String): String { check(); return AshLink.guard(token) }
        override fun release(token: String) { check(); AshLink.release(token) }
        override fun attach(host: IAshHost) { check(); AshLink.attach(host) }
        override fun island(state: String) { check(); AshLink.island(this@BridgeService, state) }
        override fun islandResult(result: String) { check(); AshLink.result(result) }
    }

    companion object {
        /** The island stays out of a capture of the main screen, and lets the agent's own touches pass under it. */
        fun run(ctx: Context, name: String, args: JSONObject): CapResult {
            val c = (ScreenCapabilities.list + ScreenCapabilities.hidden).firstOrNull { it.name == name }
                ?: return CapResult.fail("the phone has no capability $name")
            if (!c.available(ctx)) return CapResult.fail("$name is not available right now (the screen helper's accessibility service is off)")
            val call = {
                try { c.run(ctx, args) } catch (e: Throwable) {
                    Log.w("ash.screen", "$name failed", e)
                    CapResult.fail("$name failed: ${e.message ?: e.javaClass.simpleName}")
                }
            }
            return try {
                when {
                    name in setOf("screen.see", "screen.capture") && args.optInt("display", 0) != 0 -> call()
                    name in setOf("screen.see", "screen.capture") -> NativeIsland.withoutOverlay(call)
                    name !in setOf("screen.read", "screen.touch_status") -> NativeIsland.withTouchPassthrough(call)
                    else -> call()
                }
            } catch (e: IllegalStateException) { CapResult.fail(e.message ?: "owner_input_busy") }
        }
    }
}

/** The one Ash attached to the bridge: what the island asks of it, and what it is told when this app's state changes. */
internal object AshLink : NativeIsland.Ash {
    @Volatile var app: Context? = null
    @Volatile private var host: IAshHost? = null
    private val main = Handler(Looper.getMainLooper())
    private val waiting = ConcurrentHashMap<String, (Boolean, String) -> Unit>()
    /** The agent's own input passing under the island, by Ash's token, until released. */
    private val guards = ConcurrentHashMap<String, Thread>()
    private var model: JSONObject? = null

    init { NativeIsland.ash = this }

    fun status(): JSONObject {
        val ctx = app
        return JSONObject().put("version", BuildConfig.VERSION_CODE).put("accessibility", A11yService.instance != null)
            .put("screenshot", A11yService.instance != null && A11yService.canScreenshot)
            .put("island_ready", ctx != null && NativeIsland.ready(ctx)).put("island_shown", NativeIsland.showing())
    }
    /** Tell Ash: the service came or went, the island appeared or left. */
    fun changed() { host?.let { h -> runCatching { h.changed(status().toString()) } } }
    /**
     * The accessibility service connected, went away, or was reconnected (the system does so, e.g. while a testing tool
     * holds the screen): the island's windows went with the old one, so it is drawn again here, from the last frame.
     */
    fun serviceChanged() {
        changed()
        main.post { app?.let { apply(it) } }
    }

    fun attach(next: IAshHost) {
        host = next
        runCatching { next.asBinder().linkToDeath({ if (host === next) { host = null; failWaiting(); main.post { NativeIsland.hide() } } }, 0) }
        changed()
    }

    fun island(ctx: Context, state: String) {
        val value = runCatching { JSONObject(state) }.getOrNull() ?: return
        main.post {
            NativeIsland.ashInFront = value.optBoolean("ash_in_front")
            val shown = value.optJSONObject("model")
            if (!value.optBoolean("show") || shown == null) { model = null; NativeIsland.hide(); return@post }
            model = shown
            apply(ctx)
        }
    }
    /** The latest frame again (the island re-applies it when it may be shown again, or after a local answer). */
    private fun apply(ctx: Context) {
        val m = model ?: return
        NativeIsland.update(ctx, JSONObject(m.toString())) { main.post { apply(ctx) } }
    }

    fun guard(token: String): String {
        if (token.isBlank()) return "bad token"
        val entered = java.util.concurrent.CountDownLatch(1)
        var refused = ""
        // withTouchPassthrough holds for the length of its action; here the action is "until Ash releases".
        val holder = Thread({
            try {
                NativeIsland.withTouchPassthrough {
                    entered.countDown()
                    try { Thread.sleep(Long.MAX_VALUE) } catch (_: InterruptedException) {}
                }
            } catch (e: IllegalStateException) { refused = e.message ?: "owner_input_busy"; entered.countDown() }
        }, "ash-screen-guard")
        guards[token] = holder
        holder.start()
        entered.await()
        if (refused.isNotEmpty()) guards.remove(token)
        return refused
    }
    fun release(token: String) { guards.remove(token)?.interrupt() }

    fun result(json: String) {
        val r = runCatching { JSONObject(json) }.getOrNull() ?: return
        waiting.remove(r.optString("request"))?.invoke(r.optBoolean("ok"), r.optString("message"))
    }
    private fun failWaiting() { for (key in waiting.keys.toList()) waiting.remove(key)?.invoke(false, "Ash 未连接，请稍后重试") }

    private fun tell(action: JSONObject, done: ((Boolean, String) -> Unit)? = null) {
        val h = host
        if (h == null) { done?.invoke(false, "Ash 未连接，请稍后重试"); return }
        if (done != null) { val id = UUID.randomUUID().toString(); waiting[id] = done; action.put("request", id) }
        try { h.islandAction(action.toString()) }
        catch (_: Exception) { action.optString("request").takeIf { it.isNotEmpty() }?.let { waiting.remove(it) }; done?.invoke(false, "Ash 未连接，请稍后重试") }
    }
    override fun dismiss(turn: String) = tell(JSONObject().put("action", "dismiss").put("turn", turn))
    override fun stop(turn: String) = tell(JSONObject().put("action", "stop").put("turn", turn))
    override fun open() = tell(JSONObject().put("action", "open"))
    override fun answer(id: String, choice: String, text: String?, done: (Boolean, String) -> Unit) =
        tell(JSONObject().put("action", "answer").put("id", id).put("choice", choice).apply { if (text != null) put("text", text) }, done)
    override fun send(text: String, clientId: String, done: (Boolean, String) -> Unit) =
        tell(JSONObject().put("action", "send").put("text", text).put("client_id", clientId), done)
    override fun shown(value: Boolean) = changed()
}
