package ai.ash.widget

import org.junit.Assert.*
import org.junit.Test

class SvgPathTest {
    @Test fun commandsBecomeAbsoluteSteps() {
        val ops = SvgPath.parse("M2 2 l20 0 V22 h-10 z")
        assertEquals(listOf(PathOp.Move(2f, 2f), PathOp.Line(22f, 2f), PathOp.Line(22f, 22f), PathOp.Line(12f, 22f), PathOp.Close), ops)
        assertArrayEquals(floatArrayOf(2f, 2f, 22f, 22f), SvgPath.bounds(ops), 0f)
    }

    @Test fun smoothCurvesReflectAndArcsBecomeCubics() {
        val ops = SvgPath.parse("M0 0 C 0 10 10 10 10 0 S 20 -10 20 0")
        assertEquals(PathOp.Cubic(10f, -10f, 20f, -10f, 20f, 0f), ops[2])
        val arc = SvgPath.parse("M0 12 A12 12 0 0 1 24 12")
        assertTrue(arc.drop(1).all { it is PathOp.Cubic })
        val end = arc.last() as PathOp.Cubic
        assertEquals(24f, end.x, 0.01f); assertEquals(12f, end.y, 0.01f)
        // Half a circle over the top reaches y = 0.
        assertEquals(0f, SvgPath.bounds(arc)[1], 1f)
    }

    @Test fun brokenPathsSayWhy() {
        assertThrows(CardProblem::class.java) { SvgPath.parse("L 1 2") }
        assertThrows(CardProblem::class.java) { SvgPath.parse("M 1") }
    }
}
