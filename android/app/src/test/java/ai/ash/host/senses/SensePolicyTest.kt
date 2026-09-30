package ai.ash.host.senses

import org.junit.Assert.*
import org.junit.Test

class SensePolicyTest {
    @Test fun batteryHysteresis() {
        assertFalse(SensePolicy.lowBattery(15, true))
        assertTrue(SensePolicy.lowBattery(14, true))
        for (level in listOf(14, 15, 16, 14)) assertFalse(SensePolicy.lowBattery(level, false))
        assertFalse(SensePolicy.batteryArmed(16, false))
        assertTrue(SensePolicy.batteryArmed(17, false))
        assertTrue(SensePolicy.lowBattery(14, SensePolicy.batteryArmed(17, false)))
        assertFalse(SensePolicy.lowBattery(-1, true))
    }

    @Test fun screenAwayIsNeverNegative() {
        assertEquals(0, SensePolicy.awayMs(100, 0))
        assertEquals(0, SensePolicy.awayMs(100, 101))
        assertEquals(70, SensePolicy.awayMs(100, 30))
    }

    @Test fun calendarWindowAndReminder() {
        val now = 1_000_000_000L
        assertTrue(SensePolicy.inWindow(now + 1_000, now + 2_000, now))
        assertFalse(SensePolicy.inWindow(now + SensePolicy.DAY_MS, now + SensePolicy.DAY_MS + 1_000, now))
        assertEquals(now + 1_000, SensePolicy.reminderAt(now + SensePolicy.REMINDER_LEAD_MS + 1_000, now))
        assertNull(SensePolicy.reminderAt(now + SensePolicy.REMINDER_LEAD_MS, now))
        assertTrue(SensePolicy.due(now + SensePolicy.REMINDER_LEAD_MS, now))
        assertFalse(SensePolicy.due(now, now))
        assertEquals(now + 6 * 60 * 60 * 1000L, SensePolicy.nextScanAt(now))
        // Even an empty first scan has a future alarm; a later scan discovers an
        // unchanged event that has since entered the rolling 24-hour window.
        val futureStart = now + SensePolicy.DAY_MS + 1_000
        assertFalse(SensePolicy.inWindow(futureStart, futureStart + 1_000, now))
        val nextScan = SensePolicy.nextScanAt(now)
        assertTrue(SensePolicy.inWindow(futureStart, futureStart + 1_000, nextScan))
    }
}
