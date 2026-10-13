package ai.ash.kernel.host.ctx

import ai.ash.kernel.host.FakeContext
import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Notification
import android.app.UiAutomation
import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.PowerManager
import android.os.Process
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject
import java.io.BufferedWriter
import java.io.File
import java.io.FileWriter
import java.io.RandomAccessFile
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * A one-day context probe, started and kept alive by the shell host (child `app_process`, nice name `ash_ctx`).
 * Records on this phone only, under /data/local/tmp/ash-ctx/<day>/:
 * - events.jsonl: the owner's own actions from accessibility events (click, long click, scroll, typing, window change,
 *   focus, selection, notification) and screen on/off;
 * - screens.jsonl: the active window's text, read once a second while the screen is on, written only when it changed;
 * - touch.jsonl: every finger touch and key from the input devices (getevent), to see what accessibility misses;
 * - stats.jsonl: what it costs (CPU of this process and of getevent, poll time, bytes, battery), every 10 minutes.
 * Accessibility comes from a UiAutomation that does not suppress the installed accessibility services. Screen reads
 * run on their own thread with a time budget, so a hung foreground app cannot stall the event log.
 * Pause by creating /data/local/tmp/ash-ctx/paused. Exits when its stdin closes (the host went), and while
 * /data/local/tmp/ash-ctx/hold is younger than two minutes, which frees the one UiAutomation for `uiautomator dump`
 * (the install script touches it); the launcher starts it again later.
 */
object ContextProbe {
    private val ROOT = File("/data/local/tmp/ash-ctx")
    private const val POLL_MS = 1_000L
    private const val STATS_MS = 600_000L
    private const val TYPING_IDLE_MS = 2_500L
    private const val SCROLL_IDLE_MS = 1_500L
    private const val MAX_NODES = 600
    private const val MAX_CHARS = 6_000
    private const val POLL_BUDGET_MS = 500L
    private const val EVENT_TYPES = AccessibilityEvent.TYPE_VIEW_CLICKED or AccessibilityEvent.TYPE_VIEW_LONG_CLICKED or
        AccessibilityEvent.TYPE_VIEW_CONTEXT_CLICKED or AccessibilityEvent.TYPE_VIEW_SCROLLED or
        AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED or AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
        AccessibilityEvent.TYPE_VIEW_FOCUSED or AccessibilityEvent.TYPE_VIEW_SELECTED or
        AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED

    private lateinit var main: Handler
    private lateinit var pollHandler: Handler
    private lateinit var ua: UiAutomation
    private lateinit var ctx: Context
    private val rec = Recorder(ROOT)

    // Events, stats and getevent lines run on the main looper; screen reads on the poll thread. Writes are synchronized.
    private val counts = HashMap<String, Long>()
    private var polls = 0L; private var pollsOff = 0L; private var pollMsSum = 0.0; private var pollMsMax = 0.0
    private var changed = 0L; private var unchanged = 0L
    private var lastScreenPkg = ""; private var lastScreenHash = 0
    @Volatile private var lastWindow = ""
    private var typing: JSONObject? = null
    private var scroll: JSONObject? = null
    @Volatile private var interactive = false; @Volatile private var screenOnSince = 0L; @Volatile private var screenOnMs = 0L
    private var geteventPid = 0

    @JvmStatic
    fun main(args: Array<String>) {
        Looper.prepareMainLooper()
        ROOT.mkdirs()
        if (held()) System.exit(0)
        val lock = RandomAccessFile(File(ROOT, ".lock"), "rw").channel.tryLock()
        if (lock == null) { System.err.println("another ash_ctx is running"); System.exit(0) }
        Thread({ try { while (System.`in`.read() >= 0) { } } catch (_: Throwable) { }; Touch.stop(); rec.flush(); System.exit(0) }, "ctx-stdin")
            .apply { isDaemon = true; start() }
        main = Handler(Looper.getMainLooper())
        ctx = FakeContext.get()
        ua = connect()
        ua.setOnAccessibilityEventListener { e -> runCatching { onEvent(e) } }
        interactive = isInteractive(); if (interactive) screenOnSince = SystemClock.elapsedRealtime()
        write("events", JSONObject().put("t", System.currentTimeMillis()).put("ev", "probe_start").put("sdk", Build.VERSION.SDK_INT))
        stats("start")
        Touch.start()
        pollHandler = Handler(HandlerThread("ctx-poll").apply { start() }.looper)
        pollHandler.postDelayed(object : Runnable { override fun run() { runCatching { poll() }; pollHandler.postDelayed(this, POLL_MS) } }, POLL_MS)
        main.postDelayed(object : Runnable { override fun run() { runCatching { stats("tick") }; main.postDelayed(this, STATS_MS) } }, STATS_MS)
        Looper.loop()
    }

