package ai.ash.sysapps.devices

import ai.ash.R
import ai.ash.ui.design.AshUi
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.View

/** A device object, never an agent avatar or a claim about its screen contents (SPEC C05/V06). */
internal class DeviceObjectView(context: Context, kind: String) : View(context) {
    var kind: String = kind
        set(value) { if (field != value) { field = value; invalidate() } }
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    init { importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val c = AshUi.p(context)
        val scale = minOf(width / 100f, height / 80f)
        canvas.save(); canvas.translate((width - 100 * scale) / 2, (height - 80 * scale) / 2); canvas.scale(scale, scale)
        fun box(l: Float, t: Float, r: Float, b: Float, radius: Float, fill: Int, stroke: Int? = null, line: Float = 1f) {
            paint.style = Paint.Style.FILL; paint.color = fill; canvas.drawRoundRect(RectF(l, t, r, b), radius, radius, paint)
            if (stroke != null) { paint.style = Paint.Style.STROKE; paint.color = stroke; paint.strokeWidth = line; canvas.drawRoundRect(RectF(l, t, r, b), radius, radius, paint) }
        }
        when (kind) {
            "phone" -> {
                box(32f, 2f, 68f, 77f, 9f, c.surface, c.ink, 3f)
                box(37f, 12f, 63f, 67f, 2f, c.surface, c.line2)
                box(40f, 20f, 60f, 22f, 0f, c.line2); box(40f, 27f, 50f, 29f, 0f, c.line2)
            }
            "server" -> {
                box(16f, 13f, 84f, 68f, 16f, c.surface3, c.line2)
                context.getDrawable(R.drawable.ash_ic_server)?.mutate()?.apply { setTint(c.text2); setBounds(37, 27, 63, 53); draw(canvas) }
            }
            "browser" -> {
                context.getDrawable(R.drawable.ash_ic_globe)?.mutate()?.apply { setTint(c.text2); setBounds(20, 10, 80, 70); draw(canvas) }
            }
            else -> {
                box(14f, 9f, 86f, 61f, 5f, c.surface2, c.ink, 3f)
                box(22f, 18f, 78f, 53f, 2f, c.surface, c.line2)
                box(28f, 27f, 72f, 28f, 0f, c.line2); box(28f, 34f, 62f, 36f, 0f, c.line2)
                box(5f, 66f, 95f, 71f, 2f, c.ink)
            }
        }
        canvas.restore()
    }
}
