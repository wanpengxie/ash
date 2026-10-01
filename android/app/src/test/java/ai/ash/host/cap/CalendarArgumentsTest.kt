package ai.ash.host.cap

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class CalendarArgumentsTest {
    private fun validCreate() = JSONObject().put("calendar_id", 1).put("title", "Fixture")
        .put("start_ms", 1_800_000_000_000L).put("end_ms", 1_800_000_060_000L)

    @Test fun malformedCreateNeverTouchesProvider() {
        val bad = listOf(
            validCreate().put("calendar_id", "1"),
            validCreate().put("calendar_id", 1.5),
            validCreate().put("title", JSONObject().put("text", "Fixture")),
            validCreate().put("start_ms", 1_800_000_000_000.5),
            validCreate().put("end_ms", "1800000060000"),
            validCreate().put("description", JSONObject()),
            validCreate().put("time_zone", "No/Such_Zone"),
            validCreate().put("callback_url", "https://example.invalid"),
        )
        var providerCalls = 0
        for (input in bad) {
            val result = CalendarArguments.create(input, { providerCalls++; "provider" }, { "rejected" })
            assertEquals("rejected", result)
        }
        assertEquals(0, providerCalls)
        assertEquals("provider", CalendarArguments.create(validCreate(), { providerCalls++; "provider" }, { "rejected" }))
        assertEquals(1, providerCalls)
    }

    @Test fun malformedSearchNeverTouchesProvider() {
        val bad = listOf(
            JSONObject().put("start_ms", "1800000000000"),
            JSONObject().put("start_ms", 1.5),
            JSONObject().put("end_ms", 2.5),
            JSONObject().put("limit", "5"),
            JSONObject().put("limit", 51),
            JSONObject().put("query", JSONObject()),
            JSONObject().put("callback_url", "https://example.invalid"),
        )
        var providerCalls = 0
        for (input in bad) {
            val result = CalendarArguments.search(input, 1_800_000_000_000L, { providerCalls++; "provider" }, { "rejected" })
            assertEquals("rejected", result)
        }
        assertEquals(0, providerCalls)
        assertEquals("provider", CalendarArguments.search(JSONObject().put("limit", 5), 1_800_000_000_000L,
            { providerCalls++; "provider" }, { "rejected" }))
        assertEquals(1, providerCalls)
    }
}
