package ai.ash.sysapps

import ai.ash.R
import ai.ash.apps.Ui
import ai.ash.ui.BackRouter
import ai.ash.ui.HumanCall
import ai.ash.ui.HumanPort
import ai.ash.ui.KeyboardDeck
import ai.ash.ui.LedgerFeed
import ai.ash.ui.WindowInsetsOwner
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi
import android.app.Activity
import android.content.res.Configuration
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

/**
 * The frame of a system app (spec ARCH-APPS §3): one Activity per app, its own task-free screen opened from the apps grid,
 * from `person:owner/open {app}` or from another app. It gives every app the same skeleton (MOBILE-ARCH §1): a header
 * (back, title, a slot for actions), the window's one insets owner, back through the dispatcher, the hub reached as the
 * owner without taking the chat's page ([call]), and a stable status slot while Ash cannot be reached.
 *
 * An app is a subclass that builds its page into [content] ([build]) and keeps its own model. A page that rides the
 * keyboard (a conversation) names its deck in [deck]; any other is laid out above the keyboard.
 */
abstract class SystemAppActivity : Activity() {
    /** The existing human connection. Overridable by a test Activity; no separate connection or chat page is created. */
    protected open val humanClient: ai.ash.link.LinkClient get() = ai.ash.link.Link.get(this).client
    protected val c get() = AshUi.p(this)
    protected fun dp(v: Int) = AshUi.dp(this, v)

    protected lateinit var title: android.widget.TextView
    /** The header's right side: the app's own actions (icon buttons). */
    protected lateinit var actions: LinearLayout
    /** Where the app draws its page. */
    protected lateinit var content: FrameLayout
    /** Opt in to the v6 app chrome. A null identity preserves the old subclass header contract. */
    protected open val appIdentity: AppIdentity? get() = null
    protected lateinit var bottomActions: FrameLayout
    private lateinit var header: LinearLayout
    private lateinit var backButton: View
    private lateinit var identityIcon: FrameLayout
    private lateinit var summary: LinearLayout
    private lateinit var summaryText: TextView
    private lateinit var summaryAction: TextView
    private lateinit var navigation: LinearLayout
    private var destinations = emptyList<AppDestination>()
    private var selectedDestination: String? = null
    private var onDestination: ((String) -> Unit)? = null
    private var isDetail = false
    private var navigationVisible = true
    private var connected = false
    private var statusText: String? = null
    private lateinit var offline: android.widget.TextView
    private var imeVisible = false
    private val back = BackRouter(this, { canGoBack() }, { goBack() })

    /** The page's deck that rides the keyboard (MOBILE-ARCH §4.4), or null to be laid out above it. */
    protected open val deck: KeyboardDeck? get() = null

    /** Whether the app has somewhere to go back to inside itself (a session, a detail); at its root, back closes the app. */
    protected open fun canGoBack(): Boolean = false
    protected open fun goBack() {}

    /** Builds the page into [content]; [saved] is what [onSaveInstanceState] kept when the screen was made again. */
    protected abstract fun build(saved: Bundle?)

    /**
     * A complete message of the ledger (`from`, `to`, `word`, `body`, `payload`…) while the app is on screen: refresh what it shows when it is
     * about it (filter by word or member). Not called while the app is behind; read again when it comes back ([onStart]).
     */
    protected open fun onLedger(message: JSONObject) {}
    /** Called on the main thread on entry and after each connection change; reread after reconnecting. */
    protected open fun onConnectionChanged(connected: Boolean) {}
    private val connection: (Boolean) -> Unit = {
        connected = it
        paintStatus()
        onConnectionChanged(it)
    }
    private val ledger: (JSONObject) -> Unit = { if (!isDestroyed) onLedger(it) }

    override fun onStart() { super.onStart(); LedgerFeed.listen(humanClient, ledger, connection) }
    override fun onStop() { LedgerFeed.remove(ledger); super.onStop() }

