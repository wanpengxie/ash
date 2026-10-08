package ai.ash.apps

import ai.ash.bridge.Bridge
import ai.ash.bridge.IAppsHost
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.IBinder
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** One of the owner's apps, as Ash lists it. */
data class AppInfo(
    val id: String, val name: String, val version: String, val summary: String,
    val surfaces: List<Pair<String, String>>, val enabled: Boolean, val granted: Boolean,
) {
    val usable get() = enabled && granted

    companion object {
        /** GET /api/apps; entries with an id the shell cannot give an origin to are left out. */
        fun list(json: String): List<AppInfo> {
            val a = JSONArray(json)
            return (0 until a.length()).mapNotNull { i ->
                val o = a.optJSONObject(i) ?: return@mapNotNull null
                val id = o.optString("id").takeIf { AppIds.valid(it) } ?: return@mapNotNull null
                val s = o.optJSONArray("surfaces") ?: JSONArray()
                val surfaces = (0 until s.length()).mapNotNull { j ->
                    val so = s.optJSONObject(j) ?: return@mapNotNull null
                    val sid = so.optString("id").takeIf { AppIds.validSurface(it) } ?: return@mapNotNull null
                    sid to so.optString("title", sid).ifBlank { sid }.take(40)
                }
                AppInfo(id, o.optString("name", id).ifBlank { id }.take(60), o.optString("version").take(40), o.optString("summary").take(300),
                    surfaces, o.optBoolean("enabled", true), o.optBoolean("granted", false))
            }
        }
    }
}

/** Ash could not be reached (not installed, not running, signed by someone else) or refused. */
class AshUnavailable(message: String) : Exception(message)

/**
 * The shell's only way out: Ash's apps service (IAppsHost), bound once per process. Ash is checked to be signed like
 * this app before binding; Ash checks the same of us on every call. Every call here blocks: never on the main thread.
 */
