package ai.ash.senses

import ai.ash.senses.LocationPolicy.Candidate
import ai.ash.senses.LocationPolicy.Mode
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.location.LocationRequest
import android.os.Build
import android.os.Bundle
import android.os.HandlerThread
import android.os.PowerManager
import android.os.SystemClock
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Location fixes from the framework's LocationManager (no Google Play services): the fused provider where the phone
 * has one, GPS and the network provider. Which ones are asked, and when a fix is good enough, is [LocationPolicy]'s.
 * It never answers with a made-up or stale position: no fix in time is an error that says, per provider, why.
 */
object LocationReader {
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "senses-location") }
    private val thread by lazy { HandlerThread("senses-location-looper").apply { start() } }

    /** A point older than this is not "now". */
    const val FRESH_MS = LocationPolicy.FRESH_MS

    class Result(val fix: Fix, val attempt: FixAttempt)

    /** The most recent attempt (any mode), for sense.status. */
    @Volatile var lastAttempt: FixAttempt? = null
        private set

    fun providers(ctx: Context): LocationPolicy.Providers {
        val lm = ctx.getSystemService(LocationManager::class.java)
        val present = runCatching { lm.allProviders.toSet() }.getOrDefault(emptySet())
        val enabled = present.filter { runCatching { lm.isProviderEnabled(it) }.getOrDefault(false) }.toSet()
        return LocationPolicy.Providers(present, enabled, Senses.preciseLocation(ctx))
    }

    /**
     * One fix: a fresh last-known fix that is accurate enough answers at once (no power spent); otherwise the
     * providers [LocationPolicy.plan] picks are asked together until one is good enough, the grace after the first
     * fix runs out, or [timeoutMs] passes. [cancelled] stops the wait early (recording was turned off). Throws [SenseError].
     */
    fun fix(ctx: Context, accuracy: String, timeoutMs: Long, mode: Mode = Mode.ON_DEMAND, cancelled: () -> Boolean = { false }): Result {
        val started = System.currentTimeMillis()
        fun fail(code: String, message: String, asked: List<String> = emptyList(), reasons: Map<String, String> = emptyMap()): Nothing {
            record(FixAttempt(started, mode.id, accuracy, asked, reasons, System.currentTimeMillis() - started, error = "$code: $message"))
            throw SenseError(code, message)
        }
        if (!Senses.locationPermission(ctx)) fail("permission_denied", "location permission is not granted to Ash 感知 (open its setup page)")
        if (!Senses.locationOn(ctx)) fail("location_off", "location is turned off in the phone's settings")
        val lm = ctx.getSystemService(LocationManager::class.java)
        val providers = providers(ctx)
        val plan = LocationPolicy.plan(providers, accuracy, mode)
        val timeoutS = timeoutMs / 1000

        val known = LocationPolicy.lastKnown(lastKnown(lm, providers.present))
        if (known != null && (known.fix.accuracyM <= LocationPolicy.target(accuracy) || plan.ask.isEmpty())) {
            val attempt = FixAttempt(started, mode.id, accuracy, emptyList(), plan.skipped, System.currentTimeMillis() - started, known.fix, known.ageMs, fromLastKnown = true)
            record(attempt)
            return Result(known.fix, attempt)
        }
        if (plan.ask.isEmpty()) fail("no_fix", "no location provider can be used: ${LocationPolicy.explainAll(plan.skipped, timeoutS)}", reasons = plan.skipped)

        val lock = Object()
        var best: Candidate? = known
        var firstAt: Long? = null
        var fromLastKnown = known != null
        val answered = mutableSetOf<String>()
        val failed = linkedMapOf<String, String>()
        val listeners = mutableListOf<LocationListener>()
        val wake = ctx.getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ash.senses:fix")
        wake.acquire(timeoutMs + 5_000)
        try {
            for (provider in plan.ask) {
                val l = object : LocationListener {
                    override fun onLocationChanged(loc: Location) {
                        val c = Candidate(toFix(loc, provider), age(loc))
                        if (c.ageMs > FRESH_MS) return
                        synchronized(lock) {
                            answered += provider
                            if (firstAt == null) firstAt = System.currentTimeMillis()
                            val next = LocationPolicy.better(best, c)
                            if (next !== best) { best = next; fromLastKnown = false }
                            lock.notifyAll()
                        }
                    }
                    @Deprecated("") override fun onStatusChanged(p: String?, s: Int, e: Bundle?) {}
                    override fun onProviderEnabled(p: String) {}
                    override fun onProviderDisabled(p: String) { synchronized(lock) { failed[provider] = LocationPolicy.DISABLED_WHILE_WAITING; lock.notifyAll() } }
                }
                try {
                    request(lm, provider, accuracy, l)
                    listeners += l
                } catch (e: SecurityException) {
                    failed[provider] = LocationPolicy.REFUSED
                } catch (e: IllegalArgumentException) {
                    failed[provider] = LocationPolicy.NOT_PRESENT
                }
            }
            val deadline = started + timeoutMs
            synchronized(lock) {
                while (true) {
                    val now = System.currentTimeMillis()
                    val listening = plan.ask.count { it !in failed }
                    if (now >= deadline || LocationPolicy.done(best, firstAt ?: known?.let { started }, now, accuracy, plan.ask, listening)) break
                    if (cancelled()) fail("not_recording", "recording was turned off", plan.ask, failed)
                    lock.wait(minOf(500L, deadline - now).coerceAtLeast(1L))
                }
            }
        } finally {
            for (l in listeners) runCatching { lm.removeUpdates(l) }
            if (wake.isHeld) wake.release()
        }

        val reasons = synchronized(lock) {
            linkedMapOf<String, String>().apply {
                putAll(plan.skipped)
                for (p in plan.ask) if (p !in answered) put(p, failed[p] ?: LocationPolicy.TIMEOUT)
            }
        }
        val waited = System.currentTimeMillis() - started
        val chosen = synchronized(lock) { best }
        if (chosen != null) {
            val attempt = FixAttempt(started, mode.id, accuracy, plan.ask, reasons, waited, chosen.fix, chosen.ageMs, synchronized(lock) { fromLastKnown })
            record(attempt)
            return Result(chosen.fix, attempt)
        }
        if (!Senses.locationOn(ctx)) fail("location_off", "location was turned off", plan.ask, reasons)
        val background = if (!Senses.backgroundLocation(ctx)) " (background location is not allowed: with the phone locked or Ash 感知 not in front, the system gives no fix; set location to 「始终允许」)" else ""
        fail("no_fix", "no location fix within ${timeoutS}s: ${LocationPolicy.explainAll(reasons, timeoutS)}$background", plan.ask, reasons)
    }

    private fun request(lm: LocationManager, provider: String, accuracy: String, l: LocationListener) {
        if (Build.VERSION.SDK_INT >= 31) {
            val quality = when (accuracy) {
                "high" -> LocationRequest.QUALITY_HIGH_ACCURACY
                "low" -> LocationRequest.QUALITY_LOW_POWER
                else -> LocationRequest.QUALITY_BALANCED_POWER_ACCURACY
            }
            lm.requestLocationUpdates(provider, LocationRequest.Builder(1_000L).setQuality(quality).build(), executor, l)
        } else {
            lm.requestLocationUpdates(provider, 1_000L, 0f, l, thread.looper)
        }
    }

    /** Each present provider's last known fix (free: nothing is switched on), with its age. */
    private fun lastKnown(lm: LocationManager, present: Set<String>): List<Candidate> =
        listOf(LocationPolicy.FUSED, LocationPolicy.GPS, LocationPolicy.NETWORK, LocationPolicy.PASSIVE).filter { it in present }.mapNotNull { p ->
            runCatching { lm.getLastKnownLocation(p) }.getOrNull()?.let { Candidate(toFix(it, p), age(it)) }
        }

    /** How old a fix is, by the phone's elapsed clock (a fix's own wall-clock time can be off). */
    private fun age(loc: Location): Long {
        val nanos = loc.elapsedRealtimeNanos
        return if (nanos > 0) (SystemClock.elapsedRealtimeNanos() - nanos) / 1_000_000 else System.currentTimeMillis() - loc.time
    }

    private fun record(attempt: FixAttempt) {
        lastAttempt = attempt
        runCatching { Senses.prefs().edit().putString("location_last_attempt", attempt.toJson().toString()).apply() }
    }

    /** What sense.status says about location: each provider, the last attempt and how background recording asks. */
    fun status(ctx: Context): JSONObject {
        val now = System.currentTimeMillis()
        val last = lastAttempt?.toJson() ?: Senses.prefs(ctx).getString("location_last_attempt", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        return JSONObject().put("providers", providers(ctx).toJson())
            .put("background", background(ctx).toJson(now))
            .apply {
                if (last != null) put("last_attempt", last)
                Senses.store.lastFix()?.let { put("last_recorded_fix", JSONObject().put("ts", it.ts).put("provider", it.provider).put("accuracy_m", it.accuracyM)
                    .put("age_s", (now - it.ts) / 1000)) }
            }
    }

    fun background(ctx: Context): LocationPolicy.Background {
        val p = Senses.prefs(ctx)
        return LocationPolicy.Background(p.getInt("location_bg_failures", 0), p.getLong("location_bg_fallback_since", 0L))
    }

    fun saveBackground(ctx: Context, state: LocationPolicy.Background) {
        Senses.prefs(ctx).edit().putInt("location_bg_failures", state.failures).putLong("location_bg_fallback_since", state.fallbackSince).apply()
    }

    fun toFix(loc: Location, provider: String): Fix {
        val mocked = if (Build.VERSION.SDK_INT >= 31) loc.isMock else @Suppress("DEPRECATION") loc.isFromMockProvider
        return Fix(loc.time, loc.latitude, loc.longitude, if (loc.hasAccuracy()) loc.accuracy.toDouble() else 9999.0,
            loc.provider ?: provider, mocked, if (loc.hasSpeed()) loc.speed.toDouble() else null)
    }
}
