package ai.ash.senses

import ai.ash.bridge.Bridge
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

class SenseArgsTest {
    private val utc = ZoneOffset.UTC
    private val now = 1_800_000_000_000L

    private fun bad(block: () -> Unit) {
        val e = assertThrows(SenseError::class.java) { block() }
        assertEquals("bad_args", e.code)
    }

    @Test fun everyToolIsListedForAshsPolicies() {
        assertEquals(Bridge.SENSES_TOOLS, SenseCapabilities.list.map { it.name })
    }

    @Test fun everyToolHasAnObjectSchema() {
        for (c in SenseCapabilities.list) assertEquals(c.name, "object", c.schema.getString("type"))
    }

    @Test fun timesInEveryAcceptedForm() {
        assertEquals(1_790_000_000_000L, SenseArgs.time(1_790_000_000_000L, "from", utc))
        assertEquals(1_790_000_000_000L, SenseArgs.time("2026-09-21T14:13:20Z", "from", utc))
        assertEquals(1_790_000_000_000L, SenseArgs.time("2026-09-21T22:13:20+08:00", "from", utc))
        assertEquals(1_790_000_000_000L, SenseArgs.time("2026-09-21T14:13:20", "from", utc))
        assertEquals(1_790_000_000_000L - 51_200_000L, SenseArgs.time("2026-09-21", "from", utc))
        bad { SenseArgs.time("yesterday", "from", utc) }
        bad { SenseArgs.time(1_790_000_000L, "from", utc) } // seconds, not ms
        bad { SenseArgs.time(true, "from", utc) }
    }

    @Test fun ranges() {
        assertEquals((now - 86_400_000L) until now, SenseArgs.range(JSONObject(), now, 86_400_000L, utc))
        bad { SenseArgs.range(JSONObject().put("from", "2026-09-22").put("to", "2026-09-21"), now, 1, utc) }
        bad { SenseArgs.range(JSONObject().put("from", "2020-01-01").put("to", "2026-01-01"), now, 1, utc) }
        assertEquals(0L until Long.MAX_VALUE, SenseArgs.deleteRange(JSONObject(), utc))
    }

    @Test fun unknownKeysAreRefused() = bad { SenseArgs.only(JSONObject().put("form", 1), setOf("from", "to")) }

    @Test fun metrics() {
        assertEquals(HealthMetric.names, SenseArgs.metrics(JSONObject()))
        assertEquals(listOf("steps", "weight"), SenseArgs.metrics(JSONObject().put("metrics", JSONArray(listOf("steps", "weight", "steps")))))
        bad { SenseArgs.metrics(JSONObject().put("metrics", JSONArray(listOf("mood")))) }
        bad { SenseArgs.metrics(JSONObject().put("metrics", JSONArray())) }
        bad { SenseArgs.metrics(JSONObject().put("metrics", "steps")) }
    }

    @Test fun limitsAndKinds() {
        assertEquals(500, SenseArgs.limit(JSONObject(), "max_points", 500, 5000))
        assertEquals(20, SenseArgs.limit(JSONObject().put("max_points", 20), "max_points", 500, 5000))
        bad { SenseArgs.limit(JSONObject().put("max_points", 0), "max_points", 500, 5000) }
        bad { SenseArgs.limit(JSONObject().put("max_points", 2.5), "max_points", 500, 5000) }
        assertEquals("all", SenseArgs.deleteKind(JSONObject().put("kind", "all")))
        bad { SenseArgs.deleteKind(JSONObject()) }
        bad { SenseArgs.deleteKind(JSONObject().put("kind", "contacts")) }
    }

    @Test fun summaryRanges() {
        val (p, day) = SenseArgs.summaryRange(JSONObject().put("date", "2026-10-06"), now, utc)
        assertEquals("day", p)
        assertEquals(86_400_000L, day.last + 1 - day.first)
        val (_, week) = SenseArgs.summaryRange(JSONObject().put("period", "week").put("date", "2026-10-06"), now, utc)
        assertEquals(7 * 86_400_000L, week.last + 1 - week.first)
        assertEquals(day.last, week.last)
        bad { SenseArgs.summaryRange(JSONObject().put("period", "month"), now, utc) }
        bad { SenseArgs.summaryRange(JSONObject().put("date", "06/10/2026"), now, utc) }
    }

