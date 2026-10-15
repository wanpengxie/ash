package ai.ash.ui.design

import android.animation.ValueAnimator
import android.content.Context
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Outline
import android.graphics.Path
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.SweepGradient
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.provider.Settings
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.style.LineHeightSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Ash 主 App 的原生组件（无 Compose、无 XML 布局，和现有 shell 一样用代码拼 View）。
 * 每个函数对应设计稿「设计系统 · 组件」里的一个组件；尺寸、颜色、圆角、字号全部来自 [AshTokens]，不要在页面里写死数值。
 * 网页端的同名组件在 packages/web 的 ash.css 里，两边一一对应（见 design/app/HANDOFF.md 的对照表）。
 */
object AshUi {
    // ---------- basics ----------
    fun night(ctx: Context) = (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    fun p(ctx: Context): AshPalette = AshTokens.palette(night(ctx))
    fun dp(ctx: Context, v: Float): Int = (v * ctx.resources.displayMetrics.density + 0.5f).toInt()
    fun dp(ctx: Context, v: Int): Int = dp(ctx, v.toFloat())
    fun dpF(ctx: Context, v: Float): Float = v * ctx.resources.displayMetrics.density
    /** 系统「动画缩放」为 0 时，所有循环动画（呼吸、光环、转圈）都不跑。 */
    fun motionOn(ctx: Context) = Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f

    fun color(ctx: Context, role: Role): Int = p(ctx).let {
        when (role) { Role.INK -> it.ink; Role.TEXT -> it.text; Role.TEXT_2 -> it.text2; Role.TEXT_3 -> it.text3 }
    }

    private fun weighted(weight: Int): Typeface =
        if (Build.VERSION.SDK_INT >= 28) Typeface.create(Typeface.DEFAULT, weight.coerceAtMost(900).let { if (it == 650) 600 else it }, false)
        else if (weight >= 600) Typeface.DEFAULT_BOLD else Typeface.DEFAULT

    /** 按字号阶梯设好一个 TextView：字号、行高、字重、默认颜色；数字等宽。 */
    fun style(tv: TextView, type: AshType, color: Int? = null): TextView = tv.apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, type.sizeSp)
        typeface = weighted(type.weight)
        includeFontPadding = false
        val linePx = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, type.lineSp, resources.displayMetrics)
        // The add-on is only a stand-in for text set some other way; [text] sets the exact line height itself.
        if (Build.VERSION.SDK_INT >= 28) lineHeight = linePx.toInt()
        else setLineSpacing(linePx - paint.fontMetricsInt.let { it.descent - it.ascent }, 1f)
        fontFeatureSettings = "tnum"
        setTextColor(color ?: type.role?.let { color(context, it) } ?: p(context).text)
    }

    /**
     * A line of exactly [heightPx], the room above and below equal (also under the last line). The line-spacing add-on counts the
     * Latin font's height, so a phone that draws Chinese in another font got taller lines and a last line without its share.
     */
    private class ExactLine(private val heightPx: Int) : LineHeightSpan {
        override fun chooseHeight(text: CharSequence?, start: Int, end: Int, spanstartv: Int, lineHeight: Int, fm: Paint.FontMetricsInt) {
            val extra = heightPx - (fm.descent - fm.ascent)
            fm.ascent -= extra / 2; fm.descent += extra - extra / 2
            fm.top = fm.ascent; fm.bottom = fm.descent
        }
    }

    /** [s] with the style's exact line height. (`setLineHeight` of 34+ was measured too and still gave taller lines under a CJK fallback font.) */
    private fun exactLines(tv: TextView, s: CharSequence, type: AshType): CharSequence {
        if (s.isEmpty()) return s
        tv.setLineSpacing(0f, 1f)
        val px = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, type.lineSp, tv.resources.displayMetrics).toInt()
        return SpannableStringBuilder(s).apply { setSpan(ExactLine(px), 0, length, Spanned.SPAN_INCLUSIVE_INCLUSIVE) }
    }

    fun text(ctx: Context, s: CharSequence, type: AshType = AshTokens.Type.body, color: Int? = null, maxLines: Int = Int.MAX_VALUE) =
        style(TextView(ctx), type, color).apply {
            text = exactLines(this, s, type)
            if (maxLines != Int.MAX_VALUE) { this.maxLines = maxLines; ellipsize = TextUtils.TruncateAt.END }
        }

    fun rounded(fill: Int, radiusPx: Float, stroke: Int? = null, strokePx: Int = 0) = GradientDrawable().apply {
        setColor(fill); cornerRadius = radiusPx
        if (stroke != null && strokePx > 0) setStroke(strokePx, stroke)
    }

    private fun ripple(ctx: Context, content: Drawable, mask: Drawable): Drawable =
        RippleDrawable(ColorStateList.valueOf(withAlpha(p(ctx).ink, 0.08f)), content, mask)

    fun withAlpha(c: Int, a: Float) = Color.argb((a * 255).toInt(), Color.red(c), Color.green(c), Color.blue(c))

    /** 亮色卡片的暖色阴影；暗色不用阴影（靠更亮一层的底色分层）。 */
    fun cardShadow(v: View, elevationDp: Float = 1f) {
        if (night(v.context)) { v.elevation = 0f; return }
        v.elevation = dpF(v.context, elevationDp)
        if (Build.VERSION.SDK_INT >= 28) { v.outlineAmbientShadowColor = 0x33784628; v.outlineSpotShadowColor = 0x33784628 }
    }

    fun vstack(ctx: Context, gapDp: Int = 0) = LinearLayout(ctx).apply {
        orientation = LinearLayout.VERTICAL
        if (gapDp > 0) { showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE; dividerDrawable = spacer(ctx, 0, gapDp) }
    }
    fun hstack(ctx: Context, gapDp: Int = 0) = LinearLayout(ctx).apply {
        orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
        if (gapDp > 0) { showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE; dividerDrawable = spacer(ctx, gapDp, 0) }
    }
    private fun spacer(ctx: Context, w: Int, h: Int) = GradientDrawable().apply { setSize(dp(ctx, w), dp(ctx, h)); setColor(Color.TRANSPARENT) }

    // ---------- buttons ----------
    enum class Kind { PRIMARY, SECONDARY, NEUTRAL, DANGER, GHOST }
    enum class BtnSize(val heightDp: Int, val padXDp: Int) { SM(AshTokens.Size.buttonSm, 14), MD(AshTokens.Size.button, 20), LG(AshTokens.Size.buttonLg, 24) }

    /**
     * 全圆角胶囊按钮。一屏只有一个 PRIMARY（珊瑚橙）。DANGER 用于删除 / 收回 / 停止，并且要点两次（第二次文案写出后果）。
     */
    fun button(ctx: Context, label: CharSequence, kind: Kind = Kind.PRIMARY, size: BtnSize = BtnSize.MD, block: Boolean = false, onClick: (() -> Unit)? = null): TextView {
        val c = p(ctx)
        val (bg, fg) = when (kind) {
            Kind.PRIMARY -> c.you to c.onYou
            Kind.SECONDARY -> c.youSoft to c.youText
            Kind.NEUTRAL -> c.surface2 to c.ink
            Kind.DANGER -> c.errSoft to c.err
            Kind.GHOST -> Color.TRANSPARENT to c.youText
        }
        val h = dp(ctx, size.heightDp)
        // The pill is drawn at its size; the view around it is at least the 48dp a finger needs (MOBILE-ARCH §5.4).
        val touch = maxOf(h, dp(ctx, AshTokens.Size.touch))
        val inset = (touch - h) / 2
        val pill = { color: Int -> android.graphics.drawable.InsetDrawable(rounded(color, h / 2f), 0, inset, 0, inset) }
        return style(TextView(ctx), if (size == BtnSize.SM) AshTokens.Type.buttonSm else AshTokens.Type.button, fg).apply {
            text = label; gravity = Gravity.CENTER; isClickable = true; isFocusable = true
            // A long label or a large system font wraps to a second line (the button grows); it is never shrunk below its size.
            maxLines = 2; ellipsize = android.text.TextUtils.TruncateAt.END
            minHeight = touch; minimumHeight = touch
            setPadding(dp(ctx, size.padXDp), inset, dp(ctx, size.padXDp), inset)
            background = ripple(ctx, pill(bg), pill(Color.WHITE))
            layoutParams = ViewGroup.LayoutParams(if (block) ViewGroup.LayoutParams.MATCH_PARENT else ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            role(this, android.widget.Button::class.java.name)
            onClick?.let { f -> setOnClickListener { f() } }
        }
    }

    /**
     * What TalkBack and a keyboard hear a drawn control is (MOBILE-ARCH §5.5): a button, a switch… [state] is said after it
     * (「已开启」, 「处理中」), when given.
     */
    fun role(v: View, className: String, state: (() -> CharSequence?)? = null) {
        v.accessibilityDelegate = object : View.AccessibilityDelegate() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: android.view.accessibility.AccessibilityNodeInfo) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                info.className = className
                state?.invoke()?.let { if (Build.VERSION.SDK_INT >= 30) info.stateDescription = it }
            }
        }
    }

    /** 不可点的状态（例如「正在保存…」）：40% 透明，不响应。 */
    fun disable(v: View) { v.isEnabled = false; v.alpha = 0.4f }

    /** 48dp 的圆形图标按钮（顶栏、卡片右上角）。icon 用项目里的线条图标（24 网格，1.8 线宽）。 */
    fun iconButton(ctx: Context, icon: Drawable, description: String, filled: Boolean = false, onClick: () -> Unit) =
        FrameLayout(ctx).apply {
            val s = dp(ctx, AshTokens.Size.iconButton)
            layoutParams = ViewGroup.LayoutParams(s, s)
            contentDescription = description; isClickable = true; isFocusable = true
            role(this, android.widget.Button::class.java.name)
            background = ripple(ctx, rounded(if (filled) p(ctx).surface2 else Color.TRANSPARENT, s / 2f), rounded(Color.WHITE, s / 2f))
            addView(View(ctx).apply { background = icon.mutate().apply { setTint(p(ctx).text) } },
                FrameLayout.LayoutParams(dp(ctx, AshTokens.Size.icon), dp(ctx, AshTokens.Size.icon), Gravity.CENTER))
            setOnClickListener { onClick() }
        }

    // ---------- cards / lists ----------
    /** 消息里的卡片和页面里的卡片：卡面色、圆角 22、1dp 描边、亮色带暖阴影。 */
    fun card(ctx: Context, gapDp: Int = 10): LinearLayout = vstack(ctx, gapDp).apply {
        val c = p(ctx)
        background = rounded(c.surface, dpF(ctx, AshTokens.Radius.card.toFloat()), c.line, dp(ctx, 1))
        setPadding(dp(ctx, 14), dp(ctx, 14), dp(ctx, 14), dp(ctx, 12))
        cardShadow(this)
    }

    /** 卡片头：小图标块 + 一行语气（「需要你确认」「她问你」「没做成」「需要授权」）+ 右侧注脚。 */
    enum class Tone { HER, WARN, ERR, YOU, OK, MUTE }
    fun toneColors(ctx: Context, tone: Tone): Pair<Int, Int> = p(ctx).let {
        when (tone) {
            Tone.HER -> it.herSoft to it.her; Tone.WARN -> it.warnSoft to it.warn; Tone.ERR -> it.errSoft to it.err
            Tone.YOU -> it.youSoft to it.youText; Tone.OK -> it.okSoft to it.ok; Tone.MUTE -> it.surface2 to it.text2
        }
    }
    fun cardHeader(ctx: Context, tone: Tone, icon: Drawable, label: String, trailing: String? = null): LinearLayout = hstack(ctx, 8).apply {
        val (soft, strong) = toneColors(ctx, tone)
        addView(FrameLayout(ctx).apply {
            background = rounded(soft, dpF(ctx, 8f))
            addView(View(ctx).apply { background = icon.mutate().apply { setTint(strong) } }, FrameLayout.LayoutParams(dp(ctx, 16), dp(ctx, 16), Gravity.CENTER))
        }, LinearLayout.LayoutParams(dp(ctx, 24), dp(ctx, 24)))
        addView(text(ctx, label, AshType(12.5f, 16f, 600, null), strong), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        trailing?.let { addView(text(ctx, it, AshTokens.Type.caption)) }
    }

    /** 分组列表的组：组名（13 号次要文字）+ 圆角 20 的白底列表。行之间的分隔线从图标右侧开始（54dp）。 */
    fun group(ctx: Context, title: String? = null, footer: String? = null, rows: List<View>, iconInset: Boolean = true): LinearLayout = vstack(ctx, 8).apply {
        title?.let { addView(text(ctx, it, AshTokens.Type.sub).apply { setPadding(dp(ctx, 6), 0, dp(ctx, 6), 0) }) }
        val list = vstack(ctx).apply {
            background = rounded(p(ctx).surface, dpF(ctx, AshTokens.Radius.lg.toFloat())); clipToOutline = true; cardShadow(this)
            rows.forEachIndexed { i, row ->
                if (i > 0) addView(View(ctx).apply { setBackgroundColor(p(ctx).line) },
                    LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, maxOf(1, dp(ctx, 0.5f))).apply { marginStart = dp(ctx, if (iconInset) 54 else 14) })
                addView(row)
            }
        }
        addView(list)
        footer?.let { addView(text(ctx, it, AshType(12f, 18f, 400, Role.TEXT_3)).apply { setPadding(dp(ctx, 6), 0, dp(ctx, 6), 0) }) }
    }

    /**
     * 一行：可选的 30dp 图标块 + 标题 + 第二行（写现状，不写功能说明）+ 右侧（值文字 / 标签 / 开关 / 箭头）。
     * subTone 用来把第二行标成琥珀（要处理）或绿色（在线）。
     */
    fun row(ctx: Context, title: CharSequence, sub: CharSequence? = null, icon: Drawable? = null, iconTone: Tone = Tone.MUTE,
            trailing: View? = null, subColor: Int? = null, onClick: (() -> Unit)? = null): LinearLayout = hstack(ctx, 12).apply {
        minimumHeight = dp(ctx, AshTokens.Size.listRow)
        setPadding(dp(ctx, 14), dp(ctx, 8), dp(ctx, 14), dp(ctx, 8))
        icon?.let {
            val (soft, strong) = toneColors(ctx, iconTone)
            addView(FrameLayout(ctx).apply {
                background = rounded(if (iconTone == Tone.MUTE) p(ctx).surface2 else soft, dpF(ctx, AshTokens.Radius.iconTile.toFloat()))
                addView(View(ctx).apply { background = it.mutate().apply { setTint(if (iconTone == Tone.MUTE) p(ctx).text else strong) } },
                    FrameLayout.LayoutParams(dp(ctx, 18), dp(ctx, 18), Gravity.CENTER))
            }, LinearLayout.LayoutParams(dp(ctx, 30), dp(ctx, 30)))
        }
        addView(vstack(ctx, 1).apply {
            addView(text(ctx, title, AshTokens.Type.listTitle))
            sub?.let { addView(text(ctx, it, AshTokens.Type.listSub, subColor, maxLines = 1)) }
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        trailing?.let { addView(it) }
        onClick?.let { f -> isClickable = true; background = ripple(ctx, rounded(Color.TRANSPARENT, 0f), rounded(Color.WHITE, 0f)); setOnClickListener { f() } }
    }

    fun valueText(ctx: Context, s: String) = text(ctx, s, AshType(14f, 20f, 400, Role.TEXT_2))

    /** 小标签：运行中 / 等你批准 / 出错 / 已停用 / 在做事。高 22，全圆角，11.5 号 600。 */
    fun tag(ctx: Context, label: String, tone: Tone, dot: Boolean = false): TextView {
        val (soft, strong) = toneColors(ctx, tone)
        return text(ctx, (if (dot) "● " else "") + label, AshType(11.5f, 14f, 600, null), strong).apply {
            gravity = Gravity.CENTER; setPadding(dp(ctx, 8), 0, dp(ctx, 8), 0); height = dp(ctx, AshTokens.Size.tagH)
            background = rounded(soft, dpF(ctx, 11f))
        }
    }

    /** 选项按钮（选项卡里）。选中后变实心珊瑚并带勾，其它变淡到 40%。 */
    fun option(ctx: Context, label: String, selected: Boolean = false, dimmed: Boolean = false, onClick: (() -> Unit)? = null): TextView {
        val c = p(ctx)
        return text(ctx, if (selected) "✓ $label" else label, AshType(14f, 20f, if (selected) 600 else 400, null), if (selected) c.onYou else c.ink).apply {
            gravity = Gravity.CENTER_VERTICAL; height = dp(ctx, 40); setPadding(dp(ctx, 15), 0, dp(ctx, 15), 0)
            background = if (selected) rounded(c.you, dpF(ctx, 20f)) else rounded(c.surface, dpF(ctx, 20f), c.line2, dp(ctx, 1))
            if (dimmed) alpha = 0.4f
            onClick?.let { f -> isClickable = true; setOnClickListener { f() } }
        }
    }

    /** 卡片答完后的一行结果（「已允许这一次」「已拒绝 · 这一步不会执行」…）。ok=true 用绿色。 */
    fun resolved(ctx: Context, label: String, ok: Boolean = false): TextView {
        val c = p(ctx)
        return text(ctx, if (ok) "✓ $label" else label, AshType(13.5f, 18f, 400, null), if (ok) c.ok else c.text2).apply {
            gravity = Gravity.CENTER; height = dp(ctx, 40); background = rounded(if (ok) c.okSoft else c.surface2, dpF(ctx, 20f))
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(ctx, 40))
        }
    }

    /** 分段控件（性格 / 名片、有影响时才问 / 每次都问）。 */
    fun segmented(ctx: Context, items: List<String>, selected: Int, onSelect: (Int) -> Unit): LinearLayout = hstack(ctx, 2).apply {
        val c = p(ctx)
        background = rounded(c.surface2, dpF(ctx, 14f)); setPadding(dp(ctx, 3), dp(ctx, 3), dp(ctx, 3), dp(ctx, 3))
        items.forEachIndexed { i, s ->
            val on = i == selected
            addView(text(ctx, s, AshType(13.5f, 18f, if (on) 600 else 400, null), if (on) c.ink else c.text2).apply {
                gravity = Gravity.CENTER; isClickable = true; isFocusable = true
                background = if (on) rounded(c.elev, dpF(ctx, 11f)) else null
                if (on) cardShadow(this, 0.5f)
                // A tab to TalkBack, and which one is chosen; at least as tall as a finger needs, taller with a large font.
                isSelected = on
                role(this, "android.widget.RadioButton") { if (on) "已选中" else null }
                minHeight = dp(ctx, AshTokens.Size.touch) - dp(ctx, 6)
                setOnClickListener { onSelect(i) }
            }, LinearLayout.LayoutParams(0, -2, 1f))
        }
    }

    // ---------- conversation pieces ----------
    /** 气泡底：你的（蜜桃，右下角收尖）/ 她的（卡面，左下角收尖）。连续多条的中间那条，上角也收（mid=true）。 */
    fun bubble(ctx: Context, mine: Boolean, mid: Boolean = false): Drawable {
        val c = p(ctx); val r = dpF(ctx, AshTokens.Radius.bubble.toFloat()); val t = dpF(ctx, AshTokens.Radius.bubbleTail.toFloat())
        // top-left, top-right, bottom-right, bottom-left
        val radii = if (mine) floatArrayOf(r, r, if (mid) t else r, if (mid) t else r, t, t, r, r)
                    else floatArrayOf(if (mid) t else r, if (mid) t else r, r, r, r, r, t, t)
        return GradientDrawable().apply { setColor(if (mine) c.bubbleMe else c.bubbleHer); cornerRadii = radii }
    }
    /** The outline the system casts the bubble's shadow from: a drawable with one small corner gives it none of its own. */
    fun bubbleOutline(ctx: Context, mine: Boolean, mid: Boolean = false): ViewOutlineProvider = object : ViewOutlineProvider() {
        override fun getOutline(v: View, outline: Outline) {
            val r = dpF(ctx, AshTokens.Radius.bubble.toFloat()); val t = dpF(ctx, AshTokens.Radius.bubbleTail.toFloat())
            val radii = if (mine) floatArrayOf(r, r, if (mid) t else r, if (mid) t else r, t, t, r, r)
                        else floatArrayOf(if (mid) t else r, if (mid) t else r, r, r, r, r, t, t)
            outline.setConvexPath(Path().apply { addRoundRect(RectF(0f, 0f, v.width.toFloat(), v.height.toFloat()), radii, Path.Direction.CW) })
        }
    }

    fun bubbleText(ctx: Context, s: CharSequence, mine: Boolean, mid: Boolean = false) =
        text(ctx, s, AshTokens.Type.chat, if (mine) p(ctx).onMe else p(ctx).text).apply {
            background = bubble(ctx, mine, mid); setPadding(dp(ctx, 14), dp(ctx, 10), dp(ctx, 14), dp(ctx, 10))
            maxWidth = (ctx.resources.displayMetrics.widthPixels * 0.8f).toInt()
            if (!mine) { cardShadow(this); outlineProvider = bubbleOutline(ctx, mine, mid) }
        }

    /** 输入框上方的小胶囊：「在看网页 · 12 秒」（进行中，带转圈）/「做了 4 步 · 18 秒 · 查看」。 */
    fun progressPill(ctx: Context, verb: String, rest: String, running: Boolean): LinearLayout = hstack(ctx, 7).apply {
        val c = p(ctx)
        background = rounded(c.elev, dpF(ctx, 16f), c.line, dp(ctx, 1)); cardShadow(this)
        setPadding(dp(ctx, 10), 0, dp(ctx, 10), 0); minimumHeight = dp(ctx, 32)
        if (running) addView(Spinner(ctx), LinearLayout.LayoutParams(dp(ctx, 14), dp(ctx, 14)))
        addView(text(ctx, verb, AshType(12.5f, 16f, 600, Role.INK)))
        addView(text(ctx, "· $rest", AshType(12.5f, 16f, 400, Role.TEXT_2)))
    }

    /** 底部抽屉的底：顶部圆角 28，elevation 12。 */
    fun sheetBackground(ctx: Context) = GradientDrawable().apply {
        val r = dpF(ctx, AshTokens.Radius.sheet.toFloat())
        setColor(p(ctx).elev); cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
    }

    // ---------- example composition: the approval card ----------
    /**
     * 审批卡（和灵动岛的卡片同结构）。answer 为 null 时显示三个按钮；答过之后传入结果文字，按钮区收成一行。
     * 文案：「需要你确认」/ 标题「在改剪贴板」/ 一句话说明 / 可选「审核：…」/「查看完整原文」/ 允许这一次 · 以后都允许 · 不允许。
     */
    fun approvalCard(ctx: Context, shield: Drawable, title: String, body: String, review: String?, expires: String?,
                     canAlways: Boolean, answer: Pair<String, Boolean>?, onOriginal: () -> Unit,
                     onOnce: () -> Unit, onAlways: () -> Unit, onDeny: () -> Unit): LinearLayout = card(ctx).apply {
        val c = p(ctx)
        addView(cardHeader(ctx, Tone.WARN, shield, "需要你确认", expires))
        addView(text(ctx, title, AshType(16f, 23f, 600, Role.INK)))
        if (answer == null) {
            addView(text(ctx, body, AshTokens.Type.callout))
            review?.let { addView(text(ctx, it, AshType(13f, 19f, 400, Role.TEXT_2)).apply {
                background = rounded(c.surface2, dpF(ctx, 12f)); setPadding(dp(ctx, 11), dp(ctx, 9), dp(ctx, 11), dp(ctx, 9)) }) }
            addView(text(ctx, "查看完整原文 ›", AshType(13f, 18f, 400, null), c.youText).apply { minHeight = dp(ctx, 28); gravity = Gravity.CENTER_VERTICAL; setOnClickListener { onOriginal() } })
            addView(button(ctx, "允许这一次", Kind.PRIMARY, block = true, onClick = onOnce))
            addView(hstack(ctx, 8).apply {
                if (canAlways) addView(button(ctx, "以后都允许", Kind.SECONDARY, onClick = onAlways), LinearLayout.LayoutParams(0, dp(ctx, 44), 1f))
                addView(button(ctx, "不允许", Kind.NEUTRAL, onClick = onDeny), LinearLayout.LayoutParams(0, dp(ctx, 44), 1f))
            })
        } else addView(resolved(ctx, answer.first, answer.second))
    }

    // ---------- custom views ----------
    /** 小转圈：薄荷色弧在淡薄荷轨道上，0.9 秒一圈。 */
    class Spinner(ctx: Context) : View(ctx) {
        private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = p(ctx).herSoft }
        private val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = p(ctx).herFill; strokeCap = Paint.Cap.ROUND }
        private var angle = 0f
        private val anim = ValueAnimator.ofFloat(0f, 360f).apply {
            duration = AshTokens.Motion.spinner; repeatCount = ValueAnimator.INFINITE; interpolator = android.view.animation.LinearInterpolator()
            addUpdateListener { angle = it.animatedValue as Float; invalidate() }
        }
        override fun onAttachedToWindow() { super.onAttachedToWindow(); if (motionOn(context)) anim.start() }
        override fun onDetachedFromWindow() { anim.cancel(); super.onDetachedFromWindow() }
        override fun onDraw(canvas: Canvas) {
            val s = dpF(context, 2f); track.strokeWidth = s; arc.strokeWidth = s
            val r = RectF(s / 2, s / 2, width - s / 2, height - s / 2)
            canvas.drawOval(r, track); canvas.drawArc(r, angle - 90f, 90f, false, arc)
        }
    }

    /**
     * Ash 的头像：圆角方形（32%），状态在外圈表达——
     * ONLINE 右下绿点；THINKING 薄荷外圈呼吸（1.8s）；WORKING 薄荷光环转动（2.4s）；WAITING 琥珀外圈呼吸；OFFLINE 整体 55% + 灰点。
     * 表情图片跟状态换（沿用灵动岛的对应表：在想 thinking，在做事 focused，等你 listening，完成 success，离线 resting）。
     */
    class AvatarView(ctx: Context) : View(ctx) {
        enum class State { ONLINE, THINKING, WORKING, WAITING, OFFLINE, PLAIN }
        var state: State = State.PLAIN; set(v) { field = v; alpha = if (v == State.OFFLINE) 0.55f else 1f; restart(); invalidate() }
        var image: Bitmap? = null; set(v) { field = v; face = null; invalidate() }
        private val imgPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
        // what a frame of the turning ring needs is kept, not built again: the face's shader (until the picture or the size changes)
        // and the ring's sweep, which only has its matrix turned
        private var face: BitmapShader? = null
        private var sweep: SweepGradient? = null
        private val sweepMatrix = Matrix()
        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { face = null; sweep = null }
        private val dot = Paint(Paint.ANTI_ALIAS_FLAG)
        private var t = 0f
        private var anim: ValueAnimator? = null

        private fun restart() {
            anim?.cancel(); anim = null
            if (!isAttachedToWindow || !motionOn(context)) return
            val period = when (state) { State.WORKING -> AshTokens.Motion.ring; State.THINKING -> AshTokens.Motion.breathe; State.WAITING -> 1600L; else -> return }
            anim = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = period; repeatCount = ValueAnimator.INFINITE; interpolator = android.view.animation.LinearInterpolator()
                addUpdateListener { t = it.animatedValue as Float; invalidate() }; start()
            }
        }
        override fun onAttachedToWindow() { super.onAttachedToWindow(); restart() }
        override fun onDetachedFromWindow() { anim?.cancel(); super.onDetachedFromWindow() }

        override fun onDraw(canvas: Canvas) {
            val c = p(context); val inset = dpF(context, 3f)
            val box = RectF(inset, inset, width - inset, height - inset)
            val r = box.width() * AshTokens.Radius.avatarFraction
            // the face is a cut-out: the warm tile shows behind it
            imgPaint.shader = null; imgPaint.color = c.surface2; canvas.drawRoundRect(box, r, r, imgPaint)
            image?.let { bmp ->
                val shader = face ?: BitmapShader(bmp, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).also { made ->
                    val scale = maxOf(box.width() / bmp.width, box.height() / bmp.height)
                    // object-position 50% 18%: keep the face, crop from the top
                    val dy = (box.height() - bmp.height * scale) * 0.18f
                    made.setLocalMatrix(Matrix().apply { setScale(scale, scale); postTranslate(box.left + (box.width() - bmp.width * scale) / 2, box.top + dy) })
                    face = made
                }
                imgPaint.shader = shader; canvas.drawRoundRect(box, r, r, imgPaint)
            }

            val outer = RectF(box.left - inset + dpF(context, 0.8f), box.top - inset + dpF(context, 0.8f), box.right + inset - dpF(context, 0.8f), box.bottom + inset - dpF(context, 0.8f))
            val ro = outer.width() * 0.36f
            ring.strokeWidth = dpF(context, 1.6f)
            when (state) {
                State.WORKING -> {
                    val shader = sweep ?: SweepGradient(outer.centerX(), outer.centerY(), intArrayOf(c.herFill, Color.TRANSPARENT, Color.TRANSPARENT, c.herFill), floatArrayOf(0f, .4f, .6f, 1f)).also { sweep = it }
                    sweepMatrix.setRotate(t * 360f, outer.centerX(), outer.centerY()); shader.setLocalMatrix(sweepMatrix)
                    ring.shader = shader
                    canvas.drawRoundRect(outer, ro, ro, ring); ring.shader = null
                }
                State.THINKING, State.WAITING -> {
                    val a = 0.25f + 0.75f * (0.5f - 0.5f * Math.cos(t * 2 * Math.PI).toFloat())
                    ring.color = withAlpha(if (state == State.WAITING) c.warnFill else c.herFill, a); canvas.drawRoundRect(outer, ro, ro, ring)
                }
                State.ONLINE, State.OFFLINE -> {
                    // 11dp dot with a 2.5dp ring of the page colour, sitting 2dp outside the avatar's bottom-right corner
                    val d = dpF(context, 11f); val edge = dpF(context, 2f)
                    val cx = box.right + edge - d / 2; val cy = box.bottom + edge - d / 2
                    dot.color = c.bg; canvas.drawCircle(cx, cy, d / 2, dot)
                    dot.color = if (state == State.ONLINE) c.okFill else c.text3; canvas.drawCircle(cx, cy, d / 2 - dpF(context, 2.5f), dot)
                }
                State.PLAIN -> Unit
            }
        }
    }

    /**
     * A helper agent's face: a rounded square (the avatar's 32%), its first character in white at weight 650, on one of the six
     * helper colours picked by its name ([AshLetter]). Ash herself always uses her picture ([AvatarView]), never this.
     */
    class LetterAvatarView(ctx: Context, name: String?) : View(ctx) {
        private val letter = AshLetter.letterOf(name)
        private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = AshLetter.color(p(ctx), name) }
        private val glyph = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = p(ctx).onHelper; typeface = weighted(AshTokens.Type.button.weight); textAlign = Paint.Align.CENTER }
        init { contentDescription = null; importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
        override fun onDraw(canvas: Canvas) {
            val side = minOf(width, height).toFloat()
            val r = side * AshTokens.Radius.avatarFraction
            val box = RectF((width - side) / 2f, (height - side) / 2f, (width + side) / 2f, (height + side) / 2f)
            canvas.drawRoundRect(box, r, r, fill)
            glyph.textSize = side * 0.45f
            val m = glyph.fontMetrics
            canvas.drawText(letter, box.centerX(), box.centerY() - (m.ascent + m.descent) / 2f, glyph)
        }
    }

    /** A [LetterAvatarView] [sizeDp] on a side. */
    fun letterAvatar(ctx: Context, name: String?, sizeDp: Int = AshTokens.Size.avatarPage): LetterAvatarView =
        LetterAvatarView(ctx, name).apply { layoutParams = ViewGroup.LayoutParams(dp(ctx, sizeDp), dp(ctx, sizeDp)) }

    /**
     * Her face in a round frame with a ring of light around it (the first-launch guide: download progress, how many things are on).
     * [progress] of the ring is lit, from the top, clockwise; [spinning] lights a short arc that goes round instead (not when the
     * system's animations are off). [boxDp] is the view's side, [radiusDp] the ring's radius, [avatarDp] the face's diameter.
     */
    class RingAvatar(ctx: Context, private val boxDp: Int, private val radiusDp: Int, private val avatarDp: Int = 120, private val strokeDp: Float = 5f) : View(ctx) {
        var image: Bitmap? = null; set(v) { field = v; face = null; invalidate() }
        var progress = 0f; private set
        var spinning = false; set(v) { field = v; restart(); invalidate() }
        private val c = p(ctx)
        private val track = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = c.surface3 }
        private val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; color = c.herFill; strokeCap = Paint.Cap.ROUND }
        private val img = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
        private var turn = 0f
        private var face: BitmapShader? = null   // built once per picture and size, not once per frame of the turning arc
        private var spin: ValueAnimator? = null
        private var grow: ValueAnimator? = null

        /** Moves the lit part of the ring to [to] (0..1), smoothly when animations are on. */
        fun setProgress(to: Float, animate: Boolean = true) {
            val target = to.coerceIn(0f, 1f)
            grow?.cancel()
            if (!animate || !motionOn(context) || !isAttachedToWindow) { progress = target; invalidate(); return }
            grow = ValueAnimator.ofFloat(progress, target).apply {
                duration = AshTokens.Motion.cardResolve; interpolator = AshTokens.Motion.easing()
                addUpdateListener { progress = it.animatedValue as Float; invalidate() }; start()
            }
        }

        private fun restart() {
            spin?.cancel(); spin = null
            if (!spinning || !isAttachedToWindow || !motionOn(context)) return
            spin = ValueAnimator.ofFloat(0f, 360f).apply {
                duration = AshTokens.Motion.ring; repeatCount = ValueAnimator.INFINITE; interpolator = android.view.animation.LinearInterpolator()
                addUpdateListener { turn = it.animatedValue as Float; invalidate() }; start()
            }
        }

        override fun onAttachedToWindow() { super.onAttachedToWindow(); restart() }
        override fun onDetachedFromWindow() { spin?.cancel(); grow?.cancel(); super.onDetachedFromWindow() }
        override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(dp(context, boxDp), dp(context, boxDp))
        override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { face = null }

        override fun onDraw(canvas: Canvas) {
            val cx = width / 2f; val cy = height / 2f
            val stroke = dpF(context, strokeDp)
            track.strokeWidth = stroke; arc.strokeWidth = stroke
            val r = dpF(context, radiusDp.toFloat())
            val oval = RectF(cx - r, cy - r, cx + r, cy + r)
            canvas.drawOval(oval, track)
            when {
                spinning -> canvas.drawArc(oval, turn - 90f, 100f, false, arc)
                progress > 0f -> canvas.drawArc(oval, -90f, 360f * progress, false, arc)
            }
            val a = dpF(context, avatarDp / 2f)
            val box = RectF(cx - a, cy - a, cx + a, cy + a)
            img.shader = null; img.color = c.surface2; canvas.drawCircle(cx, cy, a, img)
            val bmp = image ?: return
            img.shader = face ?: BitmapShader(bmp, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).also { made ->
                val scale = maxOf(box.width() / bmp.width, box.height() / bmp.height)
                // object-position 50% 18%, as everywhere she is drawn: keep the face, crop from the top
                val dy = (box.height() - bmp.height * scale) * 0.18f
                made.setLocalMatrix(Matrix().apply { setScale(scale, scale); postTranslate(box.left + (box.width() - bmp.width * scale) / 2, box.top + dy) })
                face = made
            }
            canvas.drawCircle(cx, cy, a, img)
        }
    }

    /** 开关：46×28，开 = 绿色。150ms 滑动，用岛的曲线。 */
    class AshSwitch(ctx: Context) : View(ctx) {
        var checked = false; private set
        var onChange: ((Boolean) -> Unit)? = null
        private var pos = 0f
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        init {
            isClickable = true; isFocusable = true; setOnClickListener { set(!checked, true) }
            // A switch to TalkBack, saying whether it is on (§5.5).
            role(this, android.widget.Switch::class.java.name) { if (checked) "已开启" else "已关闭" }
        }
        fun set(v: Boolean, animate: Boolean = false) {
            checked = v; onChange?.takeIf { animate }?.invoke(v)
            if (animate && motionOn(context)) ValueAnimator.ofFloat(pos, if (v) 1f else 0f).apply {
                duration = 150; interpolator = AshTokens.Motion.easing(); addUpdateListener { pos = it.animatedValue as Float; invalidate() }; start()
            } else { pos = if (v) 1f else 0f; invalidate() }
        }
        // Drawn 46×28 in the middle of a view at least 48dp each way: a touch anywhere in it counts (§5.4).
        override fun onMeasure(w: Int, h: Int) = setMeasuredDimension(
            maxOf(dp(context, AshTokens.Size.switchW), dp(context, AshTokens.Size.touch)), maxOf(dp(context, AshTokens.Size.switchH), dp(context, AshTokens.Size.touch)))
        override fun onDraw(canvas: Canvas) {
            val c = p(context); val w = dpF(context, AshTokens.Size.switchW.toFloat()); val h = dpF(context, AshTokens.Size.switchH.toFloat())
            canvas.save(); canvas.translate((width - w) / 2, (height - h) / 2)
            paint.color = blend(c.surface3, c.okFill, pos); canvas.drawRoundRect(0f, 0f, w, h, h / 2, h / 2, paint)
            val k = dpF(context, 22f); val m = (h - k) / 2
            paint.color = Color.WHITE; paint.setShadowLayer(dpF(context, 1.5f), 0f, dpF(context, 1f), 0x40000000)
            canvas.drawCircle(m + k / 2 + pos * (w - k - 2 * m), h / 2, k / 2, paint); paint.clearShadowLayer()
            canvas.restore()
        }
        private fun blend(a: Int, b: Int, f: Float) = Color.rgb(
            (Color.red(a) + (Color.red(b) - Color.red(a)) * f).toInt(), (Color.green(a) + (Color.green(b) - Color.green(a)) * f).toInt(), (Color.blue(a) + (Color.blue(b) - Color.blue(a)) * f).toInt())
    }
}
