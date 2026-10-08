package ai.ash.widget

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CardPreviewTest {
    @Test fun widgetSizeFollowsTheCardSizeOnThisScreen() {
        // 411 dp wide: cells of 94.75 dp, a 4-column widget about 363 dp wide.
        val (w42, h42) = PreviewPlan.sizeDp("4x2", 411f)
        assertEquals(363f, w42, 0.5f); assertEquals(192.5f, h42, 1f)
        val (w22, h22) = PreviewPlan.sizeDp("2x2", 411f)
        assertEquals(173.5f, w22, 0.5f); assertEquals(h42, h22, 0.01f)
        val (w44, h44) = PreviewPlan.sizeDp("4x4", 411f)
        assertEquals(w42, w44, 0.01f); assertEquals(2 * h42 + 16f, h44, 0.5f)
        // A narrower phone gives a narrower widget; an unknown size is treated as 4x2.
        assertTrue(PreviewPlan.sizeDp("4x2", 360f).first < w42)
        assertEquals(PreviewPlan.sizeDp("4x2", 411f), PreviewPlan.sizeDp("wide", 411f))
    }

    @Test fun thePictureIsCappedAtNineHundredPixelsOnTheLongerSideAndNeverEnlarged() {
        assertEquals(1f, PreviewPlan.scale(600, 300), 0f)
        assertEquals(1f, PreviewPlan.scale(900, 900), 0f)
        val s = PreviewPlan.scale(1089, 1200)
        assertEquals(900, PreviewPlan.scaled(1200, s))
        assertTrue(PreviewPlan.scaled(1089, s) <= 900)
        assertEquals(1, PreviewPlan.scaled(1, 0.1f))
        // A zero-sized widget does not divide by zero.
        assertEquals(1f, PreviewPlan.scale(0, 0), 0f)
    }

    @Test fun aPngThatIsTooLargeIsDrawnSmallerInFourSteps() {
        val scales = (0..3).map { PreviewPlan.step(1200, 800, it)!! }
        assertEquals(listOf(0.75f, 0.6f, 0.48f, 0.375f), scales.map { Math.round(it * 1000f) / 1000f })
        assertNull(PreviewPlan.step(1200, 800, 4))
        assertEquals(200 * 1024, PreviewPlan.MAX_BYTES)
    }

    @Test fun theWaitForListsIsBoundedAndShorterThanTheWholeBudget() {
        assertEquals(PreviewPlan.Wait.READY, PreviewPlan.wait(true, true, 10))
        assertEquals(PreviewPlan.Wait.WAIT, PreviewPlan.wait(true, false, 100))
        assertEquals(PreviewPlan.Wait.WAIT, PreviewPlan.wait(false, false, 100))
        assertEquals(PreviewPlan.Wait.LISTS_TIMED_OUT, PreviewPlan.wait(true, false, PreviewPlan.LISTS_MS + 1))
        assertEquals(PreviewPlan.Wait.NOT_APPLIED, PreviewPlan.wait(false, false, PreviewPlan.LISTS_MS + 1))
        // Late lists still count as ready; the core gives up on a preview after 7 s.
        assertEquals(PreviewPlan.Wait.READY, PreviewPlan.wait(true, true, PreviewPlan.LISTS_MS + 500))
        assertTrue(PreviewPlan.LISTS_MS < PreviewPlan.TIMEOUT_MS)
        assertTrue(PreviewPlan.TIMEOUT_MS < 7000)
    }

    @Test fun theReportEntryNamesThePictureItsSizeAndTheme() {
        val png = byteArrayOf(1, 2, 3)
        val seen = ArrayList<ByteArray>()
        val dark = PreviewPlan.shot(png, 720, 385, true, 363.2f, 192.6f) { seen.add(it); "AQID" }
        assertEquals("AQID", dark.getString("png"))
        assertEquals(720, dark.getInt("width")); assertEquals(385, dark.getInt("height"))
        assertEquals("dark", dark.getString("theme"))
        assertEquals(363, dark.getJSONObject("dp").getInt("width")); assertEquals(193, dark.getJSONObject("dp").getInt("height"))
        assertSame(png, seen.single())
        assertEquals("light", PreviewPlan.shot(png, 1, 1, false, 1f, 1f) { "" }.getString("theme"))
    }

    @Test fun thePushedStateNamesTheCardsToPreview() {
        val card = JSONObject().put("id", "w").put("title", "t").put("size", "4x2").put("owner", "agent:main").put("updated_at", 5)
            .put("a2ui", JSONObject().put("root", "root").put("components", org.json.JSONArray().put(JSONObject().put("id", "root").put("component", "Text").put("text", "hi"))))
        val body = JSONObject().put("revision", 1).put("cards", org.json.JSONArray().put(card)).put("bindings", JSONObject())
        assertTrue(WidgetPlan.parseState(body).previews.isEmpty())
        val asked = WidgetPlan.parseState(body.put("previews", JSONObject().put("w", 3).put("bad", -1)))
        assertEquals(mapOf("w" to 3L), asked.previews)
        assertEquals("w", asked.cards.keys.single())
    }
}
