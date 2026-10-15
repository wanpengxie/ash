package ai.ash.sysapps.devices

import org.json.JSONArray
import org.json.JSONObject

/*
 * The device app's model (APPS-R1 §1; MOBILE-ARCH §1.4, §2.2, §3.2, §6.1): plain Kotlin, no Android, so it is tested on the
 * JVM. The screens bind what it computes; every action is a word of service:devices / service:link, and what changes comes
 * back as a recorded event (device.changed, pair.changed, service:link connected / disconnected / gateway.changed), which
 * [Refresh.of] turns into what to read again. Nothing here polls.
 *
 * What the app shows:
 *   - first screen: one status line for the relay (which one, connected or not, why not), requests waiting for approval,
 *     then every device (this phone first, then online ones, then by name): name, online / last seen and how it connects,
 *     its program version and whether it is the latest (or updating), and what it gives the hub in plain words (screen,
 *     files and commands, Codex, browser…). Revoked devices only behind 「显示已撤销」.
 *   - a device: rename, what it may do (access_set), revoke / restore, diagnose, update; the last change and who made it.
 *   - connecting a new one: one screen from the install command to the device connected ([PairFlow]).
 */

/** One device as the app shows it, from one entry of `service:devices list`. Immutable; [id] (`device:<hand>`) is its key. */
data class Device(
    val id: String,
    val name: String,
    val kind: String,
    val online: Boolean,
    val lastSeen: Long?,
    /** "local" (this phone's own link) or "gateway" (through the relay). */
    val via: String?,
    val revoked: Boolean,
    val version: String?,
    /** Runs the hub's release of the computer program; null when the hub has none for it (a phone). */
    val latest: Boolean?,
    /** The release it was told to install and has not come back with. */
    val updating: String?,
    val capabilities: List<String>,
    val tier: String,
    val lend: Boolean,
    val body: Boolean,
    val localAgents: Boolean,
) {
    val isPhone get() = kind == "phone"
    val isComputer get() = kind == "computer" || kind == "server"
}

/** The hub's relay, from `service:link gateway.status`. */
data class Relay(val configured: Boolean, val connected: Boolean, val url: String?, val error: String?)

/** A pairing a new device answered, waiting for the owner (`service:devices pair_pending`). */
data class PairRequest(val pairId: String, val name: String, val kind: String)

/** A recorded change of one device (`device.changed`): what and who. */
data class Change(val change: String, val by: String, val version: String?, val at: Long)

/** What a recorded ledger message means for the app: what to read again. */
enum class Refresh { DEVICES, RELAY, PAIRS;
    companion object {
        /** The ledger message [m] (as `sync.msg` carries it): which reads it makes stale; empty for everything else. */
        fun of(m: JSONObject): Set<Refresh> {
            if (m.optString("kind") != "event") return emptySet()
            return when ("${m.optString("to")}/${m.optString("word")}") {
                "service:devices/device.changed", "service:link/connected", "service:link/disconnected" -> setOf(DEVICES)
                "service:devices/pair.changed" -> setOf(PAIRS, DEVICES)
                "service:link/gateway.changed" -> setOf(RELAY)
                else -> emptySet()
            }
        }
    }
}

object DevicesText {
    private val KINDS = mapOf("phone" to "手机", "computer" to "电脑", "server" to "服务器", "browser" to "网页")
    fun kind(kind: String) = KINDS[kind] ?: "设备"

    /** What a device gives the hub, in the owner's words, in this order; names not listed are "其他". Its own management words are not shown. */
    private val ABILITIES: List<Pair<String, List<String>>> = listOf(
        "屏幕" to listOf("screen.", "vscreen.", "input."),
        "文件和命令" to listOf("workspace.", "body.info"),
        "Codex" to listOf("x.codex."),
        "浏览器" to listOf("browser.", "x.android.browser.", "x.kimi.", "x.ego."),
        "相机" to listOf("camera."),
        "照片和媒体" to listOf("media."),
        "位置" to listOf("location."),
        "日历" to listOf("calendar."),
        "剪贴板" to listOf("clipboard."),
        "应用" to listOf("apps."),
        "健康" to listOf("health."),
        "感知" to listOf("sense."),
        "识字和朗读" to listOf("ocr.", "tts."),
    )
    private val HIDDEN = listOf("config.", "x.ash.")

