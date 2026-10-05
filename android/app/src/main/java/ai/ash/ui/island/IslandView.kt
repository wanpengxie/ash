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
 * The island's content and morph. A change of form (capsule <-> card) animates the shell's width and radius over the
 * reference's 500ms curve while the new content enters (340ms after 100ms: fade, -4dp, 98%, blur 3dp). Within a form
 * the content is updated in place; only text that changed fades in. [onFrame] is called with the shell's size on
 * every frame of a morph and on every content change, so the window can follow in the same frame.
 */
internal class IslandView(ctx: Context, private val actions: Actions) {
    interface Actions { fun tap(); fun collapse(); fun close(); fun open(); fun stop(); fun send(text: String); fun focus(editing: Boolean) }
    val shell = IslandShell(ctx)
    var onFrame: (widthPx: Int, heightPx: Int) -> Unit = { _, _ -> }
    private val d = ctx.resources.displayMetrics.density
    private fun px(v: Float) = Math.round(v * d)
    private var model: IslandModel? = null
    private var form = ""
    private var cardWidthDp = IslandTokens.SIZE_CARD_W
    private var widthPx = 0; private var heightPx = 0
    private var morph: ValueAnimator? = null
    private var expanded = false
    var reduceMotion = false
    private val morphCurve = PathInterpolator(IslandTokens.MOTION_MORPH_EASING[0], IslandTokens.MOTION_MORPH_EASING[1], IslandTokens.MOTION_MORPH_EASING[2], IslandTokens.MOTION_MORPH_EASING[3])
    private val cssEaseOut = PathInterpolator(0f, 0f, 0.58f, 1f)

