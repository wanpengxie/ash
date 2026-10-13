package ai.ash.ui

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import ai.ash.ui.design.AshPage
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi

/**
 * 「她的主页」 and the pages under it, drawn natively (the web page's home.js and home-*.js): a layer over the chat holding a stack of
 * pages, the first of which is the home page. It speaks to the kernel only through [port]; each page reads what it shows by itself
 * and draws it again when the ledger moves ([HumanPort.onChange]) or the link comes back.
 *
 * What the chat gives it: [composeHook] (put words in the message box; also the page-level 「问问她这件事」), [jumpHook] (show a message
 * in the conversation). [name] follows her IDENTITY.md; [onName] tells the chat's bar.
 */
class HomePages(private val activity: Activity, private val port: HumanPort, private val files: ChatFiles? = null) : ChatHooks.Home, HomeNav {
    private val c = AshUi.p(activity)
    private val main = Handler(Looper.getMainLooper())
    private val root = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(c.bg); visibility = View.GONE; isClickable = true }
    private val stage = FrameLayout(activity)
    private val banner = Hk.note(activity, "还没连上。连上后这里会自动刷新。", "warn").apply {
        gravity = Gravity.CENTER; background = AshUi.rounded(c.warnSoft, AshUi.dpF(activity, AshTokens.Radius.sm.toFloat())); minHeight = AshUi.dp(activity, 36); visibility = View.GONE
    }
    private val names = HomeNames(port)
    private val intents = HomeIntents()
    private class Entry(val page: HomePage, val screen: View)
    private val stack = ArrayList<Entry>()
    private var agent: String? = null
    private var shown = false
    private var wasDown = false
    private var changeQueued = false
    private val onChange = { if (!changeQueued) { changeQueued = true; main.postDelayed({ changeQueued = false; if (shown) stack.toList().forEach { it.page.changed() } }, 120) } }

    var composeHook: ((text: String, turn: String?) -> Unit)? = null
    var jumpHook: ((id: String) -> Unit)? = null
    var onName: ((String) -> Unit)? = null
    val name: String get() = names.name

    override val view: View get() = root

    init {
        root.addView(banner, LinearLayout.LayoutParams(-1, -2).apply { setMargins(AshUi.dp(activity, 16), AshUi.dp(activity, 8), AshUi.dp(activity, 16), 0) })
        root.addView(stage, LinearLayout.LayoutParams(-1, 0, 1f))
        names.listen { n -> onName?.invoke(n) }
        port.onLink { open ->
            banner.visibility = if (open || !shown) View.GONE else View.VISIBLE
            if (open) names.refresh()
            if (open && wasDown && shown) stack.toList().forEach { it.page.refresh() }
            wasDown = !open
        }
        names.refresh()
    }

    override fun open() = openPage(null, null)

    /** Opens the home page (of the agent [agent], or of her), and [section] on top of it ([arg]: what that page was asked about). */
    fun openPage(section: String?, agent: String?, arg: String? = null) {
        if (section == "apps") { apps(); return }
        hideIme()
        disposeAll()
        this.agent = agent?.takeIf { Regex("^agent:[a-z][a-z0-9_-]*$").matches(it) && it != port.primary }
        if (!shown) { shown = true; port.onChange(onChange) }
        banner.visibility = if (port.open) View.GONE else View.VISIBLE
        root.visibility = View.VISIBLE
        push("home", null, false)
        if (section != null && section != "home" && make(section, arg) != null) push(section, arg, false)
        names.refresh()
        if (AshUi.motionOn(activity)) {
            root.alpha = 0f; root.translationY = AshUi.dpF(activity, 24f)
            root.animate().alpha(1f).translationY(0f).setDuration(AshTokens.Motion.sheet).setInterpolator(AshTokens.Motion.easing()).start()
        }
    }

    override fun back(): Boolean {
        if (!shown) return false
        if (stack.size <= 1) close() else popPage()
        return true
    }

    override fun pop() { back() }

    private fun hideIme() { activity.currentFocus?.let { activity.getSystemService(android.view.inputmethod.InputMethodManager::class.java)?.hideSoftInputFromWindow(it.windowToken, 0) } }

    private fun disposeAll() { stack.forEach { it.page.dispose() }; stack.clear(); stage.removeAllViews() }

    // ---- HomeNav
    override fun close() {
        if (!shown) return
        hideIme()
        shown = false
        port.removeChange(onChange)
        stack.forEach { it.page.dispose() }
        val done = { if (!shown) { stack.clear(); stage.removeAllViews(); root.visibility = View.GONE; root.alpha = 1f; root.translationY = 0f } }
        if (AshUi.motionOn(activity)) root.animate().alpha(0f).translationY(AshUi.dpF(activity, 24f)).setDuration(AshTokens.Motion.sheet).setInterpolator(AshTokens.Motion.easing()).withEndAction(done).start() else done()
    }

    override fun go(id: String, arg: String?) { if (shown) push(id, arg, true) }

    override fun home() {
        val base = stack.firstOrNull() ?: return
        while (stack.size > 1) { val e = stack.removeAt(stack.size - 1); e.page.dispose(); stage.removeView(e.screen) }
        base.screen.visibility = View.VISIBLE
        base.page.refresh()
    }

    override fun compose(text: String, turn: String?) { close(); composeHook?.invoke(text, turn) }
    override fun jump(id: String) { close(); jumpHook?.invoke(id) }
    override fun apps() { close(); activity.startActivity(HomeRoute.appsIntent(activity)) }

    // ---- the stack
    private fun env() = HomeEnv(activity, port, this, names, intents, agent, files)

    private fun make(id: String, arg: String?): HomePage? = env().let { e ->
        when (id) {
            "home" -> HmHome(e, arg)
            "coworker" -> HmCoworker(e, arg)
            "waiting", "approvals" -> HmWaiting(e, arg)
            "settled" -> HmSettled(e, arg)
            "activity" -> HmActivity(e, arg)
            "upcoming", "plans" -> HmUpcoming(e, arg)
            "memory" -> HmMemory(e, arg)
            "identity" -> HmIdentity(e, arg)
            "promises" -> HmPromises(e, arg)
            "hands" -> HmHands(e, arg)
            "device" -> HmDevice(e, arg)
            "connect" -> HmConnect(e, arg)
            "browser" -> HmBrowser(e, arg)
            "backstage" -> HmBackstage(e, arg)
            "keys" -> HmKeys(e, arg)
            "model" -> HmModel(e, arg)
            "usage" -> HmUsage(e, arg)
            "advanced" -> HmAdvanced(e, arg)
            "files" -> HmFiles(e, arg)
            "file" -> HmFile(e, arg)
            else -> null
        }
    }

    private fun push(id: String, arg: String?, animate: Boolean) {
        val page = make(id, arg) ?: return
        hideIme()
        val bar = AshPage.navbar(activity, if (id == "home") null else page.title, if (stack.isEmpty()) "返回对话" else "返回", page.trailing) { back() }
        val screen = AshPage.screen(activity).apply {
            addView(bar)
            addView(AshPage.scroll(activity, 20, listOf(page.content()), 8), LinearLayout.LayoutParams(-1, 0, 1f))
        }
        val below = stack.lastOrNull()
        stack.add(Entry(page, screen))
        stage.addView(screen, FrameLayout.LayoutParams(-1, -1))
        if (animate && AshUi.motionOn(activity)) {
            screen.alpha = 0f; screen.translationX = AshUi.dpF(activity, 32f)
            screen.animate().alpha(1f).translationX(0f).setDuration(AshTokens.Motion.sheet).setInterpolator(AshTokens.Motion.easing()).withEndAction { below?.screen?.visibility = View.INVISIBLE }.start()
        } else below?.screen?.visibility = View.INVISIBLE
        page.refresh()
    }

    private fun popPage() {
        hideIme()
        val leaving = stack.removeAt(stack.size - 1)
        leaving.page.dispose()
        val under = stack.last()
        under.screen.visibility = View.VISIBLE
        under.page.refresh()
        if (AshUi.motionOn(activity)) leaving.screen.animate().alpha(0f).translationX(AshUi.dpF(activity, 32f)).setDuration(AshTokens.Motion.sheet).setInterpolator(AshTokens.Motion.easing()).withEndAction { stage.removeView(leaving.screen) }.start()
        else stage.removeView(leaving.screen)
    }
}
