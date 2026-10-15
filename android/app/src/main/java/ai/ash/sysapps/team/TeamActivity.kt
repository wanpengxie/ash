package ai.ash.sysapps.team

import ai.ash.sysapps.SystemAppActivity
import ai.ash.ui.ChatRow
import ai.ash.ui.HumanCall
import ai.ash.ui.HumanPort
import ai.ash.ui.KeyedRowsAdapter
import ai.ash.ui.UiDrafts
import ai.ash.ui.UiIo
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi
import android.content.Context
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Ash's own team, using the very same hub words as the agents. Never a page of the main conversation. */
class TeamActivity : SystemAppActivity() {
    private val members = TeamModel.Read<List<TeamModel.Member>>()
    private val costs = TeamModel.Read<Map<String, TeamModel.Cost>>()
    private var exchanges = TeamModel.Read<List<TeamModel.Exchange>>()
    private var before: Long? = null
    private var route = "team"
    private var selected: String? = null
    private var target: String? = null
    private var routeGeneration = 0
    private var scrollVersion = 0
    private var active = false
    private var refreshMembers = false
    private var refreshExchanges = false
    private var refreshCosts = false
    private var changedBy: String? = null
    private val opened = HashSet<String>()
    private val busy = HashSet<String>()
    // Process-wide pending state: callbacks from a recreated Activity cannot overwrite its new questions on disk.
    private val pending get() = sharedPending
    private var outboxReady: Boolean
        get() = pendingLoaded
        set(value) { pendingLoaded = value }
    private var restoringTarget = false
    private lateinit var list: RecyclerView
    private lateinit var lm: LinearLayoutManager
    private lateinit var rows: KeyedRowsAdapter
    private lateinit var status: TextView
    private lateinit var targets: Spinner
    private lateinit var input: EditText
    private lateinit var send: TextView
    private lateinit var composer: LinearLayout
    private lateinit var formSlot: LinearLayout
    private var targetIds = emptyList<String>()
    private var extra = emptyList<ChatRow>()
    private var moreExtra: (() -> Unit)? = null
    private var restoringEdit = false
    private var resetPosition = false
    private var sourceRequest: Triple<Long, Boolean, String>? = null
    private var armedAction: String? = null
    private var targetLabels = emptyList<String>()
    private var savedKey: String? = null
    private var savedOffset = 0
    private val drafts by lazy { UiDrafts.get(this) }
    private val prefs by lazy { applicationContext.getSharedPreferences("ash.team.pending", Context.MODE_PRIVATE) }

