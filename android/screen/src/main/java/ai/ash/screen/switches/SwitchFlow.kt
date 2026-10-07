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
 *  2. For each app, its row, found by the app's exact name (「Ash」 is never 「Ash 感知」):
 *     - ColorOS 15: the row has the app's one switch, and a subtitle saying what it covers (「开机自启动、后台自启动」,
 *       「后台自启动」, with 「已禁止」 when off). The switch is turned on if off and read again; the subtitle afterwards
 *       says which of 开机自启动 / 后台自启动 it turned on.
 *     - older versions: the row opens the app's page → 「开机自启动」 and 「后台自启动」, each turned on if off.
 *     A confirmation dialog is answered with 「允许」/「确定」/「仍然允许」.
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
    totalMs: Long = 150_000,
    private val maxScrolls: Int = 40,
) {
    private class Abort(val reason: String) : Exception(reason)

    /** One row with its own switch: the smallest element around the label that holds exactly one switch. */
    private class Row(val scope: UiNode, val title: UiNode, val box: UiNode) {
        /** The row's other texts (ColorOS 15: what the switch covers, and whether it is 已禁止). */
        val subtitle: String = texts(scope).filter { it != title.label }.joinToString(" ")
        /** The subtitle's own say, when it has one: off when it says 已禁止, on when it names a kind without that. */
        val subtitleOn: Boolean? = when {
            OFF_WORDS.any { subtitle.contains(it) } -> false
            AUTOSTART.any { subtitle.contains(it.label) } -> true
            else -> null
        }
        /** The switch is on, and the subtitle (if any) does not say otherwise. */
        val on get() = box.checked && subtitleOn != false
        /** The switch and the subtitle agree (or there is no subtitle to disagree). */
        val agrees get() = subtitleOn == null || subtitleOn == box.checked
        /** The kinds the subtitle names; none named: the one switch is the whole 自启动. */
        val covers: Set<Kind> get() = AUTOSTART.filter { subtitle.contains(it.label) }.toSet().ifEmpty { AUTOSTART.toSet() }
    }

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
        for ((i, t) in targets.withIndex()) {
            begin("「自启动」列表 →「${t.label}」")
            // The list takes a moment to come up the first time; after that, a row not on screen is scrolled to.
            val title = locate(t.label, if (i == 0) stepMs else ROW_MS)
            if (title == null) { missing(t, Kind.BOOT, Kind.BACKGROUND); continue }
            val row = rowOf(title)
            if (row != null) {
                begin("「自启动」列表里「${t.label}」的开关")
                listSwitch(t, row)
                continue
            }
            val list = allowedRoot()?.let { texts(it) }
            press(title, t.label)
            begin("「${t.label}」的自启动页")
            // Only a new screen, with the label beside its own switch, is the app's page: in a list, another app's
            // subtitle may read 「后台自启动」 too.
            waitFor("开机自启动 / 后台自启动") { r ->
                if (texts(r) == list) null else AUTOSTART.firstNotNullOfOrNull { k -> exact(r, k.label).firstOrNull { rowOf(it) != null } }
            }
            for (kind in AUTOSTART) { begin("「${t.label}」的「${kind.label}」"); toggle(t, kind, 800) }
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

    // ---- ColorOS 15: one switch per app in the list ----

    /** The app's one switch in the list: read (switch and subtitle), turned on if off, read again. */
    private fun listSwitch(t: Target, first: Row) {
        var row = first
        if (!row.agrees) {
            // The subtitle may lag the switch for a moment; read once more before trusting either.
            ui.settle(); ui.sleep(POLL_MS)
            row = rowOnScreen(t.label) ?: row
            if (!row.agrees) { report(t, row, State.FAILED); return }
        }
        if (row.on) { report(t, row, State.WAS_ON); return }
        val after = turnOnRow(t.label, row)
        if (after == null) report(t, row, State.FAILED) else report(t, after, State.TURNED_ON)
    }

    /** One item per kind: what the switch covers gets [state]; the other kind is not on this phone. */
    private fun report(t: Target, row: Row, state: State) {
        val covers = row.covers
        for (k in AUTOSTART) items += Item(t.pkg, k, if (k in covers) state else State.NOT_OFFERED)
    }

    /**
     * Taps the switch (else its row) and waits to read it on, switch and subtitle both. A second element is tapped
     * only when the first left the switch plainly off, so a slow switch is never turned back off.
     */
    private fun turnOnRow(label: String, row: Row): Row? {
        for (tap in tapsFor(row)) {
            guard(tap)
            if (!tap.click()) continue
            val end = minOf(ui.now() + stepMs, deadline)
            var dialogs = 0
            var seen: Row? = null
            while (true) {
                ui.settle()
                val root = allowedRoot()
                if (root != null) {
                    val now = exact(root, label).firstNotNullOfOrNull { rowOf(it) }
                    if (now != null) { seen = now; if (now.on && now.agrees) return now }
                    if (dialogs < 2 && answerDialog(root)) { dialogs++; continue }
                }
                if (ui.now() >= end) break
                ui.sleep(POLL_MS)
            }
            // Not plainly off (the row is gone, or the switch and its subtitle disagree): no more taps.
            val last = seen ?: return null
            if (last.box.checked || last.subtitleOn == true) return null
        }
        return null
    }

    /** The switch itself when it takes taps, then the nearest tappable element above it within the row. */
    private fun tapsFor(row: Row): List<UiNode> {
        val taps = mutableListOf<UiNode>()
        if (row.box.clickable && row.box.enabled) taps += row.box
        var cur: UiNode? = row.box.parent()
        while (cur != null) {
            if (cur.clickable && cur.enabled) { taps += cur; break }
            if (cur == row.scope) break
            cur = cur.parent()
        }
        return taps.distinct()
    }

    private fun rowOnScreen(label: String): Row? = allowedRoot()?.let { r -> exact(r, label).firstNotNullOfOrNull { rowOf(it) } }

    // ---- a labelled switch on its own (the older app page, 耗电管理) ----

    /** Turns one switch on, and reads it again to be sure. */
    private fun toggle(t: Target, kind: Kind, appearMs: Long) {
        val label = locate(kind.label, appearMs)
        if (label == null) { items += Item(t.pkg, kind, State.NOT_FOUND); return }
        val found = rowOf(label)
        if (found == null) { items += Item(t.pkg, kind, State.FAILED); return }
        if (found.box.checked) { items += Item(t.pkg, kind, State.WAS_ON); return }
        items += Item(t.pkg, kind, turnOn(kind, found))
    }

    private fun turnOn(kind: Kind, row: Row): State {
        if (!pressSwitch(row)) return State.FAILED
        val end = minOf(ui.now() + stepMs, deadline)
        var dialogs = 0
        while (true) {
            ui.settle()
            val root = allowedRoot()
            if (root != null) {
                val now = exact(root, kind.label).firstNotNullOfOrNull { rowOf(it) }?.box
                if (now?.checked == true) return State.TURNED_ON
                if (dialogs < 2 && answerDialog(root)) { dialogs++; continue }
            }
            if (ui.now() >= end) return State.FAILED
            ui.sleep(POLL_MS)
        }
    }

    /** A system dialog may stand in the way: it is answered with its positive button. */
    private fun answerDialog(root: UiNode): Boolean {
        val button = CONFIRM.firstNotNullOfOrNull { c -> exact(root, c).firstOrNull { it.clickable && it.enabled } } ?: return false
        guard(button)
        return button.click()
    }

    // ---- finding and pressing ----

    /**
     * The row around [label]: the nearest ancestor holding exactly one switch, and never the list itself (a row that
     * has no switch must not borrow its neighbour's).
     */
    private fun rowOf(label: UiNode): Row? {
        var scope: UiNode? = label
        for (depth in 0..5) {
            val s = scope ?: return null
            if (s.scrollable) return null
            val boxes = checkables(s)
            if (boxes.size == 1) return if (hasScroller(s)) null else Row(s, label, boxes[0])
            if (boxes.size > 1) return null
            scope = s.parent()
        }
        return null
    }

    private fun checkables(node: UiNode): List<UiNode> =
        (if (node.checkable) listOf(node) else emptyList()) + node.children().flatMap { checkables(it) }

    private fun hasScroller(node: UiNode): Boolean = node.children().any { it.scrollable || hasScroller(it) }

    /** Taps the switch itself when it takes taps, else the row it sits in (never anything wider than the row). */
    private fun pressSwitch(row: Row): Boolean {
        guard(row.title)
        val tap = tapsFor(row).firstOrNull() ?: return false
        guard(tap)
        return tap.click()
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

    /** Elements whose whole text (or description) is [label]: 「Ash」 never matches 「Ash 感知」 or 「Ash 屏幕助手」. */
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

    /**
     * The element whose text is exactly [label]: on screen within [appearMs], else by scrolling the list down to its
     * end and then back up to its top, at most [maxScrolls] each way. The end is where a scroll is refused or leaves
     * the list showing the same texts.
     */
    private fun locate(label: String, appearMs: Long): UiNode? {
        poll(appearMs) { exact(it, label).firstOrNull() }?.let { return it }
        foreign()
        for (forward in listOf(true, false)) {
            var shown = allowedRoot()?.let { r -> scroller(r)?.let { texts(it) } }
            var n = 0
            while (n++ < maxScrolls) {
                if (ui.now() >= deadline) throw Abort("超过了总时限")
                val root = allowedRoot() ?: run { foreign(); null } ?: break
                val list = scroller(root) ?: break
                guard(list)
                if (!list.scroll(forward)) break
                ui.settle()
                val after = allowedRoot() ?: continue
                exact(after, label).firstOrNull()?.let { return it }
                val now = scroller(after)?.let { texts(it) }
                if (now == shown) break
                shown = now
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
        /** How long a row already in the list is looked for on screen before scrolling. */
        private const val ROW_MS = 1_000L
        private val AUTOSTART = listOf(Kind.BOOT, Kind.BACKGROUND)
        /** What a subtitle says when the switch is off. */
        private val OFF_WORDS = listOf("已禁止", "已关闭")
        /** The positive buttons of the dialogs the switches may bring up. */
        private val CONFIRM = listOf("允许", "确定", "仍然允许")

        /** Every text under [node], in order. */
        private fun texts(node: UiNode): List<String> =
            listOfNotNull(node.label.takeIf { it.isNotEmpty() }) + node.children().flatMap { texts(it) }

        /** The system's settings and the maker's own settings and security apps: the only windows the flow works in. */
        fun allowedPackage(pkg: String): Boolean =
            pkg == "com.android.settings" || pkg.startsWith("com.coloros.") || pkg.startsWith("com.oplus.")

        /** Only ColorOS (OPPO, OnePlus, realme) for now. */
        fun supported(manufacturer: String): Boolean = manufacturer.lowercase() in setOf("oppo", "oneplus", "realme")
    }
}
