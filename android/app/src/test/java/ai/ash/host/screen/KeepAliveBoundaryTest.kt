package ai.ash.host.screen

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The helper's keep-alive switch flow is for the owner's tap on a permission entry: no agent-facing tool reaches it. */
class KeepAliveBoundaryTest {
    private val sources = listOf("src/main/java", "../screen/src/main/java", "../bridge/src/main/java")
        .map(::File).filter { it.isDirectory }.flatMap { dir -> dir.walk().filter { it.extension == "kt" }.toList() }

    @Test fun onlyTheFlowItsToolAndTheBridgeNameIt() {
        assertTrue("no sources found", sources.isNotEmpty())
        val users = sources.filter { Regex("""KeepAliveSwitches\.CAPABILITY|ash\.keepalive_switches""").containsMatchIn(it.readText()) }.map { it.name }.toSet()
        assertEquals(setOf("KeepAliveFlow.kt", "ScreenCapabilities.kt", "BridgeService.kt", "KeepAliveSwitches.kt"), users)
    }

    @Test fun theFlowIsStartedOnlyFromPermissionEntries() {
        val users = sources.filter { Regex("""KeepAliveFlow\.""").containsMatchIn(it.readText()) }.map { it.name }.toSet()
        assertEquals(setOf("Permissions.kt", "ScreenInstaller.kt"), users)
    }
}
