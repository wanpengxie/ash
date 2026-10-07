package ai.ash.widget

import ai.ash.host.TaskFrame

/** One thing on the Ash widget the owner has not taken in yet; [key] is the island's "noticed" key for it. */
data class AshItem(val key: String, val text: String)

/** What the Ash widget shows: a face, one status line (with a running clock from [since]), and up to three items. */
data class AshWidgetView(val status: String, val since: Long?, val avatar: String, val items: List<AshItem>) {
    /** Redraw only when something visible changes (the running clock ticks by itself). */
    val key: String get() = "$avatar|$status|$since|${items.joinToString("|") { it.key }}"
}

/**
 * The Ash widget's content, from the same task frame and "noticed" record as the island: whatever the owner already saw
 * in Ash (or closed on the island) is never shown again here either.
 */
object AshWidgetModel {
    const val MAX_ITEMS = 3

    internal fun view(frame: TaskFrame?, noticed: Set<String>, hostUp: Boolean, coreRunning: Boolean, stale: Boolean): AshWidgetView {
        if (!hostUp) return AshWidgetView("未运行 · 点此打开 Ash", null, "resting", emptyList())
        if (!coreRunning) return AshWidgetView("正在启动…", null, "default", emptyList())
        val turn = frame?.turn
        if (frame == null || turn == null || frame.state in setOf("idle", "resting"))
            return AshWidgetView(if (frame?.state == "resting") "在休息" else "在线", null, if (frame?.state == "resting") "resting" else "default", emptyList())
        val running = frame.canStop && frame.state !in setOf("done", "waiting_you")
        val items = buildList {
            for (c in frame.cards) if (c.state == "waiting" && "card:${c.id}" !in noticed) {
                val label = when { c.kind == "question" -> "等你回答"; c.kind == "confirmation" -> "等你确认"; else -> "待你批准" }
                add(AshItem("card:${c.id}", "$label：${c.title}"))
            }
            if (!running && "end:$turn" !in noticed) {
                val reply = frame.reply.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() }
                if (reply != null) add(AshItem("end:$turn", "Ash：$reply"))
                else if (frame.outcome == "completed") add(AshItem("end:$turn", "任务完成"))
            }
        }.take(MAX_ITEMS)
        return when {
            stale && running -> AshWidgetView("连接中断，状态待确认", null, "default", items)
            items.any { it.key.startsWith("card:") } -> AshWidgetView("等你回应", null, "focused", items)
            running -> AshWidgetView(frame.text.ifBlank { "在忙" }, frame.startedAt.takeIf { it > 0 },
                if (frame.state == "listening") "listening" else "thinking", items)
            items.isNotEmpty() -> AshWidgetView(if (frame.outcome == "completed") "刚完成" else "本轮已结束", null, "success", items)
            else -> AshWidgetView("在线", null, "default", items)
        }
    }
}