    override fun onCreate(saved: Bundle?) {
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        setTheme(if (night) R.style.Ash_Dark else R.style.Ash_Light)
        super.onCreate(saved)
        Ui.systemBars(this)
        title = AshUi.text(this, "", AshTokens.Type.listTitle).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        actions = AshUi.hstack(this, 2)
        backButton = AshUi.iconButton(this, getDrawable(R.drawable.ash_ic_back)!!, "返回") { toolbarBack() }
        identityIcon = FrameLayout(this)
        appIdentity?.let { identity ->
            identityIcon.background = AshUi.rounded(identity.accent.color(this), dp(9).toFloat())
            identityIcon.addView(AppUi.icon(this, identity.icon, identity.accent.foreground(this), 20),
                FrameLayout.LayoutParams(dp(20), dp(20), Gravity.CENTER))
            title.text = identity.name
            AshUi.style(title, AshTokens.Type.title, c.ink)
        }
        header = AshUi.hstack(this, 8).apply {
            gravity = Gravity.CENTER_VERTICAL; minimumHeight = dp(AshTokens.Size.topBar)
            setPadding(dp(if (appIdentity == null) 6 else 16), 0, dp(8), 0)
            addView(backButton)
            addView(identityIcon, LinearLayout.LayoutParams(dp(28), dp(28)).apply { marginEnd = dp(2) })
            addView(title, LinearLayout.LayoutParams(0, -2, 1f))
            addView(actions)
        }
        summaryText = AshUi.text(this, "", AshTokens.Type.sub, c.text2).apply {
            maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END
        }
        // Reserve two status lines at the current font scale and one accessible action. The budget
        // belongs to the enabled slot, not its current wording/action; business consequences stay in content.
        val summaryHeight = maxOf(dp(48), summaryText.lineHeight * 2 + dp(8))
        summaryAction = AshUi.text(this, "", AshTokens.Type.sub, appIdentity?.accent?.color(this) ?: c.text2).apply {
            gravity = Gravity.END or Gravity.CENTER_VERTICAL; minimumHeight = dp(48); minimumWidth = dp(48)
            maxLines = 1; maxWidth = dp(120); ellipsize = android.text.TextUtils.TruncateAt.END
        }
        summary = AshUi.hstack(this, 8).apply {
            gravity = Gravity.CENTER_VERTICAL; minimumHeight = summaryHeight
            setPadding(dp(16), 0, dp(16), 0); visibility = View.GONE
            addView(summaryText, LinearLayout.LayoutParams(0, -2, 1f)); addView(summaryAction)
        }
        navigation = AshUi.hstack(this, 0).apply {
            visibility = View.GONE; minimumHeight = dp(60)
            setPadding(dp(12), dp(2), dp(12), dp(4)); setBackgroundColor(c.bg)
        }
        bottomActions = FrameLayout(this).apply { visibility = View.GONE }
        content = FrameLayout(this)
        // A measured status slot: showing a connection problem never moves or covers editable content (§1.2).
        offline = AshUi.text(this, "暂时连不上 Ash，连上后会自动恢复", AshTokens.Type.callout, c.text2).apply {
            gravity = Gravity.CENTER; setPadding(dp(14), dp(6), dp(14), dp(6)); setBackgroundColor(c.bg); visibility = View.INVISIBLE
        }
        // The header stays; the stage under it clips a deck the keyboard moves up.
        val stage = FrameLayout(this).apply {
            clipChildren = true
            addView(content, FrameLayout.LayoutParams(-1, -1))
        }
        val root = AshUi.vstack(this).apply {
            setBackgroundColor(c.bg)
            addView(header, LinearLayout.LayoutParams(-1, -2))
            addView(summary, LinearLayout.LayoutParams(-1, summaryHeight))
            addView(offline, LinearLayout.LayoutParams(-1, -2))
            addView(stage, LinearLayout.LayoutParams(-1, 0, 1f))
            addView(bottomActions, LinearLayout.LayoutParams(-1, -2))
            addView(navigation, LinearLayout.LayoutParams(-1, -2))
        }
        setContentView(root)
        WindowInsetsOwner.install(root, front = { deck }, onKeyboard = { imeVisible = it })
        build(saved)
        paintHeader(); if (appIdentity != null) paintStatus()
        syncBack()
    }

    /** Declare 2–3 stable destinations once; the app owns the selected id and its business routes. */
    protected fun setDestinations(items: List<AppDestination>, selected: String, onSelect: (String) -> Unit) {
        require(items.size in 2..3 && items.map { it.id }.distinct().size == items.size)
        destinations = items.toList(); selectedDestination = selected; onDestination = onSelect
        paintNavigation()
    }

    protected fun selectDestination(id: String) { selectedDestination = id; paintNavigation() }

    /** Detail chrome never changes the app's selected destination. Input docks remain inside the app's KeyboardDeck. */
    protected fun showPage(label: String, detail: Boolean = false, showNavigation: Boolean = true) {
        title.text = label; isDetail = detail; navigationVisible = showNavigation; paintHeader()
        navigation.visibility = if (showNavigation && destinations.isNotEmpty()) View.VISIBLE else View.GONE
        syncBack()
    }

