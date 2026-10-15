package ai.ash.sysapps.tasks

import ai.ash.sysapps.SystemAppActivity
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = android.app.Application::class)
class TasksActivityProductTest {
    private fun Views(v: View): List<View> = listOf(v) + if(v is ViewGroup) (0 until v.childCount).flatMap { Views(v.getChildAt(it)) } else emptyList()
    private fun set(a: TasksActivity, name: String, value: Any) = TasksActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.set(a, value)
    private fun get(a: TasksActivity, name: String): Any? = TasksActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(a)
    private fun render(a: TasksActivity) = TasksActivity::class.java.getDeclaredMethod("render").apply { isAccessible = true }.invoke(a)
    private fun screen(): org.robolectric.android.controller.ActivityController<TasksActivity> {
        val intent = Intent().putExtra(SystemAppActivity.EXTRA_ARG, "{\"id\":\"one\"}")
        val ctl = Robolectric.buildActivity(TasksActivity::class.java, intent).create()
        val a = ctl.get()
        set(a,"ready",true)
        set(a,"state",TasksModel.State(tasks = listOf(TasksModel.Task("one","第一条"),TasksModel.Task("two","第二条",subject="ash",assignee="agent:main")),loaded=true))
        render(a)
        return ctl
    }
    @Test fun reusedActivityOpensNewTaskAndKeepsPreviousDraft() {
        val ctl=screen();val a=ctl.get()
        val input=Views(a.window.decorView).filterIsInstance<EditText>().first { it.text.toString()=="第一条" }
        input.setText("第一条的未发草稿")
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{\"id\":\"two\",\"subject\":\"ash\"}"))
        assertEquals("two",get(a,"selected"))
        assertTrue(Views(a.window.decorView).filterIsInstance<EditText>().any { it.text.toString()=="第二条" })
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{\"id\":\"one\"}"))
        assertTrue(Views(a.window.decorView).filterIsInstance<EditText>().any { it.text.toString()=="第一条的未发草稿" })
        ctl.destroy()
    }
    @Test fun timeEntryUsesASelectorInsteadOfARequiredFormattedTextField() {
        val ctl=screen();val views=Views(ctl.get().window.decorView)
        assertFalse(views.filterIsInstance<EditText>().any { it.hint?.toString()?.startsWith("截止时间") == true })
        assertTrue(views.filterIsInstance<TextView>().any { it.tag=="task.time.due_at" && it.isClickable })
        ctl.destroy()
    }
    @Test fun choosingAssigneeDoesNotChangeItBeforeAListChoice() {
        val ctl=screen();val a=ctl.get()
        val agents=get(a,"agents") as MutableList<String>;agents.add("agent:main")
        val button=Views(a.window.decorView).filterIsInstance<TextView>().first { it.text.toString().startsWith("负责人：") }
        button.performClick()
        assertEquals("person:owner",get(a,"assignee"))
        ctl.destroy()
    }
}
