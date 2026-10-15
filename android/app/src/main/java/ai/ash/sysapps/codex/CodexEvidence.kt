package ai.ash.sysapps.codex

import ai.ash.ui.CodexModel

/** Presentation of returned evidence, never an interpretation of a goal or test outcome. */
object CodexEvidence {
    fun roundLabel(detail: CodexModel.Detail): String = when {
        detail.session.waiting -> "等本次批准"
        detail.session.running -> "运行中"
        detail.turns.lastOrNull()?.status in setOf("completed", "complete") -> "本轮已结束"
        detail.turns.lastOrNull()?.status in setOf("interrupted", "cancelled", "canceled") -> "本轮已停止"
        detail.turns.lastOrNull()?.status in setOf("failed", "error") -> "本轮失败"
        else -> "当前未运行"
    }
    fun files(detail: CodexModel.Detail) = detail.turns.lastOrNull()?.items.orEmpty()
        .filter { it.kind == "file" && it.text.isNotBlank() }.map { it.text }.distinct()
    fun report(detail: CodexModel.Detail) = detail.turns.lastOrNull()?.items.orEmpty()
        .lastOrNull { it.kind == "agent" && it.text.isNotBlank() }?.text
}
