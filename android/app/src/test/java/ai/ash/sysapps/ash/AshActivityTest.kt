package ai.ash.sysapps.ash

import android.app.AlertDialog
import android.app.Application
import android.content.DialogInterface
import android.content.Intent
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
import org.robolectric.shadows.ShadowAlertDialog

/** Actual Activity, RecyclerView rows, editor, clicks and saved drafts. The port is deterministic; the Node scenario covers the real hub. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class AshActivityTest {
    class TestActivity : AshActivity() {
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
        activity = controller!!.get(); activity.onConnectionChanged(true); settle()
    }
    private fun all(view: View = activity.window.decorView): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { all(view.getChildAt(it)) } else emptyList()
    private fun texts() = all().filterIsInstance<TextView>().map { it.text.toString() }
    private fun settle() {
        repeat(12) {
            shadowOf(Looper.getMainLooper()).idle()
            val root = activity.window.decorView
            root.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2400, View.MeasureSpec.EXACTLY)); root.layout(0, 0, 1080, 2400)
            Thread.sleep(10)
        }
    }
    private fun click(text: String) { settle(); val target = all().filterIsInstance<TextView>().firstOrNull { it.text.toString() == text && it.isShown }; assertNotNull("missing visible action $text: ${texts()}", target); target!!.performClick(); settle() }
    private fun clickCard(title: String) {
        settle()
        val heading = all().filterIsInstance<TextView>().first { it.text.toString() == title }
        all(heading.parent as ViewGroup).filterIsInstance<TextView>().first { it.text.toString() == "查看" }.performClick(); settle()
    }
    private fun statusAction() {
        settle()
        val status = all().filterIsInstance<TextView>().first { it.text.toString().contains("尚未通知 Ash") }
        val card = status.parent as ViewGroup
        all(card).filterIsInstance<TextView>().first { it.text.toString() == "查看" }.performClick(); settle()
    }

    @Test fun aSingleFactCorrectionPreservesNewFactsAndShowsWhetherAshWasNotified() {
        open("memory")
        assertTrue(texts().contains("会议周二")); assertFalse(texts().contains(Port.document))
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
        Port.reply = "我知道了，已按周三安排。"
        activity.onLedger(JSONObject().put("from", "service:persona").put("kind", "event").put("word", "persona.changed").put("body", JSONObject().put("part", "notes").put("by", "agent:main")))
        settle(); assertTrue(texts().any { it.contains("Ash 已回应") })
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
        assertTrue(texts().contains("卡在这里")); assertTrue(texts().contains("在等你确认周三下午的时间"))
        clickCard("打开任务应用")
        val launched = shadowOf(activity).nextStartedActivity
        val arg = JSONObject(launched.getStringExtra(SystemAppActivity.EXTRA_ARG)!!)
        assertEquals("t_meeting", arg.getString("id")); assertEquals("ash", arg.getString("subject"))
        task.put("status", "done").put("result", "会议已改到周三下午，日历已更新")
        activity.onConnectionChanged(true); settle()
        assertTrue(texts().contains("事情的结果")); assertTrue(texts().contains("会议已改到周三下午，日历已更新"))
        assertFalse(texts().contains("卡在这里"))
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
        activity.goBack(); activity.onConnectionChanged(true); settle()
        assertTrue(texts().contains("会议周五"))
    }
}
