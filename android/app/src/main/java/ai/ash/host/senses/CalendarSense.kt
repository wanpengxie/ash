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

/** One observer and one next reminder alarm, owned by the resident service. */
class CalendarSense(private val ctx: Context, private val rescanIntervalMs: Long = SensePolicy.RESCAN_INTERVAL_MS) {
    private val prefs = ctx.getSharedPreferences("sense_calendar", Context.MODE_PRIVATE)
    private val serial = SenseSerial()
    private val outbox = SenseOutbox(object : SenseOutbox.Store {
        override fun get(key: String): String? = prefs.getString(key, null)
        override fun keys(): Set<String> = prefs.all.keys
        override fun commit(puts: Map<String, String>, removes: Set<String>): Boolean {
            val edit = prefs.edit()
            for ((key, value) in puts) edit.putString(key, value)
            for (key in removes) edit.remove(key)
            return edit.commit()
        }
    })
    private var observing = false
    private val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
        override fun onChange(selfChange: Boolean, uri: Uri?) { refresh() }
        override fun onChange(selfChange: Boolean) { refresh() }
    }

    fun start() { refresh() }

    fun refresh() {
        serial.submit {
        if (ctx.checkSelfPermission(Manifest.permission.READ_CALENDAR) != PackageManager.PERMISSION_GRANTED) {
            if (observing) {
                ctx.contentResolver.unregisterContentObserver(observer)
                observing = false
            }
            cancelAlarm()
            return@submit
        }
        if (!observing) {
            try {
                ctx.contentResolver.registerContentObserver(CalendarContract.Events.CONTENT_URI, true, observer)
                observing = true
            } catch (e: SecurityException) { cancelAlarm(); return@submit }
            catch (e: Exception) {
                Log.w("sense.calendar", "observer unavailable: ${e.javaClass.simpleName}")
                schedule(System.currentTimeMillis() + 60_000)
                return@submit
            }
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
            val cursor = ctx.contentResolver.query(uri, projection, null, null, null)
            if (cursor == null) {
                schedule(now + 60_000)
                return
            }
            cursor.use {
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
            schedule(now + 60_000)
            return
        }
        val old = runCatching { JSONObject(prefs.getString("snapshot", "{}") ?: "{}") }.getOrDefault(JSONObject())
        val first = !prefs.contains("snapshot")
        val oldRows = linkedMapOf<String, String>()
        val oldKeys = old.keys()
        while (oldKeys.hasNext()) {
            val key = oldKeys.next()
            old.optJSONObject(key)?.let { oldRows[key] = it.toString() }
        }
        val currentRows = rows.mapValues { it.value.toString() }
        var accepted = true
        if (!first) {
            val unresolved = mutableSetOf<String>()
            val attempts = CalendarDelivery.attempts(prefs.all)
            val malformed = prefs.all.keys.filter { it.startsWith("attempt:") }
                .filterNot { key -> attempts.any { CalendarDelivery.attemptKey(it.occurrence) == key } }
            if (malformed.isNotEmpty()) {
                accepted = false
                unresolved += malformed.map { it.removePrefix("attempt:") }
            }
            for (attempt in attempts) {
                val event = runCatching { JSONObject(attempt.event) }.getOrNull()
                if (event == null || !sendAttempt(attempt, event, reserve = false)) {
                    unresolved += attempt.occurrence
                    accepted = false
                }
            }
            for (change in CalendarDelivery.diff(oldRows, CalendarDelivery.journal(prefs.all), currentRows)) {
                if (change.occurrence in unresolved) continue
                val event = runCatching { JSONObject(change.current ?: change.previous ?: "") }.getOrNull()
                if (event == null) { accepted = false; continue }
                val version = change.current ?: CalendarDelivery.ABSENT
                val generation = CalendarDelivery.nextGeneration(prefs.all, change.occurrence)
                val attempt = CalendarDelivery.Attempt(change.occurrence, event.toString(), version, generation)
                accepted = sendAttempt(attempt, event, reserve = true) && accepted
            }
        }
        if (accepted) {
            val snapshot = JSONObject()
            for ((key, event) in rows) snapshot.put(key, event)
            val edit = prefs.edit().putString("snapshot", snapshot.toString())
            for (name in outbox.completedKeys("changed")) edit.remove(name)
            for (name in CalendarDelivery.completedKeys(prefs.all)) edit.remove(name)
            for (name in prefs.all.keys) {
                if (name.startsWith("reminded:") && !rows.containsKey(name.removePrefix("reminded:"))) edit.remove(name)
            }
            accepted = edit.commit()
        }
        var next = if (accepted) SensePolicy.nextScanAt(now, rescanIntervalMs) else now + 60_000
        for ((key, event) in rows) {
            val start = event.getLong("start")
            val reminderKey = "reminded:$key"
            val outboxKey = "upcoming:$key"
            if (prefs.getLong(reminderKey, -1) == start) continue
            if (SensePolicy.due(start, now)) {
                if (send("upcoming", event, outboxKey) && prefs.edit().putLong(reminderKey, start).commit()) outbox.complete("upcoming", outboxKey)
                else next = minOf(next, now + 60_000)
            } else SensePolicy.reminderAt(start, now)?.let { next = minOf(next, it) }
        }
        schedule(next)
    }

    private fun send(kind: String, event: JSONObject, key: String, acceptedState: Map<String, String> = emptyMap()): Boolean = outbox.dispatch(kind, key, acceptedState) { id ->
        try {
            CoreClient(ctx).sendSense("sense.calendar", JSONObject().put("kind", kind).put("event", event), id)
        } catch (e: Exception) {
            Log.w("sense.calendar", "delivery unavailable: ${e.javaClass.simpleName}")
            throw e
        }
    }

    private fun sendAttempt(attempt: CalendarDelivery.Attempt, event: JSONObject, reserve: Boolean): Boolean {
        val acceptedState = mapOf(
            CalendarDelivery.key(attempt.occurrence) to attempt.target,
            CalendarDelivery.generationKey(attempt.occurrence) to attempt.generation.toString(),
        )
        val attemptKey = CalendarDelivery.attemptKey(attempt.occurrence)
        return outbox.dispatch(
            "changed", attempt.deliveryKey, acceptedState,
            if (reserve) mapOf(attemptKey to attempt.encode()) else emptyMap(),
            setOf(attemptKey),
        ) { id ->
            CoreClient(ctx).sendSense("sense.calendar", JSONObject().put("kind", "changed").put("event", event), id)
        }
    }

    private fun alarm() = PendingIntent.getBroadcast(ctx, 701, Intent(ctx, CalendarAlarmReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun cancelAlarm() = ctx.getSystemService(AlarmManager::class.java).cancel(alarm())
    private fun schedule(at: Long) {
        val manager = ctx.getSystemService(AlarmManager::class.java)
        val intent = alarm()
        try {
            manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
        } catch (_: SecurityException) {
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, intent)
        }
    }

    fun stop() {
        serial.close {
            if (observing) ctx.contentResolver.unregisterContentObserver(observer)
            observing = false
        }
    }
}

class CalendarAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) = CoreService.start(ctx, CoreService.ACTION_CALENDAR_ALARM)
}
