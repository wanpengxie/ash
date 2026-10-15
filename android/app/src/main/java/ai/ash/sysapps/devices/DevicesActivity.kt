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
import android.content.Intent
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
open class DevicesActivity : SystemAppActivity() {
    private lateinit var model: DevicesState
    private val pair = PairFlow()
    private lateinit var list: RecyclerView
    private lateinit var rows: KeyedRowsAdapter
    private var route = ""
    private var routeGeneration = 0
    private var active = false
    private var detail: Detail? = null
    private var pairing: Pairing? = null
    private var confirmation: AlertDialog? = null
    private val reading = HashSet<Refresh>()
    private val dirty = HashSet<Refresh>()
    private var reconcileDetail: Detail? = null
    private var pairUncertain = false
    private var pairDraft: String? = null
    private var pairingKind = "computer"
    private var readingPair = false
    private var pairDirty = false
    private var manualPairRead = false
    private val readErrors = HashMap<Refresh, String>()
    private var restoreKey: String? = null
    private var restoreOffset = 0
    private var primary: String? = null
    private var note = ""
    private val handler = Handler(Looper.getMainLooper())
    private val clock = object : Runnable {
        override fun run() { if (active) { pairing?.tick(); handler.postDelayed(this, 1000) } }
    }
    private val prefs by lazy { getSharedPreferences("devices.ui", MODE_PRIVATE) }

    /** Device app I/O boundary: the production implementation always uses the shared hub port. */
    protected open fun request(to: String, word: String, body: JSONObject = JSONObject(), done: (JSONObject?, HumanPort.Failure?) -> Unit) =
        call(to, word, body, done)

