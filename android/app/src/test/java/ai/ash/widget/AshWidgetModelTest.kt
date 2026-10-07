package ai.ash.widget

import ai.ash.host.TaskCard
import ai.ash.host.TaskFrame
import org.junit.Assert.*
import org.junit.Test

class AshWidgetModelTest {
    private fun card(id: String, kind: String = "question", state: String = "waiting") =
        TaskCard(id, "p_$id", "agent:main", "t_a", kind, "去哪吃", "", "", listOf("a" to "A"), 99_999, false, state)
    private fun frame(state: String, canStop: Boolean, cards: List<TaskCard> = emptyList(), reply: String = "", outcome: String = "") =
        TaskFrame("s", 1, "t_a", 1000, state, "在看网页", emptyList(), canStop, outcome = outcome, reply = reply, cards = cards)

    @Test fun offlineStartingAndIdle() {
        assertEquals("未运行 · 点此打开 Ash", AshWidgetModel.view(null, emptySet(), hostUp = false, coreRunning = false, stale = false).status)
        assertEquals("正在启动…", AshWidgetModel.view(null, emptySet(), hostUp = true, coreRunning = false, stale = false).status)
        val idle = AshWidgetModel.view(null, emptySet(), hostUp = true, coreRunning = true, stale = false)
        assertEquals("在线", idle.status); assertTrue(idle.items.isEmpty())
    }

    @Test fun runningShowsTheVerbAndAClock() {
        val v = AshWidgetModel.view(frame("working", true), emptySet(), hostUp = true, coreRunning = true, stale = false)
        assertEquals("在看网页", v.status); assertEquals(1000L, v.since); assertEquals("thinking", v.avatar)
    }

    @Test fun questionsAndResultsUntilSeen() {
        val f = frame("waiting_you", false, listOf(card("q1"), card("a1", "approval"), card("old", state = "answered")), reply = "\n订好了，周六晚七点\n详情…", outcome = "completed")
        val v = AshWidgetModel.view(f, emptySet(), hostUp = true, coreRunning = true, stale = false)
        assertEquals("等你回应", v.status)
        assertEquals(listOf("等你回答：去哪吃", "待你批准：去哪吃", "Ash：订好了，周六晚七点"), v.items.map { it.text })
        // Seen in Ash (the island's noticed keys): gone from the widget too.
        val seen = AshWidgetModel.view(f, setOf("card:q1", "card:a1", "end:t_a"), hostUp = true, coreRunning = true, stale = false)
        assertTrue(seen.items.isEmpty()); assertEquals("在线", seen.status)
        val result = AshWidgetModel.view(frame("done", false, reply = "好了", outcome = "completed"), emptySet(), hostUp = true, coreRunning = true, stale = false)
        assertEquals("刚完成", result.status); assertEquals("success", result.avatar)
        assertNotEquals(v.key, seen.key)
    }

    @Test fun atMostThreeItems() {
        val f = frame("waiting_you", false, (1..5).map { card("q$it") })
        assertEquals(3, AshWidgetModel.view(f, emptySet(), hostUp = true, coreRunning = true, stale = false).items.size)
    }
}
