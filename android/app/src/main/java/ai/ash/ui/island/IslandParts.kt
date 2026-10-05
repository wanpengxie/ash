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
 * clipped to the same rounded shape (overflow: hidden). Width, height and radius are set per frame by the morph.
 */
internal class IslandShell(ctx: Context) : FrameLayout(ctx) {
    var radius = 0f
        set(value) { if (field != value) { field = value; invalidate(); clip.invalidateOutline() } }
    val clip = object : FrameLayout(ctx) {}.apply {
        clipToOutline = true
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) { outline.setRoundRect(0, 0, view.width, view.height, radius) }
        }
    }
    private val density = ctx.resources.displayMetrics.density
    private val shadowPaints = IslandTokens.SHADOW_LAYERS.mapIndexed { i, layer ->
        // CSS blur B is a Gaussian of sigma B/2; Android's shadow radius r gives sigma 0.57735r + 0.5.
        val sigma = layer[2] * density / 2f
        val r = ((sigma - 0.5f) / 0.57735f).coerceAtLeast(0.01f)
        Paint(Paint.ANTI_ALIAS_FLAG).apply { color = IslandTokens.COLOR_ISLAND; setShadowLayer(r, layer[0] * density, layer[1] * density, IslandTokens.SHADOW_COLORS[i]) }
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = IslandTokens.COLOR_ISLAND }
    // inset 0 0 0 1px rgba(255,255,255,.06): a 1px line just inside the edge.
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = density; color = IslandTokens.COLOR_ISLAND_STROKE }
    private val box = RectF()
    init {
        setWillNotDraw(false); clipChildren = false; clipToPadding = false
        // Shadow layers on shapes need software rendering before API 28.
        if (Build.VERSION.SDK_INT < 28) setLayerType(LAYER_TYPE_SOFTWARE, null)
        addView(clip, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }
    override fun onDraw(canvas: Canvas) {
        box.set(0f, 0f, width.toFloat(), height.toFloat())
        for (p in shadowPaints) canvas.drawRoundRect(box, radius, radius, p)
        canvas.drawRoundRect(box, radius, radius, fill)
        val half = stroke.strokeWidth / 2; box.inset(half, half)
        canvas.drawRoundRect(box, (radius - half).coerceAtLeast(0f), (radius - half).coerceAtLeast(0f), stroke)
    }
}

/** `.isl-av`: the face, object-fit cover at a vertical focus, on #2A2A2D, clipped to a circle or rounded square. */
internal class IslandAvatar(ctx: Context, private val focusY: Float, private val cornerDp: Float? = null) : View(ctx) {
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
        val r = cornerDp?.let { IslandSpec.dp(context, it) } ?: (w / 2)
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

/** The reference's 24-unit stroke icons: collapse chevron, send arrow. */
internal class IslandIcon(ctx: Context, private val kind: Kind) : View(ctx) {
    enum class Kind { UP, SEND }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND; strokeWidth = 2.2f }
    private val path = Path()
    var ink = IslandSpec.ICON_BUTTON_INK
        set(value) { field = value; invalidate() }
    override fun onDraw(canvas: Canvas) {
        // An 18dp glyph centred in the view, drawn in its 24-unit viewBox.
        val size = IslandSpec.dp(context, 18f)
        canvas.save(); canvas.translate((width - size) / 2, (height - size) / 2); canvas.scale(size / 24f, size / 24f)
        paint.color = ink; path.reset()
        when (kind) {
            Kind.UP -> { path.moveTo(6f, 15f); path.lineTo(12f, 9f); path.lineTo(18f, 15f) }
            Kind.SEND -> { path.moveTo(12f, 19f); path.lineTo(12f, 5f); path.moveTo(6f, 11f); path.lineTo(12f, 5f); path.lineTo(18f, 11f) }
        }
        canvas.drawPath(path, paint); canvas.restore()
    }
}

/** A filled rounded rectangle, for buttons, blocks and the input (`border-radius` + background). */
internal class RoundedBackground(private val color: Int, private val radiusPx: Float) : android.graphics.drawable.Drawable() {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = this@RoundedBackground.color }
    private val box = RectF()
    override fun draw(canvas: Canvas) { box.set(bounds); canvas.drawRoundRect(box, radiusPx, radiusPx, paint) }
    override fun setAlpha(alpha: Int) { paint.alpha = alpha }
    override fun setColorFilter(colorFilter: android.graphics.ColorFilter?) { paint.colorFilter = colorFilter }
    @Deprecated("Deprecated in Java") override fun getOpacity() = android.graphics.PixelFormat.TRANSLUCENT
}

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
