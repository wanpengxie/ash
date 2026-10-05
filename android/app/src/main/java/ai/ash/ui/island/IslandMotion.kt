package ai.ash.ui.island

/**
 * How the island moves between states. The reference fixes the look of each state and its own marks; the transitions
 * between states follow the platforms' established patterns instead:
 *  - capsule <-> card: one spring drives width, height and corner radius together (iOS Dynamic Island; bouncier
 *    when it opens than when it closes). Material container transform for the content: the avatar is a shared element
 *    that morphs between its two places; both contents scale with the container (fit to width) and fade through (the
 *    outgoing leaves just before the incoming arrives, so two texts never overlap); they travel with it and, with
 *    the avatar staying, no frame shows an empty island.
 *  - changed text cross-fades; a changed mark shrinks out as the new one grows in (SF Symbols replace); colours blend.
 *  - a card whose content grows or shrinks springs to its new height without bounce (animateContentSize).
 *  - appearing, the island springs out of the top centre; leaving, it shrinks back into it.
 *  - with reduced motion: short cross-fades only, no spring, scale or blur (iOS Reduce Motion).
 */
internal object IslandMotion {
    // Springs (androidx SpringAnimation): stiffness ~ (2π / response)^2 for a response of ~0.45s (open) and ~0.38s.
    const val OPEN_STIFFNESS = 200f; const val OPEN_DAMPING = 0.78f
    const val CLOSE_STIFFNESS = 280f; const val CLOSE_DAMPING = 0.92f
    const val RESIZE_STIFFNESS = 400f; const val RESIZE_DAMPING = 1f
    const val APPEAR_STIFFNESS = 260f; const val APPEAR_DAMPING = 0.72f
    const val APPEAR_FROM_SCALE = 0.6f
    // Fade through within a morph: the outgoing content is gone by 130ms; the incoming starts at 50ms and takes 210ms.
    const val OUT_MS = 100L; const val IN_DELAY_MS = 40L; const val IN_MS = 200L
    // Closing, the height reaches the capsule's by this share of the spring's progress.
    const val CLOSE_HEIGHT_LEAD = 0.6f
    // Text and marks changing in place.
    const val TEXT_OUT_MS = 160L; const val TEXT_IN_MS = 200L; const val TEXT_IN_DELAY_MS = 40L
    const val MARK_MS = 220L; const val COLOUR_MS = 200L
    const val LEAVE_MS = 180L
    const val REDUCED_FADE_MS = 150L
}
