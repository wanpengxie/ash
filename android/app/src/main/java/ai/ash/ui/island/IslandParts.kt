package ai.ash.ui.island

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.os.Build
import android.view.View
import android.view.ViewOutlineProvider
import android.widget.FrameLayout

/**
 * The island's body: the reference's shadow (`.isl` box-shadow), dark fill and 1px inner stroke, with its children
 * clipped to the same rounded shape (overflow: hidden). The view itself keeps one size (the card's width, and the
 * tallest the island needs); the island's own box inside it is set per frame ([setBox]) and only redraws, so a
 * transition never lays anything out. The box is centred horizontally and starts at the top.
 */
internal class IslandShell(ctx: Context) : FrameLayout(ctx) {
    /** The island's box in this view, in px. */
    val box = android.graphics.Rect()
    var radius = 0f; private set
    fun setBox(w: Int, h: Int, cornerRadius: Float, viewWidth: Int = width) {
        // A corner is never larger than half the box (CSS clamps border-radius the same way).
        val radius = minOf(cornerRadius, w / 2f, h / 2f)
        val left = (viewWidth - w) / 2
        if (box.left == left && box.width() == w && box.height() == h && this.radius == radius) return
        box.set(left, 0, left + w, h); this.radius = radius
        invalidate(); clip.invalidateOutline()
    }
    val clip = object : FrameLayout(ctx) {}.apply {
        clipToOutline = true
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) { outline.setRoundRect(box, radius) }
        }
    }
    private val density = ctx.resources.displayMetrics.density
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = IslandTokens.COLOR_ISLAND }
    // inset 0 0 0 1px rgba(255,255,255,.06): a 1px line just inside the edge.
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = density; color = IslandTokens.COLOR_ISLAND_STROKE }
    private val shadowPaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val rect = RectF()
    // The shadow is blurred once per corner radius, off screen, and drawn as nine slices (as CardView does): a
    // Gaussian blur on every frame of a transition costs more than the rest of the frame.
    private val compactShadow by lazy { IslandShadow(IslandSpec.dp(ctx, IslandTokens.SIZE_COMPACT_RADIUS), density) }
    private val cardShadow by lazy { IslandShadow(IslandSpec.dp(ctx, IslandTokens.SIZE_CARD_RADIUS), density) }
    init {
        setWillNotDraw(false); clipChildren = false; clipToPadding = false
        addView(clip, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }
    override fun onDraw(canvas: Canvas) {
        if (box.isEmpty) return
        // Between the two forms' radii the two shadows cross-fade.
        val a = compactShadow; val b = cardShadow
        val t = ((radius - a.radius) / (b.radius - a.radius)).coerceIn(0f, 1f)
        if (t < 1f) a.draw(canvas, box, radius, ((1 - t) * 255).toInt(), shadowPaint)
        if (t > 0f) b.draw(canvas, box, radius, (t * 255).toInt(), shadowPaint)
        rect.set(box); canvas.drawRoundRect(rect, radius, radius, fill)
        val half = stroke.strokeWidth / 2; rect.inset(half, half)
        canvas.drawRoundRect(rect, (radius - half).coerceAtLeast(0f), (radius - half).coerceAtLeast(0f), stroke)
    }
}

/**
 * The reference's box-shadow layers around a rounded rectangle of corner [radius], rendered once into a bitmap whose
 * middle row and column stretch: corners are drawn as they are, edges stretched along the box. The shape itself is
 * cleared out of it, as a CSS box-shadow is never drawn under its box.
 */
