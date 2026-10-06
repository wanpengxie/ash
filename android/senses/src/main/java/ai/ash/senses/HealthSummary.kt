package ai.ash.senses

import org.json.JSONObject
import kotlin.math.roundToLong

/**
 * A day's or week's readings in a few numbers, by rule (no model). Sources are never added together: two sources
 * counting the same steps would double them, so totals come from the source with the most.
 */
object HealthSummary {
    fun of(rows: List<HealthRow>, range: LongRange): JSONObject {
        val out = JSONObject()
        val byMetric = rows.filter { it.ts in range }.groupBy { it.metric }
        fun bestTotal(list: List<HealthRow>): Pair<Double, String> =
            list.groupBy { it.source }.mapValues { (_, r) -> r.sumOf { it.value } }.maxByOrNull { it.value }!!.let { it.value to it.key }
        for ((metric, list) in byMetric) {
            val unit = HealthMetric.unit(metric)
            val o = JSONObject().put("unit", unit).put("readings", list.size)
            when (metric) {
                "steps", "active_calories", "distance" -> { val (t, s) = bestTotal(list); o.put("total", round1(t)).put("source", s) }
                "heart_rate", "spo2" -> {
                    o.put("min", round1(list.minOf { it.value })).put("max", round1(list.maxOf { it.value }))
                        .put("avg", round1(list.sumOf { it.value } / list.size))
                }
                "sleep" -> {
                    val (t, s) = bestTotal(list)
                    o.put("total_min", round1(t)).put("sessions", list.count { it.source == s }).put("source", s)
                }
                "exercise" -> {
                    val (t, s) = bestTotal(list)
                    o.put("total_min", round1(t)).put("sessions", list.count { it.source == s }).put("source", s)
                }
                "weight", "body_fat" -> {
                    val last = list.maxByOrNull { it.ts }!!
                    o.put("latest", round1(last.value)).put("latest_ts", last.ts).put("source", last.source)
                        .put("min", round1(list.minOf { it.value })).put("max", round1(list.maxOf { it.value }))
                }
            }
            out.put(metric, o)
        }
        return out
    }

    private fun round1(v: Double): Double = (v * 10).roundToLong() / 10.0
}
