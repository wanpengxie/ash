package ai.ash.widget

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.File

/** The chart geometry is the web page's (design/vitals/chart/chart.mjs): the same test vectors check both. */
class AshChartTest {
    private fun repoFile(path: String): File = generateSequence(File("").absoluteFile) { it.parentFile }.map { File(it, path) }.first { it.isFile }

    /** The vectors name colours by token ("her-fill"); here each name is a colour of its own, so a result can be named again. */
    private val names = HashMap<Int, String>()
    private fun tint(raw: Any?): Tint? = (raw as? String)?.let { n -> Tint(n.hashCode(), n.hashCode()).also { names[it.light] = n } }
    private fun nameOf(t: Tint) = names.getValue(t.light)

    private fun near(a: Double, b: Float, what: String) = assertEquals(what, a, b.toDouble(), 0.051)
    private fun points(a: JSONArray) = (0 until a.length()).map { a.getJSONArray(it).let { p -> p.getDouble(0) to p.getDouble(1) } }

    @Test fun everyVectorOfTheDesignDrawsTheSameShapes() {
        val vectors = JSONArray(repoFile("design/vitals/chart/vectors.json").readText())
        assertTrue(vectors.length() >= 7)
        for (i in 0 until vectors.length()) {
            val v = vectors.getJSONObject(i)
            val name = v.getString("name")
            val prims = AshChart.layout(AshChart.parse(v.getJSONObject("chart"), ::tint), v.getDouble("w").toFloat(), v.getDouble("h").toFloat())
            val expect = v.getJSONArray("expect")
            assertEquals("$name: how many shapes", expect.length(), prims.size)
            for (k in 0 until expect.length()) {
                val e = expect.getJSONObject(k); val p = prims[k]; val at = "$name #$k ${e.getString("kind")}"
                when (e.getString("kind")) {
                    "bar" -> { p as AshChart.Prim.Bar
                        near(e.getDouble("x"), p.x, "$at x"); near(e.getDouble("y"), p.y, "$at y"); near(e.getDouble("w"), p.w, "$at w"); near(e.getDouble("h"), p.h, "$at h"); near(e.getDouble("r"), p.r, "$at r")
                        assertEquals(at, e.getString("color"), nameOf(p.color)) }
                    "area" -> { p as AshChart.Prim.Area
                        assertEquals(at, points(e.getJSONArray("points")).size, p.points.size)
                        points(e.getJSONArray("points")).zip(p.points).forEach { (a, b) -> near(a.first, b.first, "$at x"); near(a.second, b.second, "$at y") }
                        near(e.getDouble("alpha"), p.alpha, "$at alpha"); assertEquals(at, e.getString("color"), nameOf(p.color)) }
                    "line" -> { p as AshChart.Prim.Line
                        assertEquals(at, points(e.getJSONArray("points")).size, p.points.size)
                        points(e.getJSONArray("points")).zip(p.points).forEach { (a, b) -> near(a.first, b.first, "$at x"); near(a.second, b.second, "$at y") }
                        near(e.getDouble("width"), p.width, "$at width"); assertEquals(at, e.getString("color"), nameOf(p.color)) }
                    "limit" -> { p as AshChart.Prim.Limit
                        near(e.getDouble("y"), p.y, "$at y"); near(e.getDouble("x1"), p.x1, "$at x1"); near(e.getDouble("x2"), p.x2, "$at x2")
                        assertEquals(at, e.getString("color"), nameOf(p.color))
                        assertEquals(at, e.getJSONArray("dash").getDouble(0), AshChart.LIMIT_DASH[0].toDouble(), 0.0); assertEquals(at, e.getDouble("width"), AshChart.LIMIT_WIDTH.toDouble(), 0.0) }
                    "dot" -> { p as AshChart.Prim.Dot
                        near(e.getDouble("x"), p.x, "$at x"); near(e.getDouble("y"), p.y, "$at y"); near(e.getDouble("r"), p.r, "$at r")
                        assertEquals(at, e.getString("color"), nameOf(p.color)) }
                    else -> throw AssertionError("$at: a shape the phone does not know")
                }
            }
        }
    }

    private fun chart(vararg series: String) = JSONObject("""{"series": [${series.joinToString(",")}]}""")
    private fun line(extra: String = "", values: String = "[1,2,3]") = """{"type":"line","values":$values,"color":"teal"$extra}"""

