package ai.ash.kernel.host

import ai.ash.kernel.AndroidAlarms
import ai.ash.kernel.AndroidPower
import ai.ash.kernel.AndroidProvisioner
import ai.ash.kernel.Codec
import ai.ash.kernel.Keys
import ai.ash.kernel.Paths
import android.content.Context
import android.os.Binder
import android.os.IBinder
import android.os.Parcel
import android.util.Log
import java.io.File

/**
 * The kernel package's own identity, as the shell host reaches it ([IKernelBridge]). It runs in the kernel package's app
 * process (so it holds the Keystore, the alarm clock and write access to the package's private storage); the shell host
 * (uid 2000) runs everything else and calls here only for what its identity cannot do. Every call is refused unless it
 * comes from the shell or the system.
 */
class KernelBridge(ctx: Context) : IKernelBridge.Stub() {
    private val app = ctx.applicationContext
    private val paths = Paths(app)
    private val alarms = AndroidAlarms(app)
    private val power = AndroidPower.get(app)

    override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
        val uid = Binder.getCallingUid()
        if (code in FIRST_CALL_TRANSACTION..LAST_CALL_TRANSACTION && uid != android.os.Process.SHELL_UID && uid != 0) {
            throw SecurityException("only the phone's shell may use the kernel bridge")
        }
        return super.onTransact(code, data, reply, flags)
    }

    override fun provision() {
        val p = AndroidProvisioner(app, paths)
        if (p.needsWork()) p.run { Log.i(TAG, "provision: $it") }
    }

    override fun writeHostSpec(json: String) {
        val target = paths.hostSpec
        target.parentFile?.mkdirs()
        val tmp = File(target.path + ".tmp")
        tmp.delete(); tmp.createNewFile()
        tmp.setReadable(false, false); tmp.setReadable(true, true); tmp.setWritable(true, true)
        tmp.writeText(json)
        if (!tmp.renameTo(target)) throw IllegalStateException("cannot write host.json")
    }

    override fun sealKey(): String {
        val raw = Keys.vaultSealKey(paths.vaultKey)
        try { return Codec.b64u(raw) } finally { raw.fill(0) }
    }

    override fun identityKey(): String {
        val spki = Keys.publicKey()
        return Codec.keyId(spki) + " " + Codec.b64u(spki)
    }

    override fun identitySign(dataB64u: String): String = Codec.b64u(Keys.sign(Codec.unb64u(dataB64u)))

    override fun alarmSet(atMs: Long) = alarms.set(atMs)
    override fun alarmCancel() = alarms.cancel()
    override fun powerHold(ms: Long, reason: String) = power.hold(ms, reason)
    override fun powerRelease() = power.release()

    override fun attach(cb: IHostCallback): String {
        HostPresence.take(app, cb)
        return runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: "0"
    }

    override fun reportCoreStatus(text: String, ready: Boolean) {
        if (HostPresence.yielded) {
            HostPresence.report(text, ready)
            ai.ash.kernel.KernelService.publishHostStatus(app, text)
        }
    }

    override fun reportProbe(text: String) { if (HostPresence.yielded) HostPresence.probe = text }

    companion object {
        private const val TAG = "ash.kernel.bridge"

        @Volatile private var instance: KernelBridge? = null
        fun get(ctx: Context): KernelBridge = instance ?: synchronized(this) {
            instance ?: KernelBridge(ctx).also { instance = it }
        }
    }
}

/**
 * Whether a shell host is in charge of the core now. While it is, [ai.ash.kernel.KernelService] yields: it does not run a
 * core of its own, so there is only ever one. The shell host's callback also carries a wake or a shutdown to the core.
 */
object HostPresence {
    @Volatile private var callback: IHostCallback? = null
    @Volatile private var onChange: (() -> Unit)? = null

    val yielded: Boolean get() = callback?.asBinder()?.isBinderAlive == true
    @Volatile var coreReady = false
        private set
    @Volatile var status = "正在启动"
        private set
    /** The context probe's state as the host last reported it. */
    @Volatile var probe = ""

    internal fun report(text: String, ready: Boolean) { status = text; coreReady = ready }

    /** The kernel service registers what to run when the host comes or goes (it re-evaluates whether to run the core). */
    fun watch(onChange: () -> Unit) { this.onChange = onChange }

    @Synchronized internal fun take(ctx: Context, cb: IHostCallback) {
        check(!yielded) { "a shell host is already supervising the core" }
        coreReady = false
        status = "正在启动"
        callback = cb
        try { cb.asBinder().linkToDeath({ gone(ctx, cb) }, 0) } catch (e: Exception) { callback = null; throw e }
        onChange?.invoke()
        KernelPairing.cancel(ctx)
    }

    @Synchronized private fun gone(ctx: Context, cb: IHostCallback) {
        if (callback?.asBinder() != cb.asBinder()) return
        callback = null
        // Not one the kernel asked for (shutdown): the system took it away, so the owner is told at once.
        if (!asked) runCatching { KernelPairing.hostLost(ctx) }
        asked = false
        coreReady = false
        status = "宿主未连接"
        probe = ""
        onChange?.invoke()
        // The host went away (its service stopped or wireless debugging was revoked): the kernel service takes over.
        runCatching { ai.ash.kernel.KernelService.start(ctx) }
    }

    fun wakeFired(atMs: Long) = runCatching { callback?.wakeFired(atMs) }
    fun setProbe(on: Boolean) = runCatching { callback?.setProbe(on) }
    /** The kernel asked the host to stop: its going is not a loss. */
    @Volatile private var asked = false
    fun shutdown(reason: String) = runCatching { asked = true; callback?.shutdown(reason) }
}
