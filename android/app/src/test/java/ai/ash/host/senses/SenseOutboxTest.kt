package ai.ash.host.senses

import org.junit.Assert.*
import org.junit.Test

class SenseOutboxTest {
    private class Memory : SenseOutbox.Store {
        val values = mutableMapOf<String, String>()
        var failAckOnce = false
        override fun get(key: String) = values[key]
        override fun keys() = values.keys.toSet()
        override fun commit(puts: Map<String, String>, removes: Set<String>): Boolean {
            if (failAckOnce && puts.keys.any { it.startsWith("accepted:") }) {
                failAckOnce = false
                return false
            }
            values.putAll(puts)
            for (key in removes) values.remove(key)
            return true
        }
    }

    @Test fun partialBatchRetryAfterRestartDoesNotRedeliverAcceptedChange() {
        val state = Memory()
        val first = SenseOutbox(state)
        val sends = mutableListOf<Pair<String, String>>()
        val a = "changed:one:new"
        val b = "changed:two:new"
        assertTrue(first.dispatch("changed", a) { sends += "a" to it })
        assertFalse(first.dispatch("changed", b) { sends += "b" to it; error("offline") })

        val restarted = SenseOutbox(state)
        assertTrue(restarted.dispatch("changed", a) { error("accepted A must not resend") })
        assertTrue(restarted.dispatch("changed", b) { sends += "b" to it })
        assertEquals(listOf("a", "b", "b"), sends.map { it.first })
        assertEquals(sends[1].second, sends[2].second) // same client_id after restart
        assertTrue(state.commit(mapOf("snapshot" to "advanced"), restarted.completedKeys("changed")))
        assertTrue(state.keys().none { it.startsWith("accepted:changed:") || it.startsWith("pending:changed:") })
        assertTrue(SenseOutbox(state).dispatch("changed", a) { sends += "a" to it })
        assertNotEquals(sends[0].second, sends.last().second) // a future change cycle is new
    }

    @Test fun lostAcknowledgementStorageRetriesWithTheReservedId() {
        val state = Memory().apply { failAckOnce = true }
        val ids = mutableListOf<String>()
        val outbox = SenseOutbox(state)
        assertFalse(outbox.dispatch("changed", "item") { ids += it })
        assertTrue(SenseOutbox(state).dispatch("changed", "item") { ids += it })
        assertEquals(2, ids.size)
        assertEquals(ids[0], ids[1])
    }

    @Test fun reminderAcknowledgementSurvivesUntilMarkerCommits() {
        val state = Memory()
        val outbox = SenseOutbox(state)
        var sends = 0
        assertTrue(outbox.dispatch("upcoming", "event:1") { sends++ })
        assertTrue(SenseOutbox(state).dispatch("upcoming", "event:1") { sends++ })
        assertEquals(1, sends)
        assertTrue(state.commit(mapOf("reminded:event:1" to "start")))
        assertTrue(outbox.complete("upcoming", "event:1"))
        assertTrue(state.keys().none { it.startsWith("accepted:upcoming:") || it.startsWith("pending:upcoming:") })
    }
}
