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
import ai.ash.sysapps.SystemAppActivity
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
        fun connect() = onConnectionChanged(true)
        fun backInside() = goBack()
        fun message(message: JSONObject) = onLedger(message)
        override fun request(to: String, word: String, body: JSONObject, done: (Reply) -> Unit) = Port.call(to, word, body, done)
    }
    object Port {
        var document = "# 安排\n- 会议周二\n- 爱喝美式\n"
        var told = false
        var reply = ""
        var tasks = JSONArray()
        var current: JSONObject? = null
        var growth = JSONArray()
        val calls = ArrayList<Triple<String, String, JSONObject>>()
        fun call(to: String, word: String, body: JSONObject, done: (Reply) -> Unit) {
            calls.add(Triple(to, word, JSONObject(body.toString())))
            val data = when(word) {
                "memory.get" -> JSONObject().put("files", JSONArray().put(JSONObject().put("file", "USER.md").put("content", document)))
                "memory.set" -> { document = body.getString("content"); JSONObject().put("saved", true) }
                "note" -> JSONObject().put("id", body.getString("id")).put("told", told)
                "notes.list" -> JSONObject().put("notes", JSONArray().apply {
                    val note = calls.lastOrNull { it.second == "note" }?.third
                    if (note != null) put(JSONObject().put("id", note.getString("id")).put("about", note.getString("about")).put("text", note.getString("text")).put("by", "person:owner").put("at", 1).apply { if (reply.isNotEmpty()) put("reply", reply).put("replied_by", "agent:main") })
                })
                "list" -> if (to == "service:agents") JSONObject().put("agents", JSONArray().put(JSONObject().put("id", "agent:main").put("primary", true).put("name", "Ash"))) else JSONObject().put("tasks", tasks)
                "get" -> JSONObject().put("task", (0 until tasks.length()).map { tasks.getJSONObject(it) }.firstOrNull { it.optString("id") == body.optString("id") })
                "done" -> {
                    val task = (0 until tasks.length()).map { tasks.getJSONObject(it) }.first { it.getString("id") == body.getString("id") }
                    task.put("status", "done"); JSONObject().put("task", task)
                }
                "current" -> current ?: JSONObject().put("as_of", System.currentTimeMillis()).put("presence", JSONObject().put("state", "idle"))
                "pulse.get" -> JSONObject().put("enabled", false)
                "diary.get" -> JSONObject().put("content", "# 日记\n- 会议周三").put("notes", JSONArray())
                "growth.list" -> JSONObject().put("items", growth)
                else -> JSONObject()
            }
            done(Reply(true, data, null, null))
        }
    }
    private var controller: ActivityController<TestActivity>? = null
    private lateinit var activity: TestActivity
    @Before fun reset() {
        Port.document = "# 安排\n- 会议周二\n- 爱喝美式\n"; Port.told = false; Port.reply = ""; Port.calls.clear(); Port.tasks = JSONArray(); Port.current = null; Port.growth = JSONArray()
        org.robolectric.RuntimeEnvironment.getApplication().getSharedPreferences("ash-app-drafts", 0).edit().clear().commit()
    }
    @After fun close() { controller?.destroy() }
    private fun open(section: String) {
        val intent = Intent().putExtra(SystemAppActivity.EXTRA_ARG, JSONObject().put("section", section).toString())
        controller = Robolectric.buildActivity(TestActivity::class.java, intent).create().visible()
        activity = controller!!.get(); activity.connect(); settle()
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
            shadowOf(Looper.getMainLooper()).idle()
            val root = activity.window.decorView
            val width = (360 * activity.resources.displayMetrics.density).toInt()
            val height = (800 * activity.resources.displayMetrics.density).toInt()
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
        root.draw(Canvas(bitmap))
        val colors = HashSet<Int>()
        for (y in 0 until bitmap.height step 3) for (x in 0 until bitmap.width step 3) colors.add(bitmap.getPixel(x, y))
        assertTrue("screenshot is empty or only flat backgrounds (${colors.size} colors)", colors.size > 16)
        val file = File(output, "$name.png"); file.parentFile!!.mkdirs()
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
    private fun click(text: String) {
        repeat(15) {
            settle()
            val target = all().filterIsInstance<TextView>().firstOrNull { it.text.toString() == text && it.isShown && it.getGlobalVisibleRect(Rect()) }
            if (target != null) { target.performClick(); settle(); return }
            all().filterIsInstance<androidx.recyclerview.widget.RecyclerView>().first().scrollBy(0, (300 * activity.resources.displayMetrics.density).toInt())
        }
        fail("missing visible action $text: ${texts()}")
    }
    private fun clickCard(title: String) {
        settle()
        val heading = all().filterIsInstance<TextView>().first { it.text.toString() == title }
        all(heading.parent as ViewGroup).filterIsInstance<TextView>().first { it.text.toString() == "查看" }.performClick(); settle()
    }
    private fun statusAction() {
        settle()
        val status = all().filterIsInstance<TextView>().first { it.text.toString().contains("尚未通知 Ash") }
        val card = status.parent as ViewGroup
        all(card).filterIsInstance<TextView>().first { it.text.toString() == "重试通知" }.performClick(); settle()
    }

    @Test fun homeShowsCurrentWorkAndTheSharedPromisesOnAPhone() {
        val now = System.currentTimeMillis()
        Port.current = JSONObject().put("as_of", now)
            .put("presence", JSONObject().put("state", "working").put("text", "正在整理你下周的行程"))
            .put("progress", JSONObject().put("started", now - 60_000))
        Port.tasks = JSONArray()
            .put(JSONObject().put("id", "t_schedule").put("subject", "ash").put("title", "整理下周行程")
                .put("assignee", "agent:main").put("status", "doing").put("note", "正在核对已有安排，检查时间冲突"))
            .put(JSONObject().put("id", "t_meeting").put("subject", "ash").put("title", "帮你改会议")
                .put("assignee", "agent:main").put("status", "waiting").put("note", "在等你确认周三下午的时间"))
            .put(JSONObject().put("id", "t_owner").put("subject", "owner").put("title", "用户自己的待办").put("status", "todo"))
        open("now")
        assertTrue(texts().any { it.contains("正在整理你下周的行程") })
        for (title in listOf("我现在在做什么", "整理下周行程", "帮你改会议")) {
            assertTrue("home screenshot must visibly show $title", all().filterIsInstance<TextView>().any {
                it.text.toString() == title && it.isShown && it.getGlobalVisibleRect(Rect())
            })
        }
        assertTrue(texts().any { it.contains("在等你确认周三下午的时间") })
        assertFalse(texts().contains("用户自己的待办"))
        val listRead = Port.calls.first { it.first == "service:tasks" && it.second == "list" }.third
        assertEquals("ash", listRead.getString("subject")); assertEquals("all", listRead.getString("status"))
        assertFalse(Port.calls.any { it.second == "done" })
        screenshot("ash-home-now-and-promises")
    }

    @Test fun aSingleFactCorrectionPreservesNewFactsAndShowsWhetherAshWasNotified() {
        open("memory")
        val advanced = texts().indexOf("全文与整页批注（高级）")
        assertTrue("specific memories must precede the advanced entry", advanced < 0 || texts().indexOf("会议周二") < advanced)
        assertTrue(texts().contains("会议周二")); assertFalse(texts().contains(Port.document)); screenshot("memory-before-correction")
        click("修改")
        val editor = activity.findViewById<EditText>(R.id.ash_editor)
        assertEquals("会议周二", editor.text.toString())
        Port.document += "- 刚刚补上的偏好\n"
        editor.setText("会议周三"); click("保存")
        assertTrue(Port.document.contains("会议周三")); assertTrue(Port.document.contains("刚刚补上的偏好")); assertTrue(Port.document.contains("爱喝美式"))
        assertTrue(texts().any { it.contains("批注已保存，但尚未通知 Ash") })
        val note = Port.calls.last { it.second == "note" }.third
        Port.told = true; statusAction()
        assertEquals(note.getString("id"), Port.calls.last { it.second == "note" }.third.getString("id"))
        assertTrue(texts().any { it.contains("已通知 Ash") })
        Port.reply = "我读到了更正：会议是周三。咖啡偏好保持不变。"
        activity.message(JSONObject().put("from", "service:persona").put("kind", "event").put("word", "persona.changed").put("body", JSONObject().put("part", "notes").put("by", "agent:main")))
        settle(); assertTrue(texts().any { it.contains("Ash 已回应") }); screenshot("memory-corrected-and-answered")
    }

    @Test fun deletionClicksRemoveOnlyThatFactThroughTheSameWords() {
        open("memory"); click("删除")
        val dialog = ShadowAlertDialog.getLatestAlertDialog() as AlertDialog
        dialog.getButton(DialogInterface.BUTTON_POSITIVE).performClick(); settle()
        assertFalse(Port.document.contains("会议周二")); assertTrue(Port.document.contains("爱喝美式"))
        val writes = Port.calls.indexOfFirst { it.second == "memory.set" }; assertTrue(writes > 0); assertEquals("memory.get", Port.calls[writes - 1].second)
    }

    @Test fun aPromiseShowsItsBlockerThenItsActualResultAndOpensTheSameTask() {
        val task = JSONObject().put("id", "t_meeting").put("subject", "ash").put("title", "帮你改会议").put("assignee", "agent:main").put("status", "waiting").put("note", "在等你确认周三下午的时间")
        Port.tasks.put(task)
        open("now"); clickCard("帮你改会议")
        assertTrue(texts().contains("卡在这里")); assertTrue(texts().contains("在等你确认周三下午的时间")); screenshot("promise-blocked")
        assertFalse("viewing the task must not complete it", Port.calls.any { it.second == "done" })
        click("打开任务")
        val launched = shadowOf(activity).nextStartedActivity
        assertEquals("ai.ash.sysapps.tasks.TasksActivity", launched.component!!.className)
        val arg = JSONObject(launched.getStringExtra(SystemAppActivity.EXTRA_ARG)!!)
        assertEquals("t_meeting", arg.getString("id")); assertEquals("ash", arg.getString("subject"))
        task.put("status", "done").put("result", "会议已改到周三下午，日历已更新")
        activity.connect(); settle()
        assertTrue(texts().contains("事情的结果")); assertTrue(texts().contains("会议已改到周三下午，日历已更新"))
        assertFalse(texts().contains("卡在这里")); screenshot("promise-result")
    }

    @Test fun onlyTheExplicitCompletionActionCompletesAPromise() {
        Port.tasks.put(JSONObject().put("id", "t_meeting").put("subject", "ash").put("title", "帮你改会议").put("status", "waiting").put("note", "等你确认时间"))
        open("now"); clickCard("帮你改会议")
        click("批注 / 纠正")
        assertFalse(Port.calls.any { it.second == "done" })
        activity.backInside(); settle()
        click("完成这件事")
        val done = Port.calls.filter { it.second == "done" }
        assertEquals(1, done.size); assertEquals("t_meeting", done.single().third.getString("id"))
    }

    @Test fun oldStatusAndUnsubstantiatedGrowthStayClearlyLabelled() {
        Port.current = JSONObject().put("as_of", System.currentTimeMillis() - 600_000).put("presence", JSONObject().put("state", "working").put("text", "查会议"))
        Port.tasks = JSONArray().put(JSONObject().put("id", "t1").put("subject", "ash").put("title", "还没开始的事").put("status", "todo"))
        open("now")
        assertTrue(texts().any { it.contains("当前状态待确认") })
        assertTrue(texts().any { it.startsWith("待做") })
        Port.growth = JSONArray().put(JSONObject().put("id", "g1").put("title", "试着改进提醒").put("why", "反馈").put("did", "我修改了提醒方式").put("effect", "").put("next", "").put("by", "agent:main").put("at", 1))
        controller!!.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG, "{\"section\":\"growth\"}")); settle()
        assertTrue(texts().any { it.contains("效果怎样：尚未记录") })
        assertTrue(texts().any { it.contains("尚未附出处") })
        assertTrue(texts().any { it.contains("记录") })
    }

    @Test fun reusedEntryPreservesTheExactFactDraftAndRefreshesAfterReturning() {
        open("memory"); click("修改")
        activity.findViewById<EditText>(R.id.ash_editor).setText("还没保存的周三")
        controller!!.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG, "{\"section\":\"diary\",\"date\":\"2026-10-15\"}")); settle()
        assertTrue(texts().contains("会议周三"))
        controller!!.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG, "{\"section\":\"memory\"}")); settle(); click("修改")
        assertEquals("还没保存的周三", activity.findViewById<EditText>(R.id.ash_editor).text.toString())
        assertFalse(Port.calls.any { it.second == "memory.set" })
        Port.document = "# 安排\n- 会议周五\n"
        activity.backInside(); activity.connect(); settle()
        assertTrue(texts().contains("会议周五"))
    }
}
