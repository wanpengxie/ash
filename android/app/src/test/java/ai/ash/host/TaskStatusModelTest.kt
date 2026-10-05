package ai.ash.host

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TaskStatusModelTest {
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
    @Test fun completedTaskHasBriefFixedDurationEvenIfReplayed() {
        val m = TaskStatusModel(); m.accept(frame(), 2000)
        m.accept(frame(2, state = "done", canStop = false), 4000)
        assertEquals(3L, m.elapsed(7000)); assertTrue(m.visible(7000)); assertFalse(m.canStop("t_a", 7000))
        m.accept(frame(3, state = "done", canStop = false), 7500)
        assertFalse(m.visible(8000))
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
}
