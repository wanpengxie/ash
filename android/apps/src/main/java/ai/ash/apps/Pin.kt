package ai.ash.apps

import ai.ash.bridge.Bridge
import android.app.Activity
import android.app.AlertDialog
import android.app.Application
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.widget.Toast

/** Where an unanswered 「添加到桌面」 request stands. */
enum class PinVerdict { WAIT, ADDED, NOTHING, GIVE_UP }

/** Who asked the launcher: the shell itself, or Ash on the shell's behalf (its shortcut, its permission). */
enum class PinLeg { SHELL, ASH }

/** After a request came to nothing: let Ash ask, or tell the owner whose 「创建桌面快捷方式」 to allow. */
enum class PinNext { ASK_ASH, GUIDE_SHELL, GUIDE_ASH }

/**
 * 「添加到桌面」. Some systems (ColorOS) drop the request until the owner lets the app create home-screen shortcuts,
 * leaving only a system note that is gone at once — and ColorOS gives 「Ash 应用」 no permission page to allow it on,
 * since the shell requests no runtime permission. So the request is watched — the launcher's accept callback, or the
 * shortcut turning up pinned — and when nothing came of it Ash, which has a permission page, asks instead (its own
 * shortcut, opening the app here). If that comes to nothing too, the owner is told where to allow it: Ash's page.
 * Once per tap, never retried by itself; after Ash's request worked once, Ash asks first. A launcher that covers the
 * screen (its own question, or ColorOS's permission note) is waited for; a deliberate no can't be told apart from the
 * permission block, so the note says both.
 */
object Pin {
    /** Nothing by then, with the shell in front all along: the request went nowhere. */
    const val WAIT_MS = 4_000L
    /** After the launcher's own question (or a passing system note) is gone, its answer arrives within this. */
    const val SETTLE_MS = 1_500L
    /** The owner went elsewhere and never came back to the shell: stop watching, say nothing. */
    const val GIVE_UP_MS = 120_000L
    private const val TICK_MS = 250L
    private const val PROBE_MS = 1_000L
    private const val ACTION = "ai.ash.apps.PIN_ACCEPTED"
    private const val PREFS = "pin"
    private const val VIA_ASH = "via_ash"

    private var current: Watch? = null
    private val main by lazy { Handler(Looper.getMainLooper()) }

    /**
     * [asked]: the shell was paused meanwhile (the launcher put its own question in front, or the owner left);
     * [focusedFor]: how long the shell has held the window focus without a break (0 while something covers it).
     */
    fun verdict(elapsed: Long, answered: Boolean, asked: Boolean, focusedFor: Long): PinVerdict = when {
        answered -> PinVerdict.ADDED
        elapsed >= GIVE_UP_MS -> PinVerdict.GIVE_UP
        focusedFor < SETTLE_MS -> PinVerdict.WAIT
        // ColorOS covers the shell with the launcher's page while it shows its permission note, then hands back with
        // nothing added: that looks exactly like a launcher question answered no, so either way the owner is told.
        elapsed >= WAIT_MS -> PinVerdict.NOTHING
        else -> PinVerdict.WAIT
    }

    /** The shell's own request came to nothing (or could not be made): Ash asks, once; Ash's came to nothing: say so. */
    fun afterNothing(leg: PinLeg, ashInstalled: Boolean): PinNext = when {
        leg == PinLeg.ASH -> PinNext.GUIDE_ASH
        ashInstalled -> PinNext.ASK_ASH
        else -> PinNext.GUIDE_SHELL
    }

    /** Ash's answer to its request: null when the launcher was asked (watch it); otherwise what to tell the owner. */
    fun afterAshAnswer(code: Int): PinNext? = when (code) {
        Bridge.PIN_ASKED -> null
        // An Ash too old to ask, or not reachable: only the shell's own permission is left to point at.
        0 -> PinNext.GUIDE_SHELL
        else -> PinNext.GUIDE_ASH
    }

    /** Which leg asks first: Ash, once its request has worked here (the shell's own goes nowhere on this phone). */
    fun firstLeg(viaAsh: Boolean, ashInstalled: Boolean): PinLeg = if (viaAsh && ashInstalled) PinLeg.ASH else PinLeg.SHELL

