package ai.ash.ui.island

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import android.text.InputType
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.animation.PathInterpolator
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.FloatValueHolder
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.dynamicanimation.animation.SpringForce

/** What the island shows: the reference's `renderIsland` model. */
internal data class IslandModel(
    val kind: String, val form: String, val elapsedSec: Long, val activity: String = "", val body: String = "",
    val canStop: Boolean = false, val placeholder: String = "回复 Ash…",
)

/** The reference's KIND table (island.html), one row per card type. */
internal class IslandKind(val label: String?, val title: String, val face: String, val mark: IslandIndicator.Mark, val tone: Int,
    val run: Boolean = false, val note: String = "", val clamp: Boolean = false, val placeholder: String? = null) {
    companion object {
        private val R = IslandTokens.COLOR_RUNNING; private val N = IslandTokens.COLOR_NEEDS_YOU; private val D = IslandTokens.COLOR_DONE
        private val S = IslandTokens.COLOR_STOP; private val O = IslandTokens.COLOR_OFFLINE
        private const val WORK_NOTE = "你可以继续用手机，需要你时这里会展开"
        private val face = IslandTokens.AVATAR_FACE_BY_KIND
        val ALL = mapOf(
            "listening" to IslandKind("在听", "在听", face.getValue("listening"), IslandIndicator.Mark.BARS, R, run = true, note = "刚收到你的消息"),
            "thinking" to IslandKind("在想", "正在处理", face.getValue("thinking"), IslandIndicator.Mark.DOTS, R, run = true, note = WORK_NOTE),
            "working" to IslandKind(null, "正在处理", face.getValue("working"), IslandIndicator.Mark.RING, R, run = true, note = WORK_NOTE),
            "stale" to IslandKind("连接中断", "连接中断", face.getValue("stale"), IslandIndicator.Mark.OFF, O, note = "15 秒没收到新状态，Ash 可能仍在运行"),
            "ask" to IslandKind("等你回答", "等你回答", face.getValue("ask"), IslandIndicator.Mark.PULSE, N, placeholder = "或者直接告诉 Ash…"),
            "approval" to IslandKind("需要批准", "需要你批准", face.getValue("approval"), IslandIndicator.Mark.PULSE, N),
            "in_app" to IslandKind("去 Ash 操作", "需要你在 Ash 里操作", face.getValue("in_app"), IslandIndicator.Mark.PULSE, N),
            "result" to IslandKind("已完成", "已完成", face.getValue("result"), IslandIndicator.Mark.CHECK, D, clamp = true),
            "incomplete" to IslandKind("未完成", "未完成", face.getValue("incomplete"), IslandIndicator.Mark.WARN, S),
            "stopped" to IslandKind("已停止", "已停止", face.getValue("stopped"), IslandIndicator.Mark.STOP, S),
            // Not in the reference: a normal end before (or without) a judgment. A quiet grey dot.
            "reply" to IslandKind("本轮回复", "本轮回复", "default", IslandIndicator.Mark.DOT, O, clamp = true),
        )
        fun of(kind: String) = ALL[kind] ?: ALL.getValue("working")
    }
}

/**
 * The island's content and its transitions (see [IslandMotion]). Static layout is the reference's; [onFrame] is called
 * with the shell's size on every frame of a transition and on every content change.
 */
internal class IslandView(ctx: Context, private val actions: Actions) {
    interface Actions { fun tap(); fun collapse(); fun close(); fun open(); fun stop(); fun send(text: String); fun focus(editing: Boolean) }
    val shell = IslandShell(ctx)
    var onFrame: (widthPx: Int, heightPx: Int) -> Unit = { _, _ -> }
    /** A transition is about to need this height (the window grows first); and the height once it has settled. */
    var onReserve: (heightPx: Int) -> Unit = {}
    var onSettled: (heightPx: Int) -> Unit = {}
    private val d = ctx.resources.displayMetrics.density
    private fun px(v: Float) = Math.round(v * d)
    private var model: IslandModel? = null
    private var form = ""
    private var cardWidthDp = IslandTokens.SIZE_CARD_W
    private var widthPx = 0; private var heightPx = 0
    private var expanded = false
    var reduceMotion = false
    /** Development check: log each spring step's time and progress. */
    var traceMotion = false
    private val cssEaseOut = PathInterpolator(0f, 0f, 0.58f, 1f)
    // Material's emphasised decelerate, for both sides of the fade through.
    private val fadeIn = PathInterpolator(0.05f, 0.7f, 0.1f, 1f)

