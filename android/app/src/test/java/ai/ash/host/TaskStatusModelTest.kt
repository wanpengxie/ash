package ai.ash.host

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TaskStatusModelTest {
    @Test fun replyAndApprovalOriginalAreNotFlattenedOrTruncated() {
        val original = "x".repeat(2500) + "\n尾部原文"
        val card = JSONObject().put("id", "m_ask").put("pending_id", "m_action").put("to", "service:gate").put("turn", "t_a")
            .put("kind", "approval").put("title", "提交").put("detail", "摘要").put("original", original)
            .put("options", JSONArray().put(JSONObject().put("id", "once").put("label", "允许这一次")))
            .put("expires_at", 10000).put("state", "waiting")
        val b = JSONObject().put("session", "s").put("revision", 1).put("turn", "t_a").put("started_at", 1000)
            .put("state", "waiting_you").put("text", "等待你回应").put("steps", JSONArray()).put("can_stop", false)
            .put("reply", "你想选择哪个？\n\nA 或 B").put("cards", JSONArray().put(card))
        val f = TaskFrame.parse(b)
        assertEquals(original, f.cards.single().original)
        assertEquals("你想选择哪个？\n\nA 或 B", f.reply)
        assertTrue(f.cards.single().actionable(9000)); assertFalse(f.cards.single().actionable(10000))
        assertFalse(f.cards.single().copy(state = "answered").actionable(9000))
        assertFalse(f.cards.single().copy(state = "withdrawn").actionable(9000))
    }
    private fun frame(revision: Long = 1, session: String = "session-a", turn: String? = "t_a", state: String = "working", canStop: Boolean = true) =
        TaskFrame(session, revision, turn, 1000, state, "在搜索", listOf("在想", "在搜索"), canStop)
    @Test fun staleSnapshotsNeverRestoreAnOldTurnOrSession() {
        val m = TaskStatusModel()
        assertTrue(m.accept(frame(2), 2000)); assertFalse(m.accept(frame(1), 2100))
        assertTrue(m.accept(frame(1, "session-b", "t_new"), 2200))
        assertFalse(m.accept(frame(3), 2300)); assertEquals("t_new", m.frame?.turn)
    }
    @Test fun stoppedButtonsAreExactAndExpireBeforeStatusDisappears() {
        val m = TaskStatusModel(); m.accept(frame(), 2000)
        assertTrue(m.canStop("t_a", 2000)); assertFalse(m.canStop("t_old", 2000))
        assertTrue(m.visible(18000)); assertTrue(m.stale(18000)); assertFalse(m.canStop("t_a", 18000))
        assertTrue(m.visible(32000)); assertTrue(m.stale(32000)); assertFalse(m.canStop("t_a", 32000))
    }
    @Test fun endedReplyStaysUntilExplicitlyDismissedEvenAtHome() {
        val m = TaskStatusModel(); m.accept(frame(), 2000)
        m.accept(frame(2, state = "done", canStop = false), 4000)
        assertEquals(3L, m.elapsed(7000)); assertTrue(m.visible(7000)); assertFalse(m.canStop("t_a", 7000))
        m.accept(frame(3, state = "done", canStop = false), 7500)
        assertTrue(m.visible(8000)); assertTrue(m.dismiss("t_a")); assertFalse(m.visible(9000))
    }
    @Test fun idleAndRestartClearTaskVisibility() {
        val m = TaskStatusModel(); m.accept(frame(), 2000); m.clear(); assertFalse(m.visible(2100))
        m.accept(frame(turn = null, state = "idle", canStop = false), 2200); assertFalse(m.visible(2200))
    }
    @Test fun wireFrameIsBoundedAndCannotCreateIdleStopButton() {
        val b = JSONObject().put("session", "s").put("revision", 1).put("turn", "t_a").put("started_at", 1000)
            .put("state", "working").put("text", "hello\nworld").put("steps", JSONArray(listOf("a"))).put("can_stop", true)
        assertEquals("hello world", TaskFrame.parse(b).text)
        b.put("state", "idle"); assertThrows(IllegalArgumentException::class.java) { TaskFrame.parse(b) }
        b.put("state", "working").put("steps", JSONArray(List(6) { "x" }))
        assertThrows(IllegalArgumentException::class.java) { TaskFrame.parse(b) }
    }
    @Test fun activityToolAndStepClockAreSeparateFromTaskTitle() {
        val b = JSONObject().put("session", "s").put("revision", 1).put("turn", "t_a").put("started_at", 1000)
            .put("state", "working").put("text", "读取书架里的书名").put("steps", JSONArray(listOf("打开阅读应用")))
            .put("can_stop", true).put("tool", "screen.read").put("step_started_at", 2500)
        val parsed = TaskFrame.parse(b)
        assertEquals("读取书架里的书名", parsed.text); assertEquals("screen.read", parsed.tool)
        assertEquals(2500L, parsed.stepStartedAt); assertEquals(1000L, parsed.startedAt)
        b.remove("tool"); b.remove("step_started_at")
        assertEquals("", TaskFrame.parse(b).tool); assertEquals(1000L, TaskFrame.parse(b).stepStartedAt)
    }
    @Test fun completedHandoffStaysOutsideAshUntilDismissedAndNeverBecomesDisconnected() {
        val m = TaskStatusModel(); m.accept(frame(), 2000)
        m.accept(frame(2, state = "done", canStop = false).copy(outcome = "completed"), 4000)
        assertTrue(m.visible(60000, homeVisible = false)); assertFalse(m.stale(60000))
        assertFalse(m.dismiss("t_old")); assertTrue(m.visible(60000, homeVisible = false))
        assertTrue(m.dismiss("t_a")); assertFalse(m.visible(61000, homeVisible = false))
        m.accept(frame(3, state = "done", canStop = false), 62000)
        assertFalse(m.visible(63000, homeVisible = false))
        m.accept(frame(4, turn = "t_next"), 64000); assertTrue(m.visible(65000, homeVisible = false))
    }
    @Test fun returningHomeDoesNotConsumeAReplyOrQuestion() {
        val m = TaskStatusModel(); m.accept(frame(2, state = "done", canStop = false), 4000)
        assertTrue(m.visible(9000, homeVisible = true, editing = true))
        assertTrue(m.visible(10000, homeVisible = true, editing = false))
        assertTrue(m.visible(11000, homeVisible = false))
    }
}