    fun abilities(capabilities: List<String>): List<String> {
        val shown = capabilities.filter { c -> HIDDEN.none { c.startsWith(it) } }
        val labels = ABILITIES.filter { (_, prefixes) -> shown.any { c -> prefixes.any { p -> c == p || c.startsWith(p) } } }.map { it.first }
        val other = shown.count { c -> ABILITIES.none { (_, prefixes) -> prefixes.any { p -> c == p || c.startsWith(p) } } }
        return if (other > 0) labels + "其他 $other 项" else labels
    }

    /** "在线 · 经中转站", "离线 · 3 小时前在线", "已撤销". */
    fun presence(d: Device, now: Long): String = when {
        d.revoked -> "已撤销"
        d.online -> "在线" + when (d.via) { "gateway" -> " · 经中转站"; "local" -> " · 这台手机"; else -> "" }
        d.lastSeen != null -> "离线 · ${ago(d.lastSeen, now)}在线"
        else -> "离线"
    }

    /** "0.2.4 · 最新", "0.2.3 · 正在升级到 0.2.4", "0.2.3 · 有新版本 0.2.4", or the version alone; null without one. */
    fun version(d: Device, release: String?): String? {
        val v = d.version ?: return null
        return when {
            d.updating != null -> "$v · 正在升级到 ${d.updating}"
            d.latest == true -> "$v · 最新"
            d.latest == false && release == v -> "$v · 更新状态待确认"
            d.latest == false && release != null -> "$v · 有新版本 $release，在线时可升级"
            else -> v
        }
    }

    fun ago(at: Long, now: Long): String {
        val s = ((now - at) / 1000).coerceAtLeast(0)
        return when {
            s < 60 -> "刚刚"
            s < 3600 -> "${s / 60} 分钟前"
            s < 86_400 -> "${s / 3600} 小时前"
            else -> "${s / 86_400} 天前"
        }
    }

    /** Who made a change, for the owner: themself, Ash (the primary agent), another agent, or the hub on its own. */
    fun who(by: String, primary: String?): String = when {
        by == "person:owner" -> "你"
        by == primary || by == "agent:main" -> "Ash"
        by.startsWith("agent:") -> "帮手 ${by.removePrefix("agent:")}"
        by == "service:devices" -> "自动"
        by.startsWith("device:") -> "设备自己"
        else -> by
    }

    fun change(c: Change, primary: String?, now: Long): String {
        val what = when (c.change) {
            "renamed" -> "改了名字"; "access" -> "改了它能做的事"; "revoked" -> "撤销了它"; "restored" -> "恢复了它"
            "updating" -> "让它升级到 ${c.version ?: "新版本"}"; "updated" -> "升级到了 ${c.version ?: "新版本"}"; "paired" -> "批准它连上"
            else -> c.change
        }
        val who = who(c.by, primary)
        return if (c.change == "updated") "${ago(c.at, now)}$what" else "${ago(c.at, now)}，$who$what"
    }

    /** The relay status line on the first screen, and whether it is a problem. */
    fun relay(r: Relay?): Pair<String, Boolean> = when {
        r == null -> "正在读取中转站…" to false
        !r.configured -> "还没有中转站：只有这台手机能用，电脑连不进来" to true
        r.connected -> "中转站已连通${r.url?.let { " · ${it.removePrefix("https://")}" } ?: ""}" to false
        else -> "中转站连不上${r.url?.let { " · ${it.removePrefix("https://")}" } ?: ""}${r.error?.let { "：$it" } ?: ""}" to true
    }
}

