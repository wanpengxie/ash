package ai.ash.ui

import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import ai.ash.R
import ai.ash.apps.Ash
import ai.ash.apps.AppsPane
import ai.ash.host.HandRuntime
import ai.ash.host.KernelGate
import ai.ash.host.KernelLauncher
import ai.ash.caps.config.Permissions
import ai.ash.link.Link
import ai.ash.ui.design.AshUi

/**
 * Opening the app opens Ash: the chat ([ChatScreen], drawn natively) and nothing else on the screen. The owner's apps
 * ([AppsPane]) open over the chat from the 「应用」 button; an app opens in a task of its own in the isolated process, never in
 * here. [HomeRoute] decides which of the two an intent asks for. The chat has no connection of its own: it speaks the human
 * channel through [ai.ash.human.ChatBridge] (SPEC-05 §4.1).
 */
class HomeActivity : Activity() {
    private lateinit var content: FrameLayout
    private lateinit var chatScreen: ChatScreen
    private lateinit var port: HumanPort
    private lateinit var files: ChatFiles
    private lateinit var home: HomePages
    private var appsPane: AppsPane? = null
    private var codexPane: CodexPane? = null
    private var tab = HomeTab.CHAT
    private var resumed = false
    private val ui = Handler(Looper.getMainLooper())
    private val night get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    private var themedNight = false
    /** What the activity was given when it was made again (the Codex page's route waits here until the page is made). */
    private var saved: Bundle? = null
    private val backRouter = BackRouter(this, ::canGoBack, ::goBack)

    override fun onCreate(savedInstanceState: Bundle?) {
        themedNight = night
        setTheme(if (themedNight) R.style.Ash_Dark else R.style.Ash_Light)
        super.onCreate(savedInstanceState)
        saved = savedInstanceState
        ai.ash.apps.Ui.systemBars(this)
        port = HumanPort(Link.get(this).chat)
        files = ChatFiles(this, port)
        home = HomePages(this, port)
        chatScreen = ChatScreen(this, port, files, home, { showTab(HomeTab.APPS) }, { showTab(HomeTab.CODEX) })
        home.composeHook = { text, _ -> showTab(HomeTab.CHAT); chatScreen.compose(text) }
        home.jumpHook = { id -> showTab(HomeTab.CHAT); chatScreen.jumpTo(id) }
        home.onName = { name -> chatScreen.setName(name) }
        home.onShownChange = {
            backRouter.sync()
            syncChatShown()
            // Opening/closing the home overlay changes the IME owner even if the tab did not change.
            if (::content.isInitialized) ViewCompat.requestApplyInsets(content)
        }
        chatScreen.restore(savedInstanceState)
        // Edge to edge (targetSdk 35): the frame keeps clear of the bars and the keyboard; the chat is laid out in what is left.
        content = FrameLayout(this).apply {
            setBackgroundColor(AshUi.p(this@HomeActivity).bg)
            addView(chatScreen.view, FrameLayout.LayoutParams(-1, -1))
            addView(home.view, FrameLayout.LayoutParams(-1, -1))
        }
        // The window's one insets owner: the chat or a Codex session in front rides the keyboard, any other page is laid out above it.
        WindowInsetsOwner.install(content, front = ::frontDeck)
        setContentView(content)
        val saved = HomeTab.of(savedInstanceState?.getString(STATE_TAB))
        val focus = intent?.getBooleanExtra(EXTRA_FOCUS_INPUT, false) == true
        showTab(saved ?: HomeRoute.tabFor(intent?.getStringExtra(HomeRoute.EXTRA_TAB), focus, fromLauncher(intent), HomeTab.CHAT))
        port.start()
        ai.ash.host.AppState.homePageLive = true
        if (focus) ui.postDelayed({ chatScreen.focusInput() }, 300)
        openHomePageFrom(intent)
        val firstStart = OnboardingActivity.showOnce(this)
        // After an upgrade the phone may have put Ash's auto-start back off: look again once the link to the kernel is up.
        ui.postDelayed({ if (!isFinishing && !isDestroyed) Permissions.recheckAfterUpgrade(this, firstStart) }, 5_000)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val focus = intent.getBooleanExtra(EXTRA_FOCUS_INPUT, false)
        if (!::content.isInitialized) return
        showTab(HomeRoute.tabFor(intent.getStringExtra(HomeRoute.EXTRA_TAB), focus, fromLauncher(intent), tab))
        if (focus) chatScreen.focusInput()
        openHomePageFrom(intent)
    }

    /** An app (her status) pointed the owner to a page of her home. */
    private fun openHomePageFrom(i: Intent?) {
        val page = i?.getStringExtra(EXTRA_HOME_PAGE) ?: return
        i.removeExtra(EXTRA_HOME_PAGE)
        home.openPage(page, null, i.getStringExtra(EXTRA_HOME_ARG))
    }

