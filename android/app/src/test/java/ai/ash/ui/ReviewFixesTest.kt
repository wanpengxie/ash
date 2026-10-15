package ai.ash.ui

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The counter-examples of the first review of the phone UI (docs/MOBILE-AUDIT.md §5.1), each failing on what was there before. */
class ReviewFixesTest {
    private fun send(id: String, thread: String, text: String, device: String = "device:mac", status: String = Pending.SENT, at: Long = 0) =
        Pending(id, device, JSONObject().put("op", "send").put("thread", thread).put("text", text), status, at = at)

    private fun detail(vararg items: Pair<String, String?>) = CodexModel.detail(JSONObject().put("id", "t1").put("turns", JSONArray().put(
        JSONObject().put("id", "u1").put("items", JSONArray().apply { items.forEachIndexed { i, (text, client) ->
            put(JSONObject().put("kind", "user").put("text", text).put("at", i).apply { if (client != null) put("client_id", client) })
        } }))))!!

    // 1. A Codex message is a stored operation, fixed to its computer, session and client id, and comes back after the app went.
    @Test fun aCodexMessageIsStoredWithItsComputerSessionAndIdAndAnInterruptedOneIsNotResent() {
        val op = send("c1", "t1", "run the tests", status = Pending.SENDING, at = 5)
        val back = Pending.fromStored(JSONObject(op.meta().toString()), null)!!
        assertEquals(listOf("device:mac", "t1", "c1", "run the tests"), listOf(back.to, back.body.optString("thread"), back.clientId, back.text))
        assertEquals("what was going out when the app went is unknown, not sent again", listOf("c1"), CodexModel.interrupted(listOf(back, send("c2", "t1", "x"))))
    }

    // 2. A waiting message is settled only by the session showing it (its client id), not by any read that worked.
    @Test fun aReadThatDoesNotShowTheMessageDoesNotSettleIt() {
        val ops = listOf(send("c1", "t1", "same"), send("c2", "t1", "same"), send("c3", "t2", "other"), send("c4", "t1", "x", device = "device:mini"))
        assertEquals("a read from before the send settles nothing", emptyList<String>(), CodexModel.settled(ops, "device:mac", "t1", CodexModel.clientIds(detail("old" to null))))
        assertEquals("the same words twice: only the one shown", listOf("c1"), CodexModel.settled(ops, "device:mac", "t1", CodexModel.clientIds(detail("same" to "c1", "same" to null))))
        assertEquals("a computer that cannot name it settles nothing", emptyList<String>(), CodexModel.settled(ops, "device:mac", "t1", emptySet()))
    }

    @Test fun oldSentMessagesAreNotSettledByAnUnrelatedRead() {
        val old = send("old", "t1", "keep this", at = System.currentTimeMillis() - 86_400_000)
        assertEquals(emptyList<String>(), CodexModel.settled(listOf(old), "device:mac", "t1", emptySet()))
    }

    @Test fun theSessionsCopyTakesTheWaitingRowsKeyAndAPlaceIsInTheWholeTurn() {
        val shown = CodexModel.Item("user", "hi", at = 40, id = "i9", clientId = "c1")
        assertEquals("c1", CodexModel.itemKey("u1", shown, 0))
        // The last 30 of a turn of 41: the item at 40 is shown 29th; one more item and it is shown 28th — its key stays.
        val agent = CodexModel.Item("agent", "ok", at = 40)
        assertEquals(CodexModel.itemKey("u1", agent, 29), CodexModel.itemKey("u1", agent, 28))
        assertNotEquals(CodexModel.itemKey("u1", CodexModel.Item("agent", "ok", at = 39), 29), CodexModel.itemKey("u1", agent, 29))
    }

    // 4. Whether to follow the end is decided when the rows land, from where the owner is then.
    @Test fun rowsThatLandAfterTheOwnerScrolledUpDoNotPullThemBack() {
        val f = FollowIntent()
        f.commit(f.submit(false), listOf("a"), atEndNow = true)
        val t = f.submit(false)                       // handed over while at the end…
        val d = f.commit(t, listOf("a", "b"), atEndNow = false) // …landing after the owner scrolled up
        assertFalse(d.scrollToEnd); assertTrue(d.unseen)
        val sent = f.submit(toEnd = true)
        f.dragged()                                   // the owner dragged after sending
        assertFalse(f.commit(sent, listOf("a", "b", "c"), atEndNow = false).scrollToEnd)
        assertTrue(f.commit(f.submit(false), listOf("a", "b", "c", "d"), atEndNow = true).scrollToEnd)
        assertFalse("restoring a place holds the list", f.commit(f.submit(false), listOf("a", "b", "c", "d", "e"), atEndNow = true, hold = true).scrollToEnd)
    }

    // 5. A reading place is kept until its row is there, or is clearly not coming — then the oldest row, never the newest.
    @Test fun aReadingPlaceOlderThanTheNewestWindowIsFetchedThenFoundOrLeftAtTheOldest() {
        val r = AnchorRestore(AnchorRestore.Anchor("m5", "m5", 12))
        assertEquals("rows before the conversation was read do not count", AnchorRestore.Step.Wait, r.onRows(listOf("out:1"), read = false, canFetch = true))
        assertEquals(AnchorRestore.Step.Fetch("m5"), r.onRows(listOf("m90", "m91"), read = true, canFetch = true))
        assertTrue(r.pending)
        assertEquals("a refresh or card patch while around is in flight must wait", AnchorRestore.Step.Wait, r.onRows(listOf("m90", "m91"), true, true))
        assertTrue(r.pending)
        r.fetchFinished()
        assertEquals(AnchorRestore.Step.Go(1, 12), r.onRows(listOf("m4", "m5", "m90"), read = true, canFetch = true))
        val gone = AnchorRestore(AnchorRestore.Anchor("m5", "m5", 12))
        gone.onRows(listOf("m90"), true, true)
        gone.fetchFinished()
        assertEquals(AnchorRestore.Step.Oldest, gone.onRows(listOf("m90"), true, true))
        assertFalse(gone.pending)
    }

    // (review 5.4) What a send took is what leaves the picked files; what was picked while it was being stored stays.
    @Test fun filesPickedWhileAMessageIsStoredStayPicked() {
        val picked = JSONArray().put(JSONObject().put("name", "a")).put(JSONObject().put("name", "b"))
        val taken = Picked.entries(picked)
        picked.put(JSONObject().put("name", "c"))
        assertEquals(listOf("c"), Picked.entries(Picked.afterSend(picked, taken)).map { (it as JSONObject).getString("name") })
    }
}
