package ai.ash.host.screen

import ai.ash.bridge.Bridge
import ai.ash.bridge.KeepAliveSwitches
import ai.ash.bridge.KeepAliveSwitches.Report
import ai.ash.host.PhoneMaker
import ai.ash.host.Permissions
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 「帮我打开」: on ColorOS the screen helper turns on, in the system's settings, the switches that keep Ash's own three
 * apps alive. Only the owner's tap on one of the three keep-alive entries starts it; it is not a tool in the phone's
 * manifest, so no agent can. Anything short of a clean run falls back to the written guidance.
 */
object KeepAliveFlow {
    private val running = AtomicBoolean(false)
    private val main = Handler(Looper.getMainLooper())

    /** The permission entry each app's switches settle. */
    private val keys = mapOf(KeepAliveSwitches.ASH_PACKAGE to "autostart", Bridge.SCREEN_PACKAGE to "screen_keepalive", Bridge.SENSES_PACKAGE to "senses_keepalive")

    /** A helper that has the flow is connected with its accessibility service on, on a phone whose settings it knows. */
    fun available(ctx: Context): Boolean = PhoneMaker.current == PhoneMaker.COLOROS && ScreenBridge.accessibility() &&
        ScreenBridge.installedVersion(ctx) >= KeepAliveSwitches.MIN_HELPER_VERSION && !ScreenBridge.needsInstall(ctx)

    /** Asks the owner, then runs; [guidance] is the old way (written steps), used when this cannot be offered or does not finish. */
    fun offer(a: Activity, guidance: () -> Unit) {
        if (!available(a)) return guidance()
        if (running.get()) { Toast.makeText(a, "正在打开中，请稍等", Toast.LENGTH_SHORT).show(); return }
        AlertDialog.Builder(a).setTitle("帮我打开")
            .setMessage("让屏幕助手替你打开 Ash、Ash 感知、屏幕助手的开机自启动、后台自启动和后台行为？期间请不要操作手机。")
            .setPositiveButton("确定") { _, _ -> start(a, guidance) }
            .setNegativeButton("取消", null).show()
    }

    private fun start(a: Activity, guidance: () -> Unit) {
        if (!running.compareAndSet(false, true)) return
        val ctx = a.applicationContext
        val asked = KeepAliveSwitches.targets.filter { installed(ctx, it.pkg) }
        Thread({
            val report = try { run(asked) } finally { running.set(false) }
            main.post { finish(a, asked, report, guidance) }
        }, "ash-keepalive-switches").start()
    }

    private fun installed(ctx: Context, pkg: String) = runCatching { ctx.packageManager.getPackageInfo(pkg, 0) }.isSuccess

    private fun run(asked: List<KeepAliveSwitches.Target>): Report? {
        val args = JSONObject().put("packages", JSONArray(asked.map { it.pkg }))
        val result = ScreenBridge.call(KeepAliveSwitches.CAPABILITY, args)
        return (result.data as? JSONObject)?.takeIf { result.ok }?.let { Report.fromJson(it) }
    }

    private fun finish(a: Activity, asked: List<KeepAliveSwitches.Target>, report: Report?, guidance: () -> Unit) {
        if (report == null || report.outcome == KeepAliveSwitches.Outcome.UNSUPPORTED) {
            Toast.makeText(a, "没能代你打开，请按提示自己打开", Toast.LENGTH_LONG).show()
            return guidance()
        }
        // Only a switch seen on again counts as done.
        for (t in asked) if (report.verified(t.pkg)) keys[t.pkg]?.let { Permissions.confirm(a.applicationContext, it) }
        val all = asked.all { report.verified(it.pkg) }
        val text = report.summary(asked)
        if (a.isFinishing || a.isDestroyed) return run { Toast.makeText(a.applicationContext, text, Toast.LENGTH_LONG).show() }
        AlertDialog.Builder(a).setTitle(if (all) "都打开了" else "没有全部打开").setMessage(text)
            .setPositiveButton("好的", null)
            .apply { if (!all) setNeutralButton("自己去开") { _, _ -> guidance() } }
            .show()
    }
}
