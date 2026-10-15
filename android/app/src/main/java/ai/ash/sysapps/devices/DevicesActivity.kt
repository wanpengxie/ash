package ai.ash.sysapps.devices

import ai.ash.R
import ai.ash.link.Link
import ai.ash.sysapps.SystemAppActivity
import ai.ash.sysapps.AppAccent
import ai.ash.sysapps.AppIdentity
import ai.ash.sysapps.AppDestination
import ai.ash.sysapps.AppUi
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
import android.view.ViewGroup
import android.view.Gravity
import android.graphics.Rect
import android.widget.ImageView
import android.widget.PopupMenu
import android.view.WindowManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import org.json.JSONObject

/** Device app, APPS-R1 §1; MOBILE-ARCH §2–3, §5–6. All business actions use the hub. */
open class DevicesActivity : SystemAppActivity() {
    override val appIdentity = AppIdentity("设备", R.drawable.ash_ic_laptop, AppAccent.TEAL)
    private lateinit var model: DevicesState
    private val pair = PairFlow()
    private lateinit var list: RecyclerView
    private lateinit var rows: KeyedRowsAdapter
    private var route = ""
    private var space = "now"
    private var pairsLoaded = false
    private var devicesConfirmedAt: Long? = null
    private val anchors = HashMap<String, Pair<String, Int>>()
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
        space = saved?.getString("space") ?: "now"
        pairUncertain = saved?.getBoolean("pairUncertain") ?: false
        pairDraft = saved?.getString("pairDraft")
        pairingKind = saved?.getString("pairKind") ?: "computer"
        model.showRevoked = saved?.getBoolean("revoked") ?: false
        restoreKey = saved?.getString("anchor"); restoreOffset = saved?.getInt("offset") ?: 0
        (saved?.getString("pair") ?: route.takeIf { it.startsWith("p/") }?.removePrefix("p/"))?.let(pair::resume)
        list = RecyclerView(this).apply {
            layoutManager = GridLayoutManager(this@DevicesActivity, 2).apply {
                spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
                    override fun getSpanSize(position: Int) = if (::rows.isInitialized && rows.currentList.getOrNull(position)?.key?.startsWith("device:") == true) 1 else 2
                }
            }
            addItemDecoration(object : RecyclerView.ItemDecoration() {
                override fun getItemOffsets(out: Rect, view: View, parent: RecyclerView, state: RecyclerView.State) {
                    val params = view.layoutParams as? GridLayoutManager.LayoutParams ?: return
                    out.bottom = dp(10)
                    if (params.spanSize == 1) { out.left = if (params.spanIndex == 0) 0 else dp(5); out.right = if (params.spanIndex == 0) dp(5) else 0 }
                }
            })
            setPadding(dp(AshTokens.Space.pageX), 0, dp(AshTokens.Space.pageX), 0)
            clipToPadding = false
        }
        rows = KeyedRowsAdapter(this).apply { stateRestorationPolicy = RecyclerView.Adapter.StateRestorationPolicy.PREVENT_WHEN_EMPTY }
        list.adapter = rows
        setDestinations(listOf(AppDestination("now", getString(R.string.dev_now), R.drawable.ash_ic_laptop), AppDestination("permissions", getString(R.string.dev_permissions), R.drawable.ash_ic_shield)), space, ::switchSpace)
        setStatus(getString(R.string.dev_loading))
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
        out.putString("space", space)
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
        return when { raw == "permissions" -> raw
            raw == "connect" || raw.startsWith("p/") -> raw
            raw.startsWith("d/") -> "d/" + canonicalId(raw.removePrefix("d/"))
            raw.startsWith("device:") -> "d/$raw"
            else -> "" }
    }
    private fun canonicalId(id: String) = if (id.startsWith("device:")) id else "device:$id"

    private fun rememberPlace() {
        val lm = list.layoutManager as LinearLayoutManager
        val pos = lm.findFirstVisibleItemPosition()
        rows.currentList.getOrNull(pos)?.let { row -> lm.findViewByPosition(pos)?.let { anchors[space] = row.key to (lm.getDecoratedTop(it) - list.paddingTop) } }
    }
    private fun switchSpace(next: String) {
        if (space == next && route.isEmpty()) return
        if (route.isEmpty()) rememberPlace()
        space = next
        anchors[space]?.let { restoreKey = it.first; restoreOffset = it.second }
        showRoute("")
    }
    private fun showRoute(next: String) {
        if (route.isEmpty() && next.isNotEmpty()) rememberPlace()
        if (next == "permissions") space = "permissions"
        confirmation?.dismiss(); confirmation = null
        routeGeneration++; route = if (next == "permissions") "" else next; detail = null; pairing = null; note = ""
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
                showPage(getString(R.string.dev_title))
                selectDestination(space)
                actions.removeAllViews()
                actions.addView(AshUi.iconButton(this, getDrawable(R.drawable.ash_ic_slider)!!, getString(R.string.dev_more)) { showRootMenu() })
                anchors[space]?.let { restoreKey = it.first; restoreOffset = it.second }
                (list.parent as? android.view.ViewGroup)?.removeView(list)
                content.addView(list)
            }
            route.startsWith("d/") -> {
                showPage(getString(R.string.dev_detail_title), detail = true, showNavigation = false)
                setStatus(null)
                actions.removeAllViews()
                actions.addView(AshUi.iconButton(this, getDrawable(R.drawable.ash_ic_more)!!, getString(R.string.dev_detail_more)) { detail?.more() })
                detail = Detail(route.removePrefix("d/"))
                content.addView(scroll(detail!!.root))
                readChanges(route.removePrefix("d/"))
            }
            else -> {
                showPage(getString(R.string.dev_connect), detail = true, showNavigation = false)
                setStatus(null)
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
        val reviewedDetail = detail?.takeIf { what == Refresh.DEVICES && it.needsConnectionReview() }
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
            val devicesAccepted = when (what) {
                Refresh.DEVICES -> model.devicesRead(gen, valid)
                Refresh.RELAY -> { model.relayRead(gen, valid); false }
                Refresh.PAIRS -> { model.requestsRead(gen, valid); if (valid != null) pairsLoaded = true; false }
            }
            if (valid == null) readErrors[what] = error(failure) else if (failure == null) {
                readErrors.remove(what)
                if (devicesAccepted) devicesConfirmedAt = System.currentTimeMillis()
                if (devicesAccepted && reviewedDetail === detail && reviewedDetail?.id?.let(model::device) != null) reviewedDetail?.connectionReadSucceeded()
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

    private fun showRootMenu() {
        val choices = arrayOf(getString(R.string.dev_refresh), getString(R.string.dev_relay_title), getString(R.string.dev_connect), getString(R.string.dev_revoked_list))
        AlertDialog.Builder(this).setTitle(R.string.dev_title).setItems(choices) { _, index -> when (index) {
            0 -> { Refresh.entries.forEach(::read); readPair(manual = true) }
            1 -> showRelay()
            2 -> startPairing()
            3 -> { model.showRevoked = true; switchSpace("permissions"); render() }
        } }.show()
    }
    private fun showPairRequests() {
        val pending = model.requests.toList()
        if (pending.isEmpty()) return
        AlertDialog.Builder(this).setTitle(R.string.dev_requests).setItems(pending.map { it.name.ifEmpty { DevicesText.kind(it.kind) } }.toTypedArray()) { _, which ->
            val requested = pending[which]
            if (requested.pairId != pair.pairId) { pairDraft = null; pairUncertain = false; pair.reset(); pair.resume(requested.pairId) }
            showRoute("p/${requested.pairId}"); readPair()
        }.setNegativeButton(R.string.dev_cancel, null).show()
    }
    private fun showRelay() {
        val relay = model.relay
        AlertDialog.Builder(this).setTitle(R.string.dev_relay_title)
            .setMessage(listOfNotNull(relaySummary(), relay?.url, relay?.error, model.release?.let { getString(R.string.dev_hub_release, it) }).distinct().joinToString("\n"))
            .setPositiveButton(R.string.dev_refresh) { _, _ -> Refresh.entries.forEach(::read) }
            .setNeutralButton(R.string.dev_relay_help) { _, _ ->
                val agent = primary
                if (agent != null) request("service:agents", "tell", JSONObject().put("agent", agent).put("text", getString(R.string.dev_relay_request))) { _, failure -> note = if (failure == null) getString(R.string.dev_told) else error(failure); render() }
                else { note = getString(R.string.dev_agent_unavailable); render() }
            }.setNegativeButton(R.string.dev_close, null).show()
    }
    private fun ensureHomePair() {
        if (space != "now") return
        val pending = model.requests.firstOrNull { it.pairId == pair.pairId } ?: model.requests.firstOrNull()
        if (pending != null && pending.pairId != pair.pairId && pair.step !is PairFlow.Step.Approved && pair.step !is PairFlow.Step.Approving) {
            routeGeneration++; pair.reset(); pair.resume(pending.pairId); pairDraft = null; pairUncertain = false
            readingPair = false; pairing = null
        }
        val show = pending != null || pair.step is PairFlow.Step.Approved || pair.step is PairFlow.Step.Approving
        if (show && pairing == null) { pairing = Pairing(compact = true); readPair() }
    }
    private fun render() {
        if (!active) return
        if (route.isEmpty()) {
            ensureHomePair()
            val contentRows = ArrayList<ChatRow>()
            setStatus(getString(R.string.dev_recent_confirm, relaySummary()),
                if (model.requests.isNotEmpty()) getString(R.string.dev_request_count, model.requests.size) else null) { showPairRequests() }
            if (space == "now") {
                val flow = pair.step
                if (pairing?.compact == true && flow !is PairFlow.Step.Connected && flow !is PairFlow.Step.Ended) {
                    val shownPair = pairing!!
                    shownPair.bind()
                    contentRows += ChatRow("pair/${pair.pairId}", flow.toString()) { shownPair.root }
                } else if (pairsLoaded && model.requests.isEmpty() && Refresh.PAIRS !in readErrors) {
                    contentRows += ChatRow("quiet", "quiet") { AshUi.text(this, getString(R.string.dev_quiet), AshTokens.Type.sub, c.text2).apply { setPadding(0, dp(12), 0, dp(16)) } }
                }
            }
            contentRows += ChatRow("heading", space) { sectionHeading(getString(if (space == "now") R.string.dev_your_devices else R.string.dev_permissions_title), getString(R.string.dev_connection_separate)) }
            val snapshot = model.rows(System.currentTimeMillis())
            snapshot.filterIsInstance<DevicesState.Row.Item>().forEach { row -> contentRows += ChatRow(row.key, row.toString() + space) { deviceTile(row.device, row.presence, row.abilities) } }
            snapshot.filterIsInstance<DevicesState.Row.Note>().forEach { row -> contentRows += ChatRow(row.key, row.text) { AshUi.text(this, row.text, AshTokens.Type.callout, c.text2) } }
            snapshot.filterIsInstance<DevicesState.Row.ShowRevoked>().forEach { row -> contentRows += ChatRow(row.key, row.toString()) { button(if (row.shown) R.string.dev_hide_revoked else R.string.dev_show_revoked, row.count) { model.showRevoked = !model.showRevoked; render() } } }
            if (space == "now") contentRows += ChatRow("connect", "connect") { linkButton(R.string.dev_connect_new, R.drawable.ash_ic_plus) { startPairing() } }
            else contentRows += ChatRow("relay", model.relay.toString()) { linkButton(R.string.dev_relay_title, R.drawable.ash_ic_globe) { showRelay() } }
            readErrors.forEach { (key, message) -> contentRows += ChatRow("error/$key", message) { AshUi.text(this, message, AshTokens.Type.callout, c.err) } }
            if (note.isNotEmpty()) contentRows += ChatRow("feedback", note) { AshUi.text(this, note, AshTokens.Type.callout) }
            rows.submitList(contentRows) {
                restoreKey?.let { key ->
                    val position = rows.currentList.indexOfFirst { it.key == key }
                    if (position >= 0) { (list.layoutManager as LinearLayoutManager).scrollToPositionWithOffset(position, restoreOffset); restoreKey = null }
                }
            }
        } else { detail?.bind(); pairing?.bind() }
    }
    private fun deviceTile(d: Device, presence: String, abilities: List<String>): View = surface(12).apply {
        minimumHeight = dp(176)
        contentDescription = getString(R.string.dev_open_named, d.name)
        isClickable = true; isFocusable = true
        AshUi.role(this, android.widget.Button::class.java.name)
        addView(DeviceObjectView(this@DevicesActivity, d.kind), LinearLayout.LayoutParams(-1, dp(72)))
        addView(AshUi.text(this@DevicesActivity, d.name, AshTokens.Type.headline, c.ink))
        addView(AshUi.text(this@DevicesActivity, devicePresence(d), AshTokens.Type.sub, if (d.online && !d.revoked) accent else c.text2))
        val names = abilities.take(2)
        if (names.isNotEmpty()) addView(AshUi.hstack(this@DevicesActivity, 8).apply {
            setPadding(0, dp(8), 0, 0)
            names.forEach { name -> addView(AshUi.vstack(this@DevicesActivity, 4).apply {
                addView(icon(abilityIcon(name), 18), LinearLayout.LayoutParams(-2, dp(20)))
                addView(AshUi.text(this@DevicesActivity, name, AshTokens.Type.sub, c.text2))
            }, LinearLayout.LayoutParams(0, -2, 1f)) }
        })
        if (space == "permissions") addView(AshUi.text(this@DevicesActivity, accessDescription(d), AshTokens.Type.sub, c.text2))
        setOnClickListener { showRoute("d/${d.id}") }
    }

    /** A small static form; this instance stays attached while events update labels around the active edit field. */
    private inner class Detail(val id: String) {
        val root = column()
        private val header = AshUi.text(this@DevicesActivity, getString(R.string.dev_loading), AshTokens.Type.title, c.ink)
        private val presenceLabel = AshUi.text(this@DevicesActivity, "", AshTokens.Type.sub, c.text2)
        private val identity = AshUi.hstack(this@DevicesActivity, 16)
        private val deviceObject = DeviceObjectView(this@DevicesActivity, "computer")
        private val notice = surface(16)
        private val status = text("")
        private val nextStep = text("")
        private val settings = AshUi.vstack(this@DevicesActivity, 8).apply { visibility = View.GONE }
        private var settingsOpen = false
        private val settingsToggle: TextView = button(R.string.dev_rename_action) {
            settingsOpen = !settingsOpen
            settings.visibility = visible(settingsOpen)
            settingsToggleButton().text = getString(if (settingsOpen) R.string.dev_settings_hide else R.string.dev_rename_action)
        }
        private fun settingsToggleButton() = settingsToggle
        private val change = subText("").apply { visibility = View.GONE }
        private var historyOpen = false
        private val changesToggle = linkButton(R.string.dev_known_changes, R.drawable.ash_ic_down) {
            historyOpen = !historyOpen; change.visibility = visible(historyOpen)
        }
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
        private var diagnosisIssue: String? = null
        private val diagnosisRaw = text("").apply { setTextIsSelectable(true); visibility = View.GONE }
        private var rawOpen = false
        private val diagnosisToggle: TextView = button(R.string.dev_diag_details) {
            rawOpen = !rawOpen; diagnosisRaw.visibility = visible(rawOpen)
            diagnosisToggleButton().text = getString(if (rawOpen) R.string.dev_diag_hide_details else R.string.dev_diag_details)
        }
        private fun diagnosisToggleButton() = diagnosisToggle
        private val diagnose = button(R.string.dev_check_connection) {
            read(Refresh.DEVICES); read(Refresh.RELAY); diagnose()
        }
        private val revokeNote = text("")
        private val restore: TextView = AppUi.button(this@DevicesActivity, getString(R.string.dev_restore), AppAccent.TEAL, primary = false) {
            run("restore", restoreButton(), revokeNote)
        }.apply { visibility = View.GONE }
        private fun restoreButton() = restore
        private val revoke: TextView = button(R.string.dev_revoke) {
            val d = model.device(id) ?: return@button
            if (d.revoked) run("restore", revokeButton(), revokeNote)
            else confirmation = AlertDialog.Builder(this@DevicesActivity).setTitle(getString(R.string.dev_revoke_named, d.name)).setMessage(R.string.dev_revoke_help)
                .setNegativeButton(R.string.dev_cancel, null).setPositiveButton(R.string.dev_confirm) { _, _ ->
                    if (detail === this) run("revoke", revokeButton(), revokeNote)
                }.show()
        }
        private fun revokeButton() = revoke
        private val pending = HashSet<String>()
        private val unknown = HashSet<String>()
        init {
            identity.setPadding(0, dp(8), 0, dp(16))
            identity.addView(deviceObject, LinearLayout.LayoutParams(dp(80), dp(72)))
            identity.addView(AshUi.vstack(this@DevicesActivity, 4).apply { addView(header); addView(presenceLabel) }, LinearLayout.LayoutParams(0, -2, 1f))
            root.addView(identity)
            notice.addView(status); notice.addView(nextStep); notice.addView(diagnose); notice.addView(restore); notice.addView(revokeNote)
            root.addView(notice)
            root.addView(diagnosis); root.addView(diagnosisToggle.apply { visibility = View.GONE }); root.addView(diagnosisRaw)
            root.addView(sectionHeading(getString(R.string.dev_permissions_question)))
            root.addView(access.root)
            root.addView(sectionHeading(getString(R.string.dev_program_changes)))
            root.addView(versionInfo); root.addView(update); root.addView(updateNote); root.addView(changesToggle); root.addView(change)
            root.addView(AshUi.hstack(this@DevicesActivity, 8).apply {
                addView(settingsToggle, LinearLayout.LayoutParams(0, -2, 1f)); addView(revoke, LinearLayout.LayoutParams(0, -2, 1f))
            })
            root.addView(settings)
            listOf(AshUi.text(this@DevicesActivity, getString(R.string.dev_name), AshTokens.Type.sub), name, saveName, nameNote, abilities).forEach(settings::addView)
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
        fun more() {
            val d = model.device(id) ?: return
            AlertDialog.Builder(this@DevicesActivity).setTitle(d.name).setItems(arrayOf(getString(R.string.dev_rename_action), getString(R.string.dev_diagnose), getString(if (d.revoked) R.string.dev_restore else R.string.dev_revoke))) { _, which -> when (which) {
                0 -> { if (!settingsOpen) settingsToggle.performClick(); name.requestFocus(); name.post { name.requestRectangleOnScreen(Rect(0, 0, name.width, name.height), true) } }
                1 -> diagnose.performClick()
                2 -> if (d.revoked) restore.performClick() else revoke.performClick()
            } }.setNegativeButton(R.string.dev_cancel, null).show()
        }
        private fun keepDraft(value: String?) { UiIo.disk { prefs.edit().apply { if (value == null) remove("name/$id") else putString("name/$id", value) }.apply() } }
        private fun setName(value: String) { settingName = true; name.setText(value); settingName = false; nameLoaded = true }
        fun bind() {
            val d = model.device(id)
            if (d == null) { header.text = getString(if (model.devices == null) R.string.dev_loading else R.string.dev_missing); name.isEnabled = false; saveName.isEnabled = false; access.enabled(false); update.isEnabled = false; diagnose.isEnabled = false; revoke.isEnabled = false; restore.visibility = View.GONE; return }
            header.text = d.name
            deviceObject.kind = d.kind
            presenceLabel.text = devicePresence(d)
            if (diagnosisState != null && diagnosisState != (d.online to d.revoked) && "diagnose" !in pending) clearDiagnosis()
            val noAccess = !d.lend && !d.body && !d.localAgents
            val impact = when { d.revoked -> getString(R.string.dev_detail_revoked); diagnosisIssue != null -> getString(R.string.dev_detail_connection_review); noAccess -> getString(R.string.dev_detail_no_access); else -> useSummary(d) }
            val presence = if (diagnosisIssue != null && !d.revoked) getString(R.string.dev_connection_check_needed) else DevicesText.presence(d, System.currentTimeMillis())
            status.text = listOfNotNull(presence, impact, readErrors[Refresh.DEVICES], getString(R.string.dev_busy_rebuild).takeIf { unknown.isNotEmpty() }).filter { it.isNotEmpty() }.distinct().joinToString("\n")
            nextStep.text = when {
                d.revoked -> getString(R.string.dev_detail_restore_next, d.name)
                diagnosisIssue != null -> diagnosisIssue.orEmpty()
                !d.online -> getString(R.string.dev_detail_offline_next, d.name, DevicesText.kind(d.kind))
                noAccess -> getString(R.string.dev_detail_access_next)
                else -> getString(R.string.dev_detail_online_next)
            }
            change.text = model.changes[id]?.let { DevicesText.change(it, primary, System.currentTimeMillis()) }.orEmpty()
            abilities.text = capabilities(d)
            versionInfo.text = DevicesText.version(d, model.release) ?: getString(R.string.dev_version_unknown)
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
            listOf(nameNote, versionInfo, updateNote, diagnosis, revokeNote).forEach { it.visibility = visible(it.text.isNotEmpty()) }
            change.visibility = visible(historyOpen)
            if (change.text.isEmpty()) change.text = getString(R.string.dev_no_changes)
            if (restoring) { name.isEnabled = false; saveName.isEnabled = false; access.enabled(false); update.isEnabled = false; revoke.isEnabled = false }
        }
        fun needsConnectionReview() = diagnosisIssue != null
        fun connectionReadSucceeded() { if ("diagnose" !in pending) clearDiagnosis() }
        private fun clearDiagnosis() {
            diagnosisIssue = null; diagnosisState = null; rawOpen = false
            diagnosis.text = ""; diagnosisRaw.text = ""; diagnosisRaw.visibility = View.GONE; diagnosisToggle.visibility = View.GONE
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
                if (data == null) { pending.remove("diagnose"); diagnosis.text = error(failure); diagnosisIssue = getString(R.string.dev_diag_incomplete); model.begin(Refresh.DEVICES); diagnosisState = model.device(id)?.let { it.online to it.revoked }; bind(); return@request }
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
                    val conclusionText = if (conclusion == R.string.dev_diag_tunnel_missing) getString(conclusion, d?.name.orEmpty()) else getString(conclusion)
                    diagnosisIssue = conclusionText.takeIf { conclusion != R.string.dev_diag_connected }
                    // A list already in flight predates this finding. Reuse the existing read ordering to discard it.
                    if (diagnosisIssue != null) model.begin(Refresh.DEVICES)
                    // A failure's conclusion and recovery steps are already above the primary action.
                    // Revoked devices show their restore guidance there, so keep that diagnosis conclusion below.
                    diagnosis.text = if (diagnosisIssue != null && d?.revoked != true)
                        getString(R.string.dev_diag_metrics, relaySummary(), count, latencyText(conns, id))
                    else getString(R.string.dev_diag_layout, conclusionText, relaySummary(), count, latencyText(conns, id))
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
        val root = AshUi.vstack(this@DevicesActivity)
        private val advanced = AshUi.vstack(this@DevicesActivity).apply { visibility = View.GONE }
        private var advancedOpen = false
        private val values = linkedMapOf("lend" to R.string.dev_lend, "body" to R.string.dev_body, "local_agents" to R.string.dev_agents, "tier" to R.string.dev_full)
        private val selected = values.keys.associateWith { it == "lend" }.toMutableMap()
        private val messages = values.mapValues { AshUi.text(this@DevicesActivity, "", AshTokens.Type.sub, c.text2).apply { visibility = View.GONE } }
        private val controls = values.mapValues { (key, label) ->
            button(R.string.dev_permission_allow).apply {
                contentDescription = getString(label)
                val control = this
                setOnClickListener {
                    PopupMenu(this@DevicesActivity, this).apply {
                        menu.add(0, 1, 0, R.string.dev_permission_allow)
                        menu.add(0, 0, 1, R.string.dev_permission_off)
                        setOnMenuItemClickListener { item ->
                            val on = item.itemId == 1
                            if (on != selected.getValue(key)) {
                                selected[key] = on; bindControl(key)
                                val value: Any = if (key == "tier") (if (on) "full" else "ask") else on
                                messages.getValue(key).visibility = visible(changed != null)
                                changed?.invoke(key, value, control, messages.getValue(key))
                                advancedLabel()
                            }
                            true
                        }
                    }.show()
                }
            }
        }
        private val groups = LinkedHashMap<String, View>()
        private val approval = AshUi.text(this@DevicesActivity, "", AshTokens.Type.sub, c.text2)
        private val advancedToggle: TextView = linkButton(R.string.dev_advanced_boundary, R.drawable.ash_ic_shield) {
            advancedOpen = !advancedOpen; advanced.visibility = visible(advancedOpen); advancedLabel()
        }
        init {
            val helps = listOf(R.string.dev_lend_help, R.string.dev_body_help, R.string.dev_agents_help, R.string.dev_full_help)
            values.entries.forEachIndexed { i, (key, label) ->
                val row = AshUi.hstack(this@DevicesActivity, 12).apply {
                    setPadding(0, dp(8), 0, dp(8)); minimumHeight = dp(66)
                    addView(icon(if (key == "body") R.drawable.ash_ic_folder else if (key == "lend") R.drawable.ash_ic_eye else R.drawable.ash_ic_shield), LinearLayout.LayoutParams(dp(22), dp(22)))
                    addView(AshUi.vstack(this@DevicesActivity, 4).apply {
                        addView(AshUi.text(this@DevicesActivity, getString(label), AshTokens.Type.body))
                        addView(AshUi.text(this@DevicesActivity, getString(helps[i]), AshTokens.Type.sub, c.text2))
                    }, LinearLayout.LayoutParams(0, -2, 1f))
                    addView(controls.getValue(key), LinearLayout.LayoutParams(dp(78), -2))
                }
                val group = AshUi.vstack(this@DevicesActivity).apply { addView(rule()); addView(row); addView(messages.getValue(key)) }
                groups[key] = group
                (if (key == "local_agents" || key == "tier") advanced else root).addView(group)
                bindControl(key)
            }
            root.addView(advancedToggle); root.addView(approval); root.addView(advanced)
            advancedLabel()
        }
        private fun bindControl(key: String) {
            controls.getValue(key).apply {
                text = getString(if (selected.getValue(key)) R.string.dev_permission_allow else R.string.dev_permission_off)
                isSelected = selected.getValue(key)
                AshUi.style(this, AshTokens.Type.callout, c.text)
                compoundDrawablePadding = dp(4)
                setCompoundDrawablesRelative(null, null, getDrawable(R.drawable.ash_ic_down)?.mutate()?.apply { setTint(c.text2); setBounds(0, 0, dp(16), dp(16)) }, null)
                background = AshUi.rounded(c.surface, dp(12).toFloat(), c.line2, dp(1))
                setPadding(dp(8), dp(8), dp(8), dp(8))
            }
        }
        private fun advancedLabel() {
            advancedToggle.text = getString(if (advancedOpen) R.string.dev_advanced_hide else R.string.dev_advanced_boundary)
            approval.text = getString(if (selected.getValue("tier")) R.string.dev_approval_full else R.string.dev_approval_ask) + if (selected.getValue("local_agents")) getString(R.string.dev_approval_agents) else ""
        }
        fun bind(d: Device) {
            selected.putAll(mapOf("lend" to d.lend, "body" to d.body, "local_agents" to d.localAgents, "tier" to (d.tier == "full")))
            groups.getValue("body").visibility = visible(d.isComputer || d.capabilities.any { it.startsWith("workspace.") || it == "body.info" })
            values.keys.forEach(::bindControl); advancedLabel()
        }
        fun enabled(enabled: Boolean) { controls.values.forEach { it.isEnabled = enabled; it.alpha = if (enabled) 1f else 0.4f } }
        fun restore(value: String?) {
            val data = value?.let { runCatching { JSONObject(it) }.getOrNull() } ?: return
            selected.keys.forEach { key -> selected[key] = if (key == "tier") data.optString(key) == "full" else data.optBoolean(key) }
            values.keys.forEach(::bindControl); advancedLabel()
        }
        fun args() = JSONObject().put("tier", if (selected.getValue("tier")) "full" else "ask").also { o -> listOf("lend", "body", "local_agents").forEach { o.put(it, selected.getValue(it)) } }
    }

    private inner class Pairing(val compact: Boolean = false) {
        val root = if (compact) AshUi.vstack(this@DevicesActivity, 8) else column()
        private val decision = surface(16)
        private val pairName = AshUi.text(this@DevicesActivity, "", AshTokens.Type.headline, c.ink)
        private val pairScope = AshUi.text(this@DevicesActivity, "", AshTokens.Type.sub, c.text2)
        private val decisionLabel = AshUi.text(this@DevicesActivity, getString(R.string.dev_pair_decision_label), AshTokens.Type.sub, c.text2)
        private val question = AshUi.text(this@DevicesActivity, getString(R.string.dev_pair_question), AshTokens.Type.headline, c.ink)
        private var scopeOpen = false
        private val scopeButton = linkButton(R.string.dev_adjust_pair_scope, R.drawable.ash_ic_shield) {
            scopeOpen = !scopeOpen; bind()
        }
        val result = text("")
        private val explanation = text(getString(R.string.dev_pair_intro))
        private val command = text("").apply { setTextIsSelectable(true); isSaveEnabled = false }
        private val connectedAbilities = text("")
        private val computer = button(R.string.dev_computer) { pairingKind = "computer"; kindState() }
        private val server = button(R.string.dev_server) { pairingKind = "server"; kindState() }
        private val kinds = AshUi.hstack(this@DevicesActivity, AshTokens.Space.xs).apply {
            addView(computer, LinearLayout.LayoutParams(0, -2, 1f)); addView(server, LinearLayout.LayoutParams(0, -2, 1f))
        }
        private val issue = AppUi.button(this@DevicesActivity, getString(R.string.dev_issue), AppAccent.TEAL) { issue() }
        private val copy: TextView = AppUi.button(this@DevicesActivity, getString(R.string.dev_copy), AppAccent.TEAL) {
            val waiting = pair.step as? PairFlow.Step.Waiting ?: return@button
            if (waiting.command.isEmpty() || pair.expiredBy(System.currentTimeMillis())) return@button
            copyButton().isEnabled = false
            request(Link.get(this@DevicesActivity).deviceId, "clipboard.set", JSONObject().put("text", waiting.command)) { _, failure ->
                if (pairing === this) { result.text = if (failure == null) getString(R.string.dev_copied) else error(failure); copyButton().isEnabled = true }
            }
        }
        private fun copyButton() = copy
        private val permissions: AccessForm = AccessForm { _, _, _, _ -> pairDraft = permissions.args().toString(); bind() }
        private val approve = AppUi.button(this@DevicesActivity, getString(R.string.dev_allow_connection), AppAccent.TEAL) { decide(true) }
        private val reject = button(R.string.dev_reject) { decide(false) }
        private val restart = button(R.string.dev_restart) { pair.reset(); pairUncertain = false; result.text = ""; bind() }
        private val open = AppUi.button(this@DevicesActivity, getString(R.string.dev_open_device), AppAccent.TEAL) {
            val id = (pair.step as? PairFlow.Step.Connected)?.device ?: (pair.step as? PairFlow.Step.Approved)?.device
            if (!id.isNullOrEmpty()) showRoute("d/$id")
        }
        private var deciding = false
        init {
            permissions.restore(pairDraft)
            if (compact) {
                decision.addView(AshUi.hstack(this@DevicesActivity, 8).apply {
                    addView(icon(R.drawable.ash_ic_check, 20)); addView(decisionLabel)
                })
                decision.addView(question)
                decision.addView(AshUi.hstack(this@DevicesActivity, 16).apply {
                    addView(DeviceObjectView(this@DevicesActivity, "computer"), LinearLayout.LayoutParams(dp(64), dp(56)))
                    addView(pairName, LinearLayout.LayoutParams(0, -2, 1f))
                })
                decision.addView(explanation); decision.addView(pairScope)
                decision.addView(AshUi.text(this@DevicesActivity, getString(R.string.dev_pair_consequence), AshTokens.Type.sub, c.text2))
                decision.addView(AshUi.hstack(this@DevicesActivity, 8).apply { addView(approve, LinearLayout.LayoutParams(0, -2, 1f)); addView(reject, LinearLayout.LayoutParams(0, -2, 1f)) })
                decision.addView(result); decision.addView(connectedAbilities); decision.addView(open)
                root.addView(decision); root.addView(scopeButton); root.addView(permissions.root)
            } else {
                listOf(kinds, explanation, issue, command, copy, permissions.root, approve, reject, connectedAbilities, result, open, restart).forEach(root::addView)
            }
            kindState()
        }
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
            decisionLabel.text = getString(if (s is PairFlow.Step.Asking) R.string.dev_pair_decision_label else R.string.dev_pair_progress)
            question.text = getString(if (s is PairFlow.Step.Approved) R.string.dev_pair_waiting_online else R.string.dev_pair_question)
            permissions.root.visibility = visible(asking && (!compact || scopeOpen))
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
            val request = model.requests.firstOrNull { it.pairId == pair.pairId }
            when (s) {
                is PairFlow.Step.Asking -> pairName.text = s.name.ifEmpty { request?.name.orEmpty() }
                is PairFlow.Step.Approving -> pairName.text = s.name
                else -> if (pairName.text.isEmpty()) pairName.text = request?.name.orEmpty()
            }
            val scopes = permissions.args()
            pairScope.text = getString(R.string.dev_pair_scope_summary, getString(if (scopes.optBoolean("lend")) R.string.dev_permission_allow else R.string.dev_permission_off), getString(if (scopes.optBoolean("body")) R.string.dev_permission_allow else R.string.dev_permission_off))
            scopeButton.visibility = visible(asking)
            explanation.visibility = visible(!compact || !asking)
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
    private val accent get() = AppAccent.TEAL.color(this)
    private fun surface(padding: Int = 16) = AppUi.surface(this, decision = true).apply {
        setPadding(dp(padding), dp(padding), dp(padding), dp(padding))
    }
    private fun rule() = View(this).apply { setBackgroundColor(c.line); layoutParams = LinearLayout.LayoutParams(-1, dp(1)) }
    private fun icon(resource: Int, size: Int = 22) = AppUi.icon(this, resource, c.text2, size)
    private fun sectionHeading(label: String, note: String? = null) = AshUi.hstack(this, 8).apply {
        setPadding(0, dp(20), 0, dp(8))
        addView(AshUi.text(this@DevicesActivity, label, AshTokens.Type.headline, c.ink), LinearLayout.LayoutParams(0, -2, 1f))
        note?.let { addView(AshUi.text(this@DevicesActivity, it, AshTokens.Type.sub, c.text2)) }
    }
    private fun linkButton(label: Int, image: Int, action: () -> Unit): TextView = AppUi.button(this, getString(label), AppAccent.TEAL, primary = false, click = action).apply {
        setBackgroundColor(android.graphics.Color.TRANSPARENT)
        setTextColor(c.text2); compoundDrawablePadding = dp(8)
        setCompoundDrawablesRelative(getDrawable(image)?.mutate()?.apply { setTint(c.text2); setBounds(0, 0, dp(20), dp(20)) }, null, null, null)
    }
    private fun abilityIcon(name: String) = when (name) { "Codex" -> R.drawable.ash_ic_cpu; "文件和命令" -> R.drawable.ash_ic_folder; "日历" -> R.drawable.ash_ic_clock; else -> R.drawable.ash_ic_eye }
    private fun devicePresence(d: Device) = if (!d.online && !d.revoked && d.lastSeen != null)
        getString(R.string.dev_last_confirmed, timeOf(d.lastSeen)) else DevicesText.presence(d, System.currentTimeMillis())
    private fun timeOf(at: Long) = java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT).format(java.util.Date(at))
    private fun isUnknown(f: HumanPort.Failure?) = f?.code in setOf("result_unknown", "timeout", "offline")
    private fun visible(show: Boolean) = if (show) View.VISIBLE else View.GONE
    private fun subText(value: String) = AshUi.text(this, value, AshTokens.Type.sub).apply {
        setPadding(0, dp(AshTokens.Space.xs), 0, dp(AshTokens.Space.xs))
    }
    private fun text(value: String, heading: Boolean = false) = AshUi.text(this, value, if (heading) AshTokens.Type.headline else AshTokens.Type.body)
    private fun column() = AshUi.vstack(this, AshTokens.Space.xs).apply { setPadding(dp(AshTokens.Space.pageX), 0, dp(AshTokens.Space.pageX), dp(AshTokens.Space.lg)) }
    private fun section(value: String) = column().apply { addView(text(value)) }
    private fun scroll(child: View) = ScrollView(this).apply { isFillViewport = true; addView(child) }
    private fun button(label: Int, vararg args: Any, action: () -> Unit) = AppUi.button(this, getString(label, *args), AppAccent.TEAL, primary = false, click = action).apply { layoutParams = ViewGroup.LayoutParams(-1, -2) }
}
