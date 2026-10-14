package ai.ash.ui

import ai.ash.link.Link
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import ai.ash.caps.browser.BrowserSession
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.AshUi.Kind
import ai.ash.ui.design.Role
import org.json.JSONObject


/** 她的手和眼: the phone's checkup (drawn by the app itself; here only its state), the devices she can use, her browser, the apps, and a button to connect a new device. */
class HmHands(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "她的手和眼"
    private var devices: List<JSONObject>? = null
    private var pairs: List<JSONObject> = emptyList()
    private var apps: List<JSONObject>? = null
    private var checkup: Checkup.Summary? = null
    private val phoneBox = AshUi.vstack(ctx)
    private val listBox = AshUi.vstack(ctx, 14)
    private val parts = listOf("brain" to "cpu", "alarm" to "alarm", "notify" to "bell", "awake" to "bolt", "eyes" to "eye", "files" to "folder", "location" to "pin")

    init { body.addView(phoneBox); body.addView(listBox); drawPhone(); drawList() }

    private fun openCheckup(part: String?) { ctx.startActivity(Intent(ctx, ConsoleActivity::class.java).also { i -> part?.let { i.putExtra(ConsoleActivity.EXTRA_PART, it) } }) }

    private fun drawPhone() {
        phoneBox.removeAllViews()
        val s = checkup
        val todo = s?.todo ?: 0
        phoneBox.addView(AshUi.card(ctx).apply {
            setPadding(dp(16), dp(16), dp(16), dp(16))
            addView(AshUi.hstack(ctx, 10).apply {
                minimumHeight = dp(AshTokens.Size.touch); isClickable = true; setOnClickListener { openCheckup(null) }
                addView(Hk.tint(ctx, "phone", if (todo > 0) c.warn else c.ok, 24))
                addView(AshUi.vstack(ctx).apply {
                    addView(AshUi.text(ctx, "这台手机 · 体检", AshTokens.Type.headline))
                    addView(AshUi.text(ctx, if (s == null) "点开看看她在这台手机上好不好" else if (todo > 0) "$todo 项要处理，不然她可能被系统停掉" else "都好，她可以放心干活", AshTokens.Type.caption, if (s == null) null else if (todo > 0) c.warn else c.ok))
                }, LinearLayout.LayoutParams(0, -2, 1f))
            })
            if (s != null) addView(Hk.grid(ctx, 2, 8, OnboardingPlan.PARTS.mapNotNull { p -> parts.firstOrNull { it.first == p.id }?.let { p to it.second } }.map { (p, icon) ->
                val todoP = s.todo(p)
                val bad = todoP > 0 && !Checkup.optional(p)
                AshUi.vstack(ctx, 2).apply {
                    background = AshUi.rounded(if (bad) c.warnSoft else c.surface2, AshUi.dpF(ctx, 14f)); setPadding(dp(12), dp(10), dp(12), dp(10)); minimumHeight = dp(AshTokens.Size.touch)
                    isClickable = true; setOnClickListener { openCheckup(p.id) }
                    addView(AshUi.hstack(ctx, 6).apply { addView(Hk.tint(ctx, icon, if (bad) c.warn else c.text2, AshTokens.Size.iconXs)); addView(AshUi.text(ctx, p.title, AshType(13f, 18f, 400, null), if (bad) c.warn else c.text2)) })
                    addView(AshUi.text(ctx, Checkup.cellText(p, todoP), AshType(13f, 18f, 600, null), if (bad) c.warn else if (todoP > 0) c.text3 else c.ok))
                }
            }))
        })
    }

    private fun drawList() {
        listBox.removeAllViews()
        val rows = ArrayList<View>()
        val d = devices
        if (d != null) {
            pairs.filter { it.str("state") == "requested" }.forEach { p ->
                val kind = HomeModel.KIND_NAMES[p.str("kind")] ?: "设备"
                rows.add(Hk.row(ctx, "laptop", p.str("name")?.ifEmpty { null } ?: "新${kind}想连上来", "等你批准", "warn", "warn") { env.nav.go("device", "p/${p.str("pair_id")}") })
            }
            d.forEach { dev -> rows.add(Hk.row(ctx, when (dev.str("kind")) { "browser" -> "globe"; "phone" -> "phone"; "server" -> "server"; else -> "laptop" }, dev.str("name") ?: "", HomeModel.deviceLine(dev).text) { env.nav.go("device", "d/${dev.str("device")}") }) }
        }
        rows.add(Hk.row(ctx, "globe", "她的浏览器", "登录过的网站只存在这台手机上") { env.nav.go("browser") })
        rows.add(Hk.row(ctx, "grid", "应用", apps?.let { HomeModel.appsSummary(it) }) { env.nav.apps() })
        listBox.addView(AshUi.group(ctx, "她还能用的", rows = rows))
        if (d == null) listBox.addView(Hk.note(ctx, "正在读取设备…"))
        listBox.addView(AshUi.button(ctx, "连一台新设备", Kind.SECONDARY, block = true) { env.nav.go("connect") })
    }

    override fun refresh() {
        call("service:devices", "list") { r -> if (r.ok) { devices = r.data.list("devices").filter { it.str("device") != null && it.str("name") != null }; drawList() } }
        call("service:devices", "pair_pending") { r -> if (r.ok) { pairs = r.data.list("pairs").filter { it.str("pair_id") != null }; drawList() } }
        call("service:apps", "apps.list") { r -> if (r.ok) { apps = r.data.list("apps").filter { it.str("id") != null }; drawList() } }
        Thread { val s = runCatching { Checkup.summary(ctx) }.getOrNull(); if (s != null) ctx.runOnUiThread { if (alive) { checkup = s; drawPhone() } } }.start()
    }
}

