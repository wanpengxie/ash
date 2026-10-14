package ai.ash.link

import ai.ash.BuildConfig
import ai.ash.caps.Capabilities
import ai.ash.host.AppState
import ai.ash.host.Present
import ai.ash.host.TaskStatus
import ai.ash.human.ChatBridge
import ai.ash.human.HomeLauncher
import ai.ash.human.HumanHandlers
import ai.ash.human.Presence
import ai.ash.human.Surfaces
import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import ai.ash.caps.DeviceCalls
import ai.ash.caps.Manifest

/**
 * The app's one connection to the kernel (SPEC-05 §4): the process-wide [LinkClient], with the phone's identity, event
 * queue and capabilities behind it. Events can be queued before there is a connection; the kernel host's `attach`
 * (see [HandService]) is what starts connecting.
 */
object Link {
    private const val TAG = "ash.link"
    @Volatile private var runtime: Runtime? = null

    @Synchronized fun get(ctx: Context): Runtime = runtime ?: Runtime(ctx.applicationContext).also { runtime = it }

    /** Queues a device event (a `sense.*` word, ...) for the kernel; see [LinkClient.emit]. */
    fun emit(ctx: Context, word: String, body: JSONObject, id: String, durable: Boolean = true): Boolean =
        get(ctx).client.emit(word, body, id, durable = durable)

    /** The capabilities changed (an accessibility service came or went): the kernel is told if the manifest differs now. */
    fun manifestChanged() { runtime?.refreshSoon() }

    /** One line for the diagnostics page; says nothing of the port or the token. */
    fun describe(): String {
        val r = runtime ?: return "未启动"
        val c = r.client
        return when (c.state) {
            LinkClient.State.READY -> "已连接大脑"
            LinkClient.State.STOPPED -> "已停止（关闭码 ${c.stoppedBy ?: "-"}）"
            LinkClient.State.IDLE -> "等待大脑交接"
            else -> "连接中" + (c.lastClose?.let { "（上次关闭码 ${it.code}）" } ?: "")
        }
    }

    class Runtime(private val ctx: Context) {
        private class Endpoint(val port: Int, val token: String)
        @Volatile private var endpoint: Endpoint? = null
        @Volatile private var lastManifest = ""
        private val identity = HandIdentity(KeystoreKeyBackend())
        /** This phone as the hub knows it: pages change the phone's state through the hub with it, like Ash does. */
        val deviceId: String get() = "device:${identity.handId}"
        private val refresher = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "ash-link-manifest").apply { isDaemon = true } }
        private val calls = DeviceCalls(ctx)
        private val debugLink = DebugLocalLink(
            DebugLocalLink.enabledFor(BuildConfig.DEBUG, ctx.applicationInfo.flags),
            DebugLocalLink.dirIn(ctx.filesDir),
        )

        /** The chat page's way to the human channel of this connection (SPEC-05 §4.1). */
        val chat = ChatBridge(ChatBridge.LinkUplink { client }, HomeLauncher(ctx), log = { Log.w(TAG, it) }, trace = { Log.i("ash.chat", it) })
        private val human = Surfaces.android(ctx, chat)

        val client: LinkClient = LinkClient(
            LinkOptions(
                url = { "ws://127.0.0.1:${requireNotNull(endpoint) { "the kernel host has not attached yet" }.port}/link" },
                headers = { mapOf("Authorization" to "Bearer ${requireNotNull(endpoint).token}") },
                hand = HandInfo("phone", Capabilities.deviceName(), BuildConfig.VERSION_NAME, "android-${Build.VERSION.SDK_INT}", identity.publicKey),
                humanLabel = "手机 · 对话",
                surfaces = human.surfaces,
                sign = identity::sign,
                connector = OkHttpConnector(),
                codec = FrameCodec { name -> ctx.assets.open("link-schema/$name").use { it.readBytes().toString(Charsets.UTF_8) } },
                outbox = EventOutbox(SqliteEventStore(ctx)),
                handlers = HumanHandlers(calls, human) { open, welcome -> humanChannelChanged(open, welcome) },
                humanFrames = chat::fromKernel,
            ),
        )

        /** Where the owner is: told to the kernel as `presence`. */
        val presence = Presence(client, { AppState.homeVisible }, { ai.ash.ui.VScreenPreview.watching })

        /** The human channel opened or closed: the page is told, the kernel is told where the owner is, and what waited is sent. */
        private fun humanChannelChanged(open: Boolean, welcome: JSONObject?) {
            val grant = welcome?.optJSONObject("channels")?.optJSONObject("human")
            chat.linkChanged(open, grant?.optString("client"), grant?.optBoolean("local") ?: false)
            if (open) { presence.tell(); Present.flushAsync(ctx); ai.ash.caps.config.CheckupWatch.connected(ctx); ai.ash.ui.VScreenPreview.sync(ctx) }
            TaskStatus.refresh()
        }

        // A new process holds no token yet: whatever an earlier process left in the debug file is stale.
        init { debugLink.clear() }

        init { refresher.scheduleWithFixedDelay({ runCatching { refresh() } }, 60, 60, TimeUnit.SECONDS) }

        /** The kernel host handed over a port and a token (again): connect now. The token stays in memory, never in a log. */
        fun attach(port: Int, token: String, kernelVersion: String) {
            require(port in 1..65535) { "bad port" }
            require(token.isNotEmpty()) { "empty token" }
            Log.i(TAG, "kernel host attached (kernel $kernelVersion)")
            endpoint = Endpoint(port, token)
            debugLink.write(port, token).onFailure { Log.w(TAG, "debug link file not written: ${it.javaClass.simpleName}") }
            refresh()
            client.reconnectNow()
        }

        /** The kernel host let go of the hand (unbound): the details it gave are no longer good, so the debug file goes too. */
        fun detached() { debugLink.clear() }

        fun refreshSoon() { runCatching { refresher.execute { runCatching { refresh() } } } }

        /** Tells the client the manifest when the capabilities that work now are not the ones it holds. */
        @Synchronized private fun refresh() {
            val capabilities = Manifest.capabilities(ctx)
            val key = capabilities.joinToString("\n") { it.toString() }
            if (key == lastManifest) return
            lastManifest = key
            client.setManifest(capabilities, Manifest.events)
        }
    }
}
