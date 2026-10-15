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
}
