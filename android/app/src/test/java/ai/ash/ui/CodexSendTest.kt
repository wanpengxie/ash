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
        for (t in turns) put(JSONObject().put("id", t).put("items", JSONArray().put(JSONObject().put("kind", "user").put("text", "hi").put("client_id", if (t == "u2") "c1" else "another")).put(JSONObject().put("kind", "agent").put("text", "ok"))))
    }))!!

    @Test fun storedWithItsComputerSessionAndId() {
        val back = Pending.fromStored(JSONObject(send("c1", "t1").meta().toString()), null)!!
        assertEquals(listOf("device:mac", "t1", "c1"), listOf(back.to, back.body.optString("thread"), back.clientId))
    }

    @Test fun settledOnlyWhenTheSessionShowsItsExactClientId() {
        val ops = listOf(send("c1", "t1", turn = "u2"), send("c2", "t1"), send("c3", "t2", turn = "u2"), send("c4", "t1", turn = "u2", device = "device:mini"))
        assertEquals(emptyList<String>(), CodexModel.settled(ops, "device:mac", "t1", detail("u1")))
        assertEquals(listOf("c1"), CodexModel.settled(ops, "device:mac", "t1", detail("u1", "u2")))
    }

    @Test fun theTurnsFirstMessageTakesTheWaitingRowsKey() {
        val turn = detail("u2").turns.single()
        assertEquals("c1", CodexModel.itemKey(turn, 0))
        assertEquals("u2~1", CodexModel.itemKey(turn, 1))
    }

    @Test fun onlyTheExactClientIdInTheTranscriptSettlesAPendingMessage() {
        val d = CodexModel.detail(JSONObject("""{"id":"t1","turns":[{"id":"u2","items":[
            {"kind":"user","text":"same text","client_id":"agent-c1"},
            {"kind":"user","text":"same text","client_id":"owner-c1"}]}]}"""))!!
        val mine = listOf(send("owner-c1", "t1"), send("other", "t1", "u2"), send("owner-c1", "t2"))
        assertEquals(listOf("owner-c1"), CodexModel.settled(mine, "device:mac", "t1", d))
    }
}
