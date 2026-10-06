package ai.ash.senses

import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.HandlerThread
import android.os.PowerManager
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * One location fix from the framework's LocationManager (no Google Play services): the fused provider on Android 12+
 * where the phone has one, otherwise GPS or the network provider, by the accuracy asked for. It never answers with a
 * made-up or stale position: no fix in time is an error.
 */
object LocationReader {
    private val executor = Executors.newSingleThreadExecutor { Thread(it, "senses-location") }
    private val thread by lazy { HandlerThread("senses-location-looper").apply { start() } }

    /** A point older than this is not "now". */
    const val FRESH_MS = 2 * 60_000L

    fun provider(lm: LocationManager, accuracy: String): String? {
        val enabled = lm.getProviders(true).toSet()
        val fused = if (Build.VERSION.SDK_INT >= 31 && LocationManager.FUSED_PROVIDER in enabled) LocationManager.FUSED_PROVIDER else null
        val order = when (accuracy) {
            "high" -> listOf(LocationManager.GPS_PROVIDER, fused, LocationManager.NETWORK_PROVIDER)
            "low" -> listOf(LocationManager.NETWORK_PROVIDER, fused, LocationManager.GPS_PROVIDER)
            else -> listOf(fused, LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
        }
        return order.filterNotNull().firstOrNull { it in enabled }
    }

    /** Waits up to [timeoutMs]; [cancelled] stops the wait early (recording was turned off). Throws [SenseError]. */
    fun fix(ctx: Context, accuracy: String, timeoutMs: Long, cancelled: () -> Boolean = { false }): Fix {
        if (!Senses.locationPermission(ctx)) throw SenseError("permission_denied", "location permission is not granted to Ash 感知 (open its setup page)")
        if (!Senses.locationOn(ctx)) throw SenseError("location_off", "location is turned off in the phone's settings")
        val lm = ctx.getSystemService(LocationManager::class.java)
        val provider = provider(lm, accuracy) ?: throw SenseError("location_off", "no location provider is enabled")
        val result = AtomicReference<Location?>()
        val done = CountDownLatch(1)
        val signal = CancellationSignal()
        val wake = ctx.getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ash.senses:fix")
        wake.acquire(timeoutMs + 5_000)
        var listener: LocationListener? = null
        try {
            try {
                if (Build.VERSION.SDK_INT >= 30) {
                    lm.getCurrentLocation(provider, signal, executor) { loc -> result.set(loc); done.countDown() }
                } else {
                    val l = object : LocationListener {
                        override fun onLocationChanged(loc: Location) { result.set(loc); done.countDown() }
                        @Deprecated("") override fun onStatusChanged(p: String?, s: Int, e: Bundle?) {}
                        override fun onProviderEnabled(p: String) {}
                        override fun onProviderDisabled(p: String) { done.countDown() }
                    }
                    listener = l
                    lm.requestLocationUpdates(provider, 0L, 0f, l, thread.looper)
                }
            } catch (e: SecurityException) {
                throw SenseError("permission_denied", "the system refused location: ${e.message}")
            }
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline && !done.await(500, TimeUnit.MILLISECONDS)) {
                if (cancelled()) { signal.cancel(); throw SenseError("not_recording", "recording was turned off") }
            }
        } finally {
            signal.cancel()
            listener?.let { runCatching { lm.removeUpdates(it) } }
            if (wake.isHeld) wake.release()
        }
        val loc = result.get()
        if (loc != null && System.currentTimeMillis() - loc.time <= FRESH_MS) return toFix(loc, provider)
        if (!Senses.locationOn(ctx)) throw SenseError("location_off", "location was turned off")
        val background = if (!Senses.backgroundLocation(ctx)) " (background location is not allowed: with the phone locked or Ash 感知 not in front, the system gives no fix; set location to 「始终允许」)" else ""
        throw SenseError("no_fix", "no location fix from $provider within ${timeoutMs / 1000}s$background")
    }

    fun toFix(loc: Location, provider: String): Fix {
        val mocked = if (Build.VERSION.SDK_INT >= 31) loc.isMock else @Suppress("DEPRECATION") loc.isFromMockProvider
        return Fix(loc.time, loc.latitude, loc.longitude, if (loc.hasAccuracy()) loc.accuracy.toDouble() else 9999.0,
            loc.provider ?: provider, mocked, if (loc.hasSpeed()) loc.speed.toDouble() else null)
    }
}
