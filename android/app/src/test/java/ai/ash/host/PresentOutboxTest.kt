package ai.ash.host

import org.junit.Assert.assertEquals
import org.junit.Test

class PresentOutboxTest {
    private class MemoryStore(var pending: List<QueuedPresentAction>) : PresentActionStore {
        val rejected = mutableMapOf<String, String>()
        override fun queued() = pending
        override fun remove(id: String) { pending = pending.filterNot { it.id == id } }
        override fun reject(id: String, reason: String) { rejected[id] = reason; remove(id) }
    }

    @Test fun offlineActionSurvivesNewOutboxAndReusesExactPayload() {
        val action = QueuedPresentAction("action-1", "ask-1", "{\"client_id\":\"action-1\",\"choice\":\"deny\"}")
        val store = MemoryStore(listOf(action))
        PresentOutbox(store, { PresentDelivery.Retry }).flush()
        assertEquals(listOf(action), store.queued())
        val delivered = mutableListOf<String>()
        PresentOutbox(store, { delivered.add(it); PresentDelivery.Accepted }).flush()
        assertEquals(listOf(action.payload), delivered)
        assertEquals(emptyList<QueuedPresentAction>(), store.queued())
    }

    @Test fun permanentRejectionIsRetainedAsFailureRatherThanCalledDelivered() {
        val action = QueuedPresentAction("action-2", "ask-2", "payload")
        val store = MemoryStore(listOf(action))
        val surfaced = mutableListOf<String>()
        PresentOutbox(store, { PresentDelivery.Rejected("bad_request") }, { surfaced.add(it.presentation) }).flush()
        assertEquals("bad_request", store.rejected["action-2"])
        assertEquals(listOf("ask-2"), surfaced)
    }
}