    override fun build(saved: Bundle?) {
        model = lastNonConfigurationInstance as? DevicesState ?: DevicesState()
        route = saved?.getString("route") ?: routeOf(intent.getStringExtra(EXTRA_ARG))
        pairUncertain = saved?.getBoolean("pairUncertain") ?: false
        pairDraft = saved?.getString("pairDraft")
        pairingKind = saved?.getString("pairKind") ?: "computer"
        model.showRevoked = saved?.getBoolean("revoked") ?: false
        restoreKey = saved?.getString("anchor"); restoreOffset = saved?.getInt("offset") ?: 0
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
        request("service:agents", "list") { data, _ ->
            val all = data?.optJSONArray("agents")
            primary = (0 until (all?.length() ?: 0)).mapNotNull { all?.optJSONObject(it) }.firstOrNull { it.optBoolean("primary") }?.optString("id")
            render()
        }
        handler.post(clock)
    }
    override fun onStop() { active = false; handler.removeCallbacks(clock); super.onStop() }
    override fun onRetainNonConfigurationInstance(): Any = model
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
    override fun onNewIntent(next: Intent) {
        super.onNewIntent(next)
        setIntent(next)
        val target = routeOf(next.getStringExtra(EXTRA_ARG))
        if (target == route) { Refresh.entries.forEach(::read); readPair(); return }
        if (target.startsWith("p/")) {
            val id = target.removePrefix("p/")
            if (id != pair.pairId) { pair.reset(); pairDraft = null; pairUncertain = false }
            pair.resume(id)
        } else if (target == "connect") {
            pair.reset(); pairDraft = null; pairUncertain = false
        }
        showRoute(target)
    }
    override fun onSaveInstanceState(out: Bundle) {
        out.putString("route", route); out.putBoolean("revoked", model.showRevoked)
        out.putBoolean("pairUncertain", pairUncertain)
        out.putString("pairDraft", pairing?.accessDraft() ?: pairDraft)
        out.putString("pairKind", pairingKind)
        pair.pairId?.let { out.putString("pair", it) }
        val lm = list.layoutManager as LinearLayoutManager
        val position = lm.findFirstVisibleItemPosition()
        rows.currentList.getOrNull(position)?.let { row ->
            out.putString("anchor", row.key)
            lm.findViewByPosition(position)?.let { out.putInt("offset", lm.getDecoratedTop(it) - list.paddingTop) }
        }
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
        confirmation?.dismiss(); confirmation = null
        routeGeneration++; route = next; detail = null; pairing = null; note = ""
        readingPair = false; pairDirty = false; manualPairRead = false
        currentFocus?.let {
            getSystemService(android.view.inputmethod.InputMethodManager::class.java)?.hideSoftInputFromWindow(it.windowToken, 0)
            it.clearFocus()
        }
        content.removeAllViews(); actions.removeAllViews()
        actions.addView(AshUi.iconButton(this, getDrawable(R.drawable.ash_ic_refresh)!!, getString(R.string.dev_refresh)) {
            Refresh.entries.forEach(::read); readPair(manual = true)
            reconcileDetail = detail
        })
        when {
            route.isEmpty() -> {
                title.text = getString(R.string.dev_title)
                actions.addView(AshUi.iconButton(this, getDrawable(R.drawable.ash_ic_plus)!!, getString(R.string.dev_connect)) { startPairing() })
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
        request(member, word, args) { data, failure ->
            reading.remove(what)
            val valid = when (what) {
                Refresh.DEVICES -> data?.takeIf { it.optJSONArray("devices") != null }
                Refresh.PAIRS -> data?.takeIf { it.optJSONArray("pairs") != null }
                Refresh.RELAY -> data?.takeIf { it.has("configured") && it.has("connected") }
            }
            when (what) { Refresh.DEVICES -> model.devicesRead(gen, valid); Refresh.RELAY -> model.relayRead(gen, valid); Refresh.PAIRS -> model.requestsRead(gen, valid) }
            if (valid == null) readErrors[what] = error(failure) else if (failure == null) {
                readErrors.remove(what)
                if (what == Refresh.DEVICES && reconcileDetail === detail) { detail?.reconciled(); reconcileDetail = null }
            }
            if (active) { render(); if (dirty.remove(what)) read(what) }
        }
    }

    private fun readPair(manual: Boolean = false) {
        if (pairing == null) return
        if (manual) manualPairRead = true
        val id = pair.pairId ?: return
        if (!active) return
        if (readingPair) { pairDirty = true; return }
        readingPair = true
        val generation = routeGeneration
        request("service:devices", "pair_status", JSONObject().put("pair_id", id)) { data, failure ->
            if (generation != routeGeneration) return@request
            readingPair = false
            if (pair.pairId != id) { if (active) readPair(); return@request }
            if (data != null) {
                pair.changed(data)
                if (data.optString("state") != "requested") pairUncertain = false
                if (manualPairRead) { pairing?.reconciled(); manualPairRead = false }
                val waiting = pair.step as? PairFlow.Step.Waiting
                if (data.optString("state") == "waiting" && waiting?.command.isNullOrEmpty()) readCode(id)
                pairing?.result?.text = ""
            } else pairing?.result?.text = error(failure)
            if (active) { render(); if (pairDirty) { pairDirty = false; readPair() } }
        }
    }
    private fun readCode(id: String) {
        val generation = routeGeneration
        request("service:devices", "pair_code", JSONObject().put("pair_id", id)) { data, failure ->
            if (generation != routeGeneration) return@request
            val waiting = pair.step as? PairFlow.Step.Waiting
            if (pair.pairId != id || waiting == null) return@request
            if (data != null) pair.restoreCommand(id, data.optString("command"), data.optLong("expires_at"))
            else pairing?.result?.text = error(failure)
            if (active) render()
        }
    }

    private fun render() {
        if (!active) return
        if (route.isEmpty()) {
            val snapshot = model.rows(System.currentTimeMillis())
            val errors = readErrors.filterKeys { it != Refresh.DEVICES }.map { (key, message) -> ChatRow("error/$key", message) { text(message) } }
            val feedback = if (note.isEmpty()) emptyList() else listOf(ChatRow("feedback", note) { text(note) })
            val contentRows = snapshot.map { row -> ChatRow(row.key, row.toString() + if (row is DevicesState.Row.Status) primary.orEmpty() else "") { listRow(row) } }.toMutableList()
            contentRows.add(1.coerceAtMost(contentRows.size), ChatRow("connect-device", "connect-device") {
                section(getString(R.string.dev_product_title)).apply {
                    addView(AshUi.button(this@DevicesActivity, getString(R.string.dev_product_connect), AshUi.Kind.PRIMARY, block = true) { startPairing() })
                }
            })
            rows.submitList(contentRows + errors + feedback) {
                restoreKey?.let { key ->
                    val position = rows.currentList.indexOfFirst { it.key == key }
                    if (position >= 0) { (list.layoutManager as LinearLayoutManager).scrollToPositionWithOffset(position, restoreOffset); restoreKey = null }
                }
            }
        } else { detail?.bind(); pairing?.bind() }
    }
    private fun listRow(row: DevicesState.Row): View = when (row) {
        is DevicesState.Row.Status -> column().apply {
            addView(subText(relaySummary()))
            if (row.problem) addView(button(R.string.dev_relay_help) {
                val agent = primary
                if (agent == null) { note = getString(R.string.dev_agent_unavailable); render() }
                else request("service:agents", "tell", JSONObject().put("agent", agent).put("text", getString(R.string.dev_relay_request))) { _, failure ->
                    note = if (failure == null) getString(R.string.dev_told) else error(failure); render()
                }
            }.apply { isEnabled = primary != null })
        }
        is DevicesState.Row.Request -> AshUi.row(this, row.pair.name.ifEmpty { DevicesText.kind(row.pair.kind) }, getString(R.string.dev_requests), onClick = {
            if (pair.pairId != row.pair.pairId) { pairDraft = null; pairUncertain = false }
            pair.resume(row.pair.pairId); showRoute("p/${row.pair.pairId}"); readPair()
        })
        is DevicesState.Row.Item -> column().apply {
            addView(text(row.device.name, true)); addView(subText(row.presence))
            val summary = useSummary(row.device)
            addView(text(summary))
            attention(row.device).takeIf { it.isNotEmpty() && it != summary }?.let { addView(text(it)) }
            row.version?.let { addView(subText(it)) }
            addView(button(when {
                row.device.revoked -> R.string.dev_product_restore
                !row.device.online -> R.string.dev_product_recover
                !row.device.lend && !row.device.body && !row.device.localAgents -> R.string.dev_product_choose
                else -> R.string.dev_open_device
            }) { showRoute("d/${row.device.id}") })
        }
        is DevicesState.Row.ShowRevoked -> button(if (row.shown) R.string.dev_hide_revoked else R.string.dev_show_revoked, row.count) { model.showRevoked = !model.showRevoked; render() }
        is DevicesState.Row.Note -> text(row.text)
    }

    /** A small static form; this instance stays attached while events update labels around the active edit field. */
    private inner class Detail(val id: String) {
        val root = column()
        private val header = text(getString(R.string.dev_loading), true)
        private val status = text("")
        private val nextStep = text("")
        private val settings = column().apply { visibility = View.GONE }
        private var settingsOpen = false
        private val settingsToggle: TextView = button(R.string.dev_settings) {
            settingsOpen = !settingsOpen
            settings.visibility = visible(settingsOpen)
            settingsToggleButton().text = getString(if (settingsOpen) R.string.dev_settings_hide else R.string.dev_settings)
        }
        private fun settingsToggleButton() = settingsToggle
        private val change = subText("")
        private val abilities = subText("")
        private val versionInfo = subText("")
        private val name = EditText(this@DevicesActivity).apply {
            hint = getString(R.string.dev_name); contentDescription = hint
            minimumHeight = dp(AshTokens.Size.touch); setTextColor(c.text); setHintTextColor(c.text3)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_WORDS
            isSaveEnabled = false
        }
        private var restoring = true
        private var nameLoaded = false
        private var nameDirty = false
        private var settingName = false
        private var sourceName: String? = null
        private var awaitingName: String? = null
        private val nameNote = text("")
        private val saveName: TextView = button(R.string.dev_save_name) {
            val next = name.text.toString().trim()
            if (next.isEmpty()) { nameNote.text = getString(R.string.dev_name_empty); nameNote.visibility = View.VISIBLE; return@button }
            run("rename", saveNameButton(), nameNote, JSONObject().put("name", next)) {
                // An answer to the previous name never clears a newer draft.
                if (name.text.toString().trim() == next) { awaitingName = next; keepDraft(null) }
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
        private var diagnosisState: Pair<Boolean, Boolean>? = null
        private val diagnosisRaw = text("").apply { setTextIsSelectable(true); visibility = View.GONE }
        private var rawOpen = false
        private val diagnosisToggle: TextView = button(R.string.dev_diag_details) {
            rawOpen = !rawOpen; diagnosisRaw.visibility = visible(rawOpen)
            diagnosisToggleButton().text = getString(if (rawOpen) R.string.dev_diag_hide_details else R.string.dev_diag_details)
        }
        private fun diagnosisToggleButton() = diagnosisToggle
        private val diagnose = AshUi.button(this@DevicesActivity, getString(R.string.dev_check_connection), AshUi.Kind.PRIMARY, block = true) {
            read(Refresh.DEVICES); read(Refresh.RELAY); diagnose()
        }
        private val revokeNote = text("")
        private val restore: TextView = AshUi.button(this@DevicesActivity, getString(R.string.dev_restore), AshUi.Kind.PRIMARY, block = true) {
            run("restore", restoreButton(), revokeNote)
        }.apply { visibility = View.GONE }
        private fun restoreButton() = restore
        private val revoke: TextView = button(R.string.dev_revoke) {
            val d = model.device(id) ?: return@button
            if (d.revoked) run("restore", revokeButton(), revokeNote)
            else confirmation = AlertDialog.Builder(this@DevicesActivity).setTitle(R.string.dev_revoke_question).setMessage(R.string.dev_revoke_help)
                .setNegativeButton(R.string.dev_cancel, null).setPositiveButton(R.string.dev_confirm) { _, _ ->
                    if (detail === this) run("revoke", revokeButton(), revokeNote)
                }.show()
        }
        private fun revokeButton() = revoke
        private val pending = HashSet<String>()
        private val unknown = HashSet<String>()
        init {
            root.addView(header); root.addView(status); root.addView(nextStep); root.addView(diagnose); root.addView(restore); root.addView(revokeNote); root.addView(diagnosis)
            root.addView(diagnosisToggle.apply { visibility = View.GONE }); root.addView(diagnosisRaw)
            root.addView(settingsToggle); root.addView(settings)
            listOf(change, abilities, versionInfo, name, saveName, nameNote, access.root, update, updateNote, revoke).forEach(settings::addView)
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
                val unconfirmed = listOf("rename", "access_set", "update", "revoke", "restore").filter { prefs.getBoolean("pending/$id/$it", false) }
                UiIo.ui {
                    if (!isDestroyed && detail === this) {
                        if (!nameDirty && draft != null) { setName(draft); nameDirty = true }
                        unknown.addAll(unconfirmed); restoring = false; bind()
                    }
                }
            }
        }
        private fun keepDraft(value: String?) { UiIo.disk { prefs.edit().apply { if (value == null) remove("name/$id") else putString("name/$id", value) }.apply() } }
        private fun setName(value: String) { settingName = true; name.setText(value); settingName = false; nameLoaded = true }
        fun bind() {
            val d = model.device(id)
            if (d == null) { header.text = getString(if (model.devices == null) R.string.dev_loading else R.string.dev_missing); name.isEnabled = false; saveName.isEnabled = false; access.enabled(false); update.isEnabled = false; diagnose.isEnabled = false; revoke.isEnabled = false; restore.visibility = View.GONE; return }
            header.text = d.name
            title.text = d.name
            val noAccess = !d.lend && !d.body && !d.localAgents
            val impact = when { d.revoked -> getString(R.string.dev_detail_revoked); noAccess -> getString(R.string.dev_detail_no_access); else -> useSummary(d) }
            status.text = listOfNotNull(DevicesText.presence(d, System.currentTimeMillis()), impact, readErrors[Refresh.DEVICES], getString(R.string.dev_busy_rebuild).takeIf { unknown.isNotEmpty() }).filter { it.isNotEmpty() }.distinct().joinToString("\n")
            nextStep.text = when {
                d.revoked -> getString(R.string.dev_detail_restore_next, d.name)
                !d.online -> getString(R.string.dev_detail_offline_next, d.name, DevicesText.kind(d.kind))
                noAccess -> getString(R.string.dev_detail_access_next)
                else -> getString(R.string.dev_detail_online_next)
            }
            change.text = model.changes[id]?.let { DevicesText.change(it, primary, System.currentTimeMillis()) }.orEmpty()
            abilities.text = capabilities(d)
            versionInfo.text = DevicesText.version(d, model.release).orEmpty()
            if (awaitingName == d.name && name.text.toString().trim() == awaitingName) { nameDirty = false; awaitingName = null }
            if (!nameLoaded || (!nameDirty && !name.hasFocus() && name.text.toString() != d.name)) setName(d.name)
            else if (nameDirty && sourceName != null && sourceName != d.name) nameNote.text = getString(R.string.dev_rename_external)
            sourceName = d.name
            name.isEnabled = !d.revoked
            saveName.isEnabled = !d.revoked && "rename" !in pending && "rename" !in unknown
            if ("access_set" !in pending) access.bind(d)
            access.enabled(!d.revoked && d.kind != "browser" && "access_set" !in pending && "access_set" !in unknown)
            update.visibility = visible(d.isComputer && newerRelease(d) && !d.revoked)
            update.isEnabled = d.online && d.updating == null && "update" !in pending && "update" !in unknown
            revoke.text = getString(R.string.dev_revoke); revoke.visibility = visible(!d.revoked)
            restore.visibility = visible(d.revoked)
            revoke.isEnabled = "revoke" !in pending && "restore" !in pending && "revoke" !in unknown && "restore" !in unknown
            restore.isEnabled = revoke.isEnabled && !restoring
            diagnose.isEnabled = "diagnose" !in pending
            diagnose.visibility = visible(!d.revoked)
            if (diagnosisState != null && diagnosisState != (d.online to d.revoked) && "diagnose" !in pending) {
                diagnosis.text = ""; diagnosisRaw.text = ""; diagnosisRaw.visibility = View.GONE; diagnosisToggle.visibility = View.GONE
                diagnosisState = null; rawOpen = false
            }
            listOf(nameNote, change, versionInfo, updateNote, diagnosis, revokeNote).forEach { it.visibility = visible(it.text.isNotEmpty()) }
            if (restoring) { name.isEnabled = false; saveName.isEnabled = false; access.enabled(false); update.isEnabled = false; revoke.isEnabled = false }
        }
        private fun run(word: String, control: View, message: TextView, args: JSONObject = JSONObject(), done: () -> Unit = {}) {
            if (word in unknown || !pending.add(word)) return
            control.isEnabled = false; message.text = getString(R.string.dev_working)
            prefs.edit().putBoolean("pending/$id/$word", true).apply()
            request("service:devices", word, args.put("device", id)) { data, failure ->
                pending.remove(word)
                if (isUnknown(failure)) unknown.add(word) else prefs.edit().remove("pending/$id/$word").apply()
                if (failure == null) {
                    // The next list read must not let a pre-action snapshot roll back a confirmed setting.
                    model.begin(Refresh.DEVICES)
                    model.device(id)?.let { previous ->
                        val updated = when (word) {
                            "access_set" -> data?.let { DevicesJson.devices(JSONObject().put("devices", org.json.JSONArray().put(it))).singleOrNull() }
                            "rename" -> previous.copy(name = data?.optString("name")?.takeIf { it.isNotEmpty() } ?: args.optString("name"))
                            "revoke" -> previous.copy(revoked = true, online = false)
                            "restore" -> previous.copy(revoked = false)
                            else -> null
                        }
                        updated?.let(model::replaceDevice)
                    }
                }
                if (detail !== this) { if (active) read(Refresh.DEVICES); return@request }
                if (failure == null) done()
                message.text = if (failure == null) getString(when (word) {
                    "revoke" -> R.string.dev_revoked_done; "restore" -> R.string.dev_restored_done
                    "update" -> R.string.dev_update_started; else -> R.string.dev_saved
                }) else error(failure)
                if (detail === this && active) { bind(); read(Refresh.DEVICES) }
            }
            bind()
        }
        private fun diagnose() {
            if (!pending.add("diagnose")) return
            diagnose.isEnabled = false; diagnosis.text = getString(R.string.dev_working)
            diagnosis.visibility = View.VISIBLE
            diagnosisToggle.visibility = View.GONE; diagnosisRaw.visibility = View.GONE; rawOpen = false
            request("service:link", "diagnose", JSONObject().put("hand", id.removePrefix("device:"))) { data, failure ->
                if (detail !== this) return@request
                if (data == null) { pending.remove("diagnose"); diagnosis.text = error(failure); bind(); return@request }
                request("service:link", "list") { links, linkFailure ->
                    pending.remove("diagnose")
                    if (detail !== this) return@request
                    val conns = links?.optJSONArray("connections") ?: data.optJSONArray("connections")
                    val count = if (conns == null) getString(R.string.dev_diag_connections_unknown) else (0 until conns.length()).count { conns.optJSONObject(it)?.optString("hand") == id.removePrefix("device:") }.toString()
                    val findings = data.optJSONArray("findings")
                    val lines = (0 until (findings?.length() ?: 0)).mapNotNull { findings?.optJSONObject(it)?.optString("message") }.joinToString("\n")
                    val codes = (0 until (findings?.length() ?: 0)).mapNotNull { findings?.optJSONObject(it)?.optString("code") }.toSet()
                    val d = model.device(id)
                    val conclusion = when {
                        d?.revoked == true -> R.string.dev_diag_revoked
                        d?.via == "gateway" && "relay.down" in codes -> R.string.dev_diag_relay_down
                        "tunnel.missing" in codes -> R.string.dev_diag_tunnel_missing
                        "tunnel.not_allowed" in codes -> R.string.dev_diag_access_missing
                        d?.online == false || "hand.offline" in codes -> R.string.dev_diag_offline
                        linkFailure != null || conns == null -> R.string.dev_diag_incomplete
                        !data.optBoolean("ok") -> R.string.dev_diag_problem
                        codes.any { it.startsWith("handshake.") } && d?.online != true -> R.string.dev_diag_handshake
                        d?.online == true -> R.string.dev_diag_connected
                        else -> R.string.dev_diag_incomplete
                    }
                    diagnosis.text = getString(R.string.dev_diag_layout, getString(conclusion), relaySummary(), count, latencyText(conns, id))
                    diagnosisRaw.text = listOfNotNull(lines.takeIf { it.isNotEmpty() }, model.relay?.error, linkFailure?.let(::error)).joinToString("\n")
                    diagnosisToggle.visibility = visible(diagnosisRaw.text.isNotEmpty())
                    diagnosisToggle.text = getString(R.string.dev_diag_details)
                    diagnosisState = d?.let { it.online to it.revoked }
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
        private val advanced = column().apply { visibility = View.GONE }
        private var advancedOpen = false
        private val advancedToggle: TextView = button(R.string.dev_advanced) {
            advancedOpen = !advancedOpen; advanced.visibility = visible(advancedOpen); advancedLabel()
        }
        private fun advancedLabel() {
            advancedToggle.text = getString(when {
                advancedOpen -> R.string.dev_advanced_hide
                switches.getValue("local_agents").checked || switches.getValue("tier").checked -> R.string.dev_advanced_enabled
                else -> R.string.dev_advanced
            })
        }
        private val values = linkedMapOf("lend" to R.string.dev_lend, "body" to R.string.dev_body, "local_agents" to R.string.dev_agents, "tier" to R.string.dev_full)
        private val switches = values.mapValues { (key, label) -> AshUi.AshSwitch(this@DevicesActivity).apply {
            contentDescription = getString(label)
            set(key == "lend")
            onChange = { on ->
                if (changed != null) messages.getValue(key).visibility = View.VISIBLE
                changed?.invoke(key, if (key == "tier") (if (on) "full" else "ask") else on, this, messages.getValue(key))
                advancedLabel()
            }
        } }
        private val messages = values.mapValues { text("") }
        init {
            val helps = listOf(R.string.dev_lend_help, R.string.dev_body_help, R.string.dev_agents_help, R.string.dev_full_help)
            values.entries.forEachIndexed { i, (key, label) ->
                val group = if (key == "local_agents" || key == "tier") advanced else root
                group.addView(AshUi.hstack(this@DevicesActivity, AshTokens.Space.xs).apply {
                    addView(AshUi.vstack(this@DevicesActivity).apply {
                        addView(text(getString(label), true)); addView(text(getString(helps[i])))
                    }, LinearLayout.LayoutParams(0, -2, 1f))
                    addView(switches.getValue(key))
                })
                group.addView(messages.getValue(key).apply { visibility = View.GONE })
            }
            root.addView(advancedToggle); root.addView(advanced)
        }
        fun bind(d: Device) {
            val actual = mapOf("lend" to d.lend, "body" to d.body, "local_agents" to d.localAgents, "tier" to (d.tier == "full"))
            switches.forEach { (key, switch) -> switch.set(actual.getValue(key)) }
            advancedLabel()
        }
        fun enabled(enabled: Boolean) { switches.values.forEach { it.isEnabled = enabled; it.alpha = if (enabled) 1f else 0.4f } }
        fun restore(value: String?) {
            val data = value?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return
            switches.forEach { (key, switch) -> switch.set(if (key == "tier") data.optString(key) == "full" else data.optBoolean(key)) }
            advancedLabel()
        }
        fun args() = JSONObject().put("tier", if (switches.getValue("tier").checked) "full" else "ask").also { o -> listOf("lend", "body", "local_agents").forEach { o.put(it, switches.getValue(it).checked) } }
    }

    private inner class Pairing {
        val root = column()
        val result = text("")
        private val explanation = text(getString(R.string.dev_pair_intro))
        private val command = text("").apply { setTextIsSelectable(true); isSaveEnabled = false }
        private val connectedAbilities = text("")
        private val computer = button(R.string.dev_computer) { pairingKind = "computer"; kindState() }
        private val server = button(R.string.dev_server) { pairingKind = "server"; kindState() }
        private val kinds = AshUi.hstack(this@DevicesActivity, AshTokens.Space.xs).apply {
            addView(computer, LinearLayout.LayoutParams(0, -2, 1f)); addView(server, LinearLayout.LayoutParams(0, -2, 1f))
        }
        private val issue = AshUi.button(this@DevicesActivity, getString(R.string.dev_issue), AshUi.Kind.PRIMARY, block = true) { issue() }
        private val copy: TextView = AshUi.button(this@DevicesActivity, getString(R.string.dev_copy), AshUi.Kind.PRIMARY, block = true) {
            val waiting = pair.step as? PairFlow.Step.Waiting ?: return@button
            if (waiting.command.isEmpty() || pair.expiredBy(System.currentTimeMillis())) return@button
            copyButton().isEnabled = false
            request(Link.get(this@DevicesActivity).deviceId, "clipboard.set", JSONObject().put("text", waiting.command)) { _, failure ->
                if (pairing === this) { result.text = if (failure == null) getString(R.string.dev_copied) else error(failure); copyButton().isEnabled = true }
            }
        }
        private fun copyButton() = copy
        private val permissions = AccessForm()
        private val approve = AshUi.button(this@DevicesActivity, getString(R.string.dev_approve), AshUi.Kind.PRIMARY, block = true) { decide(true) }
        private val reject = button(R.string.dev_reject) { decide(false) }
        private val restart = button(R.string.dev_restart) { pair.reset(); pairUncertain = false; result.text = ""; bind() }
        private val open = AshUi.button(this@DevicesActivity, getString(R.string.dev_open_device), AshUi.Kind.PRIMARY, block = true) {
            val id = (pair.step as? PairFlow.Step.Connected)?.device ?: (pair.step as? PairFlow.Step.Approved)?.device
            if (!id.isNullOrEmpty()) showRoute("d/$id")
        }
        private var deciding = false
        init { permissions.restore(pairDraft); listOf(kinds, explanation, issue, command, copy, permissions.root, approve, reject, connectedAbilities, result, open, restart).forEach(root::addView); kindState() }
        fun accessDraft() = permissions.args().toString()
        private fun kindState() { computer.isSelected = pairingKind == "computer"; server.isSelected = pairingKind == "server"; computer.alpha = if (computer.isSelected) 1f else 0.5f; server.alpha = if (server.isSelected) 1f else 0.5f }
        fun bind() {
            val s = pair.step
            val idle = s is PairFlow.Step.Idle || s is PairFlow.Step.Ended
            kinds.visibility = visible(idle); issue.visibility = visible(idle)
            issue.isEnabled = s !is PairFlow.Step.Issuing
            val waiting = s as? PairFlow.Step.Waiting
            command.visibility = visible(waiting != null && waiting.command.isNotEmpty() && !pair.expiredBy(System.currentTimeMillis()))
            if (command.text.toString() != waiting?.command.orEmpty()) command.text = waiting?.command.orEmpty()
            copy.visibility = command.visibility
            val asking = s is PairFlow.Step.Asking || s is PairFlow.Step.Approving
            permissions.root.visibility = visible(asking)
            permissions.enabled(!deciding && !pairUncertain && s is PairFlow.Step.Asking)
            val connectedDevice = (s as? PairFlow.Step.Connected)?.device?.let(model::device)?.takeIf { it.online && !it.revoked }
            connectedAbilities.visibility = visible(s is PairFlow.Step.Connected)
            connectedAbilities.text = connectedDevice?.let(::useSummary) ?: getString(R.string.dev_product_syncing)
            approve.visibility = visible(asking); reject.visibility = visible(asking)
            approve.isEnabled = !deciding && !pairUncertain && s is PairFlow.Step.Asking
            reject.isEnabled = approve.isEnabled
            restart.visibility = visible(s is PairFlow.Step.Ended || waiting != null && pair.expiredBy(System.currentTimeMillis()) || s is PairFlow.Step.Connected)
            open.visibility = visible(s is PairFlow.Step.Connected && s.device != null)
            if (deciding) result.text = getString(R.string.dev_working)
            else if (pairUncertain) result.text = getString(R.string.dev_unknown)
            result.visibility = visible(result.text.isNotEmpty())
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
            request("service:devices", "pair_start", JSONObject().put("kind", pairingKind)) { data, failure ->
                if (pairing !== this || routeGeneration != generation) return@request
                pair.issued(data, failure?.code, failure?.message)
                if (active) render()
                readPair()
            }
        }
        private fun decide(allow: Boolean) {
            val asking = pair.step as? PairFlow.Step.Asking ?: return
            if (deciding || pairUncertain) return
            deciding = true; pairUncertain = true
            if (allow) pair.approve()
            bind()
            val args = if (allow) permissions.args() else JSONObject()
            val generation = routeGeneration
            request("service:devices", if (allow) "pair_approve" else "pair_reject", args.put("pair_id", asking.pairId)) { data, failure ->
                if (generation != routeGeneration || pair.pairId != asking.pairId) return@request
                deciding = false; pairUncertain = isUnknown(failure)
                if (allow) pair.approveAnswered(data, failure?.code, failure?.message)
                else if (data != null) pair.changed(data)
                if (pairing === this) { result.text = if (failure == null) "" else error(failure); bind() }
                readPair(); read(Refresh.DEVICES); read(Refresh.PAIRS)
            }
        }
        fun reconciled() { pairUncertain = false; result.text = ""; bind() }
    }

    private fun readChanges(id: String) {
        request("service:history", "query", JSONObject().put("speaker", "service:devices").put("text", id).put("limit", 50)) { data, _ ->
            val messages = data?.optJSONArray("messages") ?: return@request
            (0 until messages.length()).mapNotNull { messages.optJSONObject(it) }.forEach(model::heard)
            if (active) render()
        }
    }

    private fun error(f: HumanPort.Failure?): String = when {
        isUnknown(f) -> getString(R.string.dev_unknown)
        f?.code == "unavailable" -> getString(R.string.dev_unavailable)
        else -> getString(R.string.dev_retry, f?.message.orEmpty())
    }
    private fun startPairing() { pair.reset(); pairUncertain = false; pairDraft = null; showRoute("connect") }
    private fun useSummary(d: Device): String {
        if (d.revoked) return getString(R.string.dev_access_revoked)
        val actions = ArrayList<String>()
        fun has(vararg prefixes: String) = d.capabilities.any { capability -> prefixes.any(capability::startsWith) }
        if (d.lend) {
            if (has("screen.read", "vscreen.read")) actions += getString(R.string.dev_use_screen)
            if (has("screen.tap", "input.", "vscreen.tap")) actions += getString(R.string.dev_use_input)
            if (has("x.codex.")) actions += getString(R.string.dev_use_codex)
            if (has("browser.", "x.android.browser.", "x.kimi.", "x.ego.")) actions += getString(R.string.dev_use_browser)
            if (has("camera.")) actions += getString(R.string.dev_use_camera)
            if (has("media.")) actions += getString(R.string.dev_use_media)
        }
        if (d.body) actions += getString(R.string.dev_allowed_body)
        if (d.localAgents) actions += getString(R.string.dev_allowed_agents)
        if (actions.isEmpty()) return accessDescription(d)
        return getString(if (d.online) R.string.dev_use_now else R.string.dev_use_when_online, actions.joinToString("、"))
    }
    private fun latencyText(connections: org.json.JSONArray?, device: String): String {
        val samples = (0 until (connections?.length() ?: 0)).mapNotNull { connections?.optJSONObject(it) }
            .filter { connection ->
                val channels = connection.optJSONArray("channels")
                connection.optString("hand") == device.removePrefix("device:") &&
                    (0 until (channels?.length() ?: 0)).any { channels?.optString(it) in setOf("device", "agent") }
            }.mapNotNull { connection ->
                val sample = connection.optJSONObject("latency") ?: return@mapNotNull null
                val rtt = sample.optDouble("rtt_ms", Double.NaN); val age = sample.optDouble("age_ms", Double.NaN)
                if (!rtt.isFinite() || !age.isFinite() || rtt < 0 || age < 0) null
                else getString(R.string.dev_diag_latency_sample, rtt, (age / 1000).toLong())
            }
        return samples.joinToString("\n").ifEmpty { getString(R.string.dev_diag_latency_unknown) }
    }
    private fun relaySummary(): String {
        val relay = model.relay
        return if (relay?.configured == true && !relay.connected) getString(R.string.dev_relay_down_next)
            else DevicesText.relay(relay).first
    }
    private fun capabilities(d: Device): String {
        val names = DevicesText.abilities(d.capabilities)
        return if (names.isEmpty()) getString(R.string.dev_access_unknown) else getString(R.string.dev_capabilities, names.joinToString("、"))
    }
    private fun accessDescription(d: Device): String {
        if (d.revoked) return getString(R.string.dev_access_revoked)
        val allowed = listOfNotNull(
            getString(R.string.dev_allowed_capabilities).takeIf { d.lend },
            getString(R.string.dev_allowed_body).takeIf { d.body },
            getString(R.string.dev_allowed_agents).takeIf { d.localAgents },
        )
        return if (allowed.isEmpty()) getString(R.string.dev_access_none) else getString(R.string.dev_access_allowed, allowed.joinToString("、"))
    }
    private fun attention(d: Device): String = when {
        d.revoked -> getString(R.string.dev_access_revoked)
        !d.online -> getString(R.string.dev_offline_next)
        !d.lend && !d.body && !d.localAgents -> getString(R.string.dev_access_none)
        newerRelease(d) && d.updating == null -> getString(R.string.dev_update_available)
        else -> ""
    }
    private fun newerRelease(d: Device) = d.latest == false && !model.release.isNullOrEmpty() && model.release != d.version
    private fun isUnknown(f: HumanPort.Failure?) = f?.code in setOf("result_unknown", "timeout", "offline")
    private fun visible(show: Boolean) = if (show) View.VISIBLE else View.GONE
    private fun subText(value: String) = AshUi.text(this, value, AshTokens.Type.sub).apply {
        setPadding(0, dp(AshTokens.Space.xs), 0, dp(AshTokens.Space.xs))
    }
    private fun text(value: String, heading: Boolean = false) = AshUi.text(this, value, if (heading) AshTokens.Type.headline else AshTokens.Type.body).apply {
        setPadding(0, dp(AshTokens.Space.xs), 0, dp(AshTokens.Space.xs))
    }
    private fun column() = AshUi.vstack(this, AshTokens.Space.xs).apply { setPadding(dp(AshTokens.Space.pageX), 0, dp(AshTokens.Space.pageX), dp(AshTokens.Space.lg)) }
    private fun section(value: String) = column().apply { addView(text(value)) }
    private fun scroll(child: View) = ScrollView(this).apply { isFillViewport = true; addView(child) }
    private fun button(label: Int, vararg args: Any, action: () -> Unit) = AshUi.button(this, getString(label, *args), AshUi.Kind.NEUTRAL, block = true, onClick = action)
}
