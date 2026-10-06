package ai.ash.host.screen

import ai.ash.bridge.Bridge
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.widget.Toast

/**
 * Installs (or updates) the screen helper Ash carries in its assets, through Android's package installer: the owner
 * confirms on the system's own screen. An app installed this way is not held back from accessibility as a downloaded
 * file would be (Android 13's restricted settings).
 */
object ScreenInstaller {
    private const val ASSET = "screen/ash-screen.apk"

    fun install(a: Activity) {
        if (Build.VERSION.SDK_INT >= 26 && !a.packageManager.canRequestPackageInstalls()) {
            Toast.makeText(a, "请允许 Ash 安装应用，然后再点一次", Toast.LENGTH_LONG).show()
            a.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${a.packageName}")))
            return
        }
        val ctx = a.applicationContext
        Thread({
            try {
                val installer = ctx.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setAppPackageName(Bridge.SCREEN_PACKAGE) }
                val id = installer.createSession(params)
                installer.openSession(id).use { session ->
                    ctx.assets.open(ASSET).use { input -> session.openWrite("ash-screen.apk", 0, -1).use { out -> input.copyTo(out); session.fsync(out) } }
                    // The installer fills in the outcome, so the intent must stay mutable.
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                    session.commit(PendingIntent.getBroadcast(ctx, id, Intent(ctx, ScreenInstallReceiver::class.java), flags).intentSender)
                }
            } catch (e: Exception) {
                Log.w("ash.screen", "could not install the screen helper", e)
                android.os.Handler(android.os.Looper.getMainLooper()).post { Toast.makeText(ctx, "屏幕助手安装失败：${e.message}", Toast.LENGTH_LONG).show() }
            }
        }, "ash-screen-install").start()
    }

    /** Where the owner turns the helper's accessibility service on. */
    fun openAccessibility(a: Activity) {
        Toast.makeText(a, "在列表里找到「Ash 屏幕助手」并打开", Toast.LENGTH_LONG).show()
        a.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }
}

class ScreenInstallReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION") val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                ctx.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            PackageInstaller.STATUS_SUCCESS -> {
                Toast.makeText(ctx, "屏幕助手已装好。下一步：打开它的无障碍开关", Toast.LENGTH_LONG).show()
                ScreenBridge.connect()
            }
            else -> Toast.makeText(ctx, "屏幕助手没有装上：${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "已取消"}", Toast.LENGTH_LONG).show()
        }
    }
}
