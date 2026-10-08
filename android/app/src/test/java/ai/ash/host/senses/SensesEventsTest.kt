package ai.ash.host.senses

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** The batches the senses helper pushes must match the core's contract exactly, or they are not sent on. */
class SensesEventsTest {
    private fun batch(word: String, vararg items: JSONObject, id: String = "b1") =
        JSONObject().put("batch_id", id).put("word", word).put("body", JSONObject().put("batch_id", id).put("items", JSONArray(items.toList()))).toString()

    private val fix = JSONObject().put("ts", 1_790_000_000_000L).put("lat", 31.2).put("lon", 121.5).put("accuracy_m", 12.0).put("provider", "fused")

    @Test fun locationBatches() {
        val e = SensesEvents.parse(batch("sense.location", fix, JSONObject(fix.toString()).put("is_mocked", true)))
        assertNotNull(e)
        assertEquals("b1", e!!.id)
        assertEquals("sense.location", e.word)
        assertEquals("b1", e.body.getString("batch_id"))
        assertNull(SensesEvents.parse(batch("sense.location", JSONObject(fix.toString()).put("speed", 1))))
        assertNull(SensesEvents.parse(batch("sense.location", JSONObject(fix.toString()).put("ts", "now"))))
        assertNull(SensesEvents.parse(batch("sense.location", JSONObject(fix.toString()).apply { remove("provider") })))
    }

    @Test fun activityBatches() {
        val seg = JSONObject().put("ts_start", 1_790_000_000_000L).put("state", "cycling")
        assertNotNull(SensesEvents.parse(batch("sense.activity", seg, JSONObject().put("ts_start", 1L).put("ts_end", 2L).put("state", "still"))))
        assertNull(SensesEvents.parse(batch("sense.activity", JSONObject().put("ts_start", 1L).put("state", "flying"))))
    }

    @Test fun healthBatches() {
        val row = JSONObject().put("ts", 1_790_000_000_000L).put("metric", "steps").put("value", 120).put("unit", "count").put("source", "gadgetbridge:watch")
        assertNotNull(SensesEvents.parse(batch("sense.health", row)))
        assertNull(SensesEvents.parse(batch("sense.health", JSONObject(row.toString()).put("ts_end", 1))))
    }

    @Test fun geofenceEvents() {
        val ok = JSONObject().put("batch_id", "g1").put("word", "sense.geofence").put("body", JSONObject().put("name", "home").put("transition", "exit").put("ts", 1_790_000_000_000L))
        assertNotNull(SensesEvents.parse(ok.toString()))
        ok.getJSONObject("body").put("transition", "near")
        assertNull(SensesEvents.parse(ok.toString()))
    }

    @Test fun sourceEvents() {
        fun env(body: JSONObject) = JSONObject().put("batch_id", "s1").put("word", "sense.source").put("body", body).toString()
        val body = JSONObject().put("source", "gadgetbridge").put("state", "stale").put("ts", 1_791_403_200_000L).put("stale_hours", 12)
            .put("summary", "手表数据（Gadgetbridge）已经 26 小时没有新数据了，最后一条是 10月7日 02:00").put("last_data_ts", 1_791_309_600_000L)
        assertNotNull(SensesEvents.parse(env(body)))
        // last_data_ts is optional; anything else must match.
        assertNotNull(SensesEvents.parse(env(JSONObject(body.toString()).apply { remove("last_data_ts") })))
        assertNull(SensesEvents.parse(env(JSONObject(body.toString()).put("state", "late"))))
        assertNull(SensesEvents.parse(env(JSONObject(body.toString()).put("stale_hours", 0))))
        assertNull(SensesEvents.parse(env(JSONObject(body.toString()).put("summary", ""))))
        assertNull(SensesEvents.parse(env(JSONObject(body.toString()).put("extra", 1))))
        assertNull(SensesEvents.parse(env(JSONObject(body.toString()).apply { remove("summary") })))
    }

    @Test fun envelopeRules() {
        assertNull(SensesEvents.parse(batch("sense.screen", fix)))
        assertNull(SensesEvents.parse(batch("sense.location")))
        assertNull(SensesEvents.parse("not json"))
        // The body's batch id is the event's client id: they must agree.
        val mismatched = JSONObject(batch("sense.location", fix)).put("batch_id", "other").toString()
        assertNull(SensesEvents.parse(mismatched))
        val tooMany = (1..501).map { JSONObject(fix.toString()) }.toTypedArray()
        assertNull(SensesEvents.parse(batch("sense.location", *tooMany)))
        assertNotNull(SensesEvents.parse(batch("sense.location", *tooMany.copyOf(500).requireNoNulls())))
    }

    @Test fun theTransportAcceptsTheNewWords() {
        val t = SenseTransport("http://127.0.0.1:1", "t")
        for (w in SensesEvents.WORDS) {
            // Refused only by the closed port, not by the word check.
            val e = runCatching { t.send(w, JSONObject(), "id") }.exceptionOrNull()
            assertNotNull(e)
            assert(e !is IllegalArgumentException) { "$w refused: $e" }
        }
    }
}