/** A device's permissions: switches and a choice. [read] is the body of `access_set` / `pair_approve`. */
private class Perms(private val page: HomePage, private val ctx: android.app.Activity, device: JSONObject, private val browser: Boolean) {
    private val c = AshUi.p(ctx)
    private var tier = if (device.str("tier") == "full") "full" else "ask"
    private val keys = listOf(Triple("lend", "借出它的能力", "让她能用它"), Triple("body", "当作身体", "让她读写它的文件、执行命令"), Triple("local_agents", "允许本地 Agent", "使用电脑本地完整权限"), Triple("web_ui", "允许访问聊天和网页界面", null))
    private val switches = keys.associate { (k, _, _) -> k to AshUi.AshSwitch(ctx).apply { set(if (browser) k == "web_ui" else device.optBoolean(k)); if (browser) { isEnabled = false; alpha = 0.4f } } }
    val root = AshUi.vstack(ctx, 14)
    private val tierSlot = android.widget.FrameLayout(ctx)

    init {
        root.addView(AshUi.text(ctx, "它能做什么", AshTokens.Type.sub).apply { setPadding(dp(6), 0, dp(6), 0) })
        drawTier(); root.addView(tierSlot)
        root.addView(AshUi.group(ctx, rows = keys.map { (k, t, s) -> AshUi.row(ctx, t, s, null, trailing = switches.getValue(k)).apply { minimumHeight = dp(56) } }, iconInset = false))
    }
    private fun dp(v: Int) = AshUi.dp(ctx, v)
    private fun drawTier() {
        tierSlot.removeAllViews()
        tierSlot.addView(AshUi.segmented(ctx, listOf("按规则和影响审批", "完全放开"), if (tier == "full") 1 else 0) { i -> if (!browser) { tier = if (i == 1) "full" else "ask"; drawTier() } }.also { if (browser) it.alpha = 0.4f })
    }
    fun read(): JSONObject = JSONObject().put("tier", if (browser) "ask" else tier).also { o -> keys.forEach { (k, _, _) -> o.put(k, if (browser) k == "web_ui" else switches.getValue(k).checked) } }
}