internal class IslandShadow(val radius: Float, density: Float) {
    /** How far the shadow reaches past the box on any side: three sigmas of the widest blur, plus its offset. */
    private val reach: Int
    private val bitmap: Bitmap
    private val corner: Int
    init {
        reach = IslandTokens.SHADOW_LAYERS.maxOf { l -> Math.ceil((3 * l[2] / 2 + Math.abs(l[0]) + Math.abs(l[1])) * density.toDouble()).toInt() }
        corner = reach + Math.ceil(radius.toDouble()).toInt()
        val size = 2 * corner + 1
        bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val shape = RectF(reach.toFloat(), reach.toFloat(), (size - reach).toFloat(), (size - reach).toFloat())
        IslandTokens.SHADOW_LAYERS.forEachIndexed { i, layer ->
            // CSS blur B is a Gaussian of sigma B/2; Android's shadow radius r gives sigma 0.57735r + 0.5.
            val sigma = layer[2] * density / 2f
            val r = ((sigma - 0.5f) / 0.57735f).coerceAtLeast(0.01f)
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = IslandTokens.COLOR_ISLAND; setShadowLayer(r, layer[0] * density, layer[1] * density, IslandTokens.SHADOW_COLORS[i]) }
            canvas.drawRoundRect(shape, radius, radius, paint)
        }
        canvas.drawRoundRect(shape, radius, radius, Paint(Paint.ANTI_ALIAS_FLAG).apply { xfermode = android.graphics.PorterDuffXfermode(android.graphics.PorterDuff.Mode.CLEAR) })
    }
    private val src = android.graphics.Rect(); private val dst = RectF()
    /** Draws the shadow of [box] whose corners have radius [atRadius] (corners scale with it). */
    fun draw(canvas: Canvas, box: android.graphics.Rect, atRadius: Float, alpha: Int, paint: Paint) {
        paint.alpha = alpha
        val c = reach + atRadius
        val xs = floatArrayOf(box.left - reach.toFloat(), box.left - reach + c, box.right + reach - c, box.right + reach.toFloat())
        val ys = floatArrayOf(box.top - reach.toFloat(), box.top - reach + c, box.bottom + reach - c, box.bottom + reach.toFloat())
        val n = bitmap.width
        val sx = intArrayOf(0, corner, corner + 1, n); val sy = sx
        for (i in 0..2) for (j in 0..2) {
            if (i == 1 && j == 1) continue
            if (xs[i + 1] <= xs[i] || ys[j + 1] <= ys[j]) continue
            src.set(sx[i], sy[j], sx[i + 1], sy[j + 1]); dst.set(xs[i], ys[j], xs[i + 1], ys[j + 1])
            canvas.drawBitmap(bitmap, src, dst, paint)
        }
    }
}

/** `.isl-av`: the face, object-fit cover at a vertical focus, on #2A2A2D, clipped to a circle or rounded square. */
internal class IslandAvatar(ctx: Context, private val focusY: Float, cornerDp: Float? = null) : View(ctx) {
    /** Corner radius in dp of this view's own size; null is a circle. */
    var cornerDp: Float? = cornerDp
        set(value) { if (field != value) { field = value; invalidate() } }
    private var bitmap: Bitmap? = null
    var face = ""
        set(value) {
            if (field == value) return
            field = value
            bitmap = faces[value] ?: decode(context, value)
            invalidate()
        }
    companion object {
        /** Decoded once, shared by every avatar: a transition never decodes on the main thread. */
        private val faces = java.util.concurrent.ConcurrentHashMap<String, Bitmap>()
        private val ALL = listOf("default", "focused", "listening", "resting", "success", "thinking")
        private fun decode(ctx: Context, face: String): Bitmap? = runCatching {
            ctx.assets.open("ash-island/avatars/$face.webp").use { BitmapFactory.decodeStream(it) }
        }.getOrNull()?.also { faces[face] = it }
        fun preload(ctx: Context) { Thread({ for (f in ALL) if (!faces.containsKey(f)) decode(ctx, f) }, "ash-island-faces").start() }
    }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val back = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = IslandSpec.AVATAR_BACKGROUND }
    private val matrix = Matrix(); private val clipPath = Path(); private val box = RectF()
    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat(); val h = height.toFloat()
        val r = cornerDp?.let { minOf(IslandSpec.dp(context, it), w / 2) } ?: (w / 2)
        box.set(0f, 0f, w, h); clipPath.reset(); clipPath.addRoundRect(box, r, r, Path.Direction.CW)
        canvas.save(); canvas.clipPath(clipPath)
        canvas.drawRect(box, back)
        bitmap?.let { b ->
            val scale = maxOf(w / b.width, h / b.height)
            // object-position: 50% <focusY> — the overflow is shared at that ratio.
            val dx = (w - b.width * scale) * 0.5f; val dy = (h - b.height * scale) * focusY
            matrix.setScale(scale, scale); matrix.postTranslate(dx, dy)
            canvas.drawBitmap(b, matrix, paint)
        }
        canvas.restore()
    }
}

