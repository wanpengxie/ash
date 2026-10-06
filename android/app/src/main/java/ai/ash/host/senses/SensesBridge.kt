package ai.ash.host.senses

import ai.ash.BuildConfig
import ai.ash.bridge.Bridge
import ai.ash.bridge.ISensesBridge
import ai.ash.bridge.ISensesHost
import ai.ash.host.CoreClient
import ai.ash.host.cap.CapResult
import ai.ash.host.cap.Capability
import android.app.Activity
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
import java.util.concurrent.Executors

/**
 * Ash's end of the bridge to its senses helper (ai.ash.senses): location, motion, steps and health, recorded by a
 * small app that targets a current Android. Its tools join the phone's manifest while it is connected (each needs a
 * policy of Ash's to be offered). The rows it records arrive here in batches and go on to the core as sense.* events,
 * the way the phone's other senses do; a batch is acknowledged only once the core took it. Ash only binds to a helper
 * signed like itself.
 */
object SensesBridge {
    private const val TAG = "ash.senses"
    private val main = Handler(Looper.getMainLooper())
    private val delivery = Executors.newSingleThreadExecutor { Thread(it, "ash-senses-delivery") }
    @Volatile private var app: Context? = null
    @Volatile private var bridge: ISensesBridge? = null
    @Volatile private var status = JSONObject()
    @Volatile private var tools: List<Capability> = emptyList()
    private var bound = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            val peer = ISensesBridge.Stub.asInterface(service)
            Thread({
                try {
                    if (peer.protocol() != Bridge.PROTOCOL) { Log.w(TAG, "senses helper speaks another protocol"); return@Thread }
                    bridge = peer
                    refresh(peer)
                    peer.attach(host)
                } catch (e: Exception) { Log.w(TAG, "senses helper did not answer", e) }
            }, "ash-senses-connect").start()
        }
        override fun onServiceDisconnected(name: ComponentName) { lost(); main.removeCallbacks(stillWaiting); main.postDelayed(stillWaiting, retryMs) }
        override fun onBindingDied(name: ComponentName) { lost(); main.post { unbind(); connect() } }
    }

    private val host = object : ISensesHost.Stub() {
        override fun senseBatch(batch: String) {
            val ctx = app ?: return
            if (!Bridge.sameSigner(ctx, android.os.Binder.getCallingUid())) return
            delivery.execute { deliver(ctx, batch) }
        }
        override fun changed(next: String) {
            if (!Bridge.sameSigner(app ?: return, android.os.Binder.getCallingUid())) return
            status = runCatching { JSONObject(next) }.getOrNull() ?: return
        }
    }

    /** One batch to the core; acknowledged to the helper only once the core took it (otherwise it is offered again). */
    private fun deliver(ctx: Context, raw: String) {
        val event = SensesEvents.parse(raw)
        if (event == null) {
            // Never deliverable: acknowledged so it does not come back forever, and logged.
            val id = runCatching { JSONObject(raw).optString("batch_id") }.getOrDefault("")
            Log.w(TAG, "dropped a malformed senses batch ${id.take(40)}")
            if (id.isNotBlank()) runCatching { bridge?.ack(id) }
            return
        }
        try {
            CoreClient(ctx).sendSense(event.word, event.body, event.id)
            runCatching { bridge?.ack(event.id) }
        } catch (e: Exception) {
            Log.w(TAG, "senses batch not delivered yet: ${e.javaClass.simpleName}: ${e.message?.take(80)}")
        }
    }

    @Volatile private var watching = false

    fun start(ctx: Context) {
        app = ctx.applicationContext
        if (watching) { main.post { connect() }; return }
        watching = true
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_PACKAGE_ADDED); addAction(Intent.ACTION_PACKAGE_REPLACED); addAction(Intent.ACTION_PACKAGE_REMOVED)
            addDataScheme("package")
        }
        ctx.applicationContext.registerReceiver(object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                if (intent.data?.schemeSpecificPart == Bridge.SENSES_PACKAGE) main.post { unbind(); connect() }
            }
        }, filter)
        main.post { connect() }
    }

    /** Binds to the helper when it is installed and signed like Ash. */
    fun connect() {
        val ctx = app ?: return
        // An isolated test build never takes over the owner's helper.
        if (bound || BuildConfig.ISOLATED_PROBE || !trusted(ctx)) return
        val intent = Intent().setClassName(Bridge.SENSES_PACKAGE, Bridge.SENSES_SERVICE)
        bound = runCatching { ctx.bindService(intent, connection, Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT) }.getOrDefault(false)
        if (!bound) Log.w(TAG, "could not bind the senses helper")
        main.removeCallbacks(stillWaiting)
        main.postDelayed(stillWaiting, retryMs)
    }

    // bindService answers true even when a maker's ROM then refuses to start the helper (ColorOS「关联启动」off): the
    // binding stays pending forever and no connection ever comes. Unconnected after a while: bind again, backing off.
    private var retryMs = FIRST_RETRY_MS
    private val stillWaiting = Runnable {
        if (bridge != null || app == null) { retryMs = FIRST_RETRY_MS; return@Runnable }
        Log.w(TAG, "senses helper not connected after ${retryMs / 1000} s; binding again")
        retryMs = minOf(retryMs * 2, MAX_RETRY_MS)
        unbind(); connect()
    }
    private const val FIRST_RETRY_MS = 10_000L
    private const val MAX_RETRY_MS = 300_000L
    private fun unbind() {
        if (bound) runCatching { app?.unbindService(connection) }
        bound = false; lost()
    }
    private fun lost() { bridge = null; status = JSONObject(); tools = emptyList() }

    private fun refresh(peer: ISensesBridge) {
        status = JSONObject(peer.status())
        val list = JSONArray(peer.manifest())
        tools = (0 until list.length()).mapNotNull { list.optJSONObject(it) }.map { RemoteTool(it) }
    }

    /** The core is back: batches it missed are offered again. */
    fun pull() { delivery.execute { runCatching { bridge?.pull() } } }

    fun trusted(ctx: Context): Boolean = installedVersion(ctx) > 0 &&
        ctx.packageManager.checkSignatures(ctx.packageName, Bridge.SENSES_PACKAGE) == PackageManager.SIGNATURE_MATCH
    fun installedVersion(ctx: Context): Long = runCatching {
        val info = ctx.packageManager.getPackageInfo(Bridge.SENSES_PACKAGE, 0)
        if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
    }.getOrDefault(0L)
    /** Not installed, or older than the one Ash carries. */
    fun needsInstall(ctx: Context): Boolean = installedVersion(ctx) < BuildConfig.SENSES_VERSION_CODE || !trusted(ctx)

    fun connected() = bridge != null
    fun status(): JSONObject = status
    fun tools(): List<Capability> = tools

    /** The helper's own page, where the owner grants each permission and source. */
    fun openSetup(a: Activity) {
        a.startActivity(Intent().setClassName(Bridge.SENSES_PACKAGE, Bridge.SENSES_SETUP).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun call(name: String, args: JSONObject): CapResult {
        val peer = bridge ?: return CapResult.fail("$name is not available right now: the senses helper (Ash 感知) is not connected")
        return try { CapResult.fromJson(JSONObject(Bridge.read(peer.call(name, args.toString())))) }
        catch (e: Exception) { Log.w(TAG, "$name over the bridge failed", e); CapResult.fail("$name failed: the senses helper did not answer") }
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
