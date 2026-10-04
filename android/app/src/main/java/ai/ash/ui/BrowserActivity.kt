package ai.ash.ui

import ai.ash.host.browser.BrowserArguments
import ai.ash.host.browser.BrowserSession
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * The agent's browser in front of the owner: watch a space, log in, type a password, pass a check, then press 完成.
 * The bar names the space's site; 关闭 stops that space, 切换 shows another one when several are open.
 */
class BrowserActivity : Activity() {
    companion object {
        const val EXTRA_SPACE = "space"
        const val EXTRA_REASON = "reason"
    }

    private lateinit var frame: FrameLayout
    private lateinit var reason: TextView
    private lateinit var site: TextView
    private lateinit var switch: Button
    private var space: String? = null
    private val onChange: () -> Unit = { refresh() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val ink = Color.parseColor("#1c1c1e")
        val muted = Color.parseColor("#6e6e73")
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.WHITE) }
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(24, 16, 24, 0) }
        reason = TextView(this).apply { textSize = 15f; setTextColor(ink) }
        val done = Button(this).apply { text = "完成"; setOnClickListener { finish() } }
        bar.addView(reason, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(done)
        val spaceBar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(24, 0, 24, 8) }
        site = TextView(this).apply { textSize = 13f; setTextColor(muted); setSingleLine(); ellipsize = TextUtils.TruncateAt.END }
        switch = Button(this, null, android.R.attr.borderlessButtonStyle).apply { text = "切换"; setOnClickListener { chooseSpace() } }
        val close = Button(this, null, android.R.attr.borderlessButtonStyle).apply { text = "关闭"; setOnClickListener { closeSpace() } }
        spaceBar.addView(site, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        spaceBar.addView(switch)
        spaceBar.addView(close)
        frame = FrameLayout(this)
        root.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(spaceBar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(frame, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        BrowserSession.addListener(onChange)
        show(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        show(intent)
    }

    private fun show(intent: Intent) {
        reason.text = intent.getStringExtra(EXTRA_REASON) ?: "Ash 正在用这个页面，你可以看着，也可以接手操作"
        val wanted = intent.getStringExtra(EXTRA_SPACE) ?: BrowserArguments.MAIN_SPACE
        val id = if (BrowserSession.info(wanted) != null) wanted else BrowserSession.list().firstOrNull()?.id
        if (id == null) Toast.makeText(this, "浏览器里没有打开的页面", Toast.LENGTH_SHORT).show()
        attach(id)
    }

    /** Puts [id] in the frame (the previous space goes back to the agent, still open). Null: nothing is open, so leave. */
    private fun attach(id: String?) {
        val previous = space
        if (previous != null && previous != id) BrowserSession.detach(previous)
        if (id == null || !BrowserSession.attachTo(frame, id)) {
            space = null
            finish()
            return
        }
        space = id
        refresh()
    }

    /** Follows the agent: a new page updates the bar; a space closed elsewhere gives way to the latest other one. */
    private fun refresh() {
        if (isFinishing || isDestroyed) return
        val id = space ?: return
        val all = BrowserSession.list()
        val current = all.firstOrNull { it.id == id }
        if (current == null) { space = null; attach(all.firstOrNull()?.id); return }
        site.text = if (all.size > 1) "${current.site.ifBlank { "打开中…" }}（${current.id}）" else current.site.ifBlank { "打开中…" }
        switch.visibility = if (all.size > 1) View.VISIBLE else View.GONE
    }

    private fun chooseSpace() {
        val all = BrowserSession.list()
        if (all.size < 2) return
        val names = all.map { "${it.title.ifBlank { it.site }} · ${it.site}（${it.id}）" }.toTypedArray()
        AlertDialog.Builder(this).setTitle("切换页面").setItems(names) { _, which -> attach(all[which].id) }.show()
    }

    private fun closeSpace() {
        val id = space ?: return finish()
        BrowserSession.close(id) // the listener moves to another open space, or leaves when none is left
        refresh()
    }

    override fun onResume() { super.onResume(); ai.ash.host.AppState.browserVisible = true }
    override fun onPause() { ai.ash.host.AppState.browserVisible = false; super.onPause() }

    override fun onDestroy() {
        BrowserSession.removeListener(onChange)
        // Hand the page back to the agent; it stays open with its cookies.
        space?.let { BrowserSession.detach(it) }
        super.onDestroy()
    }
}
