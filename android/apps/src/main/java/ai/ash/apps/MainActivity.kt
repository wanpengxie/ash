package ai.ash.apps

import android.app.Activity
import android.app.AlertDialog
import android.graphics.Bitmap
import android.graphics.Typeface
import android.os.Bundle
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** 「Ash 应用」: the owner's apps as Ash lists them. Tap to open one in its own task; long-press to add it to the home screen. */
class MainActivity : Activity() {
    private lateinit var list: LinearLayout
    private lateinit var status: TextView
    private lateinit var openAsh: Button
    private val icons: MutableMap<String, Bitmap?> = java.util.Collections.synchronizedMap(HashMap())
    @Volatile private var loading = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val pad = Ui.dp(this, 20)
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, Ui.dp(this@MainActivity, 16), pad, pad) }
        column.addView(TextView(this).apply { text = "Ash 应用"; textSize = 24f; typeface = Typeface.DEFAULT_BOLD; setTextColor(Ui.text(this@MainActivity)) })
        column.addView(TextView(this).apply {
            text = "你的应用，每个都有自己的页面。长按可以添加到桌面。"
            textSize = 14f; setTextColor(Ui.muted(this@MainActivity)); setPadding(0, Ui.dp(this@MainActivity, 6), 0, Ui.dp(this@MainActivity, 12))
        })
        status = TextView(this).apply { textSize = 15f; setTextColor(Ui.muted(this@MainActivity)); setPadding(0, Ui.dp(this@MainActivity, 12), 0, Ui.dp(this@MainActivity, 8)) }
        column.addView(status)
        openAsh = Button(this).apply { text = "打开 Ash"; visibility = View.GONE; setOnClickListener { Ash.open(this@MainActivity) } }
        column.addView(openAsh, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
        list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(list)
        val scroll = ScrollView(this).apply { addView(column); setBackgroundColor(Ui.page(this@MainActivity)) }
        Ui.insets(scroll)
        setContentView(scroll)
        Ui.systemBars(this)
    }

    override fun onResume() { super.onResume(); refresh() }

    private fun refresh() {
        if (loading) return
        loading = true
        if (list.childCount == 0) status.text = "正在向 Ash 要应用列表…"
        Thread({
            val result = runCatching { Ash.apps(this) }
            result.getOrNull()?.forEach { a -> if (!icons.containsKey(a.id)) icons[a.id] = Ash.icon(this, a.id) }
            runOnUiThread {
                loading = false
                if (isDestroyed) return@runOnUiThread
                result.onSuccess { show(it) }.onFailure {
                    list.removeAllViews()
                    status.text = it.message ?: "连不上 Ash"
                    status.visibility = View.VISIBLE
                    openAsh.visibility = View.VISIBLE
                }
            }
        }, "apps-list").start()
    }

    private fun show(apps: List<AppInfo>) {
        openAsh.visibility = View.GONE
        status.visibility = if (apps.isEmpty()) View.VISIBLE else View.GONE
        status.text = "还没有应用。在 Ash 里装好、批准的应用会出现在这里。"
        list.removeAllViews()
        for (a in apps) list.addView(row(a))
    }

    private fun row(a: AppInfo): View {
        val d = { v: Int -> Ui.dp(this, v) }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(0, d(12), 0, d(12))
            isClickable = true; isLongClickable = true
            setBackgroundResource(android.R.drawable.list_selector_background)
        }
        row.addView(ImageView(this).apply {
            val b = icons[a.id]
            if (b != null) setImageBitmap(b) else setImageResource(R.drawable.ic_launcher)
            scaleType = ImageView.ScaleType.FIT_CENTER
        }, LinearLayout.LayoutParams(d(48), d(48)))
        val text = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(d(14), 0, 0, 0) }
        text.addView(TextView(this).apply { this.text = a.name; textSize = 17f; typeface = Typeface.DEFAULT_BOLD; setTextColor(Ui.text(this@MainActivity)) })
        if (a.summary.isNotBlank()) text.addView(TextView(this).apply {
            this.text = a.summary; textSize = 13f; maxLines = 2; ellipsize = TextUtils.TruncateAt.END; setTextColor(Ui.muted(this@MainActivity))
        })
        if (!a.usable) text.addView(TextView(this).apply {
            this.text = if (!a.enabled) "已在 Ash 里停用" else "等你在 Ash 里批准"; textSize = 13f; setTextColor(Ui.ACCENT)
        })
        row.addView(text, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        row.setOnClickListener { open(a) }
        row.setOnLongClickListener {
            AlertDialog.Builder(this).setTitle(a.name).setItems(arrayOf("打开", "添加到桌面")) { _, which ->
                if (which == 0) open(a) else Ui.pin(this, a.id, a.name, icons[a.id])
            }.show()
            true
        }
        return row
    }

    private fun open(a: AppInfo) {
        if (a.usable) { startActivity(Ui.appIntent(this, a.id)); return }
        AlertDialog.Builder(this)
            .setTitle("「${a.name}」还不能用")
            .setMessage(if (!a.enabled) "它已在 Ash 里停用。在 Ash 里重新启用后可用。" else "在 Ash 里批准后可用。")
            .setPositiveButton("打开 Ash") { _, _ -> Ash.open(this) }
            .setNegativeButton("取消", null)
            .show()
    }
}
