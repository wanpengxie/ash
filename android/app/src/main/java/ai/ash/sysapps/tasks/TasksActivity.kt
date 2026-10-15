package ai.ash.sysapps.tasks

import ai.ash.sysapps.SystemAppActivity
import ai.ash.ui.ChatRow
import ai.ash.ui.Hk
import ai.ash.ui.HomeActivity
import ai.ash.ui.KeyedRowsAdapter
import ai.ash.ui.UiIo
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi
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
class TasksActivity : SystemAppActivity() {
    private var state = TasksModel.State()
    private var view = TasksModel.View.TODAY
    private var visible = false
    private var loading = false
    private var dirty = false
    private var selected: String? = null
    private val names = mutableMapOf("person:owner" to "你")
    private val agents = mutableListOf("person:owner")
    private lateinit var list: RecyclerView
    private lateinit var adapter: KeyedRowsAdapter
    private lateinit var quick: EditText
    private lateinit var feedback: TextView
    private lateinit var quickButton: TextView
    private lateinit var detail: ScrollView
    private lateinit var form: LinearLayout
    private val fields = linkedMapOf<String, EditText>()
    private var status = "todo"
    private var subject = "owner"
    private var assignee = "person:owner"
    private var drafts = JSONObject()
    private var ready = false
    private var busy = false
    private var pendingAdd: JSONObject? = null
    private var editorId: String? = null
    private var editorVersion: Long = 0
    private val file by lazy { File(filesDir, "drafts/tasks.json") }
    private val arg by lazy { runCatching { JSONObject(intent.getStringExtra(EXTRA_ARG).orEmpty()) }.getOrNull() }

