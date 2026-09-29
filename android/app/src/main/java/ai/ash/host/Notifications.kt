package ai.ash.host

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import ai.ash.R
import ai.ash.ui.HomeActivity
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/** Everything ash shows in the notification shade: service status, agent notices, owner confirmations. */
object Notifications {
    const val CH_STATUS = "ash.status"
    const val CH_MESSAGES = "ash.messages"
    const val CH_URGENT = "ash.urgent"
    const val CH_CONFIRM = "ash.confirm"
    const val ID_SERVICE = 1
    private val next = AtomicInteger(1000)

    fun createChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_STATUS, "Ash 运行状态", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) })
        nm.createNotificationChannel(NotificationChannel(CH_MESSAGES, "Ash 的消息", NotificationManager.IMPORTANCE_DEFAULT))
        nm.createNotificationChannel(NotificationChannel(CH_URGENT, "Ash 的紧急提醒", NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CH_CONFIRM, "需要你确认", NotificationManager.IMPORTANCE_HIGH))
    }

    @Suppress("DEPRECATION")
    private fun builder(ctx: Context, channel: String): Notification.Builder =
        if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, channel) else Notification.Builder(ctx)

    private fun openApp(ctx: Context, req: Int): PendingIntent =
        PendingIntent.getActivity(ctx, req, Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun service(ctx: Context, text: String): Notification =
        builder(ctx, CH_STATUS)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Ash")
            .setContentText(text)
            .setOngoing(true)
            .setContentIntent(openApp(ctx, 1))
            .build()

    fun updateService(ctx: Context, text: String) {
        ctx.getSystemService(NotificationManager::class.java).notify(ID_SERVICE, service(ctx, text))
    }

    /** An agent (or ash itself) wants the owner's attention. */
    fun message(ctx: Context, title: String, text: String, urgency: String) {
        val ch = if (urgency == "high") CH_URGENT else CH_MESSAGES
        val id = next.incrementAndGet()
        val n = builder(ctx, ch)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(title.ifBlank { "Ash" })
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openApp(ctx, id))
            .apply { if (Build.VERSION.SDK_INT < 26 && urgency == "high") setPriority(Notification.PRIORITY_HIGH) }
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify(id, n)
    }

    /** A confirmation card: ✓ / ✗ right in the notification, answered through ash core. */
    fun confirm(ctx: Context, c: JSONObject) {
        val id = c.getString("id")
        val code = id.hashCode()
        fun action(approve: Boolean) = PendingIntent.getBroadcast(
            ctx, code * 2 + (if (approve) 1 else 0),
            Intent(ctx, ConfirmReceiver::class.java).putExtra("id", id).putExtra("approve", approve),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val detail = c.optString("detail")
        @Suppress("DEPRECATION")
        val n = builder(ctx, CH_CONFIRM)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("🛡️ " + c.optString("title"))
            .setContentText(detail.ifBlank { "需要你确认" })
            .setStyle(Notification.BigTextStyle().bigText(detail))
            .setContentIntent(openApp(ctx, code))
            .setAutoCancel(false)
            .setOngoing(true)
            .addAction(Notification.Action.Builder(null, "允许", action(true)).build())
            .addAction(Notification.Action.Builder(null, "拒绝", action(false)).build())
            .apply { if (Build.VERSION.SDK_INT < 26) setPriority(Notification.PRIORITY_HIGH) }
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify("confirm", code, n)
    }

    fun hideConfirm(ctx: Context, id: String) {
        ctx.getSystemService(NotificationManager::class.java).cancel("confirm", id.hashCode())
    }
}
