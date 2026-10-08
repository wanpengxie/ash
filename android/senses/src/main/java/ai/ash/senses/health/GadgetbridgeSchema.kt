package ai.ash.senses.health

import ai.ash.senses.HealthRow

/**
 * How a Gadgetbridge export is read: its tables are looked at first, and only what is recognised is taken. Table names
 * change between Gadgetbridge versions and devices (Huawei's included), so nothing here names a table; it goes by
 * columns. Pure, so it is tested on its own.
 */
object GadgetbridgeSchema {
    data class Table(val name: String, val columns: List<String>) {
        private val upper = columns.associateBy { it.uppercase() }
        /** The table's own spelling of the first of [names] it has (case-insensitive). */
        fun column(vararg names: String): String? = names.firstNotNullOfOrNull { upper[it.uppercase()] }
    }

    /** Per-minute (or per-reading) samples: steps, heart rate, blood oxygen. */
    data class SamplePlan(val table: String, val ts: String, val device: String?, val metrics: Map<String, String>)

    /** Spans with a start and an end: a night's sleep, a workout. */
    data class SessionPlan(val table: String, val metric: String, val start: String, val end: String, val device: String?, val kind: String?)

    sealed class Result
    data class Plan(val samples: List<SamplePlan>, val sessions: List<SessionPlan>, val devices: Table?, val notes: List<String>) : Result()
    data class Unsupported(val tables: List<String>) : Result()

    private val START = arrayOf("START_TIMESTAMP", "START_TIME", "TIMESTAMP_START", "STARTTIME", "START")
    private val END = arrayOf("END_TIMESTAMP", "END_TIME", "TIMESTAMP_END", "ENDTIME", "END", "WAKEUP_TIME")

    fun plan(tables: List<Table>): Result {
        val samples = mutableListOf<SamplePlan>()
        val sessions = mutableListOf<SessionPlan>()
        val notes = mutableListOf<String>()
        for (t in tables) {
            val name = t.name.uppercase()
            if (name.startsWith("SQLITE_") || name == "ANDROID_METADATA") continue
            val device = t.column("DEVICE_ID")
            val start = t.column(*START)
            val end = t.column(*END)
            val sleepy = "SLEEP" in name
            val workout = "WORKOUT" in name || "ACTIVITY_SUMMARY" in name || "EXERCISE" in name
            when {
                sleepy && end != null && (start ?: t.column("TIMESTAMP")) != null ->
                    sessions += SessionPlan(t.name, "sleep", start ?: t.column("TIMESTAMP")!!, end, device, null)
                workout && start != null && end != null ->
                    sessions += SessionPlan(t.name, "exercise", start, end, device, t.column("ACTIVITY_KIND", "SPORT_TYPE", "WORKOUT_TYPE", "TYPE", "NAME"))
                !workout && !sleepy && "SUMMARY" !in name && t.column("TIMESTAMP") != null -> {
                    val metrics = linkedMapOf<String, String>()
                    t.column("STEPS")?.let { metrics["steps"] = it }
                    t.column("HEART_RATE")?.let { metrics["heart_rate"] = it }
                    t.column("SPO2", "SPO", "SP_O2")?.let { metrics["spo2"] = it }
                    if (metrics.isNotEmpty()) samples += SamplePlan(t.name, t.column("TIMESTAMP")!!, device, metrics)
                }
            }
        }
        if (samples.isEmpty() && sessions.isEmpty()) return Unsupported(tables.map { it.name }.filter { !it.uppercase().startsWith("SQLITE_") && it != "android_metadata" })
        if (sessions.none { it.metric == "sleep" })
            notes += "sleep: no table with sleep sessions (start and end) in this export; sleep stages hidden in per-minute RAW_KIND values are device-specific and are not guessed"
        val devices = tables.firstOrNull { it.name.uppercase() == "DEVICE" }
        return Plan(samples, sessions, devices, notes)
    }

    /** Gadgetbridge stores most sample times in seconds, some newer tables in milliseconds: the size of the number tells. */
    fun toMillis(value: Long): Long = if (value > 100_000_000_000L) value else value * 1000

    /** The range's ends in the table's own unit, given its largest time ([maxTs], null when empty). */
    fun rangeIn(maxTs: Long?, range: LongRange): LongRange =
        if (maxTs != null && maxTs > 100_000_000_000L) range else (range.first / 1000)..(range.last / 1000)

    /** "gadgetbridge:huawei-watch-gt-5-pro" from a device's name. */
    fun source(deviceName: String?): String {
        val slug = deviceName.orEmpty().lowercase().replace(Regex("[^a-z0-9]+"), "-").trim('-')
        return if (slug.isEmpty()) "gadgetbridge" else "gadgetbridge:$slug"
    }

    private fun long(v: Any?): Long? = when (v) { is Number -> v.toLong(); is String -> v.toLongOrNull(); else -> null }
    private fun double(v: Any?): Double? = when (v) { is Number -> v.toDouble(); is String -> v.toDoubleOrNull(); else -> null }

