package ai.ash.host.screen

import ai.ash.BuildConfig
import ai.ash.bridge.Bridge
import ai.ash.bridge.IAshHost
import ai.ash.bridge.IScreenBridge
import ai.ash.host.TaskStatus
import ai.ash.host.cap.CapResult
import ai.ash.host.cap.Capability
import ai.ash.ui.HomeActivity
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Ash's end of the bridge to its screen helper (ai.ash.screen): the app that holds the accessibility service and draws
 * the task island. The helper's tools join the phone's manifest while it is connected; the island is told what to
 * show, and the owner's actions on it come back here. Ash only binds to a helper signed like itself.
 */
object ScreenBridge {
    private const val TAG = "ash.screen"
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var app: Context? = null
    @Volatile private var bridge: IScreenBridge? = null
    @Volatile private var status = JSONObject()
    @Volatile private var tools: List<Capability> = emptyList()
    private var bound = false
    private var lastIsland = ""

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            val peer = IScreenBridge.Stub.asInterface(service)
            Thread({
                try {
                    if (peer.protocol() != Bridge.PROTOCOL) { Log.w(TAG, "screen helper speaks another protocol"); return@Thread }
                    bridge = peer
                    peer.attach(host)
                    refresh(peer)
                    main.post { lastIsland = ""; TaskStatus.refresh() }
                } catch (e: Exception) { Log.w(TAG, "screen helper did not answer", e) }
            }, "ash-screen-connect").start()
        }
        override fun onServiceDisconnected(name: ComponentName) { lost() }
        override fun onBindingDied(name: ComponentName) { lost(); main.post { unbind(); connect() } }
    }

    private val host = object : IAshHost.Stub() {
        override fun islandAction(action: String) {
            if (!Bridge.sameSigner(app ?: return, android.os.Binder.getCallingUid())) return
            val a = runCatching { JSONObject(action) }.getOrNull() ?: return
            main.post { act(a) }
        }
        override fun changed(next: String) {
            if (!Bridge.sameSigner(app ?: return, android.os.Binder.getCallingUid())) return
            val value = runCatching { JSONObject(next) }.getOrNull() ?: return
            val toolsChanged = value.optBoolean("accessibility") != status.optBoolean("accessibility")
            status = value
            if (toolsChanged) bridge?.let { peer -> Thread({ runCatching { refresh(peer) } }, "ash-screen-refresh").start() }
            main.post { TaskStatus.refresh() }
        }
    }

    fun start(ctx: Context) {
        app = ctx.applicationContext
        // Installed, updated or removed later: connect again.
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED); addAction(Intent.ACTION_PACKAGE_REPLACED); addAction(Intent.ACTION_PACKAGE_REMOVED)
            addDataScheme("package")
        }
        ctx.applicationContext.registerReceiver(object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                if (intent.data?.schemeSpecificPart == Bridge.SCREEN_PACKAGE) main.post { unbind(); connect() }
            }
        }, filter)
        main.post { connect() }
    }

    /** Binds to the helper when it is installed and signed like Ash. */
    fun connect() {
        val ctx = app ?: return
        // An isolated test build never takes over the owner's helper.
        if (bound || BuildConfig.ISOLATED_PROBE || !trusted(ctx)) return
        val intent = Intent().setClassName(Bridge.SCREEN_PACKAGE, Bridge.SCREEN_SERVICE)
        bound = runCatching { ctx.bindService(intent, connection, Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT) }.getOrDefault(false)
        if (!bound) Log.w(TAG, "could not bind the screen helper")
    }
    private fun unbind() {
        if (bound) runCatching { app?.unbindService(connection) }
        bound = false; lost()
    }
    private fun lost() {
        bridge = null; status = JSONObject(); tools = emptyList()
        main.post { TaskStatus.refresh() }
    }

    private fun refresh(peer: IScreenBridge) {
        status = JSONObject(peer.status())
        val list = JSONArray(peer.manifest())
        tools = (0 until list.length()).mapNotNull { list.optJSONObject(it) }.map { RemoteTool(it) } +
            if (status.optBoolean("screenshot")) listOf(ScreenshotTool) else emptyList()
    }

    // ---- what Ash asks of the helper ----

    /** Installed and signed like Ash (another app under the helper's name is never used). */
    fun trusted(ctx: Context): Boolean = installedVersion(ctx) > 0 &&
        ctx.packageManager.checkSignatures(ctx.packageName, Bridge.SCREEN_PACKAGE) == PackageManager.SIGNATURE_MATCH
    fun installedVersion(ctx: Context): Long = runCatching {
        val info = ctx.packageManager.getPackageInfo(Bridge.SCREEN_PACKAGE, 0)
        if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
    }.getOrDefault(0L)
    /** Not installed, or older than the one Ash carries. */
    fun needsInstall(ctx: Context): Boolean = installedVersion(ctx) < BuildConfig.SCREEN_VERSION_CODE || !trusted(ctx)

    fun connected() = bridge != null
    /** The helper's accessibility service is on: Ash can see and operate the screen. */
    fun accessibility() = connected() && status.optBoolean("accessibility")
    /** The island can be drawn (the helper's accessibility service, or its overlay permission). */
    fun islandReady() = connected() && status.optBoolean("island_ready")
    fun islandShown() = connected() && status.optBoolean("island_shown")
    fun tools(): List<Capability> = tools

    fun call(name: String, args: JSONObject): CapResult {
        val peer = bridge ?: return CapResult.fail("$name is not available right now: the screen helper is not connected")
        return try { CapResult.fromJson(JSONObject(Bridge.read(peer.call(name, args.toString())))) }
        catch (e: Exception) { Log.w(TAG, "$name over the bridge failed", e); CapResult.fail("$name failed: the screen helper did not answer") }
    }
    fun screenState(settle: Boolean): JSONObject =
        bridge?.let { runCatching { JSONObject(it.screenState(settle)) }.getOrNull() } ?: JSONObject()

    /** Ash's own input to other apps (opening an app, a key) passes under the island; refused while the owner types. */
    fun <T> withTouchPassthrough(action: () -> T): T {
        val peer = bridge ?: return action()
        val token = UUID.randomUUID().toString()
        val refused = try { peer.guard(token) } catch (_: Exception) { return action() }
        if (refused.isNotEmpty()) throw IllegalStateException(refused)
        try { return action() } finally { runCatching { peer.release(token) } }
    }

    /** What the island shows. Sent when it changes, and once more after a reconnect. */
    fun island(model: JSONObject?, ashInFront: Boolean) {
        val state = JSONObject().put("show", model != null).put("ash_in_front", ashInFront).apply { if (model != null) put("model", model) }.toString()
        if (state == lastIsland) return
        val peer = bridge ?: return
        try { peer.island(state); lastIsland = state } catch (e: Exception) { Log.w(TAG, "island state not delivered", e) }
    }

    // ---- what the owner did on the island ----

    private fun act(a: JSONObject) {
        val request = a.optString("request")
        val reply: (Boolean, String) -> Unit = { ok, message ->
            if (request.isNotEmpty()) runCatching { bridge?.islandResult(JSONObject().put("request", request).put("ok", ok).put("message", message).toString()) }
        }
        when (a.optString("action")) {
            "dismiss" -> TaskStatus.dismiss(a.optString("turn"))
            "stop" -> TaskStatus.stop(a.optString("turn"))
            "open" -> app?.let { it.startActivity(Intent(it, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) }
            "answer" -> TaskStatus.answerCard(a.optString("id"), a.optString("choice"), if (a.has("text")) a.optString("text") else null, reply)
            "send" -> TaskStatus.sendInput(a.optString("text"), a.optString("client_id"), reply)
            else -> reply(false, "未知操作")
        }
    }

    /** One of the helper's tools, as listed in its manifest: Ash's capability that calls it over the bridge. */
    private class RemoteTool(spec: JSONObject) : Capability {
        override val name: String = spec.getString("name")
        override val description: String = spec.optString("description")
        override val schema: JSONObject = spec.optJSONObject("input_schema") ?: JSONObject().put("type", "object")
        override val confirm: Boolean = spec.optBoolean("confirm")
        override fun available(ctx: Context) = connected()
        override fun run(ctx: Context, args: JSONObject) = call(name, args)
    }
}
