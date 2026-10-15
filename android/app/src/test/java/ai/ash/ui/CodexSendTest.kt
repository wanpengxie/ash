package ai.ash.ui

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** A message to a Codex session waits as its own row, stored, until the session shows the turn it started. */
class CodexSendTest {
    private fun send(id: String, thread: String, turn: String? = null, device: String = "device:mac") =
        Pending(id, device, JSONObject().put("op", "send").put("thread", thread).put("text", "hi"), if (turn == null) Pending.SENDING else Pending.SENT, turn)

    private fun detail(vararg turns: String) = CodexModel.detail(JSONObject().put("id", "t1").put("turns", JSONArray().apply {
        for (t in turns) put(JSONObject().put("id", t).put("items", JSONArray().put(JSONObject().put("kind", "user").put("text", "hi")).put(JSONObject().put("kind", "agent").put("text", "ok"))))
    }))!!

    @Test fun storedWithItsComputerSessionAndId() {
        val back = Pending.fromStored(JSONObject(send("c1", "t1").meta().toString()), null)!!
        assertEquals(listOf("device:mac", "t1", "c1"), listOf(back.to, back.body.optString("thread"), back.clientId))
    }

    @Test fun settledOnlyWhenTheSessionShowsTheTurnItStarted() {
        val ops = listOf(send("c1", "t1", turn = "u2"), send("c2", "t1"), send("c3", "t2", turn = "u2"), send("c4", "t1", turn = "u2", device = "device:mini"))
        assertEquals(emptyList<String>(), CodexModel.settled(ops, "device:mac", "t1", detail("u1")))
        assertEquals(listOf("c1"), CodexModel.settled(ops, "device:mac", "t1", detail("u1", "u2")))
    }

    @Test fun theTurnsFirstMessageTakesTheWaitingRowsKey() {
        val turn = detail("u2").turns.single()
        val sentAs = { t: String -> if (t == "u2") "c1" else null }
        assertEquals("c1", CodexModel.itemKey(turn, 0, sentAs))
        assertEquals("u2~1", CodexModel.itemKey(turn, 1, sentAs))
        assertEquals("u2~0", CodexModel.itemKey(turn, 0) { null })
    }
}
