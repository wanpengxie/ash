package ai.ash.senses

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

data class GeofenceEvent(val name: String, val transition: String, val ts: Long)

object Geo {
    fun distanceM(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val r = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLon = Math.toRadians(lon2 - lon1)
        val a = sin(dLat / 2) * sin(dLat / 2) + cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2)) * sin(dLon / 2) * sin(dLon / 2)
        return 2 * r * asin(min(1.0, sqrt(a)))
    }

    /** A point less precise than this decides no fence. */
    const val MAX_ACCURACY = 1000.0

    /**
     * The fences' states after a point at ([lat], [lon]) with [accuracyM], and the crossings it makes. Inside means
     * within the radius; outside means beyond it by more than the point's uncertainty (up to the radius), so a fix
     * wobbling at the edge does not flap. A fence seen for the first time only takes its state: configuring a fence
     * where the owner stands is not an arrival.
     */
    fun evaluate(fences: List<Geofence>, inside: Map<String, Boolean>, lat: Double, lon: Double, accuracyM: Double, ts: Long): Pair<Map<String, Boolean>, List<GeofenceEvent>> {
        val next = inside.filterKeys { name -> fences.any { it.name == name } }.toMutableMap()
        if (accuracyM > MAX_ACCURACY) return next to emptyList()
        val events = mutableListOf<GeofenceEvent>()
        for (f in fences) {
            val d = distanceM(lat, lon, f.lat, f.lon)
            val now = when {
                d <= f.radiusM -> true
                d > f.radiusM + min(accuracyM, f.radiusM) -> false
                else -> null
            } ?: continue
            val before = next[f.name]
            next[f.name] = now
            if (before != null && before != now) events += GeofenceEvent(f.name, if (now) "enter" else "exit", ts)
        }
        return next to events
    }
}
