package ai.ash.sysapps.ash

import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.ScrollView
import android.view.Gravity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import ai.ash.R
import ai.ash.sysapps.SystemAppActivity
import ai.ash.sysapps.SystemApps
import ai.ash.sysapps.AppIdentity
import ai.ash.sysapps.AppDestination
import ai.ash.sysapps.AppAccent
import ai.ash.sysapps.AppUi
import ai.ash.ui.ChatRow
import ai.ash.ui.HomeModel
import ai.ash.ui.KeyedRowsAdapter
import ai.ash.ui.Reply
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** The primary agent's app. Business reads and writes use the same hub words as the agent. */
open class AshActivity : SystemAppActivity() {
    override val appIdentity get() = AppIdentity("Ash", R.drawable.ash_ic_heart, AppAccent.TEAL)
    private var scrollGeneration = 0
    private val queuedReads = HashMap<String, () -> Unit>()
    private val sources = HashMap<String, AshModel.ReadSlot<JSONObject>>()
    private var route = "now"
    private var connected = false
    private var primary: String? = null
    private var name = "Ash"
    private var memberNames = emptyMap<String, String>()
    private var space = "now"
    private data class Place(val route: String, val day: String?, val task: String?, val anchor: String?, val offset: Int)
    private val places = ArrayList<Place>()
    private val spacePlaces = HashMap<String, Place>()
    private var noticeStatus = ""
    private var day: String? = null
    private var taskId: String? = null
    private lateinit var list: RecyclerView
    private lateinit var rows: KeyedRowsAdapter
    private lateinit var layout: LinearLayoutManager
    private lateinit var editor: LinearLayout
    private lateinit var input: EditText
    private lateinit var formScroll: ScrollView
    private lateinit var factHeader: LinearLayout
    private lateinit var factLabel: TextView
    private lateinit var factReply: TextView
    private lateinit var factSource: TextView
    private lateinit var factDelete: TextView
    private lateinit var factComment: TextView
    private lateinit var settingsButton: View
    private lateinit var moreButton: View
    private var dockShown = false
    private var chromeSpace: String? = null
    private lateinit var editStatus: TextView
    private lateinit var save: TextView
    private lateinit var saveDock: LinearLayout
    private var editing: Edit? = null
    private var writing = false
    private var editGeneration = 0
    private val pending = HashSet<String>()
    private val feedback = HashMap<String, String>()
    private var restoreKey: String? = null
    private var restoreOffset = 0
    private data class Edit(val key: String, val title: String, val to: String, val word: String, val body: String, val field: String, val notify: String? = null)
    private val prefs by lazy { getSharedPreferences("ash-app-drafts", MODE_PRIVATE) }
    private fun s(id: Int, vararg args: Any) = getString(id, *args)
    private fun slot(key: String) = sources.getOrPut(key) { AshModel.ReadSlot() }
    private fun value(key: String) = slot(key).value
    private fun JSONArray.objects() = (0 until length()).mapNotNull { optJSONObject(it) }
    private fun JSONObject.objects(key: String) = optJSONArray(key)?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
    private fun who(by: String?) = AshModel.who(by?.takeUnless { it == "null" || it.isEmpty() }, primary, name, memberNames)

