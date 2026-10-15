package ai.ash.sysapps.devices

import ai.ash.R
import ai.ash.link.Link
import ai.ash.sysapps.SystemAppActivity
import ai.ash.ui.ChatRow
import ai.ash.ui.KeyedRowsAdapter
import ai.ash.ui.HumanPort
import ai.ash.ui.UiIo
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi
import android.app.AlertDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import org.json.JSONObject

/** Device app, APPS-R1 §1; MOBILE-ARCH §2–3, §5–6. All business actions use the hub. */
class DevicesActivity : SystemAppActivity() {
    private val model = DevicesState()
    private val pair = PairFlow()
    private lateinit var list: RecyclerView
    private lateinit var rows: KeyedRowsAdapter
    private var route = ""
    private var routeGeneration = 0
    private var active = false
    private var detail: Detail? = null
    private var pairing: Pairing? = null
    private val reading = HashSet<Refresh>()
    private val dirty = HashSet<Refresh>()
    private var reconcileDetail: Detail? = null
    private var readingPair = false
    private var pairDirty = false
    private var primary: String? = null
    private var note = ""
    private val handler = Handler(Looper.getMainLooper())
    private val clock = object : Runnable {
        override fun run() { if (active) { pairing?.tick(); handler.postDelayed(this, 1000) } }
    }
    private val prefs by lazy { getSharedPreferences("devices.ui", MODE_PRIVATE) }

    override fun build(saved: Bundle?) {
        route = saved?.getString("route") ?: routeOf(intent.getStringExtra(EXTRA_ARG))
        model.showRevoked = saved?.getBoolean("revoked") ?: false
        (saved?.getString("pair") ?: route.takeIf { it.startsWith("p/") }?.removePrefix("p/"))?.let(pair::resume)
        list = RecyclerView(this).apply {
            layoutManager = LinearLayoutManager(this@DevicesActivity)
            setPadding(dp(AshTokens.Space.pageX), 0, dp(AshTokens.Space.pageX), 0)
            clipToPadding = false
        }
        rows = KeyedRowsAdapter(this).apply { stateRestorationPolicy = RecyclerView.Adapter.StateRestorationPolicy.PREVENT_WHEN_EMPTY }
        list.adapter = rows
        showRoute(route)
    }

    override fun onStart() {
        super.onStart(); active = true
        Refresh.entries.forEach(::read)
        readPair()
        call("service:agents", "list") { data, _ ->
            val all = data?.optJSONArray("agents")
            primary = (0 until (all?.length() ?: 0)).mapNotNull { all?.optJSONObject(it) }.firstOrNull { it.optBoolean("primary") }?.optString("id")
            render()
        }
        handler.post(clock)
    }
    override fun onStop() { active = false; handler.removeCallbacks(clock); super.onStop() }
    override fun onConnectionChanged(connected: Boolean) {
        if (connected && active) { Refresh.entries.forEach(::read); readPair() }
    }
    override fun onLedger(message: JSONObject) {
        model.heard(message)
        if (message.optString("to") == "service:devices" && message.optString("word") == "pair.changed") {
            // Read authoritative status for the name; pair.changed intentionally carries no name.
            if (message.optJSONObject("body")?.optString("pair_id") == pair.pairId) readPair()
        }
        Refresh.of(message).forEach(::read)
        render()
    }
    override fun canGoBack() = route.isNotEmpty()
    override fun goBack() { showRoute("") }
    override fun onSaveInstanceState(out: Bundle) {
        out.putString("route", route); out.putBoolean("revoked", model.showRevoked)
        pair.pairId?.let { out.putString("pair", it) }
        // Neither the install command nor its one-time secret enters saved state or preferences.
        super.onSaveInstanceState(out)
    }