/** One device (`d/<device>`) or one request waiting to be approved (`p/<pair id>`). */
class HmDevice(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    private val pairId = arg?.takeIf { it.startsWith("p/") }?.removePrefix("p/")
    private val deviceId = arg?.takeIf { it.startsWith("d/") }?.removePrefix("d/")
    override val title = if (pairId != null) "新设备" else "设备"
    private var devices: List<JSONObject>? = null
    private var pairs: List<JSONObject> = emptyList()
    private var status = ""
    private var failed = false
    private var info: String? = null
    private var nameField: EditText? = null
    private var perms: Perms? = null
    private var warn = ""

    init { body.addView(Hk.note(ctx, "正在读取…")) }

    override fun refresh() {
        call("service:devices", "list") { a ->
            call("service:devices", "pair_pending") { b ->
                if (!a.ok || !b.ok) { failed = true; if (devices == null) redraw { addView(Hk.note(ctx, "读取失败，请返回后重试。", "warn")) }; return@call }
                devices = a.data.list("devices").filter { it.str("device") != null && it.str("name") != null }
                pairs = b.data.list("pairs").filter { it.str("pair_id") != null }
                draw()
            }
        }
    }

    private fun act(word: String, args: JSONObject, failedText: String, then: () -> Unit = {}) = call("service:devices", word, args) { r ->
        if (r.ok) { status = ""; then(); refresh() } else { status = failedText; draw() }
    }

    private fun statusNote(): View? = if (status.isNotEmpty()) Hk.note(ctx, status, "warn") else null

    private fun draw(): Unit = redraw {
        if (devices == null) return@redraw
        if (pairId != null) {
            val pair = pairs.firstOrNull { it.str("pair_id") == pairId && it.str("state") == "requested" }
            if (pair == null) { addView(Hk.list(ctx, listOf(Hk.row(ctx, "check", "这个请求已经处理了", tone = "ok")))); addView(AshUi.button(ctx, "回到她的手和眼", Kind.NEUTRAL, block = true) { env.nav.pop() }); return@redraw }
            val kind = HomeModel.KIND_NAMES[pair.str("kind")] ?: "设备"
            val p = Perms(this@HmDevice, ctx, JSONObject().put("tier", "ask").put("lend", pair.str("kind") != "browser"), pair.str("kind") == "browser").also { perms = it }
            addView(AshUi.card(ctx).apply { addView(AshUi.text(ctx, pair.str("name")?.ifEmpty { null } ?: "新$kind", AshType(20f, 28f, 700, Role.INK))); addView(AshUi.text(ctx, "$kind · 先确认它是你的设备，再选它能做什么", AshTokens.Type.sub)) })
            addView(p.root)
            addView(AshUi.button(ctx, "批准", Kind.PRIMARY, block = true) { act("pair_approve", p.read().put("pair_id", pairId), "批准未确认，请刷新状态后检查。") { env.nav.pop() } })
            addView(AshUi.button(ctx, "拒绝", Kind.NEUTRAL, block = true) { act("pair_reject", JSONObject().put("pair_id", pairId), "拒绝未确认，请重试。") { env.nav.pop() } })
            statusNote()?.let { addView(it) }
            return@redraw
        }
        // an app may point at a device by its id (`device:<hand>`, with or without the prefix) or by its name
        val device = devices?.let { all -> all.firstOrNull { it.str("device") == deviceId } ?: all.firstOrNull { it.str("device") == "device:$deviceId" } ?: all.firstOrNull { it.str("name") == deviceId } }
        if (device == null) { addView(Hk.list(ctx, listOf(Hk.row(ctx, "alert", "没有找到这台设备")))); return@redraw }
        val real = device.str("device") ?: return@redraw   // what the hub is told: the device's own id, however the page was pointed at it
        val line = HomeModel.deviceLine(device)
        val head = AshUi.card(ctx).apply { addView(AshUi.text(ctx, device.str("name") ?: "", AshType(20f, 28f, 700, Role.INK))); addView(AshUi.text(ctx, line.text, AshTokens.Type.sub, if (line.ok) c.ok else null)) }
        if (device.num("revoked_at") != null) {
            addView(head)
            addView(AshUi.button(ctx, "恢复", Kind.SECONDARY, block = true) { act("restore", JSONObject().put("device", real), "恢复未确认，请重试。") })
            statusNote()?.let { addView(it) }
            return@redraw
        }
        val name = Hk.field(ctx, "设备名称", device.str("name") ?: "")
        val p = Perms(this@HmDevice, ctx, device, device.str("kind") == "browser").also { perms = it }
        addView(head)
        addView(AshUi.group(ctx, "名称", rows = listOf(AshUi.hstack(ctx, 8).apply {
            setPadding(dp(14), dp(8), dp(14), dp(8))
            addView(name, LinearLayout.LayoutParams(0, -2, 1f))
            addView(AshUi.button(ctx, "保存名称", Kind.NEUTRAL, AshUi.BtnSize.SM) {
                val next = name.text.toString().trim()
                if (next.isEmpty()) { status = "名称不能是空的。"; draw() } else act("rename", JSONObject().put("device", real).put("name", next), "名称未保存。")
            })
        }), iconInset = false))
        addView(p.root)
        addView(AshUi.button(ctx, "保存权限", Kind.PRIMARY, block = true) { act("access_set", p.read().put("device", real), "权限未确认，请刷新状态后检查。") })
        addView(AshUi.button(ctx, "诊断", Kind.NEUTRAL, block = true) { diagnose(device) })
        info?.let { addView(Hk.pre(ctx, it)) }
        addView(Hk.twoTap(ctx, "移除这台设备", "确定移除？", "移除后 ${device.str("name")} 需要重新配对才能连上。", { warn = it; draw() }) { act("revoke", JSONObject().put("device", real), "移除未确认，请重试。") { env.nav.pop() } })
        if (warn.isNotEmpty()) addView(Hk.note(ctx, warn, "err"))
        statusNote()?.let { addView(it) }
    }

    private fun diagnose(device: JSONObject) {
        info = "正在诊断…"; draw()
        val hand = HomeModel.handOf(device.str("device") ?: "")
        call("service:link", "diagnose", JSONObject().put("hand", hand)) { d ->
            call("service:link", "list") { l ->
                val conns = if (l.ok) l.data.list("connections").count { it.str("hand") == hand } else 0
                info = if (d.ok) HomeModel.deviceDiagnosis(device, conns, d.data) else "诊断失败，请刷新状态。"
                draw()
            }
        }
    }
}

