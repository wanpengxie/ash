package ai.ash.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.Choreographer
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import ai.ash.host.TaskStatus
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Compact native status, not a full-screen transparent touch-intercepting window. */
object TaskCapsule {
    private val main = Handler(Looper.getMainLooper())
    private var app: Context? = null
    private var root: LinearLayout? = null
    private var manager: WindowManager? = null
    private var title: TextView? = null
    private var details: TextView? = null
    private var actions: LinearLayout? = null
    private var stop: Button? = null
    private var lp: WindowManager.LayoutParams? = null
    private var expanded = false
    private var turn: String? = null
    private var dismissed: String? = null
    private var suppressed = 0
    private var restore: (() -> Unit)? = null
    private fun dp(ctx: Context, n: Int) = (ctx.resources.displayMetrics.density * n).toInt()

    fun update(ctx: Context, text: String, steps: List<String>, canStop: Boolean, task: String, visible: Boolean) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (turn != task) { expanded = false; turn = task }
        app = ctx.applicationContext
        restore = { update(ctx, text, steps, canStop, task, visible) }
        val unlocked = !ctx.getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked &&
            ctx.getSystemService(android.os.PowerManager::class.java).isInteractive
        if (!visible || ai.ash.host.AppState.homeVisible || !unlocked || dismissed == task || suppressed > 0 || !Settings.canDrawOverlays(ctx)) { detach(); return }
        runCatching {
            if (root == null) attach(ctx)
            val headingText = "$text  ${if (expanded) "▴" else "▾"}"
            if (title?.text?.toString() != headingText) title?.text = headingText
            val detailText = (steps.takeLast(5).map { "· $it" } + "仅显示执行阶段，不代表完成百分比").joinToString("\n")
            if (details?.text?.toString() != detailText) details?.text = detailText
            details?.visibility = if (expanded) View.VISIBLE else View.GONE
            actions?.visibility = if (expanded) View.VISIBLE else View.GONE
            stop?.isEnabled = canStop
            root?.let { box ->
                val p = lp ?: return@let
                box.measure(View.MeasureSpec.makeMeasureSpec(p.width, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(ctx.resources.displayMetrics.heightPixels, View.MeasureSpec.AT_MOST))
                val safeY = p.y.coerceIn(0, (ctx.resources.displayMetrics.heightPixels - box.measuredHeight - dp(ctx, 64)).coerceAtLeast(0))
                val safeX = p.x.coerceIn(0, (ctx.resources.displayMetrics.widthPixels - p.width).coerceAtLeast(0))
                if (p.y != safeY || p.x != safeX) { p.y = safeY; p.x = safeX; ctx.getSystemService(WindowManager::class.java).updateViewLayout(box, p) }
            }
        }.onFailure { detach() }
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun attach(ctx: Context) {
        val wm = ctx.getSystemService(WindowManager::class.java)
        val p = lp ?: WindowManager.LayoutParams(dp(ctx, 244), WindowManager.LayoutParams.WRAP_CONTENT,
            if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT).apply { gravity = Gravity.TOP or Gravity.LEFT; x = dp(ctx, 8); y = dp(ctx, 72); setTitle("AshTaskCapsule") }.also { lp = it }
        val box = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(ctx, 10), dp(ctx, 6), dp(ctx, 10), dp(ctx, 6))
            background = GradientDrawable().apply { setColor(Color.rgb(29, 34, 40)); cornerRadius = dp(ctx, 18).toFloat() }
            elevation = dp(ctx, 6).toFloat()
        }
        val heading = TextView(ctx).apply { textSize = 13f; setTextColor(Color.WHITE); setPadding(0, dp(ctx, 6), 0, dp(ctx, 6)); maxLines = 2; contentDescription = "Ash 任务状态，点击展开或拖动" }
        var downX = 0f; var downY = 0f; var originX = 0; var originY = 0; var dragged = false
        heading.setOnTouchListener { v, e ->
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { downX = e.rawX; downY = e.rawY; originX = p.x; originY = p.y; dragged = false }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - downX; val dy = e.rawY - downY
                    if (kotlin.math.abs(dx) + kotlin.math.abs(dy) > dp(ctx, 8)) dragged = true
                    if (dragged) {
                        val metrics = ctx.resources.displayMetrics
                        p.x = (originX + dx.toInt()).coerceIn(0, (metrics.widthPixels - p.width).coerceAtLeast(0))
                        p.y = (originY + dy.toInt()).coerceIn(0, (metrics.heightPixels - box.height.coerceAtLeast(dp(ctx, 48)) - dp(ctx, 64)).coerceAtLeast(0))
                        runCatching { wm.updateViewLayout(box, p) }
                    }
                }
                MotionEvent.ACTION_UP -> if (!dragged) v.performClick()
            }; true
        }
        heading.setOnClickListener { expanded = !expanded; restore?.invoke() }
        val detail = TextView(ctx).apply { textSize = 12f; setTextColor(Color.LTGRAY); setPadding(0, dp(ctx, 4), 0, dp(ctx, 4)) }
        val controls = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        fun button(text: String, click: () -> Unit) = Button(ctx).apply { this.text = text; textSize = 12f; setOnClickListener { click() } }
        controls.addView(button("返回 Ash") { ctx.startActivity(Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)) })
        val stopButton = button("停止本次任务") { turn?.let { TaskStatus.stop(it) } }
        controls.addView(stopButton)
        controls.addView(button("收起并隐藏本次悬浮窗") { dismissed = turn; detach() })
        box.addView(heading); box.addView(detail); box.addView(controls)
        wm.addView(box, p)
        manager = wm
        root = box; title = heading; details = detail; actions = controls; stop = stopButton
    }
    private fun detach() {
        root?.let { view ->
            view.visibility = View.INVISIBLE
            runCatching { manager?.removeViewImmediate(view) }
                .onFailure { android.util.Log.w("ash.capsule", "could not detach task window", it) }
        }
        root = null; title = null; details = null; actions = null; stop = null
        manager = null
    }
    fun hide() { if (Looper.myLooper() == Looper.getMainLooper()) { detach(); restore = null } else main.post { detach(); restore = null } }

    /** Hide around real-screen reads/touches, so neither screenshots nor taps hit our UI. */
    fun <T> withoutOverlay(action: () -> T): T {
        val latch = CountDownLatch(1)
        main.post {
            suppressed++; detach()
            // Window removal and compositor capture are different transactions. Wait for two frames.
            Choreographer.getInstance().postFrameCallback {
                Choreographer.getInstance().postFrameCallback { latch.countDown() }
            }
        }
        try {
            if (!latch.await(1000, TimeUnit.MILLISECONDS)) throw IllegalStateException("status overlay could not be cleared")
            return action()
        } finally { main.postDelayed({ suppressed = (suppressed - 1).coerceAtLeast(0); restore?.invoke() }, 120) }
    }
}