    /** A UiAutomation for the shell user, as `uiautomator` makes one, that leaves the other accessibility services on. */
    private fun connect(): UiAutomation {
        val connection = Class.forName("android.app.UiAutomationConnection").getDeclaredConstructor().apply { isAccessible = true }.newInstance()
        val iface = Class.forName("android.app.IUiAutomationConnection")
        val made = runCatching {
            UiAutomation::class.java.getDeclaredConstructor(Looper::class.java, iface).apply { isAccessible = true }
                .newInstance(Looper.getMainLooper(), connection)
        }.getOrElse {
            UiAutomation::class.java.getDeclaredConstructor(Context::class.java, iface).apply { isAccessible = true }
                .newInstance(ctx, connection)
        }
        UiAutomation::class.java.getDeclaredMethod("connect", Int::class.javaPrimitiveType).apply { isAccessible = true }
            .invoke(made, UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        val info = made.serviceInfo
        info.eventTypes = EVENT_TYPES
        info.flags = info.flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS or
            AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS or AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
        info.notificationTimeout = 0
        made.serviceInfo = info
        return made
    }

    private fun paused() = File(ROOT, "paused").exists()
    private fun held() = File(ROOT, "hold").let { it.exists() && System.currentTimeMillis() - it.lastModified() < 120_000 }

    // ---- accessibility events ----

    private fun onEvent(e: AccessibilityEvent) {
        if (paused()) return
        val pkg = e.packageName?.toString() ?: ""
        val ev = when (e.eventType) {
            AccessibilityEvent.TYPE_VIEW_CLICKED -> "click"
            AccessibilityEvent.TYPE_VIEW_LONG_CLICKED -> "long_click"
            AccessibilityEvent.TYPE_VIEW_CONTEXT_CLICKED -> "context_click"
            AccessibilityEvent.TYPE_VIEW_SCROLLED -> "scroll"
            AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> "text"
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> "window"
            AccessibilityEvent.TYPE_VIEW_FOCUSED -> "focus"
            AccessibilityEvent.TYPE_VIEW_SELECTED -> "select"
            AccessibilityEvent.TYPE_NOTIFICATION_STATE_CHANGED -> "notif"
            else -> return
        }
        counts[ev] = (counts[ev] ?: 0L) + 1
        val o = JSONObject().put("t", System.currentTimeMillis()).put("ev", ev).put("pkg", pkg)
        e.className?.let { o.put("cls", it.toString()) }
        if (Build.VERSION.SDK_INT >= 33 && e.displayId != 0) o.put("display", e.displayId)
        val evText = e.text.joinToString(" ") { it?.toString() ?: "" }.trim()
        when (ev) {
            "notif" -> {
                val n = e.parcelableData as? Notification
                if (n != null) {
                    n.extras.getCharSequence(Notification.EXTRA_TITLE)?.let { o.put("title", clip(it.toString(), 200)) }
                    n.extras.getCharSequence(Notification.EXTRA_TEXT)?.let { o.put("body", clip(it.toString(), 500)) }
                    n.category?.let { o.put("category", it) }
                } else if (evText.isNotEmpty()) o.put("text", clip(evText, 500))
                write("events", o)
            }
            "text" -> {
                if (e.isPassword) o.put("password", true) else o.put("text", clip(evText, 1000))
                describe(e, o, children = false)
                val cur = typing
                if (cur != null && (cur.optString("pkg") != pkg || cur.optString("id") != o.optString("id"))) flushTyping()
                val keep = typing
                if (keep == null) { o.put("first", o.getLong("t")).put("edits", 1).put("win", lastWindow); typing = o }
                else {
                    keep.put("edits", keep.optInt("edits") + 1).put("t", o.getLong("t"))
                    if (o.has("text")) keep.put("text", o.getString("text"))
                }
                main.removeCallbacks(typingFlush); main.postDelayed(typingFlush, TYPING_IDLE_MS)
            }
            "scroll" -> {
                if (Build.VERSION.SDK_INT >= 28) o.put("dx", e.scrollDeltaX).put("dy", e.scrollDeltaY)
                if (e.itemCount > 0) o.put("from", e.fromIndex).put("to", e.toIndex).put("items", e.itemCount)
                describe(e, o, children = false)
                val cur = scroll
                if (cur != null && (cur.optString("pkg") != pkg || cur.optString("id") != o.optString("id"))) flushScroll()
                val keep = scroll
                if (keep == null) { o.put("first", o.getLong("t")).put("n", 1).put("win", lastWindow); scroll = o }
                else {
                    keep.put("n", keep.optInt("n") + 1).put("t", o.getLong("t"))
                    if (o.has("dy")) keep.put("dy", keep.optInt("dy") + o.optInt("dy")).put("dx", keep.optInt("dx") + o.optInt("dx"))
                    if (o.has("to")) keep.put("to", o.optInt("to")).put("items", o.optInt("items"))
                }
                main.removeCallbacks(scrollFlush); main.postDelayed(scrollFlush, SCROLL_IDLE_MS)
            }
            "window" -> {
                flushTyping(); flushScroll()
                if (evText.isNotEmpty()) o.put("title", clip(evText, 200))
                lastWindow = o.optString("cls")
                write("events", o)
            }
            else -> {
                flushTyping(); flushScroll()
                if (evText.isNotEmpty()) o.put("text", clip(evText, 300))
                describe(e, o, children = ev != "focus")
                o.put("win", lastWindow)
                write("events", o)
            }
        }
    }

    private val typingFlush = Runnable { flushTyping() }
    private val scrollFlush = Runnable { flushScroll() }
    private fun flushTyping() { typing?.let { write("events", it) }; typing = null; main.removeCallbacks(typingFlush) }
    private fun flushScroll() { scroll?.let { write("events", it) }; scroll = null; main.removeCallbacks(scrollFlush) }

    private fun describe(e: AccessibilityEvent, o: JSONObject, children: Boolean) {
        val n = runCatching { e.source }.getOrNull() ?: return
        n.viewIdResourceName?.let { o.put("id", it) }
        n.contentDescription?.let { if (it.isNotBlank()) o.put("desc", clip(it.toString(), 200)) }
        if (!o.has("text")) n.text?.let { if (it.isNotBlank()) o.put("text", clip(it.toString(), 300)) }
        if (children && !o.has("text") && !o.has("desc")) {
            val inner = ArrayList<String>()
            collect(n, inner, 0)
            if (inner.isNotEmpty()) o.put("inner", clip(inner.joinToString(" | "), 300))
        }
    }

    private fun collect(n: AccessibilityNodeInfo, out: MutableList<String>, depth: Int) {
        if (depth > 3 || out.size >= 5) return
        for (i in 0 until n.childCount) {
            val c = runCatching { n.getChild(i) }.getOrNull() ?: continue
            (c.text ?: c.contentDescription)?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { out.add(it) }
            collect(c, out, depth + 1)
            if (out.size >= 5) return
        }
    }

    // ---- screen text, once a second while the screen is on ----

    private fun poll() {
        if (held()) { write("events", JSONObject().put("t", System.currentTimeMillis()).put("ev", "probe_hold")); Touch.stop(); rec.flush(); System.exit(0) }
        val on = isInteractive()
        if (on != interactive) {
            interactive = on
            val now = SystemClock.elapsedRealtime()
            if (on) screenOnSince = now else { if (screenOnSince > 0) screenOnMs += now - screenOnSince; screenOnSince = 0 }
            write("events", JSONObject().put("t", System.currentTimeMillis()).put("ev", if (on) "screen_on" else "screen_off"))
            if (!on) main.post { flushTyping(); flushScroll(); stats("screen_off") }
        }
        if (paused()) return
        if (!on) { pollsOff++; return }
        val start = SystemClock.elapsedRealtimeNanos()
        val root = runCatching { ua.rootInActiveWindow }.getOrNull()
        polls++
        if (root == null) return
        val pkg = root.packageName?.toString() ?: ""
        val parts = ArrayList<String>()
        var nodes = 0; var chars = 0
        val queue = ArrayDeque<AccessibilityNodeInfo>(); queue.add(root)
        val deadline = start + POLL_BUDGET_MS * 1_000_000
        var truncated = false
        while (queue.isNotEmpty() && nodes < MAX_NODES && chars < MAX_CHARS) {
            if (SystemClock.elapsedRealtimeNanos() > deadline) { truncated = true; break }
            val n = queue.removeFirst(); nodes++
            if (!n.isVisibleToUser) continue
            val s = (n.text ?: n.contentDescription)?.toString()?.trim()
            if (!s.isNullOrEmpty() && !n.isPassword && (parts.isEmpty() || parts.last() != s)) { parts.add(s); chars += s.length }
            for (i in 0 until n.childCount) runCatching { n.getChild(i) }.getOrNull()?.let { queue.add(it) }
        }
        val text = clip(parts.joinToString("\n"), MAX_CHARS)
        val ms = (SystemClock.elapsedRealtimeNanos() - start) / 1e6
        pollMsSum += ms; if (ms > pollMsMax) pollMsMax = ms
        val hash = text.hashCode()
        if (pkg == lastScreenPkg && hash == lastScreenHash) { unchanged++; return }
        changed++; lastScreenPkg = pkg; lastScreenHash = hash
        write("screens", JSONObject().put("t", System.currentTimeMillis()).put("pkg", pkg).put("win", lastWindow)
            .put("nodes", nodes).put("ms", Math.round(ms * 10) / 10.0).put("truncated", truncated).put("text", text))
    }

    private fun isInteractive(): Boolean = runCatching {
        (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive
    }.getOrDefault(true)

    // ---- cost ----

    private fun stats(why: String) {
        val now = SystemClock.elapsedRealtime()
        val on = screenOnMs + if (screenOnSince > 0) now - screenOnSince else 0
        val o = JSONObject().put("t", System.currentTimeMillis()).put("why", why)
            .put("cpu_ms", Process.getElapsedCpuTime())
            .put("getevent_cpu_ms", cpuMsOf(geteventPid))
            .put("polls", polls).put("polls_screen_off", pollsOff).put("changed", changed).put("unchanged", unchanged)
            .put("poll_ms_avg", if (polls > 0) Math.round(pollMsSum / polls * 100) / 100.0 else 0.0)
            .put("poll_ms_max", Math.round(pollMsMax * 10) / 10.0)
            .put("screen_on_ms", on)
            .put("counts", JSONObject(counts.toMap()))
            .put("touches", Touch.touches).put("keys", Touch.keys)
            .put("bytes", JSONObject(rec.sizes()))
        runCatching {
            val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            o.put("battery", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
                .put("current_ua", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW))
                .put("charging", bm.isCharging)
        }
        pollMsMax = 0.0
        write("stats", o)
        rec.flush()
    }

    private fun cpuMsOf(pid: Int): Long = if (pid <= 0) -1 else runCatching {
        val f = File("/proc/$pid/stat").readText().substringAfterLast(") ").split(' ')
        (f[11].toLong() + f[12].toLong()) * 10 // utime + stime, in 10 ms clock ticks
    }.getOrDefault(-1)

    fun write(kind: String, o: JSONObject) { runCatching { rec.write(kind, o) } }

    private fun clip(s: String, max: Int) = if (s.length <= max) s else s.substring(0, max) + "…"

    // ---- raw touches and keys from getevent ----

    private object Touch {
        var touches = 0L; var keys = 0L
        private val line = Regex("""^\[\s*(\d+)\.(\d+)\]\s+(/dev/input/\S+):\s+(\S+)\s+(\S+)\s+(\S+)""")
        private class Finger { var down = false; var t0 = 0L; var x0 = -1; var y0 = -1; var x = -1; var y = -1; var btn = false }
        private val fingers = HashMap<String, Finger>()
        @Volatile private var proc: java.lang.Process? = null

        fun stop() { runCatching { proc?.destroy() } }

        fun start() = Thread({ run() }, "ctx-getevent").apply { isDaemon = true; start() }

        private fun run() {
            while (true) {
                runCatching {
                    val p = ProcessBuilder("/system/bin/sh", "-c", "echo \$\$; exec /system/bin/getevent -lt").start()
                    proc = p
                    val r = p.inputStream.bufferedReader()
                    geteventPid = r.readLine()?.trim()?.toIntOrNull() ?: 0
                    while (true) {
                        val s = r.readLine() ?: break
                        val m = line.find(s) ?: continue
                        val tk = m.groupValues[1].toLong() * 1000 + m.groupValues[2].padEnd(6, '0').take(3).toLong()
                        val v = m.groupValues
                        main.post { runCatching { feed(tk, v[3], v[4], v[5], v[6]) } }
                    }
                    p.destroy()
                }
                Thread.sleep(30_000)
            }
        }

        /** Kernel time to wall time: evdev stamps with CLOCK_REALTIME unless the reader picks another clock. */
        private fun wall(tk: Long) = if (tk > 1_000_000_000_000L) tk else System.currentTimeMillis() - (SystemClock.uptimeMillis() - tk)

        private fun feed(tk: Long, dev: String, type: String, code: String, value: String) {
            if (paused()) return
            val f = fingers.getOrPut(dev) { Finger() }
            when {
                type == "EV_KEY" && code == "BTN_TOUCH" -> { f.btn = true; if (value == "DOWN") down(f, tk) else if (value == "UP") up(f, tk, dev) }
                type == "EV_ABS" && code == "ABS_MT_TRACKING_ID" && !f.btn -> { if (value == "ffffffff") up(f, tk, dev) else if (!f.down) down(f, tk) }
                type == "EV_ABS" && code == "ABS_MT_POSITION_X" -> f.x = value.toLong(16).toInt()
                type == "EV_ABS" && code == "ABS_MT_POSITION_Y" -> f.y = value.toLong(16).toInt()
                // The first frame of a touch ends here: its position is the start, whichever order the frame came in.
                type == "EV_SYN" && code == "SYN_REPORT" -> if (f.down && f.x0 < 0) { f.x0 = f.x; f.y0 = f.y }
                type == "EV_KEY" && value == "DOWN" && !code.startsWith("BTN_") -> {
                    keys++
                    write("touch", JSONObject().put("t", wall(tk)).put("ev", "key").put("key", code).put("dev", dev))
                }
            }
        }

        private fun down(f: Finger, tk: Long) { f.down = true; f.t0 = tk; f.x0 = -1; f.y0 = -1 }

        private fun up(f: Finger, tk: Long, dev: String) {
            if (!f.down) return
            f.down = false; touches++
            write("touch", JSONObject().put("t", wall(f.t0)).put("ev", "touch").put("ms", tk - f.t0)
                .put("x0", f.x0).put("y0", f.y0).put("x1", f.x).put("y1", f.y).put("dev", dev))
        }
    }
}

/** Append-only JSONL files under <root>/<day>/. Used from one thread (the main looper). */
private class Recorder(private val root: File) {
    private val dayFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US)
    private var day = ""
    private val writers = HashMap<String, BufferedWriter>()
    val bytes = HashMap<String, Long>()
    private var lastFlush = 0L

    @Synchronized fun write(kind: String, json: JSONObject) {
        val now = System.currentTimeMillis()
        val today = dayFormat.format(Date(now))
        if (today != day) { close(); day = today; bytes.clear() }
        val w = writers.getOrPut(kind) {
            val f = File(File(root, day).apply { mkdirs() }, "$kind.jsonl")
            bytes[kind] = f.length()
            BufferedWriter(FileWriter(f, true), 64 * 1024)
        }
        val line = json.toString()
        w.write(line); w.write("\n")
        bytes[kind] = (bytes[kind] ?: 0L) + line.toByteArray().size + 1
        if (now - lastFlush > 30_000) flush()
    }

    @Synchronized fun sizes(): Map<String, Long> = bytes.toMap()
    @Synchronized fun flush() { lastFlush = System.currentTimeMillis(); for (w in writers.values) runCatching { w.flush() } }
    @Synchronized fun close() { for (w in writers.values) runCatching { w.close() }; writers.clear() }
}
