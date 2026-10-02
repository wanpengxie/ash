package ai.ash.host

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import org.json.JSONObject
import java.util.UUID

/** Starts ash after boot and after an app update (not after force-stop: Android sends nothing then). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        Log.i("ash.boot", "${intent.action}: starting ash")
        CoreService.start(ctx)
    }
}

/** ash core's next timer: the alarm brings the service (and so the core) back even from doze or a kill. */
object Wake {
    fun schedule(ctx: Context, at: Long?) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val pi = PendingIntent.getBroadcast(ctx, 7, Intent(ctx, WakeReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        if (at == null) return am.cancel(pi)
        // A few seconds early: the core must be up when its timer fires, and it fires timers itself.
        val t = maxOf(System.currentTimeMillis() + 1000, at - 5_000)
        try {
            if (Build.VERSION.SDK_INT >= 23) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, pi)
            else am.setExact(AlarmManager.RTC_WAKEUP, t, pi)
        } catch (_: SecurityException) {
            // Exact-alarm permission is optional; the durable Core timer remains the source of truth.
            if (Build.VERSION.SDK_INT >= 23) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, pi)
            else am.set(AlarmManager.RTC_WAKEUP, t, pi)
        }
    }
}

class WakeReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) = CoreService.start(ctx, CoreService.ACTION_WAKE)
}

/** The status notification pauses through the same durable Core command as Settings. It never resumes. */
class NotificationPauseReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != ACTION_PAUSE) return
        val pending = goAsync()
        Thread {
            try {
                val result = CoreClient(ctx.applicationContext).sendPresentAction(JSONObject()
                    .put("to", "service:admin").put("kind", "request").put("word", "pause")
                    .put("body", JSONObject()).put("client_id", UUID.randomUUID().toString()).put("wait", true))
                val accepted = result.optString("id")
                val reply = result.optJSONObject("reply")
                if (accepted.isBlank() || reply?.optString("reply_to") != accepted ||
                    reply.optString("from") != "service:admin" || reply.optString("word") != "pause" ||
                    reply.optJSONObject("body")?.optJSONObject("result")?.optBoolean("paused") != true)
                    Notifications.presentFailure(ctx.applicationContext, "status-pause")
            } catch (e: Exception) {
                Log.w("ash.pause", "notification pause was not confirmed", e)
                Notifications.presentFailure(ctx.applicationContext, "status-pause")
            } finally { pending.finish() }
        }.start()
    }

    companion object { const val ACTION_PAUSE = "ai.ash.NOTIFICATION_PAUSE" }
}

/**
 * Start/stop/restart from tooling: `adb shell am broadcast -n ai.ash.agent/ai.ash.host.ControlReceiver -a ai.ash.STOP`.
 * Guarded by android.permission.DUMP, which only the shell and the system hold — other apps cannot use it.
 */
class ControlReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
            CoreService.ACTION_START, CoreService.ACTION_STOP, CoreService.ACTION_RESTART -> CoreService.start(ctx, intent.action)
        }
    }
}
