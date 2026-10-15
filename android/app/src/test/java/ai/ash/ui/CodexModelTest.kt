package ai.ash.ui

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CodexModelTest {
    @Test fun theListKeepsTheComputersOrderAndReadsEachSession() {
        val data = JSONObject("""{"sessions":[
            {"id":"t1","title":"Fix the build","state":"running","open":true,"cwd":"/work/app/","updated_at":1000},
            {"id":"t2","title":"Old idea","state":"idle","open":false},
            {"title":"no id"}]}""")
        val list = CodexModel.sessions(data)
        assertEquals(listOf("t1", "t2"), list.map { it.id })
        assertTrue(list[0].running); assertFalse(list[1].open)
        assertEquals("在跑", CodexModel.stateLabel(list[0])); assertEquals("历史", CodexModel.stateLabel(list[1]))
        assertEquals("app · 1 分钟前", CodexModel.subtitle(list[0], 61_000))
        assertEquals("", CodexModel.subtitle(list[1], 61_000))
        assertTrue(CodexModel.sessions(null).isEmpty())
    }

    @Test fun aSessionsTurnsAndWaitingApprovals() {
        val d = CodexModel.detail(JSONObject("""{"id":"t1","title":"T","state":"waiting_approval","open":true,
            "turns":[{"id":"u1","status":"inProgress","items":[{"kind":"user","text":"hi"},{"kind":"command","text":"npm test"}]}],
            "approvals":[{"request_id":"7","kind":"command","summary":"rm -rf build"},{"kind":"x","summary":"no id"}]}"""))!!
        assertTrue(d.session.waiting); assertEquals("等你批准", CodexModel.stateLabel(d.session))
        assertEquals(listOf("user" to "hi", "command" to "npm test"), d.turns.single().items.map { it.kind to it.text })
        assertEquals(listOf("7"), d.approvals.map { it.requestId })
        assertNull(CodexModel.detail(JSONObject("{}")))
    }

    @Test fun theComputersAreTheOnlineOnesAndTheChosenOneStays() {
        val data = JSONObject("""{"devices":[
            {"device":"device:phone","kind":"phone","online":true},
            {"device":"device:old","kind":"computer","online":false},
            {"device":"device:mac","kind":"computer","online":true,"name":"MacBook Pro"},
            {"device":"device:mini","kind":"computer","online":true,"name":"Mac mini"}]}""")
        val list = CodexModel.computers(data)
        assertEquals(listOf("MacBook Pro", "Mac mini"), list.map { it.name })
        assertEquals("device:mac", CodexModel.pick(list, null))
        assertEquals("device:mini", CodexModel.pick(list, "device:mini"))
        assertEquals("device:mac", CodexModel.pick(list, "device:gone"))
        assertNull(CodexModel.pick(CodexModel.computers(null), null))
    }

    @Test fun computersWithAnAdvertisedManifestMustActuallyOfferCodex() {
        val data = JSONObject("""{"devices":[
            {"device":"device:mac","kind":"computer","online":true,"capabilities":["x.codex.sessions"]},
            {"device":"device:other","kind":"computer","online":true,"capabilities":["workspace.read"]},
            {"device":"device:empty","kind":"computer","online":true,"capabilities":[]},
            {"device":"device:older-hub","kind":"computer","online":true}]}""")
        assertEquals(listOf("device:mac", "device:older-hub"), CodexModel.computers(data).map { it.id })
    }

    @Test fun sessionsGoByProjectTheBusyAndRecentFirst() {
        val data = JSONObject("""{"sessions":[
            {"id":"a","title":"A","state":"idle","cwd":"/w/app","updated_at":100},
            {"id":"b","title":"B","state":"idle","cwd":"/w/notes/","updated_at":300},
            {"id":"c","title":"C","state":"running","cwd":"/w/app","updated_at":50},
            {"id":"d","title":"D","state":"idle","updated_at":10}]}""")
        val projects = CodexModel.projects(CodexModel.sessions(data))
        assertEquals(listOf("app", "notes", "其他"), projects.map { it.name })
        assertEquals(listOf("a", "c"), projects[0].sessions.map { it.id })
        assertEquals("/w/notes", projects[1].cwd)
        assertNull(projects[2].cwd)
        assertEquals("t9", CodexModel.created(JSONObject("""{"thread":"t9","sent":true}""")))
    }

    @Test fun agoAndTheWordsForAFailure() {
        assertEquals("刚刚", CodexModel.ago(0, 30_000)); assertEquals("5 分钟前", CodexModel.ago(0, 300_000))
        assertEquals("3 小时前", CodexModel.ago(0, 3 * 3_600_000L)); assertEquals("2 天前", CodexModel.ago(0, 2 * 86_400_000L))
        assertTrue(CodexModel.unreachable("unavailable").contains("Codex App"))
        assertTrue(CodexModel.failure("result_unknown", "x").contains("重发"))
        assertEquals("boom", CodexModel.failure("failed", "boom"))
    }
}
