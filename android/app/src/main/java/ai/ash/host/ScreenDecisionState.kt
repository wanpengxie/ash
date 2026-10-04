package ai.ash.host

/** Host-owned resource identity; no model-supplied metadata can claim an existing display. */
class ScreenDecisionState {
    var turn: String = ""
        private set
    var epoch: Long = 0
        private set
    var virtualGeneration: Long = 0
        private set
    var virtualOwner: String = ""
        private set
    var virtualOpen: Boolean = false
        private set
    private val applied = LinkedHashSet<String>()

    @Synchronized fun beginTurn(id: String) { if (turn != id) { turn = id; epoch++ } }
    @Synchronized fun screenChanged() { epoch++ }
    @Synchronized fun virtualCreated(owner: String, reused: Boolean) {
        if (!reused) { virtualGeneration++; virtualOpen = true; virtualOwner = owner }
        else if (virtualOwner != owner) { virtualGeneration++; virtualOwner = "" }
    }
    @Synchronized fun virtualUsed(owner: String) {
        virtualGeneration++
        if (virtualOwner != owner) virtualOwner = ""
    }
    @Synchronized fun virtualClosed() { virtualGeneration++; virtualOpen = false; virtualOwner = "" }
    @Synchronized fun mayReturn(id: String, owner: String): Boolean = id !in applied && owner.isNotBlank() && owner == turn
    @Synchronized fun mayClose(id: String, owner: String, generation: Long): Boolean =
        id !in applied && owner.isNotBlank() && owner == turn && virtualOpen && owner == virtualOwner && generation == virtualGeneration
    @Synchronized fun applied(id: String) {
        applied.add(id)
        while (applied.size > 256) applied.remove(applied.first())
    }
}