/**
 * `.card-title .dot`: an 8dp dot in the card's tone; for "needs you" it pulses (`.pulse`: a ring spreading 0 -> 7dp,
 * alpha .55 -> 0, 1.4s ease-out), drawn past the view's bounds (its parents do not clip).
 */
internal class IslandDot(ctx: Context) : View(ctx) {
    var tone = IslandTokens.COLOR_RUNNING
        set(value) {
            if (field == value) return
            // Colours blend rather than switch.
            if (isAttachedToWindow) android.animation.ValueAnimator.ofArgb(field, value).apply {
                duration = IslandMotion.COLOUR_MS; addUpdateListener { shown = it.animatedValue as Int; invalidate() }; start()
            } else shown = value
            field = value
        }
    private var shown = IslandTokens.COLOR_RUNNING
    var pulsing = false
        set(value) { if (field != value) { field = value; if (value && isAttachedToWindow) ticker.start() else ticker.cancel(); invalidate() } }
    private var t = 0L
    private val ticker = android.animation.TimeAnimator().apply { setTimeListener { _, total, _ -> t = total; invalidate() } }
    private val ease = android.view.animation.PathInterpolator(0f, 0f, 0.58f, 1f)
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    override fun onAttachedToWindow() { super.onAttachedToWindow(); if (pulsing) ticker.start() }
    override fun onDetachedFromWindow() { ticker.cancel(); super.onDetachedFromWindow() }
    override fun onDraw(canvas: Canvas) {
        val r = width / 2f
        if (pulsing) {
            val p = ease.getInterpolation((t % IslandTokens.MOTION_PULSE_MS).toFloat() / IslandTokens.MOTION_PULSE_MS)
            paint.color = shown; paint.alpha = (0.55f * (1 - p) * 255).toInt()
            canvas.drawCircle(r, r, r + IslandSpec.dp(context, 7f) * p, paint)
        }
        paint.color = shown; paint.alpha = 255; canvas.drawCircle(r, r, r, paint)
    }
}

/** The reference's 24-unit stroke icons: collapse chevron, send arrow, pager chevrons, the approved tick. */
internal class IslandIcon(ctx: Context, private val kind: Kind, private val glyphDp: Float = 18f) : View(ctx) {
    enum class Kind { UP, SEND, PREV, NEXT, TICK }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; strokeWidth = if (kind == Kind.TICK) 2.6f else 2.2f }
    private val path = Path()
    var ink = IslandSpec.ICON_BUTTON_INK
        set(value) { field = value; invalidate() }
    override fun onDraw(canvas: Canvas) {
        // The glyph centred in the view, drawn in its 24-unit viewBox.
        val size = IslandSpec.dp(context, glyphDp)
        canvas.save(); canvas.translate((width - size) / 2, (height - size) / 2); canvas.scale(size / 24f, size / 24f)
        paint.color = ink; path.reset()
        when (kind) {
            Kind.UP -> { path.moveTo(6f, 15f); path.lineTo(12f, 9f); path.lineTo(18f, 15f) }
            Kind.SEND -> { path.moveTo(12f, 19f); path.lineTo(12f, 5f); path.moveTo(6f, 11f); path.lineTo(12f, 5f); path.lineTo(18f, 11f) }
            Kind.PREV -> { path.moveTo(15f, 6f); path.lineTo(9f, 12f); path.lineTo(15f, 18f) }
            Kind.NEXT -> { path.moveTo(9f, 6f); path.lineTo(15f, 12f); path.lineTo(9f, 18f) }
            Kind.TICK -> { path.moveTo(5f, 12.5f); path.lineTo(9.5f, 17f); path.lineTo(19f, 7.5f) }
        }
        canvas.drawPath(path, paint); canvas.restore()
    }
}

