package ai.ash.widget

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/** One drawing step of an SVG path, in absolute coordinates; arcs are already turned into cubic curves. */
sealed class PathOp {
    data class Move(val x: Float, val y: Float) : PathOp()
    data class Line(val x: Float, val y: Float) : PathOp()
    data class Cubic(val x1: Float, val y1: Float, val x2: Float, val y2: Float, val x: Float, val y: Float) : PathOp()
    data class Quad(val x1: Float, val y1: Float, val x: Float, val y: Float) : PathOp()
    object Close : PathOp() { override fun toString() = "Close" }
}

/** SVG path data (the A2UI Icon's svgPath) as drawing steps, for a bitmap the widget can show. */
object SvgPath {
    fun parse(d: String): List<PathOp> {
        val tokens = Regex("[MmLlHhVvCcSsQqTtAaZz]|[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?").findAll(d).map { it.value }.toList()
        val out = ArrayList<PathOp>()
        var i = 0
        var cmd = ' '
        var x = 0f; var y = 0f; var sx = 0f; var sy = 0f
        var cx = 0f; var cy = 0f // last control point, for S and T
        var last = ' '
        fun num(): Float {
            if (i >= tokens.size || tokens[i][0].isLetter()) throw CardProblem("图标路径（svgPath）不完整")
            return tokens[i++].toFloat()
        }
        fun flag(): Boolean = num() != 0f
        while (i < tokens.size) {
            if (tokens[i][0].isLetter()) cmd = tokens[i++][0]
            else if (cmd == ' ') throw CardProblem("图标路径（svgPath）要以 M 开头")
            if (out.isEmpty() && cmd.uppercaseChar() != 'M') throw CardProblem("图标路径（svgPath）要以 M 开头")
            val rel = cmd.isLowerCase()
            val ox = if (rel) x else 0f; val oy = if (rel) y else 0f
            when (cmd.uppercaseChar()) {
                'M' -> { x = ox + num(); y = oy + num(); sx = x; sy = y; out.add(PathOp.Move(x, y)); cmd = if (rel) 'l' else 'L' }
                'L' -> { x = ox + num(); y = oy + num(); out.add(PathOp.Line(x, y)) }
                'H' -> { x = ox + num(); out.add(PathOp.Line(x, y)) }
                'V' -> { y = oy + num(); out.add(PathOp.Line(x, y)) }
                'C' -> {
                    val x1 = ox + num(); val y1 = oy + num(); val x2 = ox + num(); val y2 = oy + num(); x = ox + num(); y = oy + num()
                    out.add(PathOp.Cubic(x1, y1, x2, y2, x, y)); cx = x2; cy = y2
                }
                'S' -> {
                    val x1 = if (last.uppercaseChar() in "CS") 2 * x - cx else x; val y1 = if (last.uppercaseChar() in "CS") 2 * y - cy else y
                    val x2 = ox + num(); val y2 = oy + num(); x = ox + num(); y = oy + num()
                    out.add(PathOp.Cubic(x1, y1, x2, y2, x, y)); cx = x2; cy = y2
                }
                'Q' -> { val x1 = ox + num(); val y1 = oy + num(); x = ox + num(); y = oy + num(); out.add(PathOp.Quad(x1, y1, x, y)); cx = x1; cy = y1 }
                'T' -> {
                    val x1 = if (last.uppercaseChar() in "QT") 2 * x - cx else x; val y1 = if (last.uppercaseChar() in "QT") 2 * y - cy else y
                    x = ox + num(); y = oy + num(); out.add(PathOp.Quad(x1, y1, x, y)); cx = x1; cy = y1
                }
                'A' -> {
                    val rx = num(); val ry = num(); val rot = num(); val large = flag(); val sweep = flag()
                    val ex = ox + num(); val ey = oy + num()
                    arc(out, x, y, rx, ry, rot, large, sweep, ex, ey)
                    x = ex; y = ey
                }
                'Z' -> { out.add(PathOp.Close); x = sx; y = sy }
                else -> throw CardProblem("图标路径（svgPath）里有不认识的命令 $cmd")
            }
            last = cmd
            if (cmd.uppercaseChar() == 'Z' && i < tokens.size && !tokens[i][0].isLetter()) throw CardProblem("图标路径（svgPath）不完整")
        }
        return out
    }