    /** An example of the design as the core hands it to the phone: `name:{svgPath}` becomes `svgPath`, `accessibility` becomes `a11y` (card.ts does that). */
    private fun resolved(file: String): JSONObject {
        val raw = JSONObject(repoFile(file).readText())
        val list = raw.getJSONArray("components")
        for (i in 0 until list.length()) {
            val c = list.getJSONObject(i)
            (c.opt("name") as? JSONObject)?.let { c.remove("name"); c.put("svgPath", it.getString("svgPath")) }
            c.optJSONObject("accessibility")?.let { c.remove("accessibility"); c.put("a11y", it.getString("label")) }
        }
        return raw
    }

    @Test fun aChartThatBreaksTheLimitsIsRefusedInWords() {
        fun refused(c: JSONObject) = assertThrows(CardProblem::class.java) { AshChart.parse(c) }.message!!
        assertTrue(refused(JSONObject("""{"series":[]}""")).contains("1 到 4"))
        assertTrue(refused(chart(line(values = "[]"))).contains("1 到 240"))
        assertTrue(refused(chart(line(values = "[1,\"x\"]"))).contains("不是数"))
        assertTrue(refused(chart(line(""","width":9"""))).contains("线宽"))
        assertTrue(refused(chart(line(""","highlight":{"from":7,"color":"red"}"""))).contains("高亮"))
        assertTrue(refused(chart("""{"type":"area","values":[1],"color":"teal"}""")).contains("line 或 bars"))
        assertTrue(refused(chart("""{"type":"line","values":[1]}""")).contains("没有颜色"))
        val big = "[" + (1..240).joinToString(",") + "]"
        assertTrue(refused(chart(line(values = big), line(values = big), line(values = big))).contains("600"))
    }

    @Test fun negativeValuesAreZeroAndTheAxisHasItsRules() {
        val parsed = AshChart.parse(chart(line(values = "[-5, 10]", extra = ""","floor":15""")))
        assertEquals(listOf(0f, 10f), parsed.series[0].values)
        assertEquals(15f, AshChart.scaleMax(parsed.series[0]), 0f)
        assertEquals(1f, AshChart.scaleMax(AshChart.Series("line", listOf(0f, 0f), Tint(1, 1))), 0f)
        assertEquals(25f, AshChart.scaleMax(AshChart.Series("line", listOf(20f), Tint(1, 1))), 0f)
        assertEquals(40f, AshChart.scaleMax(AshChart.Series("bars", listOf(1f), Tint(1, 1), max = 40f)), 0f)
    }

    @Test fun anAxisFromMinShowsOnlyThePartThatMoves() {
        val s = AshChart.parse(chart(line(values = "[60, 62, 64]", extra = ""","min":56"""))).series[0]
        assertEquals(56f, AshChart.scaleMin(s), 0f)
        // top = min + (largest - min) x 1.25 = 56 + 8 x 1.25
        assertEquals(66f, AshChart.scaleMax(s), 0.001f)
        // a floor above that still wins; a given max is the top
        assertEquals(70f, AshChart.scaleMax(s.copy(floor = 70f)), 0f)
        assertEquals(64f, AshChart.scaleMax(s.copy(max = 64f)), 0f)
        // everything at or under min: the axis is min .. min + 1, and the values sit on the bottom
        val under = AshChart.Series("bars", listOf(2f, 5f), Tint(1, 1), min = 6f)
        assertEquals(7f, AshChart.scaleMax(under), 0f)
        AshChart.layout(AshChart.Chart(listOf(under)), 20f, 10f).forEach { p -> p as AshChart.Prim.Bar; assertEquals(AshChart.BAR_MIN, p.h, 0f) }
        // a line: min at the bottom pad, the top at the top pad, the limit between them
        val line = AshChart.Series("line", listOf(56f, 66f), Tint(1, 1), dot = false, max = 66f, min = 56f, limit = 61f)
        val prims = AshChart.layout(AshChart.Chart(listOf(line)), 40f, 24f)
        val pts = (prims[0] as AshChart.Prim.Line).points
        assertEquals(24f - AshChart.PAD, pts[0].second, 0.05f)
        assertEquals(AshChart.PAD, pts[1].second, 0.05f)
        assertEquals(12f, (prims[1] as AshChart.Prim.Limit).y, 0.05f)
        // without min nothing changes
        assertEquals(25f, AshChart.scaleMax(AshChart.Series("line", listOf(20f), Tint(1, 1), floor = 10f)), 0f)
        // min must be under max
        assertThrows(CardProblem::class.java) { AshChart.parse(chart(line(extra = ""","min":5,"max":5"""))) }
    }