object DevicesJson {
    private fun JSONObject.str(k: String): String? = optString(k, "").takeIf { has(k) && !isNull(k) && it.isNotEmpty() }
    private fun JSONObject.long(k: String): Long? = if (has(k) && !isNull(k)) optLong(k) else null
    private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
    private fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).mapNotNull { optString(it, "").takeIf { s -> s.isNotEmpty() } }

    /** `service:devices list` → devices; entries without an id or a name are left out (never shown half). */
    fun devices(data: JSONObject): List<Device> = data.optJSONArray("devices").objects().mapNotNull { o ->
        val id = o.str("device") ?: return@mapNotNull null
        val name = o.str("name") ?: return@mapNotNull null
        Device(
            id = id, name = name, kind = o.str("kind") ?: "computer", online = o.optBoolean("online"), lastSeen = o.long("last_seen"),
            via = o.str("via"), revoked = o.long("revoked_at") != null, version = o.str("version"),
            latest = if (o.has("latest")) o.optBoolean("latest") else null, updating = o.str("updating"),
            capabilities = o.optJSONArray("capabilities").strings(), tier = o.str("tier") ?: "ask",
            lend = o.optBoolean("lend"), body = o.optBoolean("body"), localAgents = o.optBoolean("local_agents"),
        )
    }

    fun release(data: JSONObject): String? = data.str("release")

    fun relay(data: JSONObject) = Relay(data.optBoolean("configured"), data.optBoolean("connected"), data.str("url"), data.str("last_error"))

    fun requests(data: JSONObject): List<PairRequest> = data.optJSONArray("pairs").objects()
        .filter { it.str("state") == "requested" }
        .mapNotNull { p -> PairRequest(p.str("pair_id") ?: return@mapNotNull null, p.str("name") ?: "", p.str("kind") ?: "computer") }

    /** A recorded `device.changed` message → the device and the change. */
    fun change(m: JSONObject): Pair<String, Change>? {
        if (m.optString("kind") != "event" || m.optString("to") != "service:devices" || m.optString("word") != "device.changed") return null
        val b = m.optJSONObject("body") ?: return null
        val device = b.str("device") ?: return null
        return device to Change(b.str("change") ?: return null, b.str("by") ?: "", b.str("version"), m.optLong("ts", 0))
    }
}

/**
 * The first screen's state: what was last read (kept when a read fails, MOBILE-ARCH §3.2), what failed, and the rows to draw.
 * Each read carries a generation: an answer to an older read than the newest one is dropped.
 */
class DevicesState {
    var devices: List<Device>? = null; private set
    var release: String? = null; private set
    var relay: Relay? = null; private set
    var requests: List<PairRequest> = emptyList(); private set
    var error: String? = null; private set
    var showRevoked = false
    /** The last change seen of each device (from events while the app was open). */
    val changes = HashMap<String, Change>()
    private val generation = HashMap<Refresh, Int>()

    /** Starts a read of [what]; the number to hand back with its answer. */
    fun begin(what: Refresh): Int = (generation[what] ?: 0).plus(1).also { generation[what] = it }
    private fun current(what: Refresh, gen: Int) = generation[what] == gen

    fun devicesRead(gen: Int, data: JSONObject?): Boolean {
        if (!current(Refresh.DEVICES, gen)) return false
        if (data == null) { error = "设备列表没读到，显示的是上次的结果"; return false }
        devices = DevicesJson.devices(data); release = DevicesJson.release(data); error = null
        return true
    }
    fun relayRead(gen: Int, data: JSONObject?) { if (current(Refresh.RELAY, gen) && data != null) relay = DevicesJson.relay(data) }
    fun requestsRead(gen: Int, data: JSONObject?) { if (current(Refresh.PAIRS, gen) && data != null) requests = DevicesJson.requests(data) }
    fun heard(m: JSONObject) {
        DevicesJson.change(m)?.let { (device, change) ->
            if ((changes[device]?.at ?: Long.MIN_VALUE) <= change.at) changes[device] = change
        }
    }

