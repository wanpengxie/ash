package ai.ash.ui

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import ai.ash.R
import ai.ash.host.Permission
import ai.ash.host.Permissions
import kotlin.math.abs

/**
 * First-launch permission guide: a welcome page, one page per permission (Permissions.all), a
 * final page. Every permission is optional, so each page can be skipped; states are re-checked on
 * resume (the owner comes back from a settings screen) and every second (Shizuku answers async).
 */
class OnboardingActivity : Activity() {
    private val items: List<Permission> = Permissions.all
    private val ui = Handler(Looper.getMainLooper())
    private var page = 0
    private val last get() = items.size + 1

    private lateinit var icon: TextView
    private lateinit var title: TextView
    private lateinit var body: TextView
    private lateinit var state: TextView
    private lateinit var primary: Button
    private lateinit var secondary: Button
    /** For a switch the phone hides from Ash: feel it work, then say it is done. */
    private lateinit var test: Button
    private lateinit var confirm: Button
    private lateinit var checks: LinearLayout
    private lateinit var dots: LinearLayout

    private val night get() = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    private val fg get() = if (night) Color.rgb(236, 236, 238) else Color.rgb(28, 28, 30)
    private val muted get() = if (night) Color.rgb(150, 150, 156) else Color.rgb(110, 110, 116)
    private val accent get() = getColor(R.color.accent)

