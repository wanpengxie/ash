package ai.ash.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import ai.ash.R
import ai.ash.host.CoreProcess
import ai.ash.host.CoreService
import ai.ash.host.Paths

/**
 * Opening the app opens Ash: the ash UI (served by ash core on loopback) in a WebView. While
 * the core is installing or starting, a native status screen shows what is happening.
 */
class HomeActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var cover: LinearLayout
    private lateinit var status: TextView
    private lateinit var action: Button
    private val ui = Handler(Looper.getMainLooper())
    private var loaded = false

    private val night get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        // A WebView's prefers-color-scheme follows the theme's isLightTheme only, not the system
        // night mode — so the theme is chosen here to make the ash UI follow the system.
        setTheme(if (night) R.style.Ash_Dark else R.style.Ash_Light)
        super.onCreate(savedInstanceState)
        CoreService.start(this)

        web = WebView(this)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            setSupportZoom(false)
            userAgentString = "$userAgentString AshApp/0.2"
        }
        web.setBackgroundColor(if (night) 0xFF141415.toInt() else 0xFFF7F7F5.toInt())
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url
                if (u.scheme == "ash" && u.host == "console") {
                    startActivity(Intent(this@HomeActivity, ConsoleActivity::class.java))
                    return true
                }
                if (u.host == "127.0.0.1" || u.host == "localhost") return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }

            override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                if (req.isForMainFrame) {
                    loaded = false
                    cover.visibility = View.VISIBLE
                }
            }
        }

        val fg = if (night) Color.rgb(236, 236, 238) else Color.rgb(28, 28, 30)
        status = TextView(this).apply { textSize = 15f; setTextColor(fg); gravity = Gravity.CENTER; setPadding(48, 24, 48, 24) }
        action = Button(this).apply { text = "诊断"; setOnClickListener { startActivity(Intent(this@HomeActivity, ConsoleActivity::class.java)) } }
        cover = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(if (night) 0xFF141415.toInt() else 0xFFF7F7F5.toInt())
            addView(TextView(context).apply { text = "Ash"; textSize = 28f; setTextColor(fg); gravity = Gravity.CENTER })
            addView(ProgressBar(context).apply { isIndeterminate = true })
            addView(status)
            addView(action, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        setContentView(FrameLayout(this).apply {
            addView(web, FrameLayout.LayoutParams(-1, -1))
            addView(cover, FrameLayout.LayoutParams(-1, -1))
        })
        poll()
    }

    private fun poll() {
        if (isFinishing || isDestroyed) return
        val p = Paths(this)
        val st = CoreService.state
        status.text = when {
            st == "installing" -> "正在安装运行环境… ${CoreService.installProgress.takeIf { it >= 0 }?.let { "$it%" } ?: ""}\n（首次安装或升级后需要一两分钟）"
            st == "stopped" -> "Ash 已停止"
            st.startsWith("error") -> "出错了：${st.removePrefix("error: ")}"
            else -> "正在启动…"
        }
        action.visibility = if (st == "stopped" || st.startsWith("error")) View.VISIBLE else View.GONE
        if (!loaded && p.uiUrl.exists()) {
            Thread {
                val ok = CoreProcess(this).portOpen(1000)
                if (ok) ui.post { load(p.uiUrl.readText().trim()) }
            }.start()
        }
        ui.postDelayed({ poll() }, 1000)
    }

    private fun load(url: String) {
        if (loaded) return
        loaded = true
        web.loadUrl(url) // /?token=… → the core answers with an HttpOnly cookie and redirects to /
        ui.postDelayed({ cover.visibility = View.GONE }, 400)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if ((newConfig.uiMode and Configuration.UI_MODE_NIGHT_MASK) != (if (night) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)) recreate()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else moveTaskToBack(true) // Ash keeps running
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        web.destroy()
        super.onDestroy()
    }

    @Suppress("unused")
    private fun open(u: String) = startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u)))
}
