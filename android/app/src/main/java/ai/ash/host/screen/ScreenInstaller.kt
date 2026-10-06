package ai.ash.host.screen

import ai.ash.bridge.Bridge
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.Toast

/** The screen helper's installation (shared with the other helpers, see [ai.ash.host.HelperInstaller]) and its upkeep. */
object ScreenInstaller {
    fun install(a: Activity) = ai.ash.host.HelperInstaller.install(a, ai.ash.host.Helper.SCREEN)

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
        ai.ash.host.PhoneMaker.current.openKeepAlive(a, Bridge.SCREEN_PACKAGE, "Ash 屏幕助手")
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