    // ---- capsule ----
    private val compact = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(px(IslandSpec.COMPACT_PAD_LEFT), 0, px(IslandSpec.COMPACT_PAD_RIGHT), 0)
        setOnClickListener { actions.tap() }
    }
    private val compactAvatar = IslandAvatar(ctx, IslandSpec.AVATAR_FOCUS_COMPACT)
    private val compactLabel = FadeText(ctx) {
        IslandSpec.text(it, IslandTokens.TYPE_COMPACT_LABEL_SIZE, IslandTokens.COLOR_TEXT, IslandTokens.TYPE_COMPACT_LABEL_WEIGHT)
        it.letterSpacing = IslandSpec.LABEL_LETTER_SPACING; it.isSingleLine = true; it.ellipsize = TextUtils.TruncateAt.END
    }
    private val compactTime = TextView(ctx).apply {
        IslandSpec.text(this, IslandTokens.TYPE_COMPACT_TIME_SIZE, IslandTokens.COLOR_TEXT_SECONDARY, cjk = false); fontFeatureSettings = "tnum"; isSingleLine = true
    }
    private val compactMark = IslandIndicator(ctx)
    init {
        val gap = px(IslandSpec.COMPACT_GAP)
        compact.addView(compactAvatar, LinearLayout.LayoutParams(px(IslandTokens.AVATAR_COMPACT), px(IslandTokens.AVATAR_COMPACT)))
        compact.addView(compactLabel, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = gap })
        // .isl-spacer { flex: 1; min-width: 20px }
        compact.addView(View(ctx).apply { minimumWidth = px(IslandSpec.COMPACT_SPACER_MIN) }, LinearLayout.LayoutParams(0, 1, 1f).apply { leftMargin = gap })
        compact.addView(compactTime, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = gap })
        compact.addView(compactMark, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = gap })
    }

    // ---- card ----
    private val card = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        val p = IslandTokens.SIZE_CARD_PADDING
        setPadding(px(p[3]), px(p[0]), px(p[1]), px(p[2]))
    }
    private val cardAvatar = IslandAvatar(ctx, IslandSpec.AVATAR_FOCUS_CARD, IslandTokens.AVATAR_CARD_RADIUS)
    private val titleDot = IslandDot(ctx)
    private val title = FadeText(ctx) { IslandSpec.text(it, IslandTokens.TYPE_CARD_TITLE_SIZE, IslandTokens.COLOR_TEXT, IslandTokens.TYPE_CARD_TITLE_WEIGHT); it.isSingleLine = true }
    private val meta = TextView(ctx).apply { IslandSpec.text(this, IslandTokens.TYPE_CARD_META_SIZE, IslandTokens.COLOR_TEXT_SECONDARY); fontFeatureSettings = "tnum"; isSingleLine = true }
    private val collapseButton = IslandIcon(ctx, IslandIcon.Kind.UP).apply {
        background = RoundedBackground(IslandTokens.COLOR_ICON_BUTTON, IslandSpec.dp(ctx, IslandSpec.ICON_BUTTON / 2))
        contentDescription = "收起成胶囊"; setOnClickListener { actions.collapse() }
    }
    // middle: running activity block, or the agent's words
    private val activityBlock = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        val pad = px(IslandSpec.ACTIVITY_PAD); setPadding(pad, pad, pad, pad)
        background = RoundedBackground(IslandTokens.COLOR_SURFACE, IslandSpec.dp(ctx, IslandSpec.ACTIVITY_RADIUS))
    }
    private val activityMark = IslandIndicator(ctx)
    // .activity b inherits the outer span's line-height: 1.5
    private val activityTitle = FadeText(ctx) { IslandSpec.text(it, IslandSpec.ACTIVITY_TITLE_SIZE, IslandTokens.COLOR_TEXT, 600f, lineHeight = IslandSpec.ACTIVITY_NOTE_LINE_HEIGHT) }
    private val activityNote = TextView(ctx).apply { IslandSpec.text(this, IslandSpec.ACTIVITY_NOTE_SIZE, IslandTokens.COLOR_TEXT_SECONDARY, lineHeight = IslandSpec.ACTIVITY_NOTE_LINE_HEIGHT) }
    private val textColumn = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
    private val body = FadeText(ctx) { IslandSpec.text(it, IslandTokens.TYPE_BODY_SIZE, IslandTokens.COLOR_BODY, lineHeight = IslandTokens.TYPE_BODY_LINE_HEIGHT) }
    private val more = TextView(ctx).apply {
        IslandSpec.text(this, IslandSpec.MORE_SIZE, IslandTokens.COLOR_RUNNING); gravity = Gravity.CENTER_VERTICAL
        setOnClickListener { expanded = !expanded; model?.let { render(it, force = true) } }
    }
    private val primary = TextView(ctx).apply {
        IslandSpec.text(this, IslandTokens.TYPE_PRIMARY_BUTTON_SIZE, 0xFFFFFFFF.toInt(), IslandTokens.TYPE_PRIMARY_BUTTON_WEIGHT); gravity = Gravity.CENTER
        background = RoundedBackground(IslandTokens.COLOR_PRIMARY, IslandSpec.dp(ctx, IslandSpec.PRIMARY_RADIUS)); text = "去 Ash 里操作"
        setOnClickListener { actions.open() }
    }
    // foot
    // CSS keeps fractional px and Android lays out whole ones; rounding this padding down keeps the rows below within
    // half a px of the reference instead of drifting by a dp.
    private val foot = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL; setPadding(0, (IslandSpec.FOOT_PAD_TOP * d).toInt(), 0, 0) }
    private val divider = View(ctx).apply { setBackgroundColor(IslandTokens.COLOR_DIVIDER) }
    val input = EditText(ctx).apply {
        IslandSpec.text(this, IslandSpec.INPUT_SIZE, IslandTokens.COLOR_TEXT)
        setHintTextColor(IslandTokens.COLOR_PLACEHOLDER); isSingleLine = true
        inputType = InputType.TYPE_CLASS_TEXT; imeOptions = EditorInfo.IME_ACTION_SEND
        val pad = px(IslandSpec.INPUT_PAD); setPadding(pad, 0, pad, 0); gravity = Gravity.CENTER_VERTICAL
        background = RoundedBackground(IslandTokens.COLOR_INPUT, IslandSpec.dp(ctx, IslandSpec.INPUT_HEIGHT / 2))
        setOnFocusChangeListener { _, has -> actions.focus(has) }
        setOnEditorActionListener { _, id, _ -> if (id == EditorInfo.IME_ACTION_SEND) { submit(); true } else false }
    }
    private val sendButton = IslandIcon(ctx, IslandIcon.Kind.SEND).apply {
        ink = IslandTokens.COLOR_TEXT; background = RoundedBackground(IslandSpec.SEND_BACKGROUND, IslandSpec.dp(ctx, IslandSpec.INPUT_HEIGHT / 2))
        contentDescription = "发送"; setOnClickListener { submit() }
    }
    private val stopLink = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(px(IslandSpec.STOP_PAD_LEFT), 0, px(IslandSpec.LINK_PAD), 0)
        addView(View(ctx).apply { background = RoundedBackground(IslandTokens.COLOR_STOP_TEXT, IslandSpec.dp(ctx, 2f)) },
            LinearLayout.LayoutParams(px(IslandSpec.STOP_MARK), px(IslandSpec.STOP_MARK)))
        addView(link("停止任务", IslandTokens.COLOR_STOP_TEXT, 0, 0), LinearLayout.LayoutParams(-2, -1).apply { leftMargin = px(IslandSpec.STOP_GAP) })
        setOnClickListener { actions.stop() }
    }
    private fun link(text: String, color: Int, left: Int, right: Int) = TextView(context()).apply {
        IslandSpec.text(this, IslandTokens.TYPE_FOOTER_LINK_SIZE, color); this.text = text; gravity = Gravity.CENTER_VERTICAL; setPadding(left, 0, right, 0)
    }
    private fun context() = shell.context
    private val openLink = link("回到 Ash", IslandSpec.ICON_BUTTON_INK, px(IslandSpec.LINK_PAD), px(IslandSpec.LINK_PAD)).apply { setOnClickListener { actions.open() } }
    private val closeLink = link("关闭", IslandSpec.ICON_BUTTON_INK, px(IslandSpec.LINK_PAD), px(IslandSpec.CLOSE_PAD_RIGHT)).apply { setOnClickListener { actions.close() } }
    private val linksRow = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }

    init {
        val gap = px(IslandTokens.SIZE_CARD_GAP)
        val head = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        head.addView(cardAvatar, LinearLayout.LayoutParams(px(IslandTokens.AVATAR_CARD_SIZE), px(IslandTokens.AVATAR_CARD_SIZE)))
        val titles = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        // The title dot's pulse spreads past it; these do not clip it.
        val titleRow = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; clipChildren = false }
        head.clipChildren = false; titles.clipChildren = false; card.clipChildren = false
        titleRow.addView(titleDot, LinearLayout.LayoutParams(px(IslandSpec.TITLE_DOT), px(IslandSpec.TITLE_DOT)))
        titleRow.addView(title, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = px(IslandSpec.TITLE_GAP) })
        titles.addView(titleRow); titles.addView(meta, LinearLayout.LayoutParams(-2, -2).apply { topMargin = px(IslandSpec.TITLES_GAP) })
        head.addView(titles, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = px(IslandSpec.HEAD_GAP) })
        head.addView(collapseButton, LinearLayout.LayoutParams(px(IslandSpec.ICON_BUTTON), px(IslandSpec.ICON_BUTTON)).apply { leftMargin = px(IslandSpec.HEAD_GAP) })
        card.addView(head)
        activityBlock.addView(activityMark, LinearLayout.LayoutParams(-2, -2))
        val activityTexts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        activityTexts.addView(activityTitle); activityTexts.addView(activityNote)
        activityBlock.addView(activityTexts, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = px(IslandSpec.ACTIVITY_GAP) })
        card.addView(activityBlock, LinearLayout.LayoutParams(-1, -2).apply { topMargin = gap })
        textColumn.addView(body)
        textColumn.addView(more, LinearLayout.LayoutParams(-2, px(IslandSpec.MORE_HEIGHT)).apply { topMargin = px(IslandSpec.TEXT_GAP) })
        card.addView(textColumn, LinearLayout.LayoutParams(-1, -2).apply { topMargin = gap })
        card.addView(primary, LinearLayout.LayoutParams(-1, px(IslandTokens.TYPE_PRIMARY_BUTTON_HEIGHT)).apply { topMargin = gap })
        // foot: divider is the border-top of .foot
        val inputRow = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        inputRow.addView(input, LinearLayout.LayoutParams(0, px(IslandSpec.INPUT_HEIGHT), 1f))
        inputRow.addView(sendButton, LinearLayout.LayoutParams(px(IslandSpec.INPUT_HEIGHT), px(IslandSpec.INPUT_HEIGHT)).apply { leftMargin = px(IslandSpec.FOOT_INPUT_GAP) })
        foot.addView(inputRow)
        linksRow.addView(stopLink, LinearLayout.LayoutParams(-2, px(IslandSpec.LINK_HEIGHT)))
        linksRow.addView(View(ctx), LinearLayout.LayoutParams(0, 1, 1f))
        linksRow.addView(openLink, LinearLayout.LayoutParams(-2, px(IslandSpec.LINK_HEIGHT)))
        linksRow.addView(closeLink, LinearLayout.LayoutParams(-2, px(IslandSpec.LINK_HEIGHT)))
        foot.addView(linksRow, LinearLayout.LayoutParams(-1, -2).apply { topMargin = px(IslandSpec.FOOT_GAP) })
        card.addView(divider, LinearLayout.LayoutParams(-1, maxOf(1, px(1f))).apply { topMargin = gap })
        card.addView(foot, LinearLayout.LayoutParams(-1, -2))
    }

    /** Development check: each part's box in dp, relative to the shell, named as in the reference's DOM. */
    fun debugBounds(): org.json.JSONObject {
        val out = org.json.JSONObject(); val origin = IntArray(2); shell.getLocationInWindow(origin)
        fun put(name: String, v: View) {
            if (!v.isShown) return
            val at = IntArray(2); v.getLocationInWindow(at)
            out.put(name, org.json.JSONArray(listOf((at[0] - origin[0]) / d, (at[1] - origin[1]) / d, v.width / d, v.height / d).map { Math.round(it * 10) / 10.0 }))
        }
        put("shell", shell)
        if (form == "compact") { put("av", compactAvatar); put("label", compactLabel.current); put("time", compactTime); put("ind", compactMark) }
        else {
            put("av", cardAvatar); put("dot", titleDot); put("title", title.current); put("meta", meta); put("icon-btn", collapseButton)
            put("activity", activityBlock); put("activity-ind", activityMark); put("activity-b", activityTitle.current); put("activity-span", activityNote)
            put("body", body.current); put("more", more); put("primary", primary); put("divider", divider)
            put("input", input); put("send", sendButton); put("stop", stopLink); put("open", openLink); put("close", closeLink)
        }
        return out
    }

    private fun submit() {
        val text = input.text.toString().trim()
        if (text.isNotEmpty()) actions.send(text)
    }
    fun clearInput() { input.setText("") }

    fun setCardWidth(dpWidth: Float) {
        if (cardWidthDp == dpWidth) return
        cardWidthDp = dpWidth
        (card.layoutParams as? FrameLayout.LayoutParams)?.let { it.width = px(dpWidth); card.layoutParams = it }
    }

    /** Shows [next]. A new form morphs; the same form updates in place. */
    fun render(next: IslandModel, force: Boolean = false) {
        val prev = model; model = next
        val k = IslandKind.of(next.kind)
        val reform = next.form != form
        if (prev?.kind != next.kind) expanded = false
        // ---- fill both forms' fields (in place); text that changed fades ----
        compactAvatar.face = k.face
        val label = k.label ?: next.activity.ifBlank { "在忙" }
        compactLabel.set(label, !reform)
        compactTime.visibility = if (k.run || next.kind == "stale") View.VISIBLE else View.GONE
        compactTime.text = clock(next.elapsedSec, short = true)
        compactMark.reduceMotion = reduceMotion; compactMark.set(k.mark, k.tone)
        cardAvatar.face = k.face
        titleDot.tone = k.tone; titleDot.pulsing = k.tone == IslandTokens.COLOR_NEEDS_YOU && !reduceMotion
        title.set(k.title, !reform)
        meta.text = "Ash · " + when {
            k.run -> "已用 ${clock(next.elapsedSec, short = false)}"
            next.kind in setOf("result", "reply", "stopped", "incomplete") -> "用时 ${clock(next.elapsedSec, short = false)}"
            else -> "刚刚"
        }
        val running = k.run || next.kind == "stale"
        activityBlock.visibility = if (running) View.VISIBLE else View.GONE
        textColumn.visibility = if (running) View.GONE else View.VISIBLE
        if (running) {
            activityMark.reduceMotion = reduceMotion
            activityMark.set(if (k.mark == IslandIndicator.Mark.BARS) IslandIndicator.Mark.DOTS else k.mark, k.tone)
            activityTitle.set(if (next.kind == "stale") "状态待确认" else next.activity.ifBlank { k.label ?: "在忙" }, !reform)
            activityNote.text = k.note
        } else {
            val clamp = k.clamp && !expanded
            body.each { it.maxLines = if (clamp) IslandTokens.TYPE_BODY_COLLAPSED_LINES.toInt() else Int.MAX_VALUE; it.ellipsize = if (clamp) TextUtils.TruncateAt.END else null }
            body.set(next.body, !reform)
            more.visibility = if (k.clamp) View.VISIBLE else View.GONE
            more.text = if (expanded) "收起" else "展开全文"
        }
        primary.visibility = if (next.kind == "in_app") View.VISIBLE else View.GONE
        stopLink.visibility = if (k.run && next.canStop) View.VISIBLE else View.GONE
        input.hint = k.placeholder ?: next.placeholder
        // The window keeps room for this content's card at all times, so opening it never has to resize the window
        // (a resize stalls the frame it lands in).
        cardHeightPx = targetSize("card").second
        onReserve(maxOf(cardHeightPx, heightPx))
        // ---- form ----
        if (reform || force) {
            if (reform) morphTo(next.form) else layoutNow()
        } else layoutNow()
    }


    private fun clock(sec: Long, short: Boolean): String {
        val e = (sec / 5) * 5; val m = e / 60; val s = (e % 60).toString().padStart(2, '0')
        return if (short) "$m:$s" else if (m > 0) "$m 分 $s 秒" else "$e 秒"
    }

    private fun targetSize(form: String): Pair<Int, Int> = if (form == "card") {
        val w = px(cardWidthDp)
        card.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
        w to card.measuredHeight
    } else px(IslandTokens.SIZE_COMPACT_W) to px(IslandTokens.SIZE_COMPACT_H)

    private fun content(form: String): View = if (form == "card") card else compact
    private fun radiusPx(form: String) = IslandSpec.dp(shell.context, if (form == "card") IslandTokens.SIZE_CARD_RADIUS else IslandTokens.SIZE_COMPACT_RADIUS)

    // ---- shared avatar: one face that travels between the capsule's and the card's places ----
    private val overlay = FrameLayout(ctx).apply { isClickable = false }
    private val flyFrom = IslandAvatar(ctx, IslandSpec.AVATAR_FOCUS_CARD, IslandTokens.AVATAR_CARD_RADIUS)
    private val flyTo = IslandAvatar(ctx, IslandSpec.AVATAR_FOCUS_CARD, IslandTokens.AVATAR_CARD_RADIUS)
    init {
        // Both forms are built and laid out from the start; the one not shown is invisible. A transition only changes
        // what is visible, never builds or first lays out a view.
        shell.clip.addView(compact, FrameLayout.LayoutParams(px(IslandTokens.SIZE_COMPACT_W), px(IslandTokens.SIZE_COMPACT_H)))
        shell.clip.addView(card, FrameLayout.LayoutParams(px(cardWidthDp), ViewGroup.LayoutParams.WRAP_CONTENT))
        compact.visibility = View.INVISIBLE; card.visibility = View.INVISIBLE
        shell.clip.addView(overlay, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        overlay.addView(flyFrom, FrameLayout.LayoutParams(0, 0)); overlay.addView(flyTo, FrameLayout.LayoutParams(0, 0))
        overlay.visibility = View.GONE
    }
    /** The avatar's box (left, top, size) in each form, in px from the shell's corner (reference layout). */
    private fun avatarBox(form: String): FloatArray = if (form == "card") {
        val p = IslandTokens.SIZE_CARD_PADDING
        // .card-head centres a 40dp avatar on its 44dp row (the collapse button sets the row's height).
        floatArrayOf(p[3] * d, p[0] * d + (IslandSpec.ICON_BUTTON - IslandTokens.AVATAR_CARD_SIZE) / 2 * d, IslandTokens.AVATAR_CARD_SIZE * d)
    } else floatArrayOf(IslandSpec.COMPACT_PAD_LEFT * d, (IslandTokens.SIZE_COMPACT_H - IslandTokens.AVATAR_COMPACT) / 2 * d, IslandTokens.AVATAR_COMPACT * d)
    private fun placeFly(view: View, box: FloatArray) {
        val lp = view.layoutParams as FrameLayout.LayoutParams
        val size = Math.round(box[2])
        if (lp.width != size) { lp.width = size; lp.height = size; view.layoutParams = lp }
        view.translationX = box[0]; view.translationY = box[1]
    }
    private fun avatarOf(form: String) = if (form == "card") cardAvatar else compactAvatar

    private var spring: SpringAnimation? = null
    private var cardHeightPx = 0
    private var fades: ValueAnimator? = null

    /** Same form, new content: a changed height springs to its new size; a changed width (screen) is set at once. */
    private fun layoutNow() {
        if (form.isEmpty()) return
        val (w, h) = targetSize(form)
        if (spring?.isRunning == true) return
        if (heightPx == 0 || reduceMotion || w != widthPx) { onReserve(h); widthPx = w; heightPx = h; apply(w, h, radiusPx(form)); onSettled(maxOf(h, cardHeightPx)); return }
        if (h == heightPx) return
        val from = heightPx
        onReserve(maxOf(from, h))
        springTo(IslandMotion.RESIZE_STIFFNESS, IslandMotion.RESIZE_DAMPING, onEnd = { onSettled(maxOf(heightPx, cardHeightPx)) }) { t -> heightPx = Math.round(from + (h - from) * t); apply(widthPx, heightPx, shell.radius) }
    }

    private fun springTo(stiffness: Float, damping: Float, onEnd: () -> Unit = {}, step: (Float) -> Unit) {
        spring?.cancel()
        spring = SpringAnimation(FloatValueHolder(0f)).apply {
            spring = SpringForce(1f).setStiffness(stiffness).setDampingRatio(damping)
            setMinimumVisibleChange(DynamicAnimation.MIN_VISIBLE_CHANGE_SCALE)
            addUpdateListener { _, value, _ ->
                if (traceMotion) android.util.Log.i("ash.island.motion", "t=${android.os.SystemClock.uptimeMillis()} v=$value")
                step(value)
            }
            addEndListener { _, canceled, _, _ -> if (!canceled) { step(1f); onEnd() } }
            start()
        }
    }

    private fun morphTo(next: String) {
        val from = form; form = next
        val (toW, toH) = targetSize(next)
        val incoming = content(next); val outgoing = if (from.isEmpty()) null else content(from)
        spring?.cancel(); fades?.cancel()
        settle(incoming); incoming.visibility = View.VISIBLE
        if (outgoing == null) { onReserve(toH); widthPx = toW; heightPx = toH; apply(toW, toH, radiusPx(next)); onSettled(maxOf(toH, cardHeightPx)); return }
        if (reduceMotion) {
            // Reduce motion: the island takes its new size at once and its content cross-fades.
            onReserve(maxOf(heightPx, toH)); widthPx = toW; heightPx = toH; apply(toW, toH, radiusPx(next)); onSettled(maxOf(toH, cardHeightPx))
            incoming.alpha = 0f
            fades = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = IslandMotion.REDUCED_FADE_MS
                addUpdateListener { incoming.alpha = it.animatedValue as Float; outgoing.alpha = 1f - incoming.alpha }
                addListener(object : AnimatorListenerAdapter() { override fun onAnimationEnd(animation: Animator) { if (form == next) outgoing.visibility = View.INVISIBLE; outgoing.alpha = 1f } })
                start()
            }
            return
        }
        // Shared avatar: hide the two in place, fly one face between their boxes.
        val a = avatarBox(from); val b = avatarBox(next)
        flyFrom.face = (avatarOf(from) as IslandAvatar).face; flyTo.face = (avatarOf(next) as IslandAvatar).face
        compactAvatar.alpha = 0f; cardAvatar.alpha = 0f
        overlay.visibility = View.VISIBLE; overlay.bringToFront()
        val fromW = widthPx; val fromH = heightPx; val fromR = shell.radius; val toR = radiusPx(next)
        val opening = next == "card"
        onReserve(maxOf(fromH, toH))
        springTo(if (opening) IslandMotion.OPEN_STIFFNESS else IslandMotion.CLOSE_STIFFNESS,
            if (opening) IslandMotion.OPEN_DAMPING else IslandMotion.CLOSE_DAMPING,
            onEnd = {
                overlay.visibility = View.GONE; compactAvatar.alpha = 1f; cardAvatar.alpha = 1f
                if (form == next) { outgoing.visibility = View.INVISIBLE; settle(outgoing) }
                onSettled(maxOf(heightPx, cardHeightPx))
            }) { t ->
            // Closing, the height leads (done by ~60% of the way) so the box never stands empty below the capsule row.
            val ht = if (opening) t else (t / IslandMotion.CLOSE_HEIGHT_LEAD).coerceAtMost(1f)
            widthPx = Math.round(fromW + (toW - fromW) * t); heightPx = Math.round(fromH + (toH - fromH) * ht)
            apply(widthPx, heightPx, (fromR + (toR - fromR) * t).coerceAtLeast(0f))
            // Container transform, fit to width: both contents scale with the container from its top-left corner, so
            // they travel with it instead of sitting still in a growing box.
            val inScale = widthPx.toFloat() / toW; val outScale = widthPx.toFloat() / fromW
            incoming.scaleX = inScale; incoming.scaleY = inScale; outgoing.scaleX = outScale; outgoing.scaleY = outScale
            val c = t.coerceIn(0f, 1f)
            val box = floatArrayOf(a[0] + (b[0] - a[0]) * c, a[1] + (b[1] - a[1]) * c, a[2] + (b[2] - a[2]) * c)
            placeFly(flyFrom, box); placeFly(flyTo, box)
        }
        // Fade through (container transform): two different texts in the same place must not show at once, so the
        // outgoing content leaves quickly and the incoming one comes up just behind it. Both travel with the container
        // and the shared avatar stays, so the island is never an empty box.
        incoming.pivotX = 0f; incoming.pivotY = 0f; outgoing.pivotX = 0f; outgoing.pivotY = 0f
        incoming.alpha = 0f
        // Opening, the card's content lies mostly below the capsule row, so it can start at once.
        val delay = if (opening) 0L else IslandMotion.IN_DELAY_MS
        val total = delay + IslandMotion.IN_MS
        fades = ValueAnimator.ofFloat(0f, total.toFloat()).apply {
            duration = total
            addUpdateListener { anim ->
                val ms = anim.animatedValue as Float
                outgoing.alpha = 1f - fadeIn.getInterpolation((ms / IslandMotion.OUT_MS).coerceIn(0f, 1f))
                val t = fadeIn.getInterpolation(((ms - delay) / IslandMotion.IN_MS).coerceIn(0f, 1f))
                incoming.alpha = t
                // The face cross-fades too when the kind changed along the way.
                flyTo.alpha = t; flyFrom.alpha = 1f - t
            }
            start()
        }
    }

    /** Back to rest: full opacity, no offset, scale or blur. */
    private fun settle(view: View) {
        view.alpha = 1f; view.translationY = 0f; view.scaleX = 1f; view.scaleY = 1f
        if (Build.VERSION.SDK_INT >= 31) view.setRenderEffect(null)
    }

    /** Appearing: springs out of the top centre. */
    fun appear() {
        if (reduceMotion) { shell.alpha = 0f; shell.animate().alpha(1f).setDuration(IslandMotion.REDUCED_FADE_MS).start(); return }
        shell.pivotX = shell.width / 2f; shell.pivotY = 0f
        shell.scaleX = IslandMotion.APPEAR_FROM_SCALE; shell.scaleY = IslandMotion.APPEAR_FROM_SCALE; shell.alpha = 0f
        SpringAnimation(shell, DynamicAnimation.SCALE_X, 1f).apply { spring.setStiffness(IslandMotion.APPEAR_STIFFNESS).setDampingRatio(IslandMotion.APPEAR_DAMPING); start() }
        SpringAnimation(shell, DynamicAnimation.SCALE_Y, 1f).apply { spring.setStiffness(IslandMotion.APPEAR_STIFFNESS).setDampingRatio(IslandMotion.APPEAR_DAMPING); start() }
        shell.animate().alpha(1f).setDuration(IslandMotion.TEXT_IN_MS).setInterpolator(cssEaseOut).start()
    }
    /** Leaving: shrinks back into the top centre, then [done]. */
    fun leave(done: () -> Unit) {
        shell.pivotX = shell.width / 2f; shell.pivotY = 0f
        val to = if (reduceMotion) 1f else IslandMotion.APPEAR_FROM_SCALE
        shell.animate().alpha(0f).scaleX(to).scaleY(to).setDuration(IslandMotion.LEAVE_MS).setInterpolator(PathInterpolator(0.3f, 0f, 1f, 1f))
            .withEndAction { settle(shell); done() }.start()
    }

    private fun apply(w: Int, h: Int, radius: Float) {
        val lp = shell.layoutParams
        if (lp != null && (lp.width != w || lp.height != h)) { lp.width = w; lp.height = h; shell.layoutParams = lp }
        shell.radius = radius
        onFrame(w, h)
    }
}
