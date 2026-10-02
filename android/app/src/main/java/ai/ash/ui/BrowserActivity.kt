package ai.ash.ui

import ai.ash.host.browser.BrowserSession
import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/** The agent's browser in front of the owner: log in, type a password, pass a check, then press 完成. */
class BrowserActivity : Activity() {
    private var holder: FrameLayout? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.WHITE) }
        val bar = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(24, 16, 24, 16) }
        val reason = TextView(this).apply {
            text = intent.getStringExtra("reason") ?: "请在这里完成需要你做的步骤"
            textSize = 15f
            setTextColor(Color.parseColor("#1c1c1e"))
        }
        val done = Button(this).apply { text = "完成"; setOnClickListener { finish() } }
        bar.addView(reason, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bar.addView(done)
        val frame = FrameLayout(this)
        holder = frame
        root.addView(bar, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(frame, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        setContentView(root)
        Thread { BrowserSession.attachTo(frame, this) }.start()
    }

    override fun onResume() { super.onResume(); ai.ash.host.AppState.browserVisible = true }
    override fun onPause() { ai.ash.host.AppState.browserVisible = false; super.onPause() }

    override fun onDestroy() {
        // Hand the page back to the agent; it stays open with its cookies.
        Thread { BrowserSession.detach() }.start()
        super.onDestroy()
    }
}