    /** One row of the first screen; [key] is stable and unique (MOBILE-ARCH §2.2). */
    sealed class Row(val key: String) {
        data class Status(val text: String, val problem: Boolean) : Row("status")
        data class Request(val pair: PairRequest) : Row("pair/${pair.pairId}")
        data class Item(val device: Device, val presence: String, val version: String?, val abilities: List<String>) : Row(device.id)
        data class ShowRevoked(val count: Int, val shown: Boolean) : Row("revoked")
        data class Note(val text: String) : Row("note")
    }

    fun rows(now: Long): List<Row> {
        val out = ArrayList<Row>()
        val (relayText, problem) = DevicesText.relay(relay)
        out += Row.Status(relayText, problem)
        requests.forEach { out += Row.Request(it) }
        val all = devices
        if (all == null) { out += Row.Note(error ?: "正在读取设备…"); return out }
        error?.let { out += Row.Note(it) }
        val live = all.filter { !it.revoked }
        val sorted = live.sortedWith(compareBy<Device>({ !it.isPhone }, { !it.online }, { it.name }))
        sorted.forEach { out += item(it, now) }
        if (live.isEmpty()) out += Row.Note("还没有别的设备。点「连一台新设备」把电脑接进来。")
        val revoked = all.filter { it.revoked }
        if (revoked.isNotEmpty()) {
            out += Row.ShowRevoked(revoked.size, showRevoked)
            if (showRevoked) revoked.sortedBy { it.name }.forEach { out += item(it, now) }
        }
        return out
    }

    private fun item(d: Device, now: Long) = Row.Item(d, DevicesText.presence(d, now), DevicesText.version(d, release), DevicesText.abilities(d.capabilities))

    fun device(id: String): Device? = devices?.firstOrNull { it.id == id }
    /** An acknowledged write may update its device before the next whole-list snapshot arrives. */
    fun replaceDevice(device: Device) { devices = devices?.map { if (it.id == device.id) device else it } }
}

/**
 * An action on one device with its own state (MOBILE-ARCH §6.1): only that action is held while it runs; its failure stays
 * next to it with what to do next. An answer that never came (`result_unknown`) is not called a failure.
 */
class Action {
    enum class Phase { IDLE, PENDING, DONE, FAILED, UNKNOWN }
    var phase = Phase.IDLE; private set
    var message: String? = null; private set
    fun start(): Boolean { if (phase == Phase.PENDING) return false; phase = Phase.PENDING; message = null; return true }
    fun done(text: String? = null) { phase = Phase.DONE; message = text }
    fun failed(code: String, text: String) {
        phase = if (code == "result_unknown" || code == "timeout") Phase.UNKNOWN else Phase.FAILED
        message = if (phase == Phase.UNKNOWN) "没收到结果：看一下列表是否已经变了，再决定要不要重试" else text
    }
}

/**
 * Connecting a new device, on one screen: the install command, waiting for it to be run, the device asking, approving
 * with what it may do, and connected. Moves on `pair.changed` events (and the answers of the words), never by polling; the
 * countdown is computed from the deadline at drawing time.
 */
class PairFlow {
    sealed class Step {
        object Idle : Step()
        object Issuing : Step()
        data class Waiting(val pairId: String, val command: String, val deadline: Long) : Step()
        data class Asking(val pairId: String, val name: String) : Step()
        data class Approving(val pairId: String, val name: String) : Step()
        data class Approved(val pairId: String, val device: String?) : Step()
        data class Connected(val device: String?) : Step()
        /** Ended without a device: why, and what to do next. */
        data class Ended(val why: String, val next: String) : Step()
    }

    var step: Step = Step.Idle; private set
    val pairId get() = when (val s = step) {
        is Step.Waiting -> s.pairId; is Step.Asking -> s.pairId; is Step.Approving -> s.pairId; is Step.Approved -> s.pairId; else -> null
    }

