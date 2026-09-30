package ai.ash.host.senses

/** Pure decisions; delivery is committed only after the receiver accepts an event. */
internal object SensePolicy {
    const val DAY_MS = 24 * 60 * 60 * 1000L
    const val REMINDER_LEAD_MS = 30 * 60 * 1000L
    const val RESCAN_INTERVAL_MS = 6 * 60 * 60 * 1000L

    fun lowBattery(level: Int, armed: Boolean): Boolean = armed && level in 0..14
    fun batteryArmed(level: Int, armed: Boolean): Boolean = if (level >= 17) true else armed
    fun awayMs(now: Long, lastSeen: Long): Long = if (lastSeen in 1..now) now - lastSeen else 0

    fun inWindow(start: Long, end: Long, now: Long): Boolean = start < now + DAY_MS && end > now
    fun reminderAt(start: Long, now: Long): Long? {
        val at = start - REMINDER_LEAD_MS
        return at.takeIf { it > now && it <= now + DAY_MS }
    }
    fun due(start: Long, now: Long): Boolean = now >= start - REMINDER_LEAD_MS && now < start
    fun nextScanAt(now: Long): Long = now + RESCAN_INTERVAL_MS
}
