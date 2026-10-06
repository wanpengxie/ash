package ai.ash.host.senses

import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import ai.ash.host.CoreClient
import org.json.JSONObject
import java.util.UUID

/** Optional live-only sensor. It never queries already-active notifications or stores their content. */
class NotificationSense : NotificationListenerService() {
    private companion object {
        const val REVIVE_GAP_MS = 60_000L
        @Volatile var lastRevive = 0L
    }
    private val serial = SenseSerial()
    @Volatile private var connected = false

    // The system keeps this listener bound and binds it again after the process dies, so each connection (and, at
    // most once a minute, each notification) is a chance to bring the core back. Reading stays behind the opt-in.
    override fun onListenerConnected() { connected = true; revive() }
    override fun onListenerDisconnected() { connected = false }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        revive()
        if (sbn == null || sbn.packageName == packageName || !connected || !NotificationSenseSettings.allowed(this)) return
        serial.submit {
            // Revocation or an opt-out can race a queued callback. Recheck before inspecting extras.
            if (!connected || !NotificationSenseSettings.allowed(this)) return@submit
            try {
                val extras = sbn.notification.extras
                val item = NotificationSensePolicy.item(
                    sbn.packageName,
                    extras.getCharSequence(Notification.EXTRA_TITLE),
                    extras.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: extras.getCharSequence(Notification.EXTRA_TEXT),
                    packageName,
                    NotificationSenseSettings.enabled(this),
                    NotificationSenseSettings.granted(this),
                ) ?: return@submit
                // No durable queue: revocation must not release old notification content later.
                if (!connected || !NotificationSenseSettings.allowed(this)) return@submit
                CoreClient(this).sendSense(
                    "sense.notification",
                    JSONObject().put("app", item.app).put("title", item.title).put("text", item.text),
                    UUID.randomUUID().toString(),
                )
            } catch (e: Exception) {
                Log.w("sense.notification", "delivery unavailable: ${e.javaClass.simpleName}")
            }
        }
    }

    private fun revive() {
        val now = android.os.SystemClock.elapsedRealtime()
        if (lastRevive != 0L && now - lastRevive < REVIVE_GAP_MS) return
        lastRevive = now
        runCatching { ai.ash.host.CoreService.start(this) }
            .onFailure { Log.w("sense.notification", "revive failed: ${it.javaClass.simpleName}") }
    }

    override fun onDestroy() {
        connected = false
        serial.close()
        super.onDestroy()
    }
}

/** The app opt-in is separate from Android's special listener access; both are required. */
object NotificationSenseSettings {
    private const val PREFS = "sense_notification"
    private const val ENABLED = "enabled"

    fun enabled(ctx: Context): Boolean = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .getBoolean(ENABLED, false)

    fun setEnabled(ctx: Context, value: Boolean): Boolean = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        .edit().putBoolean(ENABLED, value).commit()

    fun granted(ctx: Context): Boolean = try {
        val component = ComponentName(ctx, NotificationSense::class.java)
        if (Build.VERSION.SDK_INT >= 27) {
            ctx.getSystemService(NotificationManager::class.java).isNotificationListenerAccessGranted(component)
        } else {
            Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners")
                ?.split(':')?.any { ComponentName.unflattenFromString(it) == component } == true
        }
    } catch (_: Exception) { false }

    fun allowed(ctx: Context): Boolean = enabled(ctx) && granted(ctx)

    fun accessIntent(ctx: Context): Intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).apply {
        putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
            ComponentName(ctx, NotificationSense::class.java).flattenToString())
    }
}
