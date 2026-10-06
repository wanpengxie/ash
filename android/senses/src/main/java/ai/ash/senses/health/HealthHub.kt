package ai.ash.senses.health

import ai.ash.senses.HealthRow
import ai.ash.senses.SenseError
import ai.ash.senses.Senses
import ai.ash.senses.AshLink
import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/** Every health source together: what health.sources lists and health.read reads. */
object HealthHub {
    val SOURCES = listOf("health_connect", "gadgetbridge")

    class Reading(val rows: List<HealthRow>, val errors: JSONObject)

    fun sources(ctx: Context): JSONArray = JSONArray()
        .put(runCatching { HealthConnectSource.status(ctx) }.getOrElse { JSONObject().put("id", "health_connect").put("state", "error").put("error", it.message) })
        .put(runCatching { GadgetbridgeSource.status(ctx) }.getOrElse { JSONObject().put("id", "gadgetbridge").put("error", it.message) })

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
                    else -> GadgetbridgeSource.folder(ctx) != null
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
