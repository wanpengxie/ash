package ai.ash.senses

import ai.ash.senses.LocationPolicy.Background
import ai.ash.senses.LocationPolicy.Candidate
import ai.ash.senses.LocationPolicy.Mode
import ai.ash.senses.LocationPolicy.Providers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Which providers are asked and when a fix is good enough, without a phone. */
class LocationPolicyTest {
    private val all = setOf("fused", "gps", "network", "passive")
    /** The owner's phone: location on (high accuracy), but only the network provider allowed; GPS switched off. */
    private val networkOnly = Providers(all, setOf("fused", "network", "passive"), precise = true)
    private val everything = Providers(all, all, precise = true)

    private fun fix(accuracy: Double, provider: String = "network", ts: Long = 1_800_000_000_000L) = Fix(ts, 31.2, 121.4, accuracy, provider, false, null)
    private fun c(accuracy: Double, age: Long = 1_000, provider: String = "network") = Candidate(fix(accuracy, provider), age)

    @Test fun onDemandAsksEveryUsableProviderAndSaysWhyGpsIsMissing() {
        val plan = LocationPolicy.plan(networkOnly, "high", Mode.ON_DEMAND)
        assertEquals(listOf("fused", "network"), plan.ask)
        assertEquals(mapOf("gps" to LocationPolicy.DISABLED), plan.skipped)
        assertTrue(LocationPolicy.explainAll(plan.skipped, 30).contains("gps: switched off by the system"))
        assertEquals(listOf("gps", "fused", "network"), LocationPolicy.plan(everything, "high", Mode.ON_DEMAND).ask)
        assertEquals(listOf("fused", "network", "gps"), LocationPolicy.plan(everything, "balanced", Mode.ON_DEMAND).ask)
        // Low accuracy does not switch GPS on while anything else can answer.
        assertEquals(listOf("network", "fused"), LocationPolicy.plan(everything, "low", Mode.ON_DEMAND).ask)
        assertEquals(listOf("gps"), LocationPolicy.plan(Providers(setOf("gps"), setOf("gps"), true), "low", Mode.ON_DEMAND).ask)
    }

    @Test fun backgroundAsksOneProviderAndTheFallbackLeavesGpsOutUnlessHighIsAsked() {
        assertEquals(listOf("fused"), LocationPolicy.plan(everything, "balanced", Mode.BACKGROUND).ask)
        assertEquals(listOf("gps"), LocationPolicy.plan(everything, "high", Mode.BACKGROUND).ask)
        assertEquals(listOf("fused", "network"), LocationPolicy.plan(everything, "balanced", Mode.BACKGROUND_FALLBACK).ask)
        assertEquals(listOf("gps", "fused", "network"), LocationPolicy.plan(everything, "high", Mode.BACKGROUND_FALLBACK).ask)
        // On the owner's phone "high" in the background is the fused provider (GPS is off), the one that never answered.
        assertEquals(listOf("fused"), LocationPolicy.plan(networkOnly, "high", Mode.BACKGROUND).ask)
    }

    @Test fun gpsNeedsPreciseLocationAndAbsentProvidersAreNamed() {
        val coarse = Providers(setOf("gps", "network"), setOf("gps", "network"), precise = false)
        val plan = LocationPolicy.plan(coarse, "high", Mode.ON_DEMAND)
        assertEquals(listOf("network"), plan.ask)
        assertEquals(mapOf("fused" to LocationPolicy.NOT_PRESENT, "gps" to LocationPolicy.NOT_ALLOWED), plan.skipped)
        val none = LocationPolicy.plan(Providers(setOf("gps", "network"), emptySet(), true), "balanced", Mode.ON_DEMAND)
        assertTrue(none.ask.isEmpty())
        assertEquals(setOf("fused", "gps", "network"), none.skipped.keys)
    }

    @Test fun theOwnerIsToldInChineseWhenGpsIsOff() {
        assertTrue(LocationPolicy.ownerNote(networkOnly)!!.startsWith("GPS 被系统关闭了"))
        assertNull(LocationPolicy.ownerNote(everything))
        assertEquals("系统没有打开任何定位方式，取不到位置", LocationPolicy.ownerNote(Providers(all, emptySet(), true)))
    }

    @Test fun aFreshAccurateLastKnownFixIsTakenAndAStaleOneIsNot() {
        val best = LocationPolicy.lastKnown(listOf(c(40.0, 30_000), c(12.0, 90_000, "gps"), c(5.0, 10 * 60_000L, "gps")))
        assertEquals(12.0, best!!.fix.accuracyM, 0.0)
        assertNull(LocationPolicy.lastKnown(listOf(c(5.0, 3 * 60_000L))))
        // A tie in accuracy goes to the newer fix.
        assertEquals(1_000L, LocationPolicy.better(c(20.0, 5_000), c(20.0, 1_000)).ageMs)
    }

