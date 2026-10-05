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

/**
 * What the island shows: the reference's `renderIsland` model, plus what the host adds to it (host.js `decorate`): the
 * card's own end, its full original, the pager, the send notice and which buttons can be used.
 */
internal data class IslandModel(
    val kind: String, val form: String, val elapsedSec: Long, val activity: String = "", val body: String = "",
    val canStop: Boolean = false, val placeholder: String = "回复 Ash…",
    /** approval: what Ash would send, quoted; and pending | approved | denied | expired | settled. */
    val quote: String = "", val approval: String = "",
    /** ask: the answers to tap. */
    val options: List<String> = emptyList(),
    /** How a question or approval ended ("已回答"…), shown under it. */
    val status: String = "",
    val original: String = "", val showOriginal: Boolean = false,
    /** "2 / 3" when several questions wait. */
    val pager: String = "",
    val notice: String = "",
    /** The owner can act now (not stale), and this card's buttons are still live. */
    val interactive: Boolean = true, val actionable: Boolean = true,
    /** A message is on its way: the composer waits. */
    val busy: Boolean = false,
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
    interface Actions {
        fun tap(); fun collapse(); fun close(); fun open(); fun stop(); fun send(text: String); fun focus(editing: Boolean)
        fun choose(index: Int); fun allow(); fun deny(); fun toggleOriginal(); fun page(delta: Int)
        /** The island is dragged by [dx], [dy] px since the press ("start", "move", "end"). */
        fun drag(phase: String, dx: Float, dy: Float)
    }
    val shell = IslandShell(ctx)
    var onFrame: (widthPx: Int, heightPx: Int) -> Unit = { _, _ -> }
    /** A transition is running: its frames only redraw (nothing is laid out or moved between windows). */
    var animating = false; private set
    private val d = ctx.resources.displayMetrics.density
    private fun px(v: Float) = Math.round(v * d)
    private var model: IslandModel? = null
    private var form = ""
    private var cardWidthDp = IslandTokens.SIZE_CARD_W
    private var widthPx = 0; private var heightPx = 0
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
    private val content = android.widget.ScrollView(ctx).apply { isVerticalScrollBarEnabled = false; overScrollMode = View.OVER_SCROLL_NEVER; isFillViewport = false }
    private val contentColumn = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL; showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE; dividerDrawable = gap(px(IslandTokens.SIZE_CARD_GAP))
    }
    private val body = FadeText(ctx) { IslandSpec.text(it, IslandTokens.TYPE_BODY_SIZE, IslandTokens.COLOR_BODY, lineHeight = IslandTokens.TYPE_BODY_LINE_HEIGHT) }
    private val more = TextView(ctx).apply {
        IslandSpec.text(this, IslandSpec.MORE_SIZE, IslandTokens.COLOR_RUNNING); gravity = Gravity.CENTER_VERTICAL
        setOnClickListener { actions.toggleOriginal() }
    }
    private val quote = TextView(ctx).apply {
        IslandSpec.text(this, IslandSpec.QUOTE_SIZE, IslandTokens.COLOR_TEXT, lineHeight = IslandSpec.QUOTE_LINE_HEIGHT)
        setPadding(px(IslandSpec.QUOTE_PAD_H), px(IslandSpec.QUOTE_PAD_V), px(IslandSpec.QUOTE_PAD_H), px(IslandSpec.QUOTE_PAD_V))
        background = RoundedBackground(IslandTokens.COLOR_SURFACE, IslandSpec.dp(ctx, IslandSpec.QUOTE_RADIUS), IslandSpec.QUOTE_STROKE, d)
    }
    // ---- the card's action: answers, allow / deny, how an approval ended, or "go to Ash" ----
    private val options = IslandWrap(ctx, px(IslandSpec.OPTIONS_GAP))
    private val approvalRow = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE; dividerDrawable = gap(px(IslandSpec.APPROVAL_GAP)) }
    private val allowButton = pill("允许并继续", IslandTokens.COLOR_PRIMARY, 0xFFFFFFFF.toInt(), IslandTokens.TYPE_PRIMARY_BUTTON_WEIGHT).apply { setOnClickListener { actions.allow() } }
    private val denyButton = pill("拒绝", IslandTokens.COLOR_NEUTRAL_BUTTON, IslandSpec.NEUTRAL_INK, 600f).apply { setOnClickListener { actions.deny() } }
    private val approved = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER
        background = RoundedBackground(IslandSpec.APPROVED_BACKGROUND, IslandSpec.dp(ctx, IslandSpec.PRIMARY_RADIUS))
        addView(IslandIcon(ctx, IslandIcon.Kind.TICK, IslandSpec.TICK).apply { ink = IslandTokens.COLOR_DONE_TEXT }, LinearLayout.LayoutParams(px(IslandSpec.TICK), px(IslandSpec.TICK)))
        addView(TextView(ctx).apply { IslandSpec.text(this, IslandTokens.TYPE_PRIMARY_BUTTON_SIZE, IslandTokens.COLOR_DONE_TEXT, 600f); text = "已批准，等待继续" },
            LinearLayout.LayoutParams(-2, -2).apply { leftMargin = px(IslandSpec.APPROVED_GAP) })
    }
    private val apFinal = finalLine()
    private val original = TextView(ctx).apply {
        IslandSpec.text(this, IslandSpec.ORIGINAL_SIZE, IslandTokens.COLOR_TEXT, lineHeight = IslandSpec.ORIGINAL_LINE_HEIGHT, cjk = false)
        typeface = android.graphics.Typeface.MONOSPACE; setTextIsSelectable(false)
        val pad = px(IslandSpec.ORIGINAL_PAD); setPadding(pad, pad, pad, pad)
        background = RoundedBackground(IslandTokens.COLOR_SURFACE, IslandSpec.dp(ctx, IslandSpec.ORIGINAL_RADIUS))
    }
    /** host.js decorate: how a question or approval ended. */
    private val status = finalLine()
    private val pager = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    private val pagerText = TextView(ctx).apply { IslandSpec.text(this, IslandSpec.NAV_SIZE, IslandTokens.COLOR_TEXT_SECONDARY, cjk = false); gravity = Gravity.CENTER }
    private val notice = TextView(ctx).apply { IslandSpec.text(this, IslandSpec.NOTICE_SIZE, IslandTokens.COLOR_NEEDS_YOU_TEXT) }
    private fun pill(text: String, fill: Int, ink: Int, weight: Float) = TextView(shell.context).apply {
        IslandSpec.text(this, IslandTokens.TYPE_PRIMARY_BUTTON_SIZE, ink, weight); this.text = text; gravity = Gravity.CENTER
        background = RoundedBackground(fill, IslandSpec.dp(context, IslandSpec.PRIMARY_RADIUS))
    }
    private fun finalLine() = TextView(shell.context).apply {
        IslandSpec.text(this, IslandSpec.FINAL_SIZE, IslandSpec.FINAL_INK); gravity = Gravity.CENTER
        background = RoundedBackground(IslandTokens.COLOR_SURFACE, IslandSpec.dp(context, IslandSpec.PRIMARY_RADIUS))
    }
    private fun option(label: String, index: Int) = TextView(shell.context).apply {
        IslandSpec.text(this, IslandTokens.TYPE_BUTTON_SIZE, IslandTokens.COLOR_NEEDS_YOU_TEXT, IslandTokens.TYPE_BUTTON_WEIGHT); text = label
        gravity = Gravity.CENTER_VERTICAL; isSingleLine = true; ellipsize = TextUtils.TruncateAt.END
        setPadding(px(IslandSpec.OPTION_PAD), 0, px(IslandSpec.OPTION_PAD), 0)
        background = RoundedBackground(IslandSpec.OPTION_BACKGROUND, IslandSpec.dp(context, IslandSpec.OPTION_HEIGHT / 2), IslandTokens.COLOR_NEEDS_YOU, IslandSpec.dp(context, IslandSpec.OPTION_BORDER))
        setOnClickListener { actions.choose(index) }
    }
    private fun usable(view: View, enabled: Boolean) { view.isEnabled = enabled; view.alpha = if (enabled) 1f else IslandSpec.DISABLED_ALPHA }
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
        // (Within the head: the card itself clips, so its scrolling middle never shows past the head or the foot.)
        head.clipChildren = false; titles.clipChildren = false
        titleRow.addView(titleDot, LinearLayout.LayoutParams(px(IslandSpec.TITLE_DOT), px(IslandSpec.TITLE_DOT)))
        titleRow.addView(title, LinearLayout.LayoutParams(-2, -2).apply { leftMargin = px(IslandSpec.TITLE_GAP) })
        titles.addView(titleRow); titles.addView(meta, LinearLayout.LayoutParams(-2, -2).apply { topMargin = px(IslandSpec.TITLES_GAP) })
        head.addView(titles, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = px(IslandSpec.HEAD_GAP) })
        head.addView(collapseButton, LinearLayout.LayoutParams(px(IslandSpec.ICON_BUTTON), px(IslandSpec.ICON_BUTTON)).apply { leftMargin = px(IslandSpec.HEAD_GAP) })
        card.addView(head)
        draggable(head); draggable(compact)
        activityBlock.addView(activityMark, LinearLayout.LayoutParams(-2, -2))
        val activityTexts = LinearLayout(ctx).apply { orientation = LinearLayout.VERTICAL }
        activityTexts.addView(activityTitle); activityTexts.addView(activityNote)
        activityBlock.addView(activityTexts, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = px(IslandSpec.ACTIVITY_GAP) })
        // host.css .island-content: everything between the head and the foot scrolls when the card meets its limit.
        val navButton = { kind: IslandIcon.Kind, delta: Int, label: String -> IslandIcon(ctx, kind).apply { contentDescription = label; setOnClickListener { actions.page(delta) } } }
        pager.addView(navButton(IslandIcon.Kind.PREV, -1, "上一项"), LinearLayout.LayoutParams(px(IslandSpec.ICON_BUTTON), px(IslandSpec.ICON_BUTTON)))
        pager.addView(pagerText, LinearLayout.LayoutParams(0, -2, 1f))
        pager.addView(navButton(IslandIcon.Kind.NEXT, 1, "下一项"), LinearLayout.LayoutParams(px(IslandSpec.ICON_BUTTON), px(IslandSpec.ICON_BUTTON)))
        contentColumn.addView(pager, LinearLayout.LayoutParams(-1, -2))
        contentColumn.addView(activityBlock, LinearLayout.LayoutParams(-1, -2))
        textColumn.showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE; textColumn.dividerDrawable = gap(px(IslandSpec.TEXT_GAP))
        textColumn.addView(body)
        textColumn.addView(quote, LinearLayout.LayoutParams(-1, -2))
        textColumn.addView(more, LinearLayout.LayoutParams(-2, px(IslandSpec.MORE_HEIGHT)))
        contentColumn.addView(textColumn, LinearLayout.LayoutParams(-1, -2))
        contentColumn.addView(options, LinearLayout.LayoutParams(-1, -2))
        approvalRow.addView(allowButton, LinearLayout.LayoutParams(0, px(IslandTokens.TYPE_PRIMARY_BUTTON_HEIGHT), IslandSpec.ALLOW_FLEX))
        approvalRow.addView(denyButton, LinearLayout.LayoutParams(0, px(IslandTokens.TYPE_PRIMARY_BUTTON_HEIGHT), IslandSpec.DENY_FLEX))
        contentColumn.addView(approvalRow, LinearLayout.LayoutParams(-1, -2))
        contentColumn.addView(approved, LinearLayout.LayoutParams(-1, px(IslandTokens.TYPE_PRIMARY_BUTTON_HEIGHT)))
        contentColumn.addView(apFinal, LinearLayout.LayoutParams(-1, px(IslandTokens.TYPE_PRIMARY_BUTTON_HEIGHT)))
        contentColumn.addView(primary, LinearLayout.LayoutParams(-1, px(IslandTokens.TYPE_PRIMARY_BUTTON_HEIGHT)))
        contentColumn.addView(original, LinearLayout.LayoutParams(-1, -2))
        contentColumn.addView(status, LinearLayout.LayoutParams(-1, px(IslandTokens.TYPE_PRIMARY_BUTTON_HEIGHT)))
        content.addView(contentColumn, FrameLayout.LayoutParams(-1, -2))
        // Its natural height, shrunk (weight) only when the card would pass its limit.
        card.addView(content, LinearLayout.LayoutParams(-1, -2, 1f).apply { topMargin = gap })
        // foot: divider is the border-top of .foot
        val inputRow = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        inputRow.addView(input, LinearLayout.LayoutParams(0, px(IslandSpec.INPUT_HEIGHT), 1f))
        inputRow.addView(sendButton, LinearLayout.LayoutParams(px(IslandSpec.INPUT_HEIGHT), px(IslandSpec.INPUT_HEIGHT)).apply { leftMargin = px(IslandSpec.FOOT_INPUT_GAP) })
        foot.addView(notice, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = px(IslandSpec.FOOT_GAP) })
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
        origin[0] += shell.box.left
        fun put(name: String, v: View) {
            if (!v.isShown) return
            val at = IntArray(2); v.getLocationInWindow(at)
            out.put(name, org.json.JSONArray(listOf((at[0] - origin[0]) / d, (at[1] - origin[1]) / d, v.width / d, v.height / d).map { Math.round(it * 10) / 10.0 }))
        }
        out.put("shell", org.json.JSONArray(listOf(0.0, 0.0, Math.round(shell.box.width() / d * 10) / 10.0, Math.round(shell.box.height() / d * 10) / 10.0)))
        if (form == "compact") { put("av", compactAvatar); put("label", compactLabel.current); put("time", compactTime); put("ind", compactMark) }
        else {
            put("av", cardAvatar); put("dot", titleDot); put("title", title.current); put("meta", meta); put("icon-btn", collapseButton)
            put("activity", activityBlock); put("activity-ind", activityMark); put("activity-b", activityTitle.current); put("activity-span", activityNote)
            put("body", body.current); put("more", more); put("primary", primary); put("divider", divider)
            put("quote", quote); put("options", options); put("allow", allowButton); put("deny", denyButton); put("approved", approved); put("final", apFinal)
            put("original", original); put("status", status); put("pager", pager); put("notice", notice)
            put("input", input); put("send", sendButton); put("stop", stopLink); put("open", openLink); put("close", closeLink)
        }
        return out
    }

    private fun submit() {
        val text = input.text.toString().trim()
        if (text.isNotEmpty()) actions.send(text)
    }
    fun clearInput() { input.setText("") }

    private var shownOptions: List<String> = emptyList()
    private var maxCardPx = Int.MAX_VALUE / 2
    /** The tallest the card may be (the screen below it); its middle scrolls beyond that. */
    fun setMaxCardHeight(px: Int) { maxCardPx = px }
    fun resetMore() { content.scrollTo(0, 0) }

    /** A press on the capsule or the card's head that moves past the slop drags the island instead of tapping it. */
    @android.annotation.SuppressLint("ClickableViewAccessibility")
    private fun draggable(view: View) {
        var x = 0f; var y = 0f; var dragging = false
        val slop = IslandSpec.DRAG_SLOP * d
        view.setOnTouchListener { _, e ->
            when (e.actionMasked) {
                android.view.MotionEvent.ACTION_DOWN -> { x = e.rawX; y = e.rawY; dragging = false }
                android.view.MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - x; val dy = e.rawY - y
                    if (!dragging && Math.abs(dx) + Math.abs(dy) > slop) { dragging = true; view.isPressed = false; actions.drag("start", 0f, 0f) }
                    if (dragging) actions.drag("move", dx, dy)
                }
                android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> if (dragging) {
                    dragging = false; view.isPressed = false; actions.drag("end", 0f, 0f); return@setOnTouchListener true
                }
            }
            // A head that is not itself clickable still has to take the press to see it move.
            dragging || (e.actionMasked == android.view.MotionEvent.ACTION_DOWN && !view.isClickable)
        }
    }

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
        // ---- fill both forms' fields (in place); text that changed fades ----
        compactAvatar.face = k.face
        // An approval's answer shows on its capsule (renderIsland: approved / denied / expired).
        var label = k.label ?: next.activity.ifBlank { "在忙" }; var tone = k.tone; var mark = k.mark
        when (next.approval) {
            "approved" -> { label = "已批准"; tone = IslandTokens.COLOR_DONE; mark = IslandIndicator.Mark.CHECK }
            "denied", "expired" -> { label = if (next.approval == "denied") "已拒绝" else "审批已过期"; tone = IslandTokens.COLOR_OFFLINE; mark = IslandIndicator.Mark.OFF }
        }
        compactLabel.set(label, !reform)
        compactTime.visibility = if (k.run || next.kind == "stale") View.VISIBLE else View.GONE
        compactTime.text = clock(next.elapsedSec, short = true)
        compactMark.reduceMotion = reduceMotion; compactMark.set(mark, tone)
        cardAvatar.face = k.face
        titleDot.tone = k.tone; titleDot.pulsing = tone == IslandTokens.COLOR_NEEDS_YOU && !reduceMotion
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
            // The whole reply, in a card at most half the screen tall that scrolls (not the reference's four lines and
            // "展开全文": the island is never unfolded into a reader).
            body.set(next.body, !reform)
            quote.visibility = if (next.quote.isNotBlank()) View.VISIBLE else View.GONE
            quote.text = next.quote
            val approval = next.kind == "approval"
            // An approval's full original, to check exactly what would be sent.
            more.visibility = if (approval) View.VISIBLE else View.GONE
            more.text = if (next.showOriginal) "收起原文" else "查看完整原文"
        }
        if (next.options != shownOptions) {
            shownOptions = next.options; options.removeAllViews()
            next.options.forEachIndexed { i, o -> options.addView(option(o, i), ViewGroup.LayoutParams(-2, px(IslandSpec.OPTION_HEIGHT))) }
        }
        options.visibility = if (next.kind == "ask" && next.options.isNotEmpty()) View.VISIBLE else View.GONE
        for (i in 0 until options.childCount) usable(options.getChildAt(i), next.interactive && next.actionable)
        approvalRow.visibility = if (next.approval == "pending") View.VISIBLE else View.GONE
        usable(allowButton, next.interactive && next.actionable); usable(denyButton, next.interactive && next.actionable)
        approved.visibility = if (next.approval == "approved") View.VISIBLE else View.GONE
        apFinal.visibility = if (next.approval == "denied" || next.approval == "expired") View.VISIBLE else View.GONE
        apFinal.text = if (next.approval == "denied") "已拒绝 · 这一步不会执行" else "已过期 · 未执行，需要时让 Ash 重新申请"
        primary.visibility = if (next.kind == "in_app") View.VISIBLE else View.GONE
        original.visibility = if (next.showOriginal && next.original.isNotEmpty()) View.VISIBLE else View.GONE
        original.text = next.original
        status.visibility = if (next.status.isNotEmpty()) View.VISIBLE else View.GONE
        status.text = next.status
        pager.visibility = if (next.pager.isNotEmpty()) View.VISIBLE else View.GONE
        pagerText.text = next.pager
        notice.visibility = if (next.notice.isNotEmpty()) View.VISIBLE else View.GONE
        notice.text = next.notice
        stopLink.visibility = if (k.run && next.canStop) View.VISIBLE else View.GONE
        usable(stopLink, next.interactive)
        input.isEnabled = !next.busy; usable(sendButton, !next.busy)
        input.hint = next.placeholder
        // The shell is always laid out as tall as this content's card, so opening it lays nothing out.
        cardHeightPx = targetSize("card").second
        // The card is laid out at its own height whatever the island's size this frame: a transition clips it, never
        // reflows it.
        (card.layoutParams as? FrameLayout.LayoutParams)?.takeIf { it.height != cardHeightPx }?.let { it.height = cardHeightPx; card.layoutParams = it }
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
        card.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(maxCardPx, View.MeasureSpec.AT_MOST))
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
        val fly = px(IslandTokens.AVATAR_CARD_SIZE)
        flyFrom.pivotX = 0f; flyFrom.pivotY = 0f; flyTo.pivotX = 0f; flyTo.pivotY = 0f
        overlay.addView(flyFrom, FrameLayout.LayoutParams(fly, fly)); overlay.addView(flyTo, FrameLayout.LayoutParams(fly, fly))
        overlay.visibility = View.GONE
    }
    /** The avatar's box (left, top, size) in each form, in px from the shell's corner (reference layout). */
    private fun avatarBox(form: String): FloatArray = if (form == "card") {
        val p = IslandTokens.SIZE_CARD_PADDING
        // .card-head centres a 40dp avatar on its 44dp row (the collapse button sets the row's height).
        floatArrayOf(p[3] * d, p[0] * d + (IslandSpec.ICON_BUTTON - IslandTokens.AVATAR_CARD_SIZE) / 2 * d, IslandTokens.AVATAR_CARD_SIZE * d)
    } else floatArrayOf(IslandSpec.COMPACT_PAD_LEFT * d, (IslandTokens.SIZE_COMPACT_H - IslandTokens.AVATAR_COMPACT) / 2 * d, IslandTokens.AVATAR_COMPACT * d)
    /** The flying face is the card's 40dp avatar, scaled: its corners stay 14dp on screen, a circle at the capsule's size. */
    private fun placeFly(view: IslandAvatar, box: FloatArray) {
        val s = box[2] / (IslandTokens.AVATAR_CARD_SIZE * d)
        view.scaleX = s; view.scaleY = s
        view.translationX = shell.box.left + box[0]; view.translationY = box[1]
        view.cornerDp = IslandTokens.AVATAR_CARD_RADIUS / s
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
        if (heightPx == 0 || reduceMotion || w != widthPx) { widthPx = w; heightPx = h; apply(w, h, radiusPx(form)); return }
        if (h == heightPx) return
        val from = heightPx
        springTo(IslandMotion.RESIZE_STIFFNESS, IslandMotion.RESIZE_DAMPING) { t -> heightPx = Math.round(from + (h - from) * t); apply(widthPx, heightPx, shell.radius) }
    }

    private fun springTo(stiffness: Float, damping: Float, onEnd: () -> Unit = {}, step: (Float) -> Unit) {
        spring?.cancel(); animating = false
        spring = SpringAnimation(FloatValueHolder(0f)).apply {
            spring = SpringForce(1f).setStiffness(stiffness).setDampingRatio(damping)
            setMinimumVisibleChange(DynamicAnimation.MIN_VISIBLE_CHANGE_SCALE)
            addUpdateListener { _, value, _ ->
                if (traceMotion) android.util.Log.i("ash.island.motion", "t=${android.os.SystemClock.uptimeMillis()} v=$value")
                step(value)
            }
            addEndListener { _, canceled, _, _ -> if (!canceled) { animating = false; step(1f); onEnd() } }
            animating = true
            start()
        }
    }

    private fun morphTo(next: String) {
        val from = form; form = next
        val (toW, toH) = targetSize(next)
        val incoming = content(next); val outgoing = if (from.isEmpty()) null else content(from)
        spring?.cancel(); fades?.cancel()
        settle(incoming); incoming.visibility = View.VISIBLE
        if (outgoing == null) { widthPx = toW; heightPx = toH; apply(toW, toH, radiusPx(next)); return }
        if (reduceMotion) {
            // Reduce motion: the island takes its new size at once and its content cross-fades.
            widthPx = toW; heightPx = toH; apply(toW, toH, radiusPx(next))
            incoming.alpha = 0f
            fades = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = IslandMotion.REDUCED_FADE_MS
                addUpdateListener { incoming.alpha = it.animatedValue as Float; outgoing.alpha = 1f - incoming.alpha }
                addListener(object : AnimatorListenerAdapter() { override fun onAnimationEnd(animation: Animator) { if (form == next) outgoing.visibility = View.INVISIBLE; outgoing.alpha = 1f } })
                start()
            }
            return
        }
        // Each side is drawn once into a layer and then only moved, scaled and faded (Android's advice for animating
        // views whose content does not change).
        incoming.setLayerType(View.LAYER_TYPE_HARDWARE, null); outgoing.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        // Shared avatar: hide the two in place, fly one face between their boxes.
        val a = avatarBox(from); val b = avatarBox(next)
        flyFrom.face = (avatarOf(from) as IslandAvatar).face; flyTo.face = (avatarOf(next) as IslandAvatar).face
        compactAvatar.alpha = 0f; cardAvatar.alpha = 0f
        overlay.visibility = View.VISIBLE; overlay.bringToFront()
        val fromW = widthPx; val fromH = heightPx; val fromR = shell.radius; val toR = radiusPx(next)
        val opening = next == "card"
        springTo(if (opening) IslandMotion.OPEN_STIFFNESS else IslandMotion.CLOSE_STIFFNESS,
            if (opening) IslandMotion.OPEN_DAMPING else IslandMotion.CLOSE_DAMPING,
            onEnd = {
                compact.setLayerType(View.LAYER_TYPE_NONE, null); card.setLayerType(View.LAYER_TYPE_NONE, null)
                overlay.visibility = View.GONE; compactAvatar.alpha = 1f; cardAvatar.alpha = 1f
                if (form == next) { outgoing.visibility = View.INVISIBLE; settle(outgoing) }
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

    /**
     * One frame: the island's box is [w] x [h]. The shell keeps one size (the card's width, the tallest height it may
     * need), so this only redraws; it is laid out again only when the card grows past it.
     */
    private fun apply(w: Int, h: Int, radius: Float) {
        val lp = shell.layoutParams
        val shellW = px(cardWidthDp); val shellH = maxOf(cardHeightPx, px(IslandTokens.SIZE_COMPACT_H), h)
        if (lp != null && (lp.width != shellW || lp.height < shellH || (!animating && lp.height != shellH))) { lp.width = shellW; lp.height = shellH; shell.layoutParams = lp }
        shell.setBox(w, h, radius, shellW)
        val left = shell.box.left.toFloat()
        compact.translationX = left; card.translationX = left
        onFrame(w, h)
    }
}