object Ash {
    private const val TAG = "ash.apps"
    private val lock = Object()
    @Volatile private var host: IAppsHost? = null
    @Volatile private var latch = CountDownLatch(1)
    private var bound = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            host = IAppsHost.Stub.asInterface(service); latch.countDown()
        }
        override fun onServiceDisconnected(name: ComponentName) { host = null; latch = CountDownLatch(1) }
        override fun onBindingDied(name: ComponentName) { synchronized(lock) { host = null; bound = false; latch = CountDownLatch(1) } }
        override fun onNullBinding(name: ComponentName) { latch.countDown() }
    }

    fun installed(ctx: Context): Boolean = runCatching { ctx.packageManager.getPackageInfo(Bridge.ASH_PACKAGE, 0); true }.getOrDefault(false)

    private fun connect(ctx: Context): IAppsHost {
        host?.let { return it }
        val app = ctx.applicationContext
        if (!installed(app)) throw AshUnavailable("没有找到 Ash")
        if (app.packageManager.checkSignatures(app.packageName, Bridge.ASH_PACKAGE) != PackageManager.SIGNATURE_MATCH) throw AshUnavailable("这个 Ash 和「Ash 应用」不是同一来源，不能连接")
        val wait = synchronized(lock) {
            if (!bound) {
                latch = CountDownLatch(1)
                bound = app.bindService(Intent().setClassName(Bridge.ASH_PACKAGE, Bridge.APPS_HOST_SERVICE), connection, Context.BIND_AUTO_CREATE)
                if (!bound) throw AshUnavailable("Ash 太旧，还不支持应用：请更新 Ash")
            }
            latch
        }
        wait.await(10, TimeUnit.SECONDS)
        val h = host ?: throw AshUnavailable("连不上 Ash：打开 Ash 后再试")
        if (runCatching { h.protocol() }.getOrNull() != Bridge.PROTOCOL) throw AshUnavailable("Ash 和「Ash 应用」版本不匹配：请在 Ash 里更新它")
        return h
    }

    class Reply(val status: Int, val type: String, val body: String, val bytes: ByteArray?) {
        val ok get() = status in 200..299
        /** The core's error text, if it gave one. */
        fun error(): String = runCatching { JSONObject(body).let { it.optString("message").ifBlank { it.optString("error") } } }.getOrNull()?.takeIf { it.isNotBlank() }?.take(200)
            ?: "HTTP $status"
    }

    fun request(ctx: Context, method: String, path: String, body: String = ""): Reply {
        val text = try { Bridge.read(connect(ctx).request(method, path, body)) }
        catch (e: AshUnavailable) { throw e }
        catch (e: Exception) { Log.w(TAG, "request to Ash failed", e); host = null; throw AshUnavailable("连不上 Ash：打开 Ash 后再试") }
        val o = runCatching { JSONObject(text) }.getOrNull() ?: throw AshUnavailable("Ash 的回答看不懂")
        val reply = Reply(o.optInt("status", 502), o.optString("type"), o.optString("body"),
            o.optString("base64").takeIf { it.isNotEmpty() }?.let { runCatching { Base64.decode(it, Base64.DEFAULT) }.getOrNull() })
        if (reply.status == 503) throw AshUnavailable("Ash 没在运行：打开 Ash 后再试")
        return reply
    }

    // The apps API (Ash's core, owner only).

    fun apps(ctx: Context): List<AppInfo> {
        val r = request(ctx, "GET", "/api/apps")
        if (r.status == 404) throw AshUnavailable("这个版本的 Ash 还不支持应用：请更新 Ash")
        if (!r.ok) throw AshUnavailable("Ash 没给出应用列表（${r.error()}）")
        return runCatching { AppInfo.list(r.body) }.getOrElse { throw AshUnavailable("应用列表看不懂") }
    }

    fun icon(ctx: Context, id: String): Bitmap? = runCatching {
        val r = request(ctx, "GET", "/api/apps/$id/icon")
        val bytes = r.bytes?.takeIf { r.ok } ?: return null
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }.getOrNull()

    /** An app's page: its HTML and the network domains it declared. */
    fun surface(ctx: Context, id: String, surface: String): Pair<String, Csp> {
        val r = request(ctx, "GET", "/api/apps/$id/surfaces/$surface")
        if (!r.ok) throw AshUnavailable("打不开这一页（${r.error()}）")
        val o = runCatching { JSONObject(r.body) }.getOrNull() ?: throw AshUnavailable("这一页看不懂")
        val html = o.optString("html").takeIf { it.isNotBlank() } ?: throw AshUnavailable("这一页是空的")
        return html to Csp.fromJson(o.optJSONObject("csp"))
    }

    /** The backend the MCP Apps host uses: always the one app's own routes. */
    fun backend(ctx: Context) = object : AppsBackend {
        override fun callTool(app: String, tool: String, arguments: JSONObject): JSONObject {
            val r = try { request(ctx, "POST", "/api/apps/$app/call", JSONObject().put("tool", tool).put("arguments", arguments).toString()) }
            catch (e: AshUnavailable) { throw AppsError(e.message ?: "Ash unavailable") }
            if (!r.ok) throw AppsError(r.error())
            return runCatching { JSONObject(r.body) }.getOrElse { throw AppsError("Invalid tool result") }
        }
        override fun sendMessage(app: String, text: String) {
            val r = try { request(ctx, "POST", "/api/apps/$app/message", JSONObject().put("text", text).toString()) }
            catch (e: AshUnavailable) { throw AppsError(e.message ?: "Ash unavailable") }
            if (!r.ok) throw AppsError(r.error())
        }
    }

    /**
     * 「添加到桌面」 asked by Ash, for when the shell's own request goes nowhere (ColorOS gives the shell no permission page).
     * Bridge.PIN_ASKED, PIN_UNSUPPORTED, PIN_FAILED, or 0 when Ash is too old to do it. Blocks: never on the main thread.
     */
    fun requestPin(ctx: Context, id: String, name: String, icon: Bitmap?, result: android.content.IntentSender): Int =
        try { connect(ctx).requestPin(id, name, icon, result) }
        catch (e: AshUnavailable) { throw e }
        catch (e: Exception) { Log.w(TAG, "pin request through Ash failed", e); host = null; throw AshUnavailable("连不上 Ash") }

    /** Whether Ash's shortcut for this app is on the home screen (false when Ash cannot tell). Blocks. */
    fun pinned(ctx: Context, id: String): Boolean = runCatching { connect(ctx).pinned(id) }.getOrDefault(false)

    /** Ash's own screen: where the owner approves an app. */
    fun open(ctx: Context) {
        val launch = ctx.packageManager.getLaunchIntentForPackage(Bridge.ASH_PACKAGE) ?: return
        ctx.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
