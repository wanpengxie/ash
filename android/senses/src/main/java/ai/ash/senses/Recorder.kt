package ai.ash.senses

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.TriggerEvent
import android.hardware.TriggerEventListener
import android.os.Build
import android.os.IBinder
import android.util.Log
import ai.ash.senses.health.HealthImport
import ai.ash.senses.health.XiaomiScaleSource
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Starts and stops recording. Recording runs in a foreground service with a notification the owner can stop it from;
 * when it is off nothing listens, nothing is scheduled, and no location is requested.
 */
object Recorder {
    private const val TAG = "ash.senses"
    const val CHANNEL = "senses.recording"
    const val NOTIFICATION = 1
    const val RESUME_NOTIFICATION = 2
    @Volatile internal var sampler: Sampler? = null
    @Volatile var lastProblem: String? = null

    fun running() = sampler != null

    /** Starts the service; null when started, else why not (the owner can then start it from a notification). */
    fun start(ctx: Context): String? {
        if (!Senses.locationPermission(ctx) && !Senses.activityRecognition(ctx)) return "permission_denied: neither location nor physical activity is granted"
        return try {
            ctx.startForegroundService(Intent(ctx, RecordingService::class.java))
            null
        } catch (e: Exception) {
            // Android 12+ refuses a foreground service started from the background unless the app is exempt (the
            // battery exemption is one). The owner's tap on a notification is always allowed.
            Log.w(TAG, "could not start recording", e)
            offerResume(ctx, "Ash 感知需要你点一下才能开始记录")
            "the system did not let recording start from the background (${e.javaClass.simpleName}); a notification asks the owner to tap it. Allowing Ash 感知 to ignore battery optimisation avoids this"
        }
    }

    fun stop(ctx: Context) {
        ctx.stopService(Intent(ctx, RecordingService::class.java))
        cancelAlarms(ctx)
        ctx.getSystemService(NotificationManager::class.java).cancel(RESUME_NOTIFICATION)
    }

    fun reconfigure(ctx: Context) { sampler?.reconfigure() ?: start(ctx) }

    /** An alarm went off: the sampler takes it, or recording that should be on is started again. */
    fun alarm(ctx: Context, action: String) {
        val s = sampler
        if (s != null) { s.alarm(action); return }
        if (Senses.config(ctx).recording) start(ctx)
    }

    fun offerResume(ctx: Context, text: String) {
        channel(ctx)
        val tap = PendingIntent.getForegroundService(ctx, 3, Intent(ctx, RecordingService::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = Notification.Builder(ctx, CHANNEL).setSmallIcon(R.drawable.ic_stat).setContentTitle(text).setContentText("点这里继续记录位置与运动")
            .setContentIntent(tap).setAutoCancel(true).build()
        runCatching { ctx.getSystemService(NotificationManager::class.java).notify(RESUME_NOTIFICATION, n) }
    }

    fun channel(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "位置与运动记录", NotificationManager.IMPORTANCE_LOW).apply {
                description = "记录进行时常驻，可一键停止"; setShowBadge(false)
            })
    }

