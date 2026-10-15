package ai.ash.kernel.host.ctx

import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Starts [ContextProbe] as a child `app_process` of the shell host and starts it again when it exits. Its stdin stays
 * open for as long as this host lives, so the probe exits with the host and the next host starts the next one.
 * Every 15 seconds it tells the kernel page (through [report]) whether the probe is recording and how much it has.
 */
class ContextProbeLauncher(
    private val apk: String,
    private val log: (String) -> Unit,
    private val report: (String) -> Unit,
) {
    private val root = ROOT
    @Volatile private var alive = false
    @Volatile private var startedAt = 0L
    @Volatile private var lastExit = ""

    fun start() {
        Thread({ loop() }, "ash-ctx-launcher").apply { isDaemon = true; start() }
        Thread({ while (true) { runCatching { report(status()) }; Thread.sleep(15_000) } }, "ash-ctx-status")
            .apply { isDaemon = true; start() }
    }

    fun setPaused(paused: Boolean) {
        root.mkdirs()
        val f = File(root, "paused")
        if (paused) f.writeText("") else f.delete()
        runCatching { report(status()) }
    }

    private fun loop() {
        var backoff = 5_000L
        while (true) {
            val began = System.currentTimeMillis()
            try {
                val pb = ProcessBuilder("/system/bin/app_process", "/system/bin", "--nice-name=ash_ctx", MAIN).redirectErrorStream(true)
                pb.environment()["CLASSPATH"] = apk
                val p = pb.start()
                alive = true; startedAt = began
                log("context probe started")
                runCatching { report(status()) }
                val tail = ArrayDeque<String>()
                p.inputStream.bufferedReader().forEachLine { tail.addLast(it); if (tail.size > 20) tail.removeFirst() }
                val code = p.waitFor()
                alive = false
                lastExit = "${clock(System.currentTimeMillis())} 退出（$code）"
                log("context probe exited $code: ${tail.joinToString(" / ").take(1500)}")
            } catch (t: Throwable) {
                alive = false
                lastExit = "${clock(System.currentTimeMillis())} 起不来：${t.message}"
                log("context probe: ${t.message}")
            }
            runCatching { report(status()) }
            if (System.currentTimeMillis() - began > 600_000) backoff = 5_000L
            Thread.sleep(backoff)
            backoff = minOf(backoff * 2, 300_000L)
        }
    }

    /** For ctx.list: `state` running | paused | stopped, since when it runs (Unix ms), and how it last ended (why it is not running). */
    fun state(): JSONObject {
        val o = JSONObject().put("state", when { File(root, "paused").exists() -> "paused"; alive -> "running"; else -> "stopped" })
        if (alive) o.put("since", startedAt)
        if (lastExit.isNotEmpty()) o.put("last_exit", lastExit)
        return o
    }

    private fun status(): String {
        val sb = StringBuilder("上下文探针：")
        when {
            File(root, "paused").exists() -> sb.append("已暂停")
            alive -> sb.append("记录中（已运行 ").append(span(System.currentTimeMillis() - startedAt)).append("）")
            else -> sb.append("没在运行，稍后自动重启").also { if (lastExit.isNotEmpty()) sb.append("（").append(lastExit).append("）") }
        }
        val day = File(root, SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date()))
        val files = day.listFiles()?.filter { it.name.endsWith(".jsonl") } ?: emptyList()
        if (files.isNotEmpty()) {
            val total = files.sumOf { it.length() }
            val last = files.maxOf { it.lastModified() }
            sb.append("\n今天 ").append(mb(total)).append("，最近写入 ").append(clock(last))
            val stats = File(day, "stats.jsonl")
            runCatching {
                val o = JSONObject(stats.readLines().last { it.isNotBlank() })
                val c = o.optJSONObject("counts")
                val clicks = (c?.optLong("click") ?: 0) + (c?.optLong("long_click") ?: 0)
                sb.append("\n截至 ").append(clock(o.optLong("t"))).append("：点击 ").append(clicks)
                    .append("，输入 ").append(c?.optLong("text") ?: 0).append("，滑动 ").append(c?.optLong("scroll") ?: 0)
                    .append("，通知 ").append(c?.optLong("notif") ?: 0).append("，触摸 ").append(o.optLong("touches"))
                    .append("，屏幕变化 ").append(o.optLong("changed"))
            }
        }
        return sb.toString()
    }

    private fun clock(ms: Long) = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date(ms))
    private fun mb(b: Long) = if (b < 1_048_576) "${b / 1024} KB" else String.format(Locale.US, "%.1f MB", b / 1_048_576.0)
    private fun span(ms: Long): String { val m = ms / 60_000; return if (m < 60) "$m 分钟" else "${m / 60} 小时 ${m % 60} 分" }

    companion object {
        /** Where the probe records (only the shell user can read it). */
        val ROOT = File("/data/local/tmp/ash-ctx")
        private const val MAIN = "ai.ash.kernel.host.ctx.ContextProbe"
    }
}
