package ai.ash.senses

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** The phone's hardware step counter (counts since boot; needs the activity-recognition permission). */
object StepReader {
    fun available(ctx: Context) = ctx.getSystemService(SensorManager::class.java).getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null

    /** The counter now. Throws [SenseError]. */
    fun read(ctx: Context, timeoutMs: Long = 5_000): StepSample {
        if (!Senses.activityRecognition(ctx)) throw SenseError("permission_denied", "the physical-activity permission is not granted to Ash 感知 (open its setup page)")
        val sm = ctx.getSystemService(SensorManager::class.java)
        val sensor = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) ?: throw SenseError("source_unavailable", "this phone has no step counter")
        var value = -1L
        val done = CountDownLatch(1)
        val listener = object : SensorEventListener {
            override fun onSensorChanged(e: SensorEvent) { value = e.values[0].toLong(); done.countDown() }
            override fun onAccuracyChanged(s: Sensor?, a: Int) {}
        }
        if (!sm.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_NORMAL)) throw SenseError("source_unavailable", "the step counter could not be read")
        try { done.await(timeoutMs, TimeUnit.MILLISECONDS) } finally { sm.unregisterListener(listener) }
        if (value < 0) throw SenseError("timeout", "the step counter did not answer within ${timeoutMs / 1000}s")
        return StepSample(System.currentTimeMillis(), value, Senses.bootCount(ctx))
    }
}