    private fun routeOf(arg: String?): String {
        if (arg.isNullOrBlank()) return ""
        val value = runCatching { JSONObject(arg) }.getOrNull()
        val raw = value?.optString("device")?.takeIf { it.isNotEmpty() }?.let { "d/$it" }
            ?: value?.optString("pair_id")?.takeIf { it.isNotEmpty() }?.let { "p/$it" }
            ?: value?.optString("page")?.takeIf { it.isNotEmpty() } ?: arg
        return when { raw == "connect" || raw.startsWith("p/") -> raw
            raw.startsWith("d/") -> "d/" + canonicalId(raw.removePrefix("d/"))
            raw.startsWith("device:") -> "d/$raw"
            else -> "" }
    }
    private fun canonicalId(id: String) = if (id.startsWith("device:")) id else "device:$id"

    private fun showRoute(next: String) {
        routeGeneration++; route = next; detail = null; pairing = null; note = ""
        currentFocus?.clearFocus()
        content.removeAllViews(); actions.removeAllViews()
        actions.addView(button(R.string.dev_refresh) {
            Refresh.entries.forEach(::read); readPair(manual = true)
            reconcileDetail = detail
        })
        when {
            route.isEmpty() -> {
                title.text = getString(R.string.dev_title)
                actions.addView(button(R.string.dev_connect) { pair.reset(); showRoute("connect") })
                (list.parent as? android.view.ViewGroup)?.removeView(list)
                content.addView(list)
            }
            route.startsWith("d/") -> {
                title.text = getString(R.string.dev_title)
                detail = Detail(route.removePrefix("d/"))
                content.addView(scroll(detail!!.root))
                readChanges(route.removePrefix("d/"))
            }
            else -> {
                title.text = getString(R.string.dev_connect)
                pairing = Pairing()
                content.addView(scroll(pairing!!.root))
                // One-time commands are sensitive even while this screen is merely waiting for approval.
                window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
        }
        if (pairing == null) window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        syncBack(); render()
        if (active) { read(Refresh.DEVICES); readPair() }
    }

    /** Coalesce events while a read is in flight. Failures retain the last successful snapshot. */
    private fun read(what: Refresh) {
        if (!active) return
        if (!reading.add(what)) { dirty.add(what); return }
        val gen = model.begin(what)
        val member = if (what == Refresh.RELAY) "service:link" else "service:devices"
        val word = when (what) { Refresh.DEVICES -> "list"; Refresh.RELAY -> "gateway.status"; Refresh.PAIRS -> "pair_pending" }
        val args = if (what == Refresh.DEVICES) JSONObject().put("include_revoked", true) else JSONObject()
        call(member, word, args) { data, failure ->
            reading.remove(what)
            val valid = when (what) {
                Refresh.DEVICES -> data?.takeIf { it.optJSONArray("devices") != null }
                Refresh.PAIRS -> data?.takeIf { it.optJSONArray("pairs") != null }
                Refresh.RELAY -> data?.takeIf { it.has("configured") && it.has("connected") }
            }
            when (what) { Refresh.DEVICES -> model.devicesRead(gen, valid); Refresh.RELAY -> model.relayRead(gen, valid); Refresh.PAIRS -> model.requestsRead(gen, valid) }
            if (valid == null) note = error(failure) else if (failure == null) {
                note = ""
                if (what == Refresh.DEVICES && reconcileDetail === detail) { detail?.reconciled(); reconcileDetail = null }
            }
            if (active) { render(); if (dirty.remove(what)) read(what) }
        }
    }

    private fun readPair(manual: Boolean = false) {
        val id = pair.pairId ?: return
        if (!active) return
        if (readingPair) { pairDirty = true; return }
        readingPair = true
        call("service:devices", "pair_status", JSONObject().put("pair_id", id)) { data, failure ->
            readingPair = false
            if (pair.pairId != id) { if (active) readPair(); return@call }
            if (data != null) {
                pair.changed(data)
                if (manual) pairing?.reconciled()
                val waiting = pair.step as? PairFlow.Step.Waiting
                if (data.optString("state") == "waiting" && waiting?.command.isNullOrEmpty()) readCode(id)
                pairing?.result?.text = ""
            } else pairing?.result?.text = error(failure)
            if (active) { render(); if (pairDirty) { pairDirty = false; readPair() } }
        }
    }
    private fun readCode(id: String) {
        call("service:devices", "pair_code", JSONObject().put("pair_id", id)) { data, failure ->
            val waiting = pair.step as? PairFlow.Step.Waiting
            if (pair.pairId != id || waiting == null) return@call
            if (data != null) pair.restoreCommand(id, data.optString("command"), data.optLong("expires_at"))
            else pairing?.result?.text = error(failure)
            if (active) render()
        }
    }

    private fun render() {
        if (!active) return
        if (route.isEmpty()) {
            val snapshot = model.rows(System.currentTimeMillis())
            rows.submitList(snapshot.map { row -> ChatRow(row.key, row.toString()) { listRow(row) } } +
                if (note.isEmpty()) emptyList() else listOf(ChatRow("read-error", note) { text(note) }))
        } else { detail?.bind(); pairing?.bind() }
    }
    private fun listRow(row: DevicesState.Row): View = when (row) {
        is DevicesState.Row.Status -> section(row.text).apply {
            addView(button(R.string.dev_relay_help) {
                call("service:agents", "tell", JSONObject().put("agent", primary ?: "agent:main").put("text", getString(R.string.dev_relay_request))) { _, failure ->
                    note = if (failure == null) getString(R.string.dev_saved) else error(failure); render()
                }
            })
        }
        is DevicesState.Row.Request -> AshUi.row(this, row.pair.name.ifEmpty { DevicesText.kind(row.pair.kind) }, getString(R.string.dev_requests), onClick = {
            pair.resume(row.pair.pairId); showRoute("p/${row.pair.pairId}"); readPair()
        })
        is DevicesState.Row.Item -> column().apply {
            addView(text(row.device.name, true)); addView(text(row.presence))
            row.version?.let { addView(text(it)) }
            addView(text(getString(R.string.dev_capabilities, row.abilities.joinToString("、").ifEmpty { getString(R.string.dev_none) })))
            addView(button(R.string.dev_open_device) { showRoute("d/${row.device.id}") })
        }
        is DevicesState.Row.ShowRevoked -> button(if (row.shown) R.string.dev_hide_revoked else R.string.dev_show_revoked, row.count) { model.showRevoked = !model.showRevoked; render() }
        is DevicesState.Row.Note -> text(row.text)
    }

    /** A small static form; this instance stays attached while events update labels around the active edit field. */
    private inner class Detail(val id: String) {
        val root = column()
        private val header = text(getString(R.string.dev_loading), true)
        private val status = text("")
        private val change = text("")
        private val abilities = text("")
        private val name = EditText(this@DevicesActivity).apply {
            hint = getString(R.string.dev_name); contentDescription = hint
            minimumHeight = dp(AshTokens.Size.touch); setTextColor(c.text); setHintTextColor(c.text3)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_WORDS
            isSaveEnabled = false
        }
        private var nameLoaded = false
        private var nameDirty = false
        private var settingName = false
        private var sourceName: String? = null
        private val nameNote = text("")
        private val saveName: TextView = button(R.string.dev_save_name) {
            val next = name.text.toString().trim()
            if (next.isEmpty()) { nameNote.text = getString(R.string.dev_name_empty); return@button }
            run("rename", saveNameButton(), nameNote, JSONObject().put("name", next)) {
                // An answer to the previous name never clears a newer draft.
                if (name.text.toString().trim() == next) { nameDirty = false; keepDraft(null) }
            }
        }
        private fun saveNameButton() = saveName
        private val access = AccessForm { key, value, control, message ->
            val args = JSONObject().put(key, value)
            run("access_set", control, message, args)
        }
        private val updateNote = text("")
        private val update: TextView = button(R.string.dev_update) { run("update", updateButton(), updateNote) }
        private fun updateButton() = update
        private val diagnosis = text("")
        private val diagnose = button(R.string.dev_diagnose) { diagnose() }
        private val revokeNote = text("")
        private val revoke: TextView = button(R.string.dev_revoke) {
            val d = model.device(id) ?: return@button
            if (d.revoked) run("restore", revokeButton(), revokeNote)
            else AlertDialog.Builder(this@DevicesActivity).setTitle(R.string.dev_revoke_question).setMessage(R.string.dev_revoke_help)
                .setNegativeButton(R.string.dev_cancel, null).setPositiveButton(R.string.dev_confirm) { _, _ -> run("revoke", revokeButton(), revokeNote) }.show()
        }
        private fun revokeButton() = revoke
        private val pending = HashSet<String>()
        private val unknown = HashSet<String>()
        init {
            listOf("rename", "access_set", "update", "revoke", "restore").forEach { word ->
                if (prefs.getBoolean("pending/$id/$word", false)) { unknown.add(word); status.text = getString(R.string.dev_busy_rebuild) }
            }
            root.addView(header); root.addView(status); root.addView(change); root.addView(abilities)
            root.addView(name); root.addView(saveName); root.addView(nameNote); root.addView(access.root)
            root.addView(update); root.addView(updateNote); root.addView(diagnose); root.addView(diagnosis)
            root.addView(revoke); root.addView(revokeNote)
            name.addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    if (!settingName) { nameDirty = true; keepDraft(s?.toString()) }
                }
                override fun afterTextChanged(s: Editable?) {}
            })
            // Local UI draft storage, not a device business capability. Disk reads are off the UI thread.
            UiIo.disk {
                val draft = prefs.getString("name/$id", null)
                UiIo.ui { if (detail === this && !nameDirty && draft != null) { setName(draft); nameDirty = true } }
            }
        }
        private fun keepDraft(value: String?) { UiIo.disk { prefs.edit().apply { if (value == null) remove("name/$id") else putString("name/$id", value) }.apply() } }
        private fun setName(value: String) { settingName = true; name.setText(value); settingName = false; nameLoaded = true }
        fun bind() {
            val d = model.device(id)
            if (d == null) { header.text = getString(if (model.devices == null) R.string.dev_loading else R.string.dev_missing); name.isEnabled = false; saveName.isEnabled = false; access.enabled(false); update.isEnabled = false; diagnose.isEnabled = false; revoke.isEnabled = false; return }
            header.text = d.name
            status.text = listOfNotNull(DevicesText.presence(d, System.currentTimeMillis()), DevicesText.version(d, model.release), note.takeIf { it.isNotEmpty() }).joinToString("\n")
            change.text = model.changes[id]?.let { DevicesText.change(it, primary, System.currentTimeMillis()) }.orEmpty()
            abilities.text = getString(R.string.dev_capabilities, DevicesText.abilities(d.capabilities).joinToString("、").ifEmpty { getString(R.string.dev_none) })
            if (!nameLoaded || (!nameDirty && !name.hasFocus() && name.text.toString() != d.name)) setName(d.name)
            else if (nameDirty && sourceName != null && sourceName != d.name) nameNote.text = getString(R.string.dev_rename_external)
            sourceName = d.name
            name.isEnabled = !d.revoked
            saveName.isEnabled = !d.revoked && "rename" !in pending && "rename" !in unknown
            if ("access_set" !in pending) access.bind(d)
            access.enabled(!d.revoked && d.kind != "browser" && "access_set" !in pending && "access_set" !in unknown)
            update.visibility = if (d.isComputer && d.latest == false && !d.revoked) View.VISIBLE else View.GONE
            update.isEnabled = d.online && d.updating == null && "update" !in pending && "update" !in unknown
            revoke.text = getString(if (d.revoked) R.string.dev_restore else R.string.dev_revoke)
            revoke.isEnabled = "revoke" !in pending && "restore" !in pending && "revoke" !in unknown && "restore" !in unknown
            diagnose.isEnabled = "diagnose" !in pending
        }
        private fun run(word: String, control: View, message: TextView, args: JSONObject = JSONObject(), done: () -> Unit = {}) {
            if (word in unknown || !pending.add(word)) return
            control.isEnabled = false; message.text = getString(R.string.dev_working)
            prefs.edit().putBoolean("pending/$id/$word", true).apply()
            call("service:devices", word, args.put("device", id)) { _, failure ->
                pending.remove(word); prefs.edit().remove("pending/$id/$word").apply()
                if (isUnknown(failure)) unknown.add(word)
                if (failure == null) done()
                message.text = if (failure == null) getString(R.string.dev_saved) else error(failure)
                if (detail === this && active) { bind(); read(Refresh.DEVICES) }
            }
            bind()
        }
        private fun diagnose() {
            if (!pending.add("diagnose")) return
            diagnose.isEnabled = false; diagnosis.text = getString(R.string.dev_working)
            call("service:link", "diagnose", JSONObject().put("hand", id.removePrefix("device:"))) { data, failure ->
                if (detail !== this) return@call
                if (data == null) { pending.remove("diagnose"); diagnosis.text = error(failure); bind(); return@call }
                call("service:link", "list") { links, linkFailure ->
                    pending.remove("diagnose")
                    if (detail !== this) return@call
                    val conns = links?.optJSONArray("connections")
                    val count = (0 until (conns?.length() ?: 0)).count { conns?.optJSONObject(it)?.optString("hand") == id.removePrefix("device:") }
                    val findings = data.optJSONArray("findings")
                    val lines = (0 until (findings?.length() ?: 0)).mapNotNull { findings?.optJSONObject(it)?.optString("message") }.joinToString("\n")
                    diagnosis.text = getString(R.string.dev_diagnosis, model.device(id)?.let { DevicesText.presence(it, System.currentTimeMillis()) }.orEmpty(), DevicesText.relay(model.relay).first, count,
                        if (linkFailure != null) error(linkFailure) else lines.ifEmpty { getString(R.string.dev_no_findings) })
                    bind()
                }
            }
        }
        /** A manual successful read permits the user to reconcile and retry a timed-out idempotent setting. */
        fun reconciled() {
            unknown.forEach { prefs.edit().remove("pending/$id/$it").apply() }; unknown.clear(); bind()
        }
    }

    private inner class AccessForm(private val changed: ((String, Any, View, TextView) -> Unit)? = null) {
        val root = column()
        private val values = linkedMapOf("lend" to R.string.dev_lend, "body" to R.string.dev_body, "local_agents" to R.string.dev_agents, "tier" to R.string.dev_full)
        private val switches = values.mapValues { (key, label) -> AshUi.AshSwitch(this@DevicesActivity).apply {
            contentDescription = getString(label)
            set(key == "lend")
            onChange = { on -> changed?.invoke(key, if (key == "tier") (if (on) "full" else "ask") else on, this, messages.getValue(key)) }
        } }
        private val messages = values.mapValues { text("") }
        init {
            val helps = listOf(R.string.dev_lend_help, R.string.dev_body_help, R.string.dev_agents_help, R.string.dev_full_help)
            values.entries.forEachIndexed { i, (key, label) ->
                root.addView(AshUi.row(this@DevicesActivity, getString(label), getString(helps[i]), trailing = switches.getValue(key)))
                root.addView(messages.getValue(key))
            }
        }
        fun bind(d: Device) {
            val actual = mapOf("lend" to d.lend, "body" to d.body, "local_agents" to d.localAgents, "tier" to (d.tier == "full"))
            switches.forEach { (key, switch) -> switch.set(actual.getValue(key)) }
        }
        fun enabled(enabled: Boolean) { switches.values.forEach { it.isEnabled = enabled; it.alpha = if (enabled) 1f else 0.4f } }
        fun args() = JSONObject().put("tier", if (switches.getValue("tier").checked) "full" else "ask").also { o -> listOf("lend", "body", "local_agents").forEach { o.put(it, switches.getValue(it).checked) } }
    }

    private inner class Pairing {
        val root = column()
        val result = text("")
        private val explanation = text(getString(R.string.dev_pair_intro))
        private val command = text("").apply { setTextIsSelectable(true); isSaveEnabled = false }
        private var kind = "computer"
        private val computer = button(R.string.dev_computer) { kind = "computer"; kindState() }
        private val server = button(R.string.dev_server) { kind = "server"; kindState() }
        private val issue = button(R.string.dev_issue) { issue() }
        private val copy: TextView = button(R.string.dev_copy) {
            val waiting = pair.step as? PairFlow.Step.Waiting ?: return@button
            if (waiting.command.isEmpty() || pair.expiredBy(System.currentTimeMillis())) return@button
            copyButton().isEnabled = false
            call(Link.get(this@DevicesActivity).deviceId, "clipboard.set", JSONObject().put("text", waiting.command)) { _, failure ->
                if (pairing === this) { result.text = if (failure == null) getString(R.string.dev_copied) else error(failure); copyButton().isEnabled = true }
            }
        }
        private fun copyButton() = copy
        private val permissions = AccessForm()
        private val approve = button(R.string.dev_approve) { decide(true) }
        private val reject = button(R.string.dev_reject) { decide(false) }
        private val restart = button(R.string.dev_restart) { pair.reset(); result.text = ""; bind() }
        private val open = button(R.string.dev_open_device) {
            val id = (pair.step as? PairFlow.Step.Connected)?.device ?: (pair.step as? PairFlow.Step.Approved)?.device
            if (!id.isNullOrEmpty()) showRoute("d/$id")
        }
        private var deciding = false
        private var uncertain = false
        init { listOf(computer, server, explanation, issue, command, copy, permissions.root, approve, reject, result, restart, open).forEach(root::addView); kindState() }
        private fun kindState() { computer.isSelected = kind == "computer"; server.isSelected = kind == "server"; computer.alpha = if (computer.isSelected) 1f else 0.5f; server.alpha = if (server.isSelected) 1f else 0.5f }
        fun bind() {
            val s = pair.step
            val idle = s is PairFlow.Step.Idle || s is PairFlow.Step.Ended
            computer.visibility = visible(idle); server.visibility = visible(idle); issue.visibility = visible(idle)
            issue.isEnabled = s !is PairFlow.Step.Issuing
            val waiting = s as? PairFlow.Step.Waiting
            command.visibility = visible(waiting != null && waiting.command.isNotEmpty() && !pair.expiredBy(System.currentTimeMillis()))
            if (command.text.toString() != waiting?.command.orEmpty()) command.text = waiting?.command.orEmpty()
            copy.visibility = command.visibility
            val asking = s is PairFlow.Step.Asking || s is PairFlow.Step.Approving
            permissions.root.visibility = visible(asking)
            approve.visibility = visible(asking); reject.visibility = visible(asking)
            approve.isEnabled = !deciding && !uncertain && s is PairFlow.Step.Asking
            reject.isEnabled = approve.isEnabled
            restart.visibility = visible(s is PairFlow.Step.Ended || waiting != null && pair.expiredBy(System.currentTimeMillis()) || s is PairFlow.Step.Connected)
            open.visibility = visible(s is PairFlow.Step.Connected && s.device != null)
            explanation.text = when (s) {
                is PairFlow.Step.Idle -> getString(R.string.dev_pair_intro)
                is PairFlow.Step.Issuing -> getString(R.string.dev_working)
                is PairFlow.Step.Waiting -> waitingText(s)
                is PairFlow.Step.Asking -> getString(R.string.dev_pair_request, s.name.ifEmpty { getString(R.string.dev_title) })
                is PairFlow.Step.Approving -> getString(R.string.dev_working)
                is PairFlow.Step.Approved -> getString(R.string.dev_approved)
                is PairFlow.Step.Connected -> getString(R.string.dev_connected)
                is PairFlow.Step.Ended -> "${s.why}\n${s.next}"
            }
        }
        private fun waitingText(s: PairFlow.Step.Waiting) = when {
            pair.expiredBy(System.currentTimeMillis()) -> getString(R.string.dev_pair_expired)
            s.command.isEmpty() -> getString(R.string.dev_pair_restore)
            else -> getString(R.string.dev_pair_wait, PairFlow.left(s.deadline, System.currentTimeMillis()))
        }
        fun tick() { val s = pair.step as? PairFlow.Step.Waiting ?: return; explanation.text = waitingText(s); if (pair.expiredBy(System.currentTimeMillis())) bind() }
        private fun issue() {
            if (!pair.start()) return
            result.text = ""; bind()
            val generation = routeGeneration
            call("service:devices", "pair_start", JSONObject().put("kind", kind)) { data, failure ->
                if (pairing !== this || routeGeneration != generation) return@call
                pair.issued(data, failure?.code, failure?.message)
                if (active) render()
                readPair()
            }
        }
        private fun decide(allow: Boolean) {
            val asking = pair.step as? PairFlow.Step.Asking ?: return
            if (deciding || uncertain) return
            deciding = true
            if (allow) pair.approve()
            bind()
            val args = if (allow) permissions.args() else JSONObject()
            call("service:devices", if (allow) "pair_approve" else "pair_reject", args.put("pair_id", asking.pairId)) { data, failure ->
                if (pair.pairId != asking.pairId) return@call
                deciding = false; uncertain = isUnknown(failure)
                if (allow) pair.approveAnswered(data, failure?.code, failure?.message)
                else if (data != null) pair.changed(data)
                if (pairing === this) { result.text = if (failure == null) "" else error(failure); bind() }
                readPair(); read(Refresh.DEVICES); read(Refresh.PAIRS)
            }
        }
        fun reconciled() { uncertain = false; bind() }
    }

    private fun readChanges(id: String) {
        call("service:history", "query", JSONObject().put("speaker", "service:devices").put("text", id).put("limit", 50)) { data, _ ->
            val messages = data?.optJSONArray("messages") ?: return@call
            (0 until messages.length()).mapNotNull { messages.optJSONObject(it) }.forEach(model::heard)
            if (active) render()
        }
    }

    private fun error(f: HumanPort.Failure?): String = when {
        isUnknown(f) -> getString(R.string.dev_unknown)
        f?.code == "unavailable" -> getString(R.string.dev_unavailable)
        else -> getString(R.string.dev_retry, f?.message.orEmpty())
    }
    private fun isUnknown(f: HumanPort.Failure?) = f?.code in setOf("result_unknown", "timeout", "offline")
    private fun visible(show: Boolean) = if (show) View.VISIBLE else View.GONE
    private fun text(value: String, heading: Boolean = false) = AshUi.text(this, value, if (heading) AshTokens.Type.headline else AshTokens.Type.body).apply {
        setPadding(0, dp(AshTokens.Space.xs), 0, dp(AshTokens.Space.xs))
    }
    private fun column() = AshUi.vstack(this, AshTokens.Space.xs).apply { setPadding(dp(AshTokens.Space.pageX), 0, dp(AshTokens.Space.pageX), dp(AshTokens.Space.lg)) }
    private fun section(value: String) = column().apply { addView(text(value)) }
    private fun scroll(child: View) = ScrollView(this).apply { isFillViewport = true; addView(child) }
    private fun button(label: Int, vararg args: Any, action: () -> Unit) = AshUi.button(this, getString(label, *args), AshUi.Kind.NEUTRAL, block = true, onClick = action)
}
