package ai.ash.ui

import ai.ash.link.Link
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import ai.ash.R
import ai.ash.apps.Ui
import ai.ash.caps.Capabilities
import ai.ash.caps.config.ConfigStatus
import ai.ash.caps.config.KeepAliveStatus
import ai.ash.caps.config.KernelAutostart
import ai.ash.caps.config.OwnerWord
import ai.ash.caps.config.Standing
import ai.ash.caps.config.Permission
import ai.ash.caps.config.Permissions
import ai.ash.host.KernelGate
import ai.ash.host.KernelInstaller
import ai.ash.host.KernelLauncher
import ai.ash.host.KernelState
import ai.ash.ui.OnboardingContent.Look
import ai.ash.ui.OnboardingViews.Layout
import ai.ash.ui.OnboardingPlan.Kind
import ai.ash.ui.design.AshPage
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * The first-launch guide (SPEC-05 §9), one thing at a time: she says hello, installs her brain, then asks about each thing
 * she can have — why she wants it, what the owner gets, and two buttons (open it / not now) — and ends with how many are on.
 * [OnboardingPlan] decides which screen is next from the state of the kernel package and of `config.status`; this class reads
 * that state (off the main thread, once a second and whenever the owner comes back from a settings page), starts the kernel
 * when it does not run, and draws the screen. Every button asks for what the capability of the same name would. Each
 * screen can be passed on; nothing here is required.
 */
class OnboardingActivity : Activity() {
    private class Loaded(val kernel: KernelState, val items: List<ConfigStatus.Item>) {
        val rows get() = items.map { OnboardingPlan.Row(it.item, it.state) }
    }

    /** Where the kernel package is on its way in. */
    private enum class Install { IDLE, DOWNLOADING, CONFIRM }

    private val ui = Handler(Looper.getMainLooper())
    private val reader = Executors.newSingleThreadExecutor { Thread(it, "ash-onboarding-read").apply { isDaemon = true } }
    private val skipped = mutableSetOf<String>()
    private var kernelSkipped = false
    /** The owner pressed 「开始」 (the first screen is the greeting). */
    private var started = true
    /** Items the owner has been taken to the system's page for (so a switch the phone hides from Ash can then be confirmed). */
    private val opened = mutableSetOf<String>()
    private var loaded: Loaded? = null
    /** A read is under way (set on the main thread, cleared by the reading thread whatever happens). */
    @Volatile private var loading = false
    private val tick = Runnable { reload() }
    /** Back from a settings page: read at once and again a few times, since some phones report a change late. */
    private val recheck = ReturnRecheck(object : ReturnRecheck.Scheduler {
        override fun postDelayed(task: Runnable, ms: Long) { ui.postDelayed(task, ms) }
        override fun cancel(task: Runnable) { ui.removeCallbacks(task) }
    }) { reload() }
    /** A read was asked for while one was under way: it runs once that one is done. */
    @Volatile private var readAgain = false
    /** Until when 「再检查一次」 shows that it is looking (so a quick answer is still seen to have been looked for). */
    private var checkingUntil = 0L
    private var startsTried = 0
    private var lastStart = 0L
    /** When the kernel step first saw the kernel installed but not running (0: it is running, or not yet seen). */
    private var waitingSince = 0L
    @Volatile private var install = Install.IDLE
    /** How much of the kernel package is down, in percent, or -1 when the size is not known. */
    @Volatile private var percent = -1
    @Volatile private var megabytes = 0L
    @Volatile private var installError: String? = null

    /** The screens shown so far, and which one is on show (earlier than the last when the owner went back). */
    private val history = mutableListOf<OnboardingPlan.Page>()
    private var cursor = -1
    private var shown: String? = null
    private lateinit var holder: FrameLayout
    private var ring: AshUi.RingAvatar? = null
    private var ringLabel: android.widget.TextView? = null

