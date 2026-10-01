package ai.ash.host

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PresentRouteTest {
    @Test fun notificationApprovalNeedsDenyButAllowsAnOfferedSubset() {
        assertEquals(true, PresentRoutes.notificationOptionsValid(listOf("once", "deny")))
        assertEquals(true, PresentRoutes.notificationOptionsValid(listOf("once", "always", "deny")))
        assertEquals(false, PresentRoutes.notificationOptionsValid(listOf("once")))
        assertEquals(false, PresentRoutes.notificationOptionsValid(listOf("once", "deny", "deny")))
    }

    @Test fun eachOfferedApprovalUsesTheStoredAskSender() {
        for (choice in listOf("once", "always", "deny")) {
            val route = PresentRoutes.approval("m_request", "service:gate", setOf("once", "always", "deny"), choice, 200, 100)
            assertEquals("service:gate", route.to)
            assertEquals("response", route.kind)
            assertEquals("ask", route.word)
            assertEquals("m_request", route.replyTo)
            assertEquals(choice, route.choice)
        }
    }

    @Test fun arbitraryCallbackAndUnofferedOrExpiredChoiceAreRejected() {
        assertThrows(IllegalArgumentException::class.java) {
            PresentRoutes.approval("m_request", "https://example.invalid", setOf("once"), "once", 200, 100)
        }
        assertThrows(IllegalArgumentException::class.java) {
            PresentRoutes.approval("m_request", "service:gate", setOf("once", "deny"), "always", 200, 100)
        }
        assertThrows(IllegalArgumentException::class.java) {
            PresentRoutes.approval("m_request", "service:gate", setOf("once"), "once", 100, 100)
        }
    }

    @Test fun directNotificationReplyAlwaysTargetsTheAgent() {
        val route = PresentRoutes.reply("  Hello  ")
        assertEquals("agent:main", route.to)
        assertEquals("request", route.kind)
        assertEquals("say", route.word)
        assertEquals("Hello", route.text)
        assertThrows(IllegalArgumentException::class.java) { PresentRoutes.reply("   ") }
    }
}