    fun scheduleAlarm(ctx: Context, action: String, at: Long) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        // Inexact but allowed while the phone dozes: a point every interval, give or take the system's batching.
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, alarmIntent(ctx, action))
    }

    fun cancelAlarms(ctx: Context) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        for (a in listOf(AlarmReceiver.TICK, AlarmReceiver.PROBE)) am.cancel(alarmIntent(ctx, a))
    }

    private fun alarmIntent(ctx: Context, action: String) = PendingIntent.getBroadcast(ctx, action.hashCode(),
        Intent(ctx, AlarmReceiver::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
}

/** The recording, while it is on: the persistent notification with 「停止记录」. */
class RecordingService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Senses.init(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            Senses.configure(this, Senses.config(this).copy(recording = false))
            stopSelf()
            return START_NOT_STICKY
        }
        val config = Senses.config(this)
        // Started as a foreground service, it must become one before it may stop (or the system ends the app).
        if (!foreground(config)) { stopSelf(); return START_NOT_STICKY }
        if (!config.recording) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY }
        getSystemService(NotificationManager::class.java).cancel(Recorder.RESUME_NOTIFICATION)
        if (Recorder.sampler == null) Recorder.sampler = Sampler(this).also { it.start() }
        AshLink.changed()
        return START_STICKY
    }

    private fun foreground(config: SenseConfig): Boolean {
        Recorder.channel(this)
        val stop = PendingIntent.getService(this, 1, Intent(this, RecordingService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        val open = PendingIntent.getActivity(this, 2, Intent(this, SetupActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(this, Recorder.CHANNEL).setSmallIcon(R.drawable.ic_stat).setOngoing(true)
            .setContentTitle("Ash 感知正在记录位置与运动")
            .setContentText("移动时每 ${config.intervalMin} 分钟一个位置，静止时不取位置；只存在本机")
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "停止记录", stop).build())
            .build()
        if (Build.VERSION.SDK_INT < 29) { startForeground(Recorder.NOTIFICATION, n); return true }
        val location = if (Senses.locationPermission(this)) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0
        val health = if (Build.VERSION.SDK_INT >= 34 && Senses.activityRecognition(this)) ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH else 0
        for (types in listOf(location or health, health, location).distinct().filter { it != 0 }) {
            try { startForeground(Recorder.NOTIFICATION, n, types); Recorder.lastProblem = if (types and location == 0 && location != 0) "location recording refused by the system (background location not allowed); steps and motion only" else null; return true }
            catch (e: Exception) { Log.w("ash.senses", "foreground type $types refused", e) }
        }
        Recorder.lastProblem = "the system refused the recording service (location and activity permissions)"
        Recorder.offerResume(this, "Ash 感知没能开始记录")
        return false
    }

    override fun onDestroy() {
        Recorder.sampler?.stop()
        Recorder.sampler = null
        AshLink.changed()
        super.onDestroy()
    }

    companion object { const val ACTION_STOP = "ai.ash.senses.STOP" }
}

/** Alarms (the floor tick and the probe after a motion trigger) and the phone starting up. */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        Senses.init(ctx)
        when (intent.action) {
            TICK, PROBE -> Recorder.alarm(ctx, intent.action!!)
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
                if (Senses.config(ctx).recording) Recorder.start(ctx)
                // The scale is heard whether or not recording is on.
                if (XiaomiScaleSource.configured(ctx)) XiaomiScaleSource.arm(ctx)
            }
        }
    }

    companion object {
        const val TICK = "ai.ash.senses.TICK"
        const val PROBE = "ai.ash.senses.PROBE"
    }
}

/**
 * What decides when to take a point. The step counter and the significant-motion trigger (both low-power hardware)
 * say when the owner moves; a point is taken every interval, and also when movement starts or stops. Everything runs
 * on one worker thread, in order.
 */
internal class Sampler(private val ctx: Context) {
    private val worker = Executors.newSingleThreadScheduledExecutor { Thread(it, "senses-sampler") }
    private val sm = ctx.getSystemService(SensorManager::class.java)
    private val store get() = Senses.store
    private val debounce = ActivityDebounce()
    @Volatile private var running = false
    private var lastMotion: Long? = null
    private var lastFixAttempt = 0L
    private var lastStepSaved = 0L
    private var latestSteps: StepSample? = null

    private val steps = object : SensorEventListener {
        override fun onSensorChanged(e: SensorEvent) {
            val s = StepSample(System.currentTimeMillis(), e.values[0].toLong(), Senses.bootCount(ctx))
            post { onSteps(s) }
        }
        override fun onAccuracyChanged(s: Sensor?, a: Int) {}
    }
    private val motionSensor: Sensor? = sm.getDefaultSensor(Sensor.TYPE_SIGNIFICANT_MOTION)
    private val motion = object : TriggerEventListener() {
        override fun onTrigger(e: TriggerEvent) { post { onMotion() } }
    }

