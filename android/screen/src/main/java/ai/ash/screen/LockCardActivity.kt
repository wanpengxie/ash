package ai.ash.screen

import android.app.Activity
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Opened by Ash so the helper has a card in recent apps: the owner locks that card, and makers that clear the
 * background then leave the helper (and its accessibility service) alone. "好了" keeps the card, only leaves it.
 */
class LockCardActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val pad = (24 * resources.displayMetrics.density).toInt()
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(pad, pad * 3, pad, pad)
            addView(TextView(context).apply {
                text = "Ash 屏幕助手"
                textSize = 22f
                setTypeface(typeface, Typeface.BOLD)
            })
            addView(TextView(context).apply {
                text = "打开最近任务，找到这张「Ash 屏幕助手」卡片，把它锁定。\n\n锁定后系统清理后台时会尽量留下它，屏幕操作和灵动岛就不会突然失效。"
                textSize = 16f
                setPadding(0, pad, 0, pad)
            })
            addView(Button(context).apply {
                text = "好了"
                setOnClickListener { moveTaskToBack(true) }
            })
        })
    }
}
