package ai.ash.host

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * The resident part of the app: a foreground service that
 *   1. installs/updates the payload when the APK carries a new one,
 *   2. serves the host bridge (the phone's capabilities, notifications, Keystore),
 *   3. keeps exactly one ash core process running (restart with backoff, stop on request).
 * The UI is optional: after boot or an update nothing needs to be opened for the agent to work.
 */
class CoreService : Service() {
    @Volatile private var running = false
    private var host: HostServer? = null
    private var supervisor: Thread? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(Notifications.ID_SERVICE, Notifications.service(this, "启动中…"))
        Notifications.clearLegacy(this)
        Present.restore(this)
        running = true
        val h = HostServer(this, Secrets(this).hostToken)
        h.start(HostServer.PORT)
        host = h
        supervisor = Thread({ supervise(h.port) }, "ash-supervisor").apply { start() }
        state = "starting"
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                Secrets(this).stopped = true
                Thread { CoreProcess(this).stop() }.start()
            }
            ACTION_START -> Secrets(this).stopped = false
            ACTION_RESTART -> {
                Secrets(this).stopped = false
                Thread { CoreProcess(this).stop() }.start()
            }
            ACTION_WAKE -> {
                // An alarm for a timer: give the core CPU time for the turn it is about to run.
                val pm = getSystemService(PowerManager::class.java)
                pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ash:timer").acquire(3 * 60_000L)
            }
        }
        supervisor?.interrupt()
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        supervisor?.interrupt()
        host?.stop()
        super.onDestroy()
    }

    private fun supervise(hostPort: Int) {
        val core = CoreProcess(this)
        val paths = Paths(this)
        val secrets = Secrets(this)
        var failures = 0
        var startedAt = 0L
        var unhealthySince = 0L
        core.killLegacy()
        while (running) {
            try {
                if (!PayloadInstaller.upToDate(this, paths)) {
                    core.stop()
                    state = "installing"
                    Notifications.updateService(this, "正在安装运行环境…")
                    PayloadInstaller.install(this, paths) { done, total ->
                        installProgress = if (total > 0) done * 100 / total else -1
                        Notifications.updateService(this, "正在安装运行环境… ${if (total > 0) "${done * 100 / total}%" else done}")
                    }
                    installProgress = 100
                } else PayloadInstaller.migrate(paths)
                if (paths.legacyLink.exists()) Keys.ensure(paths)
                PayloadInstaller.cleanupLegacy(paths, Keys.present())

                val pid = core.pid()
                if (secrets.stopped) {
                    if (pid != null) {
                        core.note("stopping ash core (stop requested)")
                        core.stop()
                    }
                    state = "stopped"
                    Notifications.updateService(this, "已停止（在诊断页启动）")
                } else if (pid == null) {
                    // Crash loop protection: 5s, 10s, 20s … up to 5 minutes between attempts.
                    if (startedAt > 0 && System.currentTimeMillis() - startedAt < 60_000) failures++ else failures = 0
                    if (failures > 0) sleepQuietly(minOf(5_000L shl (failures - 1).coerceAtMost(6), 300_000L))
                    if (!running || secrets.stopped) continue
                    state = "starting"
                    Notifications.updateService(this, if (failures > 2) "Ash 反复退出，正在重试（看诊断页的日志）" else "启动中…")
                    if (startedAt > 0) core.note(if (failures > 0) "ash core exited; restarting (attempt ${failures + 1})" else "ash core is not running; starting it")
                    core.start(hostPort)
                    startedAt = System.currentTimeMillis()
                    unhealthySince = 0L
                } else if (core.startedWithProxy != core.systemProxy() && startedAt > 0) {
                    // Proxy settings are process environment: apply a change by restarting the core.
                    core.note("proxy changed (${core.startedWithProxy ?: "none"} → ${core.systemProxy() ?: "none"}); restarting ash core")
                    core.stop()
                } else if (core.portOpen()) {
                    unhealthySince = 0L
                    if (state != "running") Notifications.updateService(this, "在线")
                    state = "running"
                    Present.flushAsync(this)
                } else {
                    if (unhealthySince == 0L) unhealthySince = System.currentTimeMillis()
                    // Booting DSH takes ~30 s on a phone; only a core that stays deaf is restarted.
                    if (System.currentTimeMillis() - unhealthySince > 180_000) {
                        core.note("ash core $pid does not answer for 3 minutes; restarting it")
                        core.stop()
                    }
                }
            } catch (e: Throwable) {
                Log.e(TAG, "supervisor", e)
                state = "error: ${e.message}"
                Notifications.updateService(this, "出错：${e.message}")
                sleepQuietly(30_000)
            }
            sleepQuietly(5_000)
        }
    }

    private fun sleepQuietly(ms: Long) {
        try { Thread.sleep(ms) } catch (_: InterruptedException) {}
    }

    companion object {
        private const val TAG = "ash.service"
        const val ACTION_START = "ai.ash.START"
        const val ACTION_STOP = "ai.ash.STOP"
        const val ACTION_RESTART = "ai.ash.RESTART"
        const val ACTION_WAKE = "ai.ash.WAKE"

        /** "starting" | "installing" | "running" | "stopped" | "error: …" — for the UI. */
        @Volatile var state: String = "stopped"
        @Volatile var installProgress: Int = -1

        fun start(ctx: Context, action: String? = null) {
            val i = Intent(ctx, CoreService::class.java).setAction(action)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }
    }
}
