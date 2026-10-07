package ai.ash.host

import android.app.Activity
import android.Manifest
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
import ai.ash.bridge.Bridge
import ai.ash.host.screen.KeepAliveFlow
import ai.ash.host.screen.ScreenBridge
import android.widget.Toast
import ai.ash.host.screen.ScreenInstaller
import ai.ash.host.screen.ScreenRecovery
import ai.ash.host.senses.SensesBridge
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
    /**
     * The phone keeps this switch where Ash cannot read it (a maker's own notification or background settings): the
     * owner says it is done. [check] still has to hold for it to count.
     */
    val confirmable: (Context) -> Boolean = { false },
    /** Lets the owner feel it work (a test reminder), or null. */
    val test: ((Activity) -> Unit)? = null,
) {
    fun granted(ctx: Context): Boolean = ready(ctx) && (!confirmable(ctx) || Permissions.confirmed(ctx, key))
    /** What Ash can read of it holds; a [confirmable] one then waits for the owner's word. */
    fun ready(ctx: Context): Boolean = try { check(ctx) } catch (e: Throwable) { false }
    /** The owner may now say it is done. */
    fun awaitsWord(ctx: Context): Boolean = !granted(ctx) && ready(ctx) && confirmable(ctx)
    /** The owner says the switch the phone hides from Ash is on. */
    fun confirm(ctx: Context) = Permissions.confirm(ctx, key)

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
    private const val PREFS = "ash.permissions"

    fun confirmed(ctx: Context, key: String) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("confirmed:$key", false)
    fun confirm(ctx: Context, key: String) { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("confirmed:$key", true).apply() }

    val all: List<Permission> by lazy {
        buildList {
            add(Permission(
                "calendar", "日历", "只在授权后读取接下来一天的日程与提醒",
                { it.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED },
                { a -> a.requestPermissions(arrayOf(Manifest.permission.READ_CALENDAR), 7102) },
            ))
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
                "alerts", "提醒的铃声和振动", "任务做完、需要你审批、到点提醒时，手机响铃、振动、弹横幅叫你",
                { ctx -> Notifications.ringing(ctx) },
                { a ->
                    Toast.makeText(a, "在这一页${PhoneMaker.current.alerts}", Toast.LENGTH_LONG).show()
                    a.startActivity(
                        if (Build.VERSION.SDK_INT >= 26) Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, a.packageName)
                        else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri(a)),
                    )
                },
                { "在 Ash 的通知设置里${PhoneMaker.current.alerts}" },
                confirmable = { PhoneMaker.current.ownSwitches },
                test = { a -> Notifications.testAlert(a) },
            ))
            add(Permission(
                "battery", "不受电池优化限制", "让 Ash 在后台常驻，定时提醒准时响起",
                { it.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(it.packageName) },
                { a -> a.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkgUri(a))) },
            ))
            add(Permission(
                "autostart", "Ash 自启动与后台运行", "被系统清理或手机重启后，Ash 自己回来；不开的话，被清理后要等你再打开它",
                { it.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(it.packageName) },
                { a ->
                    val own = { PhoneMaker.current.openKeepAlive(a, a.packageName, "Ash") }
                    // The helper can turn the switches on for the owner; the written steps are the way back.
                    if (a.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(a.packageName)) KeepAliveFlow.offer(a, own) else own()
                },
                { c ->
                    if (!c.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(c.packageName)) "先完成上一项「不受电池优化限制」"
                    else PhoneMaker.current.keepAliveFor("Ash")
                },
                confirmable = { PhoneMaker.current.ownSwitches },
            ))
            add(Permission(
                "lock", "在最近任务里锁定 Ash", "锁定后，系统清理后台时会尽量留下 Ash",
                { true },
                { a ->
                    Toast.makeText(a, PhoneMaker.current.lock.replace("它", "Ash "), Toast.LENGTH_LONG).show()
                    a.startActivity(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                },
                { PhoneMaker.current.lock.replace("它", "Ash ") },
                confirmable = { PhoneMaker.current.ownSwitches },
            ))
            add(Permission(
                "notification_access", "通知使用权", "系统会一直连着 Ash；Ash 被清理后，手机来通知时系统会把它叫回来。读通知内容另需你在 Ash 里单独打开",
                { ai.ash.host.senses.NotificationSenseSettings.granted(it) },
                { a ->
                    try { a.startActivity(ai.ash.host.senses.NotificationSenseSettings.accessIntent(a)) }
                    catch (e: Throwable) { a.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
                },
                { "在列表里找到 Ash 并打开" },
            ))
            add(Permission(
                "accessibility", "屏幕助手（无障碍）", "让 Ash 看懂屏幕内容，替你点击、输入、滚动，并在其他应用上方显示灵动岛",
                { ScreenBridge.accessibility() && !ScreenBridge.needsInstall(it) },
                // A separate small app holds the accessibility service, so updating or restarting Ash never turns it off.
                { a -> if (ScreenBridge.needsInstall(a)) ScreenInstaller.install(a) else ScreenInstaller.openAccessibility(a) },
                { c ->
                    when {
                        ScreenBridge.installedVersion(c) == 0L -> "先安装「Ash 屏幕助手」（Ash 自带，点一下即可安装）"
                        ScreenBridge.needsInstall(c) -> "屏幕助手需要更新，点一下即可更新"
                        // The system stopped the helper: its switch stays on, but the service is not running.
                        ScreenBridge.switchedOn(c) -> "开关开着，但屏幕助手没在工作（系统清理过它）：在无障碍里把它关掉再打开"
                        else -> "在无障碍列表里找到「Ash 屏幕助手」并打开"
                    }
                },
            ))
            add(Permission(
                "screen_keepalive", "屏幕助手不被清理", "系统清理后台时会顺带停掉屏幕助手，无障碍就失效了；放行后它能一直在",
                { c -> ScreenBridge.installedVersion(c) > 0 && c.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(Bridge.SCREEN_PACKAGE) },
                { a -> ScreenInstaller.keepAlive(a) },
                { c ->
                    when {
                        ScreenBridge.installedVersion(c) == 0L -> "先安装屏幕助手（上一项）"
                        !c.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(Bridge.SCREEN_PACKAGE) -> "先允许它在后台运行（点「去开启」，系统会问你）"
                        else -> PhoneMaker.current.keepAliveFor("Ash 屏幕助手")
                    }
                },
                confirmable = { PhoneMaker.current.ownSwitches },
            ))
            add(Permission(
                "screen_lock", "在最近任务里锁定屏幕助手", "屏幕助手平时不在最近任务里；点「去开启」会打开它的一张卡片，锁上后系统清理时会尽量留下它",
                { c -> ScreenBridge.installedVersion(c) >= ScreenInstaller.LOCK_CARD_VERSION },
                { a -> ScreenInstaller.lockCard(a) },
                { c ->
                    if (ScreenBridge.installedVersion(c) < ScreenInstaller.LOCK_CARD_VERSION) "先安装或更新屏幕助手"
                    else PhoneMaker.current.lock.replace("它", "「Ash 屏幕助手」")
                },
                confirmable = { PhoneMaker.current.ownSwitches },
            ))
            add(Permission(
                "screen_recovery", "无障碍自动恢复", "系统清理掉屏幕助手后，Ash 几秒内把它的无障碍重新拉起来，不用你去手动开关",
                { ScreenRecovery.granted(it) },
                { a -> ScreenInstaller.grantRecovery(a) },
                { c -> if (ShizukuState.ready()) "点「去开启」，经 Shizuku 授权一次" else "需要授权一次：用 Shizuku，或在电脑上运行 ${ScreenRecovery.grantCommand(c)}" },
            ))
            add(Permission(
                "senses", "Ash 感知", "位置、运动、步数和健康数据：Ash 觉得有用时自己开启记录并告诉你，你说停就停；数据只存在手机上",
                { c -> !SensesBridge.needsInstall(c) && SensesBridge.connected() && SensesBridge.status().optJSONObject("permissions")?.optBoolean("location") == true },
                // A separate small app targets a current Android, which these permissions need; Ash itself cannot.
                { a -> if (SensesBridge.needsInstall(a)) HelperInstaller.install(a, Helper.SENSES) else SensesBridge.openSetup(a) },
                { c ->
                    when {
                        SensesBridge.installedVersion(c) == 0L -> "先安装「Ash 感知」（Ash 自带，点一下即可安装）"
                        SensesBridge.needsInstall(c) -> "Ash 感知需要更新，点一下即可更新"
                        !SensesBridge.connected() -> "已安装，还没连上：点一下打开它的设置页"
                        else -> "打开 Ash 感知，逐项授权位置、运动与健身、通知等"
                    }
                },
            ))
            add(Permission(
                "senses_keepalive", "Ash 感知不被清理", "记录位置时，系统清理后台会顺带停掉 Ash 感知，轨迹就断了；放行后它能一直记",
                { c -> SensesBridge.installedVersion(c) > 0 && c.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(Bridge.SENSES_PACKAGE) },
                { a ->
                    if (SensesBridge.installedVersion(a) == 0L) HelperInstaller.install(a, Helper.SENSES)
                    else if (!a.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(Bridge.SENSES_PACKAGE)) SensesBridge.openSetup(a)
                    else KeepAliveFlow.offer(a) { PhoneMaker.current.openKeepAlive(a, Bridge.SENSES_PACKAGE, "Ash 感知") }
                },
                { c ->
                    when {
                        SensesBridge.installedVersion(c) == 0L -> "先安装 Ash 感知（上一项）"
                        !c.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(Bridge.SENSES_PACKAGE) -> "先在 Ash 感知里允许它在后台运行"
                        else -> PhoneMaker.current.keepAliveFor("Ash 感知")
                    }
                },
                confirmable = { PhoneMaker.current.ownSwitches },
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
                "overlay", "悬浮窗", "跨应用显示 Ash 的任务进度，也可用小窗查看虚拟屏画面",
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
