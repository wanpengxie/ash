package ai.ash.screen.island

import org.junit.Assert.*
import org.junit.Test

class IslandPillTest {
    // A 1080 px wide phone at 2.75x with a centred hole punch (Pixel-like), status bar 136 px.
    private val density = 2.75f
    private fun px(dp: Float) = Math.round(dp * density)
    private val hole = intArrayOf(507, 33, 573, 99)

    @Test fun huggingPillIsCentredOnTheCutoutAndOneDpOfPaddingAroundIt() {
        val g = IslandPill.geometry(1080, 136, hole, density, overStatusBar = true)
        assertTrue(g.hugging)
        assertEquals(540, g.centreX)
        assertEquals(33 - px(4f), g.top)
        assertEquals(99 + px(4f), g.top + g.height)
        // The gap is the cutout plus 2dp each side, and even so the pill sits on whole pixels.
        assertTrue(g.gap >= 66 + 2 * px(2f)); assertEquals(0, g.gap % 2)
        for (segment in listOf(IslandPill.resident(g, density), IslandPill.segment(Int.MAX_VALUE, g, density))) {
            val left = IslandPill.left(segment, g); val width = IslandPill.width(segment, g)
            // Both segments equally wide around the gap: the gap (and the camera) is exactly in the middle.
            assertEquals(g.centreX, left + width / 2)
            assertTrue("left segment ends before the camera", left + segment <= hole[0])
            assertTrue("right segment starts after the camera", left + segment + g.gap >= hole[2])
        }
    }

    @Test fun residentAndRunningSegmentWidths() {
        val g = IslandPill.geometry(1080, 136, hole, density, overStatusBar = true)
        assertEquals(px(28f), IslandPill.resident(g, density))
        // A running segment grows with what it shows, from the resident width up to 88dp.
        assertEquals(px(28f), IslandPill.segment(10, g, density))
        assertEquals(150, IslandPill.segment(150, g, density))
        assertEquals(px(88f), IslandPill.segment(1000, g, density))
        assertEquals(2 * px(88f) + g.gap, IslandPill.widest(g, density))
    }

    @Test fun aWideNotchLimitsSegmentsToTheScreen() {
        // A notch 600 px wide on a 1080 px screen: 240 px either side, less the edge margin.
        val g = IslandPill.geometry(1080, 136, intArrayOf(240, 0, 840, 90), density, overStatusBar = true)
        assertTrue(g.hugging)
        assertEquals(0, g.top)
        val most = IslandPill.segment(Int.MAX_VALUE, g, density)
        assertTrue(most < px(88f))
        assertTrue(IslandPill.left(most, g) >= 0)
        assertTrue(IslandPill.left(most, g) + IslandPill.width(most, g) <= 1080)
    }

    @Test fun noCutoutCornerCutoutOrBelowTheStatusBarFallsBackToTheTopCentre() {
        val none = IslandPill.geometry(1080, 136, null, density, overStatusBar = true)
        assertFalse(none.hugging); assertEquals(0, none.gap); assertEquals(540, none.centreX)
        assertEquals(px(28f), none.height); assertEquals((136 - px(28f)) / 2, none.top)
        // A camera in the corner leaves no room for a segment on its left.
        val corner = IslandPill.geometry(1080, 136, intArrayOf(30, 30, 90, 90), density, overStatusBar = true)
        assertFalse(corner.hugging); assertEquals(540, corner.centreX)
        // A window kept below the status bar never hugs: the pill sits at the top of its own window.
        val below = IslandPill.geometry(1080, 136, hole, density, overStatusBar = false)
        assertFalse(below.hugging); assertEquals(0, below.top); assertEquals(0, below.gap)
        val seg = IslandPill.resident(below, density)
        assertEquals(540 - seg, IslandPill.left(seg, below)); assertEquals(2 * seg, IslandPill.width(seg, below))
    }

    @Test fun aTinyHoleStillGetsAPillTallEnoughForTheFace() {
        val g = IslandPill.geometry(1080, 136, intArrayOf(530, 20, 550, 40), density, overStatusBar = true)
        assertTrue(g.hugging)
        assertTrue(g.height >= px(24f))
    }
}
