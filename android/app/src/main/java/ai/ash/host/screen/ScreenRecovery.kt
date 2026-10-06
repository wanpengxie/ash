package ai.ash.host.screen

import ai.ash.bridge.Bridge
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Brings the screen helper's accessibility service back after the system stopped the helper (a maker's background
 * cleaning does): the switch stays on in settings, but Android does not start the service again by itself.
 *
 * It needs WRITE_SECURE_SETTINGS, which Android grants whole (any secure or global setting) and only over USB or
 * Shizuku. Ash keeps it to this one use: in this file, the only place Ash writes a secure setting itself, it takes the
 * helper's own entry out of the enabled services and puts it back, and only while that entry is still there (the owner
 * left the switch on). The agent has no way to reach it; settings.put writes secure settings only through Shizuku,
 * with the owner's approval each time. Every recovery is recorded; the owner can turn it off.
 */
object ScreenRecovery {
    private const val TAG = "ash.screen"
    private const val PREFS = "ash.screen.recovery"
    private const val CHECK_MS = 15_000L
    /** A reconnecting service is not a stopped one: wait this long before acting. */
    private const val DOWN_MS = 20_000L
    /** At most once per this long, so a helper that keeps failing is not toggled in a loop. */
    private const val GAP_MS = 120_000L
    private val main = Handler(Looper.getMainLooper())
    private var app: Context? = null
    private var downSince = 0L
    private var started = false

    fun granted(ctx: Context) = ctx.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED
    fun enabled(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", true)
    fun setEnabled(ctx: Context, on: Boolean) { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", on).apply() }
    /** When Ash brought the service back, newest last (at most 20). */
    fun history(ctx: Context): List<Long> = runCatching {
        val a = JSONArray(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("history", "[]")); (0 until a.length()).map { a.getLong(it) }
    }.getOrDefault(emptyList())

    /** The adb command that grants it, for a phone without Shizuku. */
    fun grantCommand(ctx: Context) = "adb shell pm grant ${ctx.packageName} ${Manifest.permission.WRITE_SECURE_SETTINGS}"

    fun start(ctx: Context) {
        if (started) return
        started = true; app = ctx.applicationContext
        main.postDelayed(::check, CHECK_MS)
    }

    private fun check() {
        val ctx = app ?: return
        main.postDelayed(::check, CHECK_MS)
        val down = ScreenBridge.trusted(ctx) && ScreenBridge.switchedOn(ctx) && !ScreenBridge.accessibility()
        val now = System.currentTimeMillis()
        if (!down) { downSince = 0; return }
        if (downSince == 0L) { downSince = now; return }
        if (now - downSince < DOWN_MS || !enabled(ctx) || !granted(ctx)) return
        if (now - (history(ctx).lastOrNull() ?: 0L) < GAP_MS) return
        Thread({ recover(ctx) }, "ash-screen-recovery").start()
    }

    private fun recover(ctx: Context) {
        val resolver = ctx.contentResolver
        val key = Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        val services = Settings.Secure.getString(resolver, key).orEmpty()
        // The owner turned the switch off since the check: leave it off.
        if (Services.helpers(services).isEmpty()) return
        try {
            Settings.Secure.putString(resolver, key, Services.withoutHelper(services))
            Thread.sleep(800)
            Settings.Secure.putString(resolver, key, Services.withHelperBack(Settings.Secure.getString(resolver, key).orEmpty(), services))
            Settings.Secure.putInt(resolver, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
        } catch (e: SecurityException) { Log.w(TAG, "accessibility recovery not permitted", e); return }
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val list = (history(ctx) + System.currentTimeMillis()).takeLast(20)
        prefs.edit().putString("history", JSONArray(list).toString()).apply()
        Log.i(TAG, "brought the screen helper's accessibility service back")
        downSince = 0
        main.postDelayed({ ScreenBridge.rebind() }, 1500)
    }

    /**
     * The enabled-services list (`pkg/service:pkg/service`) as recovery may change it: only the screen helper's own
     * entries are taken out and put back; every other app's entry stays exactly as it was.
     */
    internal object Services {
        private fun entries(list: String) = list.split(':').filter { it.isNotBlank() }
        fun helpers(list: String) = entries(list).filter { it.startsWith("${Bridge.SCREEN_PACKAGE}/") }
        fun withoutHelper(list: String) = (entries(list) - helpers(list).toSet()).joinToString(":")
        /** [now] with the helper's entries from [before] back at its end; nothing is added unless it was there before. */
        fun withHelperBack(now: String, before: String) = (entries(now) + helpers(before)).distinct().joinToString(":")
    }

    /** For the diagnostics page. */
    fun summary(ctx: Context): JSONObject = JSONObject().put("granted", granted(ctx)).put("enabled", enabled(ctx)).put("history", JSONArray(history(ctx)))
}
