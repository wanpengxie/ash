package ai.ash.sysapps.codex

import ai.ash.ui.CodexModel
import org.junit.Assert.*
import org.junit.Test

class CodexEvidenceTest {
    private fun detail(state: String = "idle", status: String = "unknown", items: List<CodexModel.Item> = emptyList()) =
        CodexModel.Detail(CodexModel.Session("t", "work", state, true, "/work", null), listOf(CodexModel.Turn("round", status, items)), emptyList())
    @Test fun idleAndModelWordsNeverBecomeCompletionOrVerifiedFileEvidence() {
        val d = detail(items = listOf(CodexModel.Item("agent", "All tests passed; changed src/a.kt")))
        assertEquals("当前未运行", CodexEvidence.roundLabel(d)); assertTrue(CodexEvidence.files(d).isEmpty())
        assertEquals("All tests passed; changed src/a.kt", CodexEvidence.report(d))
        assertEquals("本轮已结束", CodexEvidence.roundLabel(detail(status = "completed")))
        assertEquals("本轮已停止", CodexEvidence.roundLabel(detail(status = "interrupted")))
        assertEquals("运行中", CodexEvidence.roundLabel(detail(state = "running", status = "completed")))
    }
    @Test fun onlyOriginalFilesAndTheLastRoundReportArePresented() {
        val d = detail(items = listOf(CodexModel.Item("file", "src/a.kt"), CodexModel.Item("command", "tests failed"), CodexModel.Item("agent", "Still investigating")))
        assertEquals(listOf("src/a.kt"), CodexEvidence.files(d)); assertEquals("Still investigating", CodexEvidence.report(d))
    }
}
