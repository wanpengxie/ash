package ai.ash.kernel

import ai.ash.kernel.host.ctx.ContextFiles
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class ContextFilesTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun setup(): Pair<File, HostApi> {
        val root = tmp.newFolder("ash-ctx")
        File(root, "2026-10-15").mkdirs()
        File(root, "2026-10-15/events.jsonl").writeText("{\"a\":1}\n{\"b\":22}\n{\"c\":333}\n")
        File(root, "2026-10-14").mkdirs()
        File(root, "2026-10-14/stats.jsonl").writeText("{\"t\":1}\n")
        File(root, "not-a-day").mkdirs()
        File(root, "secret.txt").writeText("no")
        val files = ContextFiles(root) { JSONObject().put("state", "running").put("since", 5) }
        val api = HostApi(HostApi.CAPABILITIES + "ctx", SoftIdentity(), WakeManager(FakeAlarms()), FakePower(), FakeHands(), FakeCallbacks(), ctx = files)
        return root to api
    }

    private fun HostApi.read(body: JSONObject) = call("ctx.read", body)
    private fun JSONObject.code() = getJSONObject("error").getString("code")

    @Test fun listsTheDaysAndTheirFilesAndTheProbe() {
        val (_, api) = setup()
        val r = api.call("ctx.list", JSONObject()).getJSONObject("result")
        assertEquals("running", r.getJSONObject("probe").getString("state"))
        val days = r.getJSONArray("days")
        assertEquals(listOf("2026-10-14", "2026-10-15"), (0 until days.length()).map { days.getJSONObject(it).getString("day") })
        val events = days.getJSONObject(1).getJSONArray("files").getJSONObject(0)
        assertEquals("events", events.getString("file"))
        assertEquals(3, events.getLong("lines"))
        assertEquals(27, events.getLong("bytes"))
        assertFalse(events.getBoolean("lines_estimated"))
    }

    @Test fun readsInPiecesOfWholeLinesToTheEnd() {
        val (_, api) = setup()
        // 12 bytes reach into the second line: only the first comes back.
        val a = api.read(JSONObject().put("day", "2026-10-15").put("file", "events").put("limit", 12)).getJSONObject("result")
        assertEquals("{\"a\":1}\n", a.getString("text"))
        assertEquals(8, a.getLong("next_offset"))
        assertFalse(a.getBoolean("eof"))
        val b = api.read(JSONObject().put("day", "2026-10-15").put("file", "events").put("offset", 8)).getJSONObject("result")
        assertEquals("{\"b\":22}\n{\"c\":333}\n", b.getString("text"))
        assertEquals(27, b.getLong("next_offset"))
        assertTrue(b.getBoolean("eof"))
        // Past the end, or a file not there: an empty read at its end.
        val c = api.read(JSONObject().put("day", "2026-10-15").put("file", "events").put("offset", 999)).getJSONObject("result")
        assertEquals("", c.getString("text")); assertEquals(27, c.getLong("next_offset")); assertTrue(c.getBoolean("eof"))
        val d = api.read(JSONObject().put("day", "2026-10-13").put("file", "touch")).getJSONObject("result")
        assertEquals(0, d.getLong("size")); assertTrue(d.getBoolean("eof"))
        // A line longer than the limit comes in pieces rather than never.
        val e = api.read(JSONObject().put("day", "2026-10-15").put("file", "events").put("limit", 3)).getJSONObject("result")
        assertEquals("{\"a", e.getString("text")); assertEquals(3, e.getLong("next_offset"))
    }

    @Test fun refusesAnythingButADayAndOneOfTheFourFiles() {
        val (_, api) = setup()
        for (day in listOf("../2026-10-15", "2026-10-15/..", "secret", "2026-1-15", "", "not-a-day"))
            assertEquals(day, "bad_request", api.read(JSONObject().put("day", day).put("file", "events")).code())
        for (file in listOf("secret", "../secret", "events.jsonl", "events/../stats", "paused", ""))
            assertEquals(file, "bad_request", api.read(JSONObject().put("day", "2026-10-15").put("file", file)).code())
        assertEquals("bad_request", api.read(JSONObject().put("day", "2026-10-15").put("file", "events").put("offset", -1)).code())
        assertEquals("bad_request", api.read(JSONObject().put("day", "2026-10-15").put("file", "events").put("limit", 0)).code())
        assertEquals("bad_request", api.read(JSONObject().put("day", "2026-10-15").put("file", "events").put("limit", ContextFiles.MAX_READ + 1)).code())
    }

    @Test fun aHostWithoutCtxHasNoSuchMethods() {
        val api = HostApi(HostApi.CAPABILITIES, SoftIdentity(), WakeManager(FakeAlarms()), FakePower(), FakeHands(), FakeCallbacks())
        assertEquals("not_found", api.call("ctx.list", JSONObject()).code())
    }
}
