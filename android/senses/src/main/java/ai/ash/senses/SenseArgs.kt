package ai.ash.senses

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeParseException

/** Tool arguments, checked before anything is read or changed. Every problem is a [SenseError] bad_args. */
object SenseArgs {
    const val DAY_MS = 86_400_000L
    /** The longest range one call reads. */
    const val MAX_SPAN_MS = 400 * DAY_MS

    /** Unknown keys are refused: a misspelled one would otherwise be silently ignored. */
    fun only(args: JSONObject, allowed: Set<String>, where: String = "arguments") {
        val extra = args.keys().asSequence().filter { it !in allowed }.toList()
        if (extra.isNotEmpty()) throw SenseError.badArgs("$where: unknown ${extra.joinToString()} (allowed: ${allowed.sorted().joinToString()})")
    }

    fun bool(args: JSONObject, key: String): Boolean =
        args.opt(key) as? Boolean ?: throw SenseError.badArgs("$key must be true or false")

    fun int(args: JSONObject, key: String, min: Int, max: Int): Int {
        val v = args.opt(key)
        val n = (v as? Number)?.toDouble() ?: throw SenseError.badArgs("$key must be a number")
        if (n != Math.floor(n) || n < min || n > max) throw SenseError.badArgs("$key must be a whole number from $min to $max")
        return n.toInt()
    }

    fun double(args: JSONObject, key: String, min: Double, max: Double, label: String = key): Double {
        val n = (args.opt(key) as? Number)?.toDouble() ?: throw SenseError.badArgs("$label must be a number")
        if (n.isNaN() || n < min || n > max) throw SenseError.badArgs("$label must be from $min to $max")
        return n
    }

    /**
     * A moment: epoch milliseconds, an ISO-8601 instant ("2026-10-06T08:00:00Z", or with an offset), a local
     * date-time without offset, or a date ("2026-10-06", its local midnight).
     */
    fun time(value: Any?, key: String, zone: ZoneId = ZoneId.systemDefault()): Long {
        when (value) {
            is Number -> {
                val n = value.toLong()
                if (n < 946_684_800_000L || n > 4_102_444_800_000L) throw SenseError.badArgs("$key must be epoch milliseconds (2000 to 2100)")
                return n
            }
            is String -> {
                val s = value.trim()
                try { return Instant.parse(s).toEpochMilli() } catch (_: DateTimeParseException) {}
                try { return OffsetDateTime.parse(s).toInstant().toEpochMilli() } catch (_: DateTimeParseException) {}
                try { return java.time.LocalDateTime.parse(s).atZone(zone).toInstant().toEpochMilli() } catch (_: DateTimeParseException) {}
                try { return LocalDate.parse(s).atStartOfDay(zone).toInstant().toEpochMilli() } catch (_: DateTimeParseException) {}
                throw SenseError.badArgs("$key must be epoch milliseconds or an ISO-8601 date/time")
            }
            else -> throw SenseError.badArgs("$key must be epoch milliseconds or an ISO-8601 date/time")
        }
    }

    /** [from, to): both optional; to defaults to now, from to [defaultSpanMs] before to. */
    fun range(args: JSONObject, now: Long, defaultSpanMs: Long, zone: ZoneId = ZoneId.systemDefault()): LongRange {
        val to = if (args.has("to") && !args.isNull("to")) time(args.opt("to"), "to", zone) else now
        val from = if (args.has("from") && !args.isNull("from")) time(args.opt("from"), "from", zone) else to - defaultSpanMs
        if (from >= to) throw SenseError.badArgs("from must be before to")
        if (to - from > MAX_SPAN_MS) throw SenseError.badArgs("a range may span at most ${MAX_SPAN_MS / DAY_MS} days")
        return from until to
    }

    fun limit(args: JSONObject, key: String, default: Int, max: Int): Int =
        if (args.has(key) && !args.isNull(key)) int(args, key, 1, max) else default

    /** health.read's metrics: all of them when absent. */
    fun metrics(args: JSONObject): List<String> {
        if (!args.has("metrics") || args.isNull("metrics")) return HealthMetric.names
        val list = args.opt("metrics") as? JSONArray ?: throw SenseError.badArgs("metrics must be an array of ${HealthMetric.names.joinToString()}")
        if (list.length() == 0) throw SenseError.badArgs("metrics must name at least one of ${HealthMetric.names.joinToString()}")
        val out = LinkedHashSet<String>()
        for (i in 0 until list.length()) {
            val m = list.opt(i) as? String
            if (m == null || m !in HealthMetric.names) throw SenseError.badArgs("unknown metric ${list.opt(i)} (known: ${HealthMetric.names.joinToString()})")
            out += m
        }
        return out.toList()
    }

    val DELETE_KINDS = listOf("location", "activity", "steps", "health", "all")

    fun deleteKind(args: JSONObject): String {
        val k = args.opt("kind") as? String ?: throw SenseError.badArgs("kind is required: one of ${DELETE_KINDS.joinToString()}")
        if (k !in DELETE_KINDS) throw SenseError.badArgs("kind must be one of ${DELETE_KINDS.joinToString()}")
        return k
    }

    /** sense.delete's range: everything when neither end is given. */
    fun deleteRange(args: JSONObject, zone: ZoneId = ZoneId.systemDefault()): LongRange {
        val from = if (args.has("from") && !args.isNull("from")) time(args.opt("from"), "from", zone) else 0L
        val to = if (args.has("to") && !args.isNull("to")) time(args.opt("to"), "to", zone) else Long.MAX_VALUE
        if (from >= to) throw SenseError.badArgs("from must be before to")
        return from until to
    }

    /** health.summary: one local day or the seven days ending with it. */
    fun summaryRange(args: JSONObject, now: Long, zone: ZoneId = ZoneId.systemDefault()): Pair<String, LongRange> {
        val period = (args.opt("period") as? String) ?: "day"
        if (period != "day" && period != "week") throw SenseError.badArgs("period must be day or week")
        val day = when {
            !args.has("date") || args.isNull("date") -> Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
            else -> try { LocalDate.parse(args.optString("date")) } catch (_: DateTimeParseException) { throw SenseError.badArgs("date must be YYYY-MM-DD") }
        }
        val end = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        val start = (if (period == "week") day.minusDays(6) else day).atStartOfDay(zone).toInstant().toEpochMilli()
        return period to (start until end)
    }

    fun startOfDay(ts: Long, zone: ZoneId = ZoneId.systemDefault()): Long =
        Instant.ofEpochMilli(ts).atZone(zone).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli()
}
