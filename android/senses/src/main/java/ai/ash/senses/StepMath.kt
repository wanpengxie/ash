package ai.ash.senses

/** Steps since local midnight, from the counter's snapshots. [complete] is false when the first snapshot came after midnight. */
data class StepsToday(val steps: Long, val since: Long, val complete: Boolean)

object StepMath {
    /**
     * The phone's step counter only counts up from boot. Between two snapshots of one boot the difference is walked;
     * after a reboot the new count is all new. A gap that straddles midnight counts only its share after midnight.
     */
    fun today(snapshots: List<StepSample>, dayStart: Long, now: Long): StepsToday? {
        val s = snapshots.filter { it.ts <= now }.sortedBy { it.ts }
        val firstToday = s.indexOfFirst { it.ts >= dayStart }
        if (firstToday < 0) return null
        val base = firstToday - 1
        var total = 0.0
        var since = s[firstToday].ts
        var complete = false
        if (base >= 0) {
            since = dayStart; complete = true
        }
        val start = if (base >= 0) base else firstToday
        for (i in start + 1 until s.size) {
            val a = s[i - 1]; val b = s[i]
            val delta = if (b.boot != a.boot || b.counter < a.counter) b.counter.toDouble() else (b.counter - a.counter).toDouble()
            total += if (a.ts < dayStart) delta * (b.ts - dayStart).toDouble() / (b.ts - a.ts).coerceAtLeast(1) else delta
        }
        return StepsToday(Math.round(total), since, complete)
    }
}