    override fun onCreate(savedInstanceState: Bundle?) {
        setTheme(if (night) R.style.Ash_Dark else R.style.Ash_Light)
        super.onCreate(savedInstanceState)
        page = savedInstanceState?.getInt(KEY_PAGE, 0)?.coerceIn(0, last) ?: 0

        icon = TextView(this).apply { textSize = 48f; gravity = Gravity.CENTER }
        title = TextView(this).apply { textSize = 24f; setTypeface(typeface, Typeface.BOLD); setTextColor(fg); gravity = Gravity.CENTER; setPadding(0, dp(16), 0, dp(12)) }
        body = TextView(this).apply { textSize = 15f; setTextColor(fg); gravity = Gravity.CENTER; setLineSpacing(0f, 1.3f) }
        state = TextView(this).apply { textSize = 14f; setTextColor(muted); gravity = Gravity.CENTER; setPadding(0, dp(20), 0, 0) }
        primary = Button(this).apply {
            isAllCaps = false; textSize = 16f; setTextColor(Color.WHITE)
            background = GradientDrawable().apply { cornerRadius = dp(24).toFloat(); setColor(accent) }
            stateListAnimator = null
        }
        secondary = Button(this, null, android.R.attr.borderlessButtonStyle).apply { isAllCaps = false; textSize = 15f; setTextColor(muted) }
        test = Button(this, null, android.R.attr.borderlessButtonStyle).apply { isAllCaps = false; textSize = 15f; setTextColor(accent); text = "测试一下" }
        confirm = Button(this, null, android.R.attr.borderlessButtonStyle).apply { isAllCaps = false; textSize = 15f; setTextColor(accent); text = "已设好" }
        checks = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER
            addView(test, LinearLayout.LayoutParams(0, -2, 1f)); addView(confirm, LinearLayout.LayoutParams(0, -2, 1f))
        }
        dots = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER; setPadding(0, dp(12), 0, dp(12)) }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(32), dp(24), dp(32), dp(24))
            addView(icon); addView(title); addView(body); addView(state)
        }
        val scroll = ScrollView(this).apply { isFillViewport = true; addView(content) }
        val bottom = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(32), 0, dp(32), dp(24))
            addView(dots)
            addView(primary, LinearLayout.LayoutParams(-1, dp(48)))
            addView(checks, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) })
            addView(secondary, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) })
        }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
            addView(bottom, LinearLayout.LayoutParams(-1, -2))
        }
        setContentView(root)

        // Page flipping by swipe too (the buttons are the primary way).
        val swipe = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onFling(e1: MotionEvent?, e2: MotionEvent, vx: Float, vy: Float): Boolean {
                if (e1 == null || abs(vx) < abs(vy) * 1.5f || abs(e2.x - e1.x) < dp(60)) return false
                go(if (vx < 0) page + 1 else page - 1)
                return true
            }
        })
        scroll.setOnTouchListener { _, e -> swipe.onTouchEvent(e); false }
        render()
    }

    override fun onResume() {
        super.onResume()
        render()
        tick()
    }

    override fun onPause() {
        ui.removeCallbacksAndMessages(null)
        super.onPause()
    }

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        out.putInt(KEY_PAGE, page)
    }

    private fun tick() {
        ui.postDelayed({ render(); tick() }, 1000)
    }

    private fun go(p: Int) {
        val n = p.coerceIn(0, last)
        if (n == page) return
        page = n
        render()
    }

    private fun render() {
        dots.removeAllViews()
        for (i in 0..last) dots.addView(View(this).apply {
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(if (i == page) accent else (muted and 0x00FFFFFF) or 0x66000000) }
        }, LinearLayout.LayoutParams(dp(if (i == page) 8 else 6), dp(if (i == page) 8 else 6)).apply { setMargins(dp(4), 0, dp(4), 0); gravity = Gravity.CENTER_VERTICAL })

        checks.visibility = View.GONE
        when (page) {
            0 -> {
                icon.text = "👋"
                title.text = "欢迎使用 Ash"
                body.text = "Ash 是住在你手机里的个人助理：替你记事、提醒、查资料，也能在你允许时帮你操作手机。\n\n" +
                    "接下来逐项介绍 Ash 能用到的手机权限，以及开启后能帮你做什么。"
                state.text = "全部可选，随时可以在「诊断」页修改"
                primary.text = "开始"
                primary.setOnClickListener { go(1) }
                secondary.text = "跳过引导"
                secondary.setOnClickListener { done() }
            }
            last -> {
                icon.text = "🎉"
                title.text = "准备好了"
                val granted = items.count { it.granted(this) }
                body.text = items.joinToString("\n") { "${if (it.granted(this)) "✅" else "⚪️"}  ${it.title}" }
                state.text = "已开启 $granted / ${items.size} 项。以后可以在「诊断」页随时开启或再次打开本引导。"
                primary.text = "完成"
                primary.setOnClickListener { done() }
                secondary.text = "上一步"
                secondary.setOnClickListener { go(page - 1) }
            }
            else -> {
                val item = items[page - 1]
                val ok = item.granted(this)
                icon.text = ICONS[item.key] ?: "🔑"
                title.text = item.title
                body.text = item.why
                state.text = if (ok) "✅ 已开启" else (item.status(this)?.let { "⚪️ 未开启 · $it" } ?: "⚪️ 未开启")
                state.setTextColor(if (ok) accent else muted)
                if (ok) {
                    primary.text = "下一步"
                    primary.setOnClickListener { go(page + 1) }
                    secondary.text = "上一步"
                    secondary.setOnClickListener { go(page - 1) }
                } else {
                    primary.text = "去开启"
                    primary.setOnClickListener { item.open(this) }
                    secondary.text = "跳过"
                    secondary.setOnClickListener { go(page + 1) }
                    // The phone keeps this switch from Ash: the owner tries it and says when it is done.
                    val word = item.awaitsWord(this)
                    if (word || (item.test != null && item.ready(this))) {
                        checks.visibility = View.VISIBLE
                        test.visibility = if (item.test != null) View.VISIBLE else View.GONE
                        test.setOnClickListener { item.test?.invoke(this) }
                        confirm.visibility = if (word) View.VISIBLE else View.GONE
                        confirm.setOnClickListener { item.confirm(this); render() }
                    }
                }
                return
            }
        }
        state.setTextColor(muted)
    }

    private fun done() {
        startActivity(Intent(this, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (page > 0) go(page - 1) else done()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val KEY_PAGE = "page"
        private const val PREFS = "ash.ui"
        private const val SEEN = "onboarding_seen"

        private val ICONS = mapOf(
            "notifications" to "🔔", "alerts" to "📳", "screen_keepalive" to "🛡️", "battery" to "🔋", "accessibility" to "👆", "all_files" to "📁",
            "usage" to "📊", "write_settings" to "⚙️", "overlay" to "🪟", "shizuku" to "🛠️",
        )

        /** Shows the guide once, on the first launch; marks it seen right away so a crash or kill never loops it. */
        fun showOnce(from: Activity): Boolean {
            val prefs = from.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            if (prefs.getBoolean(SEEN, false)) return false
            prefs.edit().putBoolean(SEEN, true).apply()
            from.startActivity(Intent(from, OnboardingActivity::class.java))
            return true
        }
    }
}