    fun request(a: Activity, id: String, name: String, icon: Bitmap?) {
        current?.stop()
        current = null
        val viaAsh = a.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(VIA_ASH, false)
        if (firstLeg(viaAsh, Ash.installed(a)) == PinLeg.ASH) askAsh(a, id, name, icon) else askShell(a, id, name, icon)
    }

    private fun next(a: Activity, leg: PinLeg, id: String, name: String, icon: Bitmap?) =
        follow(a, afterNothing(leg, Ash.installed(a)), id, name, icon)

    private fun follow(a: Activity, step: PinNext, id: String, name: String, icon: Bitmap?) {
        when (step) {
            PinNext.ASK_ASH -> askAsh(a, id, name, icon)
            PinNext.GUIDE_SHELL -> guide(a, name, ash = false)
            PinNext.GUIDE_ASH -> guide(a, name, ash = true)
        }
    }

    private fun remember(a: Activity, leg: PinLeg) =
        a.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(VIA_ASH, leg == PinLeg.ASH).apply()

    private fun askShell(a: Activity, id: String, name: String, icon: Bitmap?) {
        val sm = a.getSystemService(ShortcutManager::class.java)
        if (sm == null || !runCatching { sm.isRequestPinShortcutSupported }.getOrDefault(false)) { next(a, PinLeg.SHELL, id, name, icon); return }
        val shortcut = "app:$id"
        val info = ShortcutInfo.Builder(a, shortcut)
            .setShortLabel(name.take(24)).setLongLabel(name)
            .setIcon(icon?.let { Icon.createWithBitmap(Ui.square(it)) } ?: Icon.createWithResource(a, R.drawable.ic_launcher))
            .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse(AppIds.link(id))).setClass(a, OpenActivity::class.java))
            .build()
        // Already pinned before asking: its showing up pinned proves nothing, only the callback does.
        val watch = Watch(a, PinLeg.SHELL, id, name, icon) { runCatching { sm.pinnedShortcuts.any { it.id == shortcut && it.isPinned } }.getOrDefault(false) }
        watch.pinnedBefore = watch.pinned()
        current = watch
        watch.start()  // listening before asking, so a quick answer is not missed
        val sent = runCatching { sm.requestPinShortcut(info, watch.callback.intentSender) }
        // Refused outright (an exception, or false): Ash may still be able to ask.
        if (sent.getOrDefault(false) != true) { watch.stop(); next(a, PinLeg.SHELL, id, name, icon) }
    }

    /** Ash asks the launcher for its own shortcut to this app (through IAppsHost), off the main thread. */
    private fun askAsh(a: Activity, id: String, name: String, icon: Bitmap?) {
        val app = a.applicationContext
        // Ash checks pinned state on its side: answered by the callback, or by asking Ash now and then.
        val watch = Watch(a, PinLeg.ASH, id, name, icon) { Ash.pinned(app, id) }
        current = watch
        watch.start()
        val small = icon?.let { Ui.square(it, 192) }
        Thread({
            watch.pinnedBefore = Ash.pinned(app, id)
            val code = try { Ash.requestPin(app, id, name, small, watch.callback.intentSender) } catch (e: AshUnavailable) { 0 }
            main.post {
                val step = afterAshAnswer(code) ?: return@post
                watch.stop()
                follow(a, step, id, name, icon)
            }
        }, "apps-pin").start()
    }

    private class Watch(val a: Activity, val leg: PinLeg, val id: String, val name: String, val icon: Bitmap?, val probe: () -> Boolean) {
        val token = SystemClock.elapsedRealtimeNanos().toString()
        val callback: PendingIntent = PendingIntent.getBroadcast(a, "app:$id".hashCode() + leg.ordinal,
            Intent(ACTION).setPackage(a.packageName).putExtra("token", token), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        /** Until known, a pinned shortcut proves nothing. */
        @Volatile var pinnedBefore = true
        @Volatile private var pinnedNow = false
        @Volatile private var probing = false
        private var lastProbe = 0L
        private val started = SystemClock.uptimeMillis()
        private var focusSince: Long? = null
        @Volatile private var answered = false
        private var asked = false
        private var stopped = false
        private val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, i: Intent) { if (i.getStringExtra("token") == token) answered = true }
        }
        private val lifecycle = object : Application.ActivityLifecycleCallbacks {
            override fun onActivityPaused(x: Activity) { if (x === a) asked = true }
            override fun onActivityCreated(x: Activity, s: Bundle?) {}
            override fun onActivityStarted(x: Activity) {}
            override fun onActivityResumed(x: Activity) {}
            override fun onActivityStopped(x: Activity) {}
            override fun onActivitySaveInstanceState(x: Activity, s: Bundle) {}
            override fun onActivityDestroyed(x: Activity) {}
        }

        fun pinned(): Boolean = probe()

        /** Whether the shortcut shows up pinned, checked off the main thread (Ash's answer crosses a binder). */
        private fun probeSoon(now: Long) {
            if (probing || now - lastProbe < PROBE_MS) return
            probing = true; lastProbe = now
            Thread({ pinnedNow = runCatching { probe() }.getOrDefault(false); probing = false }, "apps-pin-probe").start()
        }

        private val tick = object : Runnable {
            override fun run() {
                if (stopped) return
                if (a.isFinishing || a.isDestroyed) { stop(); return }
                val now = SystemClock.uptimeMillis()
                focusSince = if (a.hasWindowFocus()) focusSince ?: now else null
                probeSoon(now)
                if (!pinnedBefore && !answered && pinnedNow) answered = true
                when (verdict(now - started, answered, asked, focusSince?.let { now - it } ?: 0)) {
                    PinVerdict.WAIT -> main.postDelayed(this, TICK_MS)
                    PinVerdict.ADDED -> { stop(); remember(a, leg) }
                    PinVerdict.GIVE_UP -> stop()
                    PinVerdict.NOTHING -> { stop(); next(a, leg, id, name, icon) }
                }
            }
        }

        fun start() {
            val filter = IntentFilter(ACTION)
            if (Build.VERSION.SDK_INT >= 33) a.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            else a.registerReceiver(receiver, filter)
            a.application.registerActivityLifecycleCallbacks(lifecycle)
            main.postDelayed(tick, TICK_MS)
        }

        fun stop() {
            if (stopped) return
            stopped = true
            main.removeCallbacks(tick)
            runCatching { a.unregisterReceiver(receiver) }
            a.application.unregisterActivityLifecycleCallbacks(lifecycle)
            if (current === this) current = null
        }
    }

    /** The owner's way out: what to allow, and a button to that app's settings page (the shell's, or Ash's). */
    private fun guide(a: Activity, name: String, ash: Boolean) {
        if (a.isFinishing || a.isDestroyed) return
        val message = if (ash) "「$name」的图标没有放到桌面上。如果是你刚才点了取消，忽略这条就好。\n\n" +
            "「Ash 应用」在这台手机上申请不到「创建桌面快捷方式」，所以改由 Ash 来放图标。要先允许 Ash 使用这个权限：" +
            "点「去设置」，进入 Ash 的「权限」（可能在「其他权限」里），找到「创建桌面快捷方式」，选「允许」，再回来添加一次。"
        else "「$name」的图标没有放到桌面上。如果是你刚才点了取消，忽略这条就好。\n\n" +
            "在 ColorOS（OPPO、一加、realme）等系统上，要先允许「Ash 应用」使用「创建桌面快捷方式」权限：" +
            "点「去设置」，进入「权限」（可能在「其他权限」里），找到「创建桌面快捷方式」，选「允许」，再回来添加一次。"
        AlertDialog.Builder(a)
            .setTitle("没能添加到桌面")
            .setMessage(message)
            .setPositiveButton("去设置") { _, _ -> settings(a, if (ash) Bridge.ASH_PACKAGE else a.packageName, if (ash) "Ash" else "Ash 应用") }
            .setNegativeButton("知道了", null)
            .show()
    }

    private fun settings(a: Activity, pkg: String, label: String) {
        val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg"))
        for (intent in listOf(details, Intent(Settings.ACTION_SETTINGS))) {
            if (runCatching { a.startActivity(intent) }.isSuccess) return
        }
        Toast.makeText(a, "打不开设置，请在系统设置的应用管理里找到「$label」", Toast.LENGTH_LONG).show()
    }
}
