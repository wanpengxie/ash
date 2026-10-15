package ai.ash.widget

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The card part `Chart` (an Ash extension of A2UI, design/vitals/HANDOFF.md §8) drawn on the phone: [layout] works out the shapes
 * in dp (plain Kotlin, the same geometry as design/vitals/chart/chart.mjs, checked against chart/vectors.json), [render] paints
 * them into a bitmap at the real size and density, with the colours of the current theme. A widget is a still picture between
 * two updates, so the chart is a bitmap in an ImageView like any other image of a card; it is drawn again when the system
 * goes dark or light.
 */
object AshChart {
    const val LINE_WIDTH = 1.6f
    const val AREA_ALPHA = 0.16f
    const val DOT = 2.4f
    const val PAD = 2f
    const val LIMIT_WIDTH = 1f
    val LIMIT_DASH = floatArrayOf(2f, 3f)
    const val BAR_RADIUS = 2f
    const val BAR_MIN = 2f
    const val GAP = 2f

    /** A stretch of a line in another colour: [to] null runs to the last point. */
    data class Highlight(val from: Int, val to: Int?, val color: Tint)

    data class Series(
        val type: String,
        val values: List<Float>,
        val color: Tint,
        val fill: Boolean = false,
        val width: Float? = null,
        val dot: Boolean = true,
        val max: Float? = null,
        val floor: Float? = null,
        /** The bottom of the value axis: values below it sit on the bottom. Null is 0. */
        val min: Float? = null,
        val highlight: Highlight? = null,
        val colors: Map<Int, Tint> = emptyMap(),
        val lastColor: Tint? = null,
        val limit: Float? = null,
        val limitColor: Tint? = null,
    )

    data class Chart(val series: List<Series>, val gap: Float? = null)

    /** What to paint, in the order to paint it (areas, lines and bars first; then the limit lines; the dots last). */
    sealed class Prim {
        data class Bar(val x: Float, val y: Float, val w: Float, val h: Float, val r: Float, val color: Tint) : Prim()
        data class Area(val points: List<Pair<Float, Float>>, val color: Tint, val alpha: Float) : Prim()
        data class Line(val points: List<Pair<Float, Float>>, val color: Tint, val width: Float) : Prim()
        data class Limit(val y: Float, val x1: Float, val x2: Float, val color: Tint) : Prim()
        data class Dot(val x: Float, val y: Float, val r: Float, val color: Tint) : Prim()
    }

    private fun r1(v: Float): Float = (v * 10f).roundToInt() / 10f

    /** The bottom of a series' axis: its `min`, else 0. */
    fun scaleMin(s: Series): Float = s.min ?: 0f

    /**
     * The top of a series' axis: its `max`, else the larger of `floor` and min + 1.25 x (its largest value - min);
     * min + 1 when that is not above min (all 0, or all at or under min).
     */
    fun scaleMax(s: Series): Float {
        s.max?.let { return it }
        val lo = scaleMin(s)
        val top = max(s.floor ?: 0f, lo + max(0f, max(lo, s.values.maxOrNull() ?: 0f) - lo) * 1.25f)
        return if (top > lo) top else lo + 1f
    }

    /** Where [v] sits on the axis [lo] .. [hi], 0..1 (values outside it at the ends). */
    fun frac(v: Float, hi: Float, lo: Float = 0f): Float = if (hi > lo) (min(max(v, lo), hi) - lo) / (hi - lo) else 0f

    fun linePoints(values: List<Float>, w: Float, h: Float, max: Float, min: Float = 0f): List<Pair<Float, Float>> {
        val n = values.size
        return values.mapIndexed { i, v ->
            val x = if (n == 1) w else i.toFloat() / (n - 1) * w
            r1(x) to r1(h - PAD - frac(v, max, min) * (h - PAD * 2))
        }
    }

    fun limitY(value: Float, h: Float, max: Float, bars: Boolean, min: Float = 0f): Float =
        r1(if (bars) h - frac(value, max, min) * h else h - PAD - frac(value, max, min) * (h - PAD * 2))

    fun layout(chart: Chart, w: Float, h: Float): List<Prim> {
        val body = ArrayList<Prim>(); val limits = ArrayList<Prim>(); val dots = ArrayList<Prim>()
        for (s in chart.series) {
            val mx = scaleMax(s); val lo = scaleMin(s); val n = s.values.size
            if (s.type == "bars") {
                val gap = chart.gap ?: GAP
                val bw = (w - gap * (n - 1)) / n
                s.values.forEachIndexed { i, v ->
                    val bh = max(BAR_MIN, frac(v, mx, lo) * h)
                    val color = s.colors[i] ?: (if (i == n - 1) s.lastColor else null) ?: s.color
                    val rw = r1(bw)
                    body += Prim.Bar(r1(i * (bw + gap)), r1(h - bh), rw, r1(bh), min(BAR_RADIUS, rw / 2), color)
                }
            } else {
                val pts = linePoints(s.values, w, h, mx, lo)
                val width = s.width ?: LINE_WIDTH
                if (s.fill) body += Prim.Area(pts, s.color, AREA_ALPHA)
                body += Prim.Line(pts, s.color, width)
                var dotColor = s.color
                s.highlight?.let { hl ->
                    val seg = pts.subList(hl.from.coerceIn(0, n), (hl.to?.plus(1) ?: n).coerceIn(0, n))
                    if (s.fill) body += Prim.Area(seg, hl.color, AREA_ALPHA)
                    body += Prim.Line(seg, hl.color, r1(width + 0.4f))
                    if (hl.to == null) dotColor = hl.color
                }
                if (s.dot) dots += Prim.Dot(pts[n - 1].first, pts[n - 1].second, DOT, dotColor)
            }
            s.limit?.let { limits += Prim.Limit(limitY(it, h, mx, s.type == "bars", lo), 0f, w, s.limitColor ?: s.color) }
        }
        return body + limits + dots
    }

