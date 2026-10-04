package ai.ash.host

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CoreProcessConfigTest {
    @Test fun dnsPutsIpv4FirstAndFallsBackWhenEmpty() {
        assertEquals(listOf("10.0.2.3", "8.8.8.8", "fe80::1%wlan0"), CoreProcess.orderDns(listOf("fe80::1%wlan0", "10.0.2.3", "8.8.8.8", "10.0.2.3")))
        assertEquals(listOf("223.5.5.5", "119.29.29.29"), CoreProcess.orderDns(emptyList()))
        assertEquals(listOf("223.5.5.5", "119.29.29.29"), CoreProcess.orderDns(listOf(" ")))
    }

    @Test fun proxyVariablesKeepLoopbackDirect() {
        assertTrue(CoreProcess.proxyEnv(null).isEmpty())
        val env = CoreProcess.proxyEnv("192.168.1.2:7890")
        assertEquals("http://192.168.1.2:7890", env["HTTPS_PROXY"])
        assertEquals("http://192.168.1.2:7890", env["http_proxy"])
        assertEquals("1", env["NODE_USE_ENV_PROXY"])
        assertTrue(env.getValue("NO_PROXY").split(",").contains("127.0.0.1"))
    }
}