    override fun build(saved: Bundle?) {
        title.text = "任务"
        state = (lastNonConfigurationInstance as? TasksModel.State) ?: state
        selected = saved?.getString("task") ?: arg?.optString("id")?.takeIf { it.isNotEmpty() }
        view = if (arg?.optString("subject") == "ash") TasksModel.View.ASH else
            runCatching { TasksModel.View.valueOf(saved?.getString("view") ?: arg?.optString("view").orEmpty().uppercase()) }.getOrDefault(TasksModel.View.TODAY)
        val root = AshUi.vstack(this, 6).apply { setPadding(dp(14), 0, dp(14), dp(8)) }
        val tabs = AshUi.hstack(this, 6)
        TasksModel.View.entries.forEach { tab -> tabs.addView(AshUi.button(this, tab.label, AshUi.Kind.NEUTRAL) {
            view = tab; selected = null; editorId = null; render(); syncBack()
        }) }
        root.addView(HorizontalScrollView(this).apply { isHorizontalScrollBarEnabled = false; addView(tabs) })
        feedback = AshUi.text(this, "正在读取…", AshTokens.Type.callout, c.text2).apply {
            minLines = 2; accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            setOnClickListener { refresh() }
        }
        root.addView(feedback)
        quick = Hk.field(this, "一句话添加待办").apply { id = 0x007a1101; isEnabled = false }
        quickButton = AshUi.button(this, "添加", AshUi.Kind.PRIMARY) { addQuick() }
        root.addView(AshUi.hstack(this, 8).apply {
            addView(quick, LinearLayout.LayoutParams(0, -2, 1f)); addView(quickButton)
        })
        adapter = KeyedRowsAdapter(this)
        list = RecyclerView(this).apply {
            id = 0x007a1102; layoutManager = LinearLayoutManager(this@TasksActivity)
            adapter = this@TasksActivity.adapter; itemAnimator = null
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
            call("service:agents", "list") { data, failure ->
                if (failure == null && data != null) {
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
            call("service:tasks", "list", body) { data, failure ->
                if (!visible || generation != state.generation) return@call
                if (failure != null || data?.optJSONArray("tasks") == null) {
                    loading = false; state = state.failure(generation, failure?.message ?: "待办数据没有读完整")
                    feedback.text = "${state.problem} · 保留上次内容，点这里重试"; return@call
                }
                UiIo.decode {
                    val parsed = runCatching { val a = data.getJSONArray("tasks"); (0 until a.length()).map { parse(a.getJSONObject(it)) } }
                    UiIo.ui {
                        if (!visible || generation != state.generation) return@ui
                        if (parsed.isFailure) { loading = false; feedback.text = "待办格式有误，保留上次内容"; return@ui }
                        items.addAll(parsed.getOrThrow()); val next = data.optLong("next_before")
                        if (next > 0 && next != before) { page(next); return@ui }
                        state = state.success(generation, items.distinctBy { it.id }); loading = false
                        feedback.text = if (pendingAdd != null) "上次添加待核对，点添加继续" else "${items.size} 条待办 · 点一条修改，变化会自动更新"
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
            } else if (state.loaded) feedback.text = "没有找到这条待办，返回可看全部"
            return
        }
        title.text = "任务 · ${view.label}"
        val rows = TasksModel.rows(state.tasks, view, System.currentTimeMillis()).map { t ->
            ChatRow(t.key, listOf(t.title, t.note, t.status, t.subject, t.assignee, t.dueAt, t.remindAt, t.updatedBy, t.result, names[t.assignee]).joinToString("|")) {
                AshUi.vstack(this, 4).apply {
                    setPadding(dp(10), dp(10), dp(10), dp(10))
                    addView(AshUi.text(this@TasksActivity, t.title, AshTokens.Type.headline))
                    val meta = listOf(TasksModel.status(t), TasksModel.assignee(t, names), t.dueAt?.let { "截止 ${editTime(it)}" }, t.remindAt?.let { "提醒 ${editTime(it)}" }).filterNotNull().joinToString(" · ")
                    addView(AshUi.text(this@TasksActivity, meta, AshTokens.Type.callout, c.text2))
                    if (t.note.isNotEmpty() || t.result.isNotEmpty()) addView(AshUi.text(this@TasksActivity, t.result.ifEmpty { t.note }, AshTokens.Type.callout, c.text2))
                    if (t.updatedBy.isNotBlank()) addView(AshUi.text(this@TasksActivity, "${names[t.updatedBy] ?: t.updatedBy} 更新", AshTokens.Type.callout, c.text2))
                    minimumHeight = dp(48); isClickable = true; isFocusable = true
                    setOnClickListener { selected = t.id; editorId = null; render(); syncBack() }
                    contentDescription = "${t.title}，$meta，打开详情"
                }
            }
        }.ifEmpty { listOf(ChatRow("empty", "$view:${state.loaded}") { AshUi.text(this, if (state.loaded) "这里还没有待办" else "正在读取待办…", AshTokens.Type.body, c.text2) }) }
        val lm = list.layoutManager as LinearLayoutManager
        val first = lm.findFirstVisibleItemPosition(); val key = adapter.currentList.getOrNull(first)?.key
        val offset = lm.findViewByPosition(first)?.let { lm.getDecoratedTop(it) }
        adapter.submitList(rows) {
            val index = rows.indexOfFirst { it.key == key }
            if (index >= 0 && offset != null && selected == null) lm.scrollToPositionWithOffset(index, offset)
        }
    }
    private fun edit(task: TasksModel.Task) {
        editorId = task.id; editorVersion = task.updatedAt; title.text = "待办详情"
        form.removeAllViews(); fields.clear()
        val saved = drafts.optJSONObject(task.id)
        status = saved?.optString("status") ?: task.status; subject = saved?.optString("subject") ?: task.subject
        assignee = saved?.optString("assignee") ?: task.assignee
        fun field(key: String, label: String, value: String) {
            form.addView(AshUi.text(this, label, AshTokens.Type.callout, c.text2))
            val input = Hk.field(this, label, saved?.optString(key) ?: value)
            input.watch { saveEditor() }; fields[key] = input; form.addView(input)
        }
        field("title", "内容", task.title); field("note", "补充 / 在等谁、为什么", task.note)
        field("due_at", "截止时间（2026-10-16 20:00，可留空）", editTime(task.dueAt))
        field("remind_at", "提醒时间（${ZoneId.systemDefault().id}，可留空）", editTime(task.remindAt))
        field("result", "结果 / 不做的原因", task.result)
        form.addView(AshUi.button(this, "负责人：${names[assignee] ?: assignee}", AshUi.Kind.NEUTRAL).apply {
            setOnClickListener { assignee = agents[(agents.indexOf(assignee) + 1).mod(agents.size)]; text = "负责人：${names[assignee] ?: assignee}"; saveEditor() }
        })
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
    }
    private fun saveEditor() {
        val id = editorId ?: return
        val values = JSONObject().put("status", status).put("subject", subject).put("assignee", assignee)
        fields.forEach { (key, input) -> values.put(key, input.text.toString()) }; drafts.put(id, values); persist()
    }
    private fun saveTask(id: String) {
        if (busy || !ready) return
        val title = fields["title"]?.text.toString().trim()
        if (title.isEmpty()) { feedback.text = "内容还没填"; return }
        val body = JSONObject().put("id", id).put("title", title).put("note", fields["note"]?.text.toString()).put("subject", subject).put("assignee", assignee).put("status", status).put("result", fields["result"]?.text.toString())
        if (status == "dropped" && body.optString("result").isBlank()) { feedback.text = "写一句不做的原因，Ash 也能看到"; return }
        try { for (key in listOf("due_at", "remind_at")) body.put(key, timeValue(fields[key]?.text.toString())) }
        catch (_: Exception) { feedback.text = "时间请填完整日期和时分（2026-10-16 20:00），或清空"; return }
        busy = true; feedback.text = "正在保存…"; val draftAtSend = drafts.optJSONObject(id)?.toString()
        call("service:tasks", "update", body) { _, failure ->
            busy = false
            if (failure != null) { feedback.text = "${failure.message} · 编辑保留；刷新核对后可再保存"; return@call }
            if (drafts.optJSONObject(id)?.toString() == draftAtSend) {
                drafts.remove(id); persist()
                if (selected == id) { selected = null; editorId = null; render(); syncBack() }
            }
            feedback.text = "已保存"; refresh()
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
        persist {
            call("service:tasks", "add", body) { _, failure ->
                busy = false
                if (failure != null) { feedback.text = "${failure.message} · 草稿保留，再点添加核对同一次请求"; return@call }
                pendingAdd = null; drafts.remove("pendingAdd")
                if (quick.text.toString().trim() == body.optString("title")) { quick.setText(""); drafts.remove("quick") }
                persist(); view = TasksModel.View.WAITING; render()
                feedback.text = "记下了：${body.optString("title")} · 点待办可设提醒时间"; refresh()
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
    override fun canGoBack() = selected != null
    override fun goBack() { selected = null; editorId = null; render(); syncBack() }
    override fun onSaveInstanceState(out: Bundle) { super.onSaveInstanceState(out); out.putString("task", selected); out.putString("view", view.name) }
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
            return TasksModel.Task(o.getString("id"), o.getString("title"), o.optString("note"), o.optString("subject", "owner"), o.getString("assignee"), o.getString("status"), time("due_at"), time("remind_at"), source?.let { TasksModel.Source(it.optString("message"), it.optString("agent")) }, o.optString("result").takeUnless { it == "null" }.orEmpty(), o.optString("updated_by"), o.optLong("updated_at"))
        }
    }
}
