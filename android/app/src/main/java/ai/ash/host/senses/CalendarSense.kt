package ai.ash.host.senses

import android.Manifest
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.CalendarContract
import android.util.Log
import ai.ash.host.CoreClient
import ai.ash.host.CoreService
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.Executors

/** One observer and one next reminder alarm, owned by the resident service. */
class CalendarSense(private val ctx: Context) {
    private val prefs = ctx.getSharedPreferences("sense_calendar", Context.MODE_PRIVATE)
    private val worker = Executors.newSingleThreadExecutor()
    private var observing = false
    private val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean, uri: Uri?) { refresh() }
        override fun onChange(selfChange: Boolean) { refresh() }
    }

    fun start() { refresh() }

    fun refresh() { worker.execute {
        if (ctx.checkSelfPermission(Manifest.permission.READ_CALENDAR) != PackageManager.PERMISSION_GRANTED) {
            if (observing) {
                ctx.contentResolver.unregisterContentObserver(observer)
                observing = false
            }
            cancelAlarm()
            return@execute
        }
        if (!observing) {
            try {
                ctx.contentResolver.registerContentObserver(CalendarContract.Events.CONTENT_URI, true, observer)
                observing = true
            } catch (e: SecurityException) { return@execute }
        }
        scan()
    } }

    private fun scan() {
        val now = System.currentTimeMillis()
        val rows = linkedMapOf<String, JSONObject>()
        val projection = arrayOf(
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
        )
        try {
            val uri = CalendarContract.Instances.CONTENT_URI.buildUpon()
                .appendPath(now.toString()).appendPath((now + SensePolicy.DAY_MS).toString()).build()
            ctx.contentResolver.query(uri, projection, null, null, null)?.use { cursor ->
                while (cursor.moveToNext()) {
                    val id = cursor.getLong(0).toString()
                    val title = cursor.getString(1) ?: ""
                    val start = cursor.getLong(2)
                    val end = cursor.getLong(3)
                    if (!SensePolicy.inWindow(start, end, now)) continue
                    val occurrence = "$id:$start"
                    rows[occurrence] = JSONObject().put("id", id).put("title", title).put("start", start).put("end", end)
                }
            }
        } catch (e: SecurityException) {
            cancelAlarm()
            return
        } catch (e: Exception) {
            Log.w("sense.calendar", "scan unavailable: ${e.javaClass.simpleName}")
            return
        }
        val old = runCatching { JSONObject(prefs.getString("snapshot", "{}") ?: "{}") }.getOrDefault(JSONObject())
        val first = !prefs.contains("snapshot")
        var accepted = true
        for ((key, event) in rows) {
            if (!first && old.optJSONObject(key)?.toString() != event.toString()) {
                accepted = send("changed", event, "changed:$key:${event.toString()}") && accepted
            }
        }
        if (!first) {
            val keys = old.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                if (!rows.containsKey(key)) old.optJSONObject(key)?.let { event ->
                    accepted = send("changed", event, "removed:$key:${event.toString()}") && accepted
                }
            }
        }
        if (accepted) {
            val snapshot = JSONObject()
            for ((key, event) in rows) snapshot.put(key, event)
            prefs.edit().putString("snapshot", snapshot.toString()).commit()
            val cleanup = prefs.edit()
            for (name in prefs.all.keys) {
                if (name.startsWith("reminded:") && !rows.containsKey(name.removePrefix("reminded:"))) cleanup.remove(name)
            }
            cleanup.apply()
        }
        var next: Long? = if (accepted) null else now + 60_000
        for ((key, event) in rows) {
            val start = event.getLong("start")
            val reminderKey = "reminded:$key"
            if (prefs.getLong(reminderKey, -1) == start) continue
            if (SensePolicy.due(start, now)) {
                if (send("upcoming", event, "upcoming:$key")) prefs.edit().putLong(reminderKey, start).commit()
                else next = minOf(next ?: Long.MAX_VALUE, now + 60_000)
            } else SensePolicy.reminderAt(start, now)?.let { next = minOf(next ?: Long.MAX_VALUE, it) }
        }
        schedule(next)
    }

    private fun send(kind: String, event: JSONObject, key: String): Boolean = try {
        val digest = MessageDigest.getInstance("SHA-256").digest(key.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        val preference = "pending:$digest"
        val id = prefs.getString(preference, null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString(preference, it).commit()
        }
        CoreClient(ctx).sendSense("sense.calendar", JSONObject().put("kind", kind).put("event", event), id)
        prefs.edit().remove(preference).commit()
        true
    } catch (e: Exception) {
        Log.w("sense.calendar", "delivery unavailable: ${e.javaClass.simpleName}")
        false
    }

    private fun alarm() = PendingIntent.getBroadcast(ctx, 701, Intent(ctx, CalendarAlarmReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun cancelAlarm() = ctx.getSystemService(AlarmManager::class.java).cancel(alarm())
    private fun schedule(at: Long?) {
        val manager = ctx.getSystemService(AlarmManager::class.java)
        val intent = alarm()
        if (at == null) return manager.cancel(intent)
        try {
            manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
        } catch (_: SecurityException) {
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
        }
    }

    fun stop() {
        if (observing) ctx.contentResolver.unregisterContentObserver(observer)
        observing = false
        worker.shutdown()
    }
}

class CalendarAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) = CoreService.start(ctx, CoreService.ACTION_CALENDAR_ALARM)
}