    @Test fun configureChangesOnlyWhatIsGiven() {
        val c = SenseConfig()
        assertFalse(c.recording)
        val next = SenseConfig.apply(c, JSONObject().put("recording", true).put("interval_min", 15))
        assertEquals(SenseConfig(recording = true, intervalMin = 15), next)
        val fenced = SenseConfig.apply(next, JSONObject().put("geofences", JSONArray().put(JSONObject().put("name", "office").put("lat", 31.2).put("lon", 121.5).put("radius", 150))))
        assertEquals(listOf(Geofence("office", 31.2, 121.5, 150.0)), fenced.geofences)
        assertEquals(15, fenced.intervalMin)
        assertEquals(fenced, SenseConfig.stored(fenced.toJson().toString()))
    }

    @Test fun configureRefusesBadValues() {
        val c = SenseConfig()
        bad { SenseConfig.apply(c, JSONObject().put("recording", "yes")) }
        bad { SenseConfig.apply(c, JSONObject().put("interval_min", 1)) }
        bad { SenseConfig.apply(c, JSONObject().put("interval_min", 1000)) }
        bad { SenseConfig.apply(c, JSONObject().put("accuracy", "best")) }
        bad { SenseConfig.apply(c, JSONObject().put("retention_days", 0)) }
        bad { SenseConfig.apply(c, JSONObject().put("record", true)) }
        val fence = { name: String, lat: Double, r: Double -> JSONObject().put("name", name).put("lat", lat).put("lon", 121.0).put("radius_m", r) }
        bad { SenseConfig.apply(c, JSONObject().put("geofences", JSONArray().put(fence("a", 95.0, 100.0)))) }
        bad { SenseConfig.apply(c, JSONObject().put("geofences", JSONArray().put(fence("a", 31.0, 5.0)))) }
        bad { SenseConfig.apply(c, JSONObject().put("geofences", JSONArray().put(fence("", 31.0, 100.0)))) }
        bad { SenseConfig.apply(c, JSONObject().put("geofences", JSONArray().put(fence("a", 31.0, 100.0)).put(fence("a", 31.1, 100.0)))) }
        bad { SenseConfig.apply(c, JSONObject().put("geofences", JSONArray().put(fence("a", 31.0, 100.0).put("color", "red")))) }
    }

    @Test fun storedGarbageFallsBackToOff() {
        assertEquals(SenseConfig(), SenseConfig.stored("{not json"))
        assertEquals(SenseConfig(), SenseConfig.stored(null))
        assertTrue(SenseConfig.stored("""{"recording":true}""").recording)
    }

    @Test fun summaryNeverAddsSourcesTogether() {
        val rows = listOf(
            HealthRow(10, "steps", 3000.0, "health_connect:a"), HealthRow(20, "steps", 2000.0, "health_connect:a"),
            HealthRow(15, "steps", 4800.0, "gadgetbridge:w"),
            HealthRow(10, "heart_rate", 60.0, "gadgetbridge:w"), HealthRow(20, "heart_rate", 90.0, "gadgetbridge:w"),
            HealthRow(5, "weight", 70.0, "health_connect:s"), HealthRow(25, "weight", 69.5, "health_connect:s"),
            HealthRow(99, "steps", 99999.0, "health_connect:a"),
        )
        val s = HealthSummary.of(rows, 0L until 50L)
        assertEquals(5000.0, s.getJSONObject("steps").getDouble("total"), 0.0)
        assertEquals("health_connect:a", s.getJSONObject("steps").getString("source"))
        assertEquals(75.0, s.getJSONObject("heart_rate").getDouble("avg"), 0.0)
        assertEquals(69.5, s.getJSONObject("weight").getDouble("latest"), 0.0)
    }
}
