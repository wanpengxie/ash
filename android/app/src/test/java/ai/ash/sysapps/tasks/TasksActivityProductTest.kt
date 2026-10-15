package ai.ash.sysapps.tasks

import ai.ash.sysapps.SystemAppActivity
import ai.ash.ui.HumanPort
import ai.ash.ui.KeyedRowsAdapter
import ai.ash.ui.UiIo
import android.app.Application
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.DialogInterface
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.content.Intent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowAlertDialog
import org.robolectric.shadows.ShadowDialog
import org.robolectric.shadows.ShadowLooper
import java.io.File
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class TasksTransportActivity : TasksActivity() {
    data class Request(val word: String, val body: JSONObject, val done: (JSONObject?, HumanPort.Failure?) -> Unit)
    val requests = mutableListOf<Request>()
    override fun taskCall(to: String, word: String, body: JSONObject, done: (JSONObject?, HumanPort.Failure?) -> Unit) {
        requests.add(Request(word, JSONObject(body.toString()), done))
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class TasksActivityProductTest {
    private fun views(v: View): List<View> = listOf(v) + if(v is ViewGroup) (0 until v.childCount).flatMap { views(v.getChildAt(it)) } else emptyList()
    private fun set(a: TasksActivity, name: String, value: Any) = TasksActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.set(a, value)
    private fun get(a: TasksActivity, name: String): Any? = TasksActivity::class.java.getDeclaredField(name).apply { isAccessible = true }.get(a)
    private fun invoke(a: TasksActivity, method: String) = TasksActivity::class.java.getDeclaredMethod(method).apply { isAccessible = true }.invoke(a)
    private fun flush() {
        val disk = CountDownLatch(1); UiIo.disk { disk.countDown() }; assertTrue(disk.await(10, TimeUnit.SECONDS))
        val decode = CountDownLatch(1); UiIo.decode { decode.countDown() }; assertTrue(decode.await(10, TimeUnit.SECONDS))
        ShadowLooper.idleMainLooper()
    }
    private fun screen(): org.robolectric.android.controller.ActivityController<TasksTransportActivity> {
        val app=org.robolectric.RuntimeEnvironment.getApplication()
        val disk = CountDownLatch(1); UiIo.disk { File(app.filesDir,"drafts/tasks.json").delete(); disk.countDown() };assertTrue(disk.await(10,TimeUnit.SECONDS))
        val intent = Intent().putExtra(SystemAppActivity.EXTRA_ARG, "{\"id\":\"one\"}")
        val ctl = Robolectric.buildActivity(TasksTransportActivity::class.java, intent).create()
        flush()
        val a = ctl.get()
        set(a,"state",TasksModel.State(tasks = listOf(TasksModel.Task("one","第一条"),TasksModel.Task("two","第二条",subject="ash",assignee="agent:main")),loaded=true))
        invoke(a,"render")
        return ctl
    }
    private fun text(a: TasksActivity, label: String): TextView = views(a.window.decorView).filterIsInstance<TextView>().first { it.text.toString()==label }
    private fun choice(index: Int) {
        val dialog=ShadowAlertDialog.getLatestAlertDialog()
        dialog.listView.performItemClick(dialog.listView.getChildAt(index),index,index.toLong())
    }
    @Test fun reusedActivityOpensNewTaskAndKeepsPreviousDraft() {
        val ctl=screen();val a=ctl.get()
        views(a.window.decorView).filterIsInstance<EditText>().first { it.text.toString()=="第一条" }.setText("第一条的未发草稿")
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{\"id\":\"two\",\"subject\":\"ash\"}"))
        assertEquals("two",get(a,"selected"))
        assertTrue(views(a.window.decorView).filterIsInstance<EditText>().any { it.text.toString()=="第二条" })
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{\"id\":\"one\"}"))
        assertTrue(views(a.window.decorView).filterIsInstance<EditText>().any { it.text.toString()=="第一条的未发草稿" })
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{\"subject\":\"ash\"}"))
        assertNull(get(a,"selected"));assertEquals(TasksModel.View.ASH,get(a,"view"))
        ctl.destroy();flush()
    }
    @Test fun timeEntryPicksDateAndTimeAndCanClearWithoutTypingAFormat() {
        val ctl=screen();val a=ctl.get()
        assertFalse(views(a.window.decorView).filterIsInstance<EditText>().any { it.hint?.toString()?.startsWith("截止时间") == true })
        val button=views(a.window.decorView).filterIsInstance<TextView>().first { it.tag=="task.time.due_at" }
        button.performClick();choice(0)
        val date=ShadowDialog.getLatestDialog() as DatePickerDialog
        date.updateDate(2026,10,11);date.getButton(DialogInterface.BUTTON_POSITIVE).performClick();ShadowLooper.idleMainLooper()
        val time=ShadowDialog.getLatestDialog() as TimePickerDialog
        time.updateTime(20,15);time.getButton(DialogInterface.BUTTON_POSITIVE).performClick();ShadowLooper.idleMainLooper()
        val expected=LocalDateTime.of(2026,11,11,20,15).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        assertEquals(expected,(get(a,"times") as Map<*,*>)["due_at"])
        text(a,"保存").performClick()
        assertEquals(expected,a.requests.last().body.getLong("due_at"))
        // The pending save does not disable choosing/clearing another time.
        button.performClick();choice(4)
        assertNull((get(a,"times") as Map<*,*>)["due_at"])
        ctl.destroy();flush()
    }
    @Test fun choosingAssigneeDoesNotChangeItBeforeAListChoice() {
        val ctl=screen();val a=ctl.get()
        @Suppress("UNCHECKED_CAST") val agents=get(a,"agents") as MutableList<String>;agents.add("agent:main")
        val button=views(a.window.decorView).filterIsInstance<TextView>().first { it.tag=="task.assignee" }
        button.performClick();assertEquals("person:owner",get(a,"assignee"))
        choice(1);assertEquals("agent:main",get(a,"assignee"))
        text(a,"保存").performClick()
        assertEquals("owner",a.requests.last().body.getString("subject"))
        assertEquals("agent:main",a.requests.last().body.getString("assignee"))
        assertEquals("todo",a.requests.last().body.getString("status"))
        ctl.destroy();flush()
    }
    @Test fun lateReadAndWriteResponsesCannotNavigateOrReplaceTheNewRoute() {
        val ctl=screen();val a=ctl.get();set(a,"visible",true)
        invoke(a,"refresh");val old=a.requests.last()
        text(a,"保存").performClick();val write=a.requests.last()
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{\"id\":\"two\"}"))
        val current=a.requests.last()
        current.done(JSONObject().put("tasks",JSONArray().put(task("two","现在的数据"))),null);flush()
        old.done(JSONObject().put("tasks",JSONArray().put(task("one","过时的数据"))),null)
        write.done(JSONObject().put("task",task("one","旧保存回执")),null);flush()
        assertEquals("two",get(a,"selected"))
        val state=get(a,"state") as TasksModel.State
        assertEquals(listOf("现在的数据"),state.tasks.map { it.title })
        assertTrue(views(a.window.decorView).filterIsInstance<EditText>().none { it.text.toString()=="过时的数据" })
        set(a,"visible",false);ctl.destroy();flush()
    }
    @Test fun homeShowsWhoNeedsToActAndProvidesRowActionsInsteadOfASettingsForm() {
        val ctl=screen();val a=ctl.get()
        val now=System.currentTimeMillis()
        set(a,"state",TasksModel.State(tasks=listOf(
            TasksModel.Task("tax","今天交报税材料",dueAt=now-1000),
            TasksModel.Task("price","Ash 正在比较跑鞋价格",subject="owner",assignee="agent:main",status="doing"),
            TasksModel.Task("address","等待收货地址",subject="owner",assignee="agent:helper",status="waiting",note="需要你给收货地址"),
        ),loaded=true))
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{}"))
        val list=get(a,"list") as androidx.recyclerview.widget.RecyclerView
        val adapter=list.adapter as KeyedRowsAdapter
        val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(10)
        while(adapter.currentList.none { it.key=="task:tax" } && System.nanoTime()<deadline){ShadowLooper.idleMainLooper();Thread.sleep(5)}
        assertEquals(setOf("section:you","section:working","section:blocked"),adapter.currentList.filter { it.key.startsWith("section:") }.map { it.key }.toSet())
        // Draw the exact adapter row factory used by RecyclerView, with real Views and action listeners.
        val row=adapter.currentList.first { it.key=="task:tax" }.make()!!
        views(row).filterIsInstance<TextView>().first { it.text.toString()=="完成" }.performClick()
        assertEquals("done",a.requests.last().word);assertEquals("tax",a.requests.last().body.getString("id"))
        val blocked=adapter.currentList.first { it.key=="task:address" }.make()!!
        assertTrue(views(blocked).filterIsInstance<TextView>().any { it.text.toString()=="需要你给收货地址" })
        assertTrue(views(row).none { it is EditText })
        ctl.destroy();flush()
    }
    @Test fun futureReminderPendingIsVisibleTodayAndRetriesTheExistingTask() {
        val ctl=screen();val a=ctl.get()
        set(a,"state",TasksModel.State(tasks=listOf(TasksModel.Task("future","下周交材料",remindAt=System.currentTimeMillis()+7*86_400_000L,remindersPending=true)),loaded=true))
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{}"))
        val adapter=(get(a,"list") as androidx.recyclerview.widget.RecyclerView).adapter as KeyedRowsAdapter
        val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(10)
        while(adapter.currentList.none { it.key=="task:future" } && System.nanoTime()<deadline){ShadowLooper.idleMainLooper();Thread.sleep(5)}
        assertTrue(adapter.currentList.any { it.key=="section:attention" })
        val row=adapter.currentList.first { it.key=="task:future" }.make()!!
        assertTrue(views(row).filterIsInstance<TextView>().any { it.text.toString().contains("此前不能保证到点提醒") })
        views(row).filterIsInstance<TextView>().first { it.text.toString()=="重试提醒" }.performClick()
        assertEquals("update",a.requests.last().word)
        assertEquals("{\"id\":\"future\"}",a.requests.last().body.toString())
        ctl.destroy();flush()
    }
    @Test fun quickCaptureChoosesTomorrowAndKeepsItsConfirmationAfterRefresh() {
        val ctl=screen();val a=ctl.get()
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{}"))
        (get(a,"quick") as EditText).setText("交材料")
        (get(a,"quickReminder") as View).performClick();choice(2)
        val at=java.time.LocalDate.now().plusDays(1).atTime(9,0).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        text(a,"记一条").performClick();flush()
        val add=a.requests.last();assertEquals("add",add.word)
        assertEquals("交材料",add.body.getString("title"));assertEquals(at,add.body.getLong("remind_at"))
        val stored=task("captured","交材料").put("remind_at",at).put("delivery",JSONObject().put("reminders","ready"))
        set(a,"visible",true);add.done(JSONObject().put("task",stored),null);flush()
        val confirmation=(get(a,"feedback") as TextView).text.toString()
        assertTrue(confirmation.contains("已记下：交材料"));assertTrue(confirmation.contains("已安排"));assertFalse(confirmation.contains("未设置提醒"))
        assertEquals("",(get(a,"quick") as EditText).text.toString())
        assertNull(get(a,"quickRemindAt"))
        a.requests.last { it.word=="list" }.done(JSONObject().put("tasks",JSONArray().put(stored)),null);flush()
        assertEquals(confirmation,(get(a,"feedback") as TextView).text.toString())
        set(a,"visible",false);ctl.destroy();flush()
    }
    @Test fun quickCaptureWithoutTimeSaysNoReminderWasSet() {
        val ctl=screen();val a=ctl.get()
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{}"))
        (get(a,"quick") as EditText).setText("整理书桌")
        text(a,"记一条").performClick();flush()
        val add=a.requests.last();assertTrue(add.body.isNull("remind_at"))
        add.done(JSONObject().put("task",task("desk","整理书桌")),null);flush()
        val confirmation=(get(a,"feedback") as TextView).text.toString()
        assertTrue(confirmation.contains("已记下：整理书桌"));assertTrue(confirmation.contains("未设置提醒"))
        ctl.destroy();flush()
    }
    @Test fun quickCaptureWithClockFailureSaysSavedButNotArranged() {
        val ctl=screen();val a=ctl.get()
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{}"))
        (get(a,"quick") as EditText).setText("交材料")
        (get(a,"quickReminder") as View).performClick();choice(2)
        text(a,"记一条").performClick();flush()
        val add=a.requests.last()
        add.done(JSONObject().put("task",task("captured","交材料").put("remind_at",add.body.getLong("remind_at")).put("delivery",JSONObject().put("reminders","pending"))),null);flush()
        val confirmation=(get(a,"feedback") as TextView).text.toString()
        assertTrue(confirmation.contains("已记下：交材料"));assertTrue(confirmation.contains("提醒尚未安排"));assertTrue(confirmation.contains("此前不能保证到点提醒"));assertFalse(confirmation.contains("已安排"))
        ctl.destroy();flush()
    }
    @Test fun retryOfUnknownCaptureKeepsOriginalBodyAndPreservesNewTitleAndTime() {
        val ctl=screen();val a=ctl.get()
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{}"))
        val input=get(a,"quick") as EditText
        input.setText("交材料")
        (get(a,"quickReminder") as View).performClick();choice(2)
        text(a,"记一条").performClick();flush()
        val first=a.requests.last();first.done(null,HumanPort.Failure("offline","结果尚未确认"))
        input.setText("另一件事")
        (get(a,"quickReminder") as View).performClick();choice(3)
        val newAt=get(a,"quickRemindAt")
        text(a,"记一条").performClick();flush()
        val retry=a.requests.last();assertEquals(first.body.toString(),retry.body.toString())
        retry.done(JSONObject().put("task",task("captured","交材料").put("remind_at",first.body.getLong("remind_at")).put("delivery",JSONObject().put("reminders","ready"))),null);flush()
        assertEquals("另一件事",input.text.toString());assertEquals(newAt,get(a,"quickRemindAt"))
        val confirmation=(get(a,"feedback") as TextView).text.toString()
        assertTrue(confirmation.contains("已记下：交材料"));assertTrue(confirmation.contains("新输入仍保留"));assertFalse(confirmation.contains("已记下：另一件事"))
        ctl.destroy();flush()
    }
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Config(qualifiers="w412dp-h915dp-mdpi")
    fun productHomeRendersTheActualWindowWithNativeGraphics() {
        val ctl=screen();val a=ctl.get()
        val now=System.currentTimeMillis()
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{}"))
        set(a,"visible",true)
        TasksActivity::class.java.getDeclaredMethod("onConnectionChanged",Boolean::class.javaPrimitiveType).apply { isAccessible=true }.invoke(a,true)
        a.requests.first { it.word=="list" && !it.body.has("status") }.done(JSONObject().put("agents",JSONArray()
            .put(JSONObject().put("id","agent:main").put("primary",true))
            .put(JSONObject().put("id","agent:helper").put("name","材料帮手"))),null)
        a.requests.first { it.word=="list" && it.body.has("status") }.done(JSONObject().put("tasks",JSONArray()
            .put(task("tax","交报税材料").put("due_at",now-1000))
            .put(task("price","比较跑鞋价格").put("assignee","agent:main").put("status","doing").put("note","在核对你选的三双跑鞋"))
            .put(task("address","确认收货地址").put("assignee","agent:helper").put("status","waiting").put("note","需要你给收货地址").put("source",JSONObject().put("message","source-address")))),null)
        flush()
        assertTrue(text(a,"3 条待办 · 可直接完成、改期或回来源跟进").text.isNotEmpty())
        val adapter=(get(a,"list") as androidx.recyclerview.widget.RecyclerView).adapter as KeyedRowsAdapter
        val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(10)
        while(adapter.currentList.none { it.key=="task:tax" } && System.nanoTime()<deadline){ShadowLooper.idleMainLooper();Thread.sleep(5)}
        val decor=a.window.decorView
        val metrics=a.resources.displayMetrics
        assertEquals(412,a.resources.configuration.screenWidthDp)
        assertEquals(915,a.resources.configuration.screenHeightDp)
        assertEquals(1f,metrics.density,0.001f)
        assertEquals(1f,a.resources.configuration.fontScale,0.001f)
        ctl.visible();flush()
        decor.measure(View.MeasureSpec.makeMeasureSpec(412,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(915,View.MeasureSpec.EXACTLY))
        decor.layout(0,0,412,915);flush()
        assertEquals(412f,decor.width / metrics.density,0.1f)
        val row=views(decor).first { it.tag=="task:tax" }
        val complete=views(row).filterIsInstance<TextView>().first { it.text.toString()=="完成" }
        val visibleBounds=Rect()
        assertTrue("the primary completion action must be visible in the actual phone window",complete.getGlobalVisibleRect(visibleBounds))
        assertEquals("completion must not be clipped horizontally",complete.width,visibleBounds.width())
        assertEquals("completion must not be clipped vertically",complete.height,visibleBounds.height())
        assertTrue(visibleBounds.left >= 0 && visibleBounds.right <= decor.width && visibleBounds.top >= 0 && visibleBounds.bottom <= decor.height)
        val bitmap=Bitmap.createBitmap(decor.width,decor.height,Bitmap.Config.ARGB_8888)
        decor.draw(Canvas(bitmap))
        val target=File("build/reports/tasks/tasks-product-home.png")
        target.parentFile?.mkdirs();target.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,it)) }
        bitmap.recycle();ctl.destroy();flush()
    }
    private fun task(id:String,title:String)=JSONObject().put("id",id).put("title",title).put("assignee","person:owner").put("subject","owner").put("status","todo").put("due_at",JSONObject.NULL).put("remind_at",JSONObject.NULL).put("updated_at",2)
}
