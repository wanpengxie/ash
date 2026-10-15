package ai.ash.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Shader
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.TextView

/**
 * A message bubble that shows a long text folded to [lines] lines, its last ones fading out, with [toggle] (「展开全文 ⌄」 /
 * 「收起 ⌃」) under it inside the bubble. Whether the text is long is decided while the bubble is measured, from the text's own
 * layout at the width it gets, so the bubble has its final height in the first layout: nothing grows a moment later.
 * Folded, a tap anywhere on it opens it (its text is a preview then: no selecting, no links); open, the toggle folds it again.
 * [onToggle] is told before the size changes, so the list can keep the bubble's top where it is.
 */
@SuppressLint("ViewConstructor")
class FoldBubble(
    ctx: Context, private val text: TextView, private val toggle: TextView, private val lines: Int, private val gap: Int,
    open: Boolean, private val onToggle: (FoldBubble, Boolean) -> Unit,
) : ViewGroup(ctx) {
    var open = open
        private set
    private var folded = false
    private var fadePx = 0
    private val eraser = Paint().apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.DST_OUT) }

    init {
        addView(text); addView(toggle)
        toggle.isClickable = true
        toggle.setOnClickListener { set(!this.open) }
        setOnClickListener { if (folded) set(true) }
        paintToggle()
    }

    private fun set(value: Boolean) {
        if (value == open) return
        onToggle(this, value)
        open = value
        paintToggle()
        requestLayout()
    }

    private fun paintToggle() { toggle.text = if (open) "收起 ⌃" else "展开全文 ⌄" }

    override fun onMeasure(widthSpec: Int, heightSpec: Int) {
        val padW = paddingLeft + paddingRight
        val padH = paddingTop + paddingBottom
        val mode = MeasureSpec.getMode(widthSpec)
        val child = if (mode == MeasureSpec.UNSPECIFIED) widthSpec
            else MeasureSpec.makeMeasureSpec((MeasureSpec.getSize(widthSpec) - padW).coerceAtLeast(0), MeasureSpec.AT_MOST)
        val free = MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
        text.measure(child, free)
        val layout = text.layout
        val count = layout?.lineCount ?: 0
        val long = Fold.long(count, lines)
        folded = Fold.folded(count, lines, open)
        var w = text.measuredWidth
        var h = text.measuredHeight
        if (folded && layout != null) {
            // The same layout, shown to the bottom of its last folded line; the rest is cut off (and faded into).
            h = layout.getLineBottom(lines - 1) + text.paddingTop + text.paddingBottom
            text.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
        }
        fadePx = if (folded && layout != null) Math.round(layout.getLineBottom(0) * 1.6f) else 0
        if (long) {
            toggle.measure(child, free)
            w = maxOf(w, toggle.measuredWidth); h += gap + toggle.measuredHeight
        } else toggle.measure(MeasureSpec.makeMeasureSpec(0, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.EXACTLY))
        setMeasuredDimension(resolveSize(w + padW, widthSpec), resolveSize(h + padH, heightSpec))
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val x = paddingLeft
        var y = paddingTop
        text.layout(x, y, x + text.measuredWidth, y + text.measuredHeight)
        y += text.measuredHeight
        if (toggle.measuredHeight > 0) y += gap
        toggle.layout(x, y, x + toggle.measuredWidth, y + toggle.measuredHeight)
        // A folded preview never scrolls its cut-off lines inside itself.
        if (folded && text.scrollY != 0) text.scrollTo(0, 0)
    }

    /** Folded, the bubble takes the touches: a tap opens it. */
    override fun onInterceptTouchEvent(e: MotionEvent) = folded

    override fun drawChild(canvas: Canvas, child: View, drawingTime: Long): Boolean {
        if (child !== text || fadePx <= 0 || child.height <= 0) return super.drawChild(canvas, child, drawingTime)
        val l = child.left.toFloat(); val t = child.top.toFloat(); val r = child.right.toFloat(); val b = child.bottom.toFloat()
        val save = canvas.saveLayer(l, t, r, b, null)
        canvas.clipRect(l, t, r, b)
        val drawn = super.drawChild(canvas, child, drawingTime)
        val top = (b - fadePx).coerceAtLeast(t)
        eraser.shader = LinearGradient(0f, top, 0f, b, 0x00000000, 0xFF000000.toInt(), Shader.TileMode.CLAMP)
        canvas.drawRect(l, top, r, b, eraser)
        canvas.restoreToCount(save)
        return drawn
    }
}
