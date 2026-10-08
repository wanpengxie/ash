package ai.ash.senses.health

import ai.ash.senses.HealthRow
import ai.ash.senses.SenseError
import ai.ash.senses.Senses
import ai.ash.senses.AshLink
import ai.ash.senses.AlarmReceiver
import ai.ash.senses.Batches
import ai.ash.senses.HealthFreshness
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.time.ZoneId
import java.util.concurrent.Executors

/** Every health source together: what health.sources lists and health.read reads. */
object HealthHub {
    val SOURCES = listOf("health_connect", "gadgetbridge", "xiaomi_scale")

    class Reading(val rows: List<HealthRow>, val errors: JSONObject)

    /**
     * Each source's state, with the time of its newest reading and whether that is stale. Checking also tells Ash
     * (once) of a source that went stale, or came back.
     */
    fun sources(ctx: Context, now: Long = System.currentTimeMillis()): JSONArray {
        val statuses = listOf(
            runCatching { HealthConnectSource.status(ctx, now) }.getOrElse { JSONObject().put("id", "health_connect").put("state", "error").put("error", it.message) },
            runCatching { GadgetbridgeSource.status(ctx, now) }.getOrElse { JSONObject().put("id", "gadgetbridge").put("error", it.message) },
            runCatching { XiaomiScaleSource.status(ctx) }.getOrElse { JSONObject().put("id", "xiaomi_scale").put("error", it.message) },
        )
        runCatching { freshness(ctx, statuses, now) }.onFailure { Log.w("ash.senses", "health freshness", it) }
        return JSONArray(statuses)
    }

    /** The stale ones among [sources] (as health.sources lists them), for health.summary. */
    fun stale(sources: JSONArray): JSONArray = JSONArray().apply {
        for (i in 0 until sources.length()) {
            val s = sources.optJSONObject(i) ?: continue
            if (s.optBoolean("stale")) put(JSONObject().put("source", s.optString("id")).put("latest_data_ts", s.opt("latest_data_ts"))
                .put("stale_hours", s.optInt("stale_hours")).put("summary", s.optString("stale_summary"))
                .apply { if (s.has("latest_data_age_h")) put("latest_data_age_h", s.get("latest_data_age_h")) })
        }
    }

    private const val FRESHNESS = "health_freshness"

    @Synchronized private fun freshness(ctx: Context, statuses: List<JSONObject>, now: Long) {
        val config = Senses.config(ctx)
        val zone = ZoneId.systemDefault()
        val checks = statuses.map { s ->
            val latest = if (s.has("latest_data_ts") && !s.isNull("latest_data_ts")) s.optLong("latest_data_ts") else null
            HealthFreshness.Check(s.optString("id"), s.has("latest_data_ts") || s.has("latest_error"), latest, if (s.has("latest_error")) s.optString("latest_error") else null)
        }
        for ((c, s) in checks.zip(statuses)) HealthFreshness.annotate(s, c, config.staleHours(c.source), now, zone)
        val prefs = Senses.prefs(ctx)
        val stored = runCatching { JSONObject(prefs.getString(FRESHNESS, "{}")!!) }.getOrDefault(JSONObject())
        val previous = stored.keys().asSequence().associateWith { stored.optString(it) }
        val outcome = HealthFreshness.step(previous, checks, config::staleHours, now, zone)
        if (outcome.states != previous) prefs.edit().putString(FRESHNESS, JSONObject(outcome.states as Map<*, *>).toString()).apply()
        for (e in outcome.events) Senses.store.enqueue(Batches.SOURCE, e, now)
        if (outcome.events.isNotEmpty()) AshLink.flush()
    }

    /** Reads each source; a source that fails is reported, not hidden. Throws when none answered. */
    fun read(ctx: Context, metrics: List<String>, range: LongRange, sources: List<String>, max: Int): Reading {
        val rows = mutableListOf<HealthRow>()
        val errors = JSONObject()
        var answered = 0
        var firstError: SenseError? = null
        for (s in sources) {
            try {
                rows += when (s) {
                    "health_connect" -> HealthConnectSource.read(ctx, metrics, range, max)
                    "gadgetbridge" -> GadgetbridgeSource.read(ctx, metrics, range, max)
                    "xiaomi_scale" -> XiaomiScaleSource.read(ctx, metrics, range, max)
                    else -> continue
                }
                answered++
            } catch (e: SenseError) {
                errors.put(s, JSONObject().put("code", e.code).put("message", e.message))
                if (firstError == null || firstError.code == "source_unavailable") firstError = e
            }
        }
        if (answered == 0) throw firstError ?: SenseError("source_unavailable", "no health source is set up")
        return Reading(rows.sortedBy { it.ts }.take(max), errors)
    }
}

/**
 * While recording is on, once an hour: new readings from each set-up source go into the store, and on to Ash.
 * Readings already stored are not stored twice.
 */
object HealthImport {
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "senses-health-import") }

    fun run(ctx: Context) {
        executor.execute {
            if (!Senses.config(ctx).recording) return@execute
            val prefs = Senses.prefs(ctx)
            val now = System.currentTimeMillis()
            val from = (prefs.getLong("health_imported_to", 0) - 6 * 3_600_000L).coerceAtLeast(now - 7 * 86_400_000L)
            val errors = JSONObject()
            var added = 0
            for (s in HealthHub.SOURCES) {
                val configured = when (s) {
                    "health_connect" -> HealthConnectSource.granted(ctx).isNotEmpty()
                    "gadgetbridge" -> GadgetbridgeSource.folder(ctx) != null
                    // The scale's weigh-ins are stored as they are heard.
                    else -> false
                }
                if (!configured) continue
                try {
                    val rows = HealthHub.read(ctx, ai.ash.senses.HealthMetric.names, from until now, listOf(s), 100_000).rows
                    added += Senses.store.addHealth(rows)
                } catch (e: SenseError) { errors.put(s, "${e.code}: ${e.message}") }
                catch (e: Exception) { Log.w("ash.senses", "health import from $s", e); errors.put(s, e.toString()) }
            }
            prefs.edit().putLong("health_imported_to", now).putString("health_import_errors", errors.toString()).putInt("health_import_added", added).apply()
            if (added > 0) AshLink.flush()
        }
    }
}

/**
 * Every few hours, whether or not recording is on: each source's newest reading is checked, so a watch that stopped
 * sending is noticed and Ash told. The alarm does not wake the phone; it runs the next time the phone is awake anyway.
 */
object HealthWatch {
    const val ACTION = "ai.ash.senses.HEALTH_CHECK"
    private const val INTERVAL_MS = 3 * 3_600_000L
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "senses-health-watch") }

    private fun intent(ctx: Context) = Intent(ctx, AlarmReceiver::class.java).setAction(ACTION)

    /** Once per boot (and after an update): an alarm already set is left as it is. */
    fun arm(ctx: Context) {
        if (PendingIntent.getBroadcast(ctx, ACTION.hashCode(), intent(ctx), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_NO_CREATE) != null) return
        val pi = PendingIntent.getBroadcast(ctx, ACTION.hashCode(), intent(ctx), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        runCatching { ctx.getSystemService(AlarmManager::class.java).setInexactRepeating(AlarmManager.RTC, System.currentTimeMillis() + 15 * 60_000L, INTERVAL_MS, pi) }
            .onFailure { Log.w("ash.senses", "health watch not armed", it) }
    }

    fun run(ctx: Context, done: () -> Unit) {
        executor.execute { try { HealthHub.sources(ctx) } catch (e: Exception) { Log.w("ash.senses", "health watch", e) } finally { done() } }
    }
}
