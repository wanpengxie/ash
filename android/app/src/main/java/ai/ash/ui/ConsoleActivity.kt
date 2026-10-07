package ai.ash.ui

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import ai.ash.host.CoreProcess
import ai.ash.host.CoreService
import ai.ash.host.HostServer
import ai.ash.host.LogShareProvider
import ai.ash.host.ContainerInstaller
import ai.ash.host.PayloadInstaller
import ai.ash.host.Paths
import ai.ash.host.Permissions
import ai.ash.host.senses.NotificationSenseSettings
import java.io.File
import java.io.RandomAccessFile

/** Diagnostics: the core process, the phone permissions ash can use, logs, payload. No business logic. */
class ConsoleActivity : Activity() {
    private lateinit var info: TextView
    private lateinit var perms: LinearLayout
    private lateinit var notificationState: TextView
    private lateinit var notificationToggle: Button
    private lateinit var recoveryState: TextView
    private lateinit var recoveryToggle: Button
    private lateinit var residentState: TextView
    private lateinit var residentToggle: Button
    private lateinit var logView: TextView
    private val ui = Handler(Looper.getMainLooper())

    override fun onCreate(savedInstanceState: Bundle?) {
        val night = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES
        setTheme(if (night) ai.ash.R.style.Ash_Dark else ai.ash.R.style.Ash_Light)
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(40, 60, 40, 60) }
        fun h(t: String) = root.addView(TextView(this).apply { text = t; textSize = 17f; setTypeface(typeface, Typeface.BOLD); setPadding(0, 36, 0, 12) })
        fun row(vararg bs: Pair<String, () -> Unit>) = root.addView(LinearLayout(this).apply {
            for ((label, fn) in bs) addView(Button(context).apply { text = label; isAllCaps = false; setOnClickListener { fn() } })
        })

        h("Ash 诊断")
        info = TextView(this).apply { textSize = 13f; setTextIsSelectable(true) }
        root.addView(info)
        row("启动" to { CoreService.start(this, CoreService.ACTION_START) }, "停止" to { CoreService.start(this, CoreService.ACTION_STOP) }, "重启" to { CoreService.start(this, CoreService.ACTION_RESTART) })
        row("移除网关配置" to {
            AlertDialog.Builder(this)
                .setTitle("移除本机网关配置？")
                .setMessage("仅移除本机的网关地址和未使用的一次性密钥，然后重启 Ash；不会删除对话或其他数据。")
                .setNegativeButton("取消", null)
                .setPositiveButton("移除") { _, _ ->
                    val paths = Paths(this)
                    val removed = runCatching {
                        if (paths.gateway.exists()) check(paths.gateway.delete())
                        if (paths.gatewayBootstrap.exists()) check(paths.gatewayBootstrap.delete())
                        CoreService.start(this, CoreService.ACTION_RESTART)
                    }.isSuccess
                    Toast.makeText(this, if (removed) "已移除网关配置" else "移除失败", Toast.LENGTH_SHORT).show()
                }.show()
        })

        h("手机权限（给 Ash 用的能力）")
        perms = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(perms)
        row("权限引导" to { startActivity(Intent(this, OnboardingActivity::class.java)) }, "显示虚拟屏预览" to { showPreview() })

        h("无障碍自动恢复")
        recoveryState = TextView(this).apply { textSize = 13f }
        root.addView(recoveryState)
        recoveryToggle = Button(this).apply {
            isAllCaps = false
            setOnClickListener {
                val ctx = this@ConsoleActivity
                ai.ash.host.screen.ScreenRecovery.setEnabled(ctx, !ai.ash.host.screen.ScreenRecovery.enabled(ctx)); renderRecovery()
            }
        }
        root.addView(recoveryToggle)

        h("灵动岛常驻入口")
        residentState = TextView(this).apply { textSize = 13f }
        root.addView(residentState)
        residentToggle = Button(this).apply {
            isAllCaps = false
            setOnClickListener { TaskCapsule.setResidentKept(this@ConsoleActivity, !TaskCapsule.residentKept(this@ConsoleActivity)); renderResident() }
        }
        root.addView(residentToggle)

