package ai.ash.kernel

import android.app.Activity
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.text.InputFilter
import android.text.InputType
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import ai.ash.kernel.host.GuideService
import ai.ash.kernel.host.HostPresence
import ai.ash.kernel.host.KernelHost
import ai.ash.kernel.host.KernelPairing
import ai.ash.kernel.host.PairingStage
import ai.ash.kernel.host.adb.AdbKey

/**
 * 「Ash 内核」: the kernel's one screen, with a launcher icon and a task of its own, so that it has a card in recent apps
 * the owner can lock. It shows the brain and shell host separately, accepts the owner's pairing code, and starts the
 * kernel service like [StartActivity] does. Pairing accepts either the page input or the persistent notification input.
 * It reads nothing from the intent that opened it.
 */
open class StatusActivity : Activity() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var state: TextView
    private lateinit var hostState: TextView
    private lateinit var pairingState: TextView
    private lateinit var runMode: TextView
    private lateinit var probeState: TextView
    private lateinit var probeToggle: Button
    private lateinit var progress: TextView
    private lateinit var code: EditText
    private lateinit var submit: Button
    private lateinit var retry: Button
    private lateinit var notice: TextView
    private lateinit var notificationSettings: Button
    private var lastStage = PairingStage.IDLE

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try { KernelService.start(this) } catch (_: Exception) { /* the screen still says what it can */ }
        val pad = dp(24)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(pad, dp(24), pad, pad)
        }
        root.addView(text("Ash 内核", 26f, bold = true))
        state = text("", 16f).also { it.setPadding(0, dp(16), 0, 0) }
        root.addView(state)
        hostState = text("", 16f).also { it.setPadding(0, dp(8), 0, 0) }
        root.addView(hostState)
        pairingState = text("", 16f).also { it.setPadding(0, dp(8), 0, 0) }
        root.addView(pairingState)
        runMode = text("", 16f).also { it.setPadding(0, dp(8), 0, 0) }
        root.addView(runMode)
        probeState = text("", 15f).also { it.setPadding(0, dp(8), 0, 0) }
        root.addView(probeState)
        probeToggle = Button(this).apply {
            setOnClickListener { HostPresence.setProbe(HostPresence.probe.contains("已暂停")) }
        }
        root.addView(probeToggle)
        root.addView(text("打开系统配对框后，下拉通知点「输入配对码」。系统分屏时也可以在这里输入。", 15f)
            .also { it.setPadding(0, dp(24), 0, dp(8)) })
        notice = text("", 15f)
        root.addView(notice)
        notificationSettings = Button(this).apply {
            text = "开启配对通知"
            setOnClickListener { startActivity(Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName)) }
        }
        root.addView(notificationSettings)
        root.addView(Button(this).apply {
            text = "启动配对"
            setOnClickListener { GuideService.start(this@StatusActivity, GuideService.PAIR) }
        })
        root.addView(Button(this).apply {
            text = "打开无线调试"
            setOnClickListener {
                // Pairing is explicitly requested even when a host is already connected.
                if (!GuideService.running || GuideService.progress.stage != PairingStage.WAITING_CODE)
                    GuideService.start(this@StatusActivity, GuideService.PAIR)
                val settings = KernelPairing.wirelessDebuggingIntent()
                runCatching { startActivity(settings) }
                    .onFailure { progress.text = "请在系统设置中打开开发者选项 › 无线调试" }
            }
        })
        code = EditText(this).apply {
            hint = "6 位配对码"
            inputType = InputType.TYPE_CLASS_NUMBER
            filters = arrayOf(InputFilter.LengthFilter(6))
            setSingleLine()
            imeOptions = EditorInfo.IME_ACTION_DONE
            setText(savedInstanceState?.getString("pairing_code").orEmpty())
            setOnEditorActionListener { _, action, event ->
                if (action == EditorInfo.IME_ACTION_DONE ||
                    (event?.keyCode == android.view.KeyEvent.KEYCODE_ENTER && event.action == android.view.KeyEvent.ACTION_DOWN)) {
                    submitCode(); true
                } else false
            }
        }
        root.addView(code, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(56)))
        submit = Button(this).apply { text = "配对并启动"; setOnClickListener { submitCode() } }
        root.addView(submit)
        progress = text("", 15f).also { it.setPadding(0, dp(8), 0, 0) }
        root.addView(progress)
        retry = Button(this).apply { text = "重试"; setOnClickListener { startGuide() } }
        root.addView(retry)
        root.addView(text(LOCK_HINT, 15f).also { it.setPadding(0, dp(32), 0, 0) })
        root.addView(Button(this).apply {
            text = "打开 Ash"
            setOnClickListener { packageManager.getLaunchIntentForPackage(HAND_PACKAGE)?.let { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } }
        }, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(32) })
        setContentView(ScrollView(this).apply {
            setBackgroundColor(android.graphics.Color.WHITE)
            isFillViewport = true
            addView(root)
        })
        if (!KernelHost.ready() && !GuideService.running) startGuide()
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onPause() {
        main.removeCallbacksAndMessages(null)
        super.onPause()
    }

    private fun refresh() {
        val host = KernelHost.ready()
        state.text = "大脑：" + if (host) HostPresence.status else KernelService.status ?: KernelText.STARTING
        hostState.text = "宿主：" + if (host) "已连接" else "未连接"
        val p = GuideService.progress
        val busy = GuideService.running && p.stage in listOf(PairingStage.PAIRING, PairingStage.CONNECTING, PairingStage.STARTING)
        val pairing = GuideService.running && p.pairing && p.stage in listOf(PairingStage.WAITING_CODE, PairingStage.PAIRING, PairingStage.ERROR)
        pairingState.text = "配对：" + when {
            AdbKey.paired(this) && pairing -> "已配对 · 正在重新配对"
            AdbKey.paired(this) -> "已配对"
            p.stage == PairingStage.PAIRING && GuideService.running -> "正在配对"
            else -> "未配对"
        }
        runMode.text = "运行模式：" + if (host) "调试权限（shell）" else "普通应用权限"
        probeState.text = if (!host) "上下文探针：没在记录（宿主未连接，重新连接后自动启动）"
            else HostPresence.probe.ifEmpty { "上下文探针：正在启动" }
        probeToggle.visibility = if (host && HostPresence.probe.isNotEmpty()) android.view.View.VISIBLE else android.view.View.GONE
        probeToggle.text = if (HostPresence.probe.contains("已暂停")) "继续记录" else "暂停记录"
        if (host && HostPresence.coreReady && !pairing) {
            progress.text = "宿主已连接，中枢已就绪。可以关闭无线调试"
            if (p.stage == PairingStage.READY && lastStage != PairingStage.READY) code.text.clear()
        } else {
            progress.text = if (!host && p.stage == PairingStage.READY) "宿主未连接，请开启无线调试后点重新连接"
                else p.text.ifEmpty { "输入配对码后自动连接宿主、停止旧中枢并启动" }
        }
        lastStage = p.stage
        submit.isEnabled = !busy
        code.isEnabled = !busy
        val notifications = KernelPairing.pairingNotificationsEnabled(this)
        notice.text = if (notifications) "" else "配对通知未开启，输入按钮不会出现。请先开启。"
        notice.visibility = if (notifications) android.view.View.GONE else android.view.View.VISIBLE
        notificationSettings.visibility = if (notifications) android.view.View.GONE else android.view.View.VISIBLE
        retry.isEnabled = !busy
        retry.text = if (AdbKey.paired(this) || host) "重新连接" else "重试"
        main.postDelayed(::refresh, 500)
    }

    private fun startGuide() {
        runCatching { GuideService.start(this, if (AdbKey.paired(this) || KernelHost.ready()) GuideService.CONNECT else GuideService.PAIR) }
            .onFailure { if (::progress.isInitialized) progress.text = "无法启动配对：${it.message}" }
    }

    private fun submitCode() {
        val value = code.text.toString().trim()
        if (!GuideService.validCode(value)) { code.error = "请输入 6 位数字"; return }
        runCatching { GuideService.submit(this, value) }.onFailure { progress.text = "无法提交配对码：${it.message}" }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("pairing_code", code.text.toString())
        super.onSaveInstanceState(outState)
    }

    private fun text(s: String, sp: Float, bold: Boolean = false) = TextView(this).apply {
        text = s
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
        gravity = Gravity.CENTER_HORIZONTAL
        if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    companion object {
        private const val HAND_PACKAGE = "ai.ash.agent"
        const val LOCK_HINT = "这是 Ash 的大脑。打开最近任务，把「Ash 内核」这张卡片锁住，系统清理后台时就会留下她的大脑。"
    }
}