    override fun build(saved: Bundle?) {
        selected = saved?.getString("member") ?: runCatching { JSONObject(intent.getStringExtra(EXTRA_ARG).orEmpty()).optString("agent").ifBlank { null } }.getOrNull()
        target = saved?.getString("target") ?: selected
        restoringEdit = saved?.getString("route") == "edit"
        route = saved?.getString("route") ?: if (selected == null) "team" else "member"
        if (route !in setOf("team", "member")) route = if (selected == null) "team" else "member"
        savedKey = saved?.getString("anchor"); savedOffset = saved?.getInt("offset") ?: 0
        saved?.getStringArrayList("opened")?.let(opened::addAll)
        title.text = "团队"
        actions.addView(button("刷新") { refresh() })
        actions.addView(button("新建") { edit(null) })
        status = AshUi.text(this, "正在读取团队…", AshTokens.Type.caption, c.text2).apply { minLines = 2; setPadding(dp(16), dp(4), dp(16), dp(4)) }
        lm = LinearLayoutManager(this)
        rows = KeyedRowsAdapter(this).apply { stateRestorationPolicy = RecyclerView.Adapter.StateRestorationPolicy.PREVENT_WHEN_EMPTY }
        list = RecyclerView(this).apply {
            layoutManager = lm; adapter = rows; clipToPadding = false
            setPadding(dp(16), dp(8), dp(16), dp(8))
        }
        list.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrollStateChanged(rv: RecyclerView, state: Int) {
                if (state == RecyclerView.SCROLL_STATE_DRAGGING) {
                    scrollVersion++
                    input.clearFocus()
                    androidx.core.view.ViewCompat.getWindowInsetsController(input)?.hide(androidx.core.view.WindowInsetsCompat.Type.ime())
                }
            }
            override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) { if (rv.scrollState == RecyclerView.SCROLL_STATE_DRAGGING) scrollVersion++ }
        })
        targets = Spinner(this).apply { minimumHeight = dp(48); contentDescription = "点名的团队成员" }
        input = EditText(this).apply { id = View.generateViewId(); hint = "点名对帮手说话"; minHeight = dp(48); maxLines = 4; setTextColor(c.text); setHintTextColor(c.text3) }
        input.addTextChangedListener(watcher { drafts.keep(draftKey(), it) })
        send = button("发送") { sendQuestion() }
        composer = AshUi.vstack(this, 4).apply {
            setPadding(dp(16), dp(4), dp(16), dp(8))
            addView(targets, LinearLayout.LayoutParams(-1, -2))
            addView(AshUi.hstack(this@TeamActivity, 8).apply {
                addView(input, LinearLayout.LayoutParams(0, -2, 1f)); addView(send)
            })
        }
        targets.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(parent: AdapterView<*>?) {}
            override fun onItemSelected(parent: AdapterView<*>?, v: View?, position: Int, id: Long) {
                if (!restoringTarget) targetIds.getOrNull(position)?.let { next -> if (target != next) { target = next; input.setText(drafts.text(draftKey())) } }
            }
        }
        formSlot = AshUi.vstack(this).apply { visibility = View.GONE }
        content.addView(AshUi.vstack(this).apply {
            addView(status, LinearLayout.LayoutParams(-1, -2))
            addView(list, LinearLayout.LayoutParams(-1, 0, 1f))
            addView(formSlot, LinearLayout.LayoutParams(-1, 0, 1f))
            addView(composer, LinearLayout.LayoutParams(-1, -2))
        })
        val appPrefs = prefs
        if (!outboxReady) UiIo.disk {
            val stored = runCatching { JSONArray(appPrefs.getString("questions", "[]")) }.getOrDefault(JSONArray())
            val loaded = (0 until stored.length()).mapNotNull { stored.optJSONObject(it)?.let(TeamSend::read) }
            UiIo.ui { if (!isDestroyed) { loaded.forEach { pending.putIfAbsent(it.clientId, if (it.ledgerId == null && it.error == null) it.copy(error = "上次发送结果尚未确认，请确认结果") else it) }; outboxReady = true; render() } }
        }
        render()
    }
    override fun onStart() { active = true; super.onStart() }
    override fun onStop() { active = false; members.invalidate(); costs.invalidate(); exchanges.invalidate(); super.onStop() }
    override fun onConnectionChanged(connected: Boolean) {
        if (connected) refresh() else { members.invalidate(); costs.invalidate(); exchanges.invalidate() }
    }
    override fun onLedger(message: JSONObject) {
        val change = TeamModel.refresh(message)
        change.by?.let { changedBy = TeamModel.label(it, members.value.orEmpty()) }
        if (change.members) readMembers()
        if (change.exchanges) readExchanges()
        if (change.costs) readCosts()
        if (route == "logs" && (change.members || change.exchanges)) logs()
    }
    private fun refresh() {
        readMembers(); readCosts()
        when (route) {
            "team", "member" -> readExchanges()
            "logs" -> logs()
            "memory" -> member()?.let(::memory)
            "source" -> sourceRequest?.let { source(it.first, it.second, it.third) }
        }
    }
    private fun <T> parsed(data: JSONObject?, parse: (JSONObject) -> T): T? = data?.let { runCatching { parse(it) }.getOrNull() }
    private fun readMembers() {
        val ticket = members.begin() ?: run { refreshMembers = true; return }
        call("service:agents", "list") { data, failure ->
            if (!active) return@call
            val value = parsed(data, TeamModel::members)
            if (members.finish(ticket, value, failure?.message ?: if (value == null) "成员读取失败" else null)) {
                updateTargets(); render()
                if (restoringEdit && value != null) { restoringEdit = false; edit(member()) }
            }
            if (refreshMembers) { refreshMembers = false; readMembers() }
        }
    }
    private fun readCosts() {
        val ticket = costs.begin() ?: run { refreshCosts = true; return }
        call("service:cost", "usage.get", JSONObject().put("days", 1)) { data, failure ->
            if (!active) return@call
            val value = parsed(data, TeamModel::costs)
            if (costs.finish(ticket, value, failure?.message ?: if (value == null) "今天花费暂不可读" else null)) render()
            if (refreshCosts) { refreshCosts = false; readCosts() }
        }
    }
    private fun readExchanges(older: Boolean = false) {
        if (route !in setOf("team", "member")) return
        val source = exchanges
        val ticket = source.begin() ?: run { refreshExchanges = true; return }
        val arg = JSONObject().put("limit", 50)
        selected?.let { arg.put("agent", it) }
        if (older) before?.let { arg.put("before", it) }
        call("service:history", "exchanges", arg) { data, failure ->
            if (!active) return@call
            val page = parsed(data, TeamModel::exchanges)
            val value = page?.let { TeamModel.merge(source.value.orEmpty(), it.items).take(500) }
            if (source.finish(ticket, value, failure?.message ?: if (page == null) "往来读取失败" else null)) {
                if (older || source.value?.size == page?.items?.size) before = page?.before
                if ((value?.size ?: 0) >= 500) before = null
                if (page != null) reconcile(page.items)
                render()
            }
            if (refreshExchanges) { refreshExchanges = false; readExchanges() }
        }
    }
    private fun updateTargets() {
        val all = members.value.orEmpty()
        val ids = all.map { it.id }
        val labels = all.map { it.name }
        if (ids == targetIds && labels == targetLabels) return
        restoringTarget = true
        val previous = target
        targetIds = ids; targetLabels = labels
        if (target !in ids) target = selected?.takeIf { it in ids } ?: ids.firstOrNull()
        targets.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, labels)
        targets.setSelection(ids.indexOf(target).coerceAtLeast(0))
        if (previous != target || input.text.isEmpty()) input.setText(drafts.text(draftKey()))
        restoringTarget = false
    }
    private fun draftKey() = "team:ask:${target ?: "none"}"
    private fun say(s: String) { status.text = s }
    private fun button(label: String, click: () -> Unit): TextView = AshUi.button(this, label, AshUi.Kind.GHOST, onClick = click).apply { minHeight = dp(48) }
    private fun text(s: String, muted: Boolean = false) = AshUi.text(this, s, if (muted) AshTokens.Type.caption else AshTokens.Type.body, if (muted) c.text2 else c.text).apply { setTextIsSelectable(true) }
    private fun box(vararg lines: String) = AshUi.card(this).apply { lines.filter { it.isNotBlank() }.forEach { addView(text(it)) } }
    private fun note(key: String, s: String) = ChatRow(key, s) { text(s, true) }
    private fun member(id: String? = selected) = members.value.orEmpty().firstOrNull { it.id == id }
    private fun move(id: String?, next: String) {
        selected = id; route = next; routeGeneration++; exchanges.invalidate(); exchanges = TeamModel.Read(); before = null
        extra = emptyList(); moreExtra = null; savedKey = null; sourceRequest = null; armedAction = null; resetPosition = true
        list.visibility = View.VISIBLE; formSlot.visibility = View.GONE
        if (id != null) { target = id; updateTargets(); targets.setSelection(targetIds.indexOf(id).coerceAtLeast(0)); input.setText(drafts.text(draftKey())) }
        render(); syncBack(); readExchanges()
    }
    override fun canGoBack() = route != "team"
    override fun goBack() {
        when (route) {
            "member" -> move(null, "team")
            else -> move(selected, if (selected == null) "team" else "member")
        }
    }
    private fun render() {
        if (!::rows.isInitialized || route == "edit") return
        title.text = when (route) { "team" -> "团队"; "member" -> member()?.name ?: "成员"; "logs" -> "成员日志"; "memory" -> "载入的记忆"; else -> "往来原文" }
        composer.visibility = if (route in setOf("team", "member")) View.VISIBLE else View.GONE
        send.isEnabled = outboxReady && target != null && pending.values.none { it.agent == target && it.ledgerId == null }
        val all = members.value.orEmpty(); val names = all.associate { it.id to it.name }
        val built = ArrayList<ChatRow>()
        if (route !in setOf("team", "member")) { built.addAll(extra); moreExtra?.let { more -> built.add(ChatRow("extra:more", "more") { button("继续读取", more) }) } }
        else {
            if (route == "team") {
                built.add(note("members:title", "团队成员"))
                all.forEach { m ->
                    val cost = costs.value?.get(m.id)?.label() ?: if (costs.value != null) "今天尚无用量记录" else "花费尚未读取"
                    val sig = listOf(m.name, m.role, m.model, m.state, m.doing, m.waiting.toString(), cost, m.primary.toString()).joinToString("|")
                    built.add(ChatRow("member:${m.id}", sig) {
                        box(m.name + if (m.primary) " · 主 agent" else "", m.role, m.model.ifBlank { "模型由运行时选择" }, m.status(names), cost).apply {
                            contentDescription = "${m.name}，${m.role}，${m.status(names)}，$cost"
                            addView(button("查看成员") { move(m.id, "member") })
                        }
                    })
                }
                if (members.value != null && all.isEmpty()) built.add(note("members:empty", "还没有团队成员，可以从右上角新建。"))
            } else member()?.let { m ->
                built.add(ChatRow("detail:${m.id}", m.toString() + busy.toString() + armedAction) {
                    box(m.role, m.status(names), "模型：${m.model.ifBlank { "由运行时选择" }}", "角色：${m.brief}", "工具：${m.tools?.joinToString("、") ?: "全部"}", "接口：${m.words?.joinToString("、") ?: "全部"}").apply {
                        addView(button("修改配置") { edit(m) })
                        addView(button(if (m.state == "stopped" || m.state == "error") "启动" else if (armedAction == "${m.id}:state") "确认停下，会中断工作" else "停下") { action("state", m.id, if (m.state == "stopped" || m.state == "error") "start" else "stop") })
                        addView(button("重启") { action("restart", m.id, "restart") })
                        addView(button("记忆") { memory(m) }); addView(button("日志") { route = "logs"; routeGeneration++; extra = emptyList(); moreExtra = null; resetPosition = true; logs(); render(); syncBack() })
                    }
                })
            } ?: built.add(note("member:gone", "成员已不存在，返回团队查看当前成员。"))
            built.add(note("exchanges:title", if (route == "team") "团队往来" else "这个成员的往来"))
            pending.values.filter { selected == null || selected == it.agent }.forEach { p ->
                built.add(ChatRow("pending:${p.clientId}", p.toString()) {
                    box("你 → ${TeamModel.label(p.agent, all)}", p.text, p.error ?: if (p.ledgerId == null) "正在发送…" else "已提交，等回答").apply {
                        if (p.error != null && !p.refused) addView(button("确认发送结果") { dispatch(p) })
                        if (p.refused) addView(button("保留文字，结束这次发送") {
                            pending.remove(p.clientId); savePending()
                            if (target == p.agent && input.text.isBlank()) input.setText(p.text)
                            render()
                        })
                    }
                })
            }
            exchanges.value.orEmpty().forEach { e ->
                val expanded = e.id in opened
                built.add(ChatRow("exchange:${e.id}", e.toString() + expanded + names[e.from] + names[e.to]) {
                    box("${TeamModel.label(e.from, all)} → ${TeamModel.label(e.to, all)}", "${when (e.word) { "tell" -> "告知"; "spawn" -> "临时任务"; else -> "委托" }} · ${ai.ash.ui.HomeModel.dayTime(e.ts)} · ${e.status}", e.preview(expanded)).apply {
                        e.answer?.let { a -> addView(text(if (a.error.isNotBlank()) "未完成：${a.error}" else "回答：" + if (expanded) a.text else a.text.take(220).let { it + if (a.text.length > 220) "…" else "" })) }
                        if (e.text.length > 180 || (e.answer?.text?.length ?: 0) > 220) addView(button(if (expanded) "收起" else "展开") { if (!opened.add(e.id)) opened.remove(e.id); render() })
                        addView(button("查看委托原文") { source(e.seq, false, e.word) })
                        e.answer?.let { a -> addView(button("查看回答原文") { source(a.seq, true, e.word) }) }
                    }
                })
            }
            if (exchanges.value != null && exchanges.value!!.isEmpty()) built.add(note("exchanges:empty", "还没有团队往来。可以在下面点名发话。"))
            if ((exchanges.value?.size ?: 0) >= 500) built.add(note("exchanges:limit", "已载入最近 500 条。可按成员查看其往来。"))
            before?.let { cursor -> built.add(ChatRow("exchanges:more", "$cursor:${exchanges.busy}") { button("更早的往来") { readExchanges(true) }.apply { isEnabled = !exchanges.busy } }) }
        }
        val pos = lm.findFirstVisibleItemPosition()
        val reset = resetPosition
        val key = if (reset) null else savedKey ?: rows.currentList.getOrNull(pos)?.key
        val offset = if (savedKey != null) savedOffset else lm.findViewByPosition(pos)?.let { lm.getDecoratedTop(it) - list.paddingTop } ?: 0
        val gen = routeGeneration
        val scroll = scrollVersion
        rows.submitList(built) {
            if (gen != routeGeneration || scroll != scrollVersion) return@submitList
            val index = built.indexOfFirst { it.key == key }
            if (reset) { lm.scrollToPositionWithOffset(0, 0); resetPosition = false }
            else if (index >= 0) { lm.scrollToPositionWithOffset(index, offset); savedKey = null }
        }
        val errors = listOfNotNull(members.error, exchanges.error, costs.error)
        if (errors.isNotEmpty()) say(errors.distinct().joinToString(" · ") + "；保留上次内容")
        else if (changedBy != null) say("最近由 $changedBy 修改")
        else if (members.value != null) say("点成员查看详情；内部往来单独留在这里")
    }
    private fun action(key: String, agent: String, word: String) {
        val actionKey = "$agent:$key"
        if (word == "stop" && armedAction != actionKey) { armedAction = actionKey; render(); return }
        armedAction = null
        if (!busy.add(actionKey)) return
        render(); say("正在${if (word == "stop") "停下" else "处理"}…")
        call("service:agents", word, JSONObject().put("agent", agent)) { _, failure ->
            busy.remove(actionKey); render()
            say(failure?.let { "${it.message}；请查看成员状态再决定是否重试" } ?: "已完成")
            readMembers()
        }
    }
    private fun savePending(done: (Boolean) -> Unit = {}) {
        val data = JSONArray().apply { pending.values.forEach { put(it.json()) } }.toString()
        val store = prefs
        UiIo.disk { val ok = store.edit().putString("questions", data).commit(); UiIo.ui { done(ok) } }
    }
    private fun sendQuestion() {
        val id = target ?: return
        val value = input.text.toString().trim()
        if (value.isBlank() || !outboxReady || pending.values.any { it.agent == id && it.ledgerId == null }) return
        val p = TeamSend(UUID.randomUUID().toString(), id, value)
        pending[p.clientId] = p
        savePending { ok ->
            if (!ok) { pending.remove(p.clientId); say("没有保存成功，文字仍留在输入框里"); render() }
            else dispatch(p)
        }
        render()
    }
    private fun dispatch(p: TeamSend) {
        val key = "send:${p.clientId}"
        if (!busy.add(key)) return
        HumanCall.request(this, p.request()) { result, failure ->
            busy.remove(key)
            val accepted = result?.let(p::receipt)
            val next = accepted ?: p.copy(error = failure?.message ?: "发送结果未知；确认时会沿用原请求，不重复派发", code = failure?.code)
            pending[p.clientId] = next
            savePending { ok ->
                if (!isDestroyed) {
                    if (accepted != null && target == p.agent && input.text.toString().trim() == p.text) input.setText("")
                    render(); say(if (!ok) "回执保存失败，保留原请求用于确认" else if (accepted != null) "已提交，回答会出现在委托下面" else next.error.orEmpty())
                    if (active) readExchanges()
                }
            }
        }
    }
    private fun reconcile(items: List<TeamModel.Exchange>) {
        val visible = items.map { it.id }.toSet()
        val removed = pending.values.filter { it.ledgerId in visible }.map { it.clientId }
        if (removed.isNotEmpty()) { removed.forEach(pending::remove); savePending() }
    }
    private fun watcher(change: (String) -> Unit) = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { change(s?.toString().orEmpty()) }
        override fun afterTextChanged(s: Editable?) {}
    }
    private fun edit(m: TeamModel.Member?) {
        selected = m?.id
        route = "edit"; routeGeneration++; syncBack(); title.text = if (m == null) "新建帮手" else "修改配置"
        list.visibility = View.GONE; composer.visibility = View.GONE
        formSlot.visibility = View.VISIBLE; formSlot.removeAllViews()
        val fields = AshUi.vstack(this, 10).apply { setPadding(dp(16), dp(8), dp(16), dp(16)) }
        formSlot.addView(ScrollView(this).apply { addView(fields) }, LinearLayout.LayoutParams(-1, -1))
        val key = "team:edit:${m?.id ?: "new"}"
        fun field(label: String, suffix: String, initial: String, multiline: Boolean = false): EditText {
            fields.addView(text(label, true))
            val stored = drafts.text("$key:$suffix")
            val value = if (stored.startsWith("value:")) stored.removePrefix("value:") else initial
            return EditText(this).apply {
                id = View.generateViewId(); minHeight = dp(48); setTextColor(c.text); setHintTextColor(c.text3)
                isSingleLine = !multiline; if (multiline) minLines = 3
                setText(value); addTextChangedListener(watcher { drafts.keep("$key:$suffix", "value:$it") }); fields.addView(this, LinearLayout.LayoutParams(-1, -2))
            }
        }
        val name = field("名字", "name", m?.name.orEmpty())
        val role = field("一句话说明角色", "role", m?.role.orEmpty())
        val brief = field("角色说明", "brief", m?.brief.orEmpty(), true)
        fields.addView(text("运行时", true))
        val kinds = Spinner(this).apply { minimumHeight = dp(48); contentDescription = "帮手的运行时" }
        fields.addView(kinds, LinearLayout.LayoutParams(-1, -2))
        fields.addView(text("模型", true))
        val models = Spinner(this).apply { minimumHeight = dp(48); contentDescription = "帮手使用的模型" }
        fields.addView(models, LinearLayout.LayoutParams(-1, -2))
        val tools = m?.let { field("允许使用的工具（每行一个；清空表示不允许，原本全部时留空保留）", "tools", it.tools?.joinToString("\n").orEmpty(), true) }
        val words = m?.let { field("允许调用的接口（每行一个；清空表示不允许，原本全部时留空保留）", "words", it.words?.joinToString("\n").orEmpty(), true) }
        val formNote = text("正在读取可用模型…", true); fields.addView(formNote)
        var runtimeIds = emptyList<String>()
        var modelIds = emptyList<String>()
        var runtimeRows = emptyList<JSONObject>()
        val gen = routeGeneration
        fun setModels(ids: List<String>) {
            val current = m?.model.orEmpty()
            modelIds = (listOf(current).filter { it.isNotBlank() } + ids).distinct()
            models.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, modelIds)
            val preferred = drafts.text("$key:model").ifBlank { current }
            models.setSelection(modelIds.indexOf(preferred).coerceAtLeast(0))
            formNote.text = if (modelIds.isEmpty()) "这个运行时没有返回可选模型，暂时不能保存。" else "保存后从下一轮使用；密钥和授权由中枢检查。"
        }
        models.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(p: AdapterView<*>?) {}
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) { modelIds.getOrNull(pos)?.let { drafts.keep("$key:model", it) } }
        }
        kinds.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onNothingSelected(p: AdapterView<*>?) {}
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) {
                val kind = runtimeIds.getOrNull(pos) ?: return
                drafts.keep("$key:kind", kind)
                val raw = runtimeRows.firstOrNull { it.optString("kind") == kind }?.optJSONArray("models") ?: JSONArray()
                setModels((0 until raw.length()).mapNotNull { raw.optJSONObject(it)?.optString("id")?.takeIf(String::isNotBlank) })
                val catalogMember = m?.takeIf { it.kind == kind } ?: members.value.orEmpty().firstOrNull { it.kind == kind }
                if (catalogMember != null) call("service:agents", "runtime.catalog", JSONObject().put("agent", catalogMember.id)) { data, failure ->
                    if (gen != routeGeneration || runtimeIds.getOrNull(kinds.selectedItemPosition) != kind) return@call
                    if (failure != null) { formNote.text = "目录读取失败：${failure.message}"; return@call }
                    val providers = data?.optJSONArray("providers") ?: return@call
                    val ids = ArrayList<String>()
                    for (i in 0 until providers.length()) {
                        val entries = providers.optJSONObject(i)?.optJSONArray("models") ?: continue
                        for (j in 0 until entries.length()) entries.optJSONObject(j)?.optString("id")?.takeIf(String::isNotBlank)?.let(ids::add)
                    }
                    setModels(ids)
                }
            }
        }
        val save = button("保存") {
            val kind = runtimeIds.getOrNull(kinds.selectedItemPosition)
            val model = modelIds.getOrNull(models.selectedItemPosition)
            if (name.text.isBlank() || role.text.isBlank() || kind == null || model == null) { formNote.text = "请填写名字、角色，并选择可用模型。"; return@button }
            if (!busy.add("form")) return@button
            val body = JSONObject().put("name", name.text.toString().trim()).put("summary", role.text.toString().trim())
                .put("brief", brief.text.toString().ifBlank { role.text.toString() }).put("runtime", JSONObject().put("kind", kind).put("model", model))
            val id = m?.id ?: drafts.text("$key:id").ifBlank { "agent:helper-" + UUID.randomUUID().toString().take(8) }.also { drafts.keep("$key:id", it) }
            if (m == null) body.put("id", id) else {
                body.put("agent", id)
                fun lines(e: EditText?) = e?.text.toString().lines().map(String::trim).filter(String::isNotBlank)
                body.put("tools", JSONArray(lines(tools))); body.put("words", JSONArray(lines(words)))
            }
            // Empty lists are real restrictions. The form labels reserve blank for unrestricted, represented by omitting an unchanged null policy.
            if (m != null && m.tools == null && tools?.text.isNullOrBlank()) body.remove("tools")
            if (m != null && m.words == null && words?.text.isNullOrBlank()) body.remove("words")
            formNote.text = "正在保存…"
            call("service:agents", if (m == null) "declare" else "update", body) { data, failure ->
                busy.remove("form")
                if (gen != routeGeneration) return@call
                if (failure != null) { formNote.text = "${failure.message}；草稿已保留，请查看成员状态后再决定。"; readMembers(); return@call }
                listOf("name", "role", "brief", "kind", "model", "tools", "words", "id").forEach { drafts.clear("$key:$it") }
                formNote.text = data?.optJSONArray("notes")?.toString().orEmpty()
                selected = id; move(id, "member"); readMembers()
            }
        }
        fields.addView(save)
        call("service:agents", "runtimes") { data, failure ->
            if (gen != routeGeneration) return@call
            if (failure != null) { formNote.text = failure.message; return@call }
            val a = data?.optJSONArray("runtimes") ?: JSONArray()
            runtimeRows = (0 until a.length()).mapNotNull { a.optJSONObject(it) }
            runtimeIds = runtimeRows.map { it.optString("kind") }.filter(String::isNotBlank)
            kinds.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, runtimeIds)
            val wanted = drafts.text("$key:kind").ifBlank { m?.kind ?: member(members.value?.firstOrNull()?.id)?.kind.orEmpty() }
            kinds.setSelection(runtimeIds.indexOf(wanted).coerceAtLeast(0))
        }
    }
    private var logsBusy = false
    private var logBefore: Long? = null
    private fun logs(older: Boolean = false) {
        val id = selected ?: return
        if (logsBusy) return
        logsBusy = true
        val gen = routeGeneration
        val arg = JSONObject().put("speaker", id).put("limit", 30)
        if (older) logBefore?.let { arg.put("before", it) }
        call("service:history", "query", arg) { data, failure ->
            logsBusy = false
            if (!active || gen != routeGeneration) return@call
            if (failure != null) { say("日志读取失败：${failure.message}"); return@call }
            val a = data?.optJSONArray("messages") ?: run { say("日志格式不完整"); return@call }
            val got = (0 until a.length()).mapNotNull { a.optJSONObject(it) }.map { m ->
                val key = m.optString("id"); val summary = m.optString("summary"); val word = m.optString("word"); val seq = m.optLong("seq")
                ChatRow("log:$key", "$word:$summary") { box(word, summary).apply { addView(button("查看记录") { source(seq, false, "raw") }) } }
            }
            extra = (if (older) extra + got else got).take(300)
            logBefore = (data.opt("next_before") as? Number)?.toLong()
            moreExtra = if (logBefore == null || extra.size >= 300) null else ({ logs(true) })
            render()
        }
    }
    private fun memory(m: TeamModel.Member) {
        if (route != "memory") { extra = emptyList(); resetPosition = true }
        route = "memory"; routeGeneration++; moreExtra = null; render(); syncBack()
        if (!m.userMemory) { extra = listOf(note("memory:none", "这个成员没有载入 user 记忆模块。")); render(); return }
        val gen = routeGeneration
        extra = listOf(note("memory:shared", "它载入的是团队共享的用户记忆，并非成员私有记忆。"))
        listOf("USER.md", "MEMORY.md").forEach { file ->
            call("body:main", "workspace.read", JSONObject().put("path", file).put("limit", 20000)) { data, failure ->
                if (!active || gen != routeGeneration) return@call
                val s = data?.optString("text") ?: failure?.message ?: "尚无内容"
                extra = extra.filterNot { it.key == "memory:$file" } + ChatRow("memory:$file", s) { box(file, s) }
                render()
            }
        }
    }
    private fun source(seq: Long, response: Boolean, word: String) {
        if (route != "source") { extra = emptyList(); resetPosition = true }
        sourceRequest = Triple(seq, response, word)
        route = "source"; routeGeneration++; moreExtra = null; render(); syncBack()
        val gen = routeGeneration
        call("service:history", "read", JSONObject().put("from_seq", seq).put("to_seq", seq)) { data, failure ->
            if (!active || gen != routeGeneration) return@call
            if (failure != null) { say("原文读取失败：${failure.message}"); return@call }
            val raw = data?.optJSONArray("messages")?.optJSONObject(0) ?: run { say("这条记录不存在"); return@call }
            val text = if (word == "raw") TeamModel.TextSource(raw.toString(2)) else TeamModel.source(raw, response, word)
            showSource(text, gen)
        }
    }
    private fun showSource(src: TeamModel.TextSource, gen: Int) {
        if (src.hash == null) { extra = listOf(ChatRow("source:text", src.text) { box(src.text.ifBlank { "这条记录没有文字内容。" }) }); render(); return }
        var accumulated = ""
        fun load(offset: Long) {
            moreExtra = null
            call("service:blobs", "read", JSONObject().put("hash", src.hash).put("offset", offset).put("limit", 20000)) { data, failure ->
                if (!active || gen != routeGeneration) return@call
                if (failure != null) { say("原文读取失败：${failure.message}"); return@call }
                accumulated += data?.optString("text").orEmpty()
                val next = (data?.opt("next_offset") as? Number)?.toLong()
                if (src.json && next == null) {
                    val raw = runCatching { JSONObject(accumulated) }.getOrNull()
                    var value: Any? = raw
                    src.path.forEach { value = (value as? JSONObject)?.opt(it) }
                    val resolved = if (value is JSONObject) (value as JSONObject).let { j -> TeamModel.TextSource(j.optString("summary"), j.opt("\$blob") as? String, j.optString("mime") == "application/json") } else TeamModel.TextSource(value?.toString().orEmpty())
                    showSource(resolved, gen)
                } else {
                    val chunk = accumulated
                    extra = listOf(ChatRow("source:text", chunk) { box(chunk) })
                    moreExtra = if (next != null && accumulated.length < 1_000_000) ({ load(next) }) else null
                    if (next != null && moreExtra == null) say("已显示前一百万字；完整内容保留在账本附件中。")
                    render()
                }
            }
        }
        load(0)
    }
    companion object {
        private val sharedPending = LinkedHashMap<String, TeamSend>()
        private var pendingLoaded = false
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("member", selected); outState.putString("target", target); outState.putString("route", route)
        outState.putStringArrayList("opened", ArrayList(opened))
        val pos = lm.findFirstVisibleItemPosition()
        rows.currentList.getOrNull(pos)?.let { row ->
            outState.putString("anchor", row.key)
            outState.putInt("offset", lm.findViewByPosition(pos)?.let { lm.getDecoratedTop(it) - list.paddingTop } ?: 0)
        }
        super.onSaveInstanceState(outState)
    }
}
