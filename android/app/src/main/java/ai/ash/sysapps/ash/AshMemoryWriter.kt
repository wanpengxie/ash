package ai.ash.sysapps.ash

import ai.ash.ui.HumanPort
import ai.ash.ui.Reply
import org.json.JSONObject

/** The memory app's write path: reread the complete current file, patch one fact, then use the existing persona word. */
class AshMemoryWriter(private val request: (String, JSONObject, (Reply) -> Unit) -> Unit) {
    fun save(file: String, item: String?, replacement: String?, done: (Reply) -> Unit) {
        request("memory.get", JSONObject().put("file", file)) read@{ read ->
            if (!read.ok) { done(read); return@read }
            val files = read.data.optJSONArray("files")
            val current = files?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) }.firstOrNull { it.optString("file") == file } }
            if (current == null || !current.has("content") || current.optBoolean("truncated")) {
                done(failure("memory_incomplete", "没有读到完整记忆，未覆盖文件。")); return@read
            }
            val content = if (item == null) replacement.orEmpty() else AshModel.editItem(current.getString("content"), item, replacement)
            if (content == null) { done(failure("memory_changed", "这条记忆已变化或有重复，未修改。请刷新后再选；你的草稿仍在。")); return@read }
            request("memory.set", JSONObject().put("file", file).put("content", content).put("reason", "主人在 Ash 应用中纠正"), done)
        }
    }
    private fun failure(code: String, text: String) = Reply(false, JSONObject(), null, HumanPort.Failure(code, text))
}
