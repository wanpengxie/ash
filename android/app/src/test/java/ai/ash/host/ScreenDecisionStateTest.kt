package ai.ash.host

import org.junit.Assert.*
import org.junit.Test

class ScreenDecisionStateTest {
    @Test fun newTurnInvalidatesOldCleanupAndRetriesCannotReturnTwice() {
        val state = ScreenDecisionState()
        state.beginTurn("t1")
        assertTrue(state.mayReturn("d1", "t1"))
        state.applied("d1")
        assertFalse(state.mayReturn("d1", "t1"))
        state.beginTurn("t2")
        assertFalse(state.mayReturn("d2", "t1"))
    }
    @Test fun anotherTurnUsingOrRecreatingTheDisplayPreventsOldCleanup() {
        val state = ScreenDecisionState()
        state.beginTurn("t1")
        state.virtualCreated("t1", false)
        val original = state.virtualGeneration
        assertTrue(state.mayClose("d1", "t1", original))
        state.virtualUsed("t2")
        assertFalse(state.mayClose("d1", "t1", original))
        state.virtualCreated("t2", false)
        assertFalse(state.mayClose("d1", "t1", state.virtualGeneration))
    }
    @Test fun reusedOwnerOrPreviousDisplayCannotBeClaimedByNewTurn() {
        val state = ScreenDecisionState()
        state.beginTurn("t1")
        state.virtualCreated("", false)
        state.virtualCreated("t1", true)
        assertFalse(state.mayClose("d1", "t1", state.virtualGeneration))
    }
}
