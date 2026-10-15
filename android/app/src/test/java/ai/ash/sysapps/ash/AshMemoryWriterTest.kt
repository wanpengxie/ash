package ai.ash.sysapps.ash

import ai.ash.ui.HumanPort
import ai.ash.ui.Reply
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Exercises the production write workflow and its actual get/set envelopes, not just the text reducer. */
class AshMemoryWriterTest {
    private fun ok(data: JSONObject) = Reply(true, data, null, null)
    private fun memory(text: String, truncated: Boolean = false) = JSONObject().put("files", JSONArray().put(JSONObject().put("file", "USER.md").put("content", text).put("truncated", truncated)))

    @Test fun correctionReadsTheLatestDocumentBeforeChangingOnlyTheSelectedFact() {
        val calls = ArrayList<Pair<String, JSONObject>>()
        var readDone: ((Reply) -> Unit)? = null
        val writer = AshMemoryWriter { word, body, done ->
            calls.add(word to body)
            if (word == "memory.get") readDone = done else done(ok(JSONObject().put("saved", true)))
        }
        var result: Reply? = null
        writer.save("USER.md", "会议周二", "会议周三") { result = it }
        assertEquals(listOf("memory.get"), calls.map { it.first })
        assertNull(result)
        // The agent added a preference after the user opened the editor. It must survive the correction.
        readDone!!(ok(memory("# 安排\n- 会议周二\n- 爱喝美式\n- 新添的偏好\n")))
        assertEquals(listOf("memory.get", "memory.set"), calls.map { it.first })
        assertEquals("USER.md", calls.last().second.getString("file"))
        assertEquals("# 安排\n- 会议周三\n- 爱喝美式\n- 新添的偏好\n", calls.last().second.getString("content"))
        assertTrue(result!!.ok)
    }

    @Test fun deletionUsesTheSameLatestReadAndLeavesOtherFactsIntact() {
        var written: JSONObject? = null
        val writer = AshMemoryWriter { word, body, done ->
            if (word == "memory.get") done(ok(memory("- 会议周二\n- 早睡\n")))
            else { written = body; done(ok(JSONObject().put("saved", true))) }
        }
        writer.save("USER.md", "会议周二", null) { assertTrue(it.ok) }
        assertEquals("- 早睡\n", written!!.getString("content"))
    }

    @Test fun missingAmbiguousAndTruncatedFactsNeverReachTheWriteWord() {
        for (document in listOf(memory("- 已改成周三\n"), memory("- 会议周二\n- 会议周二\n"), memory("- 会议周二", true))) {
            val words = ArrayList<String>()
            val writer = AshMemoryWriter { word, _, done -> words.add(word); done(ok(document)) }
            writer.save("USER.md", "会议周二", "会议周三") { assertFalse(it.ok) }
            assertEquals(listOf("memory.get"), words)
        }
    }

    @Test fun offlineReadDoesNotWriteAndAnUnknownWriteIsReportedAsUnknown() {
        val offline = Reply(false, JSONObject(), null, HumanPort.Failure("offline", "offline"))
        val unknown = Reply(false, JSONObject(), null, HumanPort.Failure("result_unknown", "unknown"))
        val words = ArrayList<String>()
        AshMemoryWriter { word, _, done -> words.add(word); done(offline) }.save("USER.md", "会议周二", "会议周三") { assertEquals("offline", it.code) }
        assertEquals(listOf("memory.get"), words)
        AshMemoryWriter { word, _, done -> done(if (word == "memory.get") ok(memory("- 会议周二")) else unknown) }
            .save("USER.md", "会议周二", "会议周三") { assertEquals("result_unknown", it.code); assertTrue(it.retryable) }
    }
}
