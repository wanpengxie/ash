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
        set(a,"editing",true);invoke(a,"render")
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
        assertEquals("two",get(a,"selected"));text(a,"编辑这件事").performClick()
        assertTrue(views(a.window.decorView).filterIsInstance<EditText>().any { it.text.toString()=="第二条" })
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{\"id\":\"one\"}"));text(a,"编辑这件事").performClick()
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
    @Test fun homeSeparatesActualDueReasonsFromWaitingAndOpensTheSameDetail() {
        val ctl=screen();val a=ctl.get();val now=System.currentTimeMillis()
        set(a,"state",TasksModel.State(tasks=listOf(
            TasksModel.Task("tax","交报税材料",dueAt=now-1000),
            TasksModel.Task("future","明天提醒的事",remindAt=now+86_400_000L),
            TasksModel.Task("address","等收货地址",assignee="agent:helper",status="waiting",note="等商家确认送货范围"),
        ),loaded=true))
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{}"))
        val adapter=(get(a,"list") as androidx.recyclerview.widget.RecyclerView).adapter as KeyedRowsAdapter
        awaitRow(adapter,"current:task:tax")
        assertTrue(adapter.currentList.none { it.key=="current:task:future" || it.key=="current:task:address" })
        val row=adapter.currentList.first { it.key=="current:task:tax" }.make()!!
        views(row).first { it.isClickable }.performClick()
        assertEquals("tax",get(a,"selected"));text(a,"标记我已完成").performClick()
        assertEquals("done",a.requests.last().word);assertEquals("tax",a.requests.last().body.getString("id"))
        assertEquals(1,a.requests.last().body.length())
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{\"id\":\"address\"}"))
        assertTrue(views(a.window.decorView).filterIsInstance<TextView>().any { it.text.toString()=="等商家确认送货范围" })
        assertTrue(views(get(a,"record") as View).none { it is EditText })
        ctl.destroy();flush()
    }
    private fun awaitRow(adapter:KeyedRowsAdapter,key:String){
        val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(10)
        while(adapter.currentList.none { it.key==key } && System.nanoTime()<deadline){ShadowLooper.idleMainLooper();Thread.sleep(5)}
        assertTrue("missing row $key",adapter.currentList.any { it.key==key })
    }
    @Test fun futureReminderPendingIsVisibleTodayAndRetriesTheExistingTask() {
        val ctl=screen();val a=ctl.get()
        set(a,"state",TasksModel.State(tasks=listOf(TasksModel.Task("future","下周交材料",remindAt=System.currentTimeMillis()+7*86_400_000L,remindersPending=true)),loaded=true))
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{}"))
        val adapter=(get(a,"list") as androidx.recyclerview.widget.RecyclerView).adapter as KeyedRowsAdapter
        val deadline=System.nanoTime()+TimeUnit.SECONDS.toNanos(10)
        while(adapter.currentList.none { it.key=="recovery:task:future" } && System.nanoTime()<deadline){ShadowLooper.idleMainLooper();Thread.sleep(5)}
        assertTrue(adapter.currentList.any { it.key=="section:recovery" })
        val row=adapter.currentList.first { it.key=="recovery:task:future" }.make()!!
        assertTrue(views(row).filterIsInstance<TextView>().any { it.text.toString().contains("提醒尚未安排") })
        views(row).filterIsInstance<TextView>().first { it.text.toString()=="补上提醒" }.performClick()
        assertEquals("update",a.requests.last().word)
        assertEquals("{\"id\":\"future\"}",a.requests.last().body.toString())
        ctl.destroy();flush()
    }
    @Test fun quickCaptureChoosesTomorrowAndKeepsItsConfirmationAfterRefresh() {
        val ctl=screen();val a=ctl.get()
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{}"));set(a,"quickExpanded",true);invoke(a,"render")
        (get(a,"quick") as EditText).setText("交材料")
        (get(a,"quickReminder") as View).performClick();choice(2)
        val at=java.time.LocalDate.now().plusDays(1).atTime(9,0).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        text(a,"记下").performClick();flush()
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
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{}"));set(a,"quickExpanded",true);invoke(a,"render")
        (get(a,"quick") as EditText).setText("整理书桌")
        text(a,"记下").performClick();flush()
        val add=a.requests.last();assertTrue(add.body.isNull("remind_at"))
        add.done(JSONObject().put("task",task("desk","整理书桌")),null);flush()
        val confirmation=(get(a,"feedback") as TextView).text.toString()
        assertTrue(confirmation.contains("已记下：整理书桌"));assertTrue(confirmation.contains("未设置提醒"))
        ctl.destroy();flush()
    }
    @Test fun quickCaptureWithClockFailureSaysSavedButNotArranged() {
        val ctl=screen();val a=ctl.get()
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{}"));set(a,"quickExpanded",true);invoke(a,"render")
        (get(a,"quick") as EditText).setText("交材料")
        (get(a,"quickReminder") as View).performClick();choice(2)
        text(a,"记下").performClick();flush()
        val add=a.requests.last()
        add.done(JSONObject().put("task",task("captured","交材料").put("remind_at",add.body.getLong("remind_at")).put("delivery",JSONObject().put("reminders","pending"))),null);flush()
        val confirmation=(get(a,"feedback") as TextView).text.toString()
        assertTrue(confirmation.contains("已记下：交材料"));assertTrue(confirmation.contains("提醒尚未安排"));assertTrue(confirmation.contains("此前不能保证到点提醒"));assertFalse(confirmation.contains("已安排"))
        ctl.destroy();flush()
    }
    @Test fun retryOfUnknownCaptureKeepsOriginalBodyAndPreservesNewTitleAndTime() {
        val ctl=screen();val a=ctl.get()
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{}"));set(a,"quickExpanded",true);invoke(a,"render")
        val input=get(a,"quick") as EditText
        input.setText("交材料")
        (get(a,"quickReminder") as View).performClick();choice(2)
        text(a,"记下").performClick();flush()
        val first=a.requests.last();first.done(null,HumanPort.Failure("offline","结果尚未确认"))
        input.setText("另一件事")
        (get(a,"quickReminder") as View).performClick();choice(3)
        val newAt=get(a,"quickRemindAt")
        text(a,"记下").performClick();flush()
        val retry=a.requests.last();assertEquals(first.body.toString(),retry.body.toString())
        retry.done(JSONObject().put("task",task("captured","交材料").put("remind_at",first.body.getLong("remind_at")).put("delivery",JSONObject().put("reminders","ready"))),null);flush()
        assertEquals("另一件事",input.text.toString());assertEquals(newAt,get(a,"quickRemindAt"))
        val confirmation=(get(a,"feedback") as TextView).text.toString()
        assertTrue(confirmation.contains("已记下：交材料"));assertTrue(confirmation.contains("新输入仍保留"));assertFalse(confirmation.contains("已记下：另一件事"))
        ctl.destroy();flush()
    }
    @Test
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    @Config(qualifiers="w360dp-h800dp-mdpi")
    fun frozenPhoneHomeRecoveryDetailQuietAndEditingUseTheActualWindow() {
        val ctl=screen();val a=ctl.get();val now=System.currentTimeMillis()
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{}"));set(a,"visible",true)
        @Suppress("UNCHECKED_CAST") val connected=SystemAppActivity::class.java.getDeclaredField("connection").apply { isAccessible=true }.get(a) as (Boolean)->Unit
        connected(true)
        a.requests.first { it.word=="list" && !it.body.has("status") }.done(JSONObject().put("agents",JSONArray()
            .put(JSONObject().put("id","agent:main").put("primary",true))
            .put(JSONObject().put("id","agent:helper").put("name","资料帮手"))),null)
        val recovery=task("recovery","寄出报税补充材料").put("note","周一寄出补充材料；取件前核对清单。").put("source",JSONObject().put("message","source-tax"))
            .put("remind_at",now+3*86_400_000L).put("delivery",JSONObject().put("saved",true).put("reminders","pending").put("conversation","pending"))
        val waiting=task("compare","比较日常慢跑鞋").put("source",JSONObject().put("message","source-compare")).put("assignee","agent:main").put("status","waiting").put("note","候选价格已记下，正等商家确认退换条件。先核对原比较，再决定。")
        val helper=task("helper","核对住宿退款条款并补齐比较依据").put("subject","ash").put("assignee","agent:helper").put("status","todo").put("note","原退款条款和来源尚待核对。")
        val future=task("future","交报税材料").put("remind_at",now+3_600_000L)
        val normal=JSONArray().put(recovery).put(waiting).put(helper).put(future)
        a.requests.first { it.word=="list" && it.body.has("status") }.done(JSONObject().put("tasks",normal),null);flush()
        val adapter=(get(a,"list") as androidx.recyclerview.widget.RecyclerView).adapter as KeyedRowsAdapter
        awaitRow(adapter,"recovery:task:recovery")
        assertTrue(adapter.currentList.none { it.key=="section:current" })
        val decor=a.window.decorView;ctl.visible();flush()
        assertEquals(360,a.resources.configuration.screenWidthDp);assertEquals(800,a.resources.configuration.screenHeightDp)
        assertEquals(1f,a.resources.displayMetrics.density,0.001f);assertEquals(1f,a.resources.configuration.fontScale,0.001f)
        fun layout(){decor.measure(View.MeasureSpec.makeMeasureSpec(360,View.MeasureSpec.EXACTLY),View.MeasureSpec.makeMeasureSpec(800,View.MeasureSpec.EXACTLY));decor.layout(0,0,360,800);flush()}
        fun visible(v:View){val bounds=Rect();assertTrue(v.getGlobalVisibleRect(bounds));assertEquals(v.width,bounds.width());assertEquals(v.height,bounds.height());assertTrue(bounds.left>=0 && bounds.top>=0 && bounds.right<=360 && bounds.bottom<=800)}
        fun capture(name:String){layout();val bitmap=Bitmap.createBitmap(decor.width,decor.height,Bitmap.Config.ARGB_8888);decor.draw(Canvas(bitmap));val file=File("build/reports/tasks/$name.png");file.parentFile?.mkdirs();file.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG,100,it)) };bitmap.recycle()}
        layout();visible(text(a,"补上提醒与卡片"));assertEquals(360f,decor.width/a.resources.displayMetrics.density,0.1f)
        capture("tasks-home")
        // Click the real visible object row; the recovery action always updates this id.
        text(a,"寄出报税补充材料").parent.let { (it as View).performClick() };layout()
        assertEquals("recovery",get(a,"selected"));visible(text(a,"补上提醒与卡片"));capture("tasks-detail")
        text(a,"补上提醒与卡片").performClick();assertEquals("update",a.requests.last().word);assertEquals("{\"id\":\"recovery\"}",a.requests.last().body.toString())
        val failed=a.requests.last();failed.done(null,HumanPort.Failure("offline","安排尚未确认"));flush()
        assertTrue(views(decor).filterIsInstance<TextView>().any { it.text.toString().contains("提醒尚未安排") })
        invoke(a,"goBack");layout()
        // A real list reply clears the pending state, but waiting and future reminders still create no current demand.
        invoke(a,"refresh")
        val ready=JSONObject(recovery.toString()).put("delivery",JSONObject().put("saved",true).put("reminders","ready").put("conversation","ready"))
        val quiet=JSONArray().put(ready).put(waiting).put(helper)
        a.requests.last { it.word=="list" && it.body.has("status") }.done(JSONObject().put("tasks",quiet),null);flush();awaitRow(adapter,"yours:task:recovery")
        assertTrue(adapter.currentList.none { it.key=="section:current" || it.key=="section:recovery" })
        capture("tasks-quiet")
        ctl.newIntent(Intent().putExtra(SystemAppActivity.EXTRA_ARG,"{\"id\":\"compare\"}"));layout();capture("tasks-ash-detail")
        assertTrue(views(decor).filterIsInstance<TextView>().any { it.text.toString()==waiting.getString("note") })
        (text(a,"看原始交代").parent as View).performClick()
        assertEquals("source-compare",shadowOf(a).nextStartedActivity.getStringExtra("ai.ash.extra.MESSAGE_ID"))
        text(a,"编辑记录").performClick();layout()
        val note=(get(a,"fields") as Map<*,*>)["note"] as EditText
        note.setText("已核对两家商户，继续等最后一家回复。")
        note.requestFocus();note.setSelection(4)
        invoke(a,"refresh");a.requests.last { it.word=="list" && it.body.has("status") }.done(JSONObject().put("tasks",quiet),null);flush()
        assertSame(note,(get(a,"fields") as Map<*,*>)["note"]);assertEquals(4,note.selectionStart)
        text(a,"保存").performClick();val save=a.requests.last();assertEquals("update",save.word)
        assertEquals(setOf("id","note","result"),save.body.keys().asSequence().toSet())
        save.done(JSONObject().put("task",JSONObject(waiting.toString()).put("note",note.text.toString())),null);flush();layout();capture("tasks-edited")
        assertTrue(views(decor).filterIsInstance<TextView>().any { it.text.toString()=="已核对两家商户，继续等最后一家回复。" })
        invoke(a,"goBack");set(a,"quickExpanded",true);invoke(a,"render");layout()
        val input=get(a,"quick") as EditText;input.setText("买出差用的洗漱用品与充电线")
        (get(a,"quickReminder") as View).performClick();choice(2)
        text(a,"记下").performClick();flush()
        val add=a.requests.last { it.word=="add" }
        val added=task("travel",add.body.getString("title")).put("remind_at",add.body.getLong("remind_at")).put("delivery",JSONObject().put("saved",true).put("reminders","ready").put("conversation","ready"))
        add.done(JSONObject().put("task",added),null);flush()
        a.requests.last { it.word=="list" && it.body.has("status") }.done(JSONObject().put("tasks",JSONArray().put(added)),null);flush();awaitRow(adapter,"all:task:travel")
        layout();val receipt=get(a,"feedback") as TextView
        assertTrue(receipt.text.contains("已记下：买出差用的洗漱用品与充电线"));assertTrue(receipt.text.contains("已安排"));assertTrue(receipt.lineCount>=2);visible(receipt)
        capture("tasks-added")
        set(a,"visible",false);ctl.destroy();flush()
    }
    private fun task(id:String,title:String)=JSONObject().put("id",id).put("title",title).put("assignee","person:owner").put("subject","owner").put("status","todo").put("due_at",JSONObject.NULL).put("remind_at",JSONObject.NULL).put("updated_at",2).put("delivery",JSONObject().put("saved",true).put("reminders","none").put("conversation","ready"))
}
