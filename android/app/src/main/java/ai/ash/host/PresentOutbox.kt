package ai.ash.host

/** Core delivery result for an already persisted notification action. */
sealed interface PresentDelivery {
    data object Accepted : PresentDelivery
    data object Retry : PresentDelivery
    data class Rejected(val reason: String) : PresentDelivery
}

data class QueuedPresentAction(val id: String, val presentation: String, val payload: String)

interface PresentActionStore {
    fun queued(): List<QueuedPresentAction>
    fun remove(id: String)
    fun reject(id: String, reason: String)
}

/** The store outlives this instance; a new process can retry the same exact payload/client_id. */
class PresentOutbox(private val store: PresentActionStore, private val send: (String) -> PresentDelivery,
    private val onRejected: (QueuedPresentAction) -> Unit = {}) {
    fun flush() {
        for (action in store.queued()) {
            when (val result = send(action.payload)) {
                PresentDelivery.Accepted -> store.remove(action.id)
                PresentDelivery.Retry -> Unit
                is PresentDelivery.Rejected -> { store.reject(action.id, result.reason); onRejected(action) }
            }
        }
    }
}