    /** The box the path covers: [minX, minY, maxX, maxY]. */
    fun bounds(ops: List<PathOp>): FloatArray {
        val b = floatArrayOf(Float.MAX_VALUE, Float.MAX_VALUE, -Float.MAX_VALUE, -Float.MAX_VALUE)
        fun add(x: Float, y: Float) { b[0] = minOf(b[0], x); b[1] = minOf(b[1], y); b[2] = maxOf(b[2], x); b[3] = maxOf(b[3], y) }
        for (op in ops) when (op) {
            is PathOp.Move -> add(op.x, op.y)
            is PathOp.Line -> add(op.x, op.y)
            is PathOp.Cubic -> { add(op.x1, op.y1); add(op.x2, op.y2); add(op.x, op.y) }
            is PathOp.Quad -> { add(op.x1, op.y1); add(op.x, op.y) }
            PathOp.Close -> {}
        }
        return if (b[0] > b[2]) floatArrayOf(0f, 0f, 24f, 24f) else b
    }

    /** SVG's endpoint arc as cubic curves (each at most a quarter turn). */
    private fun arc(out: MutableList<PathOp>, x0: Float, y0: Float, rxIn: Float, ryIn: Float, rotDeg: Float, large: Boolean, sweep: Boolean, x: Float, y: Float) {
        var rx = abs(rxIn).toDouble(); var ry = abs(ryIn).toDouble()
        if (rx == 0.0 || ry == 0.0 || (x0 == x && y0 == y)) { out.add(PathOp.Line(x, y)); return }
        val phi = rotDeg * PI / 180
        val cosP = cos(phi); val sinP = sin(phi)
        val dx = (x0 - x) / 2.0; val dy = (y0 - y) / 2.0
        val x1 = cosP * dx + sinP * dy; val y1 = -sinP * dx + cosP * dy
        val lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if (lambda > 1) { rx *= sqrt(lambda); ry *= sqrt(lambda) }
        val num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        val den = rx * rx * y1 * y1 + ry * ry * x1 * x1
        val coef = (if (large == sweep) -1 else 1) * sqrt(maxOf(0.0, num / den))
        val cxp = coef * rx * y1 / ry; val cyp = -coef * ry * x1 / rx
        val cx = cosP * cxp - sinP * cyp + (x0 + x) / 2.0; val cy = sinP * cxp + cosP * cyp + (y0 + y) / 2.0
        fun angle(ux: Double, uy: Double, vx: Double, vy: Double): Double = atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        val t1 = angle(1.0, 0.0, (x1 - cxp) / rx, (y1 - cyp) / ry)
        var dt = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
        if (!sweep && dt > 0) dt -= 2 * PI else if (sweep && dt < 0) dt += 2 * PI
        val segments = ceil(abs(dt) / (PI / 2)).toInt().coerceAtLeast(1)
        val step = dt / segments
        val k = 4.0 / 3.0 * tan(step / 4)
        var t = t1
        fun point(a: Double): Pair<Double, Double> = (cx + rx * cos(a) * cosP - ry * sin(a) * sinP) to (cy + rx * cos(a) * sinP + ry * sin(a) * cosP)
        fun deriv(a: Double): Pair<Double, Double> = (-rx * sin(a) * cosP - ry * cos(a) * sinP) to (-rx * sin(a) * sinP + ry * cos(a) * cosP)
        repeat(segments) {
            val (px, py) = point(t); val (dx1, dy1) = deriv(t)
            val t2 = t + step
            val (qx, qy) = point(t2); val (dx2, dy2) = deriv(t2)
            out.add(PathOp.Cubic((px + k * dx1).toFloat(), (py + k * dy1).toFloat(), (qx - k * dx2).toFloat(), (qy - k * dy2).toFloat(), qx.toFloat(), qy.toFloat()))
            t = t2
        }
    }
}
