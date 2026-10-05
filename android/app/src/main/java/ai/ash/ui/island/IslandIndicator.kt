package ai.ash.ui.island

import android.animation.TimeAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.view.View
import android.view.animation.PathInterpolator
import kotlin.math.max

/**
 * The reference's state marks (island.html `indicator()` and its keyframes), drawn in an 18dp box in the reference's
 * own 18-unit coordinates. Animated marks run while attached; reduced motion shows their resting frame.
 */
internal class IslandIndicator(ctx: Context) : View(ctx) {
    enum class Mark { BARS, DOTS, RING, PULSE, DOT, CHECK, WARN, STOP, OFF, NONE }
    var mark = Mark.NONE; private set
    var tone = IslandTokens.COLOR_RUNNING; private set
    var reduceMotion = false
    private var elapsedMs = 0L
    private val ticker = TimeAnimator().apply { setTimeListener { _, total, _ -> elapsedMs = total; invalidate() } }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND }
    // CSS ease-in-out and ease-out.
    private val easeInOut = PathInterpolator(0.42f, 0f, 0.58f, 1f)
    private val easeOut = PathInterpolator(0f, 0f, 0.58f, 1f)
    private val path = Path()
    private val rect = RectF()

    // The mark being replaced, shrinking out while the new one grows in (SF Symbols replace).
    private var previous = Mark.NONE; private var previousTone = 0; private var swap = 1f
    private val swapAnim = android.animation.ValueAnimator.ofFloat(0f, 1f).apply {
        duration = IslandMotion.MARK_MS; interpolator = PathInterpolator(0.2f, 0f, 0f, 1f)
        addUpdateListener { swap = it.animatedValue as Float; invalidate() }
    }
    fun set(mark: Mark, tone: Int) {
        if (this.mark == mark && this.tone == tone) return
        if (this.mark != mark && this.mark != Mark.NONE && isAttachedToWindow && !reduceMotion) {
            previous = this.mark; previousTone = this.tone; swapAnim.cancel(); swapAnim.start()
        } else { previous = Mark.NONE; swap = 1f }
        this.mark = mark; this.tone = tone
        if (animated() && isAttachedToWindow) ticker.takeIf { !it.isStarted }?.start() else if (!animated()) ticker.cancel()
        invalidate()
    }
    private fun animated() = !reduceMotion && mark in setOf(Mark.BARS, Mark.DOTS, Mark.RING, Mark.PULSE)
    override fun onAttachedToWindow() { super.onAttachedToWindow(); if (animated()) ticker.start() }
    override fun onDetachedFromWindow() { ticker.cancel(); super.onDetachedFromWindow() }

    /** Phase in [0,1) of a CSS animation with this period and (possibly negative) delay. */
    private fun phase(periodMs: Long, delayMs: Long = 0): Float {
        val t = elapsedMs - delayMs
        val m = ((t % periodMs) + periodMs) % periodMs
        return m.toFloat() / periodMs
    }
    /** A keyframe 0%,100% at a and 50% at b, each half eased in-out (CSS ease-in-out per segment). */
    private fun wave(p: Float, a: Float, b: Float): Float {
        val half = if (p < 0.5f) p * 2 else (1 - p) * 2
        return a + (b - a) * easeInOut.getInterpolation(half)
    }

    override fun onDraw(canvas: Canvas) {
        val unit = width / 18f
        if (previous != Mark.NONE && swap < 1f) {
            drawMark(canvas, previous, previousTone, unit, 1f - swap, 1f - 0.4f * swap)
            drawMark(canvas, mark, tone, unit, swap, 0.6f + 0.4f * swap)
        } else drawMark(canvas, mark, tone, unit, 1f, 1f)
    }

    private fun drawMark(canvas: Canvas, mark: Mark, tone: Int, unit: Float, alpha: Float, scale: Float) {
        if (alpha <= 0f) return
        canvas.save(); canvas.scale(unit, unit); canvas.scale(scale, scale, 9f, 9f)
        if (alpha < 1f) canvas.saveLayerAlpha(0f, 0f, 18f, 18f, (alpha * 255).toInt())
        when (mark) {
            // .ind-bars i { width 3px; height 6->(5,15); radius 2; gap 2 } over .9s with delays -.3 -.6 -.1 -.45
            Mark.BARS -> {
                fill.color = tone
                val delays = longArrayOf(-300, -600, -100, -450)
                val total = 4 * 3f + 3 * 2f; var x = (18 - total) / 2
                for (d in delays) {
                    val h = if (reduceMotion) 6f else wave(phase(900, d), 5f, 15f)
                    rect.set(x, 9 - h / 2, x + 3, 9 + h / 2); canvas.drawRoundRect(rect, 2f, 2f, fill); x += 5
                }
            }
            // .ind-dots i { 4px; gap 2; opacity .25->1; scale .75->1 } over 1.2s, delays 0 .2 .4
            Mark.DOTS -> {
                var cx = (18 - (3 * 4f + 2 * 2f)) / 2 + 2
                for (d in longArrayOf(0, 200, 400)) {
                    val p = phase(1200, d)
                    val a = if (reduceMotion) 1f else wave(p, 0.25f, 1f); val s = if (reduceMotion) 1f else wave(p, 0.75f, 1f)
                    fill.color = tone; fill.alpha = (a * 255).toInt()
                    canvas.drawCircle(cx, 9f, 2f * s, fill); cx += 6
                }
                fill.alpha = 255
            }
            // ring: track r7 stroke 2.4 rgba(255,255,255,.14); arc dash 12/32, round caps; rotate 1s linear
            Mark.RING -> {
                stroke.strokeWidth = 2.4f; stroke.pathEffect = null
                stroke.color = 0x24FFFFFF; canvas.drawCircle(9f, 9f, 7f, stroke)
                stroke.color = tone
                // An SVG circle's stroke starts at three o'clock.
                val start = if (reduceMotion) 0f else phase(IslandTokens.MOTION_SPIN_MS) * 360f
                rect.set(2f, 2f, 16f, 16f); canvas.drawArc(rect, start, 12f / (2 * Math.PI.toFloat() * 7f) * 360f, false, stroke)
            }
            // .ind-pulse { 9px dot } + .pulse { box-shadow 0 -> 7px, alpha .55 -> 0 over 1.4s ease-out }
            Mark.PULSE -> {
                if (!reduceMotion) {
                    val p = easeOut.getInterpolation(phase(IslandTokens.MOTION_PULSE_MS))
                    fill.color = tone; fill.alpha = (0.55f * (1 - p) * 255).toInt()
                    canvas.drawCircle(9f, 9f, 4.5f + 7f * p, fill)
                }
                fill.color = tone; fill.alpha = 255; canvas.drawCircle(9f, 9f, 4.5f, fill)
            }
            // A resting .ind-pulse: the neutral end-of-turn mark (host.css), no pulse.
            Mark.DOT -> { fill.color = tone; fill.alpha = 255; canvas.drawCircle(9f, 9f, 4.5f, fill) }
            // check: circle r8 + M5.4 9.2 l2.4 2.4 4.8-5, stroke #101011 width 2
            Mark.CHECK -> {
                fill.color = tone; canvas.drawCircle(9f, 9f, 8f, fill)
                stroke.color = IslandTokens.COLOR_ISLAND; stroke.strokeWidth = 2f; stroke.pathEffect = null
                path.reset(); path.moveTo(5.4f, 9.2f); path.rLineTo(2.4f, 2.4f); path.rLineTo(4.8f, -5f); canvas.drawPath(path, stroke)
            }
            // warn: circle r8 + M9 5 v5 (stroke 2) + dot (9,12.8) r1.1
            Mark.WARN -> {
                fill.color = tone; canvas.drawCircle(9f, 9f, 8f, fill)
                stroke.color = IslandTokens.COLOR_ISLAND; stroke.strokeWidth = 2f; stroke.pathEffect = null
                canvas.drawLine(9f, 5f, 9f, 10f, stroke)
                fill.color = IslandTokens.COLOR_ISLAND; canvas.drawCircle(9f, 12.8f, 1.1f, fill)
            }
            // .ind-stop { 10px; radius 2.5 }
            Mark.STOP -> { fill.color = tone; rect.set(4f, 4f, 14f, 14f); canvas.drawRoundRect(rect, 2.5f, 2.5f, fill) }
            // off: circle r6.5, stroke #8D8D93 width 2, dash 3 3
            Mark.OFF -> {
                stroke.color = IslandTokens.COLOR_OFFLINE; stroke.strokeWidth = 2f; stroke.strokeCap = Paint.Cap.BUTT
                stroke.pathEffect = DashPathEffect(floatArrayOf(3f, 3f), 0f); canvas.drawCircle(9f, 9f, 6.5f, stroke)
                stroke.pathEffect = null; stroke.strokeCap = Paint.Cap.ROUND
            }
            Mark.NONE -> {}
        }
        if (alpha < 1f) canvas.restore()
        canvas.restore()
    }
    override fun onMeasure(w: Int, h: Int) {
        val size = IslandSpec.dp(context, IslandSpec.INDICATOR).toInt()
        setMeasuredDimension(max(size, suggestedMinimumWidth), max(size, suggestedMinimumHeight))
    }
}