    override fun build(saved: Bundle?) {
        route = saved?.getString("route") ?: "now"
        day = saved?.getString("day"); taskId = saved?.getString("task-id")
        space = saved?.getString("space") ?: route.takeIf { it in SPACES } ?: "now"
        saved?.getString("places")?.let { raw -> runCatching { JSONArray(raw).objects().forEach { places.add(it.place()) } } }
        saved?.getString("space-places")?.let { raw -> runCatching { JSONObject(raw).let { o -> o.keys().forEach { key -> spacePlaces[key] = o.getJSONObject(key).place() } } } }
        restoreKey = saved?.getString("anchor")
        restoreOffset = saved?.getInt("offset") ?: 0
        if (saved == null) {
            val open = AshModel.openArgument(intent.getStringExtra(EXTRA_ARG))
            route = open.section; day = open.date
            space = route.takeIf { it in SPACES } ?: "now"
        }
        layout = LinearLayoutManager(this)
        rows = KeyedRowsAdapter(this)
        rows.stateRestorationPolicy = RecyclerView.Adapter.StateRestorationPolicy.PREVENT_WHEN_EMPTY
        list = RecyclerView(this).apply { layoutManager = layout; adapter = rows; clipToPadding = false
            val gap = AshUi.dp(context, AshTokens.Space.pageX)
            setPadding(gap, gap, gap, gap)
        }
        list.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) { if (recyclerView.scrollState != RecyclerView.SCROLL_STATE_IDLE) scrollGeneration++ }
        })
        editor = AshUi.vstack(this).apply { visibility = View.GONE }
        factHeader = AshUi.vstack(this, AshTokens.Space.md)
        factLabel = AshUi.text(this, s(R.string.ash_correct_directly), AshTokens.Type.sub)
        input = EditText(this).apply {
            id = R.id.ash_editor; gravity = Gravity.TOP or Gravity.START
            AshUi.style(this, AshTokens.Type.body)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            minHeight = dp(104); setPadding(dp(12), dp(12), dp(12), dp(12))
            background = AshUi.rounded(c.surface, AshUi.dpF(context, AshTokens.Radius.sm.toFloat()), c.line2, dp(1))
        }
        factReply = AshUi.text(this, "", AshTokens.Type.body)
        factSource = AshUi.button(this, "", AshUi.Kind.GHOST, block = true) { showMemoryFile() }
        factDelete = AshUi.button(this, s(R.string.ash_delete_fact), AshUi.Kind.GHOST, block = true) { editing?.let { edit ->
            val body = JSONObject(edit.body); deleteMemory(body.getString("file"), AshModel.MemoryItem(body.optString("_topic"), body.getString("_item"), 0))
        } }
        factComment = AshUi.button(this, s(R.string.ash_comment), AshUi.Kind.GHOST, block = true) { editing?.let { edit ->
            val body = JSONObject(edit.body); note("memory:${body.getString("file")}", body.getString("_item"))
        } }
        editStatus = AshUi.text(this, "", AshTokens.Type.callout)
        save = AppUi.button(this, s(R.string.ash_save), AppAccent.TEAL) { saveEdit() }
        saveDock = AshUi.vstack(this).apply {
            addView(AshViews.line(context))
            addView(AshUi.vstack(context).apply { setPadding(dp(16), dp(10), dp(16), dp(10)); addView(save) })
        }
        formScroll = ScrollView(this).apply {
            isFillViewport = false
            addView(AshUi.vstack(context, AshTokens.Space.md).apply {
                setPadding(dp(16), dp(16), dp(16), dp(24))
                addView(factHeader); addView(factLabel); addView(input, LinearLayout.LayoutParams(-1, -2))
                addView(editStatus); addView(factReply); addView(factSource); addView(factDelete)
            })
        }
        editor.addView(formScroll, LinearLayout.LayoutParams(-1, 0, 1f))

        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { editing?.let { prefs.edit().putString(it.key, s?.toString().orEmpty()).apply() } }
            override fun afterTextChanged(s: Editable?) {}
        })
        content.addView(list); content.addView(editor, android.widget.FrameLayout.LayoutParams(-1, -1))
        settingsButton = AshUi.iconButton(this, getDrawable(R.drawable.ash_ic_slider)!!, s(R.string.ash_persona_agreements)) { navigate("more") }
        moreButton = AshUi.iconButton(this, getDrawable(R.drawable.ash_ic_more)!!, s(R.string.ash_more_actions)) {
            if (editing?.let { JSONObject(it.body).has("_item") } == true) AlertDialog.Builder(this).setItems(arrayOf(s(R.string.ash_comment), s(R.string.ash_original_file, JSONObject(editing!!.body).getString("file")))) { _, which -> if (which == 0) factComment.performClick() else showMemoryFile() }.show()
            else refresh()
        }
        actions.addView(settingsButton); actions.addView(moreButton)
        setDestinations(listOf(AppDestination("now", s(R.string.ash_now_tab), R.drawable.ash_ic_heart), AppDestination("memory", s(R.string.ash_memory_tab), R.drawable.ash_ic_heart), AppDestination("diary", s(R.string.ash_diary_tab), R.drawable.ash_ic_file)), space, ::switchSpace)
        saved?.getString("edit")?.let { raw -> runCatching {
            val o = JSONObject(raw); openEdit(Edit(o.getString("key"), o.getString("title"), o.getString("to"), o.getString("word"), o.getString("body"), o.getString("field"), o.optString("notify").takeIf { it.isNotEmpty() }), "")
        } }
        draw()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val open = AshModel.openArgument(intent.getStringExtra(EXTRA_ARG))
        if (editing != null) closeEdit()
        rememberSpace(); places.clear()
        route = open.section; day = open.date; restoreKey = null
        space = route.takeIf { it in SPACES } ?: "now"
        list.scrollToPosition(0); refresh(); draw(); syncBack()
    }

    override fun onSaveInstanceState(out: Bundle) {
        out.putString("space", space)
        out.putString("places", JSONArray(places.map { it.json() }).toString())
        out.putString("space-places", JSONObject().apply { spacePlaces.forEach { (key, value) -> put(key, value.json()) } }.toString())
        out.putString("route", route); out.putString("day", day); out.putString("task-id", taskId)
        val pos = layout.findFirstVisibleItemPosition()
        rows.currentList.getOrNull(pos)?.let { out.putString("anchor", it.key); out.putInt("offset", layout.findViewByPosition(pos)?.let(layout::getDecoratedTop) ?: 0) }
        editing?.let { out.putString("edit", JSONObject().put("key", it.key).put("title", it.title).put("to", it.to).put("word", it.word).put("body", it.body).put("field", it.field).put("notify", it.notify).toString()) }
        super.onSaveInstanceState(out)
    }
    override fun canGoBack() = editing != null || day != null || route !in SPACES
    override fun goBack() {
        if (editing != null) { closeEdit(); return }
        if (places.isNotEmpty()) restore(places.removeAt(places.lastIndex))
        else { route = space; day = null; taskId = null }
        refresh(); draw(); syncBack()
    }
    private fun JSONObject.place() = Place(getString("route"), optString("day").takeIf { it.isNotEmpty() }, optString("task").takeIf { it.isNotEmpty() }, optString("anchor").takeIf { it.isNotEmpty() }, optInt("offset"))
    private fun Place.json() = JSONObject().put("route", route).put("day", day.orEmpty()).put("task", task.orEmpty()).put("anchor", anchor.orEmpty()).put("offset", offset)
    private fun place(): Place {
        val pos = layout.findFirstVisibleItemPosition()
        return Place(route, day, taskId, rows.currentList.getOrNull(pos)?.key, layout.findViewByPosition(pos)?.let(layout::getDecoratedTop) ?: 0)
    }
    private fun rememberSpace() { if (route in SPACES && day == null) spacePlaces[route] = place() }
    private fun restore(p: Place) { route = p.route; day = p.day; taskId = p.task; restoreKey = p.anchor; restoreOffset = p.offset }
    private fun switchSpace(next: String) {
        if (editing != null) closeEdit()
        rememberSpace(); places.clear(); space = next
        restore(spacePlaces[next] ?: Place(next, null, null, null, 0))
        list.scrollToPosition(0); refresh(); draw(); syncBack()
    }
    override fun onConnectionChanged(connected: Boolean) { this.connected = connected; if (::list.isInitialized) { if (connected) refresh(); draw() } }
    override fun onStop() { sources.values.forEach { it.cancel() }; queuedReads.clear(); super.onStop() }
    override fun onLedger(message: JSONObject) {
        val from = message.optString("from"); val word = message.optString("word"); val kind = message.optString("kind")
        val relevant = word in setOf("persona.changed", "task.changed", "settings.changed", "agent.changed", "agents.changed") ||
            (kind == "response" && word in setOf("workspace.write", "rules.set", "rules.revoke", "mode.set", "pulse.set")) ||
            (route == "now" && from == primary && kind in setOf("event", "response", "say"))
        if (relevant) refresh()
    }
    private fun read(key: String, to: String, word: String, body: JSONObject = JSONObject()) {
        val state = slot(key); val ticket = state.begin() ?: run { queuedReads[key] = { read(key, to, word, body) }; return }
        request(to, word, body) { r ->
            if (!state.accepts(ticket)) return@request
            val valid = r.ok && when (key) {
                "tasks" -> r.data.optJSONArray("tasks") != null
                "memory", "proactive", "identity" -> r.data.optJSONArray("files") != null
                "diary" -> r.data.optJSONArray("days") != null
                "notes" -> r.data.optJSONArray("notes") != null
                "growth" -> r.data.optJSONArray("items") != null
                else -> if (key.startsWith("task:")) r.data.optJSONObject("task") != null else true
            }
            val data = if (key == "diary" && valid && state.value != null) {
                val incoming = r.data.objects("days")
                val old = state.value!!.objects("days")
                val days = (if (body.has("before")) old + incoming else incoming + old).distinctBy { it.optString("date") }.sortedByDescending { it.optString("date") }
                JSONObject(r.data.toString()).put("days", JSONArray(days)).also { result ->
                    if (!body.has("before") && old.isNotEmpty() && old.last().optString("date") < incoming.lastOrNull()?.optString("date").orEmpty()) {
                        result.put("next_before", state.value!!.opt("next_before") ?: JSONObject.NULL)
                    }
                }
            } else r.data
            val again = state.finish(ticket, if (valid) data else null, if (valid) null else s(R.string.ash_read_failed))
            if (key == "agents" && valid) { memberNames = r.data.objects("agents").associate { it.optString("id") to it.optString("name", it.optString("id")) }; val agent = r.data.objects("agents").firstOrNull { it.optBoolean("primary") }; primary = agent?.optString("id"); name = agent?.optString("name")?.takeIf { it.isNotBlank() } ?: "Ash" }
            draw()
            if (again && connected) queuedReads.remove(key)?.invoke()
        }
    }
    protected open fun request(to: String, word: String, body: JSONObject = JSONObject(), done: (Reply) -> Unit) {
        call(to, word, body) { data, failure -> done(Reply(failure == null && data != null, data ?: JSONObject(), null, failure)) }
    }
    private fun refresh() {
        if (!connected) return
        read("agents", "service:agents", "list")
        when (route) {
            "task" -> taskId?.let { read("task:$it", AshModel.TASKS, "get", JSONObject().put("id", it)) }
            "now" -> { read("memory", AshModel.PERSONA, "memory.get"); read("growth", AshModel.PERSONA, "growth.list", JSONObject().put("limit", 10)); read("notes", AshModel.PERSONA, "notes.list", JSONObject().put("limit", 100)); read("now", "service:history", "current", JSONObject().put("limit", 40)); read("pulse", "service:pulse", "pulse.get"); read("tasks", AshModel.TASKS, "list", JSONObject().put("subject", "ash").put("status", "all").put("limit", 100)) }
            "identity" -> { read("identity", AshModel.PERSONA, "get"); listOf("SOUL.md", "IDENTITY.md").forEach { file -> read("versions:$file", AshModel.PERSONA, "versions", JSONObject().put("file", file)) } }
            "memory" -> { read("memory", AshModel.PERSONA, "memory.get"); read("notes", AshModel.PERSONA, "notes.list", JSONObject().put("limit", 100)) }
            "diary" -> if (day == null) read("diary", AshModel.PERSONA, "diary.list", JSONObject().put("limit", 60)) else read("day:$day", AshModel.PERSONA, "diary.get", JSONObject().put("date", day))
            "growth" -> read("growth", AshModel.PERSONA, "growth.list", JSONObject().put("limit", 100))
            "notes" -> read("notes", AshModel.PERSONA, "notes.list", JSONObject().put("limit", 100))
            "promises" -> { read("rules", "service:gate", "rules.list", JSONObject().put("limit", 100)); read("settings", "service:admin", "settings.get", JSONObject().put("keys", JSONArray().put(HomeModel.QUIET_KEY))); read("proactive", AshModel.PERSONA, "memory.get", JSONObject().put("file", "PROACTIVE.md")) }
        }
    }
    private fun navigate(next: String) { if (next in SPACES) { switchSpace(next); return }; places.add(place()); route = next; day = null; list.scrollToPosition(0); refresh(); draw(); syncBack() }
    private fun draw() {
        if (!::rows.isInitialized) return
        val pageTitle = editing?.title ?: when (route) { "identity" -> s(R.string.ash_identity); "memory" -> s(R.string.ash_memory); "diary" -> day ?: s(R.string.ash_diary); "growth" -> s(R.string.ash_growth); "promises" -> s(R.string.ash_promises); "notes" -> s(R.string.ash_notes); else -> name }
        showPage(pageTitle, editing != null || route !in SPACES || day != null, editing == null)
        if (chromeSpace != space) { selectDestination(space); chromeSpace = space }
        settingsButton.visibility = if (editing == null && route in SPACES && day == null) View.VISIBLE else View.GONE
        moreButton.visibility = if (settingsButton.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        val status = if (route == "now" && editing == null) value("now")?.optLong("as_of")?.takeIf { it > 0 }?.let { s(R.string.ash_recent_confirmed, HomeModel.dayTime(it, System.currentTimeMillis())) } ?: s(R.string.ash_now_unknown) else null
        setStatus(status)
        if (dockShown != (editing != null)) { dockShown = editing != null; setBottomAction(if (dockShown) saveDock else null) }
        renderEditor()
        val out = ArrayList<ChatRow>()
        fun row(key: String, heading: String, text: String = "", actionLabel: String = s(R.string.ash_open), action: (() -> Unit)? = null) {
            out.add(ChatRow(key, "$heading|$text|$actionLabel|${pending.contains(key)}|${feedback[key].orEmpty()}") {
                AshUi.card(this, AshTokens.Space.xs).apply {
                    addView(AshUi.text(context, heading, AshTokens.Type.headline))
                    if (text.isNotEmpty()) addView(AshUi.text(context, text, AshTokens.Type.body).apply { setTextIsSelectable(true) })
                    feedback[key]?.let { addView(AshUi.text(context, it, AshTokens.Type.callout)) }
                    if (action != null) addView(AshUi.button(context, actionLabel, AshUi.Kind.GHOST, block = true) { action() }.apply { isEnabled = key !in pending; minimumHeight = AshUi.dp(context, 48) })
                }
            })
        }
        fun actionRow(key: String, label: String, hint: String = "", action: () -> Unit) {
            out.add(ChatRow(key, "$label|$hint|${key in pending}|${feedback[key].orEmpty()}") {
                AshViews.region(this, AshTokens.Space.xs).apply {
                    if (hint.isNotEmpty()) addView(AshUi.text(context, hint, AshTokens.Type.body))
                    feedback[key]?.let { addView(AshUi.text(context, it, AshTokens.Type.callout)) }
                    addView(AshUi.button(context, label, AshUi.Kind.GHOST, block = true) { action() }.apply { isEnabled = key !in pending; minimumHeight = AshUi.dp(context, 48) })
                }
            })
        }
        if (noticeStatus.isNotEmpty()) row("notice", s(R.string.ash_save_result), noticeStatus)
        when (route) {
            "task" -> {
                val task = value("task:$taskId")?.optJSONObject("task")?.let { AshModel.todos(JSONObject().put("tasks", JSONArray().put(it))).firstOrNull() }
                if (task == null) row("task-loading", s(R.string.ash_loading))
                else {
                    row("promise", task.title, s(R.string.ash_promised_by, who(task.assignee)))
                    val status = when (task.status) { "waiting" -> R.string.ash_task_blocked; "done" -> R.string.ash_task_result; "dropped" -> R.string.ash_task_dropped; "doing" -> R.string.ash_task_progress; else -> R.string.ash_task_todo }
                    row("progress", s(status), if (task.status in setOf("done", "dropped")) task.result ?: task.note ?: s(R.string.ash_task_no_result) else task.note ?: s(R.string.ash_task_no_detail))
                    task.due?.let { row("due", s(R.string.ash_task_time), HomeModel.dayTime(it, System.currentTimeMillis())) }
                    actionRow("task-comment", s(R.string.ash_comment)) { note("task:${task.id}", task.title) }
                    actionRow("task-manage", s(R.string.ash_tasks_open), s(R.string.ash_task_manage_hint)) { openTasks(task.id) }
                    if (task.open) actionRow("task:${task.id}", s(R.string.ash_complete)) { mutate("task:${task.id}", AshModel.TASKS, "done", JSONObject().put("id", task.id)) }
                }
            }
            "now" -> {
                val now = AshModel.now(connected, value("now"), value("pulse"), System.currentTimeMillis())
                val confirmed = value("now")?.optLong("as_of")?.takeIf { it > 0 }
                val old = !connected || slot("now").error != null || confirmed == null || confirmed < System.currentTimeMillis() - 300_000
                val current = if (value("now") == null) s(R.string.ash_now_unknown) else if (old) s(R.string.ash_now_snapshot, AshModel.nowText(AshModel.now(true, value("now"), null, System.currentTimeMillis()), name)) else AshModel.nowText(now, name)
                val time = confirmed?.let { s(R.string.ash_recent_confirmed, HomeModel.dayTime(it, System.currentTimeMillis())) } ?: s(R.string.ash_now_unknown)
                out.add(ChatRow("profile", "$name|$current|$time") { AshViews.profile(this, name, current, listOfNotNull(time, now.nextComing?.let { s(R.string.ash_next, HomeModel.dayTime(it, System.currentTimeMillis())) }).joinToString("\n")) })
                val active = AshModel.activeTodos(AshModel.todos(value("tasks")))
                out.add(ChatRow("promises-title", active.size.toString()) { AshViews.section(this, s(R.string.ash_shared_promises), value("tasks")?.let { active.size.toString() }) })
                if (value("tasks") == null) row("tasks-loading", s(R.string.ash_loading))
                else if (active.isEmpty()) out.add(ChatRow("tasks-empty", "empty") { AshUi.text(this, s(R.string.ash_no_tasks), AshTokens.Type.body) })
                active.take(2).forEach { task -> out.add(ChatRow("task:${task.id}", "${task.title}|${task.status}|${task.assignee}|${who(task.assignee)}") {
                    AshViews.promise(this, task.title, who(task.assignee), task.assignee != null && task.assignee == primary, AshModel.statusText(task.status)) { openTasks(task.id) }
                }) }
                actionRow("all-promises", s(R.string.ash_all_promises)) { openTasks() }
                val first = AshModel.memoryFiles(value("memory")).firstNotNullOfOrNull { f -> AshModel.memoryItems(f.content).firstOrNull()?.let { f to it } }
                out.add(ChatRow("memory-title", "memory") { AshViews.section(this, s(R.string.ash_memory_space_title)) })
                if (first != null) {
                    val (file, item) = first
                    out.add(ChatRow(memoryKey(file.file, item), item.text) { AshViews.fact(this, item.section.ifBlank { memoryLabel(file.file) }, item.text) { editMemory(file.file, item) } })
                } else out.add(ChatRow("memory-empty", value("memory").toString()) { AshUi.text(this, s(if (value("memory") == null) R.string.ash_loading else R.string.ash_empty_memory), AshTokens.Type.body) })
                val growth = AshModel.growth(value("growth"))
                if (growth.isNotEmpty()) {
                    out.add(ChatRow("growth-title", "growth") { AshViews.section(this, s(R.string.ash_recent_growth)) })
                    growth.take(2).forEach { g -> out.add(ChatRow("growth:${g.id}", "${g.title}|${g.at}|${g.evidence}") {
                        AshViews.timeline(this, HomeModel.dayTime(g.at, System.currentTimeMillis()), g.title, listOf(g.why, if (g.evidence.isEmpty()) s(R.string.ash_no_evidence) else s(R.string.ash_growth_basis, g.evidence.joinToString(" · "))).filter { it.isNotBlank() }.joinToString("\n")) { navigate("growth") }
                    }) }
                }
                actionRow("persona-agreements", s(R.string.ash_persona_agreements)) { navigate("more") }
            }
            "identity" -> {
                row("identity-boundary", s(R.string.ash_identity), s(R.string.ash_persona_boundary))
                value("identity")?.objects("files")?.forEach { f ->
                    val file = f.optString("file"); val text = f.optString("content")
                    val version = AshModel.versions(value("versions:$file")).firstOrNull()
                    row("identity:$file", if (file == "SOUL.md") s(R.string.ash_soul) else s(R.string.ash_card), listOfNotNull(text, version?.let { s(R.string.ash_version, who(it.by), it.reason) }).joinToString("\n\n")) { document(file, text, true) }
                }
            }
            "memory" -> {
                out.add(ChatRow("memory-heading", "memory") { AshViews.section(this, s(R.string.ash_memory_space_title), null) })
                val files = AshModel.memoryFiles(value("memory"))
                files.forEach { file ->
                    val items = AshModel.memoryItems(file.content)
                    if (items.isEmpty()) row("memory-empty:${file.file}", s(R.string.ash_empty_memory))
                    items.forEach { item -> out.add(ChatRow(memoryKey(file.file, item), "${item.section}|${item.text}") {
                        AshViews.fact(this, item.section.ifBlank { memoryLabel(file.file) }, item.text) { editMemory(file.file, item) }
                    }) }
                }
                files.forEach { file -> actionRow("memory:${file.file}", s(R.string.ash_memory_advanced), memoryLabel(file.file)) { document(file.file, file.content, false) } }
                actionRow("all-notes", s(R.string.ash_notes)) { navigate("notes") }
            }
            "more" -> {
                listOf("identity" to R.string.ash_identity, "promises" to R.string.ash_promises, "growth" to R.string.ash_growth, "notes" to R.string.ash_notes).forEach { (id, label) -> actionRow("more:$id", s(label)) { navigate(id) } }
                actionRow("more:tasks", s(R.string.ash_all_promises)) { openTasks() }
                actionRow("more:refresh", s(R.string.ash_refresh)) { refresh() }
            }
            "diary" -> {
                if (day == null) {
                    val days = AshModel.days(value("diary"))
                    if (value("diary") != null && days.days.isEmpty()) row("empty-diary", s(R.string.ash_diary), s(R.string.ash_no_diary))
                    days.nextBefore?.let { before -> actionRow("diary-more", s(R.string.ash_more)) { read("diary", AshModel.PERSONA, "diary.list", JSONObject().put("before", before).put("limit", 60)) } }
                    days.days.forEach { d -> row("day:${d.date}", d.date, d.excerpt) { places.add(place()); day = d.date; refresh(); draw(); syncBack() } }
                } else value("day:$day")?.let { data ->
                    AshModel.diaryParts(data.optString("content")).forEachIndexed { i, part -> row("part:$i", part.title, part.lines.joinToString("\n")) }
                    actionRow("diary-note", s(R.string.ash_comment)) { note("diary:$day", day!!) }
                    AshModel.notes(data.optJSONArray("notes")).forEach { n -> row("note:${n.id}", who(n.by), listOfNotNull(n.text, n.reply?.let { s(R.string.ash_reply, it) }).joinToString("\n")) }
                }
            }
            "growth" -> {
                val growth = AshModel.growth(value("growth"))
                if (value("growth") != null && growth.isEmpty()) row("empty-growth", s(R.string.ash_growth), s(R.string.ash_no_growth))
                growth.forEach { g -> row("growth:${g.id}", g.title, listOf(s(R.string.ash_growth_why, g.why.ifBlank { s(R.string.ash_unrecorded) }), s(R.string.ash_growth_did, g.did), s(R.string.ash_growth_effect, g.effect.ifBlank { s(R.string.ash_unrecorded) }), s(R.string.ash_growth_next, g.next.ifBlank { s(R.string.ash_unrecorded) }), s(R.string.ash_recorded_at, HomeModel.dayTime(g.at, System.currentTimeMillis()), who(g.by)), if (g.evidence.isEmpty()) s(R.string.ash_growth_unverified) else "").filter { it.isNotBlank() }.joinToString("\n\n")) { growth(g) } }
            }
            "notes" -> {
                val notes = AshModel.notes(value("notes")?.optJSONArray("notes"))
                if (value("notes") != null && notes.isEmpty()) row("empty-notes", s(R.string.ash_notes), s(R.string.ash_no_notes))
                notes.forEach { n -> row("note:${n.id}", AshModel.aboutText(n.about), listOf(who(n.by), n.text, n.reply?.let { s(R.string.ash_reply, it) } ?: s(R.string.ash_no_reply)).joinToString("\n")) }
            }
            "promises" -> {
                val settings = value("settings")?.optJSONObject("settings")
                val quiet = settings?.let(HomeModel::quietOf)
                row("quiet", s(R.string.ash_quiet), quiet?.takeIf { it.isNotEmpty() } ?: if (settings == null) s(R.string.ash_loading) else s(R.string.ash_quiet_none), s(R.string.ash_edit_item)) { if (settings != null) openEdit(Edit("quiet", s(R.string.ash_quiet), "service:admin", "settings.set", "{}", HomeModel.QUIET_KEY), quiet.orEmpty()) }
                val rules = value("rules")
                row("mode", s(R.string.ash_approval), when (rules?.optString("mode")) { "auto" -> s(R.string.ash_mode_auto); "always" -> s(R.string.ash_mode_always); else -> s(R.string.ash_loading) }, s(R.string.ash_edit_item)) { if (rules != null) mode() }
                rules?.objects("rules")?.filter { (!it.has("revoked_at") || it.isNull("revoked_at")) && it.optLong("expires_at") > System.currentTimeMillis() }?.forEach { rule ->
                    val id = rule.optString("id")
                    row("rule:$id", HomeModel.actionLabel(rule.optString("word"), rule.optString("risk")), listOf(rule.optString("member"), rule.optString("object_pattern"), s(R.string.ash_applies_to, who(rule.optString("subject")))).filter { it.isNotEmpty() }.joinToString(" · "), s(R.string.ash_revoke)) {
                        AlertDialog.Builder(this).setMessage(s(R.string.ash_revoke_question)).setNegativeButton(R.string.ash_cancel, null).setPositiveButton(R.string.ash_revoke) { _, _ -> mutate("rule:$id", "service:gate", "rules.revoke", JSONObject().put("id", id)) }.show()
                    }
                }
                val proactive = AshModel.memoryFiles(value("proactive")).firstOrNull { it.file == "PROACTIVE.md" }
                row("proactive", s(R.string.ash_proactive), proactive?.content ?: s(R.string.ash_loading)) { proactive?.let { document(it.file, it.content, false) } }
            }
        }
        val keys = when(route) { "task" -> listOf("task:$taskId"); "now" -> listOf("now", "tasks", "pulse", "memory", "growth"); "identity", "memory", "growth", "notes" -> listOf(route); "diary" -> listOf(day?.let { "day:$it" } ?: "diary"); "promises" -> listOf("settings", "rules", "proactive"); else -> emptyList() }
        keys.forEach { key -> slot(key).error?.let { row("error:$key", it, s(R.string.ash_kept), s(R.string.ash_refresh)) { refresh() } } }
        if (out.isEmpty()) row("loading", s(R.string.ash_loading))
        val pos = layout.findFirstVisibleItemPosition(); val key = rows.currentList.getOrNull(pos)?.key; val offset = layout.findViewByPosition(pos)?.let(layout::getDecoratedTop) ?: 0
        val scrolling = scrollGeneration
        rows.submitList(out) {
            if (scrolling != scrollGeneration) return@submitList
            val target = restoreKey ?: key
            val index = target?.let { wanted -> out.indexOfFirst { it.key == wanted }.takeIf { it >= 0 } }
            if (index != null) layout.scrollToPositionWithOffset(index, if (restoreKey != null) restoreOffset else offset)
            if (restoreKey != null && index != null) restoreKey = null
        }
        syncBack()
    }
    private fun memoryKey(file: String, item: AshModel.MemoryItem) = "memory:$file:${item.text}:${item.occurrence}"
    private fun editMemory(file: String, item: AshModel.MemoryItem) = openEdit(Edit("item:$file:${item.text}", s(R.string.ash_correct_memory), AshModel.PERSONA, "memory.set", JSONObject().put("file", file).put("_item", item.text).put("_topic", item.section).toString(), "content", "memory:$file"), item.text)
    private fun memoryWriter() = AshMemoryWriter { word, body, done -> request(AshModel.PERSONA, word, body, done) }
    private fun deleteMemory(file: String, item: AshModel.MemoryItem) {
        val key = memoryKey(file, item)
        AlertDialog.Builder(this).setTitle(R.string.ash_delete_item).setMessage(item.text).setNegativeButton(R.string.ash_cancel, null).setPositiveButton(R.string.ash_delete_item) { _, _ ->
            if (pending.add(key)) {
                draw()
                memoryWriter().save(file, item.text, null) { result ->
                    pending.remove(key)
                    if (result.ok) {
                        if (editing?.let { JSONObject(it.body).optString("_item") == item.text && JSONObject(it.body).optString("file") == file } == true) closeEdit()
                        saveCorrection("memory:$file", s(R.string.ash_deleted_notice, item.text), s(R.string.ash_memory_saved))
                    }
                    else showNotice(if (result.retryable) s(R.string.ash_unknown) else result.failure?.message ?: s(R.string.ash_write_failed))
                    refresh(); draw()
                }
            }
        }.show()
    }
    private fun showNotice(text: String) { noticeStatus = text; draw() }
    /** The original change is already saved. This separate note write never changes that result. */
    private fun saveCorrection(about: String, text: String, saved: String, done: ((String?, String) -> Unit)? = null) {
        showNotice(saved)
        request(AshModel.PERSONA, "note", JSONObject().put("id", UUID.randomUUID().toString()).put("about", about).put("text", text)) { result ->
            val noteResult = if (result.ok) s(R.string.ash_note_saved) else if (result.retryable) s(R.string.ash_note_save_unknown) else s(R.string.ash_note_save_failed, result.failure?.message ?: s(R.string.ash_write_failed))
            showNotice("$saved；$noteResult")
            done?.invoke(if (result.ok) result.data.optString("id").takeIf { it.isNotEmpty() } else null, "$saved；$noteResult")
            refresh()
        }
    }

    private fun JSONObject.removeNote() = apply { remove("_note") }
    private fun renderEditor() {
        val edit = editing ?: return
        val body = JSONObject(edit.body)
        val item = body.optString("_item").takeIf { body.has("_item") }
        val fact = item != null
        factHeader.visibility = if (fact) View.VISIBLE else View.GONE
        listOf(factLabel, factReply, factSource, factDelete, factComment).forEach { it.visibility = if (fact) View.VISIBLE else View.GONE }
        save.text = s(if (fact) R.string.ash_save_correction else R.string.ash_save)
        if (!fact) return
        val signature = "${body.optString("file")}|${body.optString("_topic")}|$item"
        if (factHeader.tag != signature) {
            factHeader.tag = signature; factHeader.removeAllViews()
            factHeader.addView(AshUi.text(this, s(R.string.ash_fact_context, body.getString("file")), AshTokens.Type.sub))
            factHeader.addView(AshUi.text(this, body.optString("_topic").ifBlank { s(R.string.ash_correct_memory) }, AshTokens.Type.title))
            factHeader.addView(AshViews.fact(this, s(R.string.ash_current_record), item!!))
            factHeader.addView(AshUi.text(this, s(R.string.ash_fact_no_source), AshTokens.Type.sub))
        }
        factSource.text = s(R.string.ash_original_file, body.getString("file"))
        // Only an actual note id connects a reply to this correction. This is object identity, not delivery tracking.
        val note = body.optString("_note").takeIf { it.isNotEmpty() }?.let { id -> AshModel.notes(value("notes")?.optJSONArray("notes")).firstOrNull { it.id == id } }
        factReply.text = note?.reply?.let { s(R.string.ash_reply, it) } ?: if (body.has("_note")) s(R.string.ash_saved_no_reply) else ""
        factReply.visibility = if (factReply.text.isEmpty()) View.GONE else View.VISIBLE
    }
    private fun showMemoryFile() {
        val file = editing?.let { JSONObject(it.body).optString("file") }?.takeIf { it.isNotEmpty() } ?: return
        val generation = editGeneration
        request(AshModel.PERSONA, "memory.get", JSONObject().put("file", file)) { reply ->
            if (generation != editGeneration) return@request
            if (!reply.ok) { editStatus.text = reply.failure?.message ?: s(R.string.ash_read_failed); return@request }
            val original = reply.data.objects("files").firstOrNull { it.optString("file") == file }
            if (original == null || !original.has("content") || original.optBoolean("truncated")) { editStatus.text = s(R.string.ash_original_incomplete); return@request }
            AlertDialog.Builder(this).setTitle(s(R.string.ash_original_file, file)).setMessage(original.getString("content")).setPositiveButton(R.string.ash_cancel, null).show()
        }
    }

    private fun memoryLabel(file: String) = s(when(file) { "USER.md" -> R.string.ash_about_you; "MEMORY.md" -> R.string.ash_my_notes; else -> R.string.ash_proactive })
    private fun document(file: String, text: String, identity: Boolean) {
        AlertDialog.Builder(this).setTitle(if (identity) s(R.string.ash_identity) else memoryLabel(file)).setItems(arrayOf(s(R.string.ash_edit), s(R.string.ash_comment))) { _, which ->
            val about = "${if (identity) "identity" else "memory"}:$file"
            if (which == 1) note(about, if (identity) s(R.string.ash_identity) else memoryLabel(file)) else openEdit(Edit("doc:$file", if (identity) s(R.string.ash_identity) else memoryLabel(file), AshModel.PERSONA, if (identity) "propose" else "memory.set", JSONObject().put("file", file).put("reason", s(R.string.ash_owner_edit)).toString(), "content", about), text)
        }.show()
    }
    private fun note(about: String, label: String) = openEdit(Edit("note:$about:$label", s(R.string.ash_note_on, label), AshModel.PERSONA, "note", JSONObject().put("about", about).toString(), "text"), if (about.startsWith("memory:") && label != memoryLabel(about.removePrefix("memory:"))) s(R.string.ash_note_item, label) else "")
    private fun openEdit(edit: Edit, text: String) {
        editGeneration++; writing = false
        editing = edit
        input.setText(prefs.getString(edit.key, text)); input.isEnabled = true
        list.visibility = View.GONE; editor.visibility = View.VISIBLE; save.isEnabled = true
        editStatus.text = s(R.string.ash_draft_hint); formScroll.scrollTo(0, 0); draw(); syncBack()
    }
    private fun closeEdit() {
        currentFocus?.let { getSystemService(android.view.inputmethod.InputMethodManager::class.java)?.hideSoftInputFromWindow(it.windowToken, 0); it.clearFocus() }
        editGeneration++; writing = false
        editing = null; editor.visibility = View.GONE; list.visibility = View.VISIBLE; draw(); syncBack()
    }
    private fun saveEdit() {
        val edit = editing ?: return
        if (writing || !connected) { editStatus.text = s(R.string.ash_offline); return }
        val text = input.text.toString()
        if ((edit.word != "memory.set" && edit.word != "settings.set" && text.isBlank()) || (edit.word == "settings.set" && text.isNotEmpty() && !HomeModel.QUIET_FORMAT.matches(text))) { editStatus.text = s(R.string.ash_invalid); return }
        if (edit.word == "memory.set" && JSONObject(edit.body).has("_item") && text.isBlank()) { editStatus.text = s(R.string.ash_item_empty); return }
        if (edit.word == "note" && text.length > 4000) { editStatus.text = s(R.string.ash_note_long); return }
        val body = JSONObject(edit.body).put(edit.field, text)
        if (edit.word == "note") {
            val previous = runCatching { JSONObject(prefs.getString("operation:${edit.key}", "{}")!!) }.getOrDefault(JSONObject())
            val id = if (previous.optString("text") == text) previous.optString("id") else UUID.randomUUID().toString()
            body.put("id", id)
            prefs.edit().putString("operation:${edit.key}", JSONObject().put("text", text).put("id", id).toString()).apply()
        }
        val generation = editGeneration
        writing = true; input.isEnabled = false; save.isEnabled = false; editStatus.text = s(R.string.ash_saving)
        val complete: (Reply) -> Unit = done@{ r ->
            if (generation != editGeneration) return@done
            writing = false; input.isEnabled = true
            if (r.ok) {
                prefs.edit().remove(edit.key).remove("operation:${edit.key}").apply()
                val itemEdit = edit.word == "memory.set" && body.has("_item")
                if (itemEdit) {
                    val current = JSONObject(edit.body).put("_item", text).removeNote()
                    editing = edit.copy(key = "item:${body.getString("file")}:$text", body = current.toString())
                    save.isEnabled = true
                    editStatus.text = s(R.string.ash_memory_saved)
                    saveCorrection(edit.notify!!, s(R.string.ash_replaced_notice, body.getString("_item"), text), s(R.string.ash_memory_saved)) { noteId, result ->
                        if (generation == editGeneration && editing?.key == "item:${body.getString("file")}:$text") {
                            if (noteId != null) editing = editing!!.copy(body = JSONObject(editing!!.body).put("_note", noteId).toString())
                            editStatus.text = result; renderEditor()
                        }
                    }
                    renderEditor()
                } else {
                    closeEdit()
                    if (edit.word == "note") showNotice(s(R.string.ash_note_saved))
                    else if (edit.notify != null) saveCorrection(edit.notify, s(R.string.ash_edit_notice), s(if (edit.word == "memory.set") R.string.ash_memory_saved else if (edit.word == "propose") R.string.ash_persona_saved else R.string.ash_saved))
                    else showNotice(s(R.string.ash_saved))
                }
                refresh()
            } else { save.isEnabled = !r.retryable; editStatus.text = if (r.retryable) s(R.string.ash_unknown) else r.failure?.message ?: s(R.string.ash_write_failed) }
        }
        if (edit.word == "memory.set") memoryWriter().save(body.getString("file"), body.optString("_item").takeIf { body.has("_item") }, text, complete)
        else request(edit.to, edit.word, body, complete)
    }
    private fun mutate(key: String, to: String, word: String, body: JSONObject) {
        if (!pending.add(key)) return
        feedback[key] = s(R.string.ash_saving); draw()
        request(to, word, body) { r ->
            if (!r.retryable) pending.remove(key)
            feedback[key] = if (r.ok) s(R.string.ash_saved) else if (r.retryable) s(R.string.ash_unknown) else s(R.string.ash_write_failed)
            refresh(); draw()
        }
    }
    private fun task(task: AshModel.Todo) { places.add(place()); taskId = task.id; route = "task"; list.scrollToPosition(0); refresh(); draw(); syncBack() }
    private fun growth(g: AshModel.Growth) {
        AlertDialog.Builder(this).setTitle(g.title).setMessage(g.evidence.joinToString("\n").ifEmpty { s(R.string.ash_no_evidence) }).setPositiveButton(R.string.ash_comment) { _, _ -> note("growth:${g.id}", g.title) }.setNegativeButton(R.string.ash_cancel, null).show()
    }
    private fun mode() {
        AlertDialog.Builder(this).setTitle(R.string.ash_approval).setItems(arrayOf(s(R.string.ash_mode_auto), s(R.string.ash_mode_always))) { _, which -> mutate("mode", "service:gate", "mode.set", JSONObject().put("mode", if (which == 0) "auto" else "always")) }.show()
    }
    private fun openTasks(id: String? = null) {
        startActivity(SystemApps.intent(this, "tasks", JSONObject().put("subject", "ash").also { if (id != null) it.put("id", id) }.toString()))
    }
    companion object { private val SPACES = setOf("now", "memory", "diary") }

}