    private fun fromLauncher(i: Intent?) = HomeRoute.isLauncher(i?.action, i?.categories)

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putString(STATE_TAB, tab.key)
        chatScreen.save(outState)
        // The Codex page keeps its route; not made this time, the route it had before is kept for the next time.
        codexPane?.save(outState) ?: saved?.getBundle(CodexPane.STATE)?.let { outState.putBundle(CodexPane.STATE, it) }
    }

    /** The chat is what the owner sees (not another tab, not a home page over it). */
    private fun chatInFront() = tab == HomeTab.CHAT && home.view.visibility != View.VISIBLE

    /** The page in front that rides the keyboard ([KeyboardDeck]): the chat, or the Codex page; null for the others. */
    private fun frontDeck(): KeyboardDeck? = when {
        chatInFront() -> chatScreen
        tab == HomeTab.CODEX -> codexPane
        else -> null
    }

    /** Brings [next] to the front: the chat, or the apps over it (made the first time it is wanted). */
    private fun showTab(next: HomeTab) {
        tab = next
        if (next == HomeTab.APPS && appsPane == null) {
            appsPane = AppsPane(this, Ash(this, null, inProcess = true)) { showTab(HomeTab.CHAT) }
                .also { content.addView(it.view, FrameLayout.LayoutParams(-1, -1)) }
        }
        if (next == HomeTab.CODEX && codexPane == null) {
            codexPane = CodexPane(this, port, saved) { showTab(HomeTab.CHAT) }
                .also { content.addView(it.view, FrameLayout.LayoutParams(-1, -1)); it.onRouteChange = { backRouter.sync() } }
        }
        if (next != HomeTab.CHAT) chatScreen.dropKeyboard()
        chatScreen.view.visibility = if (next == HomeTab.CHAT) View.VISIBLE else View.GONE
        appsPane?.view?.visibility = if (next == HomeTab.APPS) View.VISIBLE else View.GONE
        codexPane?.view?.visibility = if (next == HomeTab.CODEX) View.VISIBLE else View.GONE
        codexPane?.shown(next == HomeTab.CODEX && resumed)
        if (next == HomeTab.APPS && resumed) appsPane?.refresh()
        syncFront()
        backRouter.sync()
        syncChatShown()
        ViewCompat.requestApplyInsets(content)
    }

    /**
     * The chat reads, ticks and tells the kernel it is seen only while it is: the activity in front and the chat its visible
     * route (not another tab, not her pages over it; MOBILE-ARCH §3.6).
     */
    private fun syncChatShown() { if (::chatScreen.isInitialized) chatScreen.shown(resumed && chatInFront()) }

    /** What the rest of Ash goes by to know the owner is looking at the chat: not when the apps tab is in front. */
    private fun syncFront() {
        val front = HomeRoute.chatInFront(resumed, tab)
        if (ai.ash.host.AppState.homeVisible == front) return
        ai.ash.host.AppState.homeVisible = front
        LeaseState.refresh()
        if (resumed) Link.get(this).presence.tell()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        ai.ash.host.AppState.homeVisible = HomeRoute.chatInFront(true, tab)
        LeaseState.refresh()
        HandRuntime.appOpened(this)
        Link.get(this).presence.tell()
        syncChatShown()
        if (tab == HomeTab.APPS) appsPane?.refresh()
        codexPane?.shown(tab == HomeTab.CODEX)
        // The kernel package: not installed, the guide's first step offers to install it (once); not running, it is started from here (in front, the app may).
        when (KernelGate.action(KernelLauncher.state(this), 0)) {
            KernelGate.Action.INSTALL -> OnboardingActivity.offerKernel(this)
            KernelGate.Action.START -> KernelLauncher.start(this)
            else -> {}
        }
    }

    override fun onPause() {
        resumed = false
        ai.ash.host.AppState.homeVisible = false
        LeaseState.refresh()
        HandRuntime.appLeft()
        Link.get(this).presence.tell()
        chatScreen.shown(false)
        codexPane?.shown(false)
        super.onPause()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (!files.onActivityResult(requestCode, resultCode, data)) super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // Light and dark: the native screen is simply made again in the other colours.
        val nowNight = (newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        if (nowNight != themedNight) recreate()
    }

    /** Somewhere to go back to: another tab than the chat, or her home pages over it. At the chat itself back is the system's. */
    private fun canGoBack() = tab != HomeTab.CHAT || home.view.visibility == View.VISIBLE

    private fun goBack() {
        when {
            tab == HomeTab.APPS -> if (appsPane?.back() != true) showTab(HomeTab.CHAT)
            tab == HomeTab.CODEX -> if (codexPane?.back() != true) showTab(HomeTab.CHAT)
            else -> home.back()
        }
    }

    /** Before Android 13 (and on 13, which reads the opt-in only for the whole app): the same route as [backRouter]. */
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (!backRouter.onBackPressed()) super.onBackPressed() }

    override fun onDestroy() {
        ai.ash.host.AppState.homePageLive = false
        ui.removeCallbacksAndMessages(null)
        chatScreen.close()
        port.stop()
        appsPane?.close()
        codexPane?.close()
        super.onDestroy()
    }

    companion object {
        /** Open with the message box focused (the home-screen widget's "跟 Ash 说"). */
        const val EXTRA_FOCUS_INPUT = "ai.ash.extra.FOCUS_INPUT"
        /** Open her home on a page ([HomePages.openPage]: `keys`, `device` with `d/<device>`). */
        const val EXTRA_HOME_PAGE = "ai.ash.extra.HOME_PAGE"
        const val EXTRA_HOME_ARG = "ai.ash.extra.HOME_ARG"
        private const val STATE_TAB = "ai.ash.state.TAB"
    }
}
