package ai.ash.sysapps.ash

import android.app.AlertDialog
import android.app.Application
import android.content.DialogInterface
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import java.io.File
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import ai.ash.R
import ai.ash.link.*
import java.time.Duration
import ai.ash.sysapps.SystemAppActivity
import ai.ash.ui.HumanPort
import ai.ash.ui.Reply
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
import org.robolectric.shadows.ShadowAlertDialog

/** Actual Activity, RecyclerView rows, editor, clicks and saved drafts. The port is deterministic; the Node scenario covers the real hub. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class, qualifiers = "w360dp-h800dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AshActivityTest {
    class TestActivity : AshActivity() {
        override val humanClient: LinkClient get() = client
        companion object { lateinit var client: LinkClient }
        fun connect() = onConnectionChanged(true)
        fun backInside() = goBack()
        fun message(message: JSONObject) = onLedger(message)
        override fun request(to: String, word: String, body: JSONObject, done: (Reply) -> Unit) = Port.call(to, word, body, done)
    }
    object Port {
        var document = "# 安排\n- 会议周二\n- 爱喝美式\n"
        var noteFailure: Reply? = null
        var reply = ""
        var tasks = JSONArray()
        var current: JSONObject? = null
        var diary = JSONArray()
        var growth = JSONArray()
        val calls = ArrayList<Triple<String, String, JSONObject>>()
        fun call(to: String, word: String, body: JSONObject, done: (Reply) -> Unit) {
            calls.add(Triple(to, word, JSONObject(body.toString())))
            if (word == "note" && noteFailure != null) { done(noteFailure!!); return }
            val data = when(word) {
                "memory.get" -> JSONObject().put("files", JSONArray().put(JSONObject().put("file", "USER.md").put("content", document)))
                "memory.set" -> { document = body.getString("content"); JSONObject().put("saved", true) }
                "note" -> JSONObject().put("id", body.getString("id"))
                "notes.list" -> JSONObject().put("notes", JSONArray().apply {
                    val note = calls.lastOrNull { it.second == "note" }?.third
                    if (note != null) put(JSONObject().put("id", note.getString("id")).put("about", note.getString("about")).put("text", note.getString("text")).put("by", "person:owner").put("at", 1).apply { if (reply.isNotEmpty()) put("reply", reply).put("replied_by", "agent:main") })
                })
                "list" -> if (to == "service:agents") JSONObject().put("agents", JSONArray().put(JSONObject().put("id", "agent:main").put("primary", true).put("name", "Ash")).put(JSONObject().put("id", "agent:helper").put("name", "执行帮手"))) else JSONObject().put("tasks", tasks)
                "get" -> JSONObject().put("task", (0 until tasks.length()).map { tasks.getJSONObject(it) }.firstOrNull { it.optString("id") == body.optString("id") })
                "done" -> {
                    val task = (0 until tasks.length()).map { tasks.getJSONObject(it) }.first { it.getString("id") == body.getString("id") }
                    task.put("status", "done"); JSONObject().put("task", task)
                }
                "current" -> current ?: JSONObject().put("as_of", System.currentTimeMillis()).put("presence", JSONObject().put("state", "idle"))
                "pulse.get" -> JSONObject().put("enabled", false)
                "diary.list" -> JSONObject().put("days", diary)
                "diary.get" -> JSONObject().put("content", "# 日记\n- 会议周三").put("notes", JSONArray())
                "growth.list" -> JSONObject().put("items", growth)
                else -> JSONObject()
            }
            done(Reply(true, data, null, null))
        }
    }
    private lateinit var link: TestLink
    private lateinit var conn: KernelConn
    private val syncs = HashSet<String>()
    private var controller: ActivityController<TestActivity>? = null
    private lateinit var activity: TestActivity
    @Before fun reset() {
        Port.document = "# 安排\n- 会议周二\n- 爱喝美式\n"; Port.noteFailure = null; Port.reply = ""; Port.calls.clear(); Port.tasks = JSONArray(); Port.current = null; Port.growth = JSONArray()
        link = TestLink(wrap = { base -> object : HandHandlers by base {
            override fun welcome(welcome: JSONObject) { base.welcome(welcome); ai.ash.ui.LedgerFeed.connectionChanged(true) }
            override fun closed(info: CloseInfo) { base.closed(info); ai.ash.ui.LedgerFeed.connectionChanged(false) }
        } })
        conn = link.connect(); TestActivity.client = link.client
        Port.diary = JSONArray(); syncs.clear()
        org.robolectric.RuntimeEnvironment.getApplication().getSharedPreferences("ash-app-drafts", 0).edit().clear().commit()
    }
    private fun closeScreen() { controller?.pause()?.stop()?.destroy(); controller = null }
    @After fun close() { closeScreen(); if (::link.isInitialized) link.close() }
    private fun open(section: String) {
        val intent = Intent().putExtra(SystemAppActivity.EXTRA_ARG, JSONObject().put("section", section).toString())
        controller = Robolectric.buildActivity(TestActivity::class.java, intent).create().start().resume().visible().windowFocusChanged(true)
        activity = controller!!.get(); settle()
        val metrics = activity.resources.displayMetrics
        assertEquals(3f, metrics.density, 0.001f)
        assertEquals(1080, metrics.widthPixels); assertEquals(2400, metrics.heightPixels)
        assertEquals(360, activity.resources.configuration.screenWidthDp)
        assertEquals(800, activity.resources.configuration.screenHeightDp)
    }
    private fun all(view: View = activity.window.decorView): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { all(view.getChildAt(it)) } else emptyList()
    private fun texts() = all().filterIsInstance<TextView>().map { it.text.toString() }
    private fun settle() {
        repeat(12) {
            conn.frames.toList().filter { it.optString("t") == "sync" && syncs.add(it.getString("sid")) }.forEach {
                conn.send(JSONObject().put("t", "sync.page").put("sid", it.getString("sid")).put("messages", JSONArray()).put("end", true))
            }
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
            val root = activity.window.decorView
            val bounds = activity.windowManager.currentWindowMetrics.bounds
            val width = bounds.width(); val height = bounds.height()
            assertEquals(1080, width); assertEquals(2400, height)
            root.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY)); root.layout(0, 0, width, height)
            Thread.sleep(10)
        }
    }
    private fun screenshot(name: String) {
        val output = System.getenv("ASH_ACCEPTANCE_ARTIFACTS") ?: return
        settle()
        val root = activity.window.decorView
        assertTrue("screenshot decor must be attached to its window", root.isAttachedToWindow)
        assertTrue("screenshot must contain visible product text", all(root).filterIsInstance<TextView>().any { it.isShown && it.text.isNotBlank() })
        val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
        all().forEach { it.invalidate() }
        bitmap.density = root.resources.displayMetrics.densityDpi
        root.draw(Canvas(bitmap))
        val file = File(output, "$name.png"); file.parentFile!!.mkdirs()
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
    private fun visible(v: View): Boolean = v.isShown && v.getGlobalVisibleRect(Rect())
    private fun tap(view: View) {
        var target = view
        while (!target.isClickable && target.parent is View) target = target.parent as View
        assertTrue("target must be visible and clickable", visible(target) && target.isClickable)
        target.performClick(); settle()
    }
    private fun click(text: String) {
        repeat(15) {
            settle()
            all().filterIsInstance<TextView>().firstOrNull { it.text.toString() == text && visible(it) }?.let { tap(it); return }
            val form = all().filterIsInstance<android.widget.ScrollView>().firstOrNull { it.isShown }
            if (form != null) form.scrollBy(0, (200 * activity.resources.displayMetrics.density).toInt())
            else all().filterIsInstance<androidx.recyclerview.widget.RecyclerView>().first { it.isShown }.scrollBy(0, (200 * activity.resources.displayMetrics.density).toInt())
        }
        fail("missing visible action $text: ${texts()}")
    }
    private fun description(text: String) { settle(); tap(all().first { it.contentDescription == text && visible(it) }) }
    private fun commentOnFact() {
        description("更多操作")
        val dialog = ShadowAlertDialog.getLatestAlertDialog() as AlertDialog
        dialog.listView.performItemClick(dialog.listView.getChildAt(0), 0, 0); settle()
    }
    private fun editor() = activity.findViewById<EditText>(R.id.ash_editor)
    private fun seedHome() {
        Port.document = "# 提醒偏好\n- 工作日上午10点提醒我处理非紧急事项。\n- 爱喝美式\n"
        Port.current = JSONObject().put("as_of", System.currentTimeMillis())
            .put("presence", JSONObject().put("state", "working").put("text", "核对住宿退款条款"))
        Port.tasks = JSONArray()
            .put(JSONObject().put("id", "t_refund").put("subject", "ash").put("title", "核对住宿退款条款并补齐比较依据").put("assignee", "agent:main").put("status", "doing"))
            .put(JSONObject().put("id", "t_access").put("subject", "ash").put("title", "补充新电脑接入说明和离线恢复步骤").put("assignee", "agent:helper").put("status", "todo"))
    }

    @Test fun homeShowsCurrentWorkAndTheSharedPromisesOnAPhone() {
        seedHome(); open("now")
        assertTrue(texts().any { it.contains("核对住宿退款条款") })
        assertTrue(texts().contains("Ash · 在做")); assertTrue(texts().contains("执行帮手 · 待做"))
        assertFalse(all().any { it.contentDescription == "返回" && it.isShown })
        for (tab in listOf("现在", "记得你", "日记")) assertTrue(all().any { it.contentDescription == tab && visible(it) })
        assertFalse(Port.calls.any { it.second == "done" })
        screenshot("ash-home")
    }

    @Test fun quietHomeStillHasRealContentAndAnEmptyPromisesEntry() {
        seedHome(); Port.tasks = JSONArray(); open("now")
        assertTrue(texts().contains("查看全部承诺"))
        assertFalse(texts().any { it.contains("本页当前没有需要你的决定") })
        val entry = all().filterIsInstance<TextView>().single { it.text.toString() == "查看全部承诺" }
        assertTrue(entry.isClickable && visible(entry))
        screenshot("ash-quiet")
    }

    @Test fun aSingleFactCorrectionPreservesNewFactsAndShowsTheOriginalNoteReply() {
        seedHome(); open("memory"); click("工作日上午10点提醒我处理非紧急事项。")
        assertTrue(texts().contains("这条记录未附原依据；不能确认它来自哪次对话。"))
        assertEquals("工作日上午10点提醒我处理非紧急事项。", editor().text.toString())
        screenshot("ash-detail")
        click("查看原文件 · USER.md")
        val original = ShadowAlertDialog.getLatestAlertDialog() as AlertDialog
        assertTrue(original.findViewById<TextView>(android.R.id.message).text.toString().contains("爱喝美式"))
        original.dismiss(); settle()
        Port.document += "- 刚刚补上的偏好\n"
        editor().setText("工作日上午11点提醒我处理非紧急事项。")
        click("保存这条纠正")
        assertTrue(Port.document.contains("工作日上午11点")); assertTrue(Port.document.contains("刚刚补上的偏好")); assertTrue(Port.document.contains("爱喝美式"))
        assertTrue(texts().any { it.contains("记忆已保存；批注已保存") })
        assertTrue(texts().any { it.contains("尚未看到 Ash 的新回应") })
        assertFalse(texts().any { it.contains("已理解") })
        val note = Port.calls.last { it.second == "note" }.third
        assertEquals("memory:USER.md", note.getString("about"))
        Port.reply = "我读到了更正：上午11点。咖啡偏好保持不变。"
        activity.message(JSONObject().put("from", "service:persona").put("kind", "event").put("word", "persona.changed").put("body", JSONObject().put("part", "notes")))
        settle(); assertTrue(texts().any { it.contains("我的回应：") && it.contains(Port.reply) })
        screenshot("ash-detail-saved")
    }

    @Test fun failedAndUnconfirmedNoteSavesKeepTheNormalEditingDraft() {
        for (code in listOf("forbidden", "result_unknown")) {
            open("memory"); click("会议周二"); commentOnFact()
            val correction = "会议是周三：$code"; editor().setText(correction)
            Port.noteFailure = Reply(false, JSONObject(), null, HumanPort.Failure(code, "批注保存未确认"))
            click("保存")
            assertEquals(correction, editor().text.toString())
            val prefs = activity.getSharedPreferences("ash-app-drafts", 0)
            val key = "note:memory:USER.md:会议周二"
            assertEquals(correction, prefs.getString(key, null)); assertTrue(prefs.contains("operation:$key"))
            assertFalse(texts().contains("批注已保存"))
            closeScreen(); Port.noteFailure = null
        }
    }

    @Test fun aSavedMemoryAndItsFailedOrUnconfirmedNoteHaveSeparateFeedback() {
        for (code in listOf("forbidden", "result_unknown")) {
            Port.document = "# 安排\n- 会议周二\n- 爱喝美式\n"
            open("memory"); click("会议周二"); editor().setText("会议周三")
            Port.noteFailure = Reply(false, JSONObject(), null, HumanPort.Failure(code, "不允许保存批注"))
            click("保存这条纠正")
            assertTrue(Port.document.contains("会议周三"))
            assertTrue(texts().any { it.startsWith("记忆已保存；") && it.contains(if (code == "result_unknown") "还没确认批注是否保存" else "批注未能保存") })
            assertFalse(texts().contains("重试通知"))
            closeScreen(); Port.noteFailure = null
        }
    }

    @Test fun deletionClicksRemoveOnlyThatFactThroughTheSameWords() {
        open("memory"); click("会议周二"); click("删除这一条")
        val dialog = ShadowAlertDialog.getLatestAlertDialog() as AlertDialog
        dialog.getButton(DialogInterface.BUTTON_POSITIVE).performClick(); settle()
        assertFalse(Port.document.contains("会议周二")); assertTrue(Port.document.contains("爱喝美式"))
        val writes = Port.calls.indexOfFirst { it.second == "memory.set" }; assertTrue(writes > 0); assertEquals("memory.get", Port.calls[writes - 1].second)
    }

    @Test fun aSharedPromiseOpensTheSameNativeTaskWithoutCompletingItAndReturnsToTheSameSpace() {
        seedHome(); open("now"); click("补充新电脑接入说明和离线恢复步骤")
        val launched = shadowOf(activity).nextStartedActivity
        assertEquals("ai.ash.sysapps.tasks.TasksActivity", launched.component!!.className)
        val arg = JSONObject(launched.getStringExtra(SystemAppActivity.EXTRA_ARG)!!)
        assertEquals("t_access", arg.getString("id")); assertEquals("ash", arg.getString("subject"))
        assertFalse(Port.calls.any { it.second == "done" })
        Port.tasks.getJSONObject(1).put("title", "接入说明已更新").put("status", "doing")
        activity.connect(); settle()
        assertTrue(texts().contains("接入说明已更新"))
        assertTrue(all().single { it.contentDescription == "现在" }.isSelected)
        Port.tasks = JSONArray(); activity.connect(); settle()
        click("查看全部承诺")
        val allTasks = shadowOf(activity).nextStartedActivity
        assertEquals("ai.ash.sysapps.tasks.TasksActivity", allTasks.component!!.className)
        val allArg = JSONObject(allTasks.getStringExtra(SystemAppActivity.EXTRA_ARG)!!)
        assertEquals("ash", allArg.getString("subject")); assertFalse(allArg.has("id"))
    }

    @Test fun oldStatusAndUnsubstantiatedGrowthStayClearlyLabelled() {
        Port.current = JSONObject().put("as_of", System.currentTimeMillis() - 600_000).put("presence", JSONObject().put("state", "working").put("text", "查会议"))
        Port.tasks = JSONArray().put(JSONObject().put("id", "t1").put("subject", "ash").put("title", "还没开始的事").put("assignee", "agent:main").put("status", "todo"))
        open("now")
        assertTrue(texts().any { it.contains("当前状态待确认") }); assertTrue(texts().contains("Ash · 待做"))
        Port.growth = JSONArray().put(JSONObject().put("id", "g1").put("title", "试着改进提醒").put("why", "反馈").put("did", "我修改了提醒方式").put("effect", "").put("next", "").put("by", "agent:main").put("at", 1))
        controller!!.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG, "{\"section\":\"growth\"}")); settle()
        assertTrue(texts().any { it.contains("效果怎样：尚未记录") }); assertTrue(texts().any { it.contains("尚未附出处") })
    }

    @Test fun reusedEntryAndBackPreserveTheExactFactDraftAndKeepTheInputOnLedgerUpdates() {
        open("memory"); click("会议周二"); val input = editor(); input.setText("还没保存的周三")
        input.setSelection(3); input.requestFocus()
        activity.message(JSONObject().put("word", "persona.changed").put("body", JSONObject().put("part", "notes")))
        settle(); assertSame(input, editor()); assertEquals(3, input.selectionStart)
        activity.backInside(); settle(); click("会议周二")
        assertEquals("还没保存的周三", editor().text.toString())
        controller!!.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG, "{\"section\":\"diary\",\"date\":\"2026-10-15\"}")); settle()
        assertTrue(texts().contains("会议周三"))
        controller!!.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG, "{\"section\":\"memory\"}")); settle(); click("会议周二")
        assertEquals("还没保存的周三", editor().text.toString()); assertFalse(Port.calls.any { it.second == "memory.set" })
        activity.backInside(); description("日记"); description("记得你"); click("会议周二")
        assertEquals("还没保存的周三", editor().text.toString())
    }
}
