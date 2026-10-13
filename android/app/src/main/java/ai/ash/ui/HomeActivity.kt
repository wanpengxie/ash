package ai.ash.ui

import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.widget.FrameLayout
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

    override fun onCreate(savedInstanceState: Bundle?) {
        themedNight = night
        setTheme(if (themedNight) R.style.Ash_Dark else R.style.Ash_Light)
        super.onCreate(savedInstanceState)
        ai.ash.apps.Ui.systemBars(this)
        port = HumanPort(Link.get(this).chat)
        files = ChatFiles(this, port)
        home = HomePages(this, port)
        chatScreen = ChatScreen(this, port, files, home, { showTab(HomeTab.APPS) }, { showTab(HomeTab.CODEX) })
        home.composeHook = { text, _ -> showTab(HomeTab.CHAT); chatScreen.compose(text) }
        home.jumpHook = { id -> showTab(HomeTab.CHAT); chatScreen.jumpTo(id) }
        home.onName = { name -> chatScreen.setName(name) }
        // Edge to edge (targetSdk 35): the frame keeps clear of the bars and the keyboard; the chat is laid out in what is left.
        content = FrameLayout(this).apply {
            setBackgroundColor(AshUi.p(this@HomeActivity).bg)
            addView(chatScreen.view, FrameLayout.LayoutParams(-1, -1))
            addView(home.view, FrameLayout.LayoutParams(-1, -1))
        }
        ai.ash.apps.Ui.insets(content)
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
    }

    /** Brings [next] to the front: the chat, or the apps over it (made the first time it is wanted). */
    private fun showTab(next: HomeTab) {
        tab = next
        if (next == HomeTab.APPS && appsPane == null) {
            appsPane = AppsPane(this, Ash(this, null, inProcess = true)) { showTab(HomeTab.CHAT) }
                .also { content.addView(it.view, FrameLayout.LayoutParams(-1, -1)) }
        }
        if (next == HomeTab.CODEX && codexPane == null) {
            codexPane = CodexPane(this, port) { showTab(HomeTab.CHAT) }
                .also { content.addView(it.view, FrameLayout.LayoutParams(-1, -1)) }
        }
        chatScreen.view.visibility = if (next == HomeTab.CHAT) View.VISIBLE else View.GONE
        appsPane?.view?.visibility = if (next == HomeTab.APPS) View.VISIBLE else View.GONE
        codexPane?.view?.visibility = if (next == HomeTab.CODEX) View.VISIBLE else View.GONE
        codexPane?.shown(next == HomeTab.CODEX && resumed)
        if (next == HomeTab.APPS && resumed) appsPane?.refresh()
        syncFront()
    }

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
        chatScreen.shown(true)
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

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (tab == HomeTab.APPS) { if (appsPane?.back() != true) showTab(HomeTab.CHAT); return }
        if (tab == HomeTab.CODEX) { if (codexPane?.back() != true) showTab(HomeTab.CHAT); return }
        if (home.back()) return
        moveTaskToBack(true)
    }

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
