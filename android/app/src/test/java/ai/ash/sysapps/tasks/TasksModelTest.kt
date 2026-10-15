package ai.ash.sysapps.tasks

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class TasksModelTest {
    private val now = Instant.parse("2026-10-15T12:00:00Z").toEpochMilli()
    private val tasks = listOf(
        TasksModel.Task("old", "逾期", dueAt = now - 86400000),
        TasksModel.Task("today", "今天", remindAt = now + 1000),
        TasksModel.Task("later", "明天", dueAt = now + 86400000),
        TasksModel.Task("ash", "我在做", subject = "ash", assignee = "agent:helper", status = "doing"),
        TasksModel.Task("done", "完成了", status = "done", dueAt = now - 1000),
    )
    @Test fun todayIncludesOverdueButNotClosedOrUnscheduled() {
        assertEquals(setOf("old", "today"), TasksModel.rows(tasks, TasksModel.View.TODAY, now, ZoneId.of("UTC")).map { it.id }.toSet())
    }
    @Test fun ashViewSharesSubjectAcrossAssignees() {
        assertEquals(listOf("ash"), TasksModel.rows(tasks, TasksModel.View.ASH, now).map { it.id })
        assertEquals(1, TasksModel.rows(tasks, TasksModel.View.CLOSED, now).size)
    }
    @Test fun staleAndFailedReadsPreserveTheLastSnapshot() {
        val initial = TasksModel.State().request().success(1, tasks)
        val next = initial.request()
        assertEquals(next, next.success(1, emptyList()))
        val failure = next.failure(2, "断线")
        assertEquals(tasks, failure.tasks); assertTrue(failure.loaded)
    }
    @Test fun eventAndKeysAreStable() {
        assertTrue(TasksModel.shouldRefresh("service:tasks", "task.changed"))
        assertFalse(TasksModel.shouldRefresh("agent:other", "task.changed"))
        assertEquals(tasks[0].key, tasks[0].copy(status = "done").key)
    }
    @Test fun currentAttentionUsesActualTimesAndResponsibilityRatherThanOwnership() {
        val waiting=TasksModel.Task("waiting","等外部",status="waiting",dueAt=now-1)
        val future=TasksModel.Task("future","稍后提醒",remindAt=now+1)
        val due=TasksModel.Task("due","截止",dueAt=now-1)
        val remind=TasksModel.Task("remind","提醒",remindAt=now-1)
        val helper=TasksModel.Task("helper","主人的事",subject="owner",assignee="agent:helper",status="waiting",remindAt=now-1)
        assertNull(TasksModel.currentReason(waiting,now));assertNull(TasksModel.currentReason(future,now));assertNull(TasksModel.currentReason(helper,now))
        assertEquals("已到截止时间",TasksModel.currentReason(due,now));assertEquals("提醒时间已到",TasksModel.currentReason(remind,now))
        assertEquals(listOf("helper"),TasksModel.now(listOf(helper),now).agents.map { it.id })
    }
    @Test fun futureRecoveryIsDistinctFromDueAndMissingDeliveryIsNotReady() {
        val pending=TasksModel.Task("p","下周",remindAt=now+7*86400000L,remindersPending=true)
        val ordinary=TasksModel.Task("o","明天",remindAt=now+86400000L)
        val projection=TasksModel.now(listOf(pending,ordinary),now)
        assertEquals(listOf("p"),projection.recovery.map { it.id });assertTrue(projection.current.isEmpty())
        assertEquals(listOf("o"),projection.yours.map { it.id })
        assertTrue(TasksModel.delivery(ordinary).contains("未取得"));assertTrue(TasksModel.delivery(pending).contains("提醒尚未安排"))
        val assigned=pending.copy(remindersPending=false,deliveryKnown=true,reminderDelivery="ready")
        assertEquals("提醒已安排",TasksModel.delivery(assigned))
        assertEquals("未设置提醒",TasksModel.delivery(assigned.copy(remindAt=null)))
        assertEquals("到期跟进已安排",TasksModel.delivery(assigned.copy(remindAt=null,dueAt=now+1000)))
    }

}
