package ai.ash.senses

import org.json.JSONArray
import org.json.JSONObject

/** The words the helper pushes to Ash, and the batches that carry them. */
object Batches {
    const val LOCATION = "sense.location"
    const val ACTIVITY = "sense.activity"
    const val HEALTH = "sense.health"
    const val GEOFENCE = "sense.geofence"
    /** A health source went stale or came back: {source, state, ts, stale_hours, summary, last_data_ts?}. */
    const val SOURCE = "sense.source"
    val WORDS = setOf(LOCATION, ACTIVITY, HEALTH, GEOFENCE, SOURCE)
    const val MAX_ITEMS = 500

    /** Items split into batches of at most [MAX_ITEMS], each with its own id. */
    fun split(items: List<JSONObject>, newId: () -> String): List<JSONObject> =
        items.chunked(MAX_ITEMS).map { chunk -> JSONObject().put("batch_id", newId()).put("items", JSONArray().apply { chunk.forEach { put(it) } }) }

    /** What crosses to Ash: {batch_id, word, body}. */
    fun envelope(id: String, word: String, body: JSONObject): JSONObject = JSONObject().put("batch_id", id).put("word", word).put("body", body)

    /** The moment an item describes, for deleting it from an undelivered batch. */
    fun itemTime(word: String, item: JSONObject): Long = when (word) {
        ACTIVITY -> item.optLong("ts_start")
        else -> item.optLong("ts")
    }

    /**
     * [body] of [word] without the items in [range]; null when nothing is left to deliver. A geofence or source event
     * is one item itself.
     */
    fun without(word: String, body: JSONObject, range: LongRange): JSONObject? {
        if (word == GEOFENCE || word == SOURCE) return if (body.optLong("ts") in range) null else body
        val items = body.optJSONArray("items") ?: return null
        val kept = JSONArray()
        for (i in 0 until items.length()) { val it = items.optJSONObject(i) ?: continue; if (itemTime(word, it) !in range) kept.put(it) }
        if (kept.length() == 0) return null
        return JSONObject(body.toString()).put("items", kept)
    }

    /** The store kind (sense.delete) a word's rows belong to. */
    fun kindOf(word: String): String = when (word) {
        LOCATION, GEOFENCE -> "location"
        ACTIVITY -> "activity"
        HEALTH, SOURCE -> "health"
        else -> "other"
    }

    /** Evenly spaced picks of [list] (first and last kept), at most [max]. */
    fun <T> thin(list: List<T>, max: Int): List<T> {
        if (list.size <= max || max < 2) return if (max < 2) list.take(max) else list
        val step = (list.size - 1).toDouble() / (max - 1)
        return (0 until max).map { list[Math.round(it * step).toInt()] }
    }
}