    fun start() {
        running = true
        post {
            debounce.state = store.openSegment()?.state
            lastMotion = Senses.prefs(ctx).getLong("last_motion", 0).takeIf { it > 0 }
        }
        if (Senses.activityRecognition(ctx)) sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)?.let {
            // Batched: the counter is cumulative, so a late delivery loses nothing.
            sm.registerListener(steps, it, SensorManager.SENSOR_DELAY_NORMAL, 60_000_000)
        }
        arm()
        post { tick(force = true) }
    }

    fun stop() {
        running = false
        sm.unregisterListener(steps)
        motionSensor?.let { runCatching { sm.cancelTriggerSensor(motion, it) } }
        Recorder.cancelAlarms(ctx)
        worker.execute { runCatching { store.switchSegment(null, System.currentTimeMillis()) } }
        worker.shutdown()
        runCatching { worker.awaitTermination(2, TimeUnit.SECONDS) }
    }

    fun reconfigure() = post { Recorder.cancelAlarms(ctx); scheduleTick() }

    fun alarm(action: String) = post { if (action == AlarmReceiver.PROBE) fixNow("probe") else tick(force = false) }

    private fun post(job: () -> Unit) {
        if (!running) return
        runCatching { worker.execute { if (running) try { job() } catch (e: Exception) { Log.w("ash.senses", "sampler", e) } } }
    }

    private fun arm() { motionSensor?.let { runCatching { sm.requestTriggerSensor(motion, it) } } }

    private fun scheduleTick() = Recorder.scheduleAlarm(ctx, AlarmReceiver.TICK, System.currentTimeMillis() + Senses.config(ctx).intervalMin * 60_000L)

    private fun tick(force: Boolean) {
        scheduleTick()
        val now = System.currentTimeMillis()
        val prefs = Senses.prefs(ctx)
        if (now - prefs.getLong("last_purge", 0) > SenseArgs.DAY_MS) {
            store.purge(now, Senses.config(ctx).retentionDays); prefs.edit().putLong("last_purge", now).apply()
        }
        if (now - prefs.getLong("last_health_import", 0) > 3_600_000L) {
            prefs.edit().putLong("last_health_import", now).apply()
            HealthImport.run(ctx)
        }
        latestSteps?.let { if (now - lastStepSaved > 60_000) { store.addSteps(it.copy(ts = now)); lastStepSaved = now } }
        evaluate()
        // A point every interval, still or not: the owner's day must read as a continuous track (one every 30 minutes
        // by default). Movement starting or stopping adds points in between.
        fixNow(if (force) "start" else "interval")
        AshLink.flush()
    }

    private fun onSteps(s: StepSample) {
        val moved = latestSteps?.let { s.counter != it.counter || s.boot != it.boot } ?: false
        latestSteps = s
        if (s.ts - lastStepSaved >= 60_000) { store.addSteps(s); lastStepSaved = s.ts }
        if (moved) evaluate()
    }

    private fun onMotion() {
        val now = System.currentTimeMillis()
        lastMotion = now
        Senses.prefs(ctx).edit().putLong("last_motion", now).apply()
        arm()
        val wasStill = debounce.state == null || debounce.state == ActivityState.STILL
        evaluate()
        if (wasStill) {
            fixNow("motion")
            // A second point a little later gives a speed: walking, cycling or a vehicle when no steps say.
            Recorder.scheduleAlarm(ctx, AlarmReceiver.PROBE, now + 2 * 60_000L)
        }
    }

    private fun evaluate() {
        val now = System.currentTimeMillis()
        val fixes = store.fixes((now - ActivityClassifier.FIX_WINDOW_MS)..now).map { it.sample() }
        val stepSamples = store.steps((now - ActivityClassifier.STEP_WINDOW_MS)..now) + listOfNotNull(latestSteps)
        val before = debounce.state
        val guess = ActivityClassifier.classify(now, fixes, stepSamples, lastMotion, before)
        val changed = debounce.next(guess.state, now) ?: return
        store.switchSegment(changed, now)
        Senses.prefs(ctx).edit().putString("activity_basis", JSONObject().put("cadence", guess.cadence ?: JSONObject.NULL)
            .put("speed", guess.speed ?: JSONObject.NULL).put("basis", guess.basis).toString()).apply()
        // Movement started or stopped: where.
        if (before != null && (before == ActivityState.STILL) != (changed == ActivityState.STILL)) fixNow(if (changed == ActivityState.STILL) "stopped" else "moving")
        AshLink.flush()
    }

    private fun fixNow(reason: String) {
        val now = System.currentTimeMillis()
        if (reason != "probe" && now - lastFixAttempt < 60_000) return
        if (!Senses.locationPermission(ctx)) { Recorder.lastProblem = "location permission was withdrawn"; return }
        lastFixAttempt = now
        val config = Senses.config(ctx)
        val fix = point(config) ?: return
        // Turned off while waiting: nothing is kept.
        if (!running || !Senses.config(ctx).recording) return
        Recorder.lastProblem = null
        // A last-known fix can be the point already kept.
        if (store.lastFix()?.let { it.ts == fix.ts && it.lat == fix.lat && it.lon == fix.lon } == true) return
        store.addFix(fix)
        if (!fix.mocked) geofences(fix, config)
        evaluate()
        AshLink.flush()
    }

    /**
     * One point for the track. Battery first: one provider (the accuracy setting's usual one). Only after it failed
     * [LocationPolicy.FALLBACK_AFTER] times in a row are all providers asked together, at once and then for a while.
     */
    private fun point(config: SenseConfig): Fix? {
        val timeout = if (config.accuracy == "high") 60_000L else 30_000L
        var state = LocationReader.background(ctx)
        var mode = state.mode(System.currentTimeMillis())
        while (true) {
            val outcome = runCatching { LocationReader.fix(ctx, config.accuracy, timeout, mode) { !running } }
            val error = outcome.exceptionOrNull() as? SenseError
            if (outcome.isFailure && error == null) throw outcome.exceptionOrNull()!!
            if (error?.code == "not_recording") return null
            // Only the providers' failures count: no permission or location off is not theirs.
            if (error == null || error.code == "no_fix") {
                state = LocationPolicy.after(state, mode, error == null, System.currentTimeMillis())
                LocationReader.saveBackground(ctx, state)
            }
            if (error == null) return outcome.getOrNull()!!.fix
            val next = state.mode(System.currentTimeMillis())
            if (mode == LocationPolicy.Mode.BACKGROUND && next == LocationPolicy.Mode.BACKGROUND_FALLBACK && running) { mode = next; continue }
            Recorder.lastProblem = "${error.code}: ${error.message}"
            Log.i("ash.senses", "no point: ${error.code}")
            return null
        }
    }

    private fun geofences(fix: Fix, config: SenseConfig) {
        if (config.geofences.isEmpty()) return
        val prefs = Senses.prefs(ctx)
        val stored = runCatching { JSONObject(prefs.getString("geofence_inside", "{}")!!) }.getOrDefault(JSONObject())
        val inside = stored.keys().asSequence().associateWith { stored.getBoolean(it) }
        val (next, events) = Geo.evaluate(config.geofences, inside, fix.lat, fix.lon, fix.accuracyM, fix.ts)
        prefs.edit().putString("geofence_inside", JSONObject(next as Map<*, *>).toString()).apply()
        for (e in events) store.enqueue(Batches.GEOFENCE, JSONObject().put("name", e.name).put("transition", e.transition).put("ts", e.ts), System.currentTimeMillis())
    }

    /** activity.current while recording. */
    fun current(): JSONObject? {
        val seg = store.openSegment() ?: return null
        val basis = runCatching { JSONObject(Senses.prefs(ctx).getString("activity_basis", "{}")!!) }.getOrDefault(JSONObject())
        return JSONObject().put("state", seg.state).put("since", seg.start).put("basis", basis)
    }
}
