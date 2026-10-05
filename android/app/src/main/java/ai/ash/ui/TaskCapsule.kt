package ai.ash.ui

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Rect
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
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.text.InputType
import android.text.InputFilter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.ScrollView
import ai.ash.host.TaskStatus
import ai.ash.host.TaskCard
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
    private var dismissButton: Button? = null
    private var collapseButton: Button? = null
    private var inputToggle: Button? = null
    private var composer: LinearLayout? = null
    private var editor: EditText? = null
    private var sendButton: Button? = null
    private var inputNotice: TextView? = null
    private var cardBox: LinearLayout? = null
    private var replyText: TextView? = null
    private var contentScroll: ScrollView? = null
    private var cardKey = ""
    private var answerTarget: String? = null
    private val submitted = mutableMapOf<String, String>()
    @Volatile private var editing = false
    private var completed = false
    private var draft = ""
    private var sending = false
    private var attemptText = ""
    private var attemptId = ""
    private var inputMessage = ""
    private var lp: WindowManager.LayoutParams? = null
    private var expanded = false
    private var turn: String? = null
    private var suppressed = 0
    private var passingTouches = 0
    private var restore: (() -> Unit)? = null
    @Volatile private var screenBounds: Rect? = null
    fun ownsWindow(bounds: Rect): Boolean = screenBounds == bounds
    private fun rememberBounds(view: View) {
        val point = IntArray(2); view.getLocationOnScreen(point)
        screenBounds = Rect(point[0], point[1], point[0] + view.width, point[1] + view.height)
    }
    private fun dp(ctx: Context, n: Int) = (ctx.resources.displayMetrics.density * n).toInt()

    fun isEditing(): Boolean = editing
    fun update(ctx: Context, text: String, steps: List<String>, canStop: Boolean, task: String, visible: Boolean, subtitle: String = "", finished: Boolean = false, success: Boolean = false,
        reply: String = "", cards: List<TaskCard> = emptyList(), interactive: Boolean = true) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (turn != task) { expanded = false; turn = task }
        app = ctx.applicationContext
        completed = finished
        restore = { update(ctx, text, steps, canStop, task, visible, subtitle, finished, success, reply, cards, interactive) }
        val unlocked = !ctx.getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked &&
            ctx.getSystemService(android.os.PowerManager::class.java).isInteractive
        if (!visible || !unlocked || suppressed > 0 || !Settings.canDrawOverlays(ctx)) {
            if (!unlocked || !visible) editing = false
            detach(); return
        }
        runCatching {
            if (root == null) attach(ctx)
            applyTouchMode()
            (root?.background as? GradientDrawable)?.setColor(Color.rgb(29, 34, 40))
            val headingText = "$text  ${if (expanded) "▴" else "▾"}"
            if (title?.text?.toString() != headingText) title?.text = headingText
            val detailText = (listOf(subtitle) + if (expanded) steps.takeLast(5).map { "· $it" } else emptyList()).filter { it.isNotBlank() }.joinToString("\n")
            if (details?.text?.toString() != detailText) details?.text = detailText
            details?.visibility = if (detailText.isNotBlank()) View.VISIBLE else View.GONE
            actions?.visibility = View.VISIBLE
            dismissButton?.isEnabled = interactive
            if (replyText?.text?.toString() != reply) replyText?.text = reply
            replyText?.visibility = if (reply.isNotBlank()) View.VISIBLE else View.GONE
            replyText?.maxLines = if (expanded) Int.MAX_VALUE else 6
            contentScroll?.visibility = if (reply.isNotBlank() || cards.isNotEmpty()) View.VISIBLE else View.GONE
            val key = cards.toString() + interactive + cards.map { it.actionable(System.currentTimeMillis()) } + submitted.toString()
            if (key != cardKey) { renderCards(ctx, cards, interactive); cardKey = key }
            composer?.visibility = if (editing) View.VISIBLE else View.GONE
            inputToggle?.text = if (editing) "收起" else "输入"
            sendButton?.isEnabled = !sending
            editor?.isEnabled = !sending
            inputNotice?.text = inputMessage
            root?.let { box ->
                rememberBounds(box)
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
        if (attemptId.isBlank()) {
            val saved = ctx.getSharedPreferences("ash_capsule_input", Context.MODE_PRIVATE)
            val id = saved.getString("pending_id", "").orEmpty()
            if (id.isNotBlank()) {
                attemptId = id; attemptText = saved.getString("pending_text", "").orEmpty()
                answerTarget = saved.getString("pending_question", null)
                if (draft.isBlank()) draft = attemptText
                inputMessage = "上次发送未确认，可使用原消息重试"
            }
        }
        val wm = ctx.getSystemService(WindowManager::class.java)
        val p = lp ?: WindowManager.LayoutParams(minOf(dp(ctx, 320), ctx.resources.displayMetrics.widthPixels - dp(ctx, 24)), WindowManager.LayoutParams.WRAP_CONTENT,
            if (Build.VERSION.SDK_INT >= 26) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY else WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT).apply { gravity = Gravity.TOP or Gravity.LEFT; x = ((ctx.resources.displayMetrics.widthPixels - width) / 2).coerceAtLeast(0); y = dp(ctx, 48); setTitle("AshTaskCapsule") }.also { lp = it }
        val box = LinearLayout(ctx).apply {
            contentDescription = "AshTaskCapsule"
            orientation = LinearLayout.VERTICAL; setPadding(dp(ctx, 10), dp(ctx, 6), dp(ctx, 10), dp(ctx, 6))
            background = GradientDrawable().apply { setColor(Color.rgb(29, 34, 40)); cornerRadius = dp(ctx, 18).toFloat() }
            elevation = dp(ctx, 6).toFloat()
            addOnLayoutChangeListener { view, _, _, _, _, _, _, _, _ -> rememberBounds(view) }
        }
        val heading = TextView(ctx).apply { textSize = 13f; setTextColor(Color.WHITE); setPadding(0, dp(ctx, 6), 0, dp(ctx, 6)); maxLines = 2; contentDescription = "Ash 任务状态，点击展开或拖动" }
        var downX = 0f; var downY = 0f; var originX = 0; var originY = 0; var dragged = false
        heading.setOnTouchListener { v, e ->
            if (passingTouches > 0) return@setOnTouchListener true
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
        heading.setOnClickListener { if (passingTouches == 0) { expanded = !expanded; restore?.invoke() } }
        val detail = TextView(ctx).apply { textSize = 12f; setTextColor(Color.LTGRAY); setPadding(0, dp(ctx, 4), 0, dp(ctx, 4)) }
        val controls = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        fun button(text: String, click: () -> Unit) = Button(ctx).apply { this.text = text; textSize = 12f; setOnClickListener { click() } }
        val input = button("输入") { answerTarget = null; editor?.hint = "补充信息或发新指令…"; setEditing(!editing) }
        controls.addView(input, LinearLayout.LayoutParams(0, dp(ctx, 42), 1f))
        controls.addView(button("回 Ash") {
            setEditing(false)
            ctx.startActivity(Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        }, LinearLayout.LayoutParams(0, dp(ctx, 42), 1f))
        val dismiss = button("结束") { setEditing(false); turn?.let { TaskStatus.end(it) } }
        controls.addView(dismiss, LinearLayout.LayoutParams(0, dp(ctx, 42), 1f))
        val content = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        val replyView = TextView(ctx).apply { textSize = 14f; setTextColor(Color.WHITE); setPadding(0, dp(ctx, 6), 0, dp(ctx, 8)); setTextIsSelectable(true) }
        val cardsView = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        content.addView(replyView); content.addView(cardsView)
        val scroll = object : ScrollView(ctx) {
            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                super.onMeasure(widthMeasureSpec, View.MeasureSpec.makeMeasureSpec(minOf(dp(ctx, 280), ctx.resources.displayMetrics.heightPixels / 3), View.MeasureSpec.AT_MOST))
            }
        }.apply { addView(content); isFillViewport = false }
        val inputBox = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        val field = object : EditText(ctx) {
            override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
                super.onWindowFocusChanged(hasWindowFocus)
                // Updating NOT_FOCUSABLE is asynchronous. An immediate showSoftInput can run before
                // InputMethodManager serves this overlay, so retry when the window actually gains focus.
                if (hasWindowFocus && editing) post {
                    if (editing && hasWindowFocus()) {
                        requestFocus()
                        ctx.getSystemService(InputMethodManager::class.java).showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
                    }
                }
            }
            override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
                if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) { setEditing(false); return true }
                return super.onKeyPreIme(keyCode, event)
            }
        }.apply {
            hint = "补充信息或发新指令…"; contentDescription = "给 Ash 的消息"
            setTextColor(Color.WHITE); setHintTextColor(Color.LTGRAY); textSize = 14f
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 2; maxLines = 3; filters = arrayOf(InputFilter.LengthFilter(4000))
            imeOptions = EditorInfo.IME_ACTION_SEND; setText(draft); setSelection(text.length)
            setOnEditorActionListener { _, action, _ -> if (action == EditorInfo.IME_ACTION_SEND) { submitInput(); true } else false }
        }
        val send = button("发送") { submitInput() }
        val inputStatus = TextView(ctx).apply { textSize = 11f; setTextColor(Color.LTGRAY) }
        inputBox.addView(field); inputBox.addView(send); inputBox.addView(inputStatus)
        box.addView(heading); box.addView(detail); box.addView(scroll); box.addView(controls)
        box.addView(inputBox)
        wm.addView(box, p)
        manager = wm
        root = box; title = heading; details = detail; actions = controls
        cardBox = cardsView; replyText = replyView; contentScroll = scroll; cardKey = ""
        dismissButton = dismiss; inputToggle = input; composer = inputBox; editor = field; sendButton = send; inputNotice = inputStatus
    }
    private fun renderCards(ctx: Context, cards: List<TaskCard>, interactive: Boolean) {
        val box = cardBox ?: return
        box.removeAllViews()
        for (card in cards) {
            fun label(value: String) = TextView(ctx).apply { text = value; textSize = 13f; setTextColor(Color.WHITE); setPadding(0, dp(ctx, 5), 0, dp(ctx, 5)); setTextIsSelectable(true) }
            box.addView(label(card.title))
            box.addView(label(card.detail))
            val original = label(card.original).apply { visibility = View.GONE; typeface = android.graphics.Typeface.MONOSPACE }
            val view = Button(ctx).apply {
                text = "查看原文"; textSize = 12f
                setOnClickListener { original.visibility = if (original.visibility == View.GONE) View.VISIBLE else View.GONE; text = if (original.visibility == View.VISIBLE) "收起原文" else "查看原文" }
            }
            box.addView(view); box.addView(original)
            val status = when {
                submitted.containsKey(card.id) && card.state == "waiting" -> submitted[card.id]!!
                card.state == "waiting" && card.expiresAt <= System.currentTimeMillis() -> "已过期"
                card.state == "answered" -> if (card.kind == "approval") "已批准，等待继续" else "已回答"
                card.state == "denied" -> "已拒绝"
                card.state == "redeemed" -> "已提交执行，结果见后续回复"
                card.state == "withdrawn" -> "已撤回"
                card.state == "skipped" -> "未执行"
                card.state == "expired" -> "已过期"
                else -> ""
            }
            if (status.isNotBlank()) box.addView(label(status))
            if (!card.actionable(System.currentTimeMillis())) continue
            for ((choice, title) in card.options.filter { card.kind == "question" || it.first in setOf("once", "deny") }) {
                box.addView(Button(ctx).apply {
                    text = if (card.kind != "question" && choice == "once") "允许并继续" else title
                    textSize = 12f; isEnabled = interactive && !submitted.containsKey(card.id)
                    setOnClickListener {
                        submitted[card.id] = "正在提交…"; restore?.invoke()
                        TaskStatus.answerCard(card.id, choice) { ok, message ->
                            if (ok) submitted[card.id] = message else submitted.remove(card.id)
                            android.widget.Toast.makeText(ctx, message, android.widget.Toast.LENGTH_LONG).show(); restore?.invoke()
                        }
                    }
                })
            }
            if (card.kind == "question" && card.allowCustom) box.addView(Button(ctx).apply {
                text = "输入回答"; textSize = 12f; isEnabled = interactive && !submitted.containsKey(card.id)
                setOnClickListener { answerTarget = card.id; setEditing(true); editor?.hint = "回答：${card.title}" }
            })
        }
    }
    private fun setEditing(value: Boolean) {
        if (value && passingTouches > 0) return
        if (value && !editing && !sending && attemptId.isBlank()) inputMessage = ""
        editing = value
        val ctx = app ?: return
        if (!value) {
            draft = editor?.text?.toString() ?: draft
            editor?.let { ctx.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(it.windowToken, 0); it.clearFocus() }
        }
        val p = lp ?: return
        p.flags = if (value) p.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv() and WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM.inv()
            else p.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        p.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        root?.let { manager?.updateViewLayout(it, p) }
        restore?.invoke()
        if (value) editor?.post {
            if (editing) { editor?.requestFocus(); ctx.getSystemService(InputMethodManager::class.java).showSoftInput(editor, InputMethodManager.SHOW_IMPLICIT) }
        }
    }
    private fun submitInput() {
        if (sending) return
        val text = editor?.text?.toString()?.trim().orEmpty()
        if (text.isBlank()) return
        // Reuse the exact identity after an ambiguous network failure. Never blindly submit a new copy.
        if (text != attemptText || attemptId.isBlank()) { attemptText = text; attemptId = java.util.UUID.randomUUID().toString() }
        val saved = app?.getSharedPreferences("ash_capsule_input", Context.MODE_PRIVATE) ?: return
        if (!saved.edit().putString("pending_id", attemptId).putString("pending_text", text).putString("pending_question", answerTarget).commit()) {
            inputMessage = "未能保存发送状态，请重试"; restore?.invoke(); return
        }
        draft = text; sending = true; inputMessage = "正在发送…"; setEditing(false)
        val target = answerTarget
        val callback: (Boolean, String) -> Unit = { ok, message ->
            sending = false; inputMessage = message
            if (ok) {
                saved.edit().remove("pending_id").remove("pending_text").remove("pending_question").commit()
                if (target != null) submitted[target] = message
                answerTarget = null
                draft = ""; attemptText = ""; attemptId = ""; editor?.setText("")
                setEditing(false)
                android.widget.Toast.makeText(app, message, android.widget.Toast.LENGTH_SHORT).show()
            } else setEditing(true)
            restore?.invoke()
        }
        if (target != null) TaskStatus.answerCard(target, "custom", text, callback)
        else TaskStatus.sendInput(text, attemptId, callback)
    }
    private fun detach() {
        draft = editor?.text?.toString() ?: draft
        editor?.let { app?.getSystemService(InputMethodManager::class.java)?.hideSoftInputFromWindow(it.windowToken, 0) }
        screenBounds = null
        root?.let { view ->
            view.visibility = View.INVISIBLE
            runCatching { manager?.removeViewImmediate(view) }
                .onFailure { android.util.Log.w("ash.capsule", "could not detach task window", it) }
        }
        root = null; title = null; details = null; actions = null; stop = null
        cardBox = null; replyText = null; contentScroll = null; cardKey = ""
        composer = null; editor = null; inputToggle = null; inputNotice = null; sendButton = null; dismissButton = null; collapseButton = null
        manager = null
    }
    fun hide() { if (Looper.myLooper() == Looper.getMainLooper()) { editing = false; detach(); restore = null } else main.post { editing = false; detach(); restore = null } }

    private fun applyTouchMode() {
        val p = lp ?: return
        val focusFlags = if (editing) p.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv() and WindowManager.LayoutParams.FLAG_ALT_FOCUSABLE_IM.inv()
            else p.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        val flags = if (passingTouches > 0) focusFlags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
            else focusFlags and WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE.inv()
        // Android's untrusted-overlay touch protection permits passthrough only below its opacity limit.
        val alpha = if (passingTouches > 0) 0.7f else 1f
        if (p.flags != flags || p.alpha != alpha) {
            p.flags = flags; p.alpha = alpha
            root?.let { manager?.updateViewLayout(it, p) }
        }
    }

    /** Keep progress visible during gestures, but let input pass through to the target app. */
    fun <T> withTouchPassthrough(action: () -> T): T {
        val latch = CountDownLatch(1)
        var applied = false
        var entered = false
        main.post {
            if (editing) { latch.countDown(); return@post }
            entered = true
            passingTouches++
            runCatching { applyTouchMode(); applied = true }
                .onFailure { android.util.Log.w("ash.capsule", "could not release overlay input", it) }
            run {
                Choreographer.getInstance().postFrameCallback {
                    Choreographer.getInstance().postFrameCallback { main.postDelayed({ latch.countDown() }, 100) }
                }
            }
        }
        try {
            if (!latch.await(1000, TimeUnit.MILLISECONDS) || !applied) throw IllegalStateException("owner_input_busy: owner is entering a message; do not take input focus")
            return action()
        } finally { main.postDelayed({ if (entered) passingTouches = (passingTouches - 1).coerceAtLeast(0); runCatching { applyTouchMode() } }, 120) }
    }

    /** Briefly hide only for real-screen capture, so the model sees the underlying page. */
    fun <T> withoutOverlay(action: () -> T): T {
        val latch = CountDownLatch(1)
        var entered = false
        main.post {
            if (editing) { latch.countDown(); return@post }
            entered = true
            suppressed++; detach()
            // Window removal and compositor capture are different transactions. Wait for two frames.
            Choreographer.getInstance().postFrameCallback {
                Choreographer.getInstance().postFrameCallback { latch.countDown() }
            }
        }
        try {
            if (!latch.await(1000, TimeUnit.MILLISECONDS) || !entered) throw IllegalStateException("owner_input_busy: owner is entering a message; defer screen capture")
            return action()
        } finally { main.postDelayed({ if (entered) suppressed = (suppressed - 1).coerceAtLeast(0); restore?.invoke() }, 120) }
    }
}
