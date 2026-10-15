package ai.ash.apps

import ai.ash.host.apps.AppsBridge
import ai.ash.host.apps.AppsBridgeService
import ai.ash.human.HumanSend
import ai.ash.ui.HomeActivity
import ai.ash.ui.HomeRoute
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.DeadObjectException
import android.os.IBinder
import android.os.Process
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.os.TransactionTooLargeException
import android.util.Base64
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/** One of the owner's apps, as Ash lists it. */
data class AppInfo(
    val id: String, val name: String, val version: String, val summary: String,
    val surfaces: List<Pair<String, String>>, val enabled: Boolean, val granted: Boolean,
    /** What it asks of Ash (the detail page lists them), whether it is running, and what went wrong with it (blank: nothing). */
    val needs: List<Need> = emptyList(), val running: Boolean = false, val error: String = "",
    /** What kind of trouble [error] is (`manifest`, `folder`, `run`; blank when the kernel did not say): [error] itself is for an agent and is never shown. */
    val problem: String = "",
    /** The app's own state, which it keeps up to date itself (`service:apps/apps.badge`): `warn`, `err` or `paused`; blank when it is simply fine. The grid draws a dot of it. */
    val badge: String = "",
    /** A system app (it comes with Ash; its screen is native, [ai.ash.sysapps.SystemApps]), and the line icon it is drawn with. */
    val system: Boolean = false, val icon: String = "",
) {
    /** The app's app.json cannot be read or does not pass: it cannot be installed and cannot be opened. (An older kernel gave no kind: a not-yet-installed app with an error is such a one.) */
    val broken get() = problem == "manifest" || (problem.isEmpty() && error.isNotBlank() && !granted)
    val hasTrouble get() = error.isNotBlank()
    val usable get() = enabled && granted && !broken

    /** What the owner reads about the trouble (what happened, why, what can be done), or null when there is none. Never the kernel's own line, a file name or a parser's message. */
    val troubleText: String? get() = when {
        !hasTrouble -> null
        broken && granted -> "这个应用的说明文件写得不对，打不开；可以点「收回全部权限」把它卸掉。"
        broken -> "这个应用的说明文件写得不对，装不了；让 Ash 帮你改好，改好之后它会出现在这里。"
        problem == "folder" -> "这个应用的文件夹已经不在了，只剩安装记录；可以点「收回全部权限」把它卸掉。"
        else -> "这个应用没能正常跑起来；重新打开试试，还不行可以让 Ash 看看原因，或点「收回全部权限」把它卸掉。"
    }

    /** One thing an app needs from Ash: [kind] is `member` (an ability of Ash's), `notify`, `widgets` or `card`; [why] is its own line for the owner. */
    data class Need(val kind: String, val why: String) {
        companion object {
            /** What the owner reads for it when the app gave no line of its own. */
            fun fallback(kind: String) = when (kind) { "notify" -> "到点提醒你"; "widgets" -> "在桌面放一个小组件"; "card" -> "在对话里放一个入口卡片"; else -> "使用 Ash 的能力" }
        }
        val text get() = why.ifBlank { fallback(kind) }
    }

    companion object {
        private val BADGES = setOf("warn", "err", "paused")

        /** `apps` of the result of `service:apps/apps.list`; entries with an id the shell cannot give an origin to are left out. */
        fun list(a: JSONArray): List<AppInfo> =
            (0 until a.length()).mapNotNull { i ->
                val o = a.optJSONObject(i) ?: return@mapNotNull null
                val id = o.optString("id").takeIf { AppIds.valid(it) } ?: return@mapNotNull null
                val s = o.optJSONArray("surfaces") ?: JSONArray()
                val surfaces = (0 until s.length()).mapNotNull { j ->
                    val so = s.optJSONObject(j) ?: return@mapNotNull null
                    val sid = so.optString("id").takeIf { AppIds.validSurface(it) } ?: return@mapNotNull null
                    sid to so.optString("title", sid).ifBlank { sid }.take(40)
                }
                AppInfo(id, o.optString("name", id).ifBlank { id }.take(60), o.optString("version").take(40), o.optString("summary").take(300),
                    surfaces, o.optBoolean("enabled", true), o.optBoolean("granted", false),
                    needs(o.optJSONArray("needs")), o.optBoolean("running", false), o.optString("error").trim().take(300), o.optString("problem").trim().take(20),
                    o.optString("badge").takeIf { it in BADGES } ?: "", o.optString("kind") == "system", o.optString("icon").take(40))
            }

        private fun needs(a: JSONArray?): List<Need> = if (a == null) emptyList() else (0 until a.length()).mapNotNull { i ->
            val n = a.optJSONObject(i) ?: return@mapNotNull null
            val kind = when {
                n.opt("member") is String -> "member"
                n.optBoolean("notify") -> "notify"
                n.optBoolean("widgets") -> "widgets"
                n.optBoolean("card") -> "card"
                else -> return@mapNotNull null
            }
            Need(kind, n.optString("why").replace(Regex("[\\p{Cc}\\p{Cf}]+"), " ").trim().take(200))
        }
    }
}

