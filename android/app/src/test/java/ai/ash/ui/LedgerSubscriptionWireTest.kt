package ai.ash.ui

import ai.ash.link.TestLink
import ai.ash.link.awaitTrue
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Real WebSocket -> LinkClient -> the production subscription, with controllable UI/work queues; no chat page. */
class LedgerSubscriptionWireTest {
    private val link = TestLink()
    private val ui = Executors.newSingleThreadExecutor()
    private val worker = Executors.newSingleThreadExecutor()
    private val feed = LedgerSubscription({ worker.execute(it) }, { ui.execute(it) })
    private fun front(f: () -> Unit) { ui.submit(f).get(5, TimeUnit.SECONDS) }
    @After fun end() { link.close(); worker.shutdownNow(); ui.shutdownNow() }
    private fun msg(seq: Int) = JSONObject().put("seq", seq).put("from", "service:devices").put("to", "person:owner")
        .put("word", "device.changed").put("kind", "event").put("body", JSONObject().put("who", "agent:main"))
    private fun page(sid: String, vararg messages: JSONObject) = JSONObject().put("t", "sync.page").put("sid", sid)
        .put("messages", JSONArray(messages.toList())).put("end", true)

    @Test fun coldEntryWaitsForTheFollowBeforeAnnouncingReadyAndReconnectReplaysTheGap() {
        val conn = link.connect()
        val states = CopyOnWriteArrayList<Boolean>()
        val seen = CopyOnWriteArrayList<JSONObject>()
        val listener: (JSONObject) -> Unit = { seen.add(it) }
        front { feed.listen(link.client, listener) { states.add(it) } }
        val sync = conn.awaitFrame("sync")
        assertEquals(listOf(false), states.toList())
        conn.send(page(sync.getString("sid"), msg(10)))
        awaitTrue("subscribed before connected") { states.lastOrNull() == true }
        assertEquals("agent:main", seen.single().getJSONObject("body").getString("who"))
        front { feed.connectionChanged(false) }
        val next = link.connect(nth = 1)
        front { feed.connectionChanged(true) }
        val resumed = next.awaitFrame("sync")
        assertEquals(10, resumed.getInt("after"))
        next.send(page(resumed.getString("sid"), msg(11), msg(12)))
        awaitTrue("all gap messages") { seen.size == 3 }
        assertEquals(listOf(10, 11, 12), seen.map { it.getInt("seq") })
        front { feed.remove(listener) }
        next.awaitFrame("sync.close")
        next.send(JSONObject().put("t", "sync.msg").put("sid", resumed.getString("sid")).put("message", msg(13)))
        front { }
        assertEquals(3, seen.size)
    }

    @Test fun twoActivitiesShareOneFollowAndStoppingOneDoesNotStopTheOther() {
        val conn = link.connect()
        val a = CopyOnWriteArrayList<JSONObject>(); val b = CopyOnWriteArrayList<JSONObject>()
        val first: (JSONObject) -> Unit = { a.add(it) }; val second: (JSONObject) -> Unit = { b.add(it) }
        front { feed.listen(link.client, first) {} }
        val sync = conn.awaitFrame("sync"); val sid = sync.getString("sid")
        conn.send(page(sid, msg(1)))
        awaitTrue("initial message") { a.size == 1 }
        front { feed.listen(link.client, second) {}; feed.remove(first) }
        conn.send(JSONObject().put("t", "sync.msg").put("sid", sid).put("message", msg(2)))
        awaitTrue("second activity") { b.size == 1 }
        assertEquals(1, a.size); assertEquals(1, conn.framesOf("sync").size); assertTrue(conn.framesOf("sync.close").isEmpty())
        front { feed.remove(second) }
        conn.awaitFrame("sync.close")
    }

    @Test fun anOpenThatCompletesAfterStopIsClosedAndNeverCallsTheOldPage() {
        val conn = link.connect()
        val held = ArrayList<() -> Unit>()
        val delayed = LedgerSubscription({ held.add(it) }, { ui.execute(it) })
        val states = CopyOnWriteArrayList<Boolean>(); val seen = CopyOnWriteArrayList<JSONObject>()
        val l: (JSONObject) -> Unit = { seen.add(it) }
        front { delayed.listen(link.client, l) { states.add(it) }; delayed.remove(l) }
        held.single()()
        val sync = conn.awaitFrame("sync")
        conn.send(page(sync.getString("sid"), msg(1)))
        conn.awaitFrame("sync.close")
        front { }
        assertTrue(seen.isEmpty()); assertEquals(listOf(false), states.toList())
    }
}
