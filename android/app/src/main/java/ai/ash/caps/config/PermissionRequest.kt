package ai.ash.caps.config

import ai.ash.caps.senses.SetupActivity
import ai.ash.host.BackgroundLaunch
import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings

/**
 * `config.permission.request`: puts the system's permission prompt, or the settings page that holds the switch, in front
 * of the owner. A permission prompt needs an activity, so a transparent one ([PermissionRequestActivity]) hosts it.
 */
object PermissionRequest {
    const val EXTRA_NAME = "name"
    const val EXTRA_REVOKE = "revoke"

    /** The app's own settings page, where every permission it holds can be turned off. */
    fun appDetails(a: Activity) {
        a.startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.fromParts("package", a.packageName, null)))
    }

    /**
     * Starts the request for [name] (one of [ConfigStatus.NAMES]); false when the name is not one. When Ash is in the
     * background with no exemption to start a screen, the request waits behind a notice the owner taps ([BackgroundLaunch]).
     */
    fun start(ctx: Context, name: String, revoke: Boolean = false): Boolean {
        if (name !in ConfigStatus.NAMES) return false
        BackgroundLaunch.start(ctx, Intent(ctx, PermissionRequestActivity::class.java).putExtra(EXTRA_NAME, name).putExtra(EXTRA_REVOKE, revoke).addFlags(Intent.FLAG_ACTIVITY_NO_ANIMATION),
            if (revoke) "Ash 要收回一项权限" else "Ash 需要你授权", if (revoke) "点一下，去关掉这项权限" else "点一下，继续给 Ash 开这项权限")
        return true
    }

    /** What to show for [name], from [a]. The runtime permissions are asked through [ask]; everything else is a page. */
    internal fun open(a: Activity, name: String, ask: (Array<String>) -> Unit) {
        val own = Uri.parse("package:${a.packageName}")
        when (name) {
            "location" -> ask(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
            "activity_recognition" -> if (Build.VERSION.SDK_INT >= 29) ask(arrayOf(Manifest.permission.ACTIVITY_RECOGNITION))
            // Background location and Health Connect have their own steps on the senses' setup page.
            "location_background", "health" -> a.startActivity(Intent(a, SetupActivity::class.java))
            "exact_alarm" ->
                if (Build.VERSION.SDK_INT >= 31) a.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, own))
            // The system's one-tap question works for the calling app only; the kernel is found in the list.
            "kernel_battery_optimization" -> BatteryExemption.openList(a, ai.ash.caps.screen.KeepAliveSwitches.KERNEL_PACKAGE)
            else -> {
                val key = ConfigStatus.PERMISSION_KEY.getValue(name)
                Permissions.all.firstOrNull { it.key == key }?.open(a)
            }
        }
    }
}

/** Transparent and short-lived: shows one permission request over whatever is in front, then goes away. */
class PermissionRequestActivity : Activity() {
    private var asked = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val name = intent.getStringExtra(PermissionRequest.EXTRA_NAME).orEmpty()
        if (name in ConfigStatus.NAMES && intent.getBooleanExtra(PermissionRequest.EXTRA_REVOKE, false)) {
            runCatching { Permissions.all.firstOrNull { p -> p.key == (ConfigStatus.PERMISSION_KEY[name] ?: name) }?.revoke?.invoke(this) ?: PermissionRequest.appDetails(this) }
            finish(); return
        }
        if (name in ConfigStatus.NAMES) runCatching {
            PermissionRequest.open(this, name) { permissions -> asked = true; requestPermissions(permissions, REQUEST) }
        }
        // A page was opened over this one, or nothing could be asked: nothing is left to wait for.
        if (!asked) finish()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        ConfigWatch.check(applicationContext)
        finish()
    }

    override fun finish() {
        super.finish()
        overridePendingTransition(0, 0)
    }

    private companion object { const val REQUEST = 7150 }
}
