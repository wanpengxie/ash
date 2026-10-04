package ai.ash.host.browser

import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class BrowserArgumentsTest {
    private val publicHost: (String) -> List<InetAddress> = { listOf(InetAddress.getByAddress(byteArrayOf(93.toByte(), 184.toByte(), 216.toByte(), 34))) }
    private fun resolvesTo(vararg octets: Int): (String) -> List<InetAddress> = { listOf(InetAddress.getByAddress(ByteArray(4) { octets[it].toByte() })) }

    private fun rejected(raw: Any?, resolve: (String) -> List<InetAddress> = publicHost) {
        try { BrowserArguments.url(raw, resolve); fail("accepted $raw") } catch (_: BrowserArguments.Rejected) { /* expected */ }
    }

    @Test fun publicPagesOpenAndBareNamesGetHttps() {
        assertEquals("https://example.com/a?b=1", BrowserArguments.url("https://example.com/a?b=1", publicHost))
        assertEquals("https://example.com", BrowserArguments.url("example.com", publicHost))
        assertEquals("http://example.com/", BrowserArguments.url(" http://example.com/ ", publicHost))
    }

    @Test fun nothingOnThePhoneOrItsNetworkOpens() {
        for (bad in listOf("http://localhost:4700/", "http://127.0.0.1:4700/api", "http://[::1]/", "http://192.168.1.5/", "http://10.0.2.2:7890/",
            "http://172.16.0.1/", "http://169.254.169.254/latest", "http://100.64.0.1/", "http://printer.local/", "http://intranet/", "http://0.0.0.0/"))
            rejected(bad) { host -> listOf(InetAddress.getByName(if (host.all { it.isDigit() || it == '.' } || host.contains(':')) host.trim('[', ']') else "127.0.0.1")) }
        // A public-looking name that resolves to a private address is refused too.
        rejected("http://sneaky.example.com/", resolvesTo(10, 0, 0, 7))
        rejected("http://sneaky.example.com/", resolvesTo(127, 0, 0, 1))
    }

    @Test fun otherSchemesAndOddAddressesAreRefused() {
        for (bad in listOf("file:///data/data/ai.ash.agent/files/ash/tokens.json", "javascript:alert(1)", "content://x", "intent://scan#Intent;end", "ftp://example.com/",
            "https://user:pass@example.com/", "", "   ", null, 42))
            rejected(bad)
        rejected("https://example.com/" + "a".repeat(BrowserArguments.MAX_URL))
    }

    @Test fun navigationChecksNeedNoLookup() {
        assertEquals("https://example.com/x", BrowserArguments.navigable("https://example.com/x"))
        for (bad in listOf("http://127.0.0.1:4700/", "http://localhost/", "intent://x", "file:///etc/hosts", "http://10.0.2.2/"))
            try { BrowserArguments.navigable(bad); fail("accepted $bad") } catch (_: BrowserArguments.Rejected) { /* expected */ }
    }

    @Test fun approvalsAreBoundToTheSiteAndTheNamedControl() {
        assertTrue(BrowserArguments.sameSite("example.com", "www.example.com"))
        assertTrue(BrowserArguments.sameSite("WWW.Example.com.", "example.com"))
        assertFalse(BrowserArguments.sameSite("example.com", "evil.example.org"))
        assertFalse(BrowserArguments.sameSite("example.com", null))
        assertFalse(BrowserArguments.sameSite("", "example.com"))
        assertTrue(BrowserArguments.labelMatches("登录", "登录 / 注册"))
        assertTrue(BrowserArguments.labelMatches("Sign in to your account", "sign in"))
        assertFalse(BrowserArguments.labelMatches("登录", "删除账号"))
        assertFalse(BrowserArguments.labelMatches("", "删除账号"))
        assertFalse(BrowserArguments.labelMatches("登录", ""))
    }

    @Test fun refsAndTextAreClosed() {
        assertEquals(3, BrowserArguments.ref(3))
        for (bad in listOf<Any?>(0, -1, 1.5, "3", null, 501)) try { BrowserArguments.ref(bad); fail("accepted $bad") } catch (_: BrowserArguments.Rejected) { /* expected */ }
        assertEquals("hi", BrowserArguments.typed("hi"))
        try { BrowserArguments.typed("x".repeat(BrowserArguments.MAX_TYPED + 1)); fail() } catch (_: BrowserArguments.Rejected) { /* expected */ }
        try { BrowserArguments.typed(5); fail() } catch (_: BrowserArguments.Rejected) { /* expected */ }
    }

    @Test fun passwordsAndFilesAreNotTypable() {
        assertTrue(BrowserArguments.typable("input", "text"))
        assertTrue(BrowserArguments.typable("input", "search"))
        assertTrue(BrowserArguments.typable("textarea", null))
        assertFalse(BrowserArguments.typable("input", "password"))
        assertFalse(BrowserArguments.typable("input", "file"))
        assertFalse(BrowserArguments.typable("input", "checkbox"))
        assertFalse(BrowserArguments.typable("button", null))
    }
}
