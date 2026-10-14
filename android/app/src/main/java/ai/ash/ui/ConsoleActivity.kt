package ai.ash.ui

import ai.ash.link.Link
import ai.ash.R
import ai.ash.caps.Capabilities
import ai.ash.caps.config.ConfigStatus
import ai.ash.caps.config.OwnerWord
import ai.ash.caps.config.Permissions
import ai.ash.caps.senses.NotificationSenseSettings
import ai.ash.host.KernelLauncher
import ai.ash.ui.design.AshPage
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.Role
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject

/**
 * 「她的手和眼 · 体检」(the page 「这台手机」 opens): the phone's state told as seven parts of a body ([Checkup]). A part with
 * an item that is off shows 「去修」; tapping a part lists its items, each with one line of why and 「去开启」. Under the parts, the
 * rest of what the old diagnostics page did (starting and stopping the kernel, the guide, the three
 * optional switches) — no business logic of its own. [EXTRA_PART] opens straight onto one part (an id of [OnboardingPlan.PARTS]).
 */
class ConsoleActivity : Activity() {
    private val ui = Handler(Looper.getMainLooper())
    private lateinit var root: LinearLayout
    private var part: OnboardingPlan.Part? = null
    private var items: List<Checkup.Item>? = null
    private var kernelLine = ""
    private var appLine = ""
    private var scroll: ScrollView? = null
    private var shown = ""
    private var resumed = false
    @Volatile private var reading = false
    /** A read was asked for while one was under way: it runs once that one is done. */
    @Volatile private var readAgain = false
    /** Back from a settings page: read at once and again a few times, since some phones report a change late. */
    private val recheck = ReturnRecheck(object : ReturnRecheck.Scheduler {
        override fun postDelayed(task: Runnable, ms: Long) { ui.postDelayed(task, ms) }
        override fun cancel(task: Runnable) { ui.removeCallbacks(task) }
    }) { refresh() }

