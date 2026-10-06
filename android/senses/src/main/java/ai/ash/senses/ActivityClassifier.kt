package ai.ash.senses

import kotlin.math.max

/** still | walking | running | cycling | in_vehicle */
object ActivityState {
    const val STILL = "still"
    const val WALKING = "walking"
    const val RUNNING = "running"
    const val CYCLING = "cycling"
    const val IN_VEHICLE = "in_vehicle"
    val all = listOf(STILL, WALKING, RUNNING, CYCLING, IN_VEHICLE)
}

/** A location point as the classifier needs it: [speed] in m/s when the provider reported one. */
data class FixSample(val ts: Long, val lat: Double, val lon: Double, val accuracyM: Double, val speed: Double? = null)

/** The step counter's running total at [ts] (it counts from boot; [boot] tells boots apart). */
data class StepSample(val ts: Long, val counter: Long, val boot: Int = 0)

data class ActivityGuess(val state: String, val cadence: Double?, val speed: Double?, val basis: String)

/**
 * What the owner is doing, from what the phone can tell without Google's activity recognition: the step cadence of
 * the last few minutes and the speed of recent location points. Pure, so it is tested on its own.
 *
 * Steps decide on foot (a fast cadence is running); without steps, speed decides (cycling has no steps on most phones,
 * a vehicle is faster still). With neither, a recent motion trigger keeps the last state; otherwise still.
 */
object ActivityClassifier {
    const val STEP_WINDOW_MS = 5 * 60_000L
    const val FIX_WINDOW_MS = 15 * 60_000L
    const val MOTION_HOLD_MS = 5 * 60_000L
    const val WALK_CADENCE = 40.0
    const val RUN_CADENCE = 140.0
    const val STILL_SPEED = 1.0
    const val CYCLE_SPEED = 2.2
    const val VEHICLE_SPEED = 8.5
    const val VEHICLE_PEAK = 12.0
    const val MAX_ACCURACY = 100.0

    fun classify(now: Long, fixes: List<FixSample>, steps: List<StepSample>, lastMotion: Long?, previous: String?): ActivityGuess {
        val cadence = cadence(now, steps)
        val speeds = speeds(now, fixes)
        val speed = speeds.takeIf { it.isNotEmpty() }?.let { median(it) }
        val peak = speeds.maxOrNull()
        if (cadence != null && cadence >= WALK_CADENCE) {
            if (speed != null && speed >= VEHICLE_SPEED) return ActivityGuess(ActivityState.IN_VEHICLE, cadence, speed, "steps but vehicle speed")
            return if (cadence >= RUN_CADENCE) ActivityGuess(ActivityState.RUNNING, cadence, speed, "running cadence")
            else ActivityGuess(ActivityState.WALKING, cadence, speed, "walking cadence")
        }
        if (speed != null) {
            val state = when {
                (peak ?: 0.0) >= VEHICLE_PEAK || speed >= VEHICLE_SPEED -> ActivityState.IN_VEHICLE
                speed >= CYCLE_SPEED -> ActivityState.CYCLING
                speed >= STILL_SPEED -> ActivityState.WALKING
                else -> ActivityState.STILL
            }
            return ActivityGuess(state, cadence, speed, "location speed")
        }
        val moving = lastMotion != null && now - lastMotion <= MOTION_HOLD_MS
        if (moving && previous != null && previous != ActivityState.STILL) return ActivityGuess(previous, cadence, null, "motion, no new speed")
        return ActivityGuess(ActivityState.STILL, cadence, null, if (moving) "motion without steps or speed" else "no steps, no motion")
    }

    /** Steps per minute over the last [STEP_WINDOW_MS], or null without two samples a minute apart in one boot. */
    fun cadence(now: Long, steps: List<StepSample>): Double? {
        val recent = steps.filter { it.ts in (now - STEP_WINDOW_MS)..now }.sortedBy { it.ts }
        if (recent.size < 2) return null
        val last = recent.last()
        val first = recent.first { it.boot == last.boot }
        val minutes = (last.ts - first.ts) / 60_000.0
        if (minutes < 1.0) return null
        return max(0L, last.counter - first.counter) / minutes
    }

    /** Reported speeds of usable fixes, or, without any, the speed between the two latest usable fixes. */
    fun speeds(now: Long, fixes: List<FixSample>): List<Double> {
        val usable = fixes.filter { it.ts in (now - FIX_WINDOW_MS)..now && it.accuracyM <= MAX_ACCURACY }.sortedBy { it.ts }
        val reported = usable.mapNotNull { it.speed }.filter { it >= 0 }
        if (reported.isNotEmpty()) return reported
        if (usable.size < 2) return emptyList()
        val a = usable[usable.size - 2]; val b = usable.last()
        val seconds = (b.ts - a.ts) / 1000.0
        if (seconds < 30) return emptyList()
        val d = Geo.distanceM(a.lat, a.lon, b.lat, b.lon)
        // Within the two points' uncertainty, the owner may not have moved at all.
        if (d <= a.accuracyM + b.accuracyM) return listOf(0.0)
        return listOf(d / seconds)
    }

    private fun median(v: List<Double>): Double { val s = v.sorted(); return if (s.size % 2 == 1) s[s.size / 2] else (s[s.size / 2 - 1] + s[s.size / 2]) / 2 }
}

/**
 * Turns guesses into the recorded state: a change to still waits until the owner has been still for [STILL_AFTER_MS]
 * (a red light is not a stop); any other change is taken at once.
 */
class ActivityDebounce(var state: String? = null, var stillSince: Long? = null) {
    /** The new recorded state, or null when it stays. */
    fun next(guess: String, now: Long): String? {
        if (guess != ActivityState.STILL) { stillSince = null; return if (guess != state) guess.also { state = it } else null }
        if (state == null || state == ActivityState.STILL) { stillSince = null; return if (state == null) guess.also { state = it } else null }
        val since = stillSince ?: now.also { stillSince = it }
        if (now - since < STILL_AFTER_MS) return null
        stillSince = null
        state = ActivityState.STILL
        return ActivityState.STILL
    }

    companion object { const val STILL_AFTER_MS = 3 * 60_000L }
}