    /** Snapshot/event wording is supplied by the app, never fabricated by the common shell. */
    protected fun setStatus(text: String?, action: String? = null, onAction: (() -> Unit)? = null) {
        statusText = text
        summaryAction.text = action.orEmpty(); summaryAction.visibility = if (action.isNullOrEmpty()) View.GONE else View.VISIBLE
        summaryAction.isClickable = onAction != null; summaryAction.isFocusable = onAction != null
        summaryAction.setOnClickListener(if (onAction == null) null else View.OnClickListener { onAction() })
        paintStatus()
    }

    /** A non-input fixed action (for example save); keyboard conversation inputs belong in the business deck. */
    protected fun setBottomAction(view: View?) {
        bottomActions.removeAllViews()
        if (view != null) bottomActions.addView(view, FrameLayout.LayoutParams(-1, -2))
        bottomActions.visibility = if (view == null) View.GONE else View.VISIBLE
    }

    private fun paintHeader() {
        val modern = appIdentity != null
        backButton.visibility = if (!modern || isDetail) View.VISIBLE else View.GONE
        identityIcon.visibility = if (modern && !isDetail) View.VISIBLE else View.GONE
    }

    private fun paintStatus() {
        if (!::offline.isInitialized) return
        if (appIdentity == null) {
            offline.visibility = if (connected) View.INVISIBLE else View.VISIBLE
            return
        }
        offline.visibility = View.GONE
        summary.visibility = if (statusText == null) View.GONE else View.VISIBLE
        summaryText.text = if (connected) statusText.orEmpty() else "暂时离线 · 保留上次内容"
        // Modern pages always supply a truthful loading/confirmed line before starting reads.
    }

    private fun paintNavigation() {
        navigation.removeAllViews()
        val accent = appIdentity?.accent ?: AppAccent.TASKS
        for (destination in destinations) {
            val selected = destination.id == selectedDestination
            val tint = if (selected) accent.color(this) else c.text2
            val item = AshUi.vstack(this, 0).apply {
                gravity = Gravity.CENTER; minimumHeight = dp(56); minimumWidth = dp(48)
                if (selected) background = AshUi.rounded(AshUi.withAlpha(accent.color(this@SystemAppActivity), 0.07f), dp(12).toFloat())
                addView(AppUi.icon(this@SystemAppActivity, destination.icon, tint))
                addView(AshUi.text(this@SystemAppActivity, destination.label, AshTokens.Type.sub,
                    if (selected && AshUi.night(this@SystemAppActivity)) c.ink else tint).apply { gravity = Gravity.CENTER })
                isSelected = selected; isClickable = true; isFocusable = true; contentDescription = destination.label
                AshUi.role(this, android.widget.Button::class.java.name)
                setOnClickListener { if (destination.id != selectedDestination) onDestination?.invoke(destination.id) }
            }
            navigation.addView(item, LinearLayout.LayoutParams(0, -2, 1f))
        }
        navigation.visibility = if (navigationVisible && destinations.isNotEmpty()) View.VISIBLE else View.GONE
    }

    private fun toolbarBack() {
        if (imeVisible) {
            getSystemService(android.view.inputmethod.InputMethodManager::class.java)?.hideSoftInputFromWindow(content.windowToken, 0)
        } else if (canGoBack()) { goBack(); syncBack() } else finish()
    }

    /** Call when what [canGoBack] answers may have changed (the system's back gesture is offered to the app only then). */
    protected fun syncBack() = back.sync()

    /**
     * A word to the hub as the owner, answered on the main thread — through [HumanCall], so the chat keeps its page. A failure
     * that means Ash is out of reach shows the offline line; the next answer that comes back takes it away.
     */
    protected fun call(to: String, word: String, body: JSONObject = JSONObject(), done: (JSONObject?, HumanPort.Failure?) -> Unit) =
        HumanCall.call(humanClient, to, word, body) { data, failure ->
            if (isDestroyed) return@call
            if (failure?.code in UNREACHABLE) { connected = false; paintStatus() }
            else if (failure == null) { connected = true; paintStatus() }
            done(data, failure)
        }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (!back.onBackPressed()) super.onBackPressed() }

    companion object {
        /** Ash itself out of reach (not a word that failed). */
        private val UNREACHABLE = setOf("offline")
        /** What the app is asked to show (`person:owner/open {app, arg}`). */
        const val EXTRA_ARG = "ai.ash.sysapps.ARG"
    }
}