    @Test fun theWaitEndsOnTheTargetTheGraceOrWhenNoProviderIsLeft() {
        val t0 = 1_000_000L
        // Balanced: a 40 m network fix is good enough at once; a 300 m one waits 10 s for better.
        assertTrue(LocationPolicy.done(c(40.0), t0, t0, "balanced", listOf("fused", "network"), 2))
        assertFalse(LocationPolicy.done(c(300.0), t0, t0 + 9_000, "balanced", listOf("fused", "network"), 2))
        assertTrue(LocationPolicy.done(c(300.0), t0, t0 + 10_000, "balanced", listOf("fused", "network"), 2))
        // High with GPS asked: a network fix does not end the wait; GPS has the whole timeout.
        assertFalse(LocationPolicy.done(c(40.0), t0, t0 + 50_000, "high", listOf("gps", "network"), 2))
        assertTrue(LocationPolicy.done(c(8.0, provider = "gps"), t0, t0, "high", listOf("gps", "network"), 2))
        // High with GPS switched off: the best network fix is taken after the grace instead of timing out.
        assertTrue(LocationPolicy.done(c(40.0), t0, t0 + 10_000, "high", listOf("fused", "network"), 2))
        // Low: the first fix.
        assertTrue(LocationPolicy.done(c(900.0), t0, t0, "low", listOf("network"), 1))
        // Nothing yet: wait, unless every provider is gone.
        assertFalse(LocationPolicy.done(null, null, t0, "balanced", listOf("network"), 1))
        assertTrue(LocationPolicy.done(null, null, t0, "balanced", listOf("network"), 0))
    }

    @Test fun backgroundFallsBackAfterRepeatedFailuresAndRetriesTheUsualProviderLater() {
        val now = 1_800_000_000_000L
        var s = Background()
        assertEquals(Mode.BACKGROUND, s.mode(now))
        s = LocationPolicy.after(s, Mode.BACKGROUND, ok = false, now)
        assertEquals(Mode.BACKGROUND, s.mode(now))
        // A fix in between resets the count.
        assertEquals(Background(), LocationPolicy.after(s, Mode.BACKGROUND, ok = true, now))
        s = LocationPolicy.after(s, Mode.BACKGROUND, ok = false, now)
        assertEquals(Mode.BACKGROUND_FALLBACK, s.mode(now))
        // The fallback runs its course whatever it gets.
        assertEquals(s, LocationPolicy.after(s, Mode.BACKGROUND_FALLBACK, ok = true, now + 60_000))
        assertEquals(s, LocationPolicy.after(s, Mode.BACKGROUND_FALLBACK, ok = false, now + 60_000))
        // Twelve hours on, the usual provider gets another chance...
        val later = now + LocationPolicy.FALLBACK_MS
        assertEquals(Mode.BACKGROUND, s.mode(later))
        // ...and one more failure sends it straight back to the fallback; a fix ends it.
        assertEquals(Mode.BACKGROUND_FALLBACK, LocationPolicy.after(s, Mode.BACKGROUND, ok = false, later).mode(later))
        assertEquals(Background(), LocationPolicy.after(s, Mode.BACKGROUND, ok = true, later))
        assertEquals("background_fallback", s.toJson(now).getString("mode"))
    }

    @Test fun anAttemptSaysWhichProviderAnsweredHowWellAndWhyOthersDidNot() {
        val ok = FixAttempt(1L, "on_demand", "high", listOf("fused", "network"), mapOf("gps" to "disabled", "fused" to "timeout"), 12_000,
            fix(35.0), 2_000)
        val j = ok.toJson()
        assertEquals("network", j.getString("provider"))
        assertEquals(35.0, j.getDouble("accuracy_m"), 0.0)
        assertEquals(2L, j.getLong("fix_age_s"))
        assertFalse(j.getBoolean("accuracy_met"))
        assertEquals("live", j.getString("source"))
        assertEquals("timeout", j.getJSONObject("provider_reasons").getString("fused"))
        val failed = FixAttempt(1L, "background", "balanced", listOf("fused"), mapOf("fused" to "timeout"), 30_000, error = "no_fix: x").toJson()
        assertFalse(failed.getBoolean("ok"))
        assertFalse(failed.has("provider"))
    }
}
