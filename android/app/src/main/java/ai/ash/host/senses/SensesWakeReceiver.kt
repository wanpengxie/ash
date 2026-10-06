package ai.ash.host.senses

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import ai.ash.host.CoreService

/**
 * Ash 感知 holds facts (a geofence crossing, a ride) and Ash is gone: the system cleared it. Starting the service
 * brings the core back and reconnects the bridge, which then takes the waiting batches.
 */
class SensesWakeReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        Log.i("ash.senses", "woken by Ash 感知")
        CoreService.start(ctx)
    }
}
