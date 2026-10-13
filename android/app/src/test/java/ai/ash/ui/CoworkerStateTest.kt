package ai.ash.ui
import org.junit.Test
import org.junit.Assert.*
import org.json.JSONObject
import org.json.JSONArray
class CoworkerStateTest {
    private val work = JSONObject().put("kind","conversation").put("node_id","mac").put("endpoint_id","mac").put("native_id","thread")
    private fun state(key: String) = JSONObject().put("connector_epoch","epoch").put("allowed_actions",JSONArray().put("send_input").put("steer"))
        .put("snapshot",JSONObject().put("state",key).put("work",work).put("connector_epoch","epoch").put("source","codex.live").put("observed_at","2026-10-13T00:00:00Z").put("identity_provenance","observed_turn_started").put("turn_id","live-turn"))
    @Test fun actionSpecificLeaseCannotCrossAnIdleActiveTransition() {
        assertEquals("send_input",coworkerAction(state("idle"),work,"send_input"))
        assertNull(coworkerAction(state("active"),work,"send_input"))
        assertEquals("steer",coworkerAction(state("active"),work,"steer"))
        assertNull(coworkerAction(state("idle"),work,"steer"))
    }
    @Test fun unknownOrMismatchedIdentityCannotSend() {
        assertNull(coworkerAction(state("unknown"),work,"send_input"))
        val other=JSONObject(work.toString()).put("native_id","other")
        assertNull(coworkerAction(state("idle"),other,"send_input"))
        val data=state("active");data.getJSONObject("snapshot").remove("turn_id")
        assertNull(coworkerAction(data,work,"steer"))
    }
    @Test fun linksKeepWebNavigationAndLocalArtifactsWithoutExecutableSchemes() {
        for(href in listOf("https://example.com","http://example.com"))assertEquals(CoworkerLink.WEB,coworkerLink(href))
        for(href in listOf("./build/result.md","artifact.md","/project/result.md","file:///project/result.md"))assertEquals(CoworkerLink.FILE,coworkerLink(href))
        for(href in listOf("javascript:alert(1)","data:text/html,x"))assertEquals(CoworkerLink.REJECTED,coworkerLink(href))
    }
    @Test fun fencedCopyPreservesWhitespaceWithoutCopyingMarkdownFence() {
        val source = "正文\n```kotlin\n\n  val value = 1  \nprintln(value)\n```\n更多\n```text\nsecond block\n```"
        assertEquals(listOf("\n  val value = 1  \nprintln(value)", "second block"), coworkerCodeBlocks(source))
        assertEquals(emptyList<String>(), coworkerCodeBlocks("`inline` is not a block"))
    }

}
