package ai.ash.senses

import org.json.JSONArray
import org.json.JSONObject

/** A circle the owner named: crossing its edge is an event ("enter" or "exit"). */
data class Geofence(val name: String, val lat: Double, val lon: Double, val radiusM: Double) {
    fun toJson(): JSONObject = JSONObject().put("name", name).put("lat", lat).put("lon", lon).put("radius_m", radiusM)
}

/**
 * What the helper records, set by the owner (here, or through Ash with approval). Everything starts off: nothing is
 * recorded until the owner asks.
 */
data class SenseConfig(
    val recording: Boolean = false,
    /** Minutes between location points while moving; also the floor tick. */
    val intervalMin: Int = 30,
    val accuracy: String = "balanced",
    val retentionDays: Int = 30,
    val geofences: List<Geofence> = emptyList(),
) {
    fun toJson(): JSONObject = JSONObject().put("recording", recording).put("interval_min", intervalMin).put("accuracy", accuracy)
        .put("retention_days", retentionDays).put("geofences", JSONArray().apply { geofences.forEach { put(it.toJson()) } })

    companion object {
        val ACCURACIES = listOf("high", "balanced", "low")
        const val MIN_INTERVAL = 5
        const val MAX_INTERVAL = 240
        const val MAX_RETENTION = 3650
        const val MAX_GEOFENCES = 50
        private val KEYS = setOf("recording", "interval_min", "accuracy", "retention_days", "geofences")

        /** The stored form; anything unreadable falls back to the defaults (recording off). */
        fun stored(text: String?): SenseConfig {
            if (text.isNullOrBlank()) return SenseConfig()
            return runCatching { apply(SenseConfig(), JSONObject(text)) }.getOrDefault(SenseConfig())
        }

        /** [current] changed by the keys present in [args] (sense.configure). Throws [SenseError] bad_args. */
        fun apply(current: SenseConfig, args: JSONObject): SenseConfig {
            SenseArgs.only(args, KEYS)
            var next = current
            if (args.has("recording")) next = next.copy(recording = SenseArgs.bool(args, "recording"))
            if (args.has("interval_min")) next = next.copy(intervalMin = SenseArgs.int(args, "interval_min", MIN_INTERVAL, MAX_INTERVAL))
            if (args.has("accuracy")) {
                val a = args.opt("accuracy")
                if (a !is String || a !in ACCURACIES) throw SenseError.badArgs("accuracy must be one of ${ACCURACIES.joinToString()}")
                next = next.copy(accuracy = a)
            }
            if (args.has("retention_days")) next = next.copy(retentionDays = SenseArgs.int(args, "retention_days", 1, MAX_RETENTION))
            if (args.has("geofences")) next = next.copy(geofences = geofences(args.opt("geofences")))
            return next
        }

        fun geofences(value: Any?): List<Geofence> {
            val list = value as? JSONArray ?: throw SenseError.badArgs("geofences must be an array of {name, lat, lon, radius_m}")
            if (list.length() > MAX_GEOFENCES) throw SenseError.badArgs("at most $MAX_GEOFENCES geofences")
            val out = mutableListOf<Geofence>()
            for (i in 0 until list.length()) {
                val g = list.opt(i) as? JSONObject ?: throw SenseError.badArgs("geofences[$i] must be an object")
                SenseArgs.only(g, setOf("name", "lat", "lon", "radius_m", "radius"), "geofences[$i]")
                val name = (g.opt("name") as? String)?.trim().orEmpty()
                if (name.isEmpty() || name.length > 64) throw SenseError.badArgs("geofences[$i].name must be 1 to 64 characters")
                if (out.any { it.name == name }) throw SenseError.badArgs("geofence name \"$name\" is used twice")
                val lat = SenseArgs.double(g, "lat", -90.0, 90.0, "geofences[$i].lat")
                val lon = SenseArgs.double(g, "lon", -180.0, 180.0, "geofences[$i].lon")
                val key = if (g.has("radius_m")) "radius_m" else "radius"
                val radius = SenseArgs.double(g, key, 20.0, 50_000.0, "geofences[$i].radius_m")
                out += Geofence(name, lat, lon, radius)
            }
            return out
        }
    }
}