    @Test fun aStaleChartIsGreyWithoutItsHighlightOrLimit() {
        val text3 = Tint(7, 7); val surface3 = Tint(8, 8)
        val c = AshChart.Chart(listOf(
            AshChart.Series("line", listOf(1f, 2f, 3f), Tint(1, 1), highlight = AshChart.Highlight(1, null, Tint(2, 2)), limit = 5f, limitColor = Tint(3, 3)),
            AshChart.Series("bars", listOf(1f, 2f), surface3, lastColor = Tint(4, 4), colors = mapOf(0 to Tint(5, 5)))))
        val s = AshChart.stale(c, text3, surface3)
        assertEquals(text3, s.series[0].color); assertNull(s.series[0].highlight); assertNull(s.series[0].limit)
        assertEquals(surface3, s.series[1].color); assertEquals(text3, s.series[1].lastColor); assertTrue(s.series[1].colors.isEmpty())
        // the numbers stay: it is the last picture the phone was given
        assertEquals(c.series[0].values, s.series[0].values)
        assertTrue(AshChart.layout(s, 64f, 30f).none { it is AshChart.Prim.Limit })
    }

    @Test fun theDesignsCardsParseAndPlanWithTheirCharts() {
        for (name in listOf("ok", "warn", "err")) {
            val render = CardSpec.parse(resolved("design/vitals/card/examples/$name.json"))
            assertEquals("$name: three sizes", 3, render.sizes.size)
            for (root in render.sizes.map { it.root }) {
                val plan = CardPlan.plan(render, root)
                assertEquals("$name: nests as the core counts", CardSpec.levels(root), plan.depth)
                val charts = plan.walk().filter { it.image is Img.Chart }.toList()
                assertTrue("$name: a size has charts", charts.isNotEmpty())
                charts.forEach { assertTrue(it.height is Dim.Dp) }
            }
        }
    }

    @Test fun aChartWithoutAHeightIsRefusedByThePlan() {
        val a2ui = JSONObject("""{"root":"c","components":[{"id":"c","component":"Chart","series":[{"type":"line","values":[1,2],"color":"teal"}]}]}""")
        assertTrue(assertThrows(CardProblem::class.java) { CardPlan.plan(CardSpec.parse(a2ui)) }.message!!.contains("高度"))
    }

    @Test fun aStaleCardKeepsItsFaceInGreyAndSaysWhenItWasLastTrue() {
        val render = CardSpec.parse(resolved("design/vitals/card/examples/err.json"))
        val stale = Stale.of("已过期 · 最后 12:31", "已过期")
        val wide = render.sizes.first { it.width > CardStale.NARROW_DP }
        val before = CardPlan.plan(render, wide.root)
        val greyWide = CardStale.grey(before, stale, wide.width)
        // wide: the time becomes a tag on a pill; the level word is left alone
        greyWide.walk().filter { it.id.endsWith(".at") }.forEach { assertEquals("已过期 · 最后 12:31", it.text?.text); assertEquals(stale.surface2, it.bg); assertEquals(stale.text2, it.textColor) }
        assertTrue(greyWide.walk().filter { it.text != null && !it.id.endsWith(".at") }.all { it.textColor == stale.text3 })
        assertTrue(greyWide.walk().none { (it.image as? Img.Chart)?.chart?.series?.any { s -> s.highlight != null || s.limit != null } == true })
        assertTrue(greyWide.walk().filter { it.id.endsWith(".halo") }.all { it.alpha == 0f })
        assertEquals(before.bg, greyWide.bg)
        // narrow: no room for the tag: the time stays, the level word says 已过期
        val narrow = render.sizes.first { it.width <= CardStale.NARROW_DP }
        val greyNarrow = CardStale.grey(CardPlan.plan(render, narrow.root), stale, narrow.width)
        assertTrue(greyNarrow.walk().filter { it.id.endsWith(".lv") }.all { it.text?.text == "已过期" })
        assertTrue(greyNarrow.walk().none { it.text?.text == "已过期 · 最后 12:31" })
    }

    @Test fun theStaleWordsInTheAppAreTheDesignersWords() {
        val copy = JSONObject(repoFile("design/vitals/copy.json").readText()).getJSONObject("widget")
        val xml = repoFile("android/app/src/main/res/values/strings.xml").readText()
        fun res(name: String) = Regex("<string name=\"$name\">([^<]*)</string>").find(xml)!!.groupValues[1]
        assertEquals(copy.getString("stale_tag").replace("{hhmm}", "%1\$s"), res("ash_stale_tag"))
        assertEquals(JSONObject(repoFile("design/vitals/copy.json").readText()).getJSONObject("levels").getJSONObject("stale").getString("name"), res("ash_stale_level"))
    }
}
