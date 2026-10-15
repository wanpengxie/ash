package ai.ash.ui

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LedgerMessagesTest {
    private val message = JSONObject("""{"from":"service:devices","to":"person:owner","word":"device.changed","body":{"device":"d1","who":"agent:main"},"payload":{"extra":true}}""")

    @Test fun pushPreservesTheWholeLedgerMessage() {
        val out = LedgerMessages.of(JSONObject().put("t", "sync.msg").put("message", message)).single()
        assertSame(message, out)
        assertEquals("agent:main", out.getJSONObject("body").getString("who"))
        assertTrue(out.getJSONObject("payload").getBoolean("extra"))
    }

    @Test fun initialPagesAndEmptyPagesUseTheSameObjects() {
        val frame = JSONObject().put("t", "sync.page").put("messages", org.json.JSONArray().put(message))
        assertSame(message, LedgerMessages.of(frame).single())
        assertTrue(LedgerMessages.of(JSONObject("""{"t":"sync.page","messages":[],"end":true}""")).isEmpty())
        assertTrue(LedgerMessages.of(JSONObject("""{"t":"send.result","ok":true}""")).isEmpty())
    }
}
