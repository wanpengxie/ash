package ai.ash.senses

import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Whether each health source still brings new readings. A source can stop quietly: Gadgetbridge kept rewriting its
 * export file on time while the watch had sent nothing for a day. So freshness goes by the newest reading inside the
 * source, never by a file's time; a source with nothing newer than its threshold (SenseConfig.staleHours) is stale.
 *
 * When a source goes stale Ash is told once (a sense.source event), and once more when readings come back. Pure, so
 * it is tested on its own; HealthHub feeds it.
 */
object HealthFreshness {
    /** Stale, and Ash was told. */
    const val STALE = "stale"
    /** Stale without ever having had a reading (nothing to report as stopped): not told. */
    const val STALE_SILENT = "stale_silent"
    const val FRESH = "fresh"
    private const val HOUR = 3_600_000L

    /** One source as checked: [configured] (set up by the owner), its newest reading, or the [error] reading it. */
    data class Check(val source: String, val configured: Boolean, val latest: Long?, val error: String? = null)

    /** Null when the source is not checked (not set up, threshold 0, or it could not be read). */
    fun stale(check: Check, hours: Int, now: Long): Boolean? =
        if (!check.configured || check.error != null || hours <= 0) null else check.latest == null || now - check.latest > hours * HOUR

    class Outcome(val states: Map<String, String>, val events: List<JSONObject>)

    /**
     * The next stored states and the events for Ash. A source that turns stale after having had readings is reported
     * once; a reported source whose readings come back is reported once more. A source that could not be read keeps
     * its state; one no longer checked forgets it.
     */
    fun step(previous: Map<String, String>, checks: List<Check>, hours: (String) -> Int, now: Long, zone: ZoneId): Outcome {
        val states = LinkedHashMap(previous)
        val events = mutableListOf<JSONObject>()
        for (c in checks) {
            val h = hours(c.source)
            if (!c.configured || h <= 0) { states.remove(c.source); continue }
            val stale = stale(c, h, now) ?: continue
            val before = previous[c.source]
            if (stale) {
                if (before == STALE) continue
                if (c.latest == null) { states[c.source] = STALE_SILENT; continue }
                states[c.source] = STALE
                events += event(c, STALE, h, now, zone)
            } else {
                states[c.source] = FRESH
                if (before == STALE) events += event(c, FRESH, h, now, zone)
            }
        }
        return Outcome(states, events)
    }

    /** sense.source: {source, state: stale|fresh, ts, stale_hours, summary, last_data_ts?}. */
    fun event(c: Check, state: String, hours: Int, now: Long, zone: ZoneId): JSONObject = JSONObject()
        .put("source", c.source).put("state", state).put("ts", now).put("stale_hours", hours).put("summary", summary(c.source, state, c.latest, now, zone))
        .apply { if (c.latest != null) put("last_data_ts", c.latest) }

    /** What health.sources adds to a source's entry. */
    fun annotate(status: JSONObject, c: Check, hours: Int, now: Long, zone: ZoneId) {
        if (!c.configured) return
        status.put("latest_data_ts", c.latest ?: JSONObject.NULL).put("stale_hours", hours)
        if (c.latest != null) status.put("latest_data_age_h", Math.round((now - c.latest) / 360_000.0) / 10.0)
        val stale = stale(c, hours, now)
        status.put("stale", stale ?: JSONObject.NULL)
        if (stale == true) status.put("stale_summary", summary(c.source, STALE, c.latest, now, zone))
    }

    fun label(source: String): String = when (source) {
        "gadgetbridge" -> "手表数据（Gadgetbridge）"
        "health_connect" -> "Health Connect 里的健康数据"
        "xiaomi_scale" -> "体重秤"
        else -> source
    }

    /** In plain Chinese, for the owner: e.g. 手表数据（Gadgetbridge）已经 26 小时没有新数据了，最后一条是 10月7日 02:00. */
    fun summary(source: String, state: String, latest: Long?, now: Long, zone: ZoneId): String {
        val name = label(source)
        if (latest == null) return "${name}还没有任何数据"
        val at = DateTimeFormatter.ofPattern("M月d日 HH:mm").withZone(zone).format(Instant.ofEpochMilli(latest))
        if (state == FRESH) return "${name}又有新数据了，最新一条是 $at"
        val ms = (now - latest).coerceAtLeast(0)
        val ago = when {
            ms >= 48 * HOUR -> "${ms / (24 * HOUR)} 天"
            ms >= HOUR -> "${ms / HOUR} 小时"
            else -> "${ms / 60_000} 分钟"
        }
        return "${name}已经 ${ago}没有新数据了，最后一条是 $at"
    }
}
