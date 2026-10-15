package ai.ash.sysapps.tasks

import java.time.Instant
import java.time.ZoneId

/** Shared task facts; UI does not own deadlines or reminders. MOBILE-ARCH §1.4, §2.2, §3.2. */
object TasksModel {
    data class Source(val message: String, val agent: String = "")
    data class Task(
        val id: String, val title: String, val note: String = "", val subject: String = "owner",
        val assignee: String = "person:owner", val status: String = "todo", val dueAt: Long? = null,
        val remindAt: Long? = null, val source: Source? = null, val result: String = "",
        val updatedBy: String = "", val updatedAt: Long = 0,
        val remindersPending: Boolean = false, val conversationPending: Boolean = false,
    ) {
        val open get() = status in setOf("todo", "doing", "waiting")
        val key get() = "task:$id"
    }
    enum class View(val label: String) { TODAY("今天"), WAITING("等你的"), ASH("Ash 在做"), ALL("全部"), CLOSED("已完成 / 不做了") }
    data class State(val tasks: List<Task> = emptyList(), val loaded: Boolean = false, val problem: String = "", val generation: Long = 0) {
        fun request() = copy(generation = generation + 1)
        fun success(token: Long, items: List<Task>) = if (token == generation) copy(tasks = items.toList(), loaded = true, problem = "") else this
        fun failure(token: Long, why: String) = if (token == generation) copy(problem = why) else this
    }
    fun rows(tasks: List<Task>, view: View, now: Long, zone: ZoneId = ZoneId.systemDefault()): List<Task> {
        val end = Instant.ofEpochMilli(now).atZone(zone).toLocalDate().plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        return tasks.filter { t -> when (view) {
            View.TODAY -> t.open && listOfNotNull(t.dueAt, t.remindAt).any { it < end }
            View.WAITING -> t.open && t.assignee == "person:owner"
            View.ASH -> t.open && t.subject == "ash"
            View.ALL -> true
            View.CLOSED -> !t.open
        } }.sortedWith(compareBy<Task> { if (it.open) 0 else 1 }.thenBy { it.dueAt ?: it.remindAt ?: Long.MAX_VALUE }.thenBy { it.id })
    }
    fun status(task: Task) = when (task.status) { "doing" -> "在做"; "waiting" -> "等对方"; "done" -> "完成"; "dropped" -> "不做了"; else -> "待做" }
    fun assignee(task: Task, names: Map<String, String> = emptyMap()) = names[task.assignee]
        ?: if (task.assignee == "person:owner") "你" else if (task.assignee == "agent:main") "Ash" else task.assignee.removePrefix("agent:")
    fun shouldRefresh(from: String, word: String) = from == "service:tasks" && word == "task.changed"
}
