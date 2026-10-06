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
    const val CH_STATUS = "ash.status.v2"
    /**
     * Ash's replies, approvals and reminders all reach the owner like a messaging app's: banner, sound and vibration.
     * What should not ring (a reply while its task still runs) is posted silently on the same channel. Android fixes a
     * channel's importance and vibration once created, so these replace the earlier quieter channels.
     */
    const val CH_MESSAGES = "ash.messages.v2"
    const val CH_URGENT = "ash.urgent.v2"
    const val CH_CONFIRM = "ash.confirm.v2"
    const val CH_BROWSING = "ash.browsing"
    const val ID_SERVICE = 1
    private val RETIRED_CHANNELS = listOf("ash.messages", "ash.urgent", "ash.confirm", "ash.status")
    private const val CHAT_SHORTCUT = "ash.chat"
    private val VIBRATION = longArrayOf(0, 250, 150, 250)

    fun createChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        fun ringing(id: String, name: String) = NotificationChannel(id, name, NotificationManager.IMPORTANCE_HIGH).apply {
            enableVibration(true); vibrationPattern = VIBRATION
        }
        // Default importance, but silent: makers clear a minimum-importance service first when memory runs short.
        nm.createNotificationChannel(NotificationChannel(CH_STATUS, "Ash 运行状态", NotificationManager.IMPORTANCE_DEFAULT).apply {
            setShowBadge(false); setSound(null, null); enableVibration(false)
        })
        nm.createNotificationChannel(ringing(CH_MESSAGES, "Ash 的消息"))
        nm.createNotificationChannel(ringing(CH_URGENT, "Ash 的提醒"))
        nm.createNotificationChannel(ringing(CH_CONFIRM, "需要你确认"))
        nm.createNotificationChannel(NotificationChannel(CH_BROWSING, "Ash 正在浏览", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
        // A channel still carrying the running service's notification cannot be deleted; the next start retires it.
        for (old in RETIRED_CHANNELS) runCatching { nm.deleteNotificationChannel(old) }
    }

    /** What Android tells Ash: notifications are on and its message channel rings and vibrates (a maker's own switches aside). */
    fun ringing(ctx: Context): Boolean {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (!nm.areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT < 26) return true
        val channel = nm.getNotificationChannel(CH_MESSAGES) ?: return true
        return channel.importance >= NotificationManager.IMPORTANCE_HIGH && channel.shouldVibrate()
    }

    /** A reminder in a few seconds, as a task's result would come: time to lock the phone and feel it. */
    fun testAlert(a: android.app.Activity) {
        android.widget.Toast.makeText(a, "5 秒后发一条测试提醒：可以先锁屏或回到桌面，感觉一下有没有响铃振动", android.widget.Toast.LENGTH_LONG).show()
        val ctx = a.applicationContext
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            val n = builder(ctx, CH_URGENT).setContentTitle("测试提醒")
                .setContentText("响了、振了，就回 Ash 点「已设好」").setContentIntent(openApp(ctx, "alert-test".hashCode()))
                .setAutoCancel(true).apply { if (Build.VERSION.SDK_INT < 26) setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL) }.build()
            ctx.getSystemService(NotificationManager::class.java).notify("alert-test", 0, n)
        }, 5000)
    }

    /** Ash's colour: the ember of its mark. */
    const val COLOR = 0xFFFF7A3D.toInt()

    /** Every notice carries Ash's mark (one colour, as Android draws status icons) in Ash's colour. */
    @Suppress("DEPRECATION")
    internal fun builder(ctx: Context, channel: String): Notification.Builder =
        (if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, channel) else Notification.Builder(ctx))
            .setSmallIcon(R.drawable.ic_stat_ash).setColor(COLOR)

    /** Ash's face, shown beside what Ash says, as a messaging app shows who wrote. */
    private var faceBitmap: android.graphics.Bitmap? = null
    private fun face(ctx: Context): android.graphics.Bitmap? = faceBitmap ?: runCatching {
        ctx.assets.open("ash-island/avatars/default.webp").use { android.graphics.BitmapFactory.decodeStream(it) }
    }.getOrNull()?.let { round(it) }?.also { faceBitmap = it }
    private fun round(src: android.graphics.Bitmap): android.graphics.Bitmap {
        val size = minOf(src.width, src.height)
        val out = android.graphics.Bitmap.createBitmap(size, size, android.graphics.Bitmap.Config.ARGB_8888)
        val canvas = android.graphics.Canvas(out)
        val paint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
        canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
        paint.xfermode = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.SRC_IN)
        canvas.drawBitmap(src, ((size - src.width) / 2).toFloat(), ((size - src.height) / 2).toFloat(), paint)
        return out
    }

    private fun openApp(ctx: Context, req: Int): PendingIntent =
        PendingIntent.getActivity(ctx, req, Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    fun service(ctx: Context, text: String): Notification =
        builder(ctx, CH_STATUS)
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
        // Core names the kind ("Due", "Reply"); the owner reads who it is from and what it is.
        val title = when (kind) { "approval" -> p.optString("title").ifBlank { "需要你确认" }; "due" -> "Ash · 提醒"; else -> "Ash" }
        val b = builder(ctx, channel)
            .setContentTitle(title)
            .setLargeIcon(face(ctx))
            .setCategory(if (kind == "approval" || kind == "due") Notification.CATEGORY_REMINDER else Notification.CATEGORY_MESSAGE)
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
            val question = p.optString("human_kind") == "question"
            val custom = question && p.optBoolean("allow_custom")
            for (i in 0 until minOf(options.length(), if (custom) 2 else 3)) {
                val option = options.getJSONObject(i)
                b.addAction(Notification.Action.Builder(null, option.getString("label"), action(ctx, id, option.getString("id"))).build())
            }
            if (custom) b.addAction(Notification.Action.Builder(null, "输入回答", action(ctx, id, "custom", mutable = true))
                .addRemoteInput(RemoteInput.Builder("reply").setLabel("回答这个问题").build()).build())
            b.setDeleteIntent(action(ctx, id, if (question) "dismiss" else "deny"))
        } else b.setDeleteIntent(action(ctx, id, "dismiss"))
        if (Build.VERSION.SDK_INT < 26 && (kind == "approval" || kind == "due")) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL)
        ctx.getSystemService(NotificationManager::class.java).notify("present:$id", 0, b.build())
    }

    /** Ash as the other side of a conversation, with its face. */
    private var ash: android.app.Person? = null
    @androidx.annotation.RequiresApi(28)
    private fun ashPerson(ctx: Context): android.app.Person = ash ?: android.app.Person.Builder().setName("Ash").setKey("ash").setImportant(true)
        .apply {
            runCatching { ctx.assets.open("ash-island/avatars/default.webp").use { android.graphics.BitmapFactory.decodeStream(it) } }.getOrNull()
                ?.let { setIcon(android.graphics.drawable.Icon.createWithBitmap(it)) }
        }.build().also { ash = it }

    /** A long-lived shortcut makes the notification a conversation: it sits with the owner's chats and can be made priority. */
    private fun chatShortcut(ctx: Context): String? {
        if (Build.VERSION.SDK_INT < 30) return null
        return runCatching {
            val shortcut = android.content.pm.ShortcutInfo.Builder(ctx, CHAT_SHORTCUT).setShortLabel("Ash").setLongLived(true)
                .setPerson(ashPerson(ctx)).setIcon(ashPerson(ctx).icon ?: android.graphics.drawable.Icon.createWithResource(ctx, R.drawable.ic_launcher))
                .setIntent(Intent(ctx, HomeActivity::class.java).setAction(Intent.ACTION_VIEW)).build()
            ctx.getSystemService(android.content.pm.ShortcutManager::class.java).pushDynamicShortcut(shortcut)
            CHAT_SHORTCUT
        }.getOrNull()
    }

    /**
     * The conversation with Ash as one notification; an empty list removes it. [ring] false only updates what the shade
     * shows (a reply while its task still runs, a restart re-showing it): no sound, vibration or banner.
     */
    fun presentChat(ctx: Context, items: List<Pair<JSONObject, Long>>, ring: Boolean) {
        val manager = ctx.getSystemService(NotificationManager::class.java)
        if (items.isEmpty()) { manager.cancel(PresentChat.TAG, 0); return }
        val latest = items.last().first
        val id = latest.getString("id")
        val style = if (Build.VERSION.SDK_INT >= 28) Notification.MessagingStyle(android.app.Person.Builder().setName("我").build())
            .also { s -> for ((record, at) in items) s.addMessage(Notification.MessagingStyle.Message(record.optString("text"), at, ashPerson(ctx))) }
            else @Suppress("DEPRECATION") Notification.MessagingStyle("我").also { s -> for ((record, at) in items) s.addMessage(record.optString("text"), at, "Ash") }
        val input = RemoteInput.Builder("reply").setLabel("回复").build()
        val b = builder(ctx, CH_MESSAGES)
            .setContentTitle("Ash")
            .setContentText(latest.optString("text"))
            .setStyle(style)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setContentIntent(openApp(ctx, PresentChat.TAG.hashCode()))
            .setAutoCancel(true)
            .setOnlyAlertOnce(!ring)
            .addAction(Notification.Action.Builder(null, "回复", action(ctx, id, "reply", mutable = true)).addRemoteInput(input).build())
            .setDeleteIntent(action(ctx, id, "dismiss"))
        if (Build.VERSION.SDK_INT >= 29) chatShortcut(ctx)?.let { b.setShortcutId(it) }
        // Silent: a lone group member that leaves alerting to its (absent) summary does not alert (as NotificationCompat's setSilent).
        if (!ring) { if (Build.VERSION.SDK_INT >= 26) b.setGroup("ash.chat.quiet").setGroupAlertBehavior(Notification.GROUP_ALERT_SUMMARY) }
        else if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_HIGH).setDefaults(Notification.DEFAULT_ALL)
        // A ringing post is a fresh notification, not an update of the quiet one: some systems (ColorOS among them)
        // do not sound or vibrate for an update of a notification already shown.
        if (ring) manager.cancel(PresentChat.TAG, 0)
        manager.notify(PresentChat.TAG, 0, b.build())
    }

    /**
     * Puts the agent's browser in front of the owner (log in, enter a password, pass a check). In the Ash app it simply
     * appears; elsewhere Android does not let a background app take the screen, so it is an urgent notification that
     * takes over a locked screen and is one tap away otherwise. Returns how it was shown.
     */
    private fun browserIntent(ctx: Context, space: String, reason: String?): Intent =
        Intent(ctx, ai.ash.ui.BrowserActivity::class.java).putExtra(ai.ash.ui.BrowserActivity.EXTRA_SPACE, space)
            .apply { if (reason != null) putExtra(ai.ash.ui.BrowserActivity.EXTRA_REASON, reason) }
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    fun browserHandoff(ctx: Context, reason: String, space: String): String {
        val intent = browserIntent(ctx, space, reason)
        if (AppState.inFront) {
            android.os.Handler(android.os.Looper.getMainLooper()).post { ctx.startActivity(intent) }
            return "in_front"
        }
        val open = PendingIntent.getActivity(ctx, "browser".hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = builder(ctx, CH_URGENT)
            .setContentTitle("Ash 请你看一下浏览器").setContentText(reason).setStyle(Notification.BigTextStyle().bigText(reason))
            .setContentIntent(open).setFullScreenIntent(open, true).setCategory(Notification.CATEGORY_REMINDER)
            .setAutoCancel(true).build()
        ctx.getSystemService(NotificationManager::class.java).notify("browser-handoff", 0, n)
        return "notification"
    }

    /**
     * While the agent's browser has a page open, one quiet ongoing notice names the latest page; tapping it shows that
     * page so the owner can watch, take over or close it. Null [latest] (nothing open) removes it.
     */
    @Suppress("DEPRECATION")
    fun browsing(ctx: Context, latest: ai.ash.host.browser.BrowserSession.Info?, open: Int) {
        val manager = ctx.getSystemService(NotificationManager::class.java)
        if (latest == null) { manager.cancel("browser-browsing", 0); return }
        val page = latest.title.ifBlank { latest.site }
        val text = if (latest.title.isBlank() || latest.site.isBlank()) page else "$page · ${latest.site}"
        val tap = PendingIntent.getActivity(ctx, "browser-browsing".hashCode(), browserIntent(ctx, latest.id, null),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val b = builder(ctx, CH_BROWSING)
            .setContentTitle("Ash 正在浏览").setContentText(text.ifBlank { "打开中…" })
            .setContentIntent(tap).setOngoing(true).setOnlyAlertOnce(true).setShowWhen(false)
            .setCategory(Notification.CATEGORY_STATUS)
        if (open > 1) b.setSubText("$open 个页面")
        if (Build.VERSION.SDK_INT < 26) b.setPriority(Notification.PRIORITY_LOW)
        manager.notify("browser-browsing", 0, b.build())
    }

    fun hidePresent(ctx: Context, id: String) = ctx.getSystemService(NotificationManager::class.java).cancel("present:$id", 0)

    fun presentFailure(ctx: Context, id: String) {
        val n = builder(ctx, CH_URGENT)
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
