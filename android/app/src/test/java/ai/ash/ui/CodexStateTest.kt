package ai.ash.ui

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CodexStateTest {
    private val devices = JSONObject("""{"devices":[{"device":"device:mac","kind":"computer","online":true,"name":"Mac"},
        {"device":"device:mini","kind":"computer","online":true,"name":"mini"}]}""")
    private val list = JSONObject("""{"sessions":[{"id":"t1","title":"One"},{"id":"t2","title":"Two"}]}""")
    private fun detail(id: String) = JSONObject("""{"id":"$id","title":"T $id","turns":[{"id":"u1","items":[{"kind":"user","text":"hi"}]}]}""")

    private fun ready(): CodexState = CodexState().apply { computersRead(devices, null, 1) }

    @Test fun aFailedReadKeepsTheListAndSaysWhy() {
        val s = ready()
        assertTrue(s.listRead(s.generation, list, null))
        assertTrue(s.listRead(s.generation, null, "timeout"))
        assertEquals(listOf("t1", "t2"), s.sessions!!.map { it.id })
        assertEquals(CodexModel.unreachable("timeout"), s.problem)
        assertTrue(s.listRead(s.generation, list, null))
        assertNull(s.problem)
    }

    @Test fun anAnswerAboutASessionLeftBehindIsDroppedSuccessOrFailure() {
        val s = ready()
        s.open("t1", "One")
        val asked = s.generation
        s.back(); s.open("t2", "Two")
        assertFalse(s.detailRead(asked, detail("t1"), null))
        assertFalse(s.detailRead(asked, null, "unavailable"))
        assertNull(s.detail); assertNull(s.problem)
        assertTrue(s.detailRead(s.generation, detail("t2"), null))
        assertEquals("t2", s.detail!!.session.id)
        // The list asked for before a session was opened does not land on the session either.
        val l = ready(); val listAsked = l.generation; l.open("t1", "One")
        assertFalse(l.listRead(listAsked, list, null))
    }

    @Test fun anotherComputerDropsWhatTheFirstOneAnswers() {
        val s = ready()
        assertEquals("device:mac", s.device)
        val asked = s.generation
        assertTrue(s.choose("device:mini"))
        assertFalse(s.listRead(asked, list, null))
        assertNull(s.sessions)
    }

    @Test fun aFailedSessionReadKeepsWhatItShowed() {
        val s = ready()
        s.open("t1", "One")
        s.detailRead(s.generation, detail("t1"), null)
        assertTrue(s.detailRead(s.generation, null, "result_unknown"))
        assertEquals("t1", s.detail!!.session.id)
        assertEquals(CodexModel.unreachable("result_unknown"), s.problem)
    }

    @Test fun theRouteComesBackAfterTheActivityIsMadeAgain() {
        val s = ready()
        s.choose("device:mini"); s.open("t2", "Two")
        val back = CodexState().apply { restore(s.route()) }
        assertEquals("t2", back.thread); assertEquals("Two", back.title)
        back.computersRead(devices, null, 2)
        assertEquals("the computer chosen before", "device:mini", back.device)
        val fresh = ready().apply { startNew(CodexModel.Project("/work/app", "app", emptyList())) }
        assertEquals("/work/app", CodexState().apply { restore(fresh.route()) }.newIn!!.cwd)
    }
}
