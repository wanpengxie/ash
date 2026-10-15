package ai.ash.sysapps.team

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TeamModelTest {
    @Test fun failedAndLateReadsKeepTheLastSnapshot() {
        val r = TeamModel.Read<List<String>>()
        val first = r.begin()!!; assertNull(r.begin()); r.finish(first, listOf("kept"))
        val old = r.begin()!!; r.invalidate(); val fresh = r.begin()!!
        assertFalse(r.finish(old, emptyList())); r.finish(fresh, null, "离线")
        assertEquals(listOf("kept"), r.value); assertEquals("离线", r.error)
    }
    @Test fun primaryFirstAndWaitingIsNotMistakenForIdle() {
        val members = TeamModel.members(JSONObject("""{"agents":[{"id":"agent:h","name":"帮手","state":"working","waiting_on":["agent:main"]},{"id":"agent:main","name":"Ash","state":"idle","primary":true}]}"""))
        assertEquals("agent:main", members.first().id)
        assertEquals("在等 Ash", members.last().status(members.associate { it.id to it.name }))
    }
    @Test fun answeredRequestKeepsItsIdentityAndOlderPages() {
        val e = TeamModel.Exchange("m1", 1, 0, "agent:a", "agent:b", "ask", "x", "waiting", null)
        val newer = e.copy(id = "m2", seq = 2)
        val answered = e.copy(state = "answered", answer = TeamModel.Answer(3, 0, "ok", ""))
        val rows = TeamModel.merge(listOf(e, newer), listOf(answered))
        assertEquals(listOf("m2", "m1"), rows.map { it.id }); assertEquals("ok", rows.last().answer?.text)
    }
    @Test fun malformedSuccessCannotClearTheList() {
        assertTrue(runCatching { TeamModel.members(JSONObject()) }.isFailure)
        assertTrue(runCatching { TeamModel.exchanges(JSONObject()) }.isFailure)
        assertTrue(runCatching { TeamModel.costs(JSONObject()) }.isFailure)
    }
    @Test fun sourceRetainsBlobAndNestedBodyLocation() {
        val q = TeamModel.source(JSONObject("""{"body":{"text":{"${'$'}blob":"abc","mime":"text/plain","summary":"长文"}}}"""), false, "ask")
        assertEquals("abc", q.hash); assertTrue(q.path.isEmpty())
        val a = TeamModel.source(JSONObject("""{"body":{"result":{"${'$'}blob":"def","mime":"application/json","summary":"结果"}}}"""), true, "ask")
        assertEquals(listOf("data", "answer"), a.path)
    }
    @Test fun eventsRefreshOnlyTheRelevantSources() {
        assertTrue(TeamModel.refresh(JSONObject("""{"from":"agent:a","word":"turn.ended"}""")).members)
        assertTrue(TeamModel.refresh(JSONObject("""{"from":"service:cost","word":"usage.recorded"}""")).costs)
        assertEquals(TeamModel.Refresh(), TeamModel.refresh(JSONObject("""{"from":"person:owner","to":"agent:main","word":"say"}""")))
    }
    @Test fun unknownCostsAreSaidAndNotDisguisedAsFree() {
        assertTrue(TeamModel.Cost(0.0, 2).label().contains("2 次未计价"))
    }
}