    /** The chart as a bitmap [wDp] x [hDp] dp at [density]; transparent, so the card's own background shows. */
    fun render(chart: Chart, wDp: Float, hDp: Float, density: Float, night: Boolean): Bitmap {
        val bmp = Bitmap.createBitmap(max(1, (wDp * density).roundToInt()), max(1, (hDp * density).roundToInt()), Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        canvas.scale(density, density)
        val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
        val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeJoin = Paint.Join.ROUND; strokeCap = Paint.Cap.ROUND }
        fun path(points: List<Pair<Float, Float>>) = Path().apply { points.forEachIndexed { i, p -> if (i == 0) moveTo(p.first, p.second) else lineTo(p.first, p.second) } }
        for (p in layout(chart, wDp, hDp)) when (p) {
            is Prim.Bar -> { fill.color = p.color.pick(night); canvas.drawRoundRect(RectF(p.x, p.y, p.x + p.w, p.y + p.h), p.r, p.r, fill) }
            is Prim.Area -> {
                val area = path(p.points).apply { lineTo(p.points.last().first, hDp); lineTo(p.points.first().first, hDp); close() }
                fill.color = p.color.withAlpha(p.alpha).pick(night); canvas.drawPath(area, fill)
            }
            is Prim.Line -> { stroke.color = p.color.pick(night); stroke.strokeWidth = p.width; stroke.pathEffect = null; canvas.drawPath(path(p.points), stroke) }
            is Prim.Limit -> {
                stroke.color = p.color.pick(night); stroke.strokeWidth = LIMIT_WIDTH; stroke.pathEffect = DashPathEffect(LIMIT_DASH, 0f); stroke.strokeCap = Paint.Cap.BUTT
                canvas.drawLine(p.x1, p.y, p.x2, p.y, stroke); stroke.strokeCap = Paint.Cap.ROUND
            }
            is Prim.Dot -> { fill.color = p.color.pick(night); canvas.drawCircle(p.x, p.y, p.r, fill) }
        }
        return bmp
    }

    /**
     * The chart of a card that has gone stale: every colour becomes [text3] (a bar of [surface3] stays), the highlighted stretch and
     * the limit line are dropped. The numbers do not change: it is the last picture the phone was given.
     */
    fun stale(chart: Chart, text3: Tint, surface3: Tint): Chart = chart.copy(series = chart.series.map { s ->
        s.copy(color = if (s.type == "bars" && s.color == surface3) surface3 else text3, highlight = null, colors = emptyMap(),
            lastColor = s.lastColor?.let { text3 }, limit = null)
    })

    // ---- reading a `Chart` component of a card

    private fun fail(what: String): Nothing = throw CardProblem("图表（Chart）$what")

    /** The `series` and `gap` of a Chart component, checked against the limits of HANDOFF §8. [color] reads a card colour. */
    fun parse(c: JSONObject, color: (Any?) -> Tint? = CardSpec::tint): Chart {
        val arr = c.optJSONArray("series") ?: fail("没有 series")
        if (arr.length() !in 1..4) fail("要 1 到 4 组数据")
        var total = 0
        val series = (0 until arr.length()).map { i ->
            val s = arr.optJSONObject(i) ?: fail("的第 ${i + 1} 组不是对象")
            val type = s.optString("type")
            if (type != "line" && type != "bars") fail("的类型只能是 line 或 bars")
            val vals = s.optJSONArray("values") ?: fail("的第 ${i + 1} 组没有 values")
            if (vals.length() !in 1..240) fail("每组要 1 到 240 个数")
            total += vals.length()
            val values = (0 until vals.length()).map { j ->
                val d = (vals.opt(j) as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: fail("的数据里有不是数的值")
                max(0.0, d).toFloat()
            }
            fun num(key: String) = if (s.has(key) && !s.isNull(key)) ((s.opt(key) as? Number)?.toFloat()?.takeIf { it.isFinite() } ?: fail("的 $key 不是数")) else null
            val width = num("width")
            if (width != null && width !in 0.5f..4f) fail("的线宽要在 0.5 到 4 之间")
            val hl = s.optJSONObject("highlight")?.let { h ->
                val from = h.optInt("from", -1)
                val to = if (h.has("to") && !h.isNull("to")) h.optInt("to", -1) else null
                if (from !in values.indices || (to != null && to !in from until values.size)) fail("的高亮段超出了数据")
                Highlight(from, to, color(h.opt("color")) ?: fail("的高亮段没有颜色"))
            }
            val colors = s.optJSONObject("colors")?.let { o -> o.keys().asSequence().associate { k ->
                (k.toIntOrNull()?.takeIf { it in values.indices } ?: fail("的 colors 里有不认识的序号")) to (color(o.opt(k)) ?: fail("的 colors 缺颜色")) } } ?: emptyMap()
            val lo = num("min")
            if (lo != null && lo < 0f) fail("的 min 不能小于 0")
            val hi = num("max")?.takeIf { it > 0 }
            if (lo != null && hi != null && hi <= lo) fail("的 max 要大于 min")
            Series(type, values, color(s.opt("color")) ?: fail("的第 ${i + 1} 组没有颜色"), s.optBoolean("fill"), width, s.optBoolean("dot", true),
                hi, num("floor"), lo, hl, colors, color(s.opt("lastColor")), num("limit"), color(s.opt("limitColor")))
        }
        if (total > 600) fail("的数据总共不能超过 600 个")
        val gap = if (c.has("gap") && !c.isNull("gap")) (c.opt("gap") as? Number)?.toFloat() ?: fail("的 gap 不是数") else null
        return Chart(series, gap)
    }
}
