package ai.ash.senses

import ai.ash.senses.health.GadgetbridgeFiles
import ai.ash.senses.health.GadgetbridgeSchema
import ai.ash.senses.health.GadgetbridgeSchema.Table
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A synthetic export: tables and columns as a Gadgetbridge database lays them out (a generic band, a Huawei watch with
 * its own column spellings), and rows as the reader gets them from a cursor.
 */
class GadgetbridgeSchemaTest {
    private val band = Table("MI_BAND_ACTIVITY_SAMPLE", listOf("TIMESTAMP", "DEVICE_ID", "USER_ID", "RAW_INTENSITY", "STEPS", "RAW_KIND", "HEART_RATE"))
    private val huawei = Table("HUAWEI_ACTIVITY_SAMPLE", listOf("timestamp", "DEVICE_ID", "USER_ID", "OTHER_TIMESTAMP", "SOURCE", "RAW_KIND", "RAW_INTENSITY", "STEPS", "CALORIES", "DISTANCE", "SPO", "HEART_RATE"))
    private val workout = Table("HUAWEI_WORKOUT_SUMMARY_SAMPLE", listOf("WORKOUT_ID", "DEVICE_ID", "START_TIMESTAMP", "END_TIMESTAMP", "TYPE", "CALORIES"))
    private val summary = Table("BASE_ACTIVITY_SUMMARY", listOf("_id", "NAME", "START_TIME", "END_TIME", "ACTIVITY_KIND", "DEVICE_ID"))
    private val device = Table("DEVICE", listOf("_id", "NAME", "MANUFACTURER", "IDENTIFIER", "TYPE", "MODEL", "ALIAS"))
    private val meta = listOf(Table("android_metadata", listOf("locale")), Table("sqlite_sequence", listOf("name", "seq")))
    private val all = HealthMetric.names

    private fun plan(vararg t: Table) = GadgetbridgeSchema.plan(meta + t.toList()) as GadgetbridgeSchema.Plan

    @Test fun samplesAreFoundByTheirColumns() {
        val p = plan(band, huawei, device)
        assertEquals(listOf("MI_BAND_ACTIVITY_SAMPLE", "HUAWEI_ACTIVITY_SAMPLE"), p.samples.map { it.table })
        assertEquals(mapOf("steps" to "STEPS", "heart_rate" to "HEART_RATE"), p.samples[0].metrics)
        // Huawei's blood oxygen column is SPO; the time column's own spelling is kept for the query.
        assertEquals(mapOf("steps" to "STEPS", "heart_rate" to "HEART_RATE", "spo2" to "SPO"), p.samples[1].metrics)
        assertEquals("timestamp", p.samples[1].ts)
        assertEquals("DEVICE_ID", p.samples[1].device)
        assertEquals("DEVICE", p.devices?.name)
    }

    @Test fun workoutsAreSessionsAndSleepIsNotGuessed() {
        val p = plan(huawei, workout, summary)
        assertEquals(listOf("exercise", "exercise"), p.sessions.map { it.metric })
        assertEquals("TYPE", p.sessions[0].kind)
        assertEquals("ACTIVITY_KIND", p.sessions[1].kind)
        assertTrue(p.notes.single().startsWith("sleep:"))
        // Summary tables are not samples, even with a TIMESTAMP-like column.
        assertTrue(p.samples.none { it.table.contains("SUMMARY") })
    }

    @Test fun aSleepTableWithStartAndEndIsSleep() {
        val sleep = Table("XIAOMI_SLEEP_TIME_SAMPLE", listOf("TIMESTAMP", "DEVICE_ID", "WAKEUP_TIME", "IS_AWAKE"))
        val p = plan(band, sleep)
        val s = p.sessions.single()
        assertEquals("sleep", s.metric)
        assertEquals("TIMESTAMP", s.start)
        assertEquals("WAKEUP_TIME", s.end)
        assertTrue(p.notes.isEmpty())
    }

    @Test fun anUnknownSchemaListsItsTables() {
        val r = GadgetbridgeSchema.plan(meta + listOf(device, Table("USER", listOf("_id", "NAME")), Table("BATTERY_LEVEL", listOf("TIMESTAMP", "LEVEL"))))
        r as GadgetbridgeSchema.Unsupported
        assertEquals(listOf("DEVICE", "USER", "BATTERY_LEVEL"), r.tables)
    }

