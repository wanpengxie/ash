package ai.ash.sysapps.codex

import ai.ash.sysapps.SystemAppActivity
import ai.ash.ui.KeyboardDeck
import android.content.Intent
import android.os.Bundle
import android.widget.FrameLayout
import org.json.JSONObject

/** One application for Codex on every connected computer. All business actions use the human channel. */
open class CodexActivity : SystemAppActivity() {
    private lateinit var pane: CodexPane
    override val deck: KeyboardDeck? get() = if (::pane.isInitialized) pane else null

    override fun build(saved: Bundle?) {
        title.text = "Codex"
        pane = CodexPane(this, title, actions, humanClient, saved)
        pane.onRouteChange = ::syncBack
        content.addView(pane.view, FrameLayout.LayoutParams(-1, -1))
        if (saved == null) pane.openArg(intent.getStringExtra(EXTRA_ARG))
    }

    override fun onStart() { super.onStart(); pane.shown(true) }
    override fun onStop() { pane.shown(false); super.onStop() }
    override fun onLedger(message: JSONObject) { pane.changed(message) }
    override fun onConnectionChanged(connected: Boolean) { if (connected) pane.connected() }
    override fun canGoBack() = ::pane.isInitialized && pane.canGoBack()
    override fun goBack() { pane.back() }
    override fun onSaveInstanceState(out: Bundle) { pane.save(out); super.onSaveInstanceState(out) }
    override fun onNewIntent(next: Intent) { super.onNewIntent(next); setIntent(next); pane.openArg(next.getStringExtra(EXTRA_ARG)); syncBack() }
    override fun onDestroy() { pane.close(); super.onDestroy() }
}
