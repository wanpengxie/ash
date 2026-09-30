package ai.ash.host.senses

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.util.Log
import ai.ash.host.CoreClient
import org.json.JSONObject
import java.util.UUID

/** Foreground-service-owned receivers; no polling, and no wake-up decision on the phone. */
class DeviceSense(private val ctx: Context) {
    private val prefs = ctx.getSharedPreferences("sense_device", Context.MODE_PRIVATE)
    private val serial = SenseSerial()
    private var registered = false
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_BATTERY_CHANGED -> {
                    val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
                    val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
                    if (scale > 0 && level >= 0) serial.submit { battery(level * 100 / scale) }
                }
                Intent.ACTION_SCREEN_OFF -> serial.submit { prefs.edit().putLong("screen_off", System.currentTimeMillis()).apply() }
                Intent.ACTION_SCREEN_ON -> serial.submit { screen("on", prefs.getLong("screen_off", 0)) }
            }
        }
    }

    fun start() {
        if (registered) return
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_BATTERY_CHANGED)
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
        }
        ctx.registerReceiver(receiver, filter)
        registered = true
    }

    fun appOpen() { serial.submit { screen("app_open", prefs.getLong("app_left", 0)) } }
    fun appLeft() { serial.submit { prefs.edit().putLong("app_left", System.currentTimeMillis()).apply() } }
    fun retryBattery() {
        val intent = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) ?: return
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        if (scale > 0 && level >= 0) serial.submit { battery(level * 100 / scale) }
    }

    private fun battery(level: Int) {
        val armed = prefs.getBoolean("battery_armed", true)
        if (level >= 17) {
            prefs.edit().putBoolean("battery_armed", true).remove("battery_pending").remove("battery_pending_level").commit()
        }
        if (!SensePolicy.lowBattery(level, armed)) return
        val pending = prefs.getString("battery_pending", null) ?: UUID.randomUUID().toString().also {
            prefs.edit().putString("battery_pending", it).putInt("battery_pending_level", level).commit()
        }
        if (send("sense.battery", JSONObject().put("level", prefs.getInt("battery_pending_level", level)), pending)) {
            prefs.edit().putBoolean("battery_armed", false).remove("battery_pending").remove("battery_pending_level").commit()
        }
    }

    private fun screen(state: String, since: Long) {
        val now = System.currentTimeMillis()
        send("sense.screen", JSONObject().put("state", state).put("away_ms", SensePolicy.awayMs(now, since)), UUID.randomUUID().toString())
    }

    private fun send(word: String, body: JSONObject, id: String): Boolean = try {
        CoreClient(ctx).sendSense(word, body, id)
        true
    } catch (e: Exception) {
        Log.w("sense.device", "delivery unavailable: ${e.javaClass.simpleName}: ${e.message?.take(80)}")
        false
    }

    fun stop() {
        if (registered) ctx.unregisterReceiver(receiver)
        registered = false
        serial.close()
    }
}
