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
import org.json.JSONObject

/**
 * The frame of a system app (spec ARCH-APPS §3): one Activity per app, its own task-free screen opened from the apps grid,
 * from `person:owner/open {app}` or from another app. It gives every app the same skeleton (MOBILE-ARCH §1): a header
 * (back, title, a slot for actions), the window's one insets owner, back through the dispatcher, the hub reached as the
 * owner without taking the chat's page ([call]), and a line over the top of the page while Ash cannot be reached.
 *
 * An app is a subclass that builds its page into [content] ([build]) and keeps its own model. A page that rides the
 * keyboard (a conversation) names its deck in [deck]; any other is laid out above the keyboard.
 */
abstract class SystemAppActivity : Activity() {
    protected val c get() = AshUi.p(this)
    protected fun dp(v: Int) = AshUi.dp(this, v)

    protected lateinit var title: android.widget.TextView
    /** The header's right side: the app's own actions (icon buttons). */
    protected lateinit var actions: LinearLayout
    /** Where the app draws its page. */
    protected lateinit var content: FrameLayout
    private lateinit var offline: android.widget.TextView
    private val back = BackRouter(this, { canGoBack() }, { goBack() })

    /** The page's deck that rides the keyboard (MOBILE-ARCH §4.4), or null to be laid out above it. */
    protected open val deck: KeyboardDeck? get() = null

    /** Whether the app has somewhere to go back to inside itself (a session, a detail); at its root, back closes the app. */
    protected open fun canGoBack(): Boolean = false
    protected open fun goBack() {}

    /** Builds the page into [content]; [saved] is what [onSaveInstanceState] kept when the screen was made again. */
    protected abstract fun build(saved: Bundle?)

    /**
     * A message of the ledger (its summary: `from`, `to`, `word`…) while the app is on screen: refresh what it shows when it is
     * about it (filter by word or member). Not called while the app is behind; read again when it comes back ([onStart]).
     */
    protected open fun onLedger(message: JSONObject) {}
    /** Called on the main thread on entry and after each connection change; reread after reconnecting. */
    protected open fun onConnectionChanged(connected: Boolean) {}
    private val connection: (Boolean) -> Unit = {
        offline.visibility = if (it) View.INVISIBLE else View.VISIBLE
        onConnectionChanged(it)
    }
    private val ledger: (JSONObject) -> Unit = { if (!isDestroyed) onLedger(it) }

    override fun onStart() { super.onStart(); LedgerFeed.listen(this, ledger, connection) }
    override fun onStop() { LedgerFeed.remove(ledger); super.onStop() }

    override fun onCreate(saved: Bundle?) {
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        setTheme(if (night) R.style.Ash_Dark else R.style.Ash_Light)
        super.onCreate(saved)
        Ui.systemBars(this)
        title = AshUi.text(this, "", AshTokens.Type.listTitle).apply { maxLines = 1; ellipsize = android.text.TextUtils.TruncateAt.END }
        actions = AshUi.hstack(this, 2)
        val header = AshUi.hstack(this, 6).apply {
            gravity = Gravity.CENTER_VERTICAL; setPadding(dp(6), 0, dp(6), 0)
            addView(AshUi.iconButton(this@SystemAppActivity, getDrawable(R.drawable.ash_ic_back)!!, "返回") { if (canGoBack()) { goBack(); syncBack() } else finish() })
            addView(title, LinearLayout.LayoutParams(0, -2, 1f))
            addView(actions)
        }
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
            addView(header, LinearLayout.LayoutParams(-1, dp(AshTokens.Size.topBar)))
            addView(offline, LinearLayout.LayoutParams(-1, -2))
            addView(stage, LinearLayout.LayoutParams(-1, 0, 1f))
        }
        setContentView(root)
        WindowInsetsOwner.install(root, front = { deck })
        build(saved)
        syncBack()
    }

    /** Call when what [canGoBack] answers may have changed (the system's back gesture is offered to the app only then). */
    protected fun syncBack() = back.sync()

    /**
     * A word to the hub as the owner, answered on the main thread — through [HumanCall], so the chat keeps its page. A failure
     * that means Ash is out of reach shows the offline line; the next answer that comes back takes it away.
     */
    protected fun call(to: String, word: String, body: JSONObject = JSONObject(), done: (JSONObject?, HumanPort.Failure?) -> Unit) =
        HumanCall.call(this, to, word, body) { data, failure ->
            if (isDestroyed) return@call
            if (failure?.code in UNREACHABLE) offline.visibility = View.VISIBLE
            else if (failure == null) offline.visibility = View.INVISIBLE
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