/** A filled rounded rectangle, for buttons, blocks and the input (`border-radius` + background, and a border inside). */
internal class RoundedBackground(private val color: Int, private val radiusPx: Float, private val strokeColor: Int = 0, private val strokePx: Float = 0f) : android.graphics.drawable.Drawable() {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = this@RoundedBackground.color }
    private val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = strokePx; this.color = strokeColor }
    private val box = RectF()
    override fun draw(canvas: Canvas) {
        box.set(bounds); canvas.drawRoundRect(box, radiusPx, radiusPx, paint)
        if (strokePx > 0f) { val half = strokePx / 2; box.inset(half, half); canvas.drawRoundRect(box, radiusPx - half, radiusPx - half, edge) }
    }
    override fun setAlpha(alpha: Int) { paint.alpha = alpha; edge.alpha = alpha }
    override fun setColorFilter(colorFilter: android.graphics.ColorFilter?) { paint.colorFilter = colorFilter; edge.colorFilter = colorFilter }
    @Deprecated("Deprecated in Java") override fun getOpacity() = android.graphics.PixelFormat.TRANSLUCENT
}

/** `display: flex; flex-wrap: wrap; gap`: children in rows, wrapping at the width. */
internal class IslandWrap(ctx: Context, private val gapPx: Int) : android.view.ViewGroup(ctx) {
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val max = MeasureSpec.getSize(widthMeasureSpec)
        var x = 0; var y = 0; var row = 0
        for (i in 0 until childCount) {
            val c = getChildAt(i); if (c.visibility == GONE) continue
            c.measure(MeasureSpec.makeMeasureSpec(max, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(c.layoutParams.height, MeasureSpec.EXACTLY))
            if (x > 0 && x + c.measuredWidth > max) { x = 0; y += row + gapPx; row = 0 }
            x += c.measuredWidth + gapPx; row = maxOf(row, c.measuredHeight)
        }
        setMeasuredDimension(max, if (childCount == 0) 0 else y + row)
    }
    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val max = r - l
        var x = 0; var y = 0; var row = 0
        for (i in 0 until childCount) {
            val c = getChildAt(i); if (c.visibility == GONE) continue
            if (x > 0 && x + c.measuredWidth > max) { x = 0; y += row + gapPx; row = 0 }
            c.layout(x, y, x + c.measuredWidth, y + c.measuredHeight)
            x += c.measuredWidth + gapPx; row = maxOf(row, c.measuredHeight)
        }
    }
}

/** A gap of [px] between a linear layout's shown children (CSS `gap`): gone children take neither room nor gap. */
internal fun gap(px: Int) = android.graphics.drawable.ShapeDrawable().apply { intrinsicHeight = px; intrinsicWidth = px; paint.color = 0 }

/**
 * Text that changes by cross-fading (the framework's TextSwitcher): the old words fade out while the new fade in, so
 * a changed label is never blank for a frame. [style] sets up both of its text views alike.
 */
internal class FadeText(ctx: Context, private val style: (android.widget.TextView) -> Unit) : android.widget.TextSwitcher(ctx) {
    init {
        setFactory { android.widget.TextView(ctx).also(style) }
        measureAllChildren = false
        inAnimation = android.view.animation.AlphaAnimation(0f, 1f).apply { duration = IslandMotion.TEXT_IN_MS; startOffset = IslandMotion.TEXT_IN_DELAY_MS }
        outAnimation = android.view.animation.AlphaAnimation(1f, 0f).apply { duration = IslandMotion.TEXT_OUT_MS }
    }
    val current: android.widget.TextView get() = currentView as android.widget.TextView
    val text: String get() = current.text.toString()
    /** Shows [value], cross-fading from the old text when [animate]. */
    fun set(value: String, animate: Boolean) {
        if (text == value) return
        if (animate) setText(value) else setCurrentText(value)
    }
    fun each(action: (android.widget.TextView) -> Unit) { for (i in 0 until childCount) action(getChildAt(i) as android.widget.TextView) }
}
