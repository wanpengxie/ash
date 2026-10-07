package ai.ash.screen.switches

import ai.ash.bridge.KeepAliveSwitches
import ai.ash.bridge.KeepAliveSwitches.Item
import ai.ash.bridge.KeepAliveSwitches.Kind
import ai.ash.bridge.KeepAliveSwitches.Outcome
import ai.ash.bridge.KeepAliveSwitches.Report
import ai.ash.bridge.KeepAliveSwitches.State
import ai.ash.bridge.KeepAliveSwitches.Target

/**
 * Turns on, in the ColorOS settings, the switches that keep Ash's own apps alive. No model is involved: every step is
 * a fixed screen to wait for, a label to find by its exact text, and one tap on that label's own row.
 *
 *  1. Settings → 「应用」 → 「自启动」 (the list of apps).
 *  2. For each app: its row → the app's page → 「开机自启动」 and 「后台自启动」, each turned on if off (a confirmation
 *     dialog is answered with 「允许」/「确定」/「仍然允许」), and checked again afterwards.
 *  3. For each app: its info page → 「耗电管理」 → 「允许应用后台行为」, the same way.
 *  4. Back to Ash.
 *
 * It only ever acts on windows of the system's settings and the maker's own settings apps ([allowedPackage]); the first
 * thing unexpected stops it, and the report says where.
 */
