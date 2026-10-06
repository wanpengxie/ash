package ai.ash.screen

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings

/**
 * Opened by Ash: asks the system to let this app run in the background (an app may only ask for itself). Systems that
 * clear background apps stop the accessibility service with them.
 */
class KeepAliveActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        if (!getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName))
            runCatching { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) }
        finish()
    }
}
