package ai.ash.sysapps.tasks

import ai.ash.sysapps.SystemAppActivity
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
import android.view.View
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
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
    private var state = TasksModel.State()
    private var view = TasksModel.View.TODAY
    private var visible = false
    private var loading = false
    private var dirty = false
    private var selected: String? = null
    private val names = mutableMapOf("person:owner" to "你", "service:tasks" to "Ash")
    private val pendingRows = mutableSetOf<String>()
    private val agents = mutableListOf("person:owner")
    private lateinit var list: RecyclerView
    private lateinit var adapter: KeyedRowsAdapter
    private lateinit var quick: EditText
    private lateinit var feedback: TextView
    private lateinit var quickButton: TextView
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
        editorId = null; restoreField = null; restoreKey = null
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
        val root = AshUi.vstack(this, 6).apply { setPadding(dp(14), 0, dp(14), dp(8)) }
        val tabs = AshUi.hstack(this, 6)
        TasksModel.View.entries.forEach { tab -> tabs.addView(AshUi.button(this, tab.label, AshUi.Kind.NEUTRAL) {
            routeGeneration++; dialog?.dismiss(); view = tab; selected = null; editorId = null; render(); syncBack()
        }) }
        root.addView(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(tabs) })
        feedback = AshUi.text(this, "正在读取…", AshTokens.Type.callout, c.text2).apply {
            minLines = 2; accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            setOnClickListener { refresh() }
        }
        root.addView(feedback)
        quick = Hk.field(this, "待办标题（先记一条）").apply { id = 0x007a1101; isEnabled = false }
        quickButton = AshUi.button(this, "记一条", AshUi.Kind.PRIMARY) { addQuick() }
        root.addView(AshUi.text(this, "这里先记标题，再选提醒时间；想用一句话安排提醒，请在对话里告诉 Ash。", AshTokens.Type.callout, c.text2))
        root.addView(AshUi.hstack(this, 8).apply {
            addView(quick, LinearLayout.LayoutParams(0, -2, 1f)); addView(quickButton)
        })
        adapter = KeyedRowsAdapter(this).apply {
            stateRestorationPolicy = RecyclerView.Adapter.StateRestorationPolicy.PREVENT_WHEN_EMPTY
        }
        list = RecyclerView(this).apply {
            id = 0x007a1102; layoutManager = LinearLayoutManager(this@TasksActivity)
            adapter = this@TasksActivity.adapter; itemAnimator = null
            addOnScrollListener(object : RecyclerView.OnScrollListener() {
                override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) { scrollVersion++ }
                override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) { if (scrollState != RecyclerView.SCROLL_STATE_IDLE) scrollVersion++ }
            })
        }
        root.addView(list, LinearLayout.LayoutParams(-1, 0, 1f))
        form = AshUi.vstack(this, 10)
        detail = ScrollView(this).apply { addView(form); visibility = View.GONE }
        root.addView(detail, LinearLayout.LayoutParams(-1, 0, 1f))
        content.addView(root)
        actions.addView(AshUi.button(this, "刷新", AshUi.Kind.GHOST) { refresh() })
        quick.watch { if (ready) { drafts.put("quick", quick.text.toString()); persist() } }
        UiIo.disk {
            val stored = runCatching { if (file.isFile) JSONObject(file.readText()) else JSONObject() }.getOrDefault(JSONObject())
            UiIo.ui {
                if (isDestroyed) return@ui
                drafts = stored; pendingAdd = stored.optJSONObject("pendingAdd")
                quick.setText(stored.optString("quick")); ready = true; quick.isEnabled = true
                if (pendingAdd != null) feedback.text = "上次添加尚未确认；点添加会核对同一次请求，输入保留。"
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
                        state = state.success(generation, items.distinctBy { it.id }); loading = false
                        feedback.text = if (pendingAdd != null) "上次添加待核对，点添加继续" else "${items.size} 条待办 · 可直接完成、改期或回来源跟进"
                        render(); if (dirty) refresh()
                    }
                }
            }
        }
        page()
    }
    private fun render() {
        if (!::list.isInitialized) return
        list.visibility = if (selected == null) View.VISIBLE else View.GONE
        detail.visibility = if (selected == null) View.GONE else View.VISIBLE
        quick.visibility = if (selected == null) View.VISIBLE else View.GONE; quickButton.visibility = quick.visibility
        if (selected != null) {
            val task = state.tasks.find { it.id == selected }
            if (task != null) {
                if (editorId != selected && ready) edit(task)
                else if (editorVersion != task.updatedAt && editorId == selected)
                    feedback.text = "这条待办有更新（${names[task.updatedBy] ?: task.updatedBy}）；你的编辑保留，返回后可重新打开。"
            } else {
                form.removeAllViews(); fields.clear(); times.clear()
                if(state.loaded) feedback.text = "没有找到这条待办，返回可看全部"
            }
            return
        }
        title.text = if (view == TasksModel.View.TODAY) "今天的事" else "任务 · ${view.label}"
        val rows = mutableListOf<ChatRow>()
        fun group(key: String, heading: String, tasks: List<TasksModel.Task>, empty: String? = null) {
            if (tasks.isEmpty() && empty == null) return
            rows.add(ChatRow("section:$key", "$heading:${tasks.size}") { AshUi.text(this, "$heading · ${tasks.size}", AshTokens.Type.headline) })
            tasks.forEach { rows.add(taskRow(it)) }
            if (tasks.isEmpty()) rows.add(ChatRow("empty:$key", empty.orEmpty()) { AshUi.text(this, empty.orEmpty(), AshTokens.Type.callout, c.text2) })
        }
        if (view == TasksModel.View.TODAY) {
            val attention = state.tasks.filter { it.remindersPending || it.conversationPending }
            group("attention", "需要补上", attention)
            val attentionIds = attention.map { it.id }.toSet()
            group("you", "今天轮到你", TasksModel.rows(state.tasks, view, System.currentTimeMillis()).filter { it.assignee == "person:owner" && it.id !in attentionIds }, "今天没有到期或逾期的事；还没定时间的在「待我处理」。")
            val work = state.tasks.filter { it.open && it.assignee.startsWith("agent:") && it.id !in attentionIds }
            group("blocked", "Ash 卡在哪里", work.filter { it.status == "waiting" })
            group("working", "Ash 正在推进", work.filter { it.status == "doing" })
            group("queued", "Ash 还未开始", work.filter { it.status == "todo" })
        } else group("all", view.label, TasksModel.rows(state.tasks, view, System.currentTimeMillis()), if (state.loaded) "这里还没有待办" else "正在读取待办…")
        val lm = list.layoutManager as LinearLayoutManager
        val first = lm.findFirstVisibleItemPosition(); val key = adapter.currentList.getOrNull(first)?.key
        val offset = lm.findViewByPosition(first)?.let { lm.getDecoratedTop(it) }
        val reading = restoreKey ?: key
        val top = if (restoreKey != null) restoreOffset else offset
        val epoch = scrollVersion
        adapter.submitList(rows) {
            val index = rows.indexOfFirst { it.key == reading }
            if (index >= 0 && top != null && selected == null && epoch == scrollVersion && list.scrollState == RecyclerView.SCROLL_STATE_IDLE) {
                lm.scrollToPositionWithOffset(index, top); restoreKey = null
            }
        }
    }
    private fun openTask(task: TasksModel.Task) { routeGeneration++; selected = task.id; editorId = null; render(); syncBack() }
    private fun source(task: TasksModel.Task) {
        task.source?.message?.takeIf { it.isNotBlank() }?.let {
            startActivity(Intent(this, HomeActivity::class.java).putExtra("ai.ash.extra.MESSAGE_ID", it).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        }
    }
    private fun taskRow(t: TasksModel.Task): ChatRow = ChatRow(t.key,
        listOf(t.title,t.note,t.status,t.subject,t.assignee,t.dueAt,t.remindAt,t.updatedBy,t.result,t.remindersPending,t.conversationPending,names[t.assignee],pendingRows.contains(t.id)).joinToString("|")) {
        AshUi.vstack(this, AshTokens.Space.xxs).apply {
            tag = t.key
            setPadding(dp(AshTokens.Space.xs),dp(AshTokens.Space.xs),dp(AshTokens.Space.xs),dp(AshTokens.Space.sm))
            addView(AshUi.text(this@TasksActivity,t.title,AshTokens.Type.headline))
            val person = TasksModel.assignee(t,names)
            val progress = when {
                t.status == "done" -> "做完了"
                t.status == "dropped" -> "已决定不做"
                t.status == "waiting" -> if (t.assignee == "person:owner") "在等对方" else "$person 暂时卡住了"
                t.status == "doing" -> if (t.assignee == "person:owner") "你正在处理" else "$person 正在处理"
                else -> if (t.assignee == "person:owner") "轮到你做" else "$person 负责，还未开始"
            }
            val at = t.dueAt ?: t.remindAt
            val timing = at?.let { "${if (t.dueAt != null) "原定" else "提醒"} ${editTime(it)}${if (t.open && it < System.currentTimeMillis()) " · 已过时间" else ""}" }
            addView(AshUi.text(this@TasksActivity,listOfNotNull(progress,timing).joinToString(" · "),AshTokens.Type.callout,c.text2))
            val detail = t.result.ifEmpty { t.note }
            if (detail.isNotBlank()) addView(AshUi.text(this@TasksActivity,detail,AshTokens.Type.body))
            if (t.remindersPending || t.conversationPending) addView(AshUi.text(this@TasksActivity,listOfNotNull(if(t.remindersPending)"已保存，提醒尚未安排；请点重试提醒，此前不能保证到点提醒" else null,if(t.conversationPending)"对话里的确认或结果待送达" else null).joinToString(" · "),AshTokens.Type.callout,c.text2))
            val buttons = Flow(this@TasksActivity,dp(AshTokens.Space.xs),dp(AshTokens.Space.xxs))
            fun action(label: String, kind: AshUi.Kind = AshUi.Kind.GHOST, run: () -> Unit) {
                buttons.addView(AshUi.button(this@TasksActivity,label,kind) { if (t.id !in pendingRows) run() }.apply { isEnabled = t.id !in pendingRows })
            }
            if(t.remindersPending)action("重试提醒",AshUi.Kind.SECONDARY) { rowWrite(t,"update",JSONObject().put("id",t.id)) }
            if(t.conversationPending)action("重试对话卡") { rowWrite(t,"update",JSONObject().put("id",t.id)) }
            if (t.open) {
                if (t.assignee == "person:owner") action("完成",AshUi.Kind.SECONDARY) { rowWrite(t,"done",JSONObject().put("id",t.id)) }
                else action("记录结果",AshUi.Kind.SECONDARY) {
                    val input = Hk.field(this@TasksActivity,"这件事的结果是什么？")
                    val epoch=routeGeneration
                    showDialog(AlertDialog.Builder(this@TasksActivity).setTitle(t.title).setView(input).setPositiveButton("完成并回报") { _, _ ->
                        if(epoch==routeGeneration && input.text.isNotBlank())rowWrite(t,"done",JSONObject().put("id",t.id).put("result",input.text.toString()))
                    }.setNegativeButton("取消",null).create())
                }
                action("改期") {
                    chooseTime("改到什么时候",t.remindAt ?: t.dueAt) { at ->
                        val b=JSONObject().put("id",t.id).put("remind_at",at ?: JSONObject.NULL)
                        if(t.dueAt!=null)b.put("due_at",at ?: JSONObject.NULL)
                        rowWrite(t,"update",b)
                    }
                }
            }
            if(t.source?.message?.isNotBlank()==true)action(if(t.status=="waiting")"去对话跟进" else "回来源对话") { source(t) }
            action("详细设置") { openTask(t) }
            addView(buttons)
            if(t.updatedBy.isNotBlank())addView(AshUi.text(this@TasksActivity,"${names[t.updatedBy] ?: t.updatedBy.removePrefix("agent:")} 更新",AshTokens.Type.callout,c.text2))
        }
    }
    private fun rowWrite(task: TasksModel.Task, word: String, body: JSONObject) {
        if(!pendingRows.add(task.id))return
        val epoch=routeGeneration; render()
        taskCall("service:tasks",word,body) { data,failure ->
            pendingRows.remove(task.id)
            if(epoch!=routeGeneration)return@taskCall
            feedback.text=if(failure!=null || data?.optJSONObject("task")==null) "${failure?.message ?: "结果尚未确认"} · 保留待办，请刷新核对" else savedMessage(data.optJSONObject("task"))
            refresh();render()
        }
    }
    private fun edit(task: TasksModel.Task) {
        editorId = task.id; editorVersion = task.updatedAt; title.text = "待办详情"
        form.removeAllViews(); fields.clear(); times.clear(); timeButtons.clear()
        val saved = drafts.optJSONObject(task.id)
        status = saved?.optString("status") ?: task.status; subject = saved?.optString("subject") ?: task.subject
        assignee = saved?.optString("assignee") ?: task.assignee
        fun field(key: String, label: String, value: String) {
            form.addView(AshUi.text(this, label, AshTokens.Type.callout, c.text2))
            val input = Hk.field(this, label, saved?.optString(key) ?: value)
            input.watch { saveEditor() }; fields[key] = input; form.addView(input)
        }
        field("title", "内容", task.title); field("note", "补充 / 在等谁、为什么", task.note)
        timeField("due_at", "截止时间", task.dueAt, saved)
        timeField("remind_at", "提醒时间", task.remindAt, saved)
        field("result", "结果 / 不做的原因", task.result)
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
        form.addView(AshUi.button(this, "保存", AshUi.Kind.PRIMARY) { saveTask(task.id) })
        if (task.open) form.addView(AshUi.button(this, "完成这件事", AshUi.Kind.SECONDARY) { status = "done"; saveTask(task.id) })
        task.source?.message?.takeIf { it.isNotBlank() }?.let { message ->
            form.addView(AshUi.button(this, "回到来源对话", AshUi.Kind.GHOST) {
                startActivity(Intent(this, HomeActivity::class.java).putExtra("ai.ash.extra.MESSAGE_ID", message).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
            })
        }
        form.addView(AshUi.text(this, "${names[task.updatedBy] ?: task.updatedBy} · ${editTime(task.updatedAt)}", AshTokens.Type.callout, c.text2))
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
    private fun savedMessage(task: JSONObject?): String {
        val delivery = task?.optJSONObject("delivery")
        return listOfNotNull("已保存", if (delivery?.optString("reminders") == "pending") "提醒尚未安排，请在列表点重试提醒" else null,
            if (delivery?.optString("conversation") == "pending") "对话卡待恢复" else null).joinToString(" · ")
    }
    private fun saveEditor() {
        val id = editorId ?: return
        val values = JSONObject().put("status", status).put("subject", subject).put("assignee", assignee)
        fields.forEach { (key, input) -> values.put(key, input.text.toString()) }
        times.forEach { (key, at) -> values.put(key, at ?: JSONObject.NULL) }
        drafts.put(id, values); persist()
    }
    private fun saveTask(id: String) {
        if (busy || !ready) return
        val title = fields["title"]?.text.toString().trim()
        if (title.isEmpty()) { feedback.text = "内容还没填"; return }
        val body = JSONObject().put("id", id).put("title", title).put("note", fields["note"]?.text.toString()).put("subject", subject).put("assignee", assignee).put("status", status).put("result", fields["result"]?.text.toString())
        if (status == "dropped" && body.optString("result").isBlank()) { feedback.text = "写一句不做的原因，Ash 也能看到"; return }
        times.forEach { (key, at) -> body.put(key, at ?: JSONObject.NULL) }
        busy = true; feedback.text = "正在保存…"; val draftAtSend = drafts.optJSONObject(id)?.toString()
        val routeAtSend = routeGeneration
        taskCall("service:tasks", "update", body) { data, failure ->
            busy = false
            if (failure != null || data?.optJSONObject("task") == null) {
                if (routeAtSend == routeGeneration) feedback.text = "${failure?.message ?: "结果尚未确认"} · 编辑保留；刷新核对后可再保存"
                return@taskCall
            }
            if (drafts.optJSONObject(id)?.toString() == draftAtSend) {
                drafts.remove(id); persist()
                if (routeAtSend == routeGeneration && selected == id) { selected = null; editorId = null; render(); syncBack() }
            }
            if (routeAtSend == routeGeneration) { feedback.text = savedMessage(data.optJSONObject("task")); refresh() }
        }
    }
    private fun addQuick() {
        if (busy || !ready) return
        val text = quick.text.toString().trim()
        if (text.isEmpty() && pendingAdd == null) return
        if (text.length > 200 && pendingAdd == null) { feedback.text = "内容请控制在 200 字内"; return }
        val body = pendingAdd ?: JSONObject().put("title", text).put("client_id", UUID.randomUUID().toString()).put("subject", "owner")
        pendingAdd = body; drafts.put("pendingAdd", body); busy = true; feedback.text = "正在记下…"
        // Persist request identity before sending, and reuse exactly that body if the outcome is unknown.
        val routeAtSend = routeGeneration
        persist {
            taskCall("service:tasks", "add", body) { data, failure ->
                busy = false
                if (failure != null || data?.optJSONObject("task") == null) {
                    if (routeAtSend == routeGeneration) feedback.text = "${failure?.message ?: "结果尚未确认"} · 标题保留，再点记一条核对同一次请求"
                    return@taskCall
                }
                pendingAdd = null; drafts.remove("pendingAdd")
                if (quick.text.toString().trim() == body.optString("title")) { quick.setText(""); drafts.remove("quick") }
                persist()
                if (routeAtSend == routeGeneration) {
                    view = TasksModel.View.WAITING; render()
                    feedback.text = "${savedMessage(data.optJSONObject("task"))}：${body.optString("title")} · 点待办可选提醒时间"; refresh()
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
    override fun canGoBack() = selected != null
    override fun goBack() { routeGeneration++; dialog?.dismiss(); selected = null; editorId = null; render(); syncBack() }
    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out); out.putString("task", selected); out.putString("view", view.name)
        val lm = list.layoutManager as LinearLayoutManager
        val first = lm.findFirstVisibleItemPosition()
        adapter.currentList.getOrNull(first)?.let { out.putString("anchor", it.key) }
        lm.findViewByPosition(first)?.let { out.putInt("offset", lm.getDecoratedTop(it)) }
        fields.entries.find { it.value.hasFocus() }?.let { out.putString("field", it.key); out.putInt("selection", it.value.selectionStart) }
    }
    private fun EditText.watch(changed: () -> Unit) = addTextChangedListener(object : TextWatcher {
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
            return TasksModel.Task(o.getString("id"), o.getString("title"), o.optString("note"), o.optString("subject", "owner"), o.getString("assignee"), o.getString("status"), time("due_at"), time("remind_at"), source?.let { TasksModel.Source(it.optString("message"), it.optString("agent")) }, o.optString("result").takeUnless { it == "null" }.orEmpty(), o.optString("updated_by"), o.optLong("updated_at"), o.optJSONObject("delivery")?.optString("reminders") == "pending", o.optJSONObject("delivery")?.optString("conversation") == "pending")
        }
    }
}
