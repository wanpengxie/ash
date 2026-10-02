package ai.ash.host

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import ai.ash.R
import ai.ash.ui.HomeActivity
import org.json.JSONObject

/** Everything ash shows in the notification shade: service status, agent notices, owner confirmations. */
object Notifications {
    const val CH_STATUS = "ash.status"
    const val CH_MESSAGES = "ash.messages"
    const val CH_URGENT = "ash.urgent"
    const val CH_CONFIRM = "ash.confirm"
    const val ID_SERVICE = 1

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
            .addAction(Notification.Action.Builder(null, "暂停", PendingIntent.getBroadcast(
                ctx, 2, Intent(ctx, NotificationPauseReceiver::class.java).setAction(NotificationPauseReceiver.ACTION_PAUSE),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build())
            .build()

    fun updateService(ctx: Context, text: String) {
        ctx.getSystemService(NotificationManager::class.java).notify(ID_SERVICE, service(ctx, text))
    }

    private fun action(ctx: Context, id: String, choice: String, mutable: Boolean = false): PendingIntent {
        val uri = Uri.Builder().scheme("ash").authority("present-action").appendPath(id).appendPath(choice).build()
        val flags = PresentPendingIntentFlags.action(Build.VERSION.SDK_INT, mutable,
            PendingIntent.FLAG_UPDATE_CURRENT, PendingIntent.FLAG_IMMUTABLE, PendingIntent.FLAG_MUTABLE)
        return PendingIntent.getBroadcast(ctx, 0, Intent(ctx, PresentActionReceiver::class.java).setData(uri), flags)
    }

    /** Render only a persisted, validated presentation; action receivers never trust their extras for routing. */
    fun present(ctx: Context, p: JSONObject) {
        val id = p.getString("id")
        val kind = p.getString("kind")
        val text = p.optString("text")
        val channel = when (kind) { "approval" -> CH_CONFIRM; "due" -> CH_URGENT; else -> CH_MESSAGES }
        val b = builder(ctx, channel)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(p.optString("title").ifBlank { "Ash" })
            .setContentText(text)
            .setContentIntent(openApp(ctx, id.hashCode()))
            .setAutoCancel(kind != "approval")
        if (kind == "reply") {
            b.setStyle(Notification.MessagingStyle("Ash").addMessage(text, System.currentTimeMillis(), "Ash"))
            val input = RemoteInput.Builder("reply").setLabel("回复").build()
            b.addAction(Notification.Action.Builder(null, "回复", action(ctx, id, "reply", mutable = true)).addRemoteInput(input).build())
        } else b.setStyle(Notification.BigTextStyle().bigText(text))
        if (kind == "approval") {
            val options = p.getJSONArray("options")
            for (i in 0 until options.length()) {
                val option = options.getJSONObject(i)
                b.addAction(Notification.Action.Builder(null, option.getString("label"), action(ctx, id, option.getString("id"))).build())
            }
            b.setDeleteIntent(action(ctx, id, "deny"))
        } else b.setDeleteIntent(action(ctx, id, "dismiss"))
        if (Build.VERSION.SDK_INT < 26 && (kind == "approval" || kind == "due")) b.setPriority(Notification.PRIORITY_HIGH)
        ctx.getSystemService(NotificationManager::class.java).notify("present:$id", 0, b.build())
    }

    /** The conversation with Ash as one notification; an empty list removes it. */
    fun presentChat(ctx: Context, items: List<Pair<JSONObject, Long>>, alert: Boolean = true) {
        val manager = ctx.getSystemService(NotificationManager::class.java)
        if (items.isEmpty()) { manager.cancel(PresentChat.TAG, 0); return }
        val latest = items.last().first
        val id = latest.getString("id")
        val style = Notification.MessagingStyle("我")
        for ((record, at) in items) style.addMessage(record.optString("text"), at, "Ash")
        val input = RemoteInput.Builder("reply").setLabel("回复").build()
        val b = builder(ctx, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("Ash")
            .setContentText(latest.optString("text"))
            .setStyle(style)
            .setContentIntent(openApp(ctx, PresentChat.TAG.hashCode()))
            .setAutoCancel(true)
            .setOnlyAlertOnce(!alert)
            .addAction(Notification.Action.Builder(null, "回复", action(ctx, id, "reply", mutable = true)).addRemoteInput(input).build())
            .setDeleteIntent(action(ctx, id, "dismiss"))
        manager.notify(PresentChat.TAG, 0, b.build())
    }

    fun hidePresent(ctx: Context, id: String) = ctx.getSystemService(NotificationManager::class.java).cancel("present:$id", 0)

    fun presentFailure(ctx: Context, id: String) {
        val n = builder(ctx, CH_URGENT).setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle("操作未送达")
            .setContentText("通知操作未被接受，请打开 Ash 检查。")
            .setContentIntent(openApp(ctx, id.hashCode())).setAutoCancel(true).build()
        ctx.getSystemService(NotificationManager::class.java).notify("present-failed:$id", 0, n)
    }

    /** On upgrade remove old untagged notices and two-button confirmations, retaining v2 records. */
    fun clearLegacy(ctx: Context) {
        val manager = ctx.getSystemService(NotificationManager::class.java)
        for (notice in manager.activeNotifications) {
            if (notice.id == ID_SERVICE && notice.tag == null) continue
            if (notice.tag?.startsWith("present:") == true || notice.tag?.startsWith("present-failed:") == true) continue
            manager.cancel(notice.tag, notice.id)
        }
    }
}
