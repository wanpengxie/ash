package ai.ash.ui

import org.junit.Assert.*
import org.junit.Test

class GatewayUrlTest {
    @Test fun httpsGatewaysAreKeptAsTheirOrigin() {
        assertEquals("https://ash.example.com", normalizeGatewayUrl("https://ash.example.com"))
        assertEquals("https://ash.example.com:8443", normalizeGatewayUrl("https://ash.example.com:8443/"))
    }
    @Test fun plainHttpOnlyReachesThisPhoneItself() {
        assertEquals("http://127.0.0.1:18988", normalizeGatewayUrl("http://127.0.0.1:18988"))
        assertEquals("http://localhost:8787", normalizeGatewayUrl("http://localhost:8787/"))
        assertNull(normalizeGatewayUrl("http://ash.example.com"))
        assertNull(normalizeGatewayUrl("http://192.168.1.5:8787"))
        assertNull(normalizeGatewayUrl("http://127.0.0.1.example.com"))
        assertNull(normalizeGatewayUrl("http://localhost.example.com"))
    }
    @Test fun anythingButAnOriginIsRefused() {
        assertNull(normalizeGatewayUrl("ftp://ash.example.com"))
        assertNull(normalizeGatewayUrl("https://user@ash.example.com"))
        assertNull(normalizeGatewayUrl("https://ash.example.com/path"))
        assertNull(normalizeGatewayUrl("https://ash.example.com/?q=1"))
        assertNull(normalizeGatewayUrl("https://ash.example.com/#x"))
        assertNull(normalizeGatewayUrl("not a url"))
    }
}
