package ai.ash.ui

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatStateTest {
    private fun say(seq: Long, id: String) = JSONObject().put("seq", seq).put("id", id).put("type", "say").put("text", id)
    private fun window(vararg items: JSONObject, more: Boolean = false) = JSONObject().put("items", JSONArray(items.toList())).put("has_more_before", more)

    @Test fun aFailedReadKeepsWhatIsShownAndSaysSo() {
        val w = ChatWindow()
        assertTrue(w.newest(w.begin(), window(say(1, "a"), say(2, "b")), 10))
        assertTrue(w.newest(w.begin(), null, 20))
        assertEquals(listOf("a", "b"), w.items.values.map { it.optString("id") })
        assertEquals(20, w.failedAt)
        // Only a successful empty read empties it.
        assertTrue(w.newest(w.begin(), window(), 30))
        assertTrue(w.items.isEmpty())
        assertEquals(0, w.failedAt)
    }

    @Test fun anAnswerFromAnEarlierReadOrLinkIsDropped() {
        val w = ChatWindow()
        val old = w.begin()
        val now = w.begin()
        assertFalse(w.newest(old, window(say(9, "stale")), 1))
        assertFalse("a failure of the earlier read does not count either", w.newest(old, null, 1))
        assertEquals(0, w.failedAt)
        assertTrue(w.newest(now, window(say(1, "a")), 2))
        w.invalidate()
        assertFalse(w.newest(now, null, 3))
        assertEquals(listOf("a"), w.items.values.map { it.optString("id") })
    }

    @Test fun olderPagesAddAboveAndAFailedOneChangesNothing() {
        val w = ChatWindow()
        w.newest(w.begin(), window(say(5, "e"), more = true), 1)
        w.older(null)
        assertTrue(w.moreBefore)
        w.older(window(say(3, "c"), say(4, "d"), more = false))
        assertEquals(listOf("c", "d", "e"), w.items.values.map { it.optString("id") })
        assertFalse(w.moreBefore)
    }

    @Test fun aMessageWithNobodyToSendToWaitsInsteadOfBeingLost() {
        val p = Pending("c1", null, JSONObject().put("text", "hi"))
        assertNull(p.request(primary = null))
        assertEquals("agent:main", p.request("agent:main")!!.getString("to"))
        assertEquals("c1", p.request("agent:main")!!.getString("client_id"))
        assertEquals("agent:helper", p.copy(to = "agent:helper").request("agent:main")!!.getString("to"))
    }

    @Test fun storedWithoutItsFilesAndReadBackWhole() {
        val att = JSONArray().put(JSONObject().put("name", "a.png").put("data", "AAAA"))
        val p = Pending("c1", "agent:x", JSONObject().put("text", "hi").put("attachments", att), at = 7)
        assertFalse(p.meta().getJSONObject("body").has("attachments"))
        val back = Pending.fromStored(p.meta(), p.attachments())!!
        assertEquals("hi", back.text)
        assertEquals("AAAA", back.attachments()!!.getJSONObject(0).getString("data"))
        assertEquals(7, back.at)
        assertEquals("agent:x", back.to)
    }

    @Test fun theOutboxKeepsOneIdThroughEveryTryAndUntilTheWindowShowsIt() {
        val m = OutboxModel()
        m.put(Pending("c1", null, JSONObject().put("text", "one")))
        m.put(Pending("c2", null, JSONObject().put("text", "two")))
        assertEquals("c1", m.next()!!.clientId)
        m.mark("c1", Pending.UNSENT)
        assertEquals("a retry is the same message", "c1", m.next()!!.clientId)
        m.taken("c1", "m-100")
        assertEquals("c2", m.next()!!.clientId)
        assertEquals("taken, it stays (as sent) until the window shows it", Pending.SENT, m.items().first().status)
        assertEquals("c1", m.sentAs("m-100"))
        m.mark("c2", Pending.FAILED)
        assertNull("a failed one is not tried again by itself", m.next())
        assertEquals(listOf("c1"), m.drop(emptySet(), setOf("m-100")).map { it.clientId })
        assertEquals(listOf("c2"), m.items().map { it.clientId })
    }

    @Test fun draftsAreKeptPerConversation() {
        val mem = HashMap<String, String>()
        val d = Drafts(object : Drafts.Store {
            override fun get(key: String) = mem[key]
            override fun put(key: String, value: String?) { if (value == null) mem.remove(key) else mem[key] = value }
        })
        d.keep(Drafts.chat(null), "给 Ash 的")
        d.keep(Drafts.chat("agent:helper"), "给帮手的")
        d.keep(Drafts.codex("device:mac", "t1"), "给 Codex 的")
        assertEquals("给 Ash 的", d.text(Drafts.chat(null)))
        assertEquals("给帮手的", d.text(Drafts.chat("agent:helper")))
        assertEquals("", d.text(Drafts.codex("device:mac", "t2")))
        d.keep(Drafts.chat(null), "")
        assertTrue("an emptied box keeps nothing", Drafts.chat(null) !in mem)
    }

    @Test fun aCardPatchedSinceTheReadStartedOutranksWhatTheReadSays() {
        val newer = JSONObject().put("type", "a2ui").put("id", "k1").put("rev", 2)
        val w = ChatWindow { item -> if (item.optJSONObject("card")?.optString("id") == "k1") JSONObject(item.toString()).put("card", newer) else item }
        val old = JSONObject().put("seq", 1).put("id", "m1").put("type", "card").put("card", JSONObject().put("type", "a2ui").put("id", "k1").put("rev", 1))
        w.newest(w.begin(), window(old), 1)
        assertEquals(2, w.items.getValue(1).getJSONObject("card").getInt("rev"))
        w.older(window(JSONObject(old.toString()).put("seq", 0)))
        assertEquals("older pages go through it too", 2, w.items.getValue(0).getJSONObject("card").getInt("rev"))
    }
}
