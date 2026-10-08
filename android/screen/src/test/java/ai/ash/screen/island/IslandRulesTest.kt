package ai.ash.screen.island

import org.junit.Assert.*
import org.junit.Test

class IslandRulesTest {
    @Test fun aQuestionOrApprovalWaitingOnTheOwnerOpensTheCard() {
        assertTrue(IslandRules.opensCard("ask", waitingOnOwner = true))
        assertTrue(IslandRules.opensCard("approval", waitingOnOwner = true))
    }

    @Test fun aStepOnlyTheOwnerCanTakeInAshOpensTheCard() {
        assertTrue(IslandRules.opensCard("in_app", waitingOnOwner = false))
    }

    @Test fun aReplyOrAnEndedTurnDoesNotOpenTheCardByItself() {
        for (kind in listOf("reply", "result", "incomplete", "stopped", "working", "thinking"))
            assertFalse(kind, IslandRules.opensCard(kind, waitingOnOwner = false))
    }

    @Test fun onlyOutcomesSettleAndNothingWaitingOnTheOwnerEverDoes() {
        for (kind in listOf("reply", "result", "incomplete", "stopped")) assertTrue(kind, IslandRules.settles(kind))
        for (kind in listOf("ask", "approval", "in_app", "working", "thinking", "listening")) assertFalse(kind, IslandRules.settles(kind))
        assertEquals(30_000L, IslandRules.SETTLE_MS)
    }
}
