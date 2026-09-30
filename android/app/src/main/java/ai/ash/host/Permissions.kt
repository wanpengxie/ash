package ai.ash.host

import android.app.Activity
import android.app.AppOpsManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import ai.ash.host.a11y.A11yService
import ai.ash.host.shizuku.ShizukuState

/**
 * One phone permission ash can use. Everything is optional: ash works without any of them, each one
 * only unlocks more capabilities. [open] jumps to the exact settings screen (or asks) for it.
 */
class Permission(
    val key: String,
    val title: String,
    /** One line: what Ash can do with it (owner-facing, Chinese). */
    val why: String,
    private val check: (Context) -> Boolean,
    private val go: (Activity) -> Unit,
    /** Extra state when not granted (e.g. "Shizuku 未安装"), or null. */
    private val detail: (Context) -> String? = { null },
) {
    fun granted(ctx: Context): Boolean = try { check(ctx) } catch (e: Throwable) { false }

    fun status(ctx: Context): String? = if (granted(ctx)) null else try { detail(ctx) } catch (e: Throwable) { null }

    /** Never throws: ROMs remove or rename settings screens, so fall back to the app's details page. */
    fun open(a: Activity) {
        try {
            go(a)
        } catch (e: Throwable) {
            try { a.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri(a))) } catch (_: Throwable) {}
        }
    }
}

/** The single list of permissions shown by the first-launch guide and the diagnostics page. */
object Permissions {
    private const val SHIZUKU_SITE = "https://shizuku.rikka.app/"
    private const val SHIZUKU_REQUEST = 42

    val all: List<Permission> by lazy {
        buildList {
            add(Permission(
                "notifications", "通知", "提醒、需要你确认的卡片，都靠通知送达",
                { it.getSystemService(NotificationManager::class.java).areNotificationsEnabled() },
                { a ->
                    a.startActivity(
                        if (Build.VERSION.SDK_INT >= 26) Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, a.packageName)
                        else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri(a)),
                    )
                },
            ))
            add(Permission(
                "battery", "不受电池优化限制", "让 Ash 在后台常驻，定时提醒准时响起",
                { it.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(it.packageName) },
                { a -> a.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkgUri(a))) },
            ))
            add(Permission(
                "accessibility", "无障碍（屏幕助手）", "让 Ash 看懂屏幕内容，并替你点击、输入、滚动",
                { A11yService.instance != null },
                { a -> a.startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) },
                { "在列表里找到「Ash 屏幕助手」并打开" },
            ))
            if (Build.VERSION.SDK_INT >= 30) add(Permission(
                "all_files", "所有文件访问", "让 Ash 读写手机存储里的照片、下载和文档",
                { Environment.isExternalStorageManager() },
                { a ->
                    try {
                        a.startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, pkgUri(a)))
                    } catch (e: Throwable) {
                        a.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                    }
                },
            ))
            add(Permission(
                "usage", "使用情况访问", "让 Ash 知道你常用哪些应用、用了多久",
                { ctx ->
                    val ops = ctx.getSystemService(AppOpsManager::class.java)
                    @Suppress("DEPRECATION")
                    ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), ctx.packageName) == AppOpsManager.MODE_ALLOWED
                },
                { a -> a.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)) },
            ))
            add(Permission(
                "write_settings", "修改系统设置", "让 Ash 帮你调亮度、屏幕超时等系统设置",
                { Settings.System.canWrite(it) },
                { a -> a.startActivity(Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, pkgUri(a))) },
            ))
            add(Permission(
                "overlay", "悬浮窗", "Ash 在虚拟屏上替你操作时，用小窗实时显示画面",
                { Settings.canDrawOverlays(it) },
                { a -> a.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkgUri(a))) },
            ))
            add(Permission(
                "shizuku", "Shizuku", "解锁高级能力：执行 shell 命令、虚拟屏（在后台操作应用，不打扰你）",
                { ShizukuState.ready() },
                ::openShizuku,
                { ctx ->
                    when {
                        !ShizukuState.installed(ctx) -> "需要先安装 Shizuku（点「去开启」打开下载页）"
                        !ShizukuState.running() -> "Shizuku 已安装但没有启动：打开 Shizuku 启动服务"
                        else -> "Shizuku 已启动，等待授权给 Ash"
                    }
                },
            ))
        }
    }

    fun grantedCount(ctx: Context): Int = all.count { it.granted(ctx) }

    /** Not installed → download page; installed but not running → the Shizuku app (to start it); running → its permission dialog. */
    private fun openShizuku(a: Activity) {
        val site = Intent(Intent.ACTION_VIEW, Uri.parse(SHIZUKU_SITE))
        if (!ShizukuState.installed(a)) return a.startActivity(site)
        if (ShizukuState.running()) {
            try {
                if (rikka.shizuku.Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED) rikka.shizuku.Shizuku.requestPermission(SHIZUKU_REQUEST)
                return
            } catch (e: Throwable) {
                // Pre-v11 servers throw here: the Shizuku app is where the owner can fix that.
            }
        }
        val launch = a.packageManager.getLaunchIntentForPackage(ShizukuState.MANAGER_PACKAGE)
        a.startActivity(launch ?: site)
    }
}

private fun pkgUri(ctx: Context): Uri = Uri.parse("package:${ctx.packageName}")
