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

    @Test fun acceptedChangeThenProviderReversalProducesCompensationDespiteStaleSnapshot() {
        val state = Memory()
        val outbox = SenseOutbox(state)
        val original = "{\"title\":\"A\"}"
        val changed = "{\"title\":\"B\"}"
        val snapshot = mapOf("one" to original)
        val sends = mutableListOf<String>()
        val first = CalendarDelivery.diff(snapshot, emptyMap(), mapOf("one" to changed, "two" to changed))
        assertEquals(2, first.size)
        assertTrue(outbox.dispatch("changed", "changed:one:$changed", mapOf(CalendarDelivery.key("one") to changed)) { sends += "B" })
        assertFalse(outbox.dispatch("changed", "changed:two:$changed", mapOf(CalendarDelivery.key("two") to changed)) { error("offline") })
        assertEquals(changed, state.values[CalendarDelivery.key("one")])

        val reversed = CalendarDelivery.diff(snapshot, CalendarDelivery.journal(state.values), mapOf("one" to original, "two" to changed))
        assertEquals(listOf("one", "two"), reversed.map { it.occurrence })
        assertEquals(changed, reversed[0].previous)
        assertEquals(original, reversed[0].current)
        assertTrue(outbox.dispatch("changed", "changed:one:$original", mapOf(CalendarDelivery.key("one") to original)) { sends += "A" })
        assertTrue(outbox.dispatch("changed", "changed:two:$changed", mapOf(CalendarDelivery.key("two") to changed)) { sends += "two" })
        assertEquals(listOf("B", "A", "two"), sends)
        assertTrue(state.commit(mapOf("snapshot" to "advanced"), outbox.completedKeys("changed") + CalendarDelivery.completedKeys(state.values)))
        assertTrue(CalendarDelivery.journal(state.values).isEmpty())
    }

    @Test fun acceptedRemovalThenReappearanceAlsoCompensates() {
        val state = Memory()
        val event = "{\"title\":\"A\"}"
        val snapshot = mapOf("one" to event)
        val outbox = SenseOutbox(state)
        assertEquals(null, CalendarDelivery.diff(snapshot, emptyMap(), emptyMap()).single().current)
        assertTrue(outbox.dispatch("changed", "removed:one:$event", mapOf(CalendarDelivery.key("one") to CalendarDelivery.ABSENT)) {})
        val restored = CalendarDelivery.diff(snapshot, CalendarDelivery.journal(state.values), snapshot).single()
        assertEquals(null, restored.previous)
        assertEquals(event, restored.current)
    }

    @Test fun ambiguousAcceptedSendIsReconciledBeforeProviderReversion() {
        val state = Memory().apply { failAckOnce = true }
        val outbox = SenseOutbox(state)
        val a = "{\"title\":\"A\"}"
        val b = "{\"title\":\"B\"}"
        val attempt = CalendarDelivery.Attempt("one", b, b, 1)
        val accepted = mapOf(CalendarDelivery.key("one") to b, CalendarDelivery.generationKey("one") to "1")
        val ids = mutableListOf<String>()
        assertFalse(outbox.dispatch("changed", attempt.deliveryKey, accepted,
            mapOf(CalendarDelivery.attemptKey("one") to attempt.encode()), setOf(CalendarDelivery.attemptKey("one"))) { ids += it })
        assertEquals(attempt, CalendarDelivery.attempts(state.values).single())
        assertTrue(CalendarDelivery.diff(mapOf("one" to a), CalendarDelivery.journal(state.values), mapOf("one" to a)).isEmpty())
        val replay = CalendarDelivery.attempts(state.values).single()
        assertTrue(outbox.dispatch("changed", replay.deliveryKey, accepted, acceptedRemoves = setOf(CalendarDelivery.attemptKey("one"))) { ids += it })
        assertEquals(ids[0], ids[1])
        assertEquals(a, CalendarDelivery.diff(mapOf("one" to a), CalendarDelivery.journal(state.values), mapOf("one" to a)).single().current)
        val compensation = CalendarDelivery.Attempt("one", a, a, CalendarDelivery.nextGeneration(state.values, "one"))
        assertNotEquals(attempt.deliveryKey, compensation.deliveryKey)
        assertTrue(outbox.dispatch("changed", compensation.deliveryKey,
            mapOf(CalendarDelivery.key("one") to a, CalendarDelivery.generationKey("one") to "2")) { ids += it })
        assertNotEquals(ids[1], ids[2])
    }

    @Test fun repeatedVersionBeforeSnapshotCommitUsesNewGeneration() {
        val state = Memory()
        val outbox = SenseOutbox(state)
        val a = "{\"title\":\"A\"}"
        val b = "{\"title\":\"B\"}"
        val sent = mutableListOf<String>()
        for ((value, generation) in listOf(b to 1L, a to 2L, b to 3L)) {
            val attempt = CalendarDelivery.Attempt("one", value, value, generation)
            assertTrue(outbox.dispatch("changed", attempt.deliveryKey,
                mapOf(CalendarDelivery.key("one") to value, CalendarDelivery.generationKey("one") to generation.toString())) { sent += it })
            assertEquals(generation + 1, CalendarDelivery.nextGeneration(state.values, "one"))
        }
        assertEquals(3, sent.distinct().size)
    }
}
