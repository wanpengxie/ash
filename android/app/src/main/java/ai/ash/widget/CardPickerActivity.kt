package ai.ash.widget

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import ai.ash.R

/** Shown when the owner places an "Ash 卡片" widget (or taps an unbound one): pick which card it shows. */
class CardPickerActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        setTheme(if (night) R.style.Ash_Dark else R.style.Ash_Light)
        super.onCreate(savedInstanceState)
        val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        val manager = AppWidgetManager.getInstance(this)
        // Only one of Ash's own card widgets can be configured here.
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID ||
            manager.getAppWidgetInfo(id)?.provider != ComponentName(this, CardWidgetProvider::class.java)) { finish(); return }
        // Leaving without a pick keeps the widget; it then offers the pick itself.
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id))
        val fg = if (night) Color.rgb(236, 236, 238) else Color.rgb(28, 28, 30)
        val fg2 = if (night) Color.rgb(150, 150, 156) else Color.rgb(110, 110, 115)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 64, 48, 48) }
        root.addView(TextView(this).apply { text = "选择要显示的卡片"; textSize = 20f; setTextColor(fg); setTypeface(typeface, Typeface.BOLD); setPadding(0, 0, 0, 24) })
        val now = System.currentTimeMillis()
        val cards = WidgetHost.state(this)?.cards?.values.orEmpty().filter { it.root != null }
        if (cards.isEmpty()) {
            root.addView(TextView(this).apply {
                text = "还没有卡片。可以跟 Ash 说「在桌面放一张今天天气的卡片」，放好后点这个小组件再选。"
                textSize = 15f; setTextColor(fg2); setPadding(0, 0, 0, 24)
            })
        }
        for (card in cards) {
            val expired = card.expiresAt != null && card.expiresAt <= now
            root.addView(LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, 24, 0, 24)
                isClickable = true
                addView(TextView(context).apply { text = card.title; textSize = 17f; setTextColor(fg) })
                addView(TextView(context).apply {
                    text = listOfNotNull(card.size, owner(card.owner), if (expired) "已过期" else null).joinToString(" · ")
                    textSize = 13f; setTextColor(fg2)
                })
                setOnClickListener { WidgetHost.pick(this@CardPickerActivity, id, card.id); finish() }
            })
        }
        root.addView(Button(this).apply { text = "先不选"; setOnClickListener { CardWidgetProvider.update(this@CardPickerActivity, manager, id); finish() } })
        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun owner(member: String): String = when {
        member == "agent:main" -> "来自 Ash"
        member == "person:owner" -> "来自你"
        else -> "来自 ${member.substringAfter(':')}"
    }
}
