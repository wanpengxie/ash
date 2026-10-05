package ai.ash.host

import org.junit.Assert.*
import org.junit.Test

class CapsuleWindowFenceTest {
    private val app = ScreenWindowFact(1, "Clock", true, true, "0,0,1080,2400")
    private val capsule = ScreenWindowFact(2, "AshTaskCapsule", false, false, "20,300,650,400")
    @Test fun capsuleUpdatesRemovalAndUnattributedTopologyDoNotLookLikeUserFocus() {
        val f = CapsuleWindowFence()
        assertFalse(f.presentationOnly(1, listOf(app), true))
        assertTrue(f.presentationOnly(2, listOf(app, capsule), true))
        assertTrue(f.presentationOnly(2, listOf(app, capsule), false))
        assertTrue(f.presentationOnly(-1, listOf(app), true))
        assertTrue(f.presentationOnly(2, listOf(app), true))
        assertFalse(f.presentationOnly(1, listOf(app), false)) // real taps/content still invalidate
    }
    @Test fun foregroundChangesAndOtherOverlaysRemainRelevant() {
        val f = CapsuleWindowFence(); f.presentationOnly(1, listOf(app, capsule), true)
        assertFalse(f.presentationOnly(-1, listOf(app.copy(focused = false), ScreenWindowFact(3, "Settings", true, true, app.bounds)), true))
        assertFalse(f.presentationOnly(4, listOf(app, ScreenWindowFact(4, "Other overlay", false, false, "10,10,100,100")), true))
    }
    @Test fun passiveNotificationUpdatesAreNotUserFocusButOpeningTheShadeIs() {
        val f = CapsuleWindowFence()
        val bar = ScreenWindowFact(4, "Status bar", false, false, "0,0,1080,136")
        assertTrue(f.presentationOnly(4, listOf(app, bar), false, true))
        assertFalse(f.presentationOnly(1, listOf(app, bar), false, true))
        assertFalse(f.presentationOnly(4, listOf(app.copy(focused = false), bar.copy(focused = true, active = true)), true))
        assertFalse(f.presentationOnly(-1, listOf(app, bar), false, true)) // unknown source stays conservative
    }
}