        h("通知读取（可选，默认关闭）")
        notificationState = TextView(this).apply { textSize = 13f }
        root.addView(notificationState)
        notificationToggle = Button(this).apply {
            isAllCaps = false
            setOnClickListener {
                if (NotificationSenseSettings.enabled(this@ConsoleActivity)) {
                    if (!NotificationSenseSettings.setEnabled(this@ConsoleActivity, false)) Toast.makeText(context, "保存失败", Toast.LENGTH_SHORT).show()
                    renderNotificationSense()
                } else {
                    AlertDialog.Builder(this@ConsoleActivity)
                        .setTitle("开启通知读取？")
                        .setMessage("仅在你开启本开关并授予系统访问权后，Ash 才会读取新通知的应用、标题和正文并发送给本机服务。关闭本开关或撤销系统权限后停止；不会补读已有通知。")
                        .setNegativeButton("取消", null)
                        .setPositiveButton("继续") { _, _ ->
                            if (!NotificationSenseSettings.setEnabled(this@ConsoleActivity, true)) Toast.makeText(context, "保存失败", Toast.LENGTH_SHORT).show()
                            renderNotificationSense()
                            if (NotificationSenseSettings.enabled(this@ConsoleActivity) && !NotificationSenseSettings.granted(this@ConsoleActivity)) openNotificationAccess()
                        }.show()
                }
            }
        }
        root.addView(notificationToggle)
        row("系统读取权限" to { openNotificationAccess() })

        h("日志")
        row("刷新" to { showLog() }, "分享日志" to { shareLogs() })
        logView = TextView(this).apply { textSize = 10.5f; typeface = Typeface.MONOSPACE; setTextIsSelectable(true) }
        root.addView(logView)

        h("运行环境")
        row("重新安装运行环境" to {
            Paths(this).buildMarker.delete()
            CoreService.start(this, CoreService.ACTION_RESTART)
        })

