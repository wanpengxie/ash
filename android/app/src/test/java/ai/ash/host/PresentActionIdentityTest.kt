package ai.ash.host

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PresentActionIdentityTest {
    @Test fun onlyTheCreatorFixedUriDeterminesTheAction() {
        // Fill-in extras claiming another id/choice are deliberately not inputs to this parser.
        assertEquals(PresentActionIdentity("reply-id", "reply"),
            PresentActionIdentity.fromUriParts("ash", "present-action", listOf("reply-id", "reply")))
        assertEquals(PresentActionIdentity("approval-id", "deny"),
            PresentActionIdentity.fromUriParts("ash", "present-action", listOf("approval-id", "deny")))
        assertEquals(PresentActionIdentity("reply-id", "dismiss"),
            PresentActionIdentity.fromUriParts("ash", "present-action", listOf("reply-id", "dismiss")))
    }

    @Test fun malformedOrForeignUrisCannotSelectAnAction() {
        assertNull(PresentActionIdentity.fromUriParts("https", "example.invalid", listOf("id", "once")))
        assertNull(PresentActionIdentity.fromUriParts("ash", "present-expiry", listOf("id", "once")))
        assertNull(PresentActionIdentity.fromUriParts("ash", "present-action", listOf("id")))
        assertNull(PresentActionIdentity.fromUriParts("ash", "present-action", listOf("id", "bad/choice")))
    }
}
