package ai.ash.host.screen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Ash holds WRITE_SECURE_SETTINGS for one thing: bringing its screen helper's accessibility service back. Android grants
 * it whole, so the boundary is kept here, in code: one file writes secure settings, only the accessibility keys, only
 * the helper's own entry, and nothing the agent can call reaches it.
 */
class SecureSettingsBoundaryTest {
    private val sources = listOf("src/main/java", "../screen/src/main/java", "../bridge/src/main/java")
        .map(::File).filter { it.isDirectory }.flatMap { dir -> dir.walk().filter { it.extension == "kt" || it.extension == "java" }.toList() }
    private val write = Regex("""Settings\.(Secure|Global)\.put\w*\(|\.putString\(\s*resolver|content://settings/(secure|global)""")

    @Test fun onlyRecoveryWritesSecureOrGlobalSettings() {
        assertTrue("no sources found", sources.isNotEmpty())
        val writers = sources.filter { write.containsMatchIn(it.readText()) }.map { it.name }.toSet()
        assertEquals(setOf("ScreenRecovery.kt"), writers)
    }

    @Test fun recoveryWritesOnlyTheAccessibilityKeys() {
        val recovery = sources.single { it.name == "ScreenRecovery.kt" }.readText()
        val keys = Regex("""Settings\.Secure\.put\w*\(\s*resolver\s*,\s*([\w.]+)""").findAll(recovery).map { it.groupValues[1] }.toSet()
        assertEquals(setOf("key", "Settings.Secure.ACCESSIBILITY_ENABLED"), keys)
        assertTrue(recovery.contains("val key = Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES"))
    }

    @Test fun noAgentCapabilityReachesRecovery() {
        val tools = sources.filter { f -> f.path.contains("/host/cap/") || f.path.contains("/screen/src/") }
        // A call or an import, not a mention in a comment.
        val use = Regex("""ScreenRecovery\.|import\s+ai\.ash\.host\.screen\.ScreenRecovery""")
        assertFalse(tools.filter { use.containsMatchIn(it.readText()) }.map { it.name }.toString(), tools.any { use.containsMatchIn(it.readText()) })
    }

    @Test fun onlyTheHelpersEntryIsTakenOutAndPutBack() {
        val list = "com.other/.Reader:ai.ash.screen/ai.ash.screen.a11y.A11yService:com.third/.Svc"
        assertEquals(listOf("ai.ash.screen/ai.ash.screen.a11y.A11yService"), ScreenRecovery.Services.helpers(list))
        val without = ScreenRecovery.Services.withoutHelper(list)
        assertEquals("com.other/.Reader:com.third/.Svc", without)
        assertEquals("com.other/.Reader:com.third/.Svc:ai.ash.screen/ai.ash.screen.a11y.A11yService", ScreenRecovery.Services.withHelperBack(without, list))
        // Never adds the helper unless the owner had it on; a look-alike package is not the helper.
        assertEquals("com.other/.Reader", ScreenRecovery.Services.withHelperBack("com.other/.Reader", "com.other/.Reader"))
        assertEquals(emptyList<String>(), ScreenRecovery.Services.helpers("ai.ash.screenfake/.X"))
    }
}