    private val night get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    private val palette get() = AshUi.p(this)

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(if (night) R.style.Ash_Setup_Dark else R.style.Ash_Setup_Light)
        super.onCreate(savedInstanceState)
        savedInstanceState?.getStringArray(KEY_SKIPPED)?.let { skipped += it }
        savedInstanceState?.getStringArray(KEY_OPENED)?.let { opened += it }
        kernelSkipped = savedInstanceState?.getBoolean(KEY_KERNEL_SKIPPED) ?: false
        started = savedInstanceState?.getBoolean(KEY_STARTED) ?: !intent.getBooleanExtra(EXTRA_WELCOME, false)
        holder = FrameLayout(this).apply { setBackgroundColor(palette.bg) }
        setContentView(holder)
        Ui.insets(holder)
        Ui.systemBars(this)
    }

    override fun onResume() {
        super.onResume()
        recheck.start()
    }

    override fun onPause() {
        recheck.cancel()
        ui.removeCallbacks(tick)
        super.onPause()
    }

    override fun onDestroy() {
        reader.shutdown()
        super.onDestroy()
    }

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        out.putStringArray(KEY_SKIPPED, skipped.toTypedArray())
        out.putBoolean(KEY_KERNEL_SKIPPED, kernelSkipped)
        out.putBoolean(KEY_STARTED, started)
        out.putStringArray(KEY_OPENED, opened.toTypedArray())
    }

    /** Reads the kernel package and `config.status` (which may wait on Health Connect, so not on the main thread). */
    private fun reload() {
        ui.removeCallbacks(tick)
        if (loading) readAgain = true
        else {
            loading = true
            reader.execute {
                try {
                    val read = runCatching { Loaded(KernelLauncher.state(this), items()) }.getOrNull()
                    ui.post { if (read != null && !isDestroyed) { loaded = read; keepKernelUp(read); render() } }
                } finally {
                    loading = false
                    if (readAgain) { readAgain = false; ui.post { if (!isDestroyed) reload() } }
                }
            }
        }
        ui.postDelayed(tick, 1000)
    }

    /** `config.status` and the keep-alive switches the phone keeps. */
    private fun items(): List<ConfigStatus.Item> {
        val keepAlive = if (KeepAliveStatus.supported()) KeepAliveStatus.items(this).filter { it.item !in ConfigStatus.NAMES } else emptyList()
        val word = OwnerWord.of(this)
        return (ConfigStatus.all(this) + keepAlive).map { row ->
            // what the owner said counts until the system shows it on (and then the word is dropped); a switch the phone keeps from Ash is the word alone, already in its state
            if (row.state == ConfigStatus.UNSUPPORTED || unreadable(row.item)) row
            else if (word.settle(row.item, row.state == ConfigStatus.GRANTED, unreadable = false) == Standing.SAID) ConfigStatus.Item(row.item, OnboardingPlan.SAID, row.detail)
            else row
        }
    }

    /** The phone keeps this switch where Ash cannot read it: the owner's word is all there is. */
    private fun unreadable(item: String): Boolean = permissionOf(item)?.confirmable?.invoke(this) == true

    /** On the brain screen, an installed kernel that does not run is started, a few times, a while apart. */
    private fun keepKernelUp(l: Loaded) {
        if (l.kernel != KernelState.NOT_RUNNING) { startsTried = 0; waitingSince = 0; return }
        if (!started || kernelSkipped) return
        val now = SystemClock.elapsedRealtime()
        if (waitingSince == 0L) waitingSince = now
        if (KernelGate.action(l.kernel, startsTried) == KernelGate.Action.START && now - lastStart > START_GAP_MS) {
            KernelLauncher.start(this)
            startsTried++; lastStart = now
        }
    }

    // ---- which screen -----------------------------------------------------------------------------------------------

    private fun live(l: Loaded): OnboardingPlan.Page =
        if (!started) OnboardingPlan.Page(Kind.WELCOME) else OnboardingPlan.page(l.kernel, l.rows, kernelSkipped, skipped)

    private fun key(p: OnboardingPlan.Page) = "${p.kind}:${p.item ?: ""}"

    /** Keeps [history] up with the live screen; returns the screen to draw. */
    private fun current(l: Loaded): OnboardingPlan.Page {
        val now = live(l)
        val atEnd = cursor == history.lastIndex
        if (atEnd && (history.isEmpty() || key(history.last()) != key(now))) { history += now; cursor = history.lastIndex }
        return history[cursor]
    }

    private fun goBack() {
        val l = loaded
        if (l == null || cursor <= 0 || current(l).kind == Kind.DONE) return done()
        cursor--
        render()
    }

    private fun forward() {
        if (cursor < history.lastIndex) cursor++
        render()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() = goBack()

    // ---- drawing ----------------------------------------------------------------------------------------------------

    private fun render() {
        val l = loaded ?: return
        if (KernelInstaller.failure != null && install != Install.IDLE) install = Install.IDLE
        val page = current(l)
        val reviewing = cursor < history.lastIndex
        val signature = signature(page, l, reviewing)
        if (page.kind == Kind.BRAIN) updateBrain(l)
        if (signature == shown) return
        val firstDraw = shown == null
        val sameScreen = shown?.substringBefore('|') == signature.substringBefore('|')
        shown = signature
        val view = when (page.kind) {
            Kind.WELCOME -> welcomePage()
            Kind.BRAIN -> brainPage(l, reviewing)
            Kind.ITEM -> itemPage(page.item!!, l, reviewing)
            Kind.DONE -> donePage(l)
        }
        holder.removeAllViews()
        holder.addView(view, OnboardingViews.frame())
        if (!firstDraw && !sameScreen) enter(view)
    }

    /** A new screen comes up from a little below, fading in. */
    private fun enter(v: View) {
        if (!AshUi.motionOn(this)) return
        v.alpha = 0f; v.translationY = AshUi.dpF(this, 6f)
        v.animate().alpha(1f).translationY(0f).setDuration(AshTokens.Motion.message).setInterpolator(AshTokens.Motion.easing()).start()
    }

    /** Everything that changes what is drawn, apart from the progress of the download (which moves the ring in place). */
    private fun signature(p: OnboardingPlan.Page, l: Loaded, reviewing: Boolean): String {
        val head = key(p)
        return head + "|" + when (p.kind) {
            Kind.WELCOME -> ""
            Kind.BRAIN -> brainPhase(l).name + reviewing + startsTried + (waitingSince != 0L && SystemClock.elapsedRealtime() - waitingSince >= OnboardingPlan.KERNEL_WAIT_MS)
            Kind.ITEM -> {
                val item = p.item!!
                val state = l.items.firstOrNull { it.item == item }?.state
                "$state$reviewing${item in opened}${canRecheck(item)}${canSay(item)}${checking()}${OnboardingPlan.dotParts(l.kernel, l.rows, skipped, history.mapNotNull { it.item }).joinToString(",")}"
            }
            Kind.DONE -> OnboardingPlan.summary(l.kernel, l.rows).let { "${it.on}/${it.off.joinToString(",")}" }
        }
    }

    private fun dp(v: Int) = AshUi.dp(this, v)

    /** The page's frame: [dots] on top (or nothing), [body] in the middle (centred, scrolls when it does not fit), [bottom] at the foot. */
    private fun frame(dots: View?, body: View, bottom: View, glow: Boolean = false): View {
        val c = palette
        val scroll = ScrollView(this).apply {
            isFillViewport = true; overScrollMode = View.OVER_SCROLL_NEVER
            addView(body, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        val middle = FrameLayout(this).apply {
            if (glow) addView(OnboardingViews.glow(this@OnboardingActivity), FrameLayout.LayoutParams(dp(AshTokens.Size.glowW), dp(AshTokens.Size.glowH), Gravity.CENTER))
            addView(scroll, OnboardingViews.frame())
        }
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; setBackgroundColor(c.bg)
            if (dots != null) addView(dots, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(Layout.dotsRow)))
            addView(middle, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(bottom, OnboardingViews.fill())
        }
    }

    private fun bottom(padBottom: Int, vararg buttons: View): LinearLayout = AshUi.vstack(this, Layout.barGap).apply {
        setPadding(dp(AshTokens.Space.lg), dp(AshTokens.Space.xs), dp(AshTokens.Space.lg), dp(padBottom))
        buttons.forEach { addView(it) }
    }

    private fun centered(gap: Int, padX: Int, vararg views: View): LinearLayout = OnboardingViews.column(this, gap).apply {
        gravity = Gravity.CENTER; setPadding(dp(padX), 0, dp(padX), dp(AshTokens.Space.xl))
        views.forEach { addView(it) }
    }

    private fun primary(label: String, onClick: () -> Unit, enabled: Boolean = true) =
        AshUi.button(this, label, if (enabled) AshUi.Kind.PRIMARY else AshUi.Kind.NEUTRAL, AshUi.BtnSize.LG, block = true, onClick = if (enabled) onClick else null)
            .also { if (!enabled) AshUi.disable(it) }

    // 你好
    private fun welcomePage(): View {
        val c = palette
        val face = OnboardingViews.avatar(this, "default", Layout.welcomeAvatar, AshUi.AvatarView.State.THINKING)
        val title = AshUi.text(this, OnboardingContent.Words.WELCOME_TITLE, OnboardingViews.welcomeTitle).apply { gravity = Gravity.CENTER }
        val body = AshUi.text(this, OnboardingContent.Words.WELCOME_BODY, OnboardingViews.welcomeBody).apply { gravity = Gravity.CENTER }
        val stack = centered(14, Layout.sideWide, face, title, body)
        (title.layoutParams as LinearLayout.LayoutParams).topMargin = dp(Layout.welcomeTitleTop)
        // the avatar's own margins (its ring) are negative; the column needs the room back
        return frame(null, stack, bottom(Layout.barSimple, primary(OnboardingContent.Words.START, { started = true; cursorToLive() })), glow = true)
            .also { it.setBackgroundColor(c.bg) }
    }

    private fun cursorToLive() {
        val l = loaded
        if (l != null) { cursor = history.lastIndex; render() }
    }

    // 大脑
    private enum class Brain { IDLE, NO_URL, DOWNLOADING, CONFIRM, ERROR, STARTING, GAVE_UP, READY }

    private fun brainPhase(l: Loaded): Brain = when {
        l.kernel == KernelState.BOUND -> Brain.READY
        l.kernel == KernelState.NOT_INSTALLED -> when {
            installError != null || KernelInstaller.failure != null -> Brain.ERROR
            install == Install.DOWNLOADING -> Brain.DOWNLOADING
            install == Install.CONFIRM -> Brain.CONFIRM
            !KernelInstaller.configured -> Brain.NO_URL
            else -> Brain.IDLE
        }
        KernelGate.action(l.kernel, startsTried) == KernelGate.Action.WAIT -> Brain.GAVE_UP
        else -> Brain.STARTING
    }

    private fun brainPage(l: Loaded, reviewing: Boolean): View {
        val c = palette
        val phase = brainPhase(l)
        val rom = KernelAutostart.rom(Build.MANUFACTURER)
        val face = AshUi.RingAvatar(this, Layout.brainRing, Layout.brainRingRadius).apply {
            image = OnboardingViews.face(this@OnboardingActivity, if (phase == Brain.READY) "success" else "thinking")
            spinning = phase == Brain.STARTING
        }
        ring = face
        val label = AshUi.text(this, "", OnboardingViews.brainLabel, c.her).apply { gravity = Gravity.CENTER; visibility = View.GONE }
        ringLabel = label
        val (title, body) = when (phase) {
            Brain.NO_URL -> "我的大脑还没装上" to "这个版本没有带下载地址。请先自己把大脑的安装包装好，再回来。"
            Brain.ERROR -> "大脑没装上" to (OnboardingPlan.brainWords(installError ?: KernelInstaller.failure ?: "") + "。可以再试一次。")
            Brain.GAVE_UP -> "大脑还没醒来" to "已经试着叫醒它 $startsTried 次，还是没有起来。"
            Brain.READY -> "大脑已经装好了" to "它醒着，我随时在。"
            Brain.CONFIRM -> OnboardingContent.Words.BRAIN_TITLE to "下载好了。请在系统弹出的安装页上点「安装」。"
            Brain.STARTING -> "大脑装好了" to listOfNotNull("正在叫醒它，一会儿就好。", OnboardingPlan.kernelPrompt(rom)).joinToString("")
            else -> OnboardingContent.Words.BRAIN_TITLE to listOfNotNull("一两分钟。", OnboardingPlan.kernelPrompt(rom)).joinToString("")
        }
        val titleView = AshUi.text(this, title, OnboardingViews.brainTitle).apply { gravity = Gravity.CENTER }
        val bodyView = AshUi.text(this, body, OnboardingViews.brainBody).apply { gravity = Gravity.CENTER }
        val stack = centered(14, Layout.sideWide, face, label, titleView, bodyView)
        val waited = if (waitingSince == 0L) 0L else SystemClock.elapsedRealtime() - waitingSince
        val refused = phase == Brain.STARTING && OnboardingPlan.showRefusedRetry(rom, waited)
        val skip = OnboardingViews.ghost(this, OnboardingContent.Words.SKIP) { kernelSkipped = true; render() }
        val buttons = mutableListOf<View>()
        when {
            reviewing -> buttons += primary("继续", { forward() })
            phase == Brain.IDLE -> {
                buttons += primary(if (KernelInstaller.mayInstall(this)) "下载并安装" else "去允许安装应用", { installKernel() }); buttons += skip
            }
            phase == Brain.ERROR -> { buttons += primary("再试一次", { installKernel() }); buttons += skip }
            phase == Brain.NO_URL -> buttons += skip
            phase == Brain.GAVE_UP || refused -> { buttons += primary("再试一次", { retryKernel() }); buttons += skip }
            else -> buttons += primary("请稍等", {}, enabled = false)
        }
        if (refused) OnboardingPlan.kernelRetryHint(rom)?.let { hint -> stack.addView(AshUi.text(this, hint, AshTokens.Type.caption).apply { gravity = Gravity.CENTER }) }
        return frame(null, stack, bottom(Layout.barSimple, *buttons.toTypedArray())).also { updateBrain(l) }
    }

    /** The ring and the line under it follow the download without redrawing the screen. */
    private fun updateBrain(l: Loaded) {
        val r = ring ?: return
        val label = ringLabel ?: return
        when (brainPhase(l)) {
            Brain.DOWNLOADING -> {
                r.setProgress(if (percent >= 0) percent / 100f else 0f)
                label.text = if (percent >= 0) "正在下载 $percent%" else "正在下载 $megabytes MB"; label.visibility = View.VISIBLE
            }
            Brain.CONFIRM -> { r.setProgress(1f); label.text = "下载好了"; label.visibility = View.VISIBLE }
            Brain.STARTING -> { label.text = "正在叫醒大脑…"; label.visibility = View.VISIBLE }
            Brain.READY -> r.setProgress(1f, animate = false)
            else -> { r.setProgress(0f, animate = false); label.visibility = View.GONE }
        }
    }

    private fun retryKernel() {
        startsTried = 0; lastStart = 0; waitingSince = SystemClock.elapsedRealtime()
        loaded?.let { keepKernelUp(it) }
        render()
    }

    // 一次一件 / 要你亲手开的
    private fun itemPage(item: String, l: Loaded, reviewing: Boolean): View {
        val row = l.items.first { it.item == item }
        val permission = permissionOf(item)
        val copy = OnboardingContent.of(item, permission?.title ?: item, permission?.why ?: "")
        val granted = row.state == ConfigStatus.GRANTED
        val said = row.state == OnboardingPlan.SAID
        val seen = history.mapNotNull { it.item }
        // one dot per part of her body: the parts before this one are done, this one is the long bar
        val parts = OnboardingPlan.dotParts(l.kernel, l.rows, skipped, seen)
        val at = parts.indexOf(OnboardingPlan.partOf(item).id)
        val states = parts.mapIndexed { i, _ ->
            when { i == at -> OnboardingViews.DotState.ACTIVE; i < at -> OnboardingViews.DotState.DONE; else -> OnboardingViews.DotState.UPCOMING }
        }
        val gap = if (copy.look == Look.HAND) Layout.pageGapHand else Layout.pageGapAsk
        val body = AshUi.vstack(this, gap).apply { setPadding(dp(Layout.sideX), 0, dp(Layout.sideX), dp(Layout.sideX)); gravity = Gravity.CENTER_VERTICAL }
        body.addView(OnboardingViews.sayRow(this, copy.expression, copy.say))
        when (copy.look) {
            Look.ASK -> copy.preview?.let { p ->
                body.addView(OnboardingViews.previewCard(this, p), OnboardingViews.fill().apply {
                    topMargin = dp(Layout.previewTop); marginStart = dp(Layout.previewSide); marginEnd = dp(Layout.previewSide)
                })
                body.addView(AshUi.text(this, p.caption, AshTokens.Type.caption).apply { gravity = Gravity.CENTER }, OnboardingViews.fill())
            }
            Look.HAND -> copy.hand?.let { h ->
                body.addView(OnboardingViews.handCard(this, h), OnboardingViews.fill().apply { topMargin = dp(AshTokens.Space.xs) })
                body.addView(OnboardingViews.steps(this, h), OnboardingViews.fill())
            }
        }
        if (granted) body.addView(AshUi.resolved(this, "已打开", ok = true))
        else if (said) body.addView(AshUi.resolved(this, OnboardingContent.Words.SAID_MARK, ok = true))
        val buttons = mutableListOf<View>()
        when {
            granted || said -> buttons += primary("继续", { forward() })
            else -> {
                buttons += OnboardingViews.iconButton(this, copy.primary, copy.icon) { opened += item; act(item); render() }
                // the owner has been to the system's page and Ash still does not see it on: look again, or take their word for it (two small buttons side by side)
                if (item in opened) {
                    val looking = checking()
                    val two = listOfNotNull(
                        if (canRecheck(item)) AshPage.smallButtonFill(this, if (looking) OnboardingContent.Words.CHECKING else OnboardingContent.Words.RECHECK, AshUi.Kind.NEUTRAL, if (looking) null else ::recheckNow) else null,
                        if (canSay(item)) AshPage.smallButtonFill(this, OnboardingContent.Words.SAID_BUTTON, AshUi.Kind.NEUTRAL) { sayOn(item) } else null,
                    )
                    if (two.isNotEmpty()) buttons += AshUi.hstack(this, AshTokens.Space.xs).apply {
                        two.forEach { addView(it, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)) }
                    }
                }
                buttons += OnboardingViews.ghost(this, OnboardingContent.Words.SKIP) { skip(item) }
            }
        }
        return frame(OnboardingViews.dots(this, states), body, bottom(Layout.barAsk, *buttons.toTypedArray()))
    }

    /** A read can tell something new only for an item Ash can read at all. */
    private fun canRecheck(item: String) = !unreadable(item)

    /** The owner may say it is on: always for an item Ash can read; for one it cannot, once what it needs first is on. */
    private fun canSay(item: String): Boolean = OwnerWord.mayBeSaid(item) && (!unreadable(item) || permissionOf(item)?.ready(this) == true)

    private fun checking() = SystemClock.elapsedRealtime() < checkingUntil

    /** 「再检查一次」: reads now; the button says it is looking for a moment. */
    private fun recheckNow() {
        checkingUntil = SystemClock.elapsedRealtime() + CHECK_SHOWN_MS
        reload()
        render()
        ui.postDelayed({ render() }, CHECK_SHOWN_MS)
    }

    /** 「我已经打开了」: taken at the owner's word; the screen goes on, and the system's own reading takes over once it shows it on. */
    private fun sayOn(item: String) {
        // Through the hub, the same word Ash calls when the owner tells it.
        HumanPort(Link.get(this).chat).also { it.start() }.call(Link.get(this).deviceId, "config.owner_said", org.json.JSONObject().put("item", item)) { _, _ -> runOnUiThread { reload() } }
    }

    /** 「先不用」: the screen is not asked again. */
    private fun skip(item: String) {
        skipped += item
        if (cursor < history.lastIndex) forward() else render()
    }

    // 准备好了
    private fun donePage(l: Loaded): View {
        val summary = OnboardingPlan.summary(l.kernel, l.rows)
        val face = AshUi.RingAvatar(this, Layout.doneRing, Layout.doneRingRadius).apply {
            image = OnboardingViews.face(this@OnboardingActivity, "success")
            setProgress(if (summary.total == 0) 1f else summary.on.toFloat() / summary.total)
        }
        val title = AshUi.text(this, OnboardingContent.Words.DONE_TITLE, AshTokens.Type.display).apply { gravity = Gravity.CENTER }
        val said = if (summary.off.isEmpty()) "开了 ${summary.on} 项，该开的都开好了。\n有什么想让我做的，直接跟我说。"
            else "开了 ${summary.on} 项。下面这几处你先没开，\n需要时在我的主页里随时能开："
        val body = AshUi.text(this, said, OnboardingViews.doneBody).apply { gravity = Gravity.CENTER }
        val stack = OnboardingViews.column(this, 10).apply {
            setPadding(dp(Layout.sideX), dp(Layout.doneTop), dp(Layout.sideX), dp(AshTokens.Space.xl))
            addView(face); addView(title, OnboardingViews.fill().apply { topMargin = dp(AshTokens.Space.sm + 2) }); addView(body)
            if (summary.off.isNotEmpty()) addView(tags(summary.offParts), OnboardingViews.fill().apply { topMargin = dp(AshTokens.Space.xs) })
        }
        return frame(null, stack, bottom(Layout.barSimple, primary(OnboardingContent.Words.DONE_BUTTON, { done() })))
    }

    /** The parts of her body that have something off, as small labels that wrap. */
    private fun tags(parts: List<OnboardingPlan.Part>): View =
        WrapRow(this, dp(AshTokens.Space.xs)).apply { parts.forEach { addView(OnboardingViews.offTag(this@OnboardingActivity, it.title)) } }

    /** Children laid out left to right, wrapping, each line centred. */
    private class WrapRow(ctx: Context, private val gap: Int) : ViewGroup(ctx) {
        override fun onMeasure(w: Int, h: Int) {
            val max = MeasureSpec.getSize(w)
            var x = 0; var y = 0; var line = 0
            for (i in 0 until childCount) {
                val v = getChildAt(i); v.measure(MeasureSpec.makeMeasureSpec(max, MeasureSpec.AT_MOST), MeasureSpec.UNSPECIFIED)
                if (x > 0 && x + v.measuredWidth > max) { x = 0; y += line + gap; line = 0 }
                x += v.measuredWidth + gap; line = maxOf(line, v.measuredHeight)
            }
            setMeasuredDimension(max, y + line)
        }

        override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
            val max = r - l
            val rows = mutableListOf<MutableList<View>>(mutableListOf())
            var x = 0
            for (i in 0 until childCount) {
                val v = getChildAt(i)
                if (x > 0 && x + v.measuredWidth > max) { rows.add(mutableListOf()); x = 0 }
                rows.last().add(v); x += v.measuredWidth + gap
            }
            var y = 0
            for (row in rows) {
                val width = row.sumOf { it.measuredWidth } + gap * (row.size - 1)
                var cx = (max - width) / 2
                for (v in row) { v.layout(cx, y, cx + v.measuredWidth, y + v.measuredHeight); cx += v.measuredWidth + gap }
                y += (row.maxOfOrNull { it.measuredHeight } ?: 0) + gap
            }
        }
    }

    // ---- doing ------------------------------------------------------------------------------------------------------

    /** The button of a screen does what the capability of the same name does; the keep-alive switches are the owner's tap on their entry. */
    private fun act(item: String) {
        if (item !in ConfigStatus.NAMES) return run { permissionOf(item)?.open(this) }
        Thread({ Capabilities.call(this, "config.permission.request", JSONObject().put("name", item)) }, "ash-onboarding-act").start()
    }

    private fun installKernel() {
        if (!KernelInstaller.mayInstall(this)) { startActivity(KernelInstaller.allowIntent(this)); return }
        installError = null; percent = -1; megabytes = 0; install = Install.DOWNLOADING; render()
        Thread({
            try {
                var last = -2
                val apk = KernelInstaller.download(this) { done, total ->
                    percent = if (total > 0) (done * 100 / total).toInt() else -1
                    megabytes = done / 1_000_000
                    if (percent != last) { last = percent; ui.post { loaded?.let { updateBrain(it) } } }
                }
                val bad = KernelInstaller.problem(this, apk)
                if (bad != null) { installError = bad; install = Install.IDLE; apk.delete() }
                else { install = Install.CONFIRM; KernelInstaller.install(this, apk) }
            } catch (e: Exception) {
                installError = "下载没成功，请检查网络后再试"; install = Install.IDLE
            }
            ui.post { render() }
        }, "ash-kernel-install").start()
    }

    private fun done() {
        startActivity(Intent(this, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }

    companion object {
        private const val KEY_SKIPPED = "skipped"
        private const val KEY_KERNEL_SKIPPED = "kernel_skipped"
        private const val KEY_STARTED = "started"
        private const val KEY_OPENED = "opened"
        private const val CHECK_SHOWN_MS = 700L
        /** Set when the guide is the first thing the owner sees: it starts with the greeting. */
        private const val EXTRA_WELCOME = "ai.ash.ui.onboarding.welcome"
        private const val PREFS = "ash.ui"
        private const val SEEN = "onboarding_seen"
        private const val START_GAP_MS = 20_000L

        /** The entries of [Permissions] that stand for items outside `config.status` (the keep-alive switches). */
        private val EXTRA_KEYS = mapOf("autostart" to "autostart", "kernel_autostart" to "kernel_autostart", "kernel_lock" to "kernel_lock")

        private fun permissionOf(item: String): Permission? {
            val key = ConfigStatus.PERMISSION_KEY[item] ?: EXTRA_KEYS[item] ?: return null
            return Permissions.all.firstOrNull { it.key == key }
        }

        @Volatile private var offered = false

        /** Shows the guide once, on the first launch; marks it seen right away so a crash or kill never loops it. */
        fun showOnce(from: Activity): Boolean {
            val prefs = from.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (prefs.getBoolean(SEEN, false)) return false
            prefs.edit().putBoolean(SEEN, true).apply()
            offered = true
            from.startActivity(Intent(from, OnboardingActivity::class.java).putExtra(EXTRA_WELCOME, true))
            return true
        }

        /** The kernel package is gone after the first launch: the guide (which starts with installing it) comes up once per run of the app. */
        fun offerKernel(from: Activity) {
            if (offered) return
            offered = true
            from.startActivity(Intent(from, OnboardingActivity::class.java))
        }
    }
}
