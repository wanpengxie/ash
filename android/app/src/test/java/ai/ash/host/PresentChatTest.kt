package ai.ash.host

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PresentChatTest {
    @Test fun chatKindsShareOneNotification() {
        assertTrue(PresentChat.isChat("reply"))
        assertTrue(PresentChat.isChat("offer"))
        assertTrue(PresentChat.isChat("heads_up"))
        assertFalse(PresentChat.isChat("approval"))
        assertFalse(PresentChat.isChat("due"))
    }

    @Test fun onlyTheNewestMessagesAreKept() {
        val items = (1..20).map { "m$it" to it.toLong() }.shuffled()
        val (keep, drop) = PresentChat.split(items)
        assertEquals((13..20).map { "m$it" }, keep)
        assertEquals((1..12).map { "m$it" }, drop)
    }

    @Test fun fewMessagesAreAllShownInOrder() {
        val (keep, drop) = PresentChat.split(listOf("b" to 2L, "a" to 1L))
        assertEquals(listOf("a", "b"), keep)
        assertEquals(emptyList<String>(), drop)
    }
}
