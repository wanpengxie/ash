package ai.ash.senses

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ActivityClassifierTest {
    private val now = 1_800_000_000_000L
    private val min = 60_000L

    /** Step-counter snapshots over the last [minutes] at [perMinute] steps a minute. */
    private fun steps(perMinute: Int, minutes: Int = 4, boot: Int = 1) =
        (0..minutes).map { StepSample(now - (minutes - it) * min, 10_000L + it * perMinute.toLong(), boot) }

    private fun fixes(vararg speeds: Double) = speeds.mapIndexed { i, s -> FixSample(now - (speeds.size - i) * min, 31.0, 121.0, 10.0, s) }

    private fun state(fixes: List<FixSample> = emptyList(), steps: List<StepSample> = emptyList(), motion: Long? = null, previous: String? = null) =
        ActivityClassifier.classify(now, fixes, steps, motion, previous).state

    @Test fun nothingMeansStill() = assertEquals("still", state())

    @Test fun cadenceDecidesOnFoot() {
        assertEquals("walking", state(steps = steps(100)))
        assertEquals("running", state(steps = steps(165)))
        assertEquals("walking", state(steps = steps(100), fixes = fixes(1.4, 1.5)))
    }

    @Test fun aFewStrayStepsAreNotWalking() = assertEquals("still", state(steps = steps(5), fixes = fixes(0.1, 0.2)))

    @Test fun withoutStepsSpeedDecides() {
        assertEquals("still", state(fixes = fixes(0.2, 0.0, 0.4)))
        assertEquals("walking", state(fixes = fixes(1.3, 1.5)))
        assertEquals("cycling", state(fixes = fixes(4.5, 5.2, 4.8)))
        assertEquals("in_vehicle", state(fixes = fixes(14.0, 16.0)))
        // A slow stretch of a drive is still a drive when the peak was fast.
        assertEquals("in_vehicle", state(fixes = fixes(3.0, 4.0, 13.0)))
    }

    @Test fun stepsAtVehicleSpeedAreAVehicle() = assertEquals("in_vehicle", state(steps = steps(60), fixes = fixes(15.0, 17.0)))

    @Test fun speedIsDerivedFromPointsWhenNotReported() {
        // 1.5 km in 5 minutes = 5 m/s: cycling.
        val a = FixSample(now - 5 * min, 31.0, 121.0, 10.0)
        val b = FixSample(now, 31.0 + 1500.0 / 111_195.0, 121.0, 10.0)
        assertEquals("cycling", state(fixes = listOf(a, b)))
        // Within the points' uncertainty: not moving.
        val c = FixSample(now, 31.0 + 15.0 / 111_195.0, 121.0, 10.0)
        assertEquals("still", state(fixes = listOf(a, c)))
    }

    @Test fun inaccurateAndOldPointsAreIgnored() {
        val vague = listOf(FixSample(now - min, 31.0, 121.0, 500.0, 20.0))
        assertEquals("still", state(fixes = vague))
        val old = listOf(FixSample(now - 60 * min, 31.0, 121.0, 10.0, 20.0))
        assertEquals("still", state(fixes = old))
    }

    @Test fun recentMotionKeepsTheLastMovingState() {
        assertEquals("cycling", state(motion = now - min, previous = "cycling"))
        assertEquals("still", state(motion = now - 20 * min, previous = "cycling"))
        assertEquals("still", state(motion = now - min, previous = "still"))
    }

    @Test fun cadenceNeedsAMinuteInOneBoot() {
        assertNull(ActivityClassifier.cadence(now, listOf(StepSample(now - 10_000, 100, 1), StepSample(now, 130, 1))))
        val acrossBoot = listOf(StepSample(now - 4 * min, 50_000, 1), StepSample(now - 3 * min, 10, 2), StepSample(now, 310, 2))
        assertEquals(100.0, ActivityClassifier.cadence(now, acrossBoot)!!, 0.01)
    }

    @Test fun debounceWaitsBeforeCallingAStop() {
        val d = ActivityDebounce()
        assertEquals("walking", d.next("walking", now))
        assertNull(d.next("walking", now + min))
        assertNull(d.next("still", now + 2 * min))
        assertNull(d.next("still", now + 4 * min))
        assertEquals("still", d.next("still", now + 5 * min))
        assertEquals("cycling", d.next("cycling", now + 6 * min))
        // A red light: still for a minute, then moving again, is no stop.
        assertNull(d.next("still", now + 7 * min))
        assertNull(d.next("cycling", now + 8 * min))
        assertNull(d.next("still", now + 9 * min))
    }

    @Test fun firstGuessIsTakenAsIs() = assertEquals("still", ActivityDebounce().next("still", now))
}
