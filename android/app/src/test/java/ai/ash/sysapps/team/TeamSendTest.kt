package ai.ash.sysapps.team

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TeamSendTest {
    @Test fun asyncQuestionAndRetryKeepTheSameIdentityAndSeparateFromChat() {
        val pending = TeamSend("client-one", "agent:h", "只在团队回答")
        val sent = pending.request()
        assertFalse(sent.getBoolean("wait")); assertEquals("ask", sent.getString("word")); assertEquals("service:agents", sent.getString("to"))
        assertEquals("client-one", sent.getString("client_id"))
        val restored = TeamSend.read(pending.copy(error = "结果未知").json())!!
        assertEquals(sent.toString(), restored.request().toString())
    }
    @Test fun followUpOnlyUsesExistingAgentAndTextAndRestoresOriginalContextOnRetry() {
        val pending=TeamSend("same-client","agent:h","请补退款条件",context="原委托 m-original：比较住宿")
        val restored=TeamSend.read(pending.copy(error="连接中断").json())!!
        val body=restored.request().getJSONObject("body")
        assertEquals(setOf("agent","text"),body.keys().asSequence().toSet())
        assertEquals("agent:h",body.getString("agent"))
        assertEquals("原委托 m-original：比较住宿\n\n追问：请补退款条件",body.getString("text"))
        assertEquals(pending.request().toString(),restored.request().toString())
    }
    @Test fun definitiveRefusalCanBeEndedButUnknownDeliveryMustReuseItsId() {
        val pending = TeamSend("same", "agent:h", "hello")
        assertFalse(pending.copy(code = "offline").refused)
        assertTrue(pending.copy(code = "forbidden").refused)
        assertEquals("same", TeamSend.read(pending.copy(code = "offline").json())!!.request().getString("client_id"))
    }
    @Test fun receiptNeedsLedgerIdentityAndNeverMistakesReplyForDelivery() {
        val pending = TeamSend("c", "agent:h", "hello")
        assertNull(pending.receipt(JSONObject("""{"ok":true}""")))
        val accepted = pending.receipt(JSONObject("""{"message":{"id":"m-one","seq":3}}"""))!!
        assertEquals("m-one", accepted.ledgerId); assertEquals("c", accepted.clientId)
        assertEquals(accepted, TeamSend.read(accepted.json()))
    }
}
