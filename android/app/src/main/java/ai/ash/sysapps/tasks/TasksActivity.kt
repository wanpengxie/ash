package ai.ash.sysapps.tasks

import ai.ash.R
import ai.ash.sysapps.SystemAppActivity
import ai.ash.sysapps.AppIdentity
import ai.ash.sysapps.AppAccent
import ai.ash.sysapps.AppDestination
import ai.ash.ui.Flow
import ai.ash.ui.ChatRow
import ai.ash.ui.HumanPort
import ai.ash.ui.Hk
import ai.ash.ui.HomeActivity
import ai.ash.ui.KeyedRowsAdapter
import ai.ash.ui.UiIo
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi
import android.app.AlertDialog
import android.app.DatePickerDialog
import android.app.Dialog
import android.app.TimePickerDialog
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.PopupMenu
import android.widget.FrameLayout
import android.widget.TextView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

/** The hub owns task state. This screen stores only drafts, request identity and reading state. */
open class TasksActivity : SystemAppActivity() {
    override val appIdentity get()=AppIdentity("任务",R.drawable.ash_ic_clock,AppAccent.TASKS)
    private var state = TasksModel.State()
    private var view = TasksModel.View.TODAY
    private var visible = false
    private var loading = false
    private var dirty = false
    private var selected: String? = null
    private val ui by lazy { TasksViews(this) }
    private var editing = false
    private var recordOnly = false
    private var quickExpanded = false
    private var confirmedAt: Long? = null
    private var historyExpanded = false
    private var historyTask: String? = null
    private var history = emptyList<String>()
    private lateinit var quickPanel: LinearLayout
    private lateinit var detailContent: LinearLayout
    private lateinit var record: LinearLayout
    private lateinit var detailActions: LinearLayout
    private val names = mutableMapOf("person:owner" to "你", "service:tasks" to "Ash")
    private val pendingRows = mutableSetOf<String>()
    private val agents = mutableListOf("person:owner")
    private lateinit var list: RecyclerView
    private lateinit var adapter: KeyedRowsAdapter
    private lateinit var quick: EditText
    private lateinit var feedback: TextView
    private lateinit var quickButton: TextView
    private lateinit var quickReminder: TextView
    private var quickRemindAt: Long? = null
    private var quickReceipt: String? = null
    private lateinit var detail: ScrollView
    private lateinit var form: LinearLayout
    private val fields = linkedMapOf<String, EditText>()
    private val times = linkedMapOf<String, Long?>()
    private val timeButtons = linkedMapOf<String, TextView>()
    private var routeGeneration = 0L
    private var dialog: Dialog? = null
    private var status = "todo"
    private var subject = "owner"
    private var assignee = "person:owner"
    private var drafts = JSONObject()
    private var ready = false
    private var busy = false
    private var pendingAdd: JSONObject? = null
    private var editorId: String? = null
    private var editorVersion: Long = 0
    private var scrollVersion = 0L
    private var restoreKey: String? = null
    private var restoreOffset = 0
    private var restoreField: String? = null
    private var restoreSelection = 0
    private val places=mutableMapOf<TasksModel.View,Pair<String?,Int>>()
    private val file by lazy { File(filesDir, "drafts/tasks.json") }
    private fun route(from: Intent?, saved: Bundle? = null) {
        val arg = runCatching { JSONObject(from?.getStringExtra(EXTRA_ARG).orEmpty()) }.getOrNull()
        selected = if (saved != null) saved.getString("task") else arg?.optString("id")?.takeIf { it.isNotBlank() }
        view = if (saved != null) runCatching { TasksModel.View.valueOf(saved.getString("view").orEmpty()) }.getOrDefault(TasksModel.View.TODAY)
        else if (arg?.optString("subject") == "ash") TasksModel.View.ASH
        else runCatching { TasksModel.View.valueOf(arg?.optString("view").orEmpty().uppercase()) }.getOrDefault(TasksModel.View.TODAY)
    }
    override fun onNewIntent(next: Intent) {
        super.onNewIntent(next)
        dialog?.dismiss(); dialog = null
        setIntent(next); routeGeneration++; state = state.request(); loading = false; dirty = false
        editorId = null; restoreField = null; restoreKey = null; editing=false;historyExpanded=false;historyTask=null
        route(next); render(); syncBack(); refresh()
    }
    /** Same production hub port, overridable only to exercise Activity callbacks with controlled transport responses. */
    protected open fun taskCall(to: String, word: String, body: JSONObject = JSONObject(), done: (JSONObject?, HumanPort.Failure?) -> Unit) =
        call(to, word, body, done)

