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
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import ai.ash.R
import ai.ash.sysapps.SystemAppActivity
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
class AshActivity : SystemAppActivity() {
    private val sources = HashMap<String, AshModel.ReadSlot<JSONObject>>()
    private var route = "now"
    private var connected = false
    private var primary: String? = null
    private var name = "Ash"
    private var day: String? = null
    private lateinit var list: RecyclerView
    private lateinit var rows: KeyedRowsAdapter
    private lateinit var layout: LinearLayoutManager
    private lateinit var editor: LinearLayout
    private lateinit var input: EditText
    private lateinit var editStatus: TextView
    private lateinit var save: TextView
    private var editing: Edit? = null
    private var writing = false
    private val pending = HashSet<String>()
    private val feedback = HashMap<String, String>()
    private var restoreKey: String? = null
    private var restoreOffset = 0
    private data class Edit(val key: String, val title: String, val to: String, val word: String, val body: String, val field: String, val notify: String? = null)
    private val prefs by lazy { getSharedPreferences("ash-app-drafts", MODE_PRIVATE) }
    private fun s(id: Int, vararg args: Any) = getString(id, *args)
    private fun slot(key: String) = sources.getOrPut(key) { AshModel.ReadSlot() }
    private fun value(key: String) = slot(key).value
    private fun JSONObject.objects(key: String) = optJSONArray(key)?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) } }.orEmpty()
    private fun who(by: String?) = AshModel.who(by?.takeUnless { it == "null" || it.isEmpty() }, primary, name)

    override fun build(saved: Bundle?) {
        route = saved?.getString("route") ?: "now"
        day = saved?.getString("day")
        restoreKey = saved?.getString("anchor")
        restoreOffset = saved?.getInt("offset") ?: 0
        val arg = runCatching { JSONObject(intent.getStringExtra(EXTRA_ARG) ?: "{}") }.getOrNull()
        if (saved == null) {
            route = arg?.optString("section")?.takeIf { it in setOf("now", "identity", "memory", "diary", "growth", "promises", "notes") } ?: "now"
            day = arg?.optString("date")?.takeIf { Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}").matches(it) }
        }
        layout = LinearLayoutManager(this)
        rows = KeyedRowsAdapter(this)
        rows.stateRestorationPolicy = RecyclerView.Adapter.StateRestorationPolicy.PREVENT_WHEN_EMPTY
        list = RecyclerView(this).apply { layoutManager = layout; adapter = rows; clipToPadding = false
            val gap = AshUi.dp(context, AshTokens.Space.pageX)
            setPadding(gap, gap, gap, gap)
        }
        editor = AshUi.vstack(this, AshTokens.Space.sm).apply { visibility = View.GONE
            val gap = AshUi.dp(context, AshTokens.Space.pageX); setPadding(gap, gap, gap, gap)
        }
        input = EditText(this).apply { id = View.generateViewId(); gravity = android.view.Gravity.TOP or android.view.Gravity.START
            setTextColor(AshUi.p(context).text); setHintTextColor(AshUi.p(context).text3)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE or android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            minimumHeight = AshUi.dp(context, 48)
        }
        editStatus = AshUi.text(this, "", AshTokens.Type.callout)
        save = AshUi.button(this, s(R.string.ash_save), AshUi.Kind.PRIMARY, block = true) { saveEdit() }
        editor.addView(input, LinearLayout.LayoutParams(-1, 0, 1f)); editor.addView(editStatus); editor.addView(save)
        input.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { editing?.let { prefs.edit().putString(it.key, s?.toString().orEmpty()).apply() } }
            override fun afterTextChanged(s: Editable?) {}
        })
        content.addView(list); content.addView(editor, android.widget.FrameLayout.LayoutParams(-1, -1))
        actions.addView(AshUi.button(this, s(R.string.ash_refresh), AshUi.Kind.GHOST) { refresh() })
        saved?.getString("edit")?.let { raw -> runCatching {
            val o = JSONObject(raw); openEdit(Edit(o.getString("key"), o.getString("title"), o.getString("to"), o.getString("word"), o.getString("body"), o.getString("field"), o.optString("notify").takeIf { it.isNotEmpty() }), "")
        } }
        draw()
    }

    override fun onSaveInstanceState(out: Bundle) {
        out.putString("route", route); out.putString("day", day)
        val pos = layout.findFirstVisibleItemPosition()
        rows.currentList.getOrNull(pos)?.let { out.putString("anchor", it.key); out.putInt("offset", layout.findViewByPosition(pos)?.let(layout::getDecoratedTop) ?: 0) }
        editing?.let { out.putString("edit", JSONObject().put("key", it.key).put("title", it.title).put("to", it.to).put("word", it.word).put("body", it.body).put("field", it.field).put("notify", it.notify).toString()) }
        super.onSaveInstanceState(out)
    }
    override fun canGoBack() = editing != null || day != null || route != "now"
    override fun goBack() {
        if (editing != null) { closeEdit(); return }
        if (day != null) day = null else route = "now"
        refresh(); draw(); syncBack()
    }
    override fun onConnectionChanged(connected: Boolean) { this.connected = connected; if (::list.isInitialized) { if (connected) refresh(); draw() } }
    override fun onStop() { sources.values.forEach { it.cancel() }; super.onStop() }
    override fun onLedger(message: JSONObject) {
        val from = message.optString("from"); val word = message.optString("word"); val kind = message.optString("kind")
        val relevant = word in setOf("persona.changed", "task.changed", "settings.changed", "agent.changed", "agents.changed") ||
            (kind == "response" && word in setOf("workspace.write", "rules.set", "rules.revoke", "mode.set", "pulse.set")) ||
            (route == "now" && from == primary && kind in setOf("event", "response", "say"))
        if (relevant) refresh()
    }
    private fun read(key: String, to: String, word: String, body: JSONObject = JSONObject()) {
        val state = slot(key); val ticket = state.begin() ?: return
        call(to, word, body) { r ->
            val valid = r.ok && when (key) {
                "tasks" -> r.data.optJSONArray("tasks") != null
                "memory", "identity" -> r.data.optJSONArray("files") != null
                "diary" -> r.data.optJSONArray("days") != null
                "notes" -> r.data.optJSONArray("notes") != null
                "growth" -> r.data.optJSONArray("items") != null
                else -> true
            }
            val again = state.finish(ticket, if (valid) r.data else null, if (valid) null else s(R.string.ash_read_failed))
            if (key == "agents" && valid) { val agent = r.data.objects("agents").firstOrNull { it.optBoolean("primary") }; primary = agent?.optString("id"); name = agent?.optString("name")?.takeIf { it.isNotBlank() } ?: "Ash" }
            draw()
            if (again && connected) read(key, to, word, body)
        }
    }
    private fun refresh() {
        if (!connected) return
        read("agents", "service:agents", "list")
        when (route) {
            "now" -> { read("now", "service:history", "current", JSONObject().put("limit", 40)); read("pulse", "service:pulse", "pulse.get"); read("tasks", AshModel.TASKS, "list", JSONObject().put("subject", "ash").put("status", "all").put("limit", 100)) }
            "identity" -> read("identity", AshModel.PERSONA, "get")
            "memory" -> read("memory", AshModel.PERSONA, "memory.get")
            "diary" -> if (day == null) read("diary", AshModel.PERSONA, "diary.list", JSONObject().put("limit", 60)) else read("day:$day", AshModel.PERSONA, "diary.get", JSONObject().put("date", day))
            "growth" -> read("growth", AshModel.PERSONA, "growth.list", JSONObject().put("limit", 100))
            "notes" -> read("notes", AshModel.PERSONA, "notes.list", JSONObject().put("limit", 100))
            "promises" -> { read("rules", "service:gate", "rules.list", JSONObject().put("limit", 100)); read("settings", "service:admin", "settings.get", JSONObject().put("keys", JSONArray().put(HomeModel.QUIET_KEY))); read("memory", AshModel.PERSONA, "memory.get", JSONObject().put("file", "PROACTIVE.md")) }
        }
    }
    private fun navigate(next: String) { route = next; day = null; list.scrollToPosition(0); refresh(); draw(); syncBack() }
    private fun draw() {
        if (!::rows.isInitialized) return
        title.text = editing?.title ?: when (route) { "identity" -> s(R.string.ash_identity); "memory" -> s(R.string.ash_memory); "diary" -> day ?: s(R.string.ash_diary); "growth" -> s(R.string.ash_growth); "promises" -> s(R.string.ash_promises); "notes" -> s(R.string.ash_notes); else -> name }
        val out = ArrayList<ChatRow>()
        fun row(key: String, heading: String, text: String = "", action: (() -> Unit)? = null) {
            out.add(ChatRow(key, "$heading|$text|${pending.contains(key)}|${feedback[key].orEmpty()}") {
                AshUi.card(this, AshTokens.Space.xs).apply {
                    addView(AshUi.text(context, heading, AshTokens.Type.headline))
                    if (text.isNotEmpty()) addView(AshUi.text(context, text, AshTokens.Type.body).apply { setTextIsSelectable(true) })
                    feedback[key]?.let { addView(AshUi.text(context, it, AshTokens.Type.callout)) }
                    if (action != null) addView(AshUi.button(context, s(R.string.ash_open), AshUi.Kind.GHOST, block = true) { action() }.apply { isEnabled = key !in pending; minimumHeight = AshUi.dp(context, 48) })
                }
            })
        }
        when (route) {
            "now" -> {
                val now = AshModel.now(connected, value("now"), value("pulse"), System.currentTimeMillis())
                val rhythm = now.nextComing?.let { s(R.string.ash_next, HomeModel.dayTime(it, System.currentTimeMillis())) }.orEmpty()
                row("now", s(R.string.ash_now), listOf(AshModel.nowText(now, name), if (now.waitingYou > 0) s(R.string.ash_waiting, now.waitingYou) else "", rhythm).filter { it.isNotEmpty() }.joinToString("\n")) { note("now", s(R.string.ash_now)) }
                val tasks = AshModel.todos(value("tasks")); val active = AshModel.activeTodos(tasks)
                if (value("tasks") == null) row("tasks-loading", s(R.string.ash_tasks), s(R.string.ash_loading))
                else if (active.isEmpty()) row("tasks-empty", s(R.string.ash_tasks), s(R.string.ash_no_tasks))
                active.forEach { task ->
                    val meta = listOf(AshModel.statusText(task.status), task.due?.let { HomeModel.dayTime(it, System.currentTimeMillis()) }, task.assignee?.let { who(it) }, task.updatedBy?.let { s(R.string.ash_changed_by, who(it)) }).filterNotNull().joinToString(" · ")
                    row("task:${task.id}", task.title, meta) { task(task) }
                }
                row("closed", s(R.string.ash_closed), s(R.string.ash_closed_count, tasks.count { !it.open })) { openTasks() }
                listOf("identity" to R.string.ash_identity, "memory" to R.string.ash_memory, "diary" to R.string.ash_diary, "growth" to R.string.ash_growth, "promises" to R.string.ash_promises, "notes" to R.string.ash_notes).forEach { (id, label) -> row("nav:$id", s(label)) { navigate(id) } }
            }
            "identity" -> value("identity")?.objects("files")?.forEach { f ->
                val file = f.optString("file"); val text = f.optString("content")
                row("identity:$file", if (file == "SOUL.md") s(R.string.ash_soul) else s(R.string.ash_card), text) { document(file, text, true) }
            }
            "memory" -> AshModel.memoryFiles(value("memory")).forEach { f -> row("memory:${f.file}", memoryLabel(f.file), if (f.missing) s(R.string.ash_empty_memory) else f.content) { document(f.file, f.content, false) } }
            "diary" -> {
                if (day == null) {
                    val days = AshModel.days(value("diary"))
                    if (value("diary") != null && days.days.isEmpty()) row("empty-diary", s(R.string.ash_diary), s(R.string.ash_no_diary))
                    days.days.forEach { d -> row("day:${d.date}", d.date, d.excerpt) { day = d.date; refresh(); draw(); syncBack() } }
                } else value("day:$day")?.let { data ->
                    AshModel.diaryParts(data.optString("content")).forEachIndexed { i, part -> row("part:$i", part.title, part.lines.joinToString("\n")) }
                    row("diary-note", s(R.string.ash_comment)) { note("diary:$day", day!!) }
                    AshModel.notes(data.optJSONArray("notes")).forEach { n -> row("note:${n.id}", who(n.by), listOfNotNull(n.text, n.reply?.let { s(R.string.ash_reply, it) }).joinToString("\n")) }
                }
            }
            "growth" -> {
                val growth = AshModel.growth(value("growth"))
                if (value("growth") != null && growth.isEmpty()) row("empty-growth", s(R.string.ash_growth), s(R.string.ash_no_growth))
                growth.forEach { g -> row("growth:${g.id}", g.title, listOf(g.why, g.did, g.effect, g.next, s(R.string.ash_changed_by, who(g.by))).filter { it.isNotBlank() }.joinToString("\n\n")) { growth(g) } }
            }
            "notes" -> {
                val notes = AshModel.notes(value("notes")?.optJSONArray("notes"))
                if (value("notes") != null && notes.isEmpty()) row("empty-notes", s(R.string.ash_notes), s(R.string.ash_no_notes))
                notes.forEach { n -> row("note:${n.id}", AshModel.aboutText(n.about), listOf(who(n.by), n.text, n.reply?.let { s(R.string.ash_reply, it) } ?: s(R.string.ash_no_reply)).joinToString("\n")) }
            }
            "promises" -> {
                val settings = value("settings")?.optJSONObject("settings")
                val quiet = settings?.let(HomeModel::quietOf)
                row("quiet", s(R.string.ash_quiet), quiet?.takeIf { it.isNotEmpty() } ?: if (settings == null) s(R.string.ash_loading) else s(R.string.ash_quiet_none)) { if (settings != null) openEdit(Edit("quiet", s(R.string.ash_quiet), "service:admin", "settings.set", "{}", HomeModel.QUIET_KEY), quiet.orEmpty()) }
                val rules = value("rules")
                row("mode", s(R.string.ash_approval), when (rules?.optString("mode")) { "auto" -> s(R.string.ash_mode_auto); "always" -> s(R.string.ash_mode_always); else -> s(R.string.ash_loading) }) { if (rules != null) mode() }
                rules?.objects("rules")?.filter { it.isNull("revoked_at") && it.optLong("expires_at") > System.currentTimeMillis() }?.forEach { rule ->
                    val id = rule.optString("id")
                    row("rule:$id", HomeModel.actionLabel(rule.optString("word"), rule.optString("risk")), listOf(rule.optString("member"), rule.optString("object_pattern"), s(R.string.ash_changed_by, who(rule.optString("created_by")))).filter { it.isNotEmpty() }.joinToString(" · ")) {
                        AlertDialog.Builder(this).setMessage(s(R.string.ash_revoke_question)).setNegativeButton(R.string.ash_cancel, null).setPositiveButton(R.string.ash_revoke) { _, _ -> mutate("rule:$id", "service:gate", "rules.revoke", JSONObject().put("id", id)) }.show()
                    }
                }
                val proactive = AshModel.memoryFiles(value("memory")).firstOrNull { it.file == "PROACTIVE.md" }
                row("proactive", s(R.string.ash_proactive), proactive?.content ?: s(R.string.ash_loading)) { proactive?.let { document(it.file, it.content, false) } }
            }
        }
        val keys = when(route) { "now" -> listOf("now", "tasks", "pulse"); "identity", "memory", "growth", "notes" -> listOf(route); "diary" -> listOf(day?.let { "day:$it" } ?: "diary"); else -> listOf("settings", "rules", "memory") }
        keys.forEach { key -> slot(key).error?.let { row("error:$key", it, s(R.string.ash_kept)) { refresh() } } }
        if (out.isEmpty()) row("loading", s(R.string.ash_loading))
        val pos = layout.findFirstVisibleItemPosition(); val key = rows.currentList.getOrNull(pos)?.key; val offset = layout.findViewByPosition(pos)?.let(layout::getDecoratedTop) ?: 0
        rows.submitList(out) {
            val target = restoreKey ?: key
            val index = target?.let { wanted -> out.indexOfFirst { it.key == wanted }.takeIf { it >= 0 } }
            if (index != null) layout.scrollToPositionWithOffset(index, if (restoreKey != null) restoreOffset else offset)
            if (restoreKey != null && index != null) restoreKey = null
        }
        syncBack()
    }
    private fun memoryLabel(file: String) = s(when(file) { "USER.md" -> R.string.ash_about_you; "MEMORY.md" -> R.string.ash_my_notes; else -> R.string.ash_proactive })
    private fun document(file: String, text: String, identity: Boolean) {
        AlertDialog.Builder(this).setTitle(if (identity) s(R.string.ash_identity) else memoryLabel(file)).setItems(arrayOf(s(R.string.ash_edit), s(R.string.ash_comment))) { _, which ->
            val about = "${if (identity) "identity" else "memory"}:$file"
            if (which == 1) note(about, if (identity) s(R.string.ash_identity) else memoryLabel(file)) else openEdit(Edit("doc:$file", if (identity) s(R.string.ash_identity) else memoryLabel(file), AshModel.PERSONA, if (identity) "propose" else "memory.set", JSONObject().put("file", file).put("reason", s(R.string.ash_owner_edit)).toString(), "content", about), text)
        }.show()
    }
    private fun note(about: String, label: String) = openEdit(Edit("note:$about", s(R.string.ash_note_on, label), AshModel.PERSONA, "note", JSONObject().put("about", about).toString(), "text"), "")
    private fun openEdit(edit: Edit, text: String) {
        editing = edit
        input.setText(prefs.getString(edit.key, text)); input.isEnabled = true
        list.visibility = View.GONE; editor.visibility = View.VISIBLE; save.isEnabled = true
        editStatus.text = s(R.string.ash_draft_hint); draw(); syncBack()
    }
    private fun closeEdit() {
        currentFocus?.let { getSystemService(android.view.inputmethod.InputMethodManager::class.java)?.hideSoftInputFromWindow(it.windowToken, 0); it.clearFocus() }
        editing = null; editor.visibility = View.GONE; list.visibility = View.VISIBLE; draw(); syncBack()
    }
    private fun saveEdit() {
        val edit = editing ?: return
        if (writing || !connected) { editStatus.text = s(R.string.ash_offline); return }
        val text = input.text.toString()
        if ((edit.word != "memory.set" && edit.word != "settings.set" && text.isBlank()) || (edit.word == "settings.set" && text.isNotEmpty() && !HomeModel.QUIET_FORMAT.matches(text))) { editStatus.text = s(R.string.ash_invalid); return }
        if (edit.word == "note" && text.length > 4000) { editStatus.text = s(R.string.ash_note_long); return }
        val body = JSONObject(edit.body).put(edit.field, text)
        writing = true; input.isEnabled = false; save.isEnabled = false; editStatus.text = s(R.string.ash_saving)
        call(edit.to, edit.word, body) { r ->
            writing = false
            if (editing != edit) return@call
            input.isEnabled = true
            if (r.ok) {
                prefs.edit().remove(edit.key).apply()
                if (edit.notify != null) call(AshModel.PERSONA, "note", JSONObject().put("about", edit.notify).put("text", s(R.string.ash_edit_notice))) { notice -> feedback[edit.notify] = if (notice.ok && notice.data.optBoolean("told")) s(R.string.ash_saved) else s(R.string.ash_saved_notice_failed); draw() }
                closeEdit(); refresh()
            } else { save.isEnabled = !r.retryable; editStatus.text = if (r.retryable) s(R.string.ash_unknown) else s(R.string.ash_write_failed) }
        }
    }
    private fun mutate(key: String, to: String, word: String, body: JSONObject) {
        if (!pending.add(key)) return
        feedback[key] = s(R.string.ash_saving); draw()
        call(to, word, body) { r ->
            if (!r.retryable) pending.remove(key)
            feedback[key] = if (r.ok) s(R.string.ash_saved) else if (r.retryable) s(R.string.ash_unknown) else s(R.string.ash_write_failed)
            refresh(); draw()
        }
    }
    private fun task(task: AshModel.Todo) {
        AlertDialog.Builder(this).setTitle(task.title).setMessage(listOfNotNull(task.source, task.assignee?.let { who(it) }).joinToString("\n"))
            .setItems(arrayOf(s(R.string.ash_complete), s(R.string.ash_comment), s(R.string.ash_tasks_open))) { _, which ->
                when(which) { 0 -> mutate("task:${task.id}", AshModel.TASKS, "done", JSONObject().put("id", task.id)); 1 -> note("task:${task.id}", task.title); else -> openTasks() }
            }.setNegativeButton(R.string.ash_cancel, null).show()
    }
    private fun growth(g: AshModel.Growth) {
        AlertDialog.Builder(this).setTitle(g.title).setMessage(g.evidence.joinToString("\n").ifEmpty { s(R.string.ash_no_evidence) }).setPositiveButton(R.string.ash_comment) { _, _ -> note("growth:${g.id}", g.title) }.setNegativeButton(R.string.ash_cancel, null).show()
    }
    private fun mode() {
        AlertDialog.Builder(this).setTitle(R.string.ash_approval).setItems(arrayOf(s(R.string.ash_mode_auto), s(R.string.ash_mode_always))) { _, which -> mutate("mode", "service:gate", "mode.set", JSONObject().put("mode", if (which == 0) "auto" else "always")) }.show()
    }
    private fun openTasks() {
        startActivity(Intent().setClassName(packageName, "ai.ash.sysapps.tasks.TasksActivity").putExtra(EXTRA_ARG, JSONObject().put("subject", "ash").toString()))
    }
}
