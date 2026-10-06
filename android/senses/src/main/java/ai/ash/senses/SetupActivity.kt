package ai.ash.senses

import ai.ash.senses.health.GadgetbridgeSource
import ai.ash.senses.health.HealthConnectSource
import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.health.connect.client.PermissionController

/**
 * The owner's page: each permission and data source, its state, and a button to the system's own screen for it.
 * Nothing is granted for the owner; every grant is the owner's tap on a system page. Also where Health Connect sends
 * the owner to read why the app asks.
 */
class SetupActivity : Activity() {
    private class Row(val title: String, val why: String, val button: String, val status: () -> Pair<Boolean, String>, val act: () -> Unit) {
        lateinit var statusView: TextView
        lateinit var buttonView: Button
    }

    private lateinit var rows: List<Row>
    @Volatile private var visible = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        Senses.init(this)
        rows = listOf(
            Row("位置", "取当前位置、记录轨迹；没有它就没有任何位置数据", "授权", {
                when {
                    Senses.preciseLocation(this) -> true to "已授权（精确）"
                    Senses.locationPermission(this) -> true to "已授权（大致位置）"
                    else -> false to "未授权"
                }
            }) { requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), REQ_PERMS) },
            Row("后台位置（始终允许）", "锁屏或不在前台时也能取到位置", "去设置", {
                if (Senses.backgroundLocation(this)) true to "已允许" else false to "未允许：在「权限 → 位置」里选「始终允许」"
            }) {
                when {
                    !Senses.locationPermission(this) -> Toast.makeText(this, "先授予上一项「位置」", Toast.LENGTH_LONG).show()
                    Build.VERSION.SDK_INT == 29 -> requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), REQ_PERMS)
                    else -> { Toast.makeText(this, "在「权限 → 位置」里选「始终允许」", Toast.LENGTH_LONG).show(); appDetails() }
                }
            },
            Row("运动与健身", "计步、区分静止/步行/跑步", "授权", {
                if (Senses.activityRecognition(this)) true to (if (StepReader.available(this)) "已授权" else "已授权（这台手机没有计步器）") else false to "未授权"
            }) { if (Build.VERSION.SDK_INT >= 29) requestPermissions(arrayOf(Manifest.permission.ACTIVITY_RECOGNITION), REQ_PERMS) },
            Row("通知", "记录时常驻一条通知，可一键「停止记录」", "授权", {
                if (Senses.notifications(this)) true to "已允许" else false to "未允许"
            }) {
                if (Build.VERSION.SDK_INT >= 33 && !Senses.granted(this, Manifest.permission.POST_NOTIFICATIONS)) requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_PERMS)
                else startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
            },
            Row("不受电池优化限制", "后台记录不被系统停掉；也让 Ash 能在后台开始记录", "去开启", {
                if (Senses.batteryUnrestricted(this)) true to "已放行" else false to "未放行"
            }) {
                if (!Senses.batteryUnrestricted(this)) startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
                else { Toast.makeText(this, "在应用信息里把自启动、后台运行也打开", Toast.LENGTH_LONG).show(); appDetails() }
            },
            Row("Health Connect", "只读：步数、心率、睡眠、体重、体脂、活动热量、距离、锻炼", "授权", {
                when (HealthConnectSource.state(this)) {
                    "available" -> {
                        val granted = HealthConnectSource.granted(this)
                        val n = HealthConnectSource.PERMISSIONS.count { it in granted }
                        (n > 0) to "已授权 $n / ${HealthConnectSource.PERMISSIONS.size} 项" + if (HealthConnectSource.BACKGROUND in granted) "（含后台读取）" else ""
                    }
                    "update_required" -> false to "需要更新 Health Connect"
                    else -> false to "这台手机没有 Health Connect"
                }
            }) {
                if (HealthConnectSource.state(this) == "available") {
                    val contract = PermissionController.createRequestPermissionResultContract(HealthConnectSource.PROVIDER)
                    runCatching { startActivityForResult(contract.createIntent(this, HealthConnectSource.requested()), REQ_HEALTH) }
                        .onFailure { Toast.makeText(this, "无法打开 Health Connect：${it.message}", Toast.LENGTH_LONG).show() }
                } else runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=${HealthConnectSource.PROVIDER}"))) }
                    .onFailure { Toast.makeText(this, "没有应用商店可以安装 Health Connect", Toast.LENGTH_LONG).show() }
            },
            Row("Gadgetbridge 导出文件夹", "手表经 Gadgetbridge 同步后，读它自动导出的数据库（只读）", "选择文件夹", {
                val installed = GadgetbridgeSource.installedVersion(this) != null
                val folder = GadgetbridgeSource.folder(this)
                when {
                    folder == null -> false to (if (installed) "未选择：选 Gadgetbridge「自动导出」用的那个文件夹" else "Gadgetbridge 未安装；装好并设好自动导出后选择文件夹")
                    else -> {
                        val doc = GadgetbridgeSource.newest(this)
                        true to (if (doc == null) "已授权，但文件夹里还没有导出" else "已授权；最新导出 ${doc.name}（${android.text.format.DateFormat.format("MM-dd HH:mm", doc.modified)}）")
                    }
                }
            }) { runCatching { startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQ_FOLDER) } },
            Row("蓝牙（附近的设备）", "检测手表连接；之后读体脂秤", "授权", {
                if (Senses.bluetooth(this)) true to "已授权" else false to "未授权"
            }) { if (Build.VERSION.SDK_INT >= 31) requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT), REQ_PERMS) },
            Row("位置与运动记录", "开启后常驻通知；移动时按间隔记录位置，静止时不取位置；数据只存在本机，交给 Ash", "开始记录", {
                val c = Senses.config(this)
                if (c.recording) true to "记录中（每 ${c.intervalMin} 分钟，保留 ${c.retentionDays} 天）" + (Recorder.lastProblem?.let { "\n$it" } ?: "") else false to "已关闭"
            }) {
                val c = Senses.config(this)
                if (!c.recording && !Senses.locationPermission(this)) { Toast.makeText(this, "先授予「位置」", Toast.LENGTH_LONG).show(); return@Row }
                Senses.configure(this, c.copy(recording = !c.recording))?.let { Toast.makeText(this, it, Toast.LENGTH_LONG).show() }
                refresh()
            },
            Row("删除已有记录", "删除本机存下的全部位置、运动、步数和健康记录（包括还没交给 Ash 的）", "删除", { true to "" }) {
                AlertDialog.Builder(this).setTitle("删除全部记录？").setMessage("删除后无法恢复。")
                    .setPositiveButton("删除") { _, _ ->
                        Thread {
                            val n = Senses.store.delete("all", 0L until Long.MAX_VALUE)
                            Senses.prefs(this).edit().remove("geofence_inside").apply()
                            runOnUiThread { Toast.makeText(this, "已删除 $n 条", Toast.LENGTH_LONG).show(); refresh() }
                        }.start()
                    }.setNegativeButton("取消", null).show()
            },
        )
        setContentView(build())
    }

    private fun build(): View {
        val density = resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()
        val list = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(16), dp(20), dp(24)) }
        list.addView(TextView(this).apply { text = "Ash 感知"; textSize = 24f; typeface = Typeface.DEFAULT_BOLD })
        list.addView(TextView(this).apply {
            text = "为 Ash 记录位置、运动、步数，读取健康数据。默认什么都不记录；只有你开启「位置与运动记录」后才采集。" +
                "数据只存在这台手机上，交给你的 Ash；健康数据只读，不写入任何地方。每项授权都由你在系统页面自己完成，可随时撤销，撤销后立即读不到。"
            textSize = 14f; setTextColor(Color.DKGRAY); setPadding(0, dp(8), 0, dp(12))
        })
        for (r in rows) {
            val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, dp(14), 0, dp(4)) }
            box.addView(TextView(this).apply { text = r.title; textSize = 17f; typeface = Typeface.DEFAULT_BOLD })
            box.addView(TextView(this).apply { text = r.why; textSize = 13f; setTextColor(Color.GRAY) })
            r.statusView = TextView(this).apply { textSize = 14f; setPadding(0, dp(4), 0, dp(4)) }
            box.addView(r.statusView)
            r.buttonView = Button(this).apply { text = r.button; setOnClickListener { r.act() } }
            box.addView(r.buttonView, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
            list.addView(box)
        }
        val scroll = ScrollView(this).apply { addView(list) }
        // Drawn edge to edge (targetSdk 35): keep clear of the status and navigation bars.
        scroll.setOnApplyWindowInsetsListener { v, insets ->
            @Suppress("DEPRECATION") v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
        return scroll
    }

    override fun onResume() { super.onResume(); visible = true; refresh() }
    override fun onPause() { visible = false; super.onPause() }

    /** States are read off the main thread: Health Connect and the export folder answer slowly. */
    private fun refresh() {
        Thread {
            val states = rows.map { r -> runCatching { r.status() }.getOrElse { false to "无法读取：${it.message}" } }
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                rows.zip(states).forEach { (r, s) ->
                    r.statusView.text = s.second
                    r.statusView.visibility = if (s.second.isEmpty()) View.GONE else View.VISIBLE
                    r.statusView.setTextColor(if (s.first) Color.rgb(0x2E, 0x7D, 0x32) else Color.rgb(0xC6, 0x28, 0x28))
                    if (r.title == "位置与运动记录") r.buttonView.text = if (Senses.config(this).recording) "停止记录" else "开始记录"
                }
            }
        }.start()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (grantResults.any { it != android.content.pm.PackageManager.PERMISSION_GRANTED } && permissions.none { shouldShowRequestPermissionRationale(it) }) {
            // Refused twice: the system no longer asks. Its settings page still can.
            Toast.makeText(this, "系统不再弹窗询问：在应用信息的「权限」里打开", Toast.LENGTH_LONG).show()
            appDetails()
        }
        AshLink.changed()
        refresh()
    }

    @Deprecated("") override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION") super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FOLDER && resultCode == RESULT_OK) data?.data?.let { uri ->
            runCatching { GadgetbridgeSource.setFolder(this, uri) }.onFailure { Toast.makeText(this, "没能保存文件夹授权：${it.message}", Toast.LENGTH_LONG).show() }
        }
        AshLink.changed()
        refresh()
    }

    private fun appDetails() = startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))

    companion object {
        private const val REQ_PERMS = 1
        private const val REQ_HEALTH = 2
        private const val REQ_FOLDER = 3
    }
}
