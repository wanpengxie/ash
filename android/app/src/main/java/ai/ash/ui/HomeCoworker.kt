package ai.ash.ui

import android.widget.EditText
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.AshUi.Kind
import org.json.JSONObject
import java.util.UUID

/** Computer sessions use the owner's existing human channel, never a second native HTTP bridge. */
class HmCoworker(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "电脑会话"
    private val args = runCatching { JSONObject(arg ?: "{}") }.getOrDefault(JSONObject())
    private var target = args.optJSONObject("target")
    private val work = args.optJSONObject("work")
    private val creating = args.optBoolean("create")
    private val scope = args.optString("scope")
    private val cursor = args.optString("cursor").ifEmpty { null }
    private val notice = Hk.note(ctx, "正在读取…")
    private val rows = AshUi.vstack(ctx, 10)
    private val input = EditText(ctx).apply { hint = "想让它做什么？"; minLines = 2; maxLines = 8 }
    private var project: JSONObject? = null
    private var epoch: String? = null
    private var controlTarget: JSONObject? = null
    private var snapshot: JSONObject? = null
    private var action: String? = null
    private var busy = false
    private val prefs = ctx.getSharedPreferences("ash.coworker", 0)
    private val binding = listOf(scope, target?.optString("endpoint_id"), target?.optString("authorization_revision"), work?.optString("native_id"), creating).joinToString("|")
    private val draftKey = "draft:$binding"
    private val pendingKey = "pending:$binding"
    private var image: CoworkerImage? = null
    private val send = AshUi.button(ctx, if (creating) "创建会话" else "发送", Kind.PRIMARY) { submit() }

    init {
        body.addView(notice); body.addView(rows)
        if (work != null || creating) {
            input.setText(prefs.getString(draftKey, ""))
            input.addTextChangedListener(object : android.text.TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { prefs.edit().putString(draftKey, s?.toString()).apply() }
                override fun afterTextChanged(s: android.text.Editable?) {}
            })
            body.addView(input); body.addView(send)
            if (work != null && env.files != null) {
                val previewRow = AshUi.hstack(ctx, 8).apply { visibility = android.view.View.GONE }
                val preview = android.widget.ImageView(ctx).apply { adjustViewBounds = true; maxHeight = dp(100) }
                val filename = Hk.note(ctx, "")
                image = CoworkerImage(env, work, scope, binding, { alive }, { notice.text = it }, { input.setText("") }) { name, encoded ->
                    filename.text = name.orEmpty(); previewRow.visibility = if (name == null) android.view.View.GONE else android.view.View.VISIBLE
                    val bytes = encoded?.let { android.util.Base64.decode(it, android.util.Base64.DEFAULT) }
                    val bitmap = bytes?.let { android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = 8 }) }
                    preview.setImageBitmap(bitmap)
                    if (name != null) send.isEnabled = pending() == null
                }
                previewRow.addView(preview, android.widget.LinearLayout.LayoutParams(dp(80), dp(80)))
                previewRow.addView(filename, android.widget.LinearLayout.LayoutParams(0, -2, 1f))
                previewRow.addView(AshUi.button(ctx, "×", Kind.GHOST) { image?.remove() })
                body.addView(previewRow)
                body.addView(AshUi.button(ctx, "选择图片", Kind.GHOST) { image?.pick() })
                if (image?.pending == true) notice.text = "上次图片结果待确认，点击发送查询"
            }
        }
        body.addView(AshUi.button(ctx, "刷新", Kind.GHOST) { refresh() })
        every(5000) { if (work != null && !busy) refresh() }
        paintPending()
    }

    private fun word(name: String, body: JSONObject = JSONObject(), done: (Reply) -> Unit) =
        call("service:collaboration", "collaboration.$name", body) { r ->
            if (!r.ok) { busy = false; notice.text = r.failure?.message ?: "暂时无法连接电脑"; send.isEnabled = false }
            else if (scope.isNotEmpty() && r.data.optString("auth_scope") != scope) {
                rows.removeAllViews(); snapshot = null; action = null; send.isEnabled = false
                notice.text = "授权已改变，请重新选择电脑"
            } else done(r)
        }

    override fun refresh() {
        if (busy) return
        send.isEnabled = false
        word(if (creating) "create.endpoints" else "endpoints") { r ->
            val targets = r.data.list(if (creating) "create_targets" else "targets")
            if (target == null) {
                rows.removeAllViews(); notice.text = if (targets.isEmpty()) "暂时没有已授权的电脑" else "选择电脑"
                targets.forEach { t ->
                    rows.addView(AshUi.button(ctx, t.optString("name", "电脑"), Kind.NEUTRAL) { open(t, null, creating, r.data.optString("auth_scope")) })
                }
                if (!creating) rows.addView(AshUi.button(ctx, "新建会话", Kind.GHOST) { env.nav.go("coworker", JSONObject().put("create", true).toString()) })
            } else {
                val live = targets.firstOrNull { it.optString("device_id") == target!!.optString("device_id") && it.optString("endpoint_id") == target!!.optString("endpoint_id") && it.optString("authorization_revision") == target!!.optString("authorization_revision") }
                if (live == null) { rows.removeAllViews(); notice.text = "电脑离线或授权已改变，请返回重新选择"; return@word }
                target = live
                if (work != null || creating) {
                    prefs.getString("shared_text", null)?.let { shared ->
                        val merged = listOf(input.text.toString(), shared).filter { it.isNotEmpty() }.joinToString("\n\n")
                        if (merged.toByteArray(Charsets.UTF_8).size <= 32768 && prefs.edit().putString(draftKey, merged).remove("shared_text").commit()) input.setText(merged)
                        else notice.text = "请先处理当前草稿，再接收分享"
                    }
                }
                if (creating) projects() else read()
            }
        }
    }

    private fun open(t: JSONObject, w: JSONObject?, create: Boolean, authScope: String = scope) =
        env.nav.go("coworker", JSONObject().put("target", t).put("scope", authScope).put("create", create).also { w?.let { work -> it.put("work", work) } }.toString())

    private fun base(): JSONObject = JSONObject().put("version", 1).put("device_id", target!!.getString("device_id"))
        .put("endpoint_id", target!!.getString("endpoint_id")).put("authorization_revision", target!!.getString("authorization_revision"))

    private fun read() {
        val b = base().put("authorization_generation", target!!.get("authorization_generation"))
            .put("action", if (work == null) "list_work" else "read_work").put("page", JSONObject().put("limit", if (work == null) 50 else 10).also { page -> cursor?.let { page.put("cursor", it) } })
        work?.let { b.put("work", it) }
        word("read", b) { r ->
            rows.removeAllViews(); notice.text = "已同步"
            val page = r.data.optJSONObject("page") ?: return@word
            page.list("items").let { if (work == null) it else it.reversed() }.forEach { item ->
                if (work == null) rows.addView(AshUi.button(ctx, item.optString("title", "未命名会话"), Kind.NEUTRAL) { open(target!!, item.getJSONObject("work"), false) })
                else item.list("messages").forEach { message -> renderMessage(item, message) }
            }
            page.optString("next_cursor").takeIf { it.isNotEmpty() && it != "null" && it != cursor }?.let { older ->
                rows.addView(AshUi.button(ctx, if (work == null) "查看更多会话" else "查看更早消息", Kind.GHOST) {
                    env.nav.go("coworker", JSONObject(args.toString()).put("cursor", older).toString())
                })
            }
            if (work != null) state()
        }
    }

    private fun renderMessage(turn: JSONObject, message: JSONObject) {
        val text = message.optString("text")
        val mine = message.optString("role") == "user"
        val content: CharSequence = if (mine) text else android.text.SpannableStringBuilder(Md.render(text, c.surface2, c.her) { href -> saveResult(turn, message, href) }).apply {
            getSpans(0, length, android.text.style.URLSpan::class.java).forEach { link ->
                val start = getSpanStart(link); val end = getSpanEnd(link); removeSpan(link)
                setSpan(object : android.text.style.ClickableSpan() {
                    override fun onClick(widget: android.view.View) {
                        if (coworkerLink(link.url) == CoworkerLink.WEB) runCatching { ctx.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(link.url))) }
                    }
                }, start, end, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
        }
        rows.addView(AshUi.bubbleText(ctx, content, mine).apply {
            setTextIsSelectable(true); movementMethod = android.text.method.LinkMovementMethod.getInstance()
        }, android.widget.LinearLayout.LayoutParams(-2, -2).apply { gravity = if (mine) android.view.Gravity.END else android.view.Gravity.START })
        if (!mine) coworkerCodeBlocks(text).take(12).forEach { code ->
            rows.addView(AshUi.button(ctx, "复制代码", Kind.GHOST) {
                val clipboard = ctx.getSystemService(android.content.Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                clipboard.setPrimaryClip(android.content.ClipData.newPlainText("代码", code))
                android.widget.Toast.makeText(ctx, "已复制", android.widget.Toast.LENGTH_SHORT).show()
            })
        }
    }

    private fun saveResult(turn: JSONObject, message: JSONObject, href: String) {
        if (busy || env.files == null || work == null) return
        busy = true; notice.text = "正在确认结果文件…"
        val b = base().put("authorization_generation", target!!.get("authorization_generation")).put("work", work)
            .put("turn_id", turn.getString("turn_id")).put("source_message_id", message.getString("source_message_id")).put("exact_href", href).also { request -> cursor?.let { request.put("page_cursor", it) } }
        call("service:collaboration", "collaboration.result.prepare", b) { r ->
            if (!r.ok || r.data.optString("auth_scope") != scope) { busy = false; notice.text = "结果文件暂时无法领取"; return@call }
            val prepared = r.data.optJSONObject("result")
            if (prepared?.optString("state") != "ready") { busy = false; notice.text = "请在电脑确认此文件，再领取"; return@call }
            val asset = prepared.getJSONObject("asset")
            val ref = JSONObject().put("save_id", prepared.getString("save_id")).put("asset_version", asset.getLong("version")).put("sha256", asset.getString("sha256"))
            call("service:collaboration", "collaboration.result.snapshot", ref) snapshot@{ snap ->
                if (!snap.ok || snap.data.optString("auth_scope") != scope) { busy = false; notice.text = "结果领取已过期或授权已改变"; return@snapshot }
                val result = snap.data.getJSONObject("result")
                env.port.stream(result.getString("stream")) stream@{ _, bytes, failure ->
                    if (!alive) return@stream
                    val verified = if (failure == null && bytes != null) runCatching { parseStreamedResultFile(result.getJSONObject("asset"), bytes) }.getOrNull() else null
                    if (verified == null || result.getJSONObject("asset").optString("sha256") != asset.optString("sha256") || result.getJSONObject("asset").optLong("version") != asset.optLong("version")) { busy = false; notice.text = "文件校验失败，请重新领取"; return@stream }
                    call("service:collaboration", "collaboration.result.check", ref) check@{ checked ->
                        busy = false
                        if (!checked.ok || checked.data.optString("auth_scope") != scope || checked.data.optJSONObject("result")?.optBoolean("current") != true) { notice.text = "领取授权已改变，请在电脑重新确认"; return@check }
                        env.files.save(verified.name, verified.mediaType, verified.bytes) { saved -> if (alive) notice.text = when (saved) { true -> "已保存到所选位置"; null -> "已取消保存"; else -> "保存失败，请重试" } }
                    }
                }
            }
        }
    }

    private fun projects() = word("create.projects", base().put("node_id", target!!.getString("endpoint_id")).put("cwd", target!!.getJSONObject("scope").getString("cwd"))) { r ->
        epoch = r.data.optString("connector_epoch"); rows.removeAllViews()
        val projects = r.data.list("projects")
        if (projects.size == 1) project = projects[0]
        projects.forEach { p -> rows.addView(AshUi.button(ctx, p.optString("cwd"), Kind.NEUTRAL) { project = p; notice.text = "已选择 ${p.optString("cwd")}"; send.isEnabled = true }) }
        notice.text = if (projects.isEmpty()) "没有可创建会话的项目" else if (project != null) "已选择 ${project!!.optString("cwd")}" else "请选择项目"
        send.isEnabled = project != null && pending() == null
    }

    private fun controlBase(): JSONObject = base().put("authorization_revision", controlTarget?.optString("authorization_revision"))
    private fun state(done: (() -> Unit)? = null) {
        word("control.endpoints") { discovery ->
            controlTarget = discovery.data.list("control_targets").firstOrNull { it.optString("endpoint_id") == work?.optString("endpoint_id") && it.optString("device_id") == target?.optString("device_id") && it.optString("grant_state") == "ready" }
            if (controlTarget == null) { action = null; busy = false; notice.text = "此会话尚未授权回复"; return@word }
            observeState(done)
        }
    }
    private fun observeState(done: (() -> Unit)? = null) {
        word("control.state", controlBase().put("work", work).put("action", "send_input")) { r ->
            val first = r.data.optJSONObject("snapshot")
            if (first?.optString("state") == "active") {
                word("control.state", controlBase().put("work", work).put("action", "steer")) { fresh ->
                    acceptState(fresh.data, "steer"); done?.invoke()
                }
            } else { acceptState(r.data, "send_input"); done?.invoke() }
        }
    }
    private fun acceptState(data: JSONObject, requested: String) {
        snapshot = data.optJSONObject("snapshot"); epoch = data.optString("connector_epoch")
        action = work?.let { coworkerAction(data, it, requested) }
        send.isEnabled = (action != null || image?.pending == true) && pending() == null
        if (action == null) notice.text = "暂时不能确认会话状态，请在电脑检查"
    }

    private fun pending(): JSONObject? = runCatching { JSONObject(prefs.getString(pendingKey, null) ?: return null) }.getOrNull()
    private fun paintPending() {
        if (pending() == null) return
        body.addView(AshUi.button(ctx, "查询上次发送结果", Kind.GHOST) { query() })
        send.isEnabled = false
    }
    private fun query() {
        val body = pending() ?: return
        val request = body.getJSONObject("request")
        val q = if (creating) JSONObject().put("version", 1).put("device_id", body.getString("device_id")).put("target", request.getJSONObject("target")).put("authorization_revision", request.getString("authorization_revision")) else JSONObject(body.toString()).apply { remove("request"); remove("expected_connector_epoch"); put("action", request.getString("action")) }
        q.put("operation_id", request.getString("operation_id"))
        word(if (creating) "create.query" else "control.query", q) { showFact(it.data) }
    }
    private fun showFact(data: JSONObject) {
        val fact = data.optJSONObject("fact") ?: return
        val original = pending()?.optJSONObject("request") ?: return
        if (fact.optString("operation_id") != original.optString("operation_id") || fact.optString("request_id") != original.optString("request_id")) { notice.text = "发送结果不匹配，请重新核实"; return }
        val status = if (creating) fact.optJSONObject("first_input")?.optString("status") else fact.optString("delivery_status")
        if (creating) fact.optJSONObject("work")?.let { created ->
            rows.addView(AshUi.button(ctx, "打开已创建会话", Kind.GHOST) {
                word("endpoints") { discovery ->
                    val readable = discovery.data.list("targets").firstOrNull { it.optString("endpoint_id") == created.optString("endpoint_id") && it.optString("device_id") == target?.optString("device_id") }
                    if (readable != null) open(readable, created, false)
                    else notice.text = "会话已创建，请在电脑查看；当前没有读取授权"
                }
            })
        }
        notice.text = when (status) { "accepted" -> "电脑已接收"; "rejected" -> "电脑拒绝了请求"; else -> "发送结果待确认，请查询结果" }
        if (status in setOf("accepted", "rejected")) { prefs.edit().remove(pendingKey).commit(); if (status == "accepted") input.setText(""); send.isEnabled = true }
    }
    private fun submit() {
        val text = input.text.toString()
        if (image?.pending == true) { image?.send(text); return }
        if (creating) { submitObserved(text); return }
        if (busy || text.isBlank() || pending() != null) return
        busy = true; send.isEnabled = false
        state { busy = false; if (action != null) submitObserved(text) }
    }
    private fun submitObserved(text: String) {
        if (image?.pending == true) { image?.send(text); return }
        if (busy || text.isBlank() || pending() != null || epoch.isNullOrEmpty()) return
        val request = JSONObject().put("request_id", UUID.randomUUID().toString()).put("operation_id", UUID.randomUUID().toString())
            .put("input", JSONObject().put("text", text)).put("expires_at", System.currentTimeMillis() + 86400000)
        val b = if (creating) {
            val p = project ?: return
            request.put("authorization_revision", target!!.getString("authorization_revision"))
                .put("target", JSONObject().put("node_id", target!!.getString("endpoint_id")).put("endpoint_id", target!!.getString("endpoint_id")).put("project_id", p.getString("project_id")).put("cwd", p.getString("cwd")))
                .put("title", text.trim().lineSequence().first().take(60))
            JSONObject().put("version", 1).put("device_id", target!!.getString("device_id"))
        } else {
            val a = action ?: return
            request.put("work", work).put("action", a)
            if (a == "steer") request.put("expected_turn_id", snapshot!!.getString("turn_id"))
            controlBase().put("work", work)
        }
        b.put("request", request).put("expected_connector_epoch", epoch)
        if (b.toString().toByteArray(Charsets.UTF_8).size > 65536) { notice.text = "内容过长，请缩短"; return }
        if (!prefs.edit().putString(pendingKey, b.toString()).commit()) { notice.text = "暂时无法保存发送记录"; return }
        busy = true; send.isEnabled = false; notice.text = "发送中…"; paintPending()
        call("service:collaboration", if (creating) "collaboration.create.apply" else "collaboration.control.apply", b) { r ->
            busy = false
            if (r.ok && r.data.optString("auth_scope") == scope) { showFact(r.data) }
            else notice.text = "发送结果待确认，请查询结果；原文已保留"
        }
    }
}
