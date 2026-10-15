package ai.ash.kernel.host

import ai.ash.kernel.AlarmPort
import ai.ash.kernel.Clock
import ai.ash.kernel.Codec
import ai.ash.kernel.HostApi
import ai.ash.kernel.HostCallbacks
import ai.ash.kernel.HostEvents
import ai.ash.kernel.Identity
import ai.ash.kernel.HostPipe
import ai.ash.kernel.KernelSupervisor
import ai.ash.kernel.Paths
import ai.ash.kernel.PowerPort
import ai.ash.kernel.Provisioner
import ai.ash.kernel.SystemClock
import ai.ash.kernel.ShellInstaller
import ai.ash.kernel.SystemEnv
import ai.ash.kernel.Updater
import ai.ash.kernel.WakeManager
import ai.ash.kernel.host.ctx.ContextFiles
import ai.ash.kernel.host.ctx.ContextProbeLauncher
import android.os.Looper
import android.os.Process
import android.util.Log
import java.io.File

/**
 * The kernel's host layer, run as the shell user (uid 2000) by `app_process` from the kernel APK, started through
 * wireless debugging. It supervises the core (install, start it with [ShellNodeLauncher] through run-as, restart it with
 * backoff, heartbeat) and serves the core's host interface over its private pipe. What its identity cannot do — the Keystore, the alarm clock,
 * writing the package storage — it asks the kernel package through [IKernelBridge]. Because the core's parent is this
 * process (outside the package's cgroup, at adbd's oom_score_adj -1000), the maker's background cleaning does not kill it.
 *
 * Started as `app_process /system/bin --nice-name=ash_kernel_host ai.ash.kernel.host.ShellHost <package> <uid>`.
 */
object ShellHost {
    private const val TAG = "ash.kernel.host"

    @JvmStatic
    fun main(args: Array<String>) {
        Looper.prepareMainLooper()
        try {
            require(Process.myUid() == Process.SHELL_UID) { "must run as the shell user, not uid ${Process.myUid()}" }
            require(args.size == 2) { "usage: ShellHost <package> <uid>" }
            run(args[0], args[1].toInt())
        } catch (t: Throwable) {
            Log.e(TAG, "cannot start", t)
            System.exit(1)
        }
        Looper.loop()
    }

    private fun run(pkg: String, kernelUid: Int) {
        val ctx = FakeContext.get()
        val userId = kernelUid / 100_000
        val bundle = ProviderClient.call("$pkg.kernelhost", userId, "bridge", null)
            ?: throw IllegalStateException("the kernel bridge is not there (is $pkg installed?)")
        val bridgeBinder = bundle.getBinder("bridge") ?: throw IllegalStateException("the kernel bridge is not usable")
        val bridge = IKernelBridge.Stub.asInterface(bridgeBinder)
            ?: throw IllegalStateException("the kernel bridge is not usable")

        val dataDir = ctx.packageManager.getApplicationInfo(pkg, 0).dataDir
        val paths = Paths(File(dataDir, "files"), File(dataDir, "cache"))
        val runDir = File("/data/local/tmp/ash-kernel-host").apply { mkdirs() }
        val sys = SystemEnv(ctx)

        val clock: Clock = SystemClock()
        lateinit var supervisor: KernelSupervisor
        val callbacks = object : HostCallbacks {
            override fun onActivity() = supervisor.onActivity()
            override fun onReady(version: String, linkPort: Int) = supervisor.onReady(version, linkPort)
            override fun onRestart(reason: String) = supervisor.onRestart(reason)
            override fun onStatus(text: String, state: String) = supervisor.onStatus(text, state)
        }
        val power = BridgePower(bridge)
        val hands = ShellHands(HAND_PACKAGE, userId).also { it.watch() }
        // The phone actions (a virtual screen, keys, launching an app) are served to the core right here, as service:host.
        val phone = ShellPhone(ctx, ShellPhone.kernelApk(ctx, pkg)) { Log.i(TAG, it) }
        // Ash's own updates: downloaded here (the shell user's directory, which `pm` can read), installed with `pm install -r`.
        val updater = Updater(File(runDir, "update"), ShellInstaller { Log.i(TAG, it) }, { Log.i(TAG, it) })
        // A one-day probe of what the owner does on the phone and what recording it costs (/data/local/tmp/ash-ctx);
        // its state is shown on the kernel page, and what it recorded is read through the host (ctx.list / ctx.read).
        val probe = ContextProbeLauncher(ShellPhone.kernelApk(ctx, pkg), { Log.i(TAG, it) }) { runCatching { bridge.reportProbe(it) } }
        val recorded = ContextFiles(ContextProbeLauncher.ROOT) { probe.state() }
        val api = HostApi(HostApi.CAPABILITIES + PHONE_CAPABILITIES + "update" + "ctx", BridgeIdentity(bridge), WakeManager(BridgeAlarm(bridge)), power, hands, callbacks, { Log.w(TAG, it) }, phone, updater, recorded)
        val pipe = HostPipe(api) { Log.i(TAG, it) }

        val version = runCatching { ctx.packageManager.getPackageInfo(pkg, 0).versionName }.getOrNull() ?: "0"
        val installedAt = runCatching { ctx.packageManager.getPackageInfo(pkg, 0).lastUpdateTime }.getOrNull() ?: 0L
        supervisor = KernelSupervisor(
            clock = clock,
            provisioner = NoProvision,
            launcher = ShellNodeLauncher(bridge, pkg, paths, sys, api, pipe, runDir, version),
            env = sys,
            stopped = { false },
            show = {
                Log.i(TAG, "status: $it")
                bridge.reportCoreStatus(it, supervisor.state == ai.ash.kernel.KernelState.RUNNING)
            },
            note = { Log.i(TAG, it) },
            // A new core knows of no virtual screen: do not leave the old one behind.
            onNodeGone = { runCatching { phone.close() } },
            powerSaver = { false },
        )

        // The kernel package stops its own core while this host lives, and tells this host about a wake or a shutdown.
        val cb = object : IHostCallback.Stub() {
            override fun wakeFired(atMs: Long) { supervisor.sendEvent(HostEvents.wakeFired(atMs)) }
            override fun shutdown(reason: String) { Thread({ supervisor.shutdown(reason, 5_000) }, "ash-host-shutdown").start() }
            override fun setProbe(on: Boolean) { probe.setPaused(!on) }
        }
        // Claim supervision first: the bridge stops the old core before acknowledging the handover.
        // A second host is refused here and exits instead of starting a second core.
        bridge.attach(cb)

        // The bridge — this host's only way to the Keystore, the alarm and host.json — belongs to the kernel package's
        // process. When that process goes (an upgrade replaces the package, or it is killed), the new kernel service
        // starts its own core; this host's core would be a second one it can no longer serve. So stop this host's core
        // (which ends its agents) and exit, leaving the one core. A later reconnect starts a fresh host.
        // When it went because the package was updated (Ash's own update.install, or an install by hand), this host starts
        // the new build's host before leaving, the way the owner's wireless debugging would: the update needs no reconnecting.
        runCatching {
            bridgeBinder.linkToDeath({
                Log.i(TAG, "the kernel package went away; stopping this host")
                runCatching { supervisor.shutdown("kernel_package_gone", 3_000) }
                runCatching { followUpdate(ctx, pkg, kernelUid, installedAt) }.onFailure { Log.w(TAG, "could not start the new build's host", it) }
                System.exit(0)
            }, 0)
        }

        Thread({
            try {
                bridge.reportCoreStatus("正在准备内核", false)
                bridge.provision()
                supervisor.run()
            } catch (t: Throwable) {
                runCatching { bridge.reportCoreStatus("启动失败：${t.message ?: t.javaClass.simpleName}", false) }
                Log.e(TAG, "cannot run core", t)
                System.exit(1)
            }
        }, "ash-kernel-host").start()
        probe.start()
        Log.i(TAG, "started for $pkg (uid $kernelUid)")
    }

