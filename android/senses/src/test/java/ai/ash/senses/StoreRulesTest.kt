package ai.ash.senses

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The store's rules that do not need a database: retention, batching, deleting from undelivered batches, steps. */
class StoreRulesTest {
    private val now = 1_800_000_000_000L
    private val day = 86_400_000L

    @Test fun retentionCutsEveryTableAtTheSameAge() {
        val plan = Retention.plan(now, 30)
        assertEquals(setOf("location", "activity", "steps", "health", "outbox"), plan.keys)
        assertTrue(plan.values.all { it == now - 30 * day })
        // Out-of-range settings are clamped, never "keep nothing" or overflow.
        assertTrue(Retention.plan(now, 0).values.all { it == now - day })
        assertTrue(Retention.plan(now, 100_000).values.all { it == now - SenseConfig.MAX_RETENTION * day })
    }

    @Test fun retentionKeepsTheOpenSegment() {
        assertEquals("DELETE FROM activity WHERE ts_start < ? AND ts_end IS NOT NULL", Retention.statement("activity"))
        assertEquals("DELETE FROM location WHERE ts < ?", Retention.statement("location"))
        assertEquals("DELETE FROM outbox WHERE created < ?", Retention.statement("outbox"))
    }

    @Test fun batchesHoldAtMost500Items() {
        var n = 0
        val items = (1..1201).map { JSONObject().put("ts", it.toLong()) }
        val batches = Batches.split(items) { "b${n++}" }
        assertEquals(listOf(500, 500, 201), batches.map { it.getJSONArray("items").length() })
        assertEquals(listOf("b0", "b1", "b2"), batches.map { it.getString("batch_id") })
        val env = Batches.envelope("b0", Batches.LOCATION, batches[0])
        assertEquals(setOf("batch_id", "word", "body"), env.keySet())
    }

    @Test fun deletingTakesRowsOutOfUndeliveredBatches() {
        val body = JSONObject().put("batch_id", "x").put("items", JSONArray().put(JSONObject().put("ts", 5L)).put(JSONObject().put("ts", 15L)))
        val kept = Batches.without(Batches.LOCATION, body, 0L..10L)!!
        assertEquals(1, kept.getJSONArray("items").length())
        assertEquals(15L, kept.getJSONArray("items").getJSONObject(0).getLong("ts"))
        assertEquals(2, body.getJSONArray("items").length())
        assertNull(Batches.without(Batches.LOCATION, body, 0L..20L))
        val seg = JSONObject().put("items", JSONArray().put(JSONObject().put("ts_start", 5L).put("state", "still")))
        assertNull(Batches.without(Batches.ACTIVITY, seg, 0L..10L))
        val fence = JSONObject().put("name", "home").put("transition", "enter").put("ts", 7L)
        assertNull(Batches.without(Batches.GEOFENCE, fence, 0L..10L))
        assertEquals(fence, Batches.without(Batches.GEOFENCE, fence, 8L..10L))
        assertEquals("location", Batches.kindOf(Batches.GEOFENCE))
    }

    @Test fun eventItemsHaveExactlyTheAgreedFields() {
        val fix = Fix(1L, 31.0, 121.0, 12.5, "fused", false, 1.2)
        assertEquals(setOf("ts", "lat", "lon", "accuracy_m", "provider"), fix.toEvent().keySet())
        assertEquals(true, fix.copy(mocked = true).toEvent().getBoolean("is_mocked"))
        assertEquals(setOf("ts_start", "state"), Segment(1, 5, null, "walking").toJson().keySet())
        assertEquals(setOf("ts_start", "ts_end", "state"), Segment(1, 5, 9, "walking").toJson().keySet())
        assertEquals(setOf("ts", "metric", "value", "unit", "source"), HealthRow(1, "sleep", 420.0, "gadgetbridge", 2, "x").toEvent().keySet())
    }

    @Test fun thinningKeepsEnds() {
        val list = (0 until 1000).toList()
        val t = Batches.thin(list, 10)
        assertEquals(10, t.size)
        assertEquals(0, t.first()); assertEquals(999, t.last())
        assertEquals(list.take(5), Batches.thin(list.take(5), 10))
    }

    @Test fun stepsTodayCountFromMidnight() {
        val mid = now - now % day
        val s = listOf(StepSample(mid - 2 * 3_600_000L, 1000, 1), StepSample(mid + 2 * 3_600_000L, 1400, 1), StepSample(mid + 5 * 3_600_000L, 2400, 1))
        // Half the gap across midnight is today's.
        assertEquals(StepsToday(1200, mid, true), StepMath.today(s, mid, mid + 6 * 3_600_000L))
        // A reboot restarts the counter: its new count is all new.
        val rebooted = s + StepSample(mid + 6 * 3_600_000L, 300, 2)
        assertEquals(1500L, StepMath.today(rebooted, mid, mid + 7 * 3_600_000L)!!.steps)
        // Without a reading before midnight, the count starts at the first one and says so.
        val partial = StepMath.today(s.drop(1), mid, mid + 6 * 3_600_000L)!!
        assertEquals(StepsToday(1000, mid + 2 * 3_600_000L, false), partial)
        assertNull(StepMath.today(s.take(1), mid, mid + 6 * 3_600_000L))
    }

    @Test fun geofencesCrossOnlyWithConfidence() {
        val home = Geofence("home", 31.0, 121.0, 100.0)
        val meters = 1.0 / 111_195.0
        // First sight only sets the state.
        var (inside, events) = Geo.evaluate(listOf(home), emptyMap(), 31.0, 121.0, 10.0, 1)
        assertEquals(mapOf("home" to true), inside); assertTrue(events.isEmpty())
        // At the edge, within the point's uncertainty: no change.
        Geo.evaluate(listOf(home), inside, 31.0 + 150 * meters, 121.0, 80.0, 2).let { (i, e) -> assertEquals(inside, i); assertTrue(e.isEmpty()) }
        // Clearly outside: exit.
        Geo.evaluate(listOf(home), inside, 31.0 + 500 * meters, 121.0, 20.0, 3).let { (i, e) -> inside = i; events = e }
        assertEquals(listOf(GeofenceEvent("home", "exit", 3)), events)
        // Back: enter.
        assertEquals(listOf(GeofenceEvent("home", "enter", 4)), Geo.evaluate(listOf(home), inside, 31.0, 121.0, 20.0, 4).second)
        // Too vague to decide anything; a removed fence is forgotten.
        assertTrue(Geo.evaluate(listOf(home), inside, 31.1, 121.0, 5000.0, 5).second.isEmpty())
        assertEquals(emptyMap<String, Boolean>(), Geo.evaluate(emptyList(), inside, 31.0, 121.0, 10.0, 6).first)
    }
}