    @Test fun sampleRowsBecomeReadings() {
        val p = plan(huawei, device).samples.single()
        val t0 = 1_790_000_000L // seconds, on the hour
        val h = t0 - t0 % 3600
        val rows = listOf(
            mapOf("timestamp" to h, "DEVICE_ID" to 1L, "STEPS" to 30L, "HEART_RATE" to 72L, "SPO" to 97L),
            mapOf("timestamp" to h + 60, "DEVICE_ID" to 1L, "STEPS" to 45L, "HEART_RATE" to 255L, "SPO" to -1L),
            mapOf("timestamp" to h + 120, "DEVICE_ID" to 1L, "STEPS" to 0L, "HEART_RATE" to 0L, "SPO" to 0L),
            mapOf("timestamp" to h + 3600, "DEVICE_ID" to 1L, "STEPS" to 10L, "HEART_RATE" to 80L, "SPO" to null),
            mapOf("timestamp" to h + 7200, "DEVICE_ID" to 2L, "STEPS" to 5L, "HEART_RATE" to null, "SPO" to null),
        )
        val devices = mapOf(1L to "HUAWEI WATCH GT 5 Pro-8A2")
        val out = GadgetbridgeSchema.samples(p, rows, devices, all, (h * 1000)..((h + 10_000) * 1000))
        val src = "gadgetbridge:huawei-watch-gt-5-pro-8a2"
        val steps = out.filter { it.metric == "steps" }
        assertEquals(listOf(75.0, 10.0, 5.0), steps.map { it.value })
        assertEquals(listOf(h * 1000, (h + 3600) * 1000, (h + 7200) * 1000), steps.map { it.ts })
        assertEquals(h * 1000 + 3_600_000, steps[0].tsEnd)
        // An unknown device keeps the source plain.
        assertEquals(listOf(src, src, "gadgetbridge"), steps.map { it.source })
        // 255 and 0 mean "no reading": dropped, not passed on.
        assertEquals(listOf(72.0, 80.0), out.filter { it.metric == "heart_rate" }.map { it.value })
        assertEquals(listOf(97.0), out.filter { it.metric == "spo2" }.map { it.value })
        assertTrue(out.all { it.unit == HealthMetric.unit(it.metric) })
    }

    @Test fun onlyWantedMetricsInRange() {
        val p = plan(band).samples.single()
        val ms = 1_790_000_000_000L // a table that stores milliseconds
        val rows = listOf(mapOf("TIMESTAMP" to ms, "STEPS" to 10L, "HEART_RATE" to 70L), mapOf("TIMESTAMP" to ms + 86_400_000L, "STEPS" to 10L, "HEART_RATE" to 70L))
        val out = GadgetbridgeSchema.samples(p, rows, emptyMap(), listOf("heart_rate"), ms..(ms + 1000))
        assertEquals(1, out.size)
        assertEquals("heart_rate", out[0].metric)
        assertEquals(ms, out[0].ts)
        assertEquals("gadgetbridge", out[0].source)
    }

    @Test fun sessionRowsBecomeMinutes() {
        val s = plan(workout, device).sessions.single()
        val start = 1_790_000_000_000L
        val rows = listOf(
            mapOf("START_TIMESTAMP" to start, "END_TIMESTAMP" to start + 45 * 60_000L, "TYPE" to 3L, "DEVICE_ID" to 7L),
            mapOf("START_TIMESTAMP" to start, "END_TIMESTAMP" to start, "TYPE" to 3L, "DEVICE_ID" to 7L),
        )
        val out = GadgetbridgeSchema.sessions(s, rows, mapOf(7L to "Watch"), start..(start + 1))
        assertEquals(1, out.size)
        assertEquals(45.0, out[0].value, 0.001)
        assertEquals("3", out[0].kind)
        assertEquals("gadgetbridge:watch", out[0].source)
        assertEquals("min", out[0].unit)
    }

    @Test fun timeUnitsAndRanges() {
        assertEquals(1_790_000_000_000L, GadgetbridgeSchema.toMillis(1_790_000_000L))
        assertEquals(1_790_000_000_000L, GadgetbridgeSchema.toMillis(1_790_000_000_000L))
        assertEquals(1_790_000_000L..1_790_000_010L, GadgetbridgeSchema.rangeIn(1_790_000_000L, 1_790_000_000_000L..1_790_000_010_000L))
        assertEquals(5L..9L, GadgetbridgeSchema.rangeIn(1_790_000_000_000L, 5L..9L))
    }

    @Test fun theNewestExportIsPicked() {
        fun doc(name: String, modified: Long, size: Long = 100) = GadgetbridgeFiles.Doc(name, name, null, modified, size)
        assertTrue(GadgetbridgeFiles.candidate(doc("Gadgetbridge", 1)))
        assertTrue(GadgetbridgeFiles.candidate(doc("export.db", 1)))
        assertTrue(GadgetbridgeFiles.candidate(doc("gadgetbridge_2026.zip", 1)))
        assertFalse(GadgetbridgeFiles.candidate(doc("Gadgetbridge-journal", 1)))
        assertFalse(GadgetbridgeFiles.candidate(doc("notes.txt", 1)))
        val picked = GadgetbridgeFiles.newest(listOf(doc("Gadgetbridge", 10), doc("old.db", 5), doc("x.txt", 99), doc("empty.db", 50, size = 0)))
        assertEquals("Gadgetbridge", picked?.name)
        assertNull(GadgetbridgeFiles.newest(listOf(doc("x.txt", 1))))
        assertTrue(GadgetbridgeFiles.zipEntry("database/Gadgetbridge"))
        assertTrue(GadgetbridgeFiles.zipEntry("Gadgetbridge.db"))
        assertFalse(GadgetbridgeFiles.zipEntry("preferences/settings.xml"))
    }
}
