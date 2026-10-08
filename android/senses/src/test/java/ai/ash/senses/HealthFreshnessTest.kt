package ai.ash.senses

import ai.ash.senses.HealthFreshness.Check
import ai.ash.senses.health.GadgetbridgeSchema
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.time.ZoneId

/** A source that stops quietly is noticed by its newest reading, and Ash is told once. */
class HealthFreshnessTest {
    private val zone = ZoneId.of("Asia/Shanghai")
    private val hour = 3_600_000L
    /** 2026-10-08 04:00 in Shanghai. */
    private val now = 1_791_403_200_000L
    /** The watch's last reading: 2026-10-07 02:00 in Shanghai, 26 hours earlier. */
    private val lastWatch = now - 26 * hour
    private val hours = { s: String -> SenseConfig().staleHours(s) }

    @Test fun staleGoesByTheNewestReadingAndTheThreshold() {
        assertEquals(true, HealthFreshness.stale(Check("gadgetbridge", true, lastWatch), 12, now))
        assertEquals(false, HealthFreshness.stale(Check("gadgetbridge", true, now - 11 * hour), 12, now))
        // Set up but nothing at all: stale. Not set up, unreadable, or not checked: no verdict.
        assertEquals(true, HealthFreshness.stale(Check("gadgetbridge", true, null), 12, now))
        assertNull(HealthFreshness.stale(Check("gadgetbridge", false, null), 12, now))
        assertNull(HealthFreshness.stale(Check("gadgetbridge", true, lastWatch, "source_unavailable: x"), 12, now))
        assertNull(HealthFreshness.stale(Check("xiaomi_scale", true, lastWatch), 0, now))
    }

    @Test fun ashIsToldOnceWhenASourceGoesStaleAndOnceWhenItComesBack() {
        val first = HealthFreshness.step(emptyMap(), listOf(Check("gadgetbridge", true, lastWatch)), hours, now, zone)
        assertEquals(mapOf("gadgetbridge" to HealthFreshness.STALE), first.states)
        assertEquals(1, first.events.size)
        val e = first.events[0]
        assertEquals(setOf("source", "state", "ts", "stale_hours", "summary", "last_data_ts"), e.keySet())
        assertEquals("stale", e.getString("state"))
        assertEquals(lastWatch, e.getLong("last_data_ts"))
        assertEquals("手表数据（Gadgetbridge）已经 26 小时没有新数据了，最后一条是 10月7日 02:00", e.getString("summary"))
        // Checked again (the export file rewritten, nothing new): not told again.
        val again = HealthFreshness.step(first.states, listOf(Check("gadgetbridge", true, lastWatch)), hours, now + 3 * hour, zone)
        assertTrue(again.events.isEmpty())
        // The watch sends again: told once that it is back.
        val back = HealthFreshness.step(again.states, listOf(Check("gadgetbridge", true, now + 5 * hour)), hours, now + 6 * hour, zone)
        assertEquals(mapOf("gadgetbridge" to HealthFreshness.FRESH), back.states)
        assertEquals("fresh", back.events.single().getString("state"))
        assertTrue(back.events.single().getString("summary").startsWith("手表数据（Gadgetbridge）又有新数据了"))
        assertTrue(HealthFreshness.step(back.states, listOf(Check("gadgetbridge", true, now + 7 * hour)), hours, now + 8 * hour, zone).events.isEmpty())
    }

    @Test fun nothingIsToldForSourcesThatNeverHadDataCannotBeReadOrAreNotChecked() {
        val checks = listOf(
            Check("health_connect", true, null),
            Check("gadgetbridge", true, null, "source_unavailable: no export"),
            Check("xiaomi_scale", true, now - 30 * 24 * hour),
        )
        val o = HealthFreshness.step(mapOf("gadgetbridge" to HealthFreshness.FRESH), checks, hours, now, zone)
        assertTrue(o.events.isEmpty())
        // Unreadable keeps its state; the scale (threshold 0) is not tracked.
        assertEquals(mapOf("gadgetbridge" to HealthFreshness.FRESH, "health_connect" to HealthFreshness.STALE_SILENT), o.states)
        // A source that never had data and then gets some is fresh, with nothing to report as back.
        val later = HealthFreshness.step(o.states, listOf(Check("health_connect", true, now)), hours, now, zone)
        assertTrue(later.events.isEmpty())
        // The owner can have the scale checked too.
        val scale = HealthFreshness.step(emptyMap(), listOf(Check("xiaomi_scale", true, now - 30 * 24 * hour)), { 24 * 7 }, now, zone)
        assertEquals("体重秤已经 30 天没有新数据了，最后一条是 9月8日 04:00", scale.events.single().getString("summary"))
        // A source no longer set up is forgotten.
        assertEquals(emptyMap<String, String>(), HealthFreshness.step(mapOf("gadgetbridge" to "stale"), listOf(Check("gadgetbridge", false, null)), hours, now, zone).states)
    }