class SwitchFlow(
    private val ui: SwitchUi,
    packages: List<String>,
    private val stepMs: Long = 5_000,
    totalMs: Long = 90_000,
    private val maxScrolls: Int = 30,
) {
    private class Abort(val reason: String) : Exception(reason)

    private val targets: List<Target> = packages.distinct().mapNotNull { KeepAliveSwitches.target(it) }
    private val items = mutableListOf<Item>()
    private val deadline = ui.now() + totalMs
    private var step = ""

    fun run(): Report {
        var stopped = ""
        try {
            if (targets.isNotEmpty()) { autostart(); behavior() }
        } catch (a: Abort) {
            stopped = "$step：${a.reason}"
        } finally {
            runCatching { ui.returnToAsh() }
        }
        return Report(if (stopped.isEmpty()) Outcome.DONE else Outcome.ABORTED, stopped, items.toList())
    }

    // ---- the steps ----

    private fun autostart() {
        begin("打开设置")
        if (!ui.openSettings()) throw Abort("打不开系统设置")
        begin("设置 →「应用」")
        press(locate("应用", stepMs) ?: throw Abort("设置里找不到「应用」"), "应用")
        begin("「应用」→「自启动」")
        press(locate("自启动", stepMs) ?: throw Abort("找不到「自启动」"), "自启动")
        for (t in targets) {
            begin("「自启动」列表 →「${t.label}」")
            val row = locate(t.label, stepMs)
            if (row == null) { missing(t, Kind.BOOT, Kind.BACKGROUND); continue }
            press(row, t.label)
            begin("「${t.label}」的自启动页")
            waitFor("开机自启动 / 后台自启动") { r -> exact(r, Kind.BOOT.label).firstOrNull() ?: exact(r, Kind.BACKGROUND.label).firstOrNull() }
            for (kind in listOf(Kind.BOOT, Kind.BACKGROUND)) { begin("「${t.label}」的「${kind.label}」"); toggle(t, kind, 800) }
            begin("回到「自启动」列表")
            ui.back(); ui.settle()
        }
    }

    private fun behavior() {
        for (t in targets) {
            begin("「${t.label}」的应用详情")
            if (!ui.openAppDetails(t.pkg)) { items += Item(t.pkg, Kind.BEHAVIOR, State.FAILED); continue }
            val power = locate("耗电管理", stepMs)
            if (power == null) { missing(t, Kind.BEHAVIOR); continue }
            press(power, "耗电管理")
            begin("「${t.label}」的「${Kind.BEHAVIOR.label}」")
            toggle(t, Kind.BEHAVIOR, stepMs)
            ui.back(); ui.settle(); ui.back(); ui.settle()
        }
    }

    private fun begin(name: String) {
        step = name
        if (ui.now() >= deadline) throw Abort("超过了总时限")
    }

    private fun missing(t: Target, vararg kinds: Kind) { for (k in kinds) items += Item(t.pkg, k, State.NOT_FOUND) }

    /** Turns one switch on, and reads it again to be sure. */
    private fun toggle(t: Target, kind: Kind, appearMs: Long) {
        val label = locate(kind.label, appearMs)
        if (label == null) { items += Item(t.pkg, kind, State.NOT_FOUND); return }
        val found = switchOf(label)
        if (found == null) { items += Item(t.pkg, kind, State.FAILED); return }
        if (found.second.checked) { items += Item(t.pkg, kind, State.WAS_ON); return }
        items += Item(t.pkg, kind, turnOn(kind, label, found.first, found.second))
    }

    private fun turnOn(kind: Kind, label: UiNode, scope: UiNode, box: UiNode): State {
        if (!pressSwitch(label, scope, box)) return State.FAILED
        val end = minOf(ui.now() + stepMs, deadline)
        var dialogs = 0
        while (true) {
            ui.settle()
            val root = allowedRoot()
            if (root != null) {
                val now = exact(root, kind.label).firstOrNull()?.let { switchOf(it) }?.second
                if (now?.checked == true) return State.TURNED_ON
                // A system dialog may stand in the way: answer it with its positive button, at most twice.
                if (dialogs < 2) {
                    val button = CONFIRM.firstNotNullOfOrNull { c -> exact(root, c).firstOrNull { it.clickable && it.enabled } }
                    if (button != null) { dialogs++; guard(button); if (button.click()) continue }
                }
            }
            if (ui.now() >= end) return State.FAILED
            ui.sleep(POLL_MS)
        }
    }

    // ---- finding and pressing ----

    /** The switch in [label]'s row: the one check box under the nearest ancestor that has any. */
    private fun switchOf(label: UiNode): Pair<UiNode, UiNode>? {
        var scope: UiNode? = label
        for (depth in 0..5) {
            val s = scope ?: return null
            val boxes = checkables(s)
            if (boxes.size == 1) return s to boxes[0]
            if (boxes.size > 1) return null
            scope = s.parent()
        }
        return null
    }

    private fun checkables(node: UiNode): List<UiNode> =
        (if (node.checkable) listOf(node) else emptyList()) + node.children().flatMap { checkables(it) }

    /** Taps the switch itself when it takes taps, else the row it sits in (never anything wider than the row). */
    private fun pressSwitch(label: UiNode, scope: UiNode, box: UiNode): Boolean {
        guard(label); guard(box)
        if (box.clickable && box.enabled) return box.click()
        var cur: UiNode? = box
        while (cur != null) {
            if (cur.clickable && cur.enabled) { guard(cur); return cur.click() }
            if (cur == scope) break
            cur = cur.parent()
        }
        return false
    }

    /** Taps the nearest tappable element at or above [node]: a row's text is rarely the tappable part. */
    private fun press(node: UiNode, what: String) {
        guard(node)
        var cur: UiNode? = node
        for (i in 0..6) {
            val c = cur ?: break
            if (c.clickable && c.enabled) { guard(c); if (c.click()) { ui.settle(); return }; break }
            cur = c.parent()
        }
        throw Abort("点不开「$what」")
    }

    /** Never acts outside the settings apps. */
    private fun guard(node: UiNode) { if (!allowedPackage(node.packageName)) throw Abort("前台是 ${node.packageName.ifEmpty { "未知应用" }}，不是系统设置") }

    /** Stops when another app is in front: whatever is wanted is not on the screen, and nothing must be tapped there. */
    private fun foreign() {
        val front = ui.root()?.packageName.orEmpty()
        if (front.isNotEmpty() && !allowedPackage(front)) throw Abort("前台是 $front，不是系统设置")
    }

    private fun exact(root: UiNode, label: String): List<UiNode> =
        root.findByText(label).filter { (it.text == label || it.description == label) && allowedPackage(it.packageName) }

    private fun allowedRoot(): UiNode? = ui.root()?.takeIf { allowedPackage(it.packageName) }

    private fun <T : Any> poll(ms: Long, probe: (UiNode) -> T?): T? {
        val end = minOf(ui.now() + ms, deadline)
        while (true) {
            val root = allowedRoot()
            if (root != null) probe(root)?.let { return it }
            if (ui.now() >= end) return null
            ui.sleep(POLL_MS)
        }
    }

    private fun <T : Any> waitFor(what: String, ms: Long = stepMs, probe: (UiNode) -> T?): T {
        poll(ms, probe)?.let { return it }
        if (ui.now() >= deadline) throw Abort("超过了总时限")
        val front = ui.root()?.packageName.orEmpty()
        throw Abort("等不到「$what」" + if (front.isNotEmpty() && !allowedPackage(front)) "（前台是 $front）" else "")
    }

    /** The element whose text is exactly [label]: on screen within [appearMs], else by scrolling down and then back up. */
    private fun locate(label: String, appearMs: Long): UiNode? {
        poll(appearMs) { exact(it, label).firstOrNull() }?.let { return it }
        foreign()
        for (forward in listOf(true, false)) {
            var n = 0
            while (n++ < maxScrolls) {
                if (ui.now() >= deadline) throw Abort("超过了总时限")
                val root = allowedRoot() ?: run { foreign(); null } ?: break
                val list = scroller(root) ?: break
                guard(list)
                if (!list.scroll(forward)) break
                ui.settle()
                allowedRoot()?.let { exact(it, label).firstOrNull() }?.let { return it }
            }
        }
        return null
    }

    private fun scroller(node: UiNode): UiNode? {
        if (node.scrollable && node.enabled) return node
        for (c in node.children()) scroller(c)?.let { return it }
        return null
    }

    companion object {
        private const val POLL_MS = 250L
        /** The positive buttons of the dialogs the switches may bring up. */
        private val CONFIRM = listOf("允许", "确定", "仍然允许")

        /** The system's settings and the maker's own settings and security apps: the only windows the flow works in. */
        fun allowedPackage(pkg: String): Boolean =
            pkg == "com.android.settings" || pkg.startsWith("com.coloros.") || pkg.startsWith("com.oplus.")

        /** Only ColorOS (OPPO, OnePlus, realme) for now. */
        fun supported(manufacturer: String): Boolean = manufacturer.lowercase() in setOf("oppo", "oneplus", "realme")
    }
}
