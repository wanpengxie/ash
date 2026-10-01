package ai.ash.host

import ai.ash.BuildConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IsolatedProbePortsTest {
    @Test fun buildVariantKeepsCoreHostAndSensePortsTogether() {
        val probe = BuildConfig.APPLICATION_ID == "ai.ash.agent.probe"
        assertEquals(probe, BuildConfig.ISOLATED_PROBE)
        assertEquals(if (probe) 14763 else 4700, BuildConfig.CORE_PORT)
        assertEquals(if (probe) 14764 else 4710, BuildConfig.HOST_PORT)
        assertEquals(if (probe) 14763 else if (BuildConfig.APPLICATION_ID.endsWith(".sensesprobe")) 4870 else 4700,
            BuildConfig.SENSE_PORT)
        assertEquals(BuildConfig.CORE_PORT, CoreProcess.PORT)
    }

    @Test fun nativeBootstrapRejectsOtherPortsAndOrigins() {
        val own = "http://127.0.0.1:14763/?token=synthetic"
        assertTrue(CoreEndpoint.acceptsUiUrl(own, 14763))
        for (url in listOf(
            "http://127.0.0.1:4700/?token=synthetic",
            "http://localhost:14763/?token=synthetic",
            "http://user@127.0.0.1:14763/?token=synthetic",
            "https://127.0.0.1:14763/?token=synthetic",
            "http://127.0.0.1:14763/other?token=synthetic",
            "not a URL",
        )) assertFalse(CoreEndpoint.acceptsUiUrl(url, 14763))
        assertFalse(CoreEndpoint.acceptsUiUrl("http://127.0.0.1:4700/", 14763))
    }
}
