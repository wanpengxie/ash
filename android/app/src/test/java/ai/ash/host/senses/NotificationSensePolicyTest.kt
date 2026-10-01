package ai.ash.host.senses

import org.junit.Assert.*
import org.junit.Test

class NotificationSensePolicyTest {
    @Test fun requiresLocalOptInAndSystemGrant() {
        assertNull(NotificationSensePolicy.item("test.sender", "Hello", "Body", "test.host", false, false))
        assertNull(NotificationSensePolicy.item("test.sender", "Hello", "Body", "test.host", false, true))
        assertNull(NotificationSensePolicy.item("test.sender", "Hello", "Body", "test.host", true, false))
        assertEquals(NotificationSensePolicy.Item("test.sender", "Hello", "Body"),
            NotificationSensePolicy.item("test.sender", "Hello", "Body", "test.host", true, true))
        // Revocation and regrant do not change the local opt-in state; both gates are read again.
        assertNull(NotificationSensePolicy.item("test.sender", "Later", "Body", "test.host", true, false))
        assertNotNull(NotificationSensePolicy.item("test.sender", "Later", "Body", "test.host", true, true))
    }

    @Test fun skipsOwnPackageEmptyContentAndBoundsTheCopiedFields() {
        assertNull(NotificationSensePolicy.item("test.host", "Private", "Body", "test.host", true, true))
        assertNull(NotificationSensePolicy.item("test.sender", " ", null, "test.host", true, true))
        assertNull(NotificationSensePolicy.item("", "Hello", "Body", "test.host", true, true))
        val item = NotificationSensePolicy.item("a".repeat(300), "t".repeat(600), "b".repeat(2500), "test.host", true, true)!!
        assertEquals(256, item.app.length)
        assertEquals(512, item.title.length)
        assertEquals(2048, item.text.length)
    }
}
