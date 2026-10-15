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
        val deliveryKnown: Boolean = false, val reminderDelivery: String? = null,
        val conversationDelivery: String? = null, val doneAt: Long? = null,
    ) {
        val open get() = status in setOf("todo", "doing", "waiting")
        val key get() = "task:$id"
    }
    enum class View(val label: String) { TODAY("现在"), WAITING("你的事"), ASH("Ash 自己的事"), ALL("全部"), CLOSED("已完成 / 不做了") }
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
    data class Now(val recovery: List<Task>, val current: List<Task>, val agents: List<Task>, val yours: List<Task>, val results: List<Task>)
    fun currentReason(task: Task, now: Long): String? {
        if (!task.open || task.assignee != "person:owner" || task.status == "waiting") return null
        return when {
            task.dueAt != null && task.dueAt <= now -> "已到截止时间"
            task.remindAt != null && task.remindAt <= now -> "提醒时间已到"
            else -> null
        }
    }
    fun needsRecovery(task: Task) = task.remindersPending || task.conversationPending
    fun now(tasks: List<Task>, at: Long): Now {
        val ordered = rows(tasks, View.ALL, at)
        return Now(ordered.filter(::needsRecovery), ordered.filter { !needsRecovery(it) && currentReason(it, at) != null },
            ordered.filter { it.open && it.assignee != "person:owner" },
            ordered.filter { it.open && it.assignee == "person:owner" && !needsRecovery(it) },
            ordered.filter { !it.open }.sortedByDescending { it.doneAt ?: it.updatedAt })
    }
    fun delivery(task: Task): String = when {
        needsRecovery(task) -> listOfNotNull("已保存", if(task.remindersPending)"提醒尚未安排" else null,if(task.conversationPending)"对话卡待恢复" else null).joinToString(" · ")
        !task.deliveryKnown -> "提醒与对话卡状态未取得"
        task.reminderDelivery == "ready" -> when {
            task.remindAt!=null -> "提醒已安排"
            task.dueAt!=null -> "到期跟进已安排"
            else -> "未设置提醒"
        }
        task.reminderDelivery == "none" -> if (task.remindAt == null && task.dueAt == null) "未设置提醒" else "没有待安排的提醒"
        else -> "提醒状态未取得"
    }
    fun recoveryAction(task: Task) = if(task.remindersPending && task.conversationPending)"补上提醒与卡片" else if(task.remindersPending)"补上提醒" else "补上对话卡"
    fun status(task: Task) = when (task.status) { "doing" -> "在做"; "waiting" -> "等待"; "done" -> "已标记完成"; "dropped" -> "不做了"; else -> "待做" }
    fun assignee(task: Task, names: Map<String, String> = emptyMap()) = names[task.assignee]
        ?: if (task.assignee == "person:owner") "你" else if (task.assignee == "agent:main") "Ash" else task.assignee.removePrefix("agent:")
    fun shouldRefresh(from: String, word: String) = from == "service:tasks" && word == "task.changed"
}
