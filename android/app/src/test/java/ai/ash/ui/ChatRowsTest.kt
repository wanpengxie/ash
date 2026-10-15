package ai.ash.ui

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatRowsTest {
    private fun say(seq: Long, id: String, text: String, client: String? = null) = JSONObject().put("seq", seq).put("id", id).put("type", "say").put("text", text)
        .apply { if (client != null) put("client_id", client) }

    private fun build(items: List<JSONObject>, outbox: List<Pending> = emptyList(), more: Boolean = false) =
        ChatRows.build(items, outbox, more, { error("not drawn") }, { error("not drawn") }, { error("not drawn") })

    @Test fun keysAreStableAndTheOwnersMessageKeepsItsRow() {
        val waiting = Pending("c1", null, JSONObject().put("text", "hi"))
        val before = build(listOf(say(1, "m1", "hello")), listOf(waiting))
        val after = build(listOf(say(1, "m1", "hello"), say(2, "m2", "hi", client = "c1")))
        assertEquals(listOf("m1", "c1"), before.map { it.key })
        assertEquals(listOf("m1", "c1"), after.map { it.key })
        // The same row (no remove and add), drawn again because it changed; the one before it is left alone.
        assertTrue(ChatRows.diff.areItemsTheSame(before[1], after[1]))
        assertFalse(ChatRows.diff.areContentsTheSame(before[1], after[1]))
        assertTrue(ChatRows.diff.areContentsTheSame(before[0], after[0]))
        assertEquals("m2", after[1].id)
    }

    @Test fun aRefreshThatChangesNothingRedrawsNothing() {
        val a = build(listOf(say(1, "m1", "x"), say(2, "m2", "y")))
        val b = build(listOf(say(1, "m1", "x"), say(2, "m2", "y")))
        assertTrue(a.indices.all { ChatRows.diff.areItemsTheSame(a[it], b[it]) && ChatRows.diff.areContentsTheSame(a[it], b[it]) })
    }

    @Test fun anOutboxEntryTheWindowShowsIsOneRowAndUnknownKindsAreNotRows() {
        val waiting = Pending("c1", null, JSONObject(), Pending.SENT)
        val rows = build(listOf(say(1, "m1", "a", client = "c1"), JSONObject().put("seq", 2).put("id", "m2").put("type", "future"),
            JSONObject().put("seq", 3).put("id", "m3").put("type", "card").put("card", JSONObject().put("type", "image"))), listOf(waiting), more = true)
        assertEquals(listOf(ChatRows.MORE, "c1", "m3"), rows.map { it.key })
    }

    @Test fun aTextFoldsOnlyWhenLongerThanTheFoldAndNotOpened() {
        assertFalse(Fold.folded(4, 4, open = false))
        assertTrue(Fold.folded(5, 4, open = false))
        assertFalse(Fold.folded(5, 4, open = true))
        assertTrue(Fold.long(5, 4))
    }

    @Test fun anImageCardBoxHasItsShapeBeforeThePictureArrives() {
        assertEquals(260 to 195, ChatFiles.cardBox(0, 0))
        assertEquals(260 to 130, ChatFiles.cardBox(1000, 500))
        assertEquals(100 to 200, ChatFiles.cardBox(500, 1000))
    }

    @Test fun aSentMessageKeepsItsRowWhenTheWindowCopyHasNoClientId() {
        val outbox = listOf(Pending("c1", null, JSONObject().put("text", "hi"), Pending.SENT, "m1"))
        val pendingOnly = ChatRows.build(emptyList(), outbox, false, { throw AssertionError("not drawn") }, { null }, { null })
        val window = listOf(JSONObject().put("id", "m1").put("seq", 9).put("type", "say").put("text", "hi"))
        val withCopy = ChatRows.build(window, emptyList(), false, { throw AssertionError("not drawn") }, { null }, { null }, sentAs = { if (it == "m1") "c1" else null })
        org.junit.Assert.assertEquals(pendingOnly.single().key, withCopy.single().key)
    }
}