    override fun build(saved: Bundle?) {
        title.text = "任务"
        restoreKey = saved?.getString("anchor")
        restoreOffset = saved?.getInt("offset") ?: 0
        restoreField = saved?.getString("field")
        restoreSelection = saved?.getInt("selection") ?: 0
        state = (lastNonConfigurationInstance as? TasksModel.State) ?: state
        route(intent, saved)
        editing=saved?.getBoolean("editing") ?: false
        recordOnly=saved?.getBoolean("recordOnly") ?: false
        quickExpanded=saved?.getBoolean("quickExpanded") ?: false
        val root=AshUi.vstack(this)
        feedback=AshUi.text(this,"",AshTokens.Type.callout,c.text2).apply {
            setPadding(dp(16),dp(8),dp(16),dp(8));visibility=View.GONE
            accessibilityLiveRegion=View.ACCESSIBILITY_LIVE_REGION_POLITE
            setOnClickListener { refresh() }
            watch { visibility=if(text.isBlank())View.GONE else View.VISIBLE }
        }
        root.addView(feedback)
        adapter=KeyedRowsAdapter(this).apply { stateRestorationPolicy=RecyclerView.Adapter.StateRestorationPolicy.PREVENT_WHEN_EMPTY }
        list=RecyclerView(this).apply {
            id=0x007a1102;layoutManager=LinearLayoutManager(this@TasksActivity)
            adapter=this@TasksActivity.adapter;itemAnimator=null;clipToPadding=false
            setPadding(dp(16),dp(8),dp(16),dp(24))
            addOnScrollListener(object:RecyclerView.OnScrollListener(){
                override fun onScrollStateChanged(recyclerView:RecyclerView,newState:Int){scrollVersion++}
                override fun onScrolled(recyclerView:RecyclerView,dx:Int,dy:Int){if(scrollState!=RecyclerView.SCROLL_STATE_IDLE)scrollVersion++}
            })
        }
        root.addView(list,LinearLayout.LayoutParams(-1,0,1f))
        form=AshUi.vstack(this,12)
        record=AshUi.vstack(this,16)
        detailContent=AshUi.vstack(this).apply { addView(record);addView(form) }
        detail=ScrollView(this).apply { setPadding(dp(16),dp(8),dp(16),dp(24));isFillViewport=false;addView(detailContent);visibility=View.GONE }
        root.addView(detail,LinearLayout.LayoutParams(-1,0,1f))
        detailActions=AshUi.hstack(this,8).apply { setPadding(dp(16),dp(10),dp(16),dp(12));visibility=View.GONE }
        quick=Hk.field(this,"例如：交报税材料").apply { id=0x007a1101;isEnabled=false }
        quickButton=ui.action("记下",primary=true) { addQuick() }
        quickReminder=ui.action("提醒：未设置") {
            chooseTime("提醒时间",quickRemindAt) { at ->
                quickRemindAt=at;quickReceipt=null;syncQuickReminder()
                drafts.put("quickRemindAt",at ?: JSONObject.NULL);persist()
            }
        }.apply { tag="task.quick.remind_at";isEnabled=false }
        quickPanel=AshUi.vstack(this,8).apply {
            setPadding(dp(16),dp(12),dp(16),dp(12))
            addView(ui.line());addView(AshUi.text(this@TasksActivity,"记一件事",AshTokens.Type.headline))
            addView(AshUi.text(this@TasksActivity,"标题",AshTokens.Type.sub,c.text2))
            addView(AshUi.hstack(this@TasksActivity,8).apply { addView(quick,LinearLayout.LayoutParams(0,-2,1f));addView(quickButton) })
            addView(quickReminder)
            addView(ui.action("收起") { quickExpanded=false;render() })
            visibility=View.GONE
        }
        root.addView(quickPanel)
        content.addView(root)
        setDestinations(listOf(AppDestination("now","现在",R.drawable.ash_ic_pulse),AppDestination("all","全部",R.drawable.ash_ic_grid),AppDestination("yours","你的事",R.drawable.ash_ic_check)),destination()){id ->
            changeSpace(when(id){"yours"->TasksModel.View.WAITING;"all"->TasksModel.View.ALL;else->TasksModel.View.TODAY})
        }
        quick.watch { if(ready){quickReceipt=null;drafts.put("quick",quick.text.toString());persist()} }
        UiIo.disk {
            val stored = runCatching { if (file.isFile) JSONObject(file.readText()) else JSONObject() }.getOrDefault(JSONObject())
            UiIo.ui {
                if (isDestroyed) return@ui
                drafts = stored; pendingAdd = stored.optJSONObject("pendingAdd")
                quickRemindAt=if(stored.has("quickRemindAt") && !stored.isNull("quickRemindAt"))stored.optLong("quickRemindAt") else null
                quick.setText(stored.optString("quick")); ready = true; quick.isEnabled = true;quickReminder.isEnabled=true;syncQuickReminder()
                if(pendingAdd!=null){quickExpanded=true;feedback.text="上次记下的结果尚未确认；点记下核对原请求，新输入保留。"}
                render()
            }
        }
    }
    override fun onRetainNonConfigurationInstance(): Any = state
    override fun onStart() { visible = true; super.onStart() }
    override fun onStop() { visible = false; state = state.request(); loading = false; super.onStop() }
    override fun onConnectionChanged(connected: Boolean) {
        if (connected && visible) {
            refresh()
            val routeAtRead = routeGeneration
            taskCall("service:agents", "list") { data, failure ->
                if (routeAtRead != routeGeneration || !visible) return@taskCall
                if (failure == null && data != null) {
                    agents.clear(); agents.add("person:owner")
                    val all = data.optJSONArray("agents")
                    for (i in 0 until (all?.length() ?: 0)) all?.optJSONObject(i)?.let { a ->
                        val id = a.optString("id")
                        if (id.isNotBlank()) {
                            names[id] = if (a.optBoolean("primary")) "Ash" else a.optString("name").ifBlank { id.removePrefix("agent:") }
                            if (id !in agents) agents.add(id)
                        }
                    }
                    render()
                }
            }
        }
    }
    override fun onLedger(message: JSONObject) {
        if (TasksModel.shouldRefresh(message.optString("from"), message.optString("word"))) refresh()
    }
    private fun refresh() {
        if (!visible) return
        if (loading) { dirty = true; return }
        loading = true; dirty = false; state = state.request(); val generation = state.generation
        val items = mutableListOf<TasksModel.Task>()
        fun page(before: Long? = null) {
            val body = JSONObject().put("status", "all").put("limit", 500)
            before?.let { body.put("before", it) }
            taskCall("service:tasks", "list", body) { data, failure ->
                if (!visible || generation != state.generation) return@taskCall
                if (failure != null || data?.optJSONArray("tasks") == null) {
                    loading = false; state = state.failure(generation, failure?.message ?: "待办数据没有读完整")
                    feedback.text = "${state.problem} · 保留上次内容，点这里重试"; return@taskCall
                }
                UiIo.decode {
                    val parsed = runCatching { val a = data.getJSONArray("tasks"); (0 until a.length()).map { parse(a.getJSONObject(it)) } }
                    UiIo.ui {
                        if (!visible || generation != state.generation) return@ui
                        if (parsed.isFailure) { loading = false; feedback.text = "待办格式有误，保留上次内容"; return@ui }
                        items.addAll(parsed.getOrThrow()); val next = data.optLong("next_before")
                        if (next > 0 && next != before) { page(next); return@ui }
                        state = state.success(generation, items.distinctBy { it.id }); loading = false;confirmedAt=System.currentTimeMillis()
                        feedback.text=if(pendingAdd!=null)"上次添加待核对，点记下继续" else quickReceipt.orEmpty()
                        render(); if (dirty) refresh()
                    }
                }
            }
        }
        page()
    }
    private fun render() {
        if(!::list.isInitialized)return
        val showingObject=selected!=null
        list.visibility=if(showingObject)View.GONE else View.VISIBLE
        detail.visibility=if(showingObject)View.VISIBLE else View.GONE
        quickPanel.visibility=if(quickExpanded && !showingObject)View.VISIBLE else View.GONE
        record.visibility=if(showingObject && !editing)View.VISIBLE else View.GONE
        form.visibility=if(showingObject && editing)View.VISIBLE else View.GONE
        detailActions.visibility=if(showingObject && !editing)View.VISIBLE else View.GONE
        refreshChrome()
        if(showingObject){
            val task=state.tasks.find { it.id==selected }
            if(task!=null){
                if(editing){
                    if(editorId!=task.id && ready)edit(task)
                    else if(editorVersion!=task.updatedAt && editorId==task.id)feedback.text="这件事有更新；你的编辑保留，返回后可重新打开。"
                }else showDetail(task)
            }else{
                record.removeAllViews();record.addView(ui.text(if(state.loaded)"没有找到这件事，返回可看全部" else "正在读取这件事…"))
                form.removeAllViews();fields.clear();times.clear();detailActions.removeAllViews()
            }
            return
        }
        val rows=mutableListOf<ChatRow>()
        fun section(key:String,label:String,items:List<TasksModel.Task>,recovery:Boolean=false,total:Int=items.size){
            rows.add(ChatRow("section:$key","$label:$total"){ui.section(label,total)})
            items.forEach { t -> rows.add(taskRow(t,recovery,key)) }
        }
        if(view==TasksModel.View.TODAY){
            val now=TasksModel.now(state.tasks,System.currentTimeMillis())
            if(now.recovery.isNotEmpty())section("recovery","需要补上",now.recovery,true)
            if(now.current.isNotEmpty())section("current","现在需处理",now.current)
            if(state.loaded && now.recovery.isEmpty() && now.current.isEmpty())rows.add(ChatRow("quiet","quiet") {
                AshUi.text(this,"本页当前没有需要你处理的事",AshTokens.Type.callout,c.text2).apply { setPadding(0,dp(20),0,dp(12)) }
            })
            section("agents","Ash 与帮手负责的事",now.agents.take(2),total=now.agents.size)
            if(now.agents.size>2)rows.add(ChatRow("more-agents",now.agents.size.toString()){ui.action("查看全部 ${now.agents.size} 项",outline=true){changeSpace(TasksModel.View.ALL)}})
            section("yours","你的待办",now.yours)
            if(state.loaded && now.yours.isEmpty())rows.add(ChatRow("empty:yours","empty"){AshUi.text(this,"暂时没有待做的个人事项。",AshTokens.Type.callout,c.text2)})
            section("results","最近结果",now.results.take(3))
            if(state.loaded && now.results.isEmpty())rows.add(ChatRow("empty:results","empty"){AshUi.text(this,"还没有新的完成结果。",AshTokens.Type.callout,c.text2)})
        }else{
            val tasks=TasksModel.rows(state.tasks,view,System.currentTimeMillis())
            section("all",view.label,tasks)
            if(state.loaded && tasks.isEmpty())rows.add(ChatRow("empty:all","empty"){AshUi.text(this,"这里还没有事项。",AshTokens.Type.callout,c.text2)})
        }
        rows.add(ChatRow("capture",quickExpanded.toString()){ui.action(if(quick.text.isNotBlank())"继续记一件事" else "记一件事",outline=true){quickExpanded=true;render();quick.requestFocus()}})
        submitRows(rows)
    }
    private fun submitRows(rows:List<ChatRow>){
        val lm=list.layoutManager as LinearLayoutManager
        val first=lm.findFirstVisibleItemPosition();val key=adapter.currentList.getOrNull(first)?.key
        val offset=lm.findViewByPosition(first)?.let { lm.getDecoratedTop(it) }
        val reading=restoreKey ?: key;val top=if(restoreKey!=null)restoreOffset else offset;val epoch=scrollVersion
        adapter.submitList(rows){
            val index=rows.indexOfFirst { it.key==reading }
            if(index>=0 && top!=null && selected==null && epoch==scrollVersion && list.scrollState==RecyclerView.SCROLL_STATE_IDLE){lm.scrollToPositionWithOffset(index,top);restoreKey=null}
        }
    }
    private fun taskRow(t:TasksModel.Task,recovery:Boolean=false,scope:String="all"):ChatRow=ChatRow("$scope:${t.key}",
        listOf(t,t.reminderDelivery,t.conversationDelivery,names[t.assignee],pendingRows.contains(t.id)).joinToString("|")) {
        if(recovery)ui.recovery(t,{openTask(t)},{rowWrite(t,"update",JSONObject().put("id",t.id))},enabled=t.id !in pendingRows)
        else ui.row(t,names,taskSubtitle(t,scope)){openTask(t)}
    }
    private fun taskSubtitle(t:TasksModel.Task,scope:String):String {
        if(!t.open)return listOfNotNull(if(t.updatedBy=="person:owner")"你标记${if(t.status=="done")"完成" else "不做了"}" else "${TasksModel.assignee(t,names)} · ${TasksModel.status(t)}",t.result.takeIf { it.isNotBlank() }).joinToString(" · ")
        val reason=if(scope=="current")TasksModel.currentReason(t,System.currentTimeMillis()) else null
        return listOfNotNull(TasksModel.assignee(t,names),TasksModel.status(t),reason,timeNote(t).takeIf { t.assignee=="person:owner" && (t.dueAt!=null || t.remindAt!=null) }).joinToString(" · ")
    }
    private fun timeNote(t:TasksModel.Task):String {
        val now=System.currentTimeMillis()
        fun at(label:String,value:Long)= "$label${editTime(value)} · ${if(value>now)"尚未到点" else "已到时间"}"
        return listOfNotNull(t.remindAt?.let { at("提醒",it) },t.dueAt?.let { at("截止",it) }).joinToString("\n").ifBlank { "未设置提醒" }
    }
    private fun rememberList(){
        val lm=list.layoutManager as LinearLayoutManager;val first=lm.findFirstVisibleItemPosition()
        restoreKey=adapter.currentList.getOrNull(first)?.key;restoreOffset=lm.findViewByPosition(first)?.let { lm.getDecoratedTop(it) } ?: 0
        places[view]=restoreKey to restoreOffset
    }
    private fun openTask(task:TasksModel.Task){rememberList();routeGeneration++;selected=task.id;editing=false;editorId=null;historyExpanded=false;historyTask=null;render();syncBack()}
    private fun changeSpace(next:TasksModel.View){
        rememberList();routeGeneration++;dialog?.dismiss();view=next;selected=null;editing=false;editorId=null
        val place=places[next];restoreKey=place?.first;restoreOffset=place?.second ?: 0
        if(place==null)(list.layoutManager as LinearLayoutManager).scrollToPositionWithOffset(0,0)
        render();syncBack()
    }
    private fun source(task:TasksModel.Task){task.source?.message?.takeIf { it.isNotBlank() }?.let {
        startActivity(Intent(this,HomeActivity::class.java).putExtra("ai.ash.extra.MESSAGE_ID",it).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
    }}
    private fun rowWrite(task:TasksModel.Task,word:String,body:JSONObject){
        if(!pendingRows.add(task.id))return
        val epoch=routeGeneration;render()
        taskCall("service:tasks",word,body){data,failure ->
            pendingRows.remove(task.id)
            if(epoch!=routeGeneration)return@taskCall
            val saved=data?.optJSONObject("task")
            if(failure!=null || saved==null)feedback.text="${failure?.message ?: "结果尚未确认"} · 原记录保留，请刷新核对"
            else {
                runCatching { parse(saved) }.getOrNull()?.let { t -> state=state.copy(tasks=state.tasks.map { if(it.id==t.id)t else it }) }
                feedback.text=savedMessage(saved)
            }
            render();refresh()
        }
    }
    private fun beginEdit(task:TasksModel.Task,onlyRecord:Boolean=false){editing=true;recordOnly=onlyRecord;editorId=null;render();syncBack()}
    private fun showDetail(t:TasksModel.Task){
        record.removeAllViews();detailActions.removeAllViews()
        record.addView(AshUi.text(this,"${TasksModel.assignee(t,names)}负责 · ${TasksModel.status(t)} · ${if(t.subject=="ash")"Ash 的承诺" else "主人的事项"}",AshTokens.Type.sub,c.text2))
        record.addView(AshUi.text(this,t.title,AshTokens.Type.title))
        record.addView(ui.text("${timeNote(t)} · 本机时间"))
        if(TasksModel.needsRecovery(t)){
            record.addView(AshUi.vstack(this,12).apply {
                setPadding(dp(12),dp(16),dp(12),dp(16));background=AshUi.rounded(c.surface2,dp(16).toFloat())
                addView(AshUi.text(this@TasksActivity,TasksModel.delivery(t),AshTokens.Type.headline))
                addView(ui.text(if(t.remindersPending)"这件事已记下。补上前不能保证到点提醒。" else "这件事已记下，对话里的卡片尚未恢复。"))
                addView(ui.action(TasksModel.recoveryAction(t),outline=true){rowWrite(t,"update",JSONObject().put("id",t.id))}.apply { isEnabled=t.id !in pendingRows })
            })
        }else record.addView(AshUi.text(this,TasksModel.delivery(t),AshTokens.Type.sub,c.text2))
        record.addView(AshUi.text(this,"当前记录",AshTokens.Type.callout,c.text2));record.addView(ui.note(t.note.ifBlank { "还没有补充记录。" }))
        if(t.result.isNotBlank()){record.addView(AshUi.text(this,"结果记录",AshTokens.Type.callout,c.text2));record.addView(ui.note(t.result))}
        record.addView(ui.actions(ui.action("编辑这件事"){beginEdit(t)},ui.action("改提醒"){chooseTime("提醒时间",t.remindAt){at -> rowWrite(t,"update",JSONObject().put("id",t.id).put("remind_at",at ?: JSONObject.NULL))}}))
        if(t.source?.message?.isNotBlank()==true)record.addView(ui.action("看原始交代",outline=true){source(t)})
        record.addView(ui.line())
        record.addView(ui.action(if(historyExpanded)"收起修改记录" else "谁改过这件事"){historyExpanded=!historyExpanded;if(historyExpanded)readHistory(t);showDetail(t)})
        if(historyExpanded){
            if(historyTask==t.id && history.isNotEmpty())history.forEach { record.addView(AshUi.text(this,it,AshTokens.Type.sub,c.text2)) }
            else record.addView(AshUi.text(this,if(historyTask==t.id)"还没有修改记录" else "正在读取修改记录…",AshTokens.Type.sub,c.text2))
        }
        fun bottom(label:String,primary:Boolean=false,run:()->Unit){detailActions.addView(ui.action(label,primary,onClick=run),LinearLayout.LayoutParams(0,-2,1f))}
        if(t.open && t.assignee=="person:owner")bottom("标记我已完成",true){rowWrite(t,"done",JSONObject().put("id",t.id))}
        else if(t.source?.message?.isNotBlank()==true)bottom("回原对话继续",true){source(t)}
        else if(!t.open)bottom("重新打开",true){rowWrite(t,"update",JSONObject().put("id",t.id).put("status","todo"))}
        bottom("编辑记录"){beginEdit(t,true)}
    }
    private fun readHistory(t:TasksModel.Task){
        val epoch=routeGeneration
        taskCall("service:tasks","get",JSONObject().put("id",t.id)){data,failure ->
            if(epoch!=routeGeneration || selected!=t.id)return@taskCall
            if(failure!=null || data?.optJSONArray("changes")==null){feedback.text="修改记录暂时读不到，原事项保留";return@taskCall}
            historyTask=t.id
            val changes=data?.optJSONArray("changes")
            history=(0 until (changes?.length() ?: 0)).mapNotNull { i -> changes?.optJSONObject(i)?.let { change ->
                val action=when(change.optString("change")){"created"->"记下事项";"done"->"标记完成";"dropped"->"标记不做了";"reopened"->"重新打开";"reminded"->"发出提醒";"followed_up"->"跟进事项";else->"更新记录"}
                "${change.optLong("at").takeIf { it>0 }?.let(::editTime) ?: "时间未记录"} · ${names[change.optString("by")] ?: change.optString("by")} · $action" }
            }
            if(!editing)state.tasks.find { it.id==t.id }?.let(::showDetail)
        }
    }
    private fun destination()=when(view){TasksModel.View.TODAY->"now";TasksModel.View.WAITING->"yours";else->"all"}
    private fun refreshChrome(){
        showPage(if(selected==null)"任务" else if(editing)"编辑这件事" else "一件事",detail=selected!=null,showNavigation=selected==null)
        selectDestination(destination())
        setStatus(if(selected!=null)null else confirmedAt?.let { "最近确认 · ${editTime(it)}" } ?: if(state.loaded)"事项记录" else "正在读取事项…")
        setBottomAction(if(selected!=null && !editing)detailActions else null)
        actions.removeAllViews()
        actions.addView(AshUi.iconButton(this,getDrawable(if(selected==null)R.drawable.ash_ic_slider else R.drawable.ash_ic_more)!!,if(selected==null)"任务选项" else "事项操作"){openMenu(actions)})
    }
    private fun openMenu(anchor:View){
        val menu=PopupMenu(this,anchor)
        val task=state.tasks.find { it.id==selected }
        fun item(label:String,run:()->Unit){menu.menu.add(label).setOnMenuItemClickListener { run();true }}
        if(task==null){
            item("记一件事"){quickExpanded=true;render();quick.requestFocus()}
            item("刷新事项"){quickReceipt=null;refresh()}
            item("Ash 自己的承诺"){changeSpace(TasksModel.View.ASH)}
            item("已完成与不做了"){changeSpace(TasksModel.View.CLOSED)}
        }else{
            item("完整设置"){beginEdit(task)}
            if(task.open){
                item("标记完成"){rowWrite(task,"done",JSONObject().put("id",task.id))}
                item("不做了"){rowWrite(task,"update",JSONObject().put("id",task.id).put("status","dropped"))}
            }else item("重新打开"){rowWrite(task,"update",JSONObject().put("id",task.id).put("status","todo"))}
            item("刷新这件事"){refresh()}
        }
        menu.show()
    }
    private fun edit(task: TasksModel.Task) {
        editorId = task.id; editorVersion = task.updatedAt; title.text = if(recordOnly)"编辑记录" else "编辑这件事"
        form.removeAllViews(); fields.clear(); times.clear(); timeButtons.clear()
        val saved = drafts.optJSONObject(task.id)
        status = saved?.optString("status") ?: task.status; subject = saved?.optString("subject") ?: task.subject
        assignee = saved?.optString("assignee") ?: task.assignee
        fun field(key: String, label: String, value: String) {
            form.addView(AshUi.text(this, label, AshTokens.Type.callout, c.text2))
            val input=Hk.field(this,label,if(saved?.has(key)==true)saved.optString(key) else value)
            input.watch { saveEditor() }; fields[key] = input; form.addView(input)
        }
        if(!recordOnly)field("title", "内容", task.title)
        field("note", "当前记录", task.note)
        field("result", "结果记录", task.result)
        if(!recordOnly){
        timeField("due_at", "截止时间", task.dueAt, saved)
        timeField("remind_at", "提醒时间", task.remindAt, saved)
        form.addView(AshUi.button(this, "负责人：${names[assignee] ?: assignee}", AshUi.Kind.NEUTRAL).apply {
            tag = "task.assignee"
            setOnClickListener {
                val choices = (agents + assignee).distinct()
                val labels = choices.map { names[it] ?: it.removePrefix("agent:") }.toTypedArray()
                val routeAtOpen = routeGeneration; val taskAtOpen = editorId
                showDialog(AlertDialog.Builder(this@TasksActivity).setTitle("选择负责人")
                    .setSingleChoiceItems(labels, choices.indexOf(assignee)) { d, which ->
                        if (routeAtOpen == routeGeneration && taskAtOpen == editorId) {
                            assignee = choices[which]; text = "负责人：${labels[which]}"; saveEditor()
                        }
                        d.dismiss()
                    }.setNegativeButton("取消", null).create())
            }
        })
        form.addView(AshUi.text(this, "负责人和状态只更新记录，不会自动通知或开工；有提醒时间时，到点才会通知负责人。", AshTokens.Type.callout, c.text2))
        form.addView(AshUi.button(this, if (subject == "ash") "Ash 自己的事" else "你的事", AshUi.Kind.NEUTRAL).apply {
            setOnClickListener { subject = if (subject == "ash") "owner" else "ash"; text = if (subject == "ash") "Ash 自己的事" else "你的事"; saveEditor() }
        })
        val statusLabel = AshUi.text(this, "状态：${TasksModel.status(task.copy(status = status))}", AshTokens.Type.callout, c.text2)
        form.addView(statusLabel)
        listOf("todo" to "待做", "doing" to "在做", "waiting" to "等对方", "done" to "完成", "dropped" to "不做了").forEach { (code, label) ->
            form.addView(AshUi.button(this, label, AshUi.Kind.NEUTRAL).apply {
                isSelected = status == code
                setOnClickListener { status = code; statusLabel.text = "状态：$label"; saveEditor(); feedback.text = "状态选为 $label · 保存后生效" }
            })
        }
        }
        form.addView(ui.action("保存",primary=true) { saveTask(task.id) })

        task.source?.message?.takeIf { it.isNotBlank() }?.let { message ->
            form.addView(AshUi.button(this, "回到来源对话", AshUi.Kind.GHOST) {
                startActivity(Intent(this, HomeActivity::class.java).putExtra("ai.ash.extra.MESSAGE_ID", message).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            })
        }
        if(task.updatedBy.isNotBlank() && task.updatedAt>0)form.addView(AshUi.text(this,"${names[task.updatedBy] ?: task.updatedBy} · ${editTime(task.updatedAt)}",AshTokens.Type.sub,c.text2))
        restoreField?.let { key -> fields[key]?.let { input -> input.requestFocus(); input.setSelection(restoreSelection.coerceIn(0, input.length())) } }
        restoreField = null
    }
    private fun showDialog(next: Dialog) {
        dialog?.dismiss(); dialog = next
        next.setOnDismissListener { if (dialog === next) dialog = null }
        next.show()
    }
    private fun timeField(key: String, label: String, current: Long?, saved: JSONObject?) {
        val value = if (saved?.has(key) == true) runCatching {
            if (saved.isNull(key)) null else if (saved.opt(key) is Number) saved.getLong(key)
            else (timeValue(saved.optString(key)) as? Number)?.toLong()
        }.getOrNull() else current
        times[key] = value
        val button = AshUi.button(this, "$label：${value?.let(::editTime) ?: "未设置"}", AshUi.Kind.NEUTRAL).apply { tag = "task.time.$key" }
        timeButtons[key] = button; form.addView(button)
        button.setOnClickListener {
            chooseTime(label,times[key]) { at -> times[key]=at;button.text="$label：${at?.let(::editTime) ?: "未设置"}";saveEditor() }
        }
    }
    private fun chooseTime(label: String, current: Long?, choose: (Long?) -> Unit) {
        val epoch=routeGeneration;val task=selected
        fun accept(at:Long?){if(epoch==routeGeneration && task==selected)choose(at)}
        val zone=ZoneId.systemDefault();val now=java.time.ZonedDateTime.now(zone)
        val tonight=now.toLocalDate().atTime(20,0).atZone(zone).let { if(it.isAfter(now))it else it.plusDays(1) }
        val labels=arrayOf("选日期和时间",if(tonight.toLocalDate()==now.toLocalDate())"今晚 20:00" else "明晚 20:00","明天 09:00","一小时后","清除时间")
        showDialog(AlertDialog.Builder(this).setTitle("$label · ${zone.id}").setItems(labels) { _,which -> when(which){
            0 -> {
                val initial=Instant.ofEpochMilli(current ?: System.currentTimeMillis()).atZone(zone)
                showDialog(DatePickerDialog(this,{ _,y,m,d ->
                    if(epoch==routeGeneration && task==selected)showDialog(TimePickerDialog(this,{ _,h,min ->
                        accept(LocalDateTime.of(y,m+1,d,h,min).atZone(zone).toInstant().toEpochMilli())
                    },initial.hour,initial.minute,android.text.format.DateFormat.is24HourFormat(this)))
                },initial.year,initial.monthValue-1,initial.dayOfMonth))
            }
            1 -> accept(tonight.toInstant().toEpochMilli())
            2 -> accept(now.toLocalDate().plusDays(1).atTime(9,0).atZone(zone).toInstant().toEpochMilli())
            3 -> accept(now.plusHours(1).toInstant().toEpochMilli())
            4 -> accept(null)
        }}.setNegativeButton("取消",null).create())
    }
    private fun savedMessage(task:JSONObject?):String {
        if(task==null)return "结果尚未确认"
        return runCatching { "已保存 · ${TasksModel.delivery(parse(task))}".removePrefix("已保存 · 已保存 · ") }.getOrDefault("已保存，安排状态待核对")
    }
    private fun saveEditor() {
        val id = editorId ?: return
        val values=JSONObject(drafts.optJSONObject(id)?.toString() ?: "{}").put("status",status).put("subject",subject).put("assignee",assignee)
        fields.forEach { (key, input) -> values.put(key, input.text.toString()) }
        times.forEach { (key, at) -> values.put(key, at ?: JSONObject.NULL) }
        drafts.put(id, values); persist()
    }
    private fun saveTask(id: String) {
        if (busy || !ready) return
        val title=fields["title"]?.text?.toString()?.trim()
        if(!recordOnly && title.isNullOrEmpty()){feedback.text="内容还没填";return}
        val body=JSONObject().put("id",id).put("note",fields["note"]?.text.toString()).put("result",fields["result"]?.text.toString())
        if(!recordOnly)body.put("title",title).put("subject",subject).put("assignee",assignee).put("status",status)
        times.forEach { (key, at) -> body.put(key, at ?: JSONObject.NULL) }
        busy = true; feedback.text = "正在保存…"; val draftAtSend = drafts.optJSONObject(id)?.toString()
        val routeAtSend=routeGeneration;val partialAtSend=recordOnly
        taskCall("service:tasks", "update", body) { data, failure ->
            busy = false
            if (failure != null || data?.optJSONObject("task") == null) {
                if (routeAtSend == routeGeneration) feedback.text = "${failure?.message ?: "结果尚未确认"} · 编辑保留；刷新核对后可再保存"
                return@taskCall
            }
            if (drafts.optJSONObject(id)?.toString() == draftAtSend) {
                if(partialAtSend){
                    drafts.optJSONObject(id)?.let { kept -> kept.remove("note");kept.remove("result");if(kept.length()==0)drafts.remove(id) }
                }else drafts.remove(id)
                persist()
                if(routeAtSend==routeGeneration && selected==id){editing=false;editorId=null;render();syncBack()}
            }
            if(routeAtSend==routeGeneration){
                runCatching { parse(data.getJSONObject("task")) }.getOrNull()?.let { updated -> state=state.copy(tasks=state.tasks.map { if(it.id==id)updated else it }) }
                feedback.text=savedMessage(data.optJSONObject("task"));render();refresh()
            }
        }
    }
    private fun syncQuickReminder() {
        quickReminder.text="提醒：${quickRemindAt?.let(::editTime) ?: "未设置"}"
    }
    private fun quickSavedMessage(task: JSONObject, body: JSONObject): String {
        val at=if(task.has("remind_at") && !task.isNull("remind_at"))task.optLong("remind_at") else null
        val delivery=task.optJSONObject("delivery")
        val reminder=when {
            at==null -> "未设置提醒"
            delivery?.optString("reminders")=="ready" -> "已安排 ${editTime(at)} 提醒"
            delivery?.optString("reminders")=="pending" -> "提醒尚未安排，请点重试提醒；此前不能保证到点提醒"
            else -> "提醒状态待核对"
        }
        return listOfNotNull("已记下：${body.optString("title")}",reminder,
            if(delivery?.optString("conversation")=="pending")"对话卡待恢复" else null).joinToString(" · ")
    }
    private fun addQuick() {
        if (busy || !ready) return
        val text = quick.text.toString().trim()
        if (text.isEmpty() && pendingAdd == null) return
        if (text.length > 200 && pendingAdd == null) { feedback.text = "内容请控制在 200 字内"; return }
        val body = pendingAdd ?: JSONObject().put("title", text).put("client_id", UUID.randomUUID().toString()).put("subject", "owner").put("remind_at",quickRemindAt ?: JSONObject.NULL)
        pendingAdd = body; drafts.put("pendingAdd", body); busy = true; quickReceipt=null;feedback.text = "正在记下…"
        // Persist request identity before sending, and reuse exactly that body if the outcome is unknown.
        val routeAtSend = routeGeneration
        persist {
            taskCall("service:tasks", "add", body) { data, failure ->
                busy = false
                if (failure != null || data?.optJSONObject("task") == null) {
                    if (routeAtSend == routeGeneration) feedback.text = "${failure?.message ?: "结果尚未确认"} · 标题保留，再点记下核对同一次请求"
                    return@taskCall
                }
                pendingAdd = null; drafts.remove("pendingAdd")
                val sentAt=if(body.isNull("remind_at") || !body.has("remind_at"))null else body.optLong("remind_at")
                val unchanged=quick.text.toString().trim()==body.optString("title") && quickRemindAt==sentAt
                if (unchanged) {
                    quick.setText("");drafts.remove("quick");quickRemindAt=null;drafts.remove("quickRemindAt");syncQuickReminder()
                }
                persist()
                if (routeAtSend == routeGeneration) {
                    view = TasksModel.View.WAITING; quickExpanded = !unchanged;render()
                    quickReceipt=quickSavedMessage(data.getJSONObject("task"),body) + if(unchanged)"" else " · 新输入仍保留"
                    feedback.text=quickReceipt;refresh()
                }
            }
        }
    }
    private fun persist(then: (() -> Unit)? = null) {
        if (!ready) return
        val text = drafts.toString()
        UiIo.disk {
            val ok = UiIo.writeAtomically(file, text)
            UiIo.ui { if (!isDestroyed) { if (ok) then?.invoke() else { busy = false; feedback.text = "草稿没有存下，请保留内容再试" } } }
        }
    }
    override fun onDestroy() { dialog?.dismiss(); dialog = null; super.onDestroy() }
    override fun canGoBack()=selected!=null || quickExpanded
    override fun goBack(){
        routeGeneration++;dialog?.dismiss()
        if(editing){editing=false;editorId=null}else if(selected!=null){selected=null;editorId=null;historyExpanded=false}else quickExpanded=false
        render();syncBack()
    }
    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out); out.putString("task",selected);out.putString("view",view.name);out.putBoolean("editing",editing);out.putBoolean("recordOnly",recordOnly);out.putBoolean("quickExpanded",quickExpanded)
        val lm = list.layoutManager as LinearLayoutManager
        val first = lm.findFirstVisibleItemPosition()
        adapter.currentList.getOrNull(first)?.let { out.putString("anchor", it.key) }
        lm.findViewByPosition(first)?.let { out.putInt("offset", lm.getDecoratedTop(it)) }
        fields.entries.find { it.value.hasFocus() }?.let { out.putString("field", it.key); out.putInt("selection", it.value.selectionStart) }
    }
    private fun TextView.watch(changed: () -> Unit) = addTextChangedListener(object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = changed()
        override fun afterTextChanged(s: Editable?) {}
    })
    companion object {
        private val FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
        private fun editTime(at: Long?) = at?.let { Instant.ofEpochMilli(it).atZone(ZoneId.systemDefault()).format(FORMAT) }.orEmpty()
        private fun timeValue(text: String): Any = if (text.isBlank()) JSONObject.NULL else {
            val local = text.trim().replace(' ', 'T')
            (if (local.length == 10) LocalDate.parse(local).atTime(23, 59) else LocalDateTime.parse(local)).atZone(ZoneId.systemDefault()).toInstant().toEpochMilli()
        }
        private fun parse(o: JSONObject): TasksModel.Task {
            fun time(key: String): Long? = if (o.isNull(key) || !o.has(key)) null else o.getLong(key)
            val source = o.optJSONObject("source")
            return TasksModel.Task(o.getString("id"), o.getString("title"), o.optString("note"), o.optString("subject", "owner"), o.getString("assignee"), o.getString("status"), time("due_at"), time("remind_at"), source?.let { TasksModel.Source(it.optString("message"), it.optString("agent")) }, o.optString("result").takeUnless { it == "null" }.orEmpty(), o.optString("updated_by"), o.optLong("updated_at"), o.optJSONObject("delivery")?.optString("reminders") == "pending", o.optJSONObject("delivery")?.optString("conversation") == "pending",o.optJSONObject("delivery")!=null,o.optJSONObject("delivery")?.optString("reminders"),o.optJSONObject("delivery")?.optString("conversation"),time("done_at"))
        }
    }
}