    /** A real measurement, not one of Gadgetbridge's "no reading" marks (0, 255, negative). */
    fun valid(metric: String, v: Double): Boolean = when (metric) {
        "steps" -> v > 0 && v < 100_000
        "heart_rate" -> v >= 25 && v <= 240
        "spo2" -> v >= 50 && v <= 100
        else -> false
    }

    /** [valid] as an SQL condition on [column] (already quoted). */
    fun validSql(metric: String, column: String): String = when (metric) {
        "steps" -> "$column > 0 AND $column < 100000"
        "heart_rate" -> "$column >= 25 AND $column <= 240"
        "spo2" -> "$column >= 50 AND $column <= 100"
        else -> "0"
    }

    /** One newest reading found: of [metric], from [source], at [ts] (ms). */
    data class Found(val metric: String, val source: String, val ts: Long)

    /** The newest real reading in an export: overall, per metric and per device (source). */
    data class Latest(val ts: Long?, val byMetric: Map<String, Long>, val bySource: Map<String, Long>)

    fun latest(found: List<Found>): Latest {
        val byMetric = sortedMapOf<String, Long>()
        val bySource = sortedMapOf<String, Long>()
        for (f in found) {
            byMetric[f.metric] = maxOf(byMetric[f.metric] ?: Long.MIN_VALUE, f.ts)
            bySource[f.source] = maxOf(bySource[f.source] ?: Long.MIN_VALUE, f.ts)
        }
        return Latest(found.maxOfOrNull { it.ts }, byMetric, bySource)
    }

    /**
     * Sample rows (column → value, as read) into readings. Steps add up per hour (a reading a minute would bury
     * everything else); heart rate and blood oxygen stay as measured. Gadgetbridge marks "no reading" with 0, 255 or
     * negative values: those are dropped, never passed on as a measurement.
     */
    fun samples(plan: SamplePlan, rows: List<Map<String, Any?>>, devices: Map<Long, String>, wanted: Collection<String>, range: LongRange): List<HealthRow> {
        val out = mutableListOf<HealthRow>()
        val hourly = sortedMapOf<Pair<Long, String>, Double>(compareBy({ it.first }, { it.second }))
        for (r in rows) {
            val ts = toMillis(long(r[plan.ts]) ?: continue)
            if (ts !in range) continue
            val source = source(plan.device?.let { long(r[it]) }?.let { devices[it] })
            for ((metric, column) in plan.metrics) {
                if (metric !in wanted) continue
                val v = double(r[column]) ?: continue
                if (!valid(metric, v)) continue
                when (metric) {
                    "steps" -> { val hour = ts - Math.floorMod(ts, 3_600_000L); hourly[hour to source] = (hourly[hour to source] ?: 0.0) + v }
                    "heart_rate", "spo2" -> out += HealthRow(ts, metric, v, source)
                }
            }
        }
        for ((key, steps) in hourly) out += HealthRow(key.first, "steps", steps, key.second, tsEnd = key.first + 3_600_000L)
        return out.sortedBy { it.ts }
    }

    /** Session rows into one reading each: its length in minutes, from its start. Empty or inverted spans are dropped. */
    fun sessions(plan: SessionPlan, rows: List<Map<String, Any?>>, devices: Map<Long, String>, range: LongRange): List<HealthRow> {
        val out = mutableListOf<HealthRow>()
        for (r in rows) {
            val start = toMillis(long(r[plan.start]) ?: continue)
            val end = toMillis(long(r[plan.end]) ?: continue)
            if (end <= start || end - start > 2 * 86_400_000L || start !in range) continue
            val source = source(plan.device?.let { long(r[it]) }?.let { devices[it] })
            val kind = plan.kind?.let { r[it]?.toString() }?.takeIf { it.isNotBlank() }
            out += HealthRow(start, plan.metric, (end - start) / 60_000.0, source, tsEnd = end, kind = kind)
        }
        return out.sortedBy { it.ts }
    }
}

/** Which file in the folder the owner granted is the newest Gadgetbridge export. */
object GadgetbridgeFiles {
    data class Doc(val id: String, val name: String, val mime: String?, val modified: Long, val size: Long)

    /** The database itself ("Gadgetbridge", or a .db or .sqlite file), or a zip export that holds it. */
    fun candidate(d: Doc): Boolean {
        val n = d.name.lowercase()
        if (n.endsWith("-journal") || n.endsWith("-wal") || n.endsWith("-shm")) return false
        return n == "gadgetbridge" || n.endsWith(".db") || n.endsWith(".sqlite") || n.endsWith(".sqlite3") || n.endsWith(".zip")
    }

    fun newest(docs: List<Doc>): Doc? = docs.filter { candidate(it) && it.size > 0 }.maxWithOrNull(compareBy({ it.modified }, { it.name }))

    /** The database inside a zip export (Gadgetbridge puts it under database/). */
    fun zipEntry(name: String): Boolean {
        val base = name.substringAfterLast('/').lowercase()
        return base == "gadgetbridge" || base.endsWith(".db")
    }

    /** An SQLite file starts with this. */
    val MAGIC = "SQLite format 3\u0000".toByteArray(Charsets.US_ASCII)
}