    @Test fun healthSourcesShowsTheDataTimeAndTheVerdict() {
        val status = JSONObject().put("id", "gadgetbridge")
        HealthFreshness.annotate(status, Check("gadgetbridge", true, lastWatch), 12, now, zone)
        assertEquals(lastWatch, status.getLong("latest_data_ts"))
        assertEquals(26.0, status.getDouble("latest_data_age_h"), 0.0)
        assertTrue(status.getBoolean("stale"))
        assertEquals(12, status.getInt("stale_hours"))
        assertTrue(status.getString("stale_summary").contains("26 小时"))
        val fresh = JSONObject()
        HealthFreshness.annotate(fresh, Check("health_connect", true, now - hour), 12, now, zone)
        assertFalse(fresh.getBoolean("stale"))
        assertFalse(fresh.has("stale_summary"))
        val unset = JSONObject()
        HealthFreshness.annotate(unset, Check("xiaomi_scale", false, null), 0, now, zone)
        assertEquals(0, unset.length())
    }

    @Test fun thresholdsAreConfiguredPerSource() {
        val c = SenseConfig.apply(SenseConfig(), JSONObject().put("stale_hours", JSONObject().put("gadgetbridge", 24)))
        assertEquals(24, c.staleHours("gadgetbridge"))
        assertEquals(12, c.staleHours("health_connect"))
        assertEquals(0, c.staleHours("xiaomi_scale"))
        // Stored and read back.
        assertEquals(24, SenseConfig.stored(c.toJson().toString()).staleHours("gadgetbridge"))
        for (bad in listOf(JSONObject().put("watch", 3), JSONObject().put("gadgetbridge", -1), JSONObject().put("gadgetbridge", 721), "12")) {
            try { SenseConfig.apply(c, JSONObject().put("stale_hours", bad)); fail("accepted $bad") } catch (e: SenseError) { assertEquals("bad_args", e.code) }
        }
    }

    @Test fun aSourceEventIsOneItemItselfAndBelongsToHealth() {
        val e = JSONObject().put("source", "gadgetbridge").put("state", "stale").put("ts", 10L)
        assertNull(Batches.without(Batches.SOURCE, e, 0L..10L))
        assertEquals(e, Batches.without(Batches.SOURCE, e, 11L..20L))
        assertEquals("health", Batches.kindOf(Batches.SOURCE))
        assertTrue(Batches.SOURCE in Batches.WORDS)
    }

    @Test fun theNewestRealReadingIsFoundPerMetricAndDevice() {
        val latest = GadgetbridgeSchema.latest(listOf(
            GadgetbridgeSchema.Found("steps", "gadgetbridge:watch", 100L),
            GadgetbridgeSchema.Found("heart_rate", "gadgetbridge:watch", 300L),
            GadgetbridgeSchema.Found("heart_rate", "gadgetbridge:band", 200L),
        ))
        assertEquals(300L, latest.ts)
        assertEquals(mapOf("heart_rate" to 300L, "steps" to 100L), latest.byMetric)
        assertEquals(mapOf("gadgetbridge:band" to 200L, "gadgetbridge:watch" to 300L), latest.bySource)
        assertNull(GadgetbridgeSchema.latest(emptyList()).ts)
        // "No reading" marks are not data.
        assertFalse(GadgetbridgeSchema.valid("heart_rate", 255.0))
        assertFalse(GadgetbridgeSchema.valid("steps", 0.0))
        assertTrue(GadgetbridgeSchema.valid("spo2", 97.0))
        assertEquals("\"HR\" >= 25 AND \"HR\" <= 240", GadgetbridgeSchema.validSql("heart_rate", "\"HR\""))
    }
}