    /**
     * The package was replaced by a newer build (its install time moved on): start that build's host, which takes over from
     * the kernel service's own core as any new host does. Removed, or only restarted: nothing to follow.
     */
    private fun followUpdate(ctx: android.content.Context, pkg: String, uid: Int, installedAt: Long) {
        val deadline = System.currentTimeMillis() + 60_000
        while (System.currentTimeMillis() < deadline) {
            // Gone for a moment while it is replaced, or removed: look again until the deadline.
            val info = runCatching { ctx.packageManager.getPackageInfo(pkg, 0) }.getOrNull()
            if (info == null) { Thread.sleep(1_000); continue }
            val app = info.applicationInfo
            if (info.lastUpdateTime != installedAt && app != null && app.uid == uid) {
                val apk = app.sourceDir
                val pb = ProcessBuilder(listOf("/system/bin/setsid", "/system/bin/app_process", "/system/bin", "--nice-name=ash_kernel_host",
                    ShellHost::class.java.name, pkg, uid.toString()))
                pb.environment()["CLASSPATH"] = apk
                pb.redirectInput(File("/dev/null")).redirectOutput(File("/dev/null")).redirectError(File("/dev/null")).start()
                Log.i(TAG, "$pkg was updated: started the new build's host")
                return
            }
            // A plain restart of the package's process keeps the install time: that host is started again by the owner.
            if (info.lastUpdateTime == installedAt && System.currentTimeMillis() > deadline - 50_000) return
            Thread.sleep(1_000)
        }
    }

    /** What the shell host declares on top of the base host: everything the debug identity can do for the phone. */
    private val PHONE_CAPABILITIES = listOf("vscreen", "input", "apps")
    private const val HAND_PACKAGE = "ai.ash.agent"
}

/** Installing is done once up front (bridge.provision); the supervisor needs nothing more. */
object NoProvision : Provisioner {
    override fun needsWork() = false
    override fun run(progress: (String) -> Unit) {}
}

/** The owner identity, through the bridge (the Keystore is the kernel package's). */
class BridgeIdentity(private val bridge: IKernelBridge) : Identity {
    override fun publicKey(): ByteArray = Codec.unb64u(bridge.identityKey().substringAfter(' '))
    override fun sign(data: ByteArray): ByteArray = Codec.unb64u(bridge.identitySign(Codec.b64u(data)))
}

class BridgeAlarm(private val bridge: IKernelBridge) : AlarmPort {
    override fun set(atMs: Long) = bridge.alarmSet(atMs)
    override fun cancel() = bridge.alarmCancel()
}

class BridgePower(private val bridge: IKernelBridge) : PowerPort {
    override fun hold(ms: Long, reason: String) = bridge.powerHold(ms, reason)
    override fun release() = bridge.powerRelease()
}
