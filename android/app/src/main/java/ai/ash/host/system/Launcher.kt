package ai.ash.host.system

import ai.ash.host.shizuku.PrivShell
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Process
import android.provider.Settings

/**
 * Starts activities for capabilities, which run in the background (CoreService). Since Android 10,
 * background activity starts are silently dropped unless an exemption applies: ash has a visible
 * window, ash's accessibility service is enabled (bound by the system), or (before Android 15)
 * ash may draw overlays. Otherwise the start goes through the privileged shell (`am start`, the
 * shell is always allowed) when Shizuku is available.
 */
object Launcher {

    /** @return a short note on how it was started (for the capability's reply). Throws when it cannot start. */
    fun start(ctx: Context, intent: Intent): String {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (canStartDirectly(ctx)) {
            ctx.startActivity(intent)
            return "started"
        }
        val via = PrivShell.channel(ctx)
        if (via != null) {
            val cmd = amStart(intent)
            val r = PrivShell.exec(ctx, cmd, 15_000, via = via)
            val out = (r.stdout + "\n" + r.stderr).trim()
            if (r.timedOut || out.contains("Error:") || out.contains("Exception")) {
                throw IllegalStateException("am start failed: ${out.ifEmpty { "exit ${r.exitCode}" }.take(600)}")
            }
            return "started (through the privileged shell)"
        }
        ctx.startActivity(intent)
        return "start requested, but Android ${Build.VERSION.RELEASE} may silently block it because ash is in the " +
            "background (enable ash's accessibility service or Shizuku to make this reliable)"
    }

    fun canStartDirectly(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < 29) return true
        if (isForeground(ctx) || accessibilityEnabled(ctx)) return true
        if (Build.VERSION.SDK_INT < 35 && try { Settings.canDrawOverlays(ctx) } catch (e: Throwable) { false }) return true
        return false
    }

    fun isForeground(ctx: Context): Boolean = try {
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        am.runningAppProcesses?.any { it.pid == Process.myPid() && it.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND } == true
    } catch (e: Throwable) { false }

    fun accessibilityEnabled(ctx: Context): Boolean = try {
        val s = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
        s.split(':').any { it.startsWith(ctx.packageName + "/") }
    } catch (e: Throwable) { false }

    /** The same intent as an `am start` command line (action, data, type, categories, component/package, string extras). */
    @Suppress("DEPRECATION")
    fun amStart(intent: Intent): String {
        val q = PrivShell::quote
        val sb = StringBuilder("am start")
        intent.action?.let { sb.append(" -a ").append(q(it)) }
        intent.data?.let { sb.append(" -d ").append(q(it.toString())) }
        intent.type?.let { sb.append(" -t ").append(q(it)) }
        intent.categories?.forEach { sb.append(" -c ").append(q(it)) }
        val comp = intent.component
        if (comp != null) sb.append(" -n ").append(q(comp.flattenToShortString()))
        else intent.`package`?.let { sb.append(" -p ").append(q(it)) }
        intent.extras?.let { b ->
            for (k in b.keySet()) {
                val v = b.get(k)
                if (v is String) sb.append(" --es ").append(q(k)).append(' ').append(q(v))
                else if (v is Boolean) sb.append(" --ez ").append(q(k)).append(' ').append(v)
                else if (v is Int) sb.append(" --ei ").append(q(k)).append(' ').append(v)
            }
        }
        sb.append(" -f ").append(intent.flags)
        return sb.toString()
    }
}
