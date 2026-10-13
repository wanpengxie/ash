package ai.ash.ui

import org.junit.Assert.*
import org.junit.Test

class SharedTextInboxTest {
    private val send = "android.intent.action.SEND"

    @Test fun retainsOriginalTextAndDoesNotReplaceUnacknowledgedShare() {
        val inbox = SharedTextInbox()
        val original = "文章标题\n  https://example.com/path?q=a%20b\n不要改写这段文案  "
        assertNull(inbox.receive(send, "text/plain", original))
        val first = inbox.pending!!
        assertEquals(original, first.text)
        assertEquals(SharedTextInbox.Rejection.BUSY, inbox.receive(send, "text/plain", "https://example.org"))
        assertEquals(first, inbox.pending)
        inbox.acknowledge("another-page-id")
        assertEquals(first, inbox.pending)
        inbox.acknowledge(first.id)
        assertNull(inbox.pending)
        assertNull(inbox.receive(send, "text/plain", original))
        assertNotEquals(first.id, inbox.pending!!.id)
    }

    @Test fun validatesUtf8BytesAndSupportsTitleWithLink() {
        val inbox = SharedTextInbox()
        val prefix = "https://example.com\n"
        assertNull(inbox.receive(send, "text/plain", prefix + "a".repeat(SharedTextInbox.MAX_BYTES - prefix.length)))
        inbox.acknowledge(inbox.pending!!.id)
        assertEquals(SharedTextInbox.Rejection.TOO_LARGE,
            inbox.receive(send, "text/plain", prefix + "文".repeat(12000)))
        assertEquals(SharedTextInbox.Rejection.TOO_LARGE,
            inbox.receive(send, "text/plain", "a".repeat(SharedTextInbox.MAX_BYTES + 1)))
        assertNull(inbox.pending)
    }

    @Test fun rejectsFilesMultipleItemsAndNonLinkText() {
        val inbox = SharedTextInbox()
        for ((action, mime, text) in listOf(
            Triple("android.intent.action.SEND_MULTIPLE", "text/plain", "https://example.com"),
            Triple(send, "image/png", "https://example.com"),
            Triple(send, "text/plain", "content://external/file"),
            Triple(send, "text/plain", "https:// "),
            Triple(send, "text/plain", null),
        )) assertEquals(SharedTextInbox.Rejection.UNSUPPORTED, inbox.receive(action, mime, text))
        assertNull(inbox.pending)
    }

    @Test fun restoresSameHandoffIdAcrossActivityRecreation() {
        val inbox = SharedTextInbox()
        inbox.restore("original-handoff", "标题 https://example.com")
        assertEquals(SharedTextInbox.Draft("original-handoff", "标题 https://example.com"), inbox.pending)
        inbox.acknowledge("original-handoff")
        inbox.restore(null, null)
        assertNull(inbox.pending)
    }
}
