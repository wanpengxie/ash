package ai.ash.screen.island

import ai.ash.screen.island.IslandTokens.SIZE_PILL_EDGE_MARGIN
import ai.ash.screen.island.IslandTokens.SIZE_PILL_GAP_PAD
import ai.ash.screen.island.IslandTokens.SIZE_PILL_MIN_H
import ai.ash.screen.island.IslandTokens.SIZE_PILL_NO_CUTOUT_H
import ai.ash.screen.island.IslandTokens.SIZE_PILL_PAD_Y
import ai.ash.screen.island.IslandTokens.SIZE_PILL_RESIDENT_SEGMENT
import ai.ash.screen.island.IslandTokens.SIZE_PILL_RUNNING_SEGMENT_MAX

/**
 * The pill that hugs the camera (docs/island/ISLAND-RESIDENT-DESIGN.md §1), in screen px: one black pill split into a
 * left and a right segment around the cutout, with a gap as wide as the cutout between them. Both segments are always
 * equally wide, so the pill stays centred on the cutout however much it shows, and nothing it shows is ever drawn
 * over the camera. Pure arithmetic, so it is tested on the JVM.
 */
internal object IslandPill {
    /**
     * Where the pill sits: its gap is centred on [centreX] (the pill is `2 * segment + gap` wide), it spans [top] to
     * `top + height`, and each segment may be at most [room] wide. [hugging]: around a camera cutout, over the status bar.
     */
    data class Geometry(val centreX: Int, val top: Int, val height: Int, val gap: Int, val room: Int, val hugging: Boolean)

    /**
     * The pill for a screen [screenWidth] px wide whose status bar is [statusBar] px tall. [cutout] is the camera's
     * bounding rect at the top of the screen (left, top, right, bottom), or null. The pill hugs it when it is drawn
     * over the status bar ([overStatusBar]) and the cutout leaves room for a resident segment on each side; otherwise
     * (no cutout, a corner one, or a window kept below the status bar) it has no gap and sits at the top centre: inside
     * the status bar when it can be drawn over it, else at the top of its own window.
     */
    fun geometry(screenWidth: Int, statusBar: Int, cutout: IntArray?, density: Float, overStatusBar: Boolean): Geometry {
        fun px(dp: Float) = Math.round(dp * density)
        val margin = px(SIZE_PILL_EDGE_MARGIN)
        if (overStatusBar && cutout != null && cutout.size == 4 && cutout[2] > cutout[0] && cutout[3] > cutout[1]) {
            // The gap is even, so the pill (two equal segments around it) is centred on whole pixels.
            var gap = cutout[2] - cutout[0] + 2 * px(SIZE_PILL_GAP_PAD)
            gap += gap % 2
            val gapLeft = (cutout[0] + cutout[2]) / 2 - gap / 2
            val room = minOf(gapLeft, screenWidth - gapLeft - gap) - margin
            if (room >= px(SIZE_PILL_RESIDENT_SEGMENT)) {
                val top = (cutout[1] - px(SIZE_PILL_PAD_Y)).coerceAtLeast(0)
                val height = maxOf(cutout[3] + px(SIZE_PILL_PAD_Y) - top, px(SIZE_PILL_MIN_H))
                return Geometry(gapLeft + gap / 2, top, height, gap, room, true)
            }
        }
        val height = px(SIZE_PILL_NO_CUTOUT_H)
        val top = if (overStatusBar) ((statusBar - height) / 2).coerceAtLeast(0) else 0
        return Geometry(screenWidth / 2, top, height, 0, screenWidth / 2 - margin, false)
    }

    /** A segment with nothing but the face: the resident entry. */
    fun resident(g: Geometry, density: Float): Int = minOf(Math.round(SIZE_PILL_RESIDENT_SEGMENT * density), g.room)

    /** A segment that would show [needed] px: never narrower than the resident one, never wider than the design or the room. */
    fun segment(needed: Int, g: Geometry, density: Float): Int {
        val most = minOf(Math.round(SIZE_PILL_RUNNING_SEGMENT_MAX * density), g.room)
        return needed.coerceIn(minOf(resident(g, density), most), most)
    }

    /** The pill's width with segments [segment] wide. */
    fun width(segment: Int, g: Geometry): Int = 2 * segment + g.gap

    /** The pill's left edge on screen. */
    fun left(segment: Int, g: Geometry): Int = g.centreX - g.gap / 2 - segment

    /** The widest the pill gets here: the window that holds it when it is not a card. */
    fun widest(g: Geometry, density: Float): Int = width(segment(Int.MAX_VALUE, g, density), g)
}
