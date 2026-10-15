package ai.ash.sysapps.ash

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class AshModelTest {
    @Test fun appArgumentsUseTheSameRouteForColdAndReusedActivities() {
        assertEquals(AshModel.Open("memory"), AshModel.openArgument("""{"section":"memory"}"""))
        assertEquals(AshModel.Open("diary", "2026-10-15"), AshModel.openArgument("""{"section":"diary","date":"2026-10-15"}"""))
        assertEquals(AshModel.Open("diary"), AshModel.openArgument("""{"section":"diary","date":"2026-02-30"}"""))
        assertEquals(AshModel.Open(), AshModel.openArgument("invalid"))
        assertEquals(AshModel.Open(), AshModel.openArgument("""{"section":"missing","date":"2026-10-15"}"""))
    }
    @Test fun sharedTasksAreFilteredAndSortedWithoutCopyingOwnerWork() {
        val data = JSONObject("""{"tasks":[{"id":"owner","subject":"owner","title":"购物"},{"id":"a","subject":"ash","title":"学习","status":"todo","source":{"message":"m1"}},{"id":"b","subject":"ash","title":"改进提醒","status":"doing","thread":"t1"},{"id":"c","subject":"ash","title":"旧事","status":"dropped"}]}""")
        val todos = AshModel.todos(data)
        assertEquals(listOf("a", "b", "c"), todos.map { it.id })
        assertEquals("m1", todos.first().source)
        assertEquals(listOf("b", "a"), AshModel.activeTodos(todos).map { it.id })
    }
    @Test fun failedOrLateReadsNeverClearTheLastGoodSnapshot() {
        val slot = AshModel.ReadSlot<List<String>>()
        val first = slot.begin()!!
        assertNull(slot.begin())
        assertTrue(slot.finish(first, listOf("keep")))
        val second = slot.begin()!!
        slot.finish(first, emptyList())
        assertEquals(listOf("keep"), slot.value)
        assertTrue(slot.busy)
        slot.finish(second, null, "离线")
        assertEquals(listOf("keep"), slot.value)
        assertEquals("离线", slot.error)
        slot.cancel()
        slot.finish(second, emptyList())
        assertEquals(listOf("keep"), slot.value)
    }
    @Test fun memoryEditsPreserveOtherFactsAndDoNotGuessMissingLines() {
        val text = "# 关于你\n- 爱喝美式\n- 早睡\n"
        assertEquals("# 关于你\n- 不喝咖啡\n- 早睡\n", AshModel.editItem(text, "爱喝美式", "不喝咖啡"))
        assertEquals("# 关于你\n- 早睡\n", AshModel.editItem(text, "爱喝美式", null))
        assertNull(AshModel.editItem(text, "不存在", "新内容"))
    }
    @Test fun diaryPartsAndPaginationKeepRealContentAndUniqueDays() {
        val parts = AshModel.diaryParts("# 今天\n## 复盘\n- 我学到了什么\n<!-- review:done -->")
        assertEquals(listOf(AshModel.Part("复盘", listOf("我学到了什么"))), parts)
        val day = AshModel.Day("2026-10-12", "安静", true, 0)
        assertEquals(listOf(day), AshModel.moreDays(listOf(day), AshModel.DayPage(listOf(day), null)).days)
        assertEquals("未记录", AshModel.who(null, "agent:main", "Ash"))
    }
    @Test fun nowDoesNotInventWorkFromAnEndedProgress() {
        val now = AshModel.now(true, JSONObject("""{"presence":{"state":"working","text":"查路线"},"progress":{"started":12,"ended":20}}"""), null, 30)
        assertNull(now.since)
        assertEquals("查路线", AshModel.nowText(now, "Ash"))
        assertEquals("offline", AshModel.now(false, null, null, 30).state)
    }
}
