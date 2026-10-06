package ai.ash.host.screen

import ai.ash.bridge.Bridge
import android.app.Activity
import android.app.PendingIntent
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
                    // The installer fills in the outcome, so the intent must stay mutable. It opens a page of Ash's, in
                    // front: some systems (ColorOS) drop an install confirmation started from the background, and the
                    // installer then reports it as refused by the owner.
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                    session.commit(PendingIntent.getActivity(ctx, id, Intent(ctx, ScreenInstallActivity::class.java), flags).intentSender)
                }
            } catch (e: Exception) {
                Log.w("ash.screen", "could not install the screen helper", e)
                android.os.Handler(android.os.Looper.getMainLooper()).post { Toast.makeText(ctx, "屏幕助手安装失败：${e.message}", Toast.LENGTH_LONG).show() }
            }
        }, "ash-screen-install").start()
    }

    /**
     * Keeps the system from clearing the helper: first its own request to run in the background (only an app can ask
     * for itself), then its app info page, where the phone maker keeps the rest of its switches.
     */
    /** The first helper with a card the owner can lock in recent apps. */
    const val LOCK_CARD_VERSION = 6L

    /** Opens the helper's lockable card, then the owner locks it in recent apps. */
    fun lockCard(a: Activity) {
        if (ScreenBridge.installedVersion(a) < LOCK_CARD_VERSION) return install(a)
        a.startActivity(Intent().setClassName(Bridge.SCREEN_PACKAGE, "ai.ash.screen.LockCardActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun keepAlive(a: Activity) {
        if (ScreenBridge.needsInstall(a)) return install(a)
        val power = a.getSystemService(android.os.PowerManager::class.java)
        if (!power.isIgnoringBatteryOptimizations(Bridge.SCREEN_PACKAGE)) {
            a.startActivity(Intent().setClassName(Bridge.SCREEN_PACKAGE, "ai.ash.screen.KeepAliveActivity"))
            return
        }
        Toast.makeText(a, "在这一页${ai.ash.host.PhoneMaker.current.keepAlive}", Toast.LENGTH_LONG).show()
        a.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${Bridge.SCREEN_PACKAGE}")))
    }

    /**
     * Grants Ash the one permission recovery needs: through Shizuku when it is running, otherwise it shows the adb
     * command (copied, for a computer the phone is plugged into).
     */
    fun grantRecovery(a: Activity) {
        if (ai.ash.host.shizuku.ShizukuState.ready()) {
            val ctx = a.applicationContext
            Thread({
                val r = runCatching { ai.ash.host.shizuku.PrivShell.exec(ctx, "pm grant ${ctx.packageName} android.permission.WRITE_SECURE_SETTINGS", 15_000) }.getOrNull()
                android.os.Handler(android.os.Looper.getMainLooper()).post {
                    Toast.makeText(ctx, if (r?.ok == true) "已授权：屏幕助手被清理后会自动恢复" else "授权没有成功：${r?.stderr?.take(80) ?: "Shizuku 不可用"}", Toast.LENGTH_LONG).show()
                }
            }, "ash-grant-recovery").start()
            return
        }
        val command = ScreenRecovery.grantCommand(a)
        a.getSystemService(android.content.ClipboardManager::class.java).setPrimaryClip(android.content.ClipData.newPlainText("adb", command))
        android.app.AlertDialog.Builder(a).setTitle("授权一次")
            .setMessage("把手机用 USB 连上电脑（打开 USB 调试），在电脑上运行下面这行（已复制）：\n\n$command\n\n只需一次，之后一直有效。")
            .setPositiveButton("好的", null).show()
    }

    /** Where the owner turns the helper's accessibility service on. */
    fun openAccessibility(a: Activity) {
        Toast.makeText(a, "在列表里找到「Ash 屏幕助手」并打开", Toast.LENGTH_LONG).show()
        a.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }
}

/** Where the installer reports: asks the owner to confirm from here, in front, then says how it went. */
class ScreenInstallActivity : Activity() {
    override fun onCreate(state: android.os.Bundle?) { super.onCreate(state); handle(intent) }
    override fun onNewIntent(next: Intent) { super.onNewIntent(next); handle(next) }

    private fun handle(intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION") val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirm != null) runCatching { startActivity(confirm) }
                    .onFailure { Toast.makeText(this, "无法打开安装确认：${it.message}", Toast.LENGTH_LONG).show() }
            }
            PackageInstaller.STATUS_SUCCESS -> {
                Toast.makeText(this, "屏幕助手已装好。下一步：打开它的无障碍开关", Toast.LENGTH_LONG).show()
                ScreenBridge.connect()
            }
            else -> Toast.makeText(this, "屏幕助手没有装上：${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "已取消"}", Toast.LENGTH_LONG).show()
        }
        finish()
    }
}