    // ---- capsule ----
    private val compact = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        setPadding(px(IslandSpec.COMPACT_PAD_LEFT), 0, px(IslandSpec.COMPACT_PAD_RIGHT), 0)
        setOnClickListener { actions.tap() }
    }
    private val compactAvatar = IslandAvatar(ctx, IslandSpec.AVATAR_FOCUS_COMPACT)
    private val compactLabel = TextView(ctx).apply {
        IslandSpec.text(this, IslandTokens.TYPE_COMPACT_LABEL_SIZE, IslandTokens.COLOR_TEXT, IslandTokens.TYPE_COMPACT_LABEL_WEIGHT)
        letterSpacing = IslandSpec.LABEL_LETTER_SPACING; isSingleLine = true; ellipsize = TextUtils.TruncateAt.END
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
    private val title = TextView(ctx).apply { IslandSpec.text(this, IslandTokens.TYPE_CARD_TITLE_SIZE, IslandTokens.COLOR_TEXT, IslandTokens.TYPE_CARD_TITLE_WEIGHT); isSingleLine = true }
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
    private val activityTitle = TextView(ctx).apply { IslandSpec.text(this, IslandSpec.ACTIVITY_TITLE_SIZE, IslandTokens.COLOR_TEXT, 600f, lineHeight = IslandSpec.ACTIVITY_NOTE_LINE_HEIGHT) }
    private val activityNote = TextView(ctx).apply { IslandSpec.text(this, IslandSpec.ACTIVITY_NOTE_SIZE, IslandTokens.COLOR_TEXT_SECONDARY, lineHeight = IslandSpec.ACTIVITY_NOTE_LINE_HEIGHT) }
    private val textColumn = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
    private val body = TextView(ctx).apply { IslandSpec.text(this, IslandTokens.TYPE_BODY_SIZE, IslandTokens.COLOR_BODY, lineHeight = IslandTokens.TYPE_BODY_LINE_HEIGHT) }
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
        if (form == "compact") { put("av", compactAvatar); put("label", compactLabel); put("time", compactTime); put("ind", compactMark) }
        else {
            put("av", cardAvatar); put("dot", titleDot); put("title", title); put("meta", meta); put("icon-btn", collapseButton)
            put("activity", activityBlock); put("activity-ind", activityMark); put("activity-b", activityTitle); put("activity-span", activityNote)
            put("body", body); put("more", more); put("primary", primary); put("divider", divider)
            put("input", input); put("send", sendButton); put("stop", stopLink); put("open", openLink); put("close", closeLink)
        }
        return out
    }

    private fun submit() {
        val text = input.text.toString().trim()
        if (text.isNotEmpty()) actions.send(text)
    }
    fun clearInput() { input.setText("") }

    fun setCardWidth(dpWidth: Float) { cardWidthDp = dpWidth }

    /** Shows [next]. A new form morphs; the same form updates in place. */
    fun render(next: IslandModel, force: Boolean = false) {
        val prev = model; model = next
        val k = IslandKind.of(next.kind)
        val reform = next.form != form
        if (prev?.kind != next.kind) expanded = false
        // ---- fill both forms' fields (in place); text that changed fades ----
        compactAvatar.face = k.face
        val label = k.label ?: next.activity.ifBlank { "在忙" }
        swapText(compactLabel, label, !reform)
        compactTime.visibility = if (k.run || next.kind == "stale") View.VISIBLE else View.GONE
        compactTime.text = clock(next.elapsedSec, short = true)
        compactMark.reduceMotion = reduceMotion; compactMark.set(k.mark, k.tone)
        cardAvatar.face = k.face
        titleDot.tone = k.tone; titleDot.pulsing = k.tone == IslandTokens.COLOR_NEEDS_YOU && !reduceMotion
        swapText(title, k.title, !reform)
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
            swapText(activityTitle, if (next.kind == "stale") "状态待确认" else next.activity.ifBlank { k.label ?: "在忙" }, !reform)
            activityNote.text = k.note
        } else {
            swapText(body, next.body, !reform)
            val clamp = k.clamp && !expanded
            body.maxLines = if (clamp) IslandTokens.TYPE_BODY_COLLAPSED_LINES.toInt() else Int.MAX_VALUE
            body.ellipsize = if (clamp) TextUtils.TruncateAt.END else null
            more.visibility = if (k.clamp) View.VISIBLE else View.GONE
            more.text = if (expanded) "收起" else "展开全文"
        }
        primary.visibility = if (next.kind == "in_app") View.VISIBLE else View.GONE
        stopLink.visibility = if (k.run && next.canStop) View.VISIBLE else View.GONE
        input.hint = k.placeholder ?: next.placeholder
        // ---- form ----
        if (reform || force) {
            if (reform) morphTo(next.form) else layoutNow()
        } else layoutNow()
    }

    private fun swapText(view: TextView, text: String, fade: Boolean) {
        if (view.text.toString() == text) return
        view.text = text
        if (fade && !reduceMotion) { view.alpha = 0f; view.animate().alpha(1f).setDuration(IslandSpec.TEXT_FADE_MS).setInterpolator(cssEaseOut).start() }
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

    /** Same form, new content: size the shell to it now. */
    private fun layoutNow() {
        if (form.isEmpty()) return
        val (w, h) = targetSize(form)
        if (morph?.isRunning == true) { heightPx = h; apply(widthPx, h, shell.radius); return }
        widthPx = w; heightPx = h; apply(w, h, radiusPx(form))
    }

    private fun morphTo(next: String) {
        val from = form; form = next
        val (toW, toH) = targetSize(next)
        val view = content(next); val other = content(if (next == "card") "compact" else "card")
        // The content keeps its final width and sits at the shell's left, clipped while the shell is narrower.
        shell.clip.removeView(other)
        if (view.parent == null) shell.clip.addView(view, FrameLayout.LayoutParams(if (next == "card") toW else toW, if (next == "card") ViewGroup.LayoutParams.WRAP_CONTENT else toH))
        morph?.cancel()
        if (from.isEmpty() || reduceMotion) { widthPx = toW; heightPx = toH; apply(toW, toH, radiusPx(next)); enter(view, instant = from.isEmpty() || reduceMotion); return }
        val fromW = widthPx; val fromR = shell.radius; val toR = radiusPx(next)
        heightPx = toH // the reference snaps height and animates width and radius
        enter(view, instant = false)
        morph = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = IslandTokens.MOTION_MORPH_MS; interpolator = morphCurve
            addUpdateListener { a ->
                val t = a.animatedValue as Float
                widthPx = Math.round(fromW + (toW - fromW) * t)
                apply(widthPx, heightPx, fromR + (toR - fromR) * t)
            }
            addListener(object : AnimatorListenerAdapter() { override fun onAnimationEnd(animation: Animator) { widthPx = toW; apply(toW, heightPx, toR) } })
            start()
        }
    }

    /** `.isl-in`: from opacity 0, translateY(-4px), scale(.98), blur(3px), 340ms ease-out after 100ms. */
    private fun enter(view: View, instant: Boolean) {
        view.animate().cancel()
        if (instant) { view.alpha = 1f; view.translationY = 0f; view.scaleX = 1f; view.scaleY = 1f; if (Build.VERSION.SDK_INT >= 31) view.setRenderEffect(null); return }
        view.alpha = IslandTokens.MOTION_CONTENT_IN_FROM_OPACITY
        view.translationY = IslandSpec.dp(view.context, IslandTokens.MOTION_CONTENT_IN_FROM_TRANSLATE_Y)
        view.scaleX = IslandTokens.MOTION_CONTENT_IN_FROM_SCALE; view.scaleY = IslandTokens.MOTION_CONTENT_IN_FROM_SCALE
        val blur = IslandSpec.dp(view.context, IslandSpec.CONTENT_IN_FROM_BLUR)
        val anim = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = IslandTokens.MOTION_CONTENT_IN_MS; startDelay = IslandTokens.MOTION_CONTENT_IN_DELAY_MS; interpolator = cssEaseOut
            addUpdateListener { a ->
                val t = a.animatedValue as Float
                view.alpha = t
                view.translationY = IslandSpec.dp(view.context, IslandTokens.MOTION_CONTENT_IN_FROM_TRANSLATE_Y) * (1 - t)
                val s = IslandTokens.MOTION_CONTENT_IN_FROM_SCALE + (1 - IslandTokens.MOTION_CONTENT_IN_FROM_SCALE) * t
                view.scaleX = s; view.scaleY = s
                if (Build.VERSION.SDK_INT >= 31) { val r = blur * (1 - t); view.setRenderEffect(if (r > 0.01f) RenderEffect.createBlurEffect(r, r, Shader.TileMode.DECAL) else null) }
            }
        }
        if (Build.VERSION.SDK_INT >= 31) view.setRenderEffect(RenderEffect.createBlurEffect(blur, blur, Shader.TileMode.DECAL))
        anim.start()
    }

    private fun apply(w: Int, h: Int, radius: Float) {
        val lp = shell.layoutParams
        if (lp != null && (lp.width != w || lp.height != h)) { lp.width = w; lp.height = h; shell.layoutParams = lp }
        shell.radius = radius
        onFrame(w, h)
    }
}
