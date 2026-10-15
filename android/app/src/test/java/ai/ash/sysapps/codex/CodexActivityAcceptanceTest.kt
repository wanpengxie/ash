package ai.ash.sysapps.codex

import ai.ash.link.*
import ai.ash.sysapps.SystemAppActivity
import android.app.Application
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Actual Codex Activity/Views and disk outbox -> HumanCall -> real WebSocket; only the remote computer is scripted. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class, qualifiers = "w393dp-h851dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CodexActivityAcceptanceTest {
    class Screen : CodexActivity() {
        override val humanClient: LinkClient get() = client
        companion object { lateinit var client: LinkClient }
    }
    private lateinit var link: TestLink
    private lateinit var conn: KernelConn
    private lateinit var controller: ActivityController<Screen>
    private val seen = HashSet<String>()
    private var sequence = 1
    private val requests = ArrayList<JSONObject>()
    private val held = ArrayList<JSONObject>()
    private var holdSend = false
    private var sendUnknown = false
    private val details = HashMap<String, JSONObject>()
    private val mac = "device:ABCDEFGHIJKLMNOPQRSTUV"
    private val mini = "device:ZYXWVUTSRQPONMLKJIHGFE"
    private lateinit var input: EditText

    @Before fun start() {
        link = TestLink(wrap = { base -> object : HandHandlers by base {
            override fun welcome(welcome: JSONObject) { base.welcome(welcome); ai.ash.ui.LedgerFeed.connectionChanged(true) }
            override fun closed(info: CloseInfo) { base.closed(info); ai.ash.ui.LedgerFeed.connectionChanged(false) }
        } })
        conn = link.connect(); Screen.client = link.client
        details["t1"] = detail("t1", "修复结算页重复扣款", JSONArray().put(progress()))
        details["t2"] = detail("t2", "整理跑步计划", JSONArray().put(JSONObject().put("kind", "agent").put("text", "明天先跑三公里，轻松配速；周末再回顾跑量和膝盖的感觉。")))
        controller = Robolectric.buildActivity(Screen::class.java, intent(mac, "t1")).create().start().resume().visible().windowFocusChanged(true)
        waitFor("existing work") { texts().contains("修复结算页重复扣款") }
        input = views().filterIsInstance<EditText>().single()
        layout(); settleWire()
    }
    @After fun end() {
        if (::controller.isInitialized) controller.pause().stop().destroy()
        shadowOf(Looper.getMainLooper()).idle()
        if (::link.isInitialized) link.close()
    }
    private fun intent(device: String, thread: String) = Intent().putExtra(SystemAppActivity.EXTRA_ARG,
        JSONObject().put("device", device).put("thread", thread).toString())
    private fun views(root: View = controller.get().window.decorView): List<View> = listOf(root) +
        if (root is ViewGroup) (0 until root.childCount).flatMap { views(root.getChildAt(it)) } else emptyList()
    private fun texts() = views().filterIsInstance<TextView>().map { it.text.toString() }
    private fun layout() { val root = controller.get().window.decorView; root.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(1920, View.MeasureSpec.EXACTLY)); root.layout(0, 0, 1080, 1920) }
    private fun detail(id: String, title: String, items: JSONArray = JSONArray()) = JSONObject().put("id", id).put("title", title)
        .put("turns", JSONArray().put(JSONObject().put("id", "running").put("status", "inProgress").put("items", items)))
        .put("state", "running").put("open", true).put("approvals", JSONArray())
    private fun progress() = JSONObject().put("kind", "agent").put("text", "已定位到支付回调重复写入退款记录，接下来验证幂等键。")
    private fun item(id: String, text: String) = JSONObject().put("kind", "user").put("text", text).put("client_id", id)
    private fun answer(frame: JSONObject, data: JSONObject?, error: String? = null) {
        val reply = if (error == null) JSONObject().put("ok", true).put("result", JSONObject().put("data", data ?: JSONObject()))
            else JSONObject().put("ok", false).put("error", JSONObject().put("code", error).put("message", "lost reply"))
        conn.send(JSONObject().put("t", "send.result").put("id", frame.getString("id")).put("ok", true)
            .put("message", JSONObject().put("id", "m" + sequence).put("seq", sequence++)).put("response", reply))
    }
    private fun pumpWire() {
        for (f in conn.frames.toList()) {
            val key = f.optString("t") + ":" + (f.optString("id").ifEmpty { f.optString("sid") })
            if (!seen.add(key)) continue
            if (f.optString("t") == "sync") conn.send(JSONObject().put("t", "sync.page").put("sid", f.getString("sid")).put("messages", JSONArray()).put("end", true))
            if (f.optString("t") != "send") continue
            val req = f.getJSONObject("request"); requests.add(req)
            val body = req.getJSONObject("body")
            when (req.getString("word")) {
                "list" -> answer(f, JSONObject().put("devices", JSONArray().put(JSONObject().put("device", mac).put("name", "工作 Mac").put("kind", "computer").put("online", true))
                    .put(JSONObject().put("device", mini).put("name", "书房 mini").put("kind", "computer").put("online", true))))
                "x.codex.session" -> answer(f, details[body.getString("thread")])
                "x.codex.sessions" -> answer(f, JSONObject().put("sessions", JSONArray().put(JSONObject().put("id", "t1").put("title", "修复结算页重复扣款").put("cwd", "/work/shop"))))
                "x.codex.send" -> if (holdSend) held.add(f) else answer(f, JSONObject().put("sent", true).put("mode", "steer"), if (sendUnknown) "result_unknown" else null)
                "x.codex.approve" -> { details["t1"] = detail("t1", "修复结算页重复扣款", JSONArray().put(JSONObject().put("kind", "agent").put("text", "退款幂等回归通过，重复扣款已修复。"))).put("state", "idle"); answer(f, JSONObject().put("approved", true)) }
                else -> answer(f, JSONObject())
            }
        }
    }
    private fun waitFor(what: String, check: () -> Boolean) {
        val deadline = System.nanoTime() + 15_000_000_000L
        while (true) {
            pumpWire(); shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(16)); layout()
            if (check()) return
            if (System.nanoTime() > deadline) error("Timed out: $what; text=${texts()}; requests=${requests.map { it.optString("word") }}")
            Thread.sleep(5)
        }
    }
    private fun settleWire() {
        var stableAt = System.nanoTime(); var count = requests.size
        val end = System.nanoTime() + 3_000_000_000L
        while (System.nanoTime() < end) {
            pumpWire(); shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(16)); layout()
            if (requests.size != count) { count = requests.size; stableAt = System.nanoTime() }
            if (System.nanoTime() - stableAt > 60_000_000L) return
            Thread.sleep(5)
        }
        error("wire did not settle")
    }
    private fun focusInput() {
        assertTrue(input.requestFocus())
        assertSame("actual decor focus", input, controller.get().window.decorView.findFocus())
        // ShadowActivity.getCurrentFocus is an independent field in Robolectric 4.14.1.
        // Seed its window precondition, then keep testing the actual View focus after every operation.
        shadowOf(controller.get()).setCurrentFocus(input)
        assertSame(input, controller.get().currentFocus)
    }
    private fun assertEditorFocus() {
        assertTrue(input.hasFocus())
        assertSame(input, controller.get().window.decorView.findFocus())
        assertSame(input, controller.get().currentFocus)
    }
    private fun event(word: String = "x.codex.send", from: String = "agent:main", body: JSONObject = JSONObject()) {
        val sync = conn.framesOf("sync").last()
        conn.send(JSONObject().put("t", "sync.msg").put("sid", sync.getString("sid")).put("message", JSONObject().put("seq", sequence++)
            .put("kind", "request").put("from", from).put("to", mac).put("word", word).put("body", body)))
    }
    private fun click(label: String) {
        val target = views().firstOrNull { it.contentDescription?.toString() == label && it.isClickable }
            ?: views().filterIsInstance<TextView>().first { it.text.toString() == label && it.isClickable }
        assertTrue(target.performClick())
    }
    private fun capture(name: String) {
        layout()
        val root = controller.get().window.decorView
        val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        root.draw(Canvas(bitmap))
        val colors = HashSet<Int>()
        for (y in 0 until root.height step 9) for (x in 0 until root.width step 9) colors += bitmap.getPixel(x, y)
        assertTrue("actual rendered Activity content", colors.size > 10)
        val dir = File("/data/atoll/tmp/codex-acceptance").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
    private fun pending() = File(controller.get().filesDir, "codex-outbox").listFiles()?.filter { it.extension == "json" }.orEmpty()

    @Test fun existingWorkSendApprovalAndResultPreserveTheActualChineseEditor() {
        assertTrue(texts().any { it.contains("工作 Mac") && it.contains("修复结算页") })
        input.setText("先跑退款回归，再提交"); focusInput(); input.setSelection(4)
        assertTrue(input.onCreateInputConnection(EditorInfo())!!.setComposingRegion(1, 4))
        assertEquals("actual editor composing precondition", 1, BaseInputConnection.getComposingSpanStart(input.text))
        assertEquals(4, BaseInputConnection.getComposingSpanEnd(input.text))
        val composing = BaseInputConnection.getComposingSpanStart(input.text)
        assertTrue("editor focus precondition", input.hasFocus())
        assertSame("window focus precondition", input, controller.get().currentFocus)
        controller.newIntent(intent(mac, "t1"))
        assertSame(input, controller.get().currentFocus)
        assertEquals(composing, BaseInputConnection.getComposingSpanStart(input.text))
        event(); waitFor("refresh without replacing editor") { texts().any { it.contains("Ash 发起") } }
        assertSame(input, views().filterIsInstance<EditText>().single()); assertEditorFocus()
        assertEquals(4, input.selectionStart); assertEquals(composing, BaseInputConnection.getComposingSpanStart(input.text))
        click("发送")
        waitFor("message acknowledged without a turn id") { requests.any { it.optString("word") == "x.codex.send" } && texts().contains("已发出，等待电脑显示") }
        assertEquals(1, pending().size)
        val client = requests.last { it.optString("word") == "x.codex.send" }.getJSONObject("body").getString("client_id")
        event(from = "person:owner", body = JSONObject().put("client_id", client))
        details["t1"] = detail("t1", "修复结算页重复扣款", JSONArray().put(progress()).put(item("agent-same-text", "先跑退款回归，再提交")))
        event(body = JSONObject().put("client_id", "agent-same-text")); waitFor("agent text does not settle owner operation") { texts().count { it == "先跑退款回归，再提交" } >= 2 }
        assertEquals(1, pending().size)
        details["t1"]!!.getJSONArray("turns").getJSONObject(0).getJSONArray("items").put(item(client, "先跑退款回归，再提交"))
        details["t1"]!!.put("approvals", JSONArray().put(JSONObject().put("request_id", "refund-test").put("summary", "运行退款回归测试")))
        event(); waitFor("exact pending settled and approval shown") { pending().isEmpty() && texts().contains("运行退款回归测试") }
        assertTrue("concrete existing work visible", texts().any { it.contains("已定位到支付回调") })
        assertTrue("owner origin visible", texts().contains("你"))
        assertTrue("Ash origin visible", texts().contains("Ash"))
        capture("refunds-waiting-approval")
        click("批准"); waitFor("visible result") { texts().any { it.contains("重复扣款已修复") } }
        capture("refunds-completed")
        assertEquals(1, requests.count { it.optString("word") == "x.codex.send" })
    }

    @Test fun switchingComputersAndLateReceiptNeverReplaceTheNewRouteOrEitherDraft() {
        holdSend = true
        input.setText("补退款回归"); click("发送")
        waitFor("held first-computer receipt") { held.size == 1 }
        input.setText("原工作里的下一句，还没发")
        controller.newIntent(intent(mini, "t2"))
        waitFor("second computer work") { texts().contains("整理跑步计划") }
        input.setText("明天先跑三公里")
        answer(held.single(), JSONObject().put("sent", true).put("mode", "steer"))
        event(); waitFor("receipt applied") { texts().contains("整理跑步计划") }
        assertEquals("明天先跑三公里", input.text.toString())
        capture("second-computer-keeps-draft")
        controller.newIntent(intent(mac, "t1")); waitFor("back at original work") { texts().contains("修复结算页重复扣款") }
        assertEquals("原工作里的下一句，还没发", input.text.toString()); assertEquals(1, pending().size)
        controller.newIntent(intent(mini, "t2")); waitFor("second draft restored") { input.text.toString() == "明天先跑三公里" }
    }

    @Test fun stoppingAndResumingTheActivityClosesAndReopensItsOwnFollowWithoutAChatPage() {
        settleWire()
        val before = requests.size
        controller.pause().stop()
        waitFor("system app follow closed") { conn.framesOf("sync.close").isNotEmpty() }
        event()
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(before, requests.size)
        val follows = conn.framesOf("sync").size
        controller.start().resume().visible().windowFocusChanged(true)
        waitFor("new follow and fresh work") { conn.framesOf("sync").size == follows + 1 && requests.size > before }
        settleWire()
        val stable = requests.size
        // A read request in the ledger is not a reason to issue that read again forever.
        event(word = "x.codex.session", from = "person:owner")
        settleWire()
        assertEquals(stable, requests.size)
        assertFalse("system app never acquires the primary chat page", requests.any { it.optString("to") == "service:agents" })
    }

    @Test fun switchingBackRestoresTheSameVisibleRowAndOffset() {
        val items = JSONArray()
        for (i in 0 until 27) items.put(JSONObject().put("id", "step-$i").put("kind", "agent").put("text", "退款排查第 $i 步：检查订单与付款记录，验证重复回调的幂等结果。"))
        details["t1"] = detail("t1", "修复结算页重复扣款", items)
        event(); waitFor("long existing work") { texts().any { it.contains("退款排查第") } }
        val list = views().filterIsInstance<RecyclerView>().first { it.visibility == View.VISIBLE }
        val lm = list.layoutManager as androidx.recyclerview.widget.LinearLayoutManager
        val rows = list.adapter as ai.ash.ui.KeyedRowsAdapter
        waitFor("all work rows laid out") { rows.currentList.size >= 27 }
        lm.scrollToPositionWithOffset(9, -21); layout()
        val before = ai.ash.ui.Anchor.of(list, lm, rows)
        assertNotNull("reading older work", before)
        controller.newIntent(intent(mini, "t2"))
        val pane = CodexActivity::class.java.getDeclaredField("pane").apply { isAccessible = true }.get(controller.get())
        val remembered = CodexPane::class.java.getDeclaredField("readingPlaces").apply { isAccessible = true }.get(pane) as Map<*, *>
        assertEquals("leaving stores the measured anchor", before, remembered[ai.ash.ui.Drafts.codex(mac, "t1")])
        waitFor("other work") { texts().contains("整理跑步计划") }
        controller.newIntent(intent(mac, "t1"))
        val pendingPlace = CodexPane::class.java.getDeclaredField("place").apply { isAccessible = true }
        assertEquals("entering selects the original anchor", before, pendingPlace.get(pane))
        val traces = ArrayList<String>()
        try {
            waitFor("same visible work restored") {
                val actual = ai.ash.ui.Anchor.of(list, lm, rows)
                val trace = "place=${pendingPlace.get(pane)} actual=$actual height=${list.height}"
                if (traces.lastOrNull() != trace) traces += trace
                actual == before
            }
        } catch (e: IllegalStateException) {
            throw AssertionError("expected reading place=$before; actual=${ai.ash.ui.Anchor.of(list, lm, rows)}; transitions=$traces", e)
        }
        capture("returned-to-reading-place")
    }

    @Test fun anUnknownSendRetryUsesTheSameClientIdAndOfflineStatusDoesNotMoveTheConversation() {
        sendUnknown = true; input.setText("只补一次退款测试"); click("发送")
        waitFor("unknown feedback") { texts().any { it.contains("没有收到确认") } }
        val first = requests.last { it.optString("word") == "x.codex.send" }.getJSONObject("body").getString("client_id")
        sendUnknown = false; click("重发")
        waitFor("one explicit retry") { requests.count { it.optString("word") == "x.codex.send" } == 2 }
        val second = requests.last { it.optString("word") == "x.codex.send" }.getJSONObject("body").getString("client_id")
        assertEquals(first, second); assertEquals(1, pending().size)
        input.setText("拼音还在输入"); focusInput(); input.setSelection(2)
        assertTrue(input.onCreateInputConnection(EditorInfo())!!.setComposingRegion(0, 2))
        assertEquals("actual editor composing precondition", 0, BaseInputConnection.getComposingSpanStart(input.text))
        assertEquals(2, BaseInputConnection.getComposingSpanEnd(input.text))
        val bounds = views().filterIsInstance<RecyclerView>().map { listOf(it.top, it.height) }
        conn.close(1000)
        waitFor("offline banner") { texts().contains("暂时连不上 Ash，连上后会自动恢复") && !link.client.channelOpen("human") }
        assertEquals(bounds, views().filterIsInstance<RecyclerView>().map { listOf(it.top, it.height) })
        assertEquals("拼音还在输入", input.text.toString()); assertEditorFocus()
        assertEquals(2, input.selectionStart); assertEquals(0, BaseInputConnection.getComposingSpanStart(input.text))
        capture("offline-keeps-editor-and-content")
    }
}
