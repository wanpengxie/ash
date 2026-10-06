package ai.ash.senses

import org.json.JSONObject

/** The health measures the helper reads, each in one unit. */
object HealthMetric {
    val units = linkedMapOf(
        "steps" to "count",
        "heart_rate" to "bpm",
        "spo2" to "%",
        "sleep" to "min",
        "weight" to "kg",
        "body_fat" to "%",
        "active_calories" to "kcal",
        "distance" to "m",
        "exercise" to "min",
    )
    val names: List<String> = units.keys.toList()
    fun unit(metric: String): String = units[metric] ?: error("unknown metric $metric")
}

/**
 * One reading: at [ts] (ms), [value] in the metric's unit, from [source] (e.g. "health_connect:com.example.app",
 * "gadgetbridge:huawei-watch-gt-5-pro"). A reading over a span (steps in an hour, a night's sleep) has [tsEnd]; an
 * exercise may name its [kind].
 */
data class HealthRow(
    val ts: Long,
    val metric: String,
    val value: Double,
    val source: String,
    val tsEnd: Long? = null,
    val kind: String? = null,
) {
    val unit: String get() = HealthMetric.unit(metric)

    fun toJson(): JSONObject = JSONObject().put("ts", ts).put("metric", metric).put("value", value).put("unit", unit).put("source", source).apply {
        if (tsEnd != null) put("ts_end", tsEnd)
        if (kind != null) put("kind", kind)
    }

    /** The shape pushed to Ash as a sense.health item: exactly {ts, metric, value, unit, source}. */
    fun toEvent(): JSONObject = JSONObject().put("ts", ts).put("metric", metric).put("value", value).put("unit", unit).put("source", source)
}
