package ai.ash.apps

import ai.ash.apps.Ui.Edges
import ai.ash.ui.OnboardingPlan
import org.junit.Assert.assertEquals
import org.junit.Test

class UiInsetsTest {
    private val statusAndNav = Edges(0, 100, 0, 126)

    @Test fun withoutKeyboardTheBarsAreKept() {
        assertEquals(statusAndNav, Ui.fit(statusAndNav, Edges.NONE, Edges.NONE))
    }

    @Test fun theKeyboardCoversTheNavigationBarInsteadOfAddingToIt() {
        // The keyboard is 900 tall including the area behind the navigation bar: the bottom is 900, not 900 + 126.
        assertEquals(Edges(0, 100, 0, 900), Ui.fit(statusAndNav, Edges.NONE, Edges(0, 0, 0, 900)))
    }

    @Test fun aLowKeyboardNeverReachesLessThanTheNavigationBar() {
        assertEquals(126, Ui.fit(statusAndNav, Edges.NONE, Edges(0, 0, 0, 40)).bottom)
    }

    @Test fun theCutoutWidensTheSidesInLandscape() {
        val landscapeBars = Edges(0, 48, 0, 48)
        assertEquals(Edges(120, 48, 0, 48), Ui.fit(landscapeBars, Edges(120, 0, 0, 0), Edges.NONE))
    }

    @Test fun theTopFollowsTheTallerOfBarAndCutout() {
        assertEquals(130, Ui.fit(statusAndNav, Edges(0, 130, 0, 0), Edges.NONE).top)
    }

    @Test fun anOnboardingRowSaysOnlyItsOwnWords() {
        assertEquals("⚪️ 精确闹钟\n让日历提醒准时响起", OnboardingPlan.rowText("⚪️", "精确闹钟", "让日历提醒准时响起"))
        assertEquals("✅ 位置", OnboardingPlan.rowText("✅", "位置", ""))
    }

    @Test fun aDeckIsMovedOnlyByWhatTheKeyboardAddsOverTheKeptBottom() {
        assertEquals(774, Ui.keyboardOver(126, 900))
        assertEquals("a floating or tiny keyboard moves nothing", 0, Ui.keyboardOver(126, 40))
        assertEquals(0, Ui.keyboardOver(126, 0))
    }
}