    private val night get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(if (night) R.style.Ash_Dark else R.style.Ash_Light)
        super.onCreate(savedInstanceState)
        ai.ash.apps.Ui.systemBars(this)
        part = Checkup.part(savedInstanceState?.getString(STATE_PART) ?: intent?.getStringExtra(EXTRA_PART))
        root = AshPage.screen(this)
        setContentView(root.also { ai.ash.apps.Ui.insets(it) }) // edge to edge (targetSdk 35)
        render()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        part = Checkup.part(intent.getStringExtra(EXTRA_PART))
        render()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        part?.let { outState.putString(STATE_PART, it.id) }
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        recheck.start()
    }

    override fun onPause() {
        resumed = false
        recheck.cancel()
        ui.removeCallbacksAndMessages(null)
        super.onPause()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (part != null && intent?.getStringExtra(EXTRA_PART) == null) { part = null; render() } else finish()
    }

    /** The page's way to the hub: a switch here is the same word Ash calls on this phone. */
    private val hub: HumanPort by lazy { HumanPort(Link.get(this).chat).also { it.start() } }
    private fun phone(word: String, body: JSONObject, done: (Boolean) -> Unit = {}) =
        hub.call(Link.get(this).deviceId, word, body) { _, failure -> runOnUiThread { if (failure != null) Toast.makeText(this, "没改成：${failure.message}", Toast.LENGTH_SHORT).show(); done(failure == null) } }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun d(v: Int) = AshUi.dp(this, v)

    // ---------- reading the phone ----------

    private fun refresh() {
        if (reading) { readAgain = true; return }
        if (!isFinishing) {
            reading = true
            Thread({
                val read = runCatching { Checkup.read(this) }.getOrNull()
                val kernel = KernelLauncher.installedVersion(this)
                val k = "${kernel?.let { "已安装 $it" } ?: "还没装"} · ${if (KernelLauncher.connected(this)) "已连上" else "没连上"}"
                val a = "Ash ${packageManager.getPackageInfo(packageName, 0).versionName}　Android ${Build.VERSION.RELEASE}（API ${Build.VERSION.SDK_INT}）"
                ui.post {
                    reading = false
                    if (read != null && !isDestroyed) { items = read; kernelLine = k; appLine = a; render() }
                    if (readAgain && !isDestroyed) { readAgain = false; refresh() }
                }
            }, "ash-checkup").start()
        }
        ui.removeCallbacks(periodic)
        if (resumed) ui.postDelayed(periodic, REFRESH_MS)
    }

    private val periodic = Runnable { refresh() }

    // ---------- drawing ----------

    /** Draws the page again only when something it shows has changed, and keeps the scroll place when it does. */
    private fun render() {
        if (!::root.isInitialized) return
        val list = items
        val p = part
        val c = AshUi.p(this)
        val sig = "${p?.id}|$night|" + (list?.joinToString(",") { "${it.id}:${it.state}:${it.note}:${it.canSay}:${it.canRecheck}:${it.revocable}" } ?: "-") + "|$kernelLine" + switchSig()
        if (sig == shown) return
        shown = sig
        val y = scroll?.scrollY ?: 0
        root.removeAllViews()
        if (p == null) {
            root.addView(AshPage.navbar(this, "她的手和眼", "返回") { finish() })
            val s = AshPage.scroll(this, 14, overview(list), topDp = 6)
            scroll = s
            root.addView(s, LinearLayout.LayoutParams(-1, 0, 1f))
        } else {
            root.addView(AshPage.navbar(this, Checkup.title(p), "返回") { if (intent?.getStringExtra(EXTRA_PART) == null) { part = null; render() } else finish() })
            val s = AshPage.scroll(this, 14, partPage(p, list), topDp = 6)
            scroll = s
            root.addView(s, LinearLayout.LayoutParams(-1, 0, 1f))
        }
        scroll?.post { scroll?.scrollTo(0, y) }
        window.decorView.setBackgroundColor(c.bg)
    }

    private fun switchSig() = "|${TaskCapsule.residentKept(this)}|${NotificationSenseSettings.enabled(this)}|${NotificationSenseSettings.granted(this)}"

    private fun partIcon(p: OnboardingPlan.Part) = when (p.id) {
        "brain" -> R.drawable.ash_ic_cpu
        "alarm" -> R.drawable.ash_ic_alarm
        "notify" -> R.drawable.ash_ic_bell
        "awake" -> R.drawable.ash_ic_bolt
        "eyes" -> R.drawable.ash_ic_eye
        "files" -> R.drawable.ash_ic_image
        else -> R.drawable.ash_ic_pin
    }

    private fun overview(list: List<Checkup.Item>?): List<View> {
        val blocks = mutableListOf<View>()
        val c = AshUi.p(this)
        val sum = list?.let { Checkup.summarize(it) }
        val todo = sum?.todo ?: 0

        blocks += AshPage.panel(this).apply {
            setPadding(d(AshTokens.Space.md), d(AshTokens.Space.md), d(AshTokens.Space.md), d(AshTokens.Space.md))
            addView(AshUi.hstack(this@ConsoleActivity, 10).apply {
                addView(View(this@ConsoleActivity).apply { background = AshPage.icon(this@ConsoleActivity, R.drawable.ash_ic_phone).apply { setTint(if (todo > 0) c.warn else c.ok) } },
                    LinearLayout.LayoutParams(d(AshTokens.Size.icon), d(AshTokens.Size.icon)))
                addView(AshUi.vstack(this@ConsoleActivity).apply {
                    addView(AshUi.text(this@ConsoleActivity, "这台手机 · 体检", AshType(16f, 22f, 600, Role.INK)))
                    addView(AshUi.text(this@ConsoleActivity,
                        when { list == null -> "正在看…"; todo > 0 -> "$todo 项要处理，不然她可能被系统停掉"; else -> "都好着" },
                        AshTokens.Type.caption, if (list == null) null else if (todo > 0) c.warn else c.ok))
                }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            })
            if (sum != null) addView(AshUi.vstack(this@ConsoleActivity, 8).apply {
                OnboardingPlan.PARTS.chunked(2).forEach { pair ->
                    addView(AshUi.hstack(this@ConsoleActivity, 8).apply {
                        pair.forEach { addView(partCell(it, sum.todo(it)), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)) }
                        if (pair.size == 1) addView(View(this@ConsoleActivity), LinearLayout.LayoutParams(0, 0, 1f))
                    })
                }
            }, LinearLayout.LayoutParams(-1, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = d(AshTokens.Space.sm) })
        }

        // What the old diagnostics page did besides listing permissions.
        blocks += AshUi.group(this, "大脑", rows = listOf(
            AshUi.row(this, "大脑", kernelLine.ifEmpty { "正在看…" }),
            AshUi.hstack(this, 8).apply {
                setPadding(d(AshTokens.Space.rowX), d(AshTokens.Space.xs), d(AshTokens.Space.rowX), d(AshTokens.Space.sm))
                listOf("启动" to KernelLauncher.ACTION_START, "停止" to KernelLauncher.ACTION_STOP, "重启" to KernelLauncher.ACTION_RESTART).forEach { (label, action) ->
                    addView(AshPage.smallButton(this@ConsoleActivity, label, AshUi.Kind.NEUTRAL) { startKernel(action) })
                }
            },
        ), iconInset = false)

        blocks += AshUi.group(this, "其他", rows = listOf(
            AshUi.row(this, "再走一遍引导", "一项一项看哪些还没开", AshPage.icon(this, R.drawable.ash_ic_list), trailing = chevron()) { startActivity(Intent(this, OnboardingActivity::class.java)) },
            AshUi.row(this, "显示虚拟屏预览", "Ash 在后台操作应用时，小窗里看她的屏幕", AshPage.icon(this, R.drawable.ash_ic_eye), trailing = chevron()) { showPreview() },
            switchRow("灵动岛常驻入口", residentLine(), TaskCapsule.residentKept(this), true) { on -> phone("config.switch.set", JSONObject().put("name", "island_resident").put("on", on)) { render() } },
            switchRow("读取通知（可选）", notificationLine(), NotificationSenseSettings.enabled(this), true) { setNotificationSense(it) },
            AshUi.row(this, "系统的通知读取权限", null, AshPage.icon(this, R.drawable.ash_ic_bell), trailing = chevron()) { openNotificationAccess() },
        ), footer = appLine.ifEmpty { null }, iconInset = false)
        return blocks
    }

    private fun chevron(): View = View(this).apply {
        layoutParams = ViewGroup.LayoutParams(d(AshTokens.Size.iconSm), d(AshTokens.Size.iconSm))
        background = AshPage.icon(this@ConsoleActivity, R.drawable.ash_ic_chev).apply { setTint(AshUi.p(this@ConsoleActivity).text3) }
    }

    /** A row with a switch; [on] false and [allowed] false (a grant it needs is missing) leaves the switch out. */
    private fun switchRow(title: String, sub: String, on: Boolean, allowed: Boolean, onSet: (Boolean) -> Unit): View =
        AshUi.AshSwitch(this).let { sw ->
            sw.set(on); sw.onChange = onSet
            // The whole row is the switch's to tap (the switch itself is only 28dp high).
            AshUi.row(this, title, sub, trailing = if (!allowed) null else sw, onClick = if (!allowed) null else ({ sw.performClick() }))
        }.apply {
            (getChildAt(0) as? LinearLayout)?.let { col -> for (i in 0 until col.childCount) (col.getChildAt(i) as? TextView)?.apply { maxLines = 3; ellipsize = null } }
        }

    private fun partCell(p: OnboardingPlan.Part, todo: Int): View {
        val c = AshUi.p(this)
        val trouble = todo > 0 && !Checkup.optional(p)
        val line = Checkup.cellText(p, todo)
        // 14dp is the design's own radius for these cells (HomePages 「她的手和眼」); it is between the tokens' 12 and 16.
        return AshUi.vstack(this, 6).apply {
            background = AshUi.rounded(if (trouble) c.warnSoft else c.surface2, AshUi.dpF(this@ConsoleActivity, 14f))
            setPadding(d(AshTokens.Space.sm), d(10), d(AshTokens.Space.sm), d(10))
            isClickable = true
            setOnClickListener { part = p; render() }
            addView(AshUi.hstack(this@ConsoleActivity, 6).apply {
                addView(View(this@ConsoleActivity).apply { background = AshPage.icon(this@ConsoleActivity, partIcon(p)).apply { setTint(if (trouble) c.warn else c.text2) } },
                    LinearLayout.LayoutParams(d(AshTokens.Size.iconXs), d(AshTokens.Size.iconXs)))
                addView(AshUi.text(this@ConsoleActivity, p.title, AshType(13f, 18f, 400, null), if (trouble) c.warn else c.text2, maxLines = 1))
            })
            addView(AshUi.text(this@ConsoleActivity, line, AshType(14f, 20f, 600, null), if (trouble) c.warn else if (todo == 0) c.ok else c.text3))
        }
    }

    private fun partPage(p: OnboardingPlan.Part, list: List<Checkup.Item>?): List<View> {
        val c = AshUi.p(this)
        val mine = list?.filter { it.part.id == p.id }.orEmpty()
        val todo = mine.count { it.state == Checkup.State.OFF }
        val blocks = mutableListOf<View>()
        blocks += AshUi.text(this, if (list == null) "正在看…" else if (todo == 0) "这一格都好着。" else if (Checkup.optional(p)) "$todo 项没开，不开也行，开了她会更懂你。" else "$todo 项要处理，不然她可能做不好这一块。",
            AshTokens.Type.callout, if (todo > 0 && !Checkup.optional(p)) c.warn else null).apply { setPadding(d(6), 0, d(6), 0) }
        if (mine.isNotEmpty()) blocks += AshUi.group(this, rows = mine.map { itemRow(it) }, iconInset = true)
        return blocks
    }

    /** One item: ✓ or ! , its name, one line of why, and what to do about it (「去开启」; 「测试」 where it can be felt). */
    private fun itemRow(item: Checkup.Item): View {
        val c = AshUi.p(this)
        val on = item.state == Checkup.State.ON
        val said = item.state == Checkup.State.SAID
        val warn = item.state == Checkup.State.OFF && !Checkup.optional(item.part)
        val tone = if (on) AshUi.Tone.OK else if (warn) AshUi.Tone.WARN else AshUi.Tone.MUTE
        val (soft, strong) = AshUi.toneColors(this, tone)
        val fixable = !on && !(said && !item.canRecheck) // a switch the system cannot read is the owner's word alone: nothing left to open
        val note = item.note?.takeIf { it.isNotBlank() && !on }
        return AshUi.hstack(this, 12).apply {
            gravity = Gravity.TOP
            minimumHeight = d(AshTokens.Size.listRow)
            setPadding(d(AshTokens.Space.rowX), d(10), d(AshTokens.Space.rowX), d(10))
            addView(android.widget.FrameLayout(this@ConsoleActivity).apply {
                background = AshUi.rounded(if (tone == AshUi.Tone.MUTE) c.surface2 else soft, AshUi.dpF(this@ConsoleActivity, AshTokens.Radius.iconTile.toFloat()))
                addView(View(this@ConsoleActivity).apply {
                    background = AshPage.icon(this@ConsoleActivity, if (on || said) R.drawable.ash_ic_check else R.drawable.ash_ic_alert).apply { setTint(if (tone == AshUi.Tone.MUTE) c.text2 else strong) }
                }, android.widget.FrameLayout.LayoutParams(d(AshTokens.Size.iconSm), d(AshTokens.Size.iconSm), Gravity.CENTER))
            }, LinearLayout.LayoutParams(d(30), d(30)))
            addView(AshUi.vstack(this@ConsoleActivity, 2).apply {
                addView(AshUi.text(this@ConsoleActivity, item.title, AshTokens.Type.listTitle))
                addView(AshUi.text(this@ConsoleActivity, item.why, AshTokens.Type.listSub))
                if (note != null) addView(AshUi.text(this@ConsoleActivity, note, AshTokens.Type.listSub, if (warn) c.warn else c.text2))
                if (!on || item.testable || item.revocable) addView(AshUi.hstack(this@ConsoleActivity, 8).apply {
                    if (fixable) addView(AshPage.smallButton(this@ConsoleActivity, "去开启", AshUi.Kind.SECONDARY) { fix(item) })
                    // the owner opened it and Ash still does not see it on: look again, or take their word for it
                    if (item.canRecheck && !on) addView(AshPage.smallButton(this@ConsoleActivity, OnboardingContent.Words.RECHECK, AshUi.Kind.NEUTRAL) { recheck.start() })
                    if (item.canSay) addView(AshPage.smallButton(this@ConsoleActivity, OnboardingContent.Words.SAID_BUTTON, AshUi.Kind.NEUTRAL) {
                        phone("config.owner_said", JSONObject().put("item", item.id)) { shown = ""; refresh() }
                    })
                    if (item.testable) addView(AshPage.smallButton(this@ConsoleActivity, "测试", AshUi.Kind.NEUTRAL) {
                        Permissions.all.firstOrNull { p -> p.key == item.id }?.test?.invoke(this@ConsoleActivity)
                    })
                    if (item.revocable) addView(AshPage.smallButton(this@ConsoleActivity, "撤销", AshUi.Kind.NEUTRAL) {
                        phone("config.permission.revoke", JSONObject().put("name", item.id)) { shown = ""; refresh() }
                    })
                }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = d(AshTokens.Space.xs) })
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            if (on) addView(AshUi.tag(this@ConsoleActivity, "已开", AshUi.Tone.OK))
            else if (said) addView(AshUi.tag(this@ConsoleActivity, OnboardingContent.Words.SAID_MARK, AshUi.Tone.MUTE))
        }
    }

    // ---------- doing ----------

    /** 「去开启」: the same thing the capability of the same name does; the phone maker's own switches are the owner's tap on their entry. */
    private fun fix(item: Checkup.Item) {
        when (item.id) {
            Checkup.KERNEL_PACKAGE -> startActivity(Intent(this, OnboardingActivity::class.java)) // the guide starts with installing it
            Checkup.KERNEL_LINK -> startKernel(KernelLauncher.ACTION_START)
            in ConfigStatus.NAMES -> Thread({ Capabilities.call(this, "config.permission.request", JSONObject().put("name", item.id)) }, "ash-checkup-fix").start()
            else -> Permissions.all.firstOrNull { it.key == item.id }?.open(this)
        }
    }

    private fun startKernel(action: String) {
        if (KernelLauncher.installedVersion(this) == null) { Toast.makeText(this, "大脑还没装", Toast.LENGTH_SHORT).show(); return }
        if (!KernelLauncher.start(this, action)) Toast.makeText(this, "没能叫动大脑", Toast.LENGTH_SHORT).show()
    }

    private fun residentLine() =
        if (!TaskCapsule.residentKept(this)) "关着：灵动岛只在任务进行中、或有你没看过的新东西时出现。"
        else "开着：平时贴着摄像头显示她的头像。轻点直接跟她说，长按打开 Ash，上划收起到下次解锁。"

    private fun notificationLine(): String {
        val enabled = NotificationSenseSettings.enabled(this)
        val granted = NotificationSenseSettings.granted(this)
        return when {
            !enabled -> "关着。系统授权：${if (granted) "已授权，但不会读" else "还没授权"}。"
            !granted -> "开着，在等系统的读取权限；这之前不会读任何通知内容。"
            else -> "开着：只读之后新来的通知（应用、标题、正文）。"
        }
    }

    private fun setNotificationSense(on: Boolean) {
        if (!on) { phone("config.switch.set", JSONObject().put("name", "notifications_read").put("on", false)) { shown = ""; render() }; return }
        AlertDialog.Builder(this)
            .setTitle("让她读新来的通知？")
            .setMessage("只有你开了这个开关、又在系统里给了读取权限，她才会读新通知的应用、标题和正文，并交给这台手机上的大脑。关掉开关或收回系统权限就停；已经在通知栏里的不会补读。")
            .setNegativeButton("取消") { _, _ -> shown = ""; render() }
            .setOnCancelListener { shown = ""; render() }
            .setPositiveButton("继续") { _, _ ->
                phone("config.switch.set", JSONObject().put("name", "notifications_read").put("on", true)) { shown = ""; render() }
            }.show()
    }

    private fun openNotificationAccess() {
        try {
            startActivity(NotificationSenseSettings.accessIntent(this))
        } catch (_: Exception) {
            try { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
            catch (_: Exception) { Toast.makeText(this, "打不开系统的通知读取设置", Toast.LENGTH_SHORT).show() }
        }
    }


    private fun showPreview() = VScreenPreview.show(this) { shown ->
        val msg = when (shown) {
            VScreenPreview.Shown.OK -> "已显示虚拟屏预览"
            VScreenPreview.Shown.NO_SCREEN -> "现在没有虚拟屏（Ash 用到时会自动显示预览）"
            VScreenPreview.Shown.NO_PERMISSION -> "先在「眼睛和手」里开悬浮窗"
        }
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    companion object {
        /** Open straight onto one part ([OnboardingPlan.Part.id]). */
        const val EXTRA_PART = "ai.ash.extra.CHECKUP_PART"
        private const val STATE_PART = "ai.ash.state.PART"
        private const val REFRESH_MS = 2_500L
    }
}
