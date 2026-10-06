package ai.ash.host

import ai.ash.bridge.Bridge
import ai.ash.host.screen.ScreenBridge
import ai.ash.host.senses.SensesBridge
import android.app.Activity
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.widget.Toast

/** A helper app Ash carries in its assets and installs (or updates) for the owner. */
enum class Helper(val pkg: String, val asset: String, val label: String, val next: String) {
    SCREEN(Bridge.SCREEN_PACKAGE, "screen/ash-screen.apk", "屏幕助手", "下一步：打开它的无障碍开关"),
    SENSES(Bridge.SENSES_PACKAGE, "senses/ash-senses.apk", "Ash 感知", "下一步：在它的页面里逐项授权");

    /** Installed: Ash connects to it now. */
    fun connect() = when (this) { SCREEN -> ScreenBridge.connect(); SENSES -> SensesBridge.connect() }
}

/**
 * Installs a helper through Android's package installer: the owner confirms on the system's own screen. An app
 * installed this way is not held back from accessibility as a downloaded file would be (Android 13's restricted
 * settings).
 */
object HelperInstaller {
    private const val EXTRA = "ai.ash.helper"

    fun install(a: Activity, helper: Helper) {
        if (Build.VERSION.SDK_INT >= 26 && !a.packageManager.canRequestPackageInstalls()) {
            Toast.makeText(a, "请允许 Ash 安装应用，然后再点一次", Toast.LENGTH_LONG).show()
            a.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${a.packageName}")))
            return
        }
        val ctx = a.applicationContext
        Thread({
            try {
                val installer = ctx.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setAppPackageName(helper.pkg) }
                val id = installer.createSession(params)
                installer.openSession(id).use { session ->
                    ctx.assets.open(helper.asset).use { input -> session.openWrite(helper.asset.substringAfterLast('/'), 0, -1).use { out -> input.copyTo(out); session.fsync(out) } }
                    // The installer fills in the outcome, so the intent must stay mutable. It opens a page of Ash's, in
                    // front: some systems (ColorOS) drop an install confirmation started from the background, and the
                    // installer then reports it as refused by the owner.
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                    val report = Intent(ctx, HelperInstallActivity::class.java).putExtra(EXTRA, helper.name)
                    session.commit(PendingIntent.getActivity(ctx, id, report, flags).intentSender)
                }
            } catch (e: Exception) {
                Log.w("ash.helper", "could not install ${helper.pkg}", e)
                android.os.Handler(android.os.Looper.getMainLooper()).post { Toast.makeText(ctx, "${helper.label}安装失败：${e.message}", Toast.LENGTH_LONG).show() }
            }
        }, "ash-helper-install").start()
    }

    internal fun helper(intent: Intent): Helper = runCatching { Helper.valueOf(intent.getStringExtra(EXTRA) ?: "") }.getOrDefault(Helper.SCREEN)
}

/** Where the installer reports: asks the owner to confirm from here, in front, then says how it went. */
class HelperInstallActivity : Activity() {
    override fun onCreate(state: android.os.Bundle?) { super.onCreate(state); handle(intent) }
    override fun onNewIntent(next: Intent) { super.onNewIntent(next); handle(next) }

    private fun handle(intent: Intent) {
        val helper = HelperInstaller.helper(intent)
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION") val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm != null) runCatching { startActivity(confirm) }
                    .onFailure { Toast.makeText(this, "无法打开安装确认：${it.message}", Toast.LENGTH_LONG).show() }
            }
            PackageInstaller.STATUS_SUCCESS -> {
                Toast.makeText(this, "${helper.label}已装好。${helper.next}", Toast.LENGTH_LONG).show()
                helper.connect()
            }
            else -> Toast.makeText(this, "${helper.label}没有装上：${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "已取消"}", Toast.LENGTH_LONG).show()
        }
        finish()
    }
}
