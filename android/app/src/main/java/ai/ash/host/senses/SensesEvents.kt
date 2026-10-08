package ai.ash.host.senses

import org.json.JSONObject

/**
 * The batches the senses helper pushes, checked before they go to the core as events. The words and bodies are a
 * contract with the core:
 *
 * - sense.location {batch_id, items: [{ts, lat, lon, accuracy_m, provider, is_mocked?}]}
 * - sense.activity {batch_id, items: [{ts_start, ts_end?, state}]}, state still|walking|running|cycling|in_vehicle;
 *   a segment is sent again (same ts_start) once it has its end
 * - sense.health {batch_id, items: [{ts, metric, value, unit, source}]}
 * - sense.geofence {name, transition: enter|exit, ts}
 * - sense.source {source, state: stale|fresh, ts, stale_hours, summary, last_data_ts?}: a health source stopped
 *   bringing new readings (told once), or they came back; summary is plain Chinese for the owner
 *
 * Times are epoch milliseconds; at most [MAX_ITEMS] items per batch. The batch id is also the event's client id, so a
 * batch offered twice is recorded once.
 */
internal object SensesEvents {
    const val MAX_ITEMS = 500
    val WORDS = setOf("sense.location", "sense.activity", "sense.health", "sense.geofence", "sense.source")
    private val STATES = setOf("still", "walking", "running", "cycling", "in_vehicle")

    data class Event(val id: String, val word: String, val body: JSONObject)

    /** The event in [raw] ({batch_id, word, body}), or null when it breaks the contract (logged and dropped by the caller). */
    fun parse(raw: String): Event? {
        val o = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val id = o.optString("batch_id")
        val word = o.optString("word")
        val body = o.optJSONObject("body") ?: return null
        if (id.isBlank() || id.length > 100 || word !in WORDS) return null
        if (!valid(word, body, id)) return null
        return Event(id, word, body)
    }

    private fun keys(o: JSONObject): Set<String> = o.keys().asSequence().toSet()
    private fun time(v: Any?): Boolean = v is Number && v.toLong() > 0 && v.toDouble() == Math.floor(v.toDouble())
    private val SOURCE_KEYS = setOf("source", "state", "ts", "stale_hours", "summary")
    private fun text(v: Any?, max: Int): Boolean = v is String && v.isNotBlank() && v.length <= max
    private fun num(v: Any?): Boolean = v is Number && !v.toDouble().isNaN() && !v.toDouble().isInfinite()

    fun valid(word: String, body: JSONObject, id: String): Boolean {
        if (word == "sense.geofence") {
            return keys(body) == setOf("name", "transition", "ts") && body.opt("name") is String && body.optString("name").isNotBlank() &&
                body.opt("transition") in setOf("enter", "exit") && time(body.opt("ts"))
        }
        if (word == "sense.source") {
            val keys = keys(body)
            return keys.containsAll(SOURCE_KEYS) && (keys - SOURCE_KEYS - "last_data_ts").isEmpty() &&
                text(body.opt("source"), 64) && body.opt("state") in setOf("stale", "fresh") && time(body.opt("ts")) &&
                (body.opt("stale_hours") as? Number)?.let { it.toDouble() == Math.floor(it.toDouble()) && it.toInt() in 1..720 } == true &&
                text(body.opt("summary"), 200) && (!body.has("last_data_ts") || time(body.opt("last_data_ts")))
        }
        if (keys(body) != setOf("batch_id", "items") || body.opt("batch_id") != id) return false
        val items = body.optJSONArray("items") ?: return false
        if (items.length() == 0 || items.length() > MAX_ITEMS) return false
        for (i in 0 until items.length()) {
            val it = items.optJSONObject(i) ?: return false
            val keys = keys(it)
            val ok = when (word) {
                "sense.location" -> keys.containsAll(setOf("ts", "lat", "lon", "accuracy_m", "provider")) &&
                    (keys - setOf("ts", "lat", "lon", "accuracy_m", "provider", "is_mocked")).isEmpty() &&
                    time(it.opt("ts")) && num(it.opt("lat")) && num(it.opt("lon")) && num(it.opt("accuracy_m")) && it.opt("provider") is String &&
                    (!it.has("is_mocked") || it.opt("is_mocked") is Boolean)
                "sense.activity" -> keys.containsAll(setOf("ts_start", "state")) && (keys - setOf("ts_start", "ts_end", "state")).isEmpty() &&
                    time(it.opt("ts_start")) && (!it.has("ts_end") || time(it.opt("ts_end"))) && it.opt("state") in STATES
                "sense.health" -> keys == setOf("ts", "metric", "value", "unit", "source") && time(it.opt("ts")) && it.opt("metric") is String &&
                    num(it.opt("value")) && it.opt("unit") is String && it.opt("source") is String
                else -> false
            }
            if (!ok) return false
        }
        return true
    }
}
