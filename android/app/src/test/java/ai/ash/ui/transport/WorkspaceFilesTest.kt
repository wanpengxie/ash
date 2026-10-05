package ai.ash.ui.transport

import org.junit.Assert.*
import org.junit.Test

class WorkspaceFilesTest {
    @Test fun virtualFileOriginCannotReachAnythingButReadOnlyFileContents() {
        assertEquals("/api/workspaces/home/content/report/index.html", workspaceContentRoute("$FILE_ORIGIN/api/workspaces/home/content/report/index.html"))
        for (url in listOf("http://ash-files.invalid/api/workspaces/home/content/a", "$FILE_ORIGIN/api/send", "$FILE_ORIGIN/api/vault",
            "$FILE_ORIGIN/api/workspaces/home/content/../../send", "https://evil.test/api/workspaces/home/content/a", "$FILE_ORIGIN/api/workspaces/home/content/a?token=x"))
            assertNull(url, workspaceContentRoute(url))
    }
    @Test fun saveNamesAreWorkspaceRelativeFilesNotArbitraryUrls() {
        assertEquals("/api/workspaces/home/files?path=reports%2Fa+b.md", workspaceReadRoute("home", "reports/a b.md"))
        for (path in listOf("/etc/passwd", "../key", "a/../key", "a\\b", "a\u0000b", ""))
            assertTrue(runCatching { workspaceReadRoute("home", path) }.isFailure)
    }
}