        setContentView(ScrollView(this).apply { addView(root) })
        refresh()
        showLog()
    }

    private fun refresh() {
        if (isFinishing) return
        Thread {
            val p = Paths(this)
            val core = CoreProcess(this)
            val pid = core.pid()
            val open = core.portOpen(1000)
            val text = buildString {
                append("服务：${CoreService.state}\n")
                append("ash core：${pid?.let { "pid $it" } ?: "未运行"}${if (open) "，端口 ${CoreProcess.PORT} 在线" else ""}\n")
                append("本机桥：127.0.0.1:${HostServer.PORT}\n")
                append("运行环境：${PayloadInstaller.installedBuild(p) ?: "未安装"}")
                PayloadInstaller.shippedBuild(this@ConsoleActivity)?.let { if (it != PayloadInstaller.installedBuild(p)) append("（待安装 $it）") }
                append("\n工作环境：${ContainerInstaller.installedVersion(p) ?: "未安装"}")
                ContainerInstaller.shippedVersion(this@ConsoleActivity)?.let { if (it != ContainerInstaller.installedVersion(p)) append("（待安装 $it）") }
                append("\nApp：${packageManager.getPackageInfo(packageName, 0).versionName}  Android ${Build.VERSION.RELEASE}（API ${Build.VERSION.SDK_INT}）")
            }
            ui.post { info.text = text; renderPerms(); renderNotificationSense(); renderRecovery(); renderResident() }
        }.start()
        ui.postDelayed({ refresh() }, 3000)
    }

    private fun renderPerms() {
        perms.removeAllViews()
        for (item in Permissions.all) {
            val ok = item.granted(this)
            val extra = item.status(this)?.let { "\n$it" } ?: ""
            perms.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(TextView(context).apply { text = "${if (ok) "✅" else "⚪️"} ${item.title}\n${item.why}$extra"; textSize = 13f; layoutParams = LinearLayout.LayoutParams(0, -2, 1f) })
                if (!ok) addView(Button(context).apply { text = "去开启"; isAllCaps = false; setOnClickListener { item.open(this@ConsoleActivity) } })
                // A switch the phone keeps from Ash: try it, then say it is done.
                if (!ok && item.test != null && item.ready(this@ConsoleActivity))
                    addView(Button(context).apply { text = "测试"; isAllCaps = false; setOnClickListener { item.test.invoke(this@ConsoleActivity) } })
                if (item.awaitsWord(this@ConsoleActivity))
                    addView(Button(context).apply { text = "已设好"; isAllCaps = false; setOnClickListener { item.confirm(this@ConsoleActivity); renderPerms() } })
            })
        }
    }

    /** What recovery may do, whether it is on, and when it last acted. */
    private fun renderRecovery() {
        val r = ai.ash.host.screen.ScreenRecovery
        val times = r.history(this).takeLast(3).reversed().joinToString("、") { java.text.SimpleDateFormat("M月d日 HH:mm", java.util.Locale.CHINA).format(java.util.Date(it)) }
        recoveryState.text = buildString {
            append(if (!r.granted(this@ConsoleActivity)) "未授权（见上方「无障碍自动恢复」）。" else if (r.enabled(this@ConsoleActivity)) "已开启。" else "已关闭。")
            append("只做一件事：屏幕助手的无障碍开关开着、但它被系统停掉时，把它重新拉起来；你关掉的开关不会去开。")
            append(if (times.isEmpty()) "还没有恢复过。" else "最近恢复：$times。")
        }
        recoveryToggle.text = if (r.enabled(this)) "关闭自动恢复" else "开启自动恢复"
        recoveryToggle.visibility = if (r.granted(this)) View.VISIBLE else View.GONE
    }

    /** The island's resident entry: on, off, or waiting for a screen helper that can draw it. */
    private fun renderResident() {
        val kept = TaskCapsule.residentKept(this)
        residentState.text = when {
            !kept -> "已关闭：灵动岛只在任务进行中、或有你没看过的新东西时出现。"
            !ai.ash.host.screen.ScreenBridge.islandResident() -> "已开启，等屏幕助手连上（需要新版屏幕助手）后出现。"
            else -> "已开启：平时贴着摄像头显示 Ash 的头像。轻点直接跟 Ash 说，长按打开 Ash，上划收起到下次解锁。"
        }
        residentToggle.text = if (kept) "关闭常驻入口" else "开启常驻入口"
    }

    private fun renderNotificationSense() {
        val enabled = NotificationSenseSettings.enabled(this)
        val granted = NotificationSenseSettings.granted(this)
        notificationState.text = when {
            !enabled -> "本机开关：关闭。系统授权：${if (granted) "已授权，但不会读取" else "未授权"}。"
            !granted -> "本机开关：开启；等待系统读取权限，不会发送通知内容。"
            else -> "本机开关与系统权限均已开启：仅发送之后新到的通知。"
        }
        notificationToggle.text = if (enabled) "关闭通知读取" else "开启通知读取"
    }

    private fun openNotificationAccess() {
        try {
            startActivity(NotificationSenseSettings.accessIntent(this))
        } catch (_: Exception) {
            try { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
            catch (_: Exception) { Toast.makeText(this, "无法打开系统通知读取设置", Toast.LENGTH_SHORT).show() }
        }
    }

    private fun showPreview() {
        val msg = when (VScreenPreview.show(this)) {
            VScreenPreview.Shown.OK -> "已显示虚拟屏预览"
            VScreenPreview.Shown.NO_SCREEN -> "当前没有虚拟屏（Ash 用到虚拟屏时会自动显示预览）"
            VScreenPreview.Shown.NO_PERMISSION -> "需要先开启「悬浮窗」权限"
        }
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }

    private fun tail(f: File, bytes: Long = 48 * 1024): String {
        if (!f.exists()) return "（没有日志）"
        RandomAccessFile(f, "r").use { r ->
            val start = maxOf(0L, r.length() - bytes)
            r.seek(start)
            val b = ByteArray((r.length() - start).toInt())
            r.readFully(b)
            // Tokens never belong on screen (they are only in files, but be safe).
            return String(b, Charsets.UTF_8).replace(Regex("token=[A-Za-z0-9_-]+"), "token=<hidden>")
        }
    }

    private fun showLog() {
        Thread {
            val t = tail(Paths(this).coreLog)
            ui.post { logView.text = t }
        }.start()
    }

    private fun shareLogs() {
        Thread {
            val p = Paths(this)
            val out = File(LogShareProvider.shareDir(this), "ash-logs.txt")
            out.writeText(
                "== core.log\n" + tail(p.coreLog, 512 * 1024) +
                    "\n\n== dsh.log\n" + tail(File(p.containerDshHome, "logs/dsh.log"), 256 * 1024),
            )
            ui.post {
                startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_STREAM, LogShareProvider.uriFor(this@ConsoleActivity, out.name))
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }, "分享 Ash 日志"))
            }
        }.start()
    }

    override fun onDestroy() {
        ui.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    @Suppress("unused")
    private fun hide(v: View) { v.visibility = View.GONE }
}