/** 连一台新设备: a pairing code for a computer, server or browser, and the relay it goes through. */
class HmConnect(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "连一台新设备"
    private class Shown(val pairId: String, val kind: String, val code: String, val url: String, val deadline: Long, var state: String = "waiting")
    private var kind = "computer"
    private var shown: Shown? = null
    private var pairResult = ""
    private var relay: JSONObject? = null
    private var copied = "复制地址"
    private var signature: String? = null
    private var tick = 0
    private var pairText: TextView? = null
    private val kinds = listOf("computer" to "电脑", "server" to "服务器", "browser" to "浏览器")

    init {
        every(1000) {
            if (shown == null) return@every
            tickText()
            if (++tick % 2 == 0) readPairing()
        }
        draw()
    }

    private fun countdown(ms: Long): String { val s = maxOf(0L, Math.ceil(ms / 1000.0).toLong()); return "${s / 60}:${"%02d".format(s % 60)}" }

    private fun textOf(s: Shown, code: String?, left: Long): String = when (code) {
        "requested" -> "配对码已使用。新设备发来的连接请求在「她的手和眼」里，确认是你的设备再批准。"
        "expired" -> "配对码已过期。需要时再点「生成配对码」。"
        else -> "配对码：${s.code}（还剩 ${countdown(left)}，只能用一次）。${if (s.url.isEmpty()) "" else if (s.kind == "browser") "在新浏览器里打开下面的地址，把上面的配对码输进去，再回到「她的手和眼」批准：" else "在要连接的电脑上用浏览器打开下面的地址，按页面提示安装，再回到「她的手和眼」批准："}"
    }
    private fun codeOf(s: Shown, left: Long) = if (s.state == "waiting" && left <= 0) "expired" else s.state

    private fun tickText() {
        val s = shown ?: return
        val left = s.deadline - System.currentTimeMillis()
        val code = codeOf(s, left)
        pairText?.text = textOf(s, code, left)
        if (code == "expired" && s.state == "waiting") draw()
    }

    private fun readRelay() = call("service:link", "gateway.status") { r -> if (r.ok) { relay = r.data; draw() } }
    private fun readPairing() = call("service:devices", "pair_pending") { r ->
        if (!r.ok) return@call
        val pairs = r.data.list("pairs")
        val sig = pairs.joinToString(",") { "${it.str("pair_id")}:${it.str("state")}" }
        var changed = signature != null && sig != signature
        signature = sig
        val s = shown
        if (s != null) {
            val own = pairs.firstOrNull { it.str("pair_id") == s.pairId }
            if (own != null) { val st = own.str("state"); if (st != null && st != s.state) { s.state = st; changed = true } }
            else call("service:devices", "pair_status", JSONObject().put("pair_id", s.pairId)) { q -> val st = q.data.str("state"); if (q.ok && st != null && st != s.state) { s.state = st; draw() } }
        }
        if (changed) draw()
    }

    private fun startPairing() {
        pairResult = "正在生成配对码…"; draw()
        call("service:devices", "pair_start", JSONObject().put("kind", kind)) { a ->
            val id = a.data.str("pair_id")
            if (!a.ok || id == null) { pairResult = "生成失败：中转站可能离线，请稍后重试。"; shown = null; draw(); return@call }
            call("service:devices", "pair_code", JSONObject().put("pair_id", id)) { b ->
                if (!b.ok) { pairResult = "生成失败：中转站可能离线，请稍后重试。"; shown = null; draw(); return@call }
                copied = "复制地址"
                shown = Shown(id, kind, b.data.str("code") ?: "", b.data.str("url") ?: "", b.data.num("expires_at") ?: a.data.num("expires_at") ?: System.currentTimeMillis())
                pairResult = ""; draw()
            }
        }
    }

    private fun draw(): Unit = redraw {
        val s = shown?.takeIf { it.state !in listOf("approved", "connected", "rejected") }
        val left = s?.let { it.deadline - System.currentTimeMillis() } ?: 0
        val code = s?.let { codeOf(it, left) }
        pairText = null
        addView(AshUi.group(ctx, "连一台新设备", rows = listOf(AshUi.vstack(ctx, 14).apply {
            setPadding(dp(14), dp(14), dp(14), dp(14))
            addView(AshUi.segmented(ctx, kinds.map { it.second }, kinds.indexOfFirst { it.first == kind }) { i -> kind = kinds[i].first; draw() })
            addView(AshUi.button(ctx, "生成配对码", Kind.PRIMARY, block = true) { startPairing() })
            if (pairResult.isNotEmpty()) addView(Hk.note(ctx, pairResult))
            if (s != null) {
                val t = AshUi.text(ctx, textOf(s, code, left), AshTokens.Type.sub); pairText = t
                addView(t)
                if (code == "waiting" && s.url.isNotEmpty()) {
                    addView(Hk.pre(ctx, s.url))
                    addView(AshUi.button(ctx, copied, Kind.NEUTRAL, AshUi.BtnSize.SM) {
                        ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("", s.url)); copied = "已复制"; draw()
                    })
                }
                if (code == "requested") addView(AshUi.button(ctx, "去批准", Kind.PRIMARY, AshUi.BtnSize.SM) { env.nav.pop() })
            }
        }), iconInset = false))

        val r = relay
        addView(AshUi.group(ctx, "中转站", rows = listOf(AshUi.vstack(ctx, 12).apply {
            setPadding(dp(14), dp(14), dp(14), dp(14))
            addView(AshUi.text(ctx, r?.let { HomeModel.relayText(it) } ?: "正在读取…", AshTokens.Type.sub))
            addView(AshUi.text(ctx, "中转站是你 Cloudflare 账号里的一个小程序，由她来搭、领回、换域名：你只需要授权一次，动你的东西之前她会先问你。", AshTokens.Type.caption))
            addView(AshUi.button(ctx, if (r?.optBoolean("connected") == true) "让她管中转站" else "让她搭中转站", Kind.SECONDARY, block = true) {
                env.nav.compose(if (r?.optBoolean("configured") == true) "帮我看看中转站" else "帮我搭中转站")
            })
        }), iconInset = false))
    }

    override fun refresh() { readRelay(); readPairing() }
}

/** Her browser: the logins she holds are kept on this phone; here they can all be cleared. */
class HmBrowser(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "她的浏览器"
    private val status = Hk.note(ctx, "")
    private var warn = ""

    init {
        body.addView(AshUi.card(ctx).apply {
            setPadding(dp(16), dp(16), dp(16), dp(16))
            addView(AshUi.text(ctx, "登录过的网站", AshType(20f, 28f, 700, Role.INK)))
            addView(AshUi.text(ctx, "她用自己的浏览器帮你上网。你在里面登录过的网站只保存在这台手机上。", AshTokens.Type.sub))
        })
        body.addView(Hk.twoTap(ctx, "清除浏览器里的所有登录", "再点一次确认清除", "会清掉所有网站的登录并关闭浏览器，之后她需要你重新登录。", { status.text = it }) {
            status.text = "正在清除…"
            call(Link.get(ctx).deviceId, "x.android.browser.clear_logins") { r -> status.text = if (r.ok) "已清除所有登录。" else "清除失败，请重试。" }
        })
        body.addView(status)
    }
}