/** An app's page, from `service:apps/apps.surface`: its HTML and the network domains it declared (its `csp`). */
class Surface(val html: String, val csp: Csp) {
    companion object {
        /** The `data` of the reply; a page without `csp` gets none, which is the strictest. Null when there is no HTML. */
        fun parse(data: JSONObject): Surface? = data.optString("html").takeIf { it.isNotBlank() }?.let { Surface(it, Csp.fromJson(data.optJSONObject("csp"))) }
    }
}

/** Ash could not be reached, or refused; the message is for the owner. */
class AshUnavailable(message: String) : Exception(message)

/**
 * The shell's only way out: the bridge to Ash (`IAppsBridge`, bound lazily; see [AppsBridgeService]), through which it asks for
 * the owner's apps and, for the page it belongs to, calls the app's tools. [app] is that page's app (null: the list screen).
 * Every call blocks: never on the main thread. [close] when the screen goes.
 */
class Ash(ctx: Context, private val app: String?, private val inProcess: Boolean = false) {
    private val ctx = ctx.applicationContext
    /** [inProcess]: the screen is in Ash's own process (the list in the apps tab), so it asks the bridge's policy directly instead of binding to it. */
    private val direct by lazy { AppsBridge(app, Process.myUid(), { Process.myUid() }) { request -> HumanSend.send(this.ctx, request) } }
    private val lock = Object()
    private var bridge: IAppsBridge? = null
    private var bound = false
    private var closed = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, service: IBinder) { synchronized(lock) { bridge = IAppsBridge.Stub.asInterface(service); lock.notifyAll() } }
        override fun onServiceDisconnected(name: ComponentName) { synchronized(lock) { bridge = null } }
        override fun onBindingDied(name: ComponentName) = reset()
        override fun onNullBinding(name: ComponentName) = reset()
    }

    private fun reset() {
        synchronized(lock) {
            bridge = null
            if (bound) { bound = false; runCatching { ctx.unbindService(connection) } }
            lock.notifyAll()
        }
    }

    /** The screen is gone: unbinds, and calls still running do not bind again. */
    fun close() {
        synchronized(lock) { closed = true }
        reset()
    }

    private fun connect(): IAppsBridge? {
        synchronized(lock) {
            if (closed) return null
            if (!bound) bound = ctx.bindService(AppsBridgeService.intent(ctx, app), connection, Context.BIND_AUTO_CREATE)
            if (!bound) return null
            val deadline = SystemClock.elapsedRealtime() + CONNECT_MS
            while (bridge == null && bound) {
                val left = deadline - SystemClock.elapsedRealtime()
                if (left <= 0) return null
                lock.wait(left)
            }
            return bridge
        }
    }

    /**
     * One word to one member, as the owner: the `Reply` ([Replies]). Never throws. Ash out of reach before the word went out is
     * `offline` (certainly not done); from the moment it went out, anything that goes wrong is `result_unknown` (it may have
     * been done), and it is never sent again.
     */
    fun call(to: String, word: String, body: JSONObject): JSONObject {
        val text = body.toString()
        if (text.length > MAX_BODY) return Replies.error("too_large", "请求太大")
        if (inProcess) return runCatching { JSONObject(direct.call(to, word, text)) }.getOrElse { Replies.error("internal", "出了点问题") }
        repeat(2) {
            val b = connect() ?: return Replies.error("offline", OFFLINE)
            if (!b.asBinder().isBinderAlive) { reset(); return@repeat } // not sent: bind again
            return try {
                val pipe = b.call(to, word, text) ?: return Replies.error("result_unknown", UNKNOWN)
                val answer = ParcelFileDescriptor.AutoCloseInputStream(pipe).use { readUpTo(it, MAX_REPLY + 1) }
                if (answer.size > MAX_REPLY) Replies.error("result_unknown", UNKNOWN) else JSONObject(String(answer, Charsets.UTF_8))
            } catch (_: TransactionTooLargeException) {
                // Thrown before the call is delivered (the request is capped, so this is a tight process buffer): certainly not done.
                Replies.error("too_large", "太大了，传不过来")
            } catch (e: Exception) {
                Log.w(TAG, "the bridge failed after the word went out: ${e.javaClass.simpleName}")
                if (e is DeadObjectException) reset()
                Replies.error("result_unknown", UNKNOWN)
            }
        }
        return Replies.error("offline", OFFLINE)
    }

    private fun readUpTo(input: java.io.InputStream, limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        while (out.size() < limit) {
            val n = input.read(buffer, 0, minOf(buffer.size, limit - out.size()))
            if (n < 0) break
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    }

    private fun data(reply: JSONObject, what: String): JSONObject {
        if (!reply.optBoolean("ok")) throw AshUnavailable("$what（${Replies.errorText(reply).take(200)}）")
        return Replies.data(reply) ?: throw AshUnavailable("$what（Ash 没给出内容）")
    }

    // `service:apps` (owner).

    fun apps(): List<AppInfo> {
        val d = data(call("service:apps", "apps.list", JSONObject()), "Ash 没给出应用列表")
        return AppInfo.list(d.optJSONArray("apps") ?: throw AshUnavailable("应用列表看不懂"))
    }

    /**
     * One of the owner's words on an app (`apps.install`, `apps.enable`, `apps.disable`, `apps.revoke`, `apps.refresh`), sent the way the
     * web page sends it (on the app's own connection, [HumanSend]) — the list screen is in Ash's process and needs no bridge. The `Reply`
     * ([Replies]); never throws. Out of reach before the word went out is `offline`; once it went out, a failure is `result_unknown`.
     */
    fun owner(word: String, id: String? = null): JSONObject {
        val body = JSONObject().apply { if (id != null) put("id", id) }
        return try {
            val sent = HumanSend.send(ctx, JSONObject().put("to", "service:apps").put("kind", "request").put("word", word).put("body", body).put("wait", true))
            HumanSend.reply(sent) ?: Replies.error("result_unknown", UNKNOWN)
        } catch (e: HumanSend.Refused) {
            Replies.error(e.code, e.message.orEmpty().ifBlank { "Ash 没有收下" })
        } catch (_: java.io.IOException) {
            Replies.error("offline", OFFLINE)
        } catch (_: Exception) {
            Replies.error("internal", "出了点问题")
        }
    }

    /** The app's icon: a picture the system decodes, or an SVG (the first-party apps' icons) drawn by [SvgIcon]. */
    fun icon(id: String): Bitmap? = runCatching {
        val bytes = Base64.decode(Replies.data(call("service:apps", "apps.icon", JSONObject().put("id", id)))?.optString("data") ?: return null, Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: SvgIcon.render(String(bytes, Charsets.UTF_8))
    }.getOrNull()

    fun surface(id: String, surface: String): Surface {
        val d = data(call("service:apps", "apps.surface", JSONObject().put("id", id).put("surface", surface)), "打不开这一页")
        return Surface.parse(d) ?: throw AshUnavailable("这一页是空的")
    }

    /** What the MCP Apps host uses for the page's tool calls: always the one app's own tools. */
    fun backend() = object : AppsBackend {
        override fun callTool(app: String, tool: String, arguments: JSONObject): JSONObject =
            Replies.toolResult(call("app:$app", tool, arguments))
    }

    companion object {
        private const val TAG = "ash.apps"
        private const val CONNECT_MS = 10_000L
        private const val OFFLINE = "连不上 Ash：打开 Ash 后再试"
        private const val UNKNOWN = "Ash 没有回复，不确定有没有做成"
        /** The same cap as the request's, in characters; a reply is bytes (UTF-8), and a page or icon is far under it. */
        private const val MAX_BODY = 256 * 1024
        private const val MAX_REPLY = 16 shl 20

        /** Ash's own screen: where the owner approves an app. */
        fun open(ctx: Context) {
            ctx.startActivity(Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }

        /** Ash with its 「应用」 tab in front: the list of all the owner's apps. */
        fun openApps(ctx: Context) {
            ctx.startActivity(HomeRoute.appsIntent(ctx))
        }
    }
}
