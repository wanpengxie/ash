package ai.ash.senses

import ai.ash.senses.health.HealthWatch
import ai.ash.senses.health.XiaomiScaleSource
import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import org.json.JSONObject

/** The helper's shared state: its store, the owner's settings, and what the system has granted it. */
object Senses {
    @Volatile private var app: Context? = null
    @Volatile private var storeInstance: SenseStore? = null
    private const val PREFS = "senses"

    fun init(ctx: Context) {
        if (app != null) return
        app = ctx.applicationContext
        // A new process: the scale's background scan is started again, in case the system dropped it.
        XiaomiScaleSource.rearm(ctx.applicationContext)
        // Health sources are checked for stopped data every few hours (a non-waking alarm, set once).
        HealthWatch.arm(ctx.applicationContext)
    }
    fun ctx(): Context = app ?: error("senses not initialised")

    val store: SenseStore get() = storeInstance ?: synchronized(this) { storeInstance ?: SenseStore(ctx()).also { storeInstance = it } }

    fun prefs(ctx: Context = ctx()) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun config(ctx: Context = ctx()): SenseConfig = SenseConfig.stored(prefs(ctx).getString("config", null))

    /** Saves [next]; turning recording on or off starts or stops the recorder. Returns the error starting it gave, if any. */
    @Synchronized fun configure(ctx: Context, next: SenseConfig): String? {
        val before = config(ctx)
        prefs(ctx).edit().putString("config", next.toJson().toString()).commit()
        if (next.retentionDays != before.retentionDays) runCatching { store.purge(System.currentTimeMillis(), next.retentionDays) }
        if (next.geofences != before.geofences) prefs(ctx).edit().remove("geofence_inside").commit()
        val problem = when {
            next.recording && !before.recording -> Recorder.start(ctx)
            !next.recording && before.recording -> { Recorder.stop(ctx); null }
            next.recording -> { Recorder.reconfigure(ctx); null }
            else -> null
        }
        AshLink.changed()
        return problem
    }

    // ---- what the system granted ----

    fun granted(ctx: Context, permission: String) = ctx.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
    fun locationPermission(ctx: Context) = granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION) || granted(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
    fun preciseLocation(ctx: Context) = granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
    fun backgroundLocation(ctx: Context) = Build.VERSION.SDK_INT < 29 || granted(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
    fun activityRecognition(ctx: Context) = Build.VERSION.SDK_INT < 29 || granted(ctx, Manifest.permission.ACTIVITY_RECOGNITION)
    fun notifications(ctx: Context) = ctx.getSystemService(NotificationManager::class.java).areNotificationsEnabled()
    fun batteryUnrestricted(ctx: Context) = ctx.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(ctx.packageName)
    fun bluetooth(ctx: Context) = Build.VERSION.SDK_INT < 31 ||
        (granted(ctx, Manifest.permission.BLUETOOTH_SCAN) && granted(ctx, Manifest.permission.BLUETOOTH_CONNECT))
    fun locationOn(ctx: Context): Boolean {
        val lm = ctx.getSystemService(LocationManager::class.java)
        return if (Build.VERSION.SDK_INT >= 28) lm.isLocationEnabled else
            @Suppress("DEPRECATION") Settings.Secure.getInt(ctx.contentResolver, Settings.Secure.LOCATION_MODE, 0) != 0
    }

    fun permissions(ctx: Context): JSONObject = JSONObject()
        .put("location", locationPermission(ctx)).put("precise_location", preciseLocation(ctx)).put("background_location", backgroundLocation(ctx))
        .put("activity_recognition", activityRecognition(ctx)).put("notifications", notifications(ctx))
        .put("battery_unrestricted", batteryUnrestricted(ctx)).put("bluetooth", bluetooth(ctx))

    /** Which boot this is: the step counter starts again from zero on each. */
    fun bootCount(ctx: Context): Int = runCatching { Settings.Global.getInt(ctx.contentResolver, Settings.Global.BOOT_COUNT, 0) }.getOrDefault(0)
}
