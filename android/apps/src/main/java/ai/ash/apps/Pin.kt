package ai.ash.apps

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

/**
 * 「添加到桌面」. Some systems (ColorOS) drop the request until the owner lets 「Ash 应用」 create home-screen shortcuts,
 * leaving only a system note that is gone at once. So the request is watched — the launcher's accept callback, or the
 * shortcut turning up pinned — and when nothing came of it the owner is told where to allow it: once per tap, never
 * retried by itself. A launcher that asks the owner first covers the shell with its own question; if that was
 * answered with no, the owner chose it and nothing more is said.
 */
object Pin {
    /** Nothing by then, with the shell in front all along: the request went nowhere. */
    const val WAIT_MS = 4_000L
    /** After the launcher's own question (or a passing system note) is gone, its answer arrives within this. */
    const val SETTLE_MS = 1_500L
    /** The owner went elsewhere and never came back to the shell: stop watching, say nothing. */
    const val GIVE_UP_MS = 120_000L
    private const val TICK_MS = 250L
    private const val ACTION = "ai.ash.apps.PIN_ACCEPTED"

    private var current: Watch? = null

    /**
     * [asked]: the shell was paused meanwhile (the launcher put its own question in front, or the owner left);
     * [focusedFor]: how long the shell has held the window focus without a break (0 while something covers it).
     */
    fun verdict(elapsed: Long, answered: Boolean, asked: Boolean, focusedFor: Long): PinVerdict = when {
        answered -> PinVerdict.ADDED
        elapsed >= GIVE_UP_MS -> PinVerdict.GIVE_UP
        focusedFor < SETTLE_MS -> PinVerdict.WAIT
        asked -> PinVerdict.GIVE_UP
        elapsed >= WAIT_MS -> PinVerdict.NOTHING
        else -> PinVerdict.WAIT
    }

    fun request(a: Activity, id: String, name: String, icon: Bitmap?) {
        current?.stop()
        current = null
        val sm = a.getSystemService(ShortcutManager::class.java)
        if (sm == null || !runCatching { sm.isRequestPinShortcutSupported }.getOrDefault(false)) { guide(a, name); return }
        val shortcut = "app:$id"
        val info = ShortcutInfo.Builder(a, shortcut)
            .setShortLabel(name.take(24)).setLongLabel(name)
            .setIcon(icon?.let { Icon.createWithBitmap(Ui.square(it)) } ?: Icon.createWithResource(a, R.drawable.ic_launcher))
            .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse(AppIds.link(id))).setClass(a, OpenActivity::class.java))
            .build()
        // Already pinned before asking: its showing up pinned proves nothing, only the callback does.
        val before = pinned(sm, shortcut)
        val watch = Watch(a, sm, shortcut, name, before)
        val callback = PendingIntent.getBroadcast(a, shortcut.hashCode(), Intent(ACTION).setPackage(a.packageName).putExtra("token", watch.token),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        current = watch
        watch.start()  // listening before asking, so a quick answer is not missed
        val sent = runCatching { sm.requestPinShortcut(info, callback.intentSender) }
        sent.onFailure { watch.stop(); Toast.makeText(a, "添加失败：${it.message}", Toast.LENGTH_LONG).show(); return }
        if (sent.getOrDefault(false) != true) { watch.stop(); guide(a, name) }
    }

    private fun pinned(sm: ShortcutManager, id: String) = runCatching { sm.pinnedShortcuts.any { it.id == id && it.isPinned } }.getOrDefault(false)

    private class Watch(val a: Activity, val sm: ShortcutManager, val shortcut: String, val name: String, val pinnedBefore: Boolean) {
        val token = SystemClock.elapsedRealtimeNanos().toString()
        private val main = Handler(Looper.getMainLooper())
        private val started = SystemClock.uptimeMillis()
        private var focusSince: Long? = null
        private var answered = false
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
        private val tick = object : Runnable {
            override fun run() {
                if (stopped) return
                if (a.isFinishing || a.isDestroyed) { stop(); return }
                val now = SystemClock.uptimeMillis()
                focusSince = if (a.hasWindowFocus()) focusSince ?: now else null
                if (!pinnedBefore && !answered && pinned(sm, shortcut)) answered = true
                when (verdict(now - started, answered, asked, focusSince?.let { now - it } ?: 0)) {
                    PinVerdict.WAIT -> main.postDelayed(this, TICK_MS)
                    PinVerdict.ADDED, PinVerdict.GIVE_UP -> stop()
                    PinVerdict.NOTHING -> { stop(); guide(a, name) }
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

    /** The owner's way out: what to allow, and a button to the shell's own settings page where it is. */
    private fun guide(a: Activity, name: String) {
        if (a.isFinishing || a.isDestroyed) return
        AlertDialog.Builder(a)
            .setTitle("没能添加到桌面")
            .setMessage("「$name」的图标没有放到桌面上。\n\n" +
                "在 ColorOS（OPPO、一加、realme）等系统上，要先允许「Ash 应用」使用「创建桌面快捷方式」权限：" +
                "点「去设置」，进入「权限」（可能在「其他权限」里），找到「创建桌面快捷方式」，选「允许」，再回来添加一次。")
            .setPositiveButton("去设置") { _, _ -> settings(a) }
            .setNegativeButton("知道了", null)
            .show()
    }

    private fun settings(a: Activity) {
        val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${a.packageName}"))
        for (intent in listOf(details, Intent(Settings.ACTION_SETTINGS))) {
            if (runCatching { a.startActivity(intent) }.isSuccess) return
        }
        Toast.makeText(a, "打不开设置，请在系统设置的应用管理里找到「Ash 应用」", Toast.LENGTH_LONG).show()
    }
}
