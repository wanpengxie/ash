package ai.ash.ui

import android.app.Activity
import android.app.AppOpsManager
import android.app.NotificationManager
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import ai.ash.host.CoreProcess
import ai.ash.host.CoreService
import ai.ash.host.HostServer
import ai.ash.host.LogShareProvider
import ai.ash.host.PayloadInstaller
import ai.ash.host.Paths
import ai.ash.host.a11y.A11yService
import java.io.File
import java.io.RandomAccessFile

/** Diagnostics: the core process, the phone permissions ash can use, logs, payload. No business logic. */
class ConsoleActivity : Activity() {
    private lateinit var info: TextView
    private lateinit var perms: LinearLayout
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

        h("手机权限（给 Ash 用的能力）")
        perms = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(perms)

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
                append("\nApp：${packageManager.getPackageInfo(packageName, 0).versionName}  Android ${Build.VERSION.RELEASE}（API ${Build.VERSION.SDK_INT}）")
            }
            ui.post { info.text = text; renderPerms() }
        }.start()
        ui.postDelayed({ refresh() }, 3000)
    }

    private fun renderPerms() {
        perms.removeAllViews()
        fun perm(label: String, ok: Boolean, why: String, fix: () -> Unit) {
            perms.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(TextView(context).apply { text = "${if (ok) "✅" else "⚪️"} $label\n$why"; textSize = 13f; layoutParams = LinearLayout.LayoutParams(0, -2, 1f) })
                if (!ok) addView(Button(context).apply { text = "去开启"; isAllCaps = false; setOnClickListener { runCatching { fix() } } })
            })
        }
        val nm = getSystemService(NotificationManager::class.java)
        perm("通知", nm.areNotificationsEnabled(), "提醒、确认卡片都靠通知") {
            startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
        }
        val pm = getSystemService(PowerManager::class.java)
        perm("不受电池优化限制", pm.isIgnoringBatteryOptimizations(packageName), "后台常驻、定时提醒准时") {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        }
        perm("无障碍（屏幕助手）", A11yService.instance != null, "读屏、点击、输入（screen.* 能力）") {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        val ops = getSystemService(AppOpsManager::class.java)
        @Suppress("DEPRECATION")
        val usage = ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, android.os.Process.myUid(), packageName) == AppOpsManager.MODE_ALLOWED
        perm("使用情况访问", usage, "应用使用统计（apps.usage）") { startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)) }
        perm("修改系统设置", Settings.System.canWrite(this), "调整亮度等系统设置（settings.put）") {
            startActivity(Intent(Settings.ACTION_MANAGE_WRITE_SETTINGS, Uri.parse("package:$packageName")))
        }
        if (Build.VERSION.SDK_INT >= 30) perm("所有文件访问", Environment.isExternalStorageManager(), "让 Ash 读写手机存储里的文件") {
            startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
        }
        perm("Shizuku", shizukuOk(), "shell、虚拟屏等高级能力（需要安装并启动 Shizuku）") { requestShizuku() }
    }

    private fun shizukuOk(): Boolean = try {
        rikka.shizuku.Shizuku.pingBinder() && rikka.shizuku.Shizuku.checkSelfPermission() == android.content.pm.PackageManager.PERMISSION_GRANTED
    } catch (e: Throwable) {
        false
    }

    private fun requestShizuku() {
        try {
            if (rikka.shizuku.Shizuku.pingBinder()) rikka.shizuku.Shizuku.requestPermission(42)
            else startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://shizuku.rikka.app/")))
        } catch (e: Throwable) {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://shizuku.rikka.app/")))
        }
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
                    "\n\n== dsh.log\n" + tail(File(p.dshHome, "logs/dsh.log"), 256 * 1024),
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
