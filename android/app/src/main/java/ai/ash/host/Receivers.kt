package ai.ash.host

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

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
        if (Build.VERSION.SDK_INT >= 23) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, pi) else am.setExact(AlarmManager.RTC_WAKEUP, t, pi)
    }
}

class WakeReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) = CoreService.start(ctx, CoreService.ACTION_WAKE)
}

/** ✓ / ✗ on a confirmation notification → answered through ash core as the phone. */
class ConfirmReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val id = intent.getStringExtra("id") ?: return
        val approve = intent.getBooleanExtra("approve", false)
        val pending = goAsync()
        Thread {
            try {
                CoreClient(ctx).answer(id, approve)
            } catch (e: Exception) {
                Log.w("ash.confirm", "answer failed", e)
            } finally {
                Notifications.hideConfirm(ctx, id)
                pending.finish()
            }
        }.start()
    }
}
