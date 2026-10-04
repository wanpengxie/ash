package ai.ash.host

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import ai.ash.host.senses.CalendarSense
import ai.ash.host.senses.DeviceSense
import ai.ash.BuildConfig

/**
 * The resident part of the app: a foreground service that
 *   1. installs/updates the payload and the agent container when the APK carries new ones,
 *   2. serves the host bridge (the phone's capabilities, notifications, Keystore),
 *   3. keeps exactly one ash core process running (restart with backoff, stop on request).
 * The UI is optional: after boot or an update nothing needs to be opened for the agent to work.
 */
class CoreService : Service() {
    @Volatile private var running = false
    private var host: HostServer? = null
    private var supervisor: Thread? = null
    private var calendarSense: CalendarSense? = null
    private var deviceSense: DeviceSense? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(Notifications.ID_SERVICE, Notifications.service(this, "启动中…"))
        Notifications.clearLegacy(this)
        Present.restore(this)
        running = true
        val h = HostServer(this, Secrets(this).hostToken)
        h.start(BuildConfig.HOST_PORT)
        host = h
        calendarSense = CalendarSense(this, BuildConfig.SENSE_RESCAN_MS).also { it.start() }
        deviceSense = DeviceSense(this).also { it.start() }
        state = "starting"
        supervisor = Thread({ supervise(h.port) }, "ash-supervisor").apply { start() }
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
            ACTION_CALENDAR_ALARM, ACTION_CALENDAR_REFRESH -> calendarSense?.refresh()
            ACTION_APP_OPEN -> {
                Present.clearChat(this)
                deviceSense?.appOpen()
                calendarSense?.refresh()
            }
            ACTION_APP_LEFT -> deviceSense?.appLeft()
        }
        // APP_OPEN / APP_LEFT arrive as onboarding and HomeActivity replace one another. Interrupting
        // Process.waitFor() while the first-install tar is running leaves the UI on a transient
        // "error: null" even though the next supervisor pass recovers. Only lifecycle commands need
        // to wake the supervisor, and even those wait for an atomic installer swap to finish.
        if (shouldInterruptSupervisor(intent?.action, state)) supervisor?.interrupt()
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        supervisor?.interrupt()
        calendarSense?.stop()
        deviceSense?.stop()
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
                }
                if (ContainerInstaller.needsWork(this, paths)) {
                    core.stop()
                    state = "preparing"
                    installProgress = -1
                    Notifications.updateService(this, "正在准备 Ash 的工作环境…")
                    var shown = -1
                    ContainerInstaller.ensure(this, paths) { pct ->
                        installProgress = pct
                        if (pct >= 0 && pct / 5 != shown) {
                            shown = pct / 5
                            Notifications.updateService(this, "正在准备 Ash 的工作环境… $pct%")
                        }
                    }
                    installProgress = 100
                }

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
                    if (state != "running") {
                        deviceSense?.retryPending()
                        calendarSense?.refresh()
                    }
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
        const val ACTION_CALENDAR_ALARM = "ai.ash.CALENDAR_ALARM"
        const val ACTION_CALENDAR_REFRESH = "ai.ash.CALENDAR_REFRESH"
        const val ACTION_APP_OPEN = "ai.ash.APP_OPEN"
        const val ACTION_APP_LEFT = "ai.ash.APP_LEFT"

        /** "starting" | "installing" | "preparing" | "running" | "stopped" | "error: …" — for the UI. */
        @Volatile var state: String = "stopped"
        @Volatile var installProgress: Int = -1

        internal fun shouldInterruptSupervisor(action: String?, currentState: String): Boolean =
            action in setOf(ACTION_START, ACTION_STOP, ACTION_RESTART) &&
                currentState != "installing" && currentState != "preparing"

        fun start(ctx: Context, action: String? = null) {
            val i = Intent(ctx, CoreService::class.java).setAction(action)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }
    }
}