    fun start(): Boolean { if (step is Step.Issuing || step is Step.Waiting || step is Step.Asking || step is Step.Approving) return false; step = Step.Issuing; return true }

    /** `pair_start` answered. */
    fun issued(data: JSONObject?, code: String?, message: String?) {
        if (step !is Step.Issuing) return
        val id = data?.optString("pair_id", "")?.takeIf { it.isNotEmpty() }
        val command = data?.optString("command", "")?.takeIf { it.isNotEmpty() }
        step = if (id != null && command != null) Step.Waiting(id, command, data.optLong("expires_at", 0))
        else Step.Ended(issueFailure(code, message), issueNext(code))
    }

    /** A `pair.changed` event, or a `pair_status` answer, for any pairing: only this flow's own is taken. */
    fun changed(body: JSONObject, name: String? = null) {
        val id = body.optString("pair_id")
        if (id.isEmpty() || id != pairId) return
        step = when (body.optString("state")) {
            "requested" -> if (step is Step.Waiting) Step.Asking(id, name ?: body.optString("name")) else step
            "approved" -> Step.Approved(id, body.optString("device").takeIf { it.isNotEmpty() })
            "connected" -> Step.Connected(body.optString("device").takeIf { it.isNotEmpty() })
            "rejected" -> Step.Ended("这次请求被拒绝了", "要接这台设备，重新生成一次安装命令")
            "expired" -> Step.Ended("安装命令过期了（几分钟内只能用一次）", "重新生成一条，拿到就去那台电脑上运行")
            "failed" -> Step.Ended("没通过安全校验：${body.optString("reason").ifEmpty { "连上来的设备不是申请配对的那台" }}", "重新生成一条安装命令；反复失败就换一个中转站")
            else -> step
        }
    }

    fun approve(): Boolean { val s = step as? Step.Asking ?: return false; step = Step.Approving(s.pairId, s.name); return true }

    /** `pair_approve` answered: approved, or back to asking with the reason. */
    fun approveAnswered(data: JSONObject?, code: String?, message: String?): String? {
        val s = step as? Step.Approving ?: return null
        if (data != null) { step = Step.Approved(s.pairId, data.optString("device").takeIf { it.isNotEmpty() }); return null }
        step = Step.Asking(s.pairId, s.name)
        return if (code == "result_unknown") "没收到结果：稍等看它会不会自己变成已批准" else "没批准成功：${message ?: code ?: "原因不明"}"
    }

    /** The command ran out of time while nobody answered (drawn from the clock, not read from the hub). */
    fun expiredBy(now: Long): Boolean = (step as? Step.Waiting)?.let { it.deadline in 1..now } == true

    fun reset() { step = Step.Idle }

    /** Restore only the identifier; the one-time secret stays out of saved state. Read pair_status before any action. */
    fun resume(id: String) { step = Step.Waiting(id, "", 0) }

    fun restoreCommand(id: String, command: String, deadline: Long) {
        val waiting = step as? Step.Waiting ?: return
        if (waiting.pairId == id && command.isNotEmpty()) step = waiting.copy(command = command, deadline = deadline)
    }

    private fun issueFailure(code: String?, message: String?) = when (code) {
        "unavailable" -> "中转站现在连不上，生成不了安装命令"
        "result_unknown" -> "没收到结果"
        else -> "生成安装命令失败：${message ?: code ?: "原因不明"}"
    }
    private fun issueNext(code: String?) = when (code) {
        "unavailable" -> "看一下顶部的中转站状态；没有中转站就让 Ash 帮你搭一个"
        else -> "稍后再试一次"
    }

    companion object {
        fun left(deadline: Long, now: Long): String {
            val s = ((deadline - now) / 1000).coerceAtLeast(0)
            return "${s / 60}:${"%02d".format(s % 60)}"
        }
    }
}
