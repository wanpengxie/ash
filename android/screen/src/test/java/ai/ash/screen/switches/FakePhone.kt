package ai.ash.screen.switches

/**
 * A node of a fake screen. A list shows only [window] of its rows at a time and scrolls like a RecyclerView; an
 * [endless] one says yes to a scroll at its end, as some lists do, and stays where it is.
 */
class FakeNode(
    override var text: String = "",
    override val packageName: String = "com.android.settings",
    override val clickable: Boolean = false,
    override val checkable: Boolean = false,
    checked: Boolean = false,
    override val enabled: Boolean = true,
    val window: Int = 0,
    val endless: Boolean = false,
    var onClick: (() -> Unit)? = null,
    rows: List<FakeNode> = emptyList(),
) : UiNode {
    override var checked = checked
    override val description = ""
    override val scrollable get() = window > 0
    private val rows = rows.toMutableList()
    private var offset = 0
    private var up: FakeNode? = null
    var clicks = 0
    init { for (r in rows) r.up = this }

    fun add(vararg n: FakeNode): FakeNode { for (r in n) { r.up = this; rows += r }; return this }
    override fun parent(): UiNode? = up
    override fun children(): List<UiNode> = if (window > 0) rows.drop(offset).take(window) else rows
    override fun findByText(text: String): List<UiNode> =
        (if (this.text.contains(text, true)) listOf(this) else emptyList()) + children().flatMap { it.findByText(text) }
    override fun click(): Boolean { clicks++; onClick?.invoke(); return true }
    override fun scroll(forward: Boolean): Boolean {
        val next = if (forward) offset + 2 else offset - 2
        if (next < 0 || next >= rows.size) return endless
        offset = next; return true
    }
}

/**
 * A ColorOS-like settings: 设置 → 应用 → 自启动 → app page, and an app info page → 耗电管理. Time only moves when it sleeps.
 *
 * With [oneSwitch], the 自启动 list of ColorOS 15: each row of [apps] holds the app's one switch and a subtitle naming
 * what it covers ([oneSwitch] per app, default 「开机自启动、后台自启动」), with 「已禁止」 when off; 「拦截记录」 on top,
 * and the apps in two sections ([firstSection] apps in the first).
 */
class FakePhone(
    val apps: List<String> = listOf("微信", "地图", "Ash", "相机", "Ash 感知", "音乐", "Ash 屏幕助手", "天气"),
    val oneSwitch: Map<String, String>? = null,
    /** ColorOS 15 list: the one switch per app. */
    val autostart: MutableMap<String, Boolean> = mutableMapOf(),
    val firstSection: Int = 0,
    /** ColorOS 15 list: the switch itself takes taps (else only its row does). */
    val switchTakesTaps: Boolean = true,
    /** ColorOS 15 list: the subtitle keeps showing the state the list was opened with. */
    val staleSubtitle: Set<String> = emptySet(),
    val listWindow: Int = 3,
    val endlessList: Boolean = false,
    /** switch label → state per app label, for the 自启动 page. */
    val boot: MutableMap<String, Boolean> = mutableMapOf(),
    val background: MutableMap<String, Boolean> = mutableMapOf(),
    val behavior: MutableMap<String, Boolean> = mutableMapOf(),
    /** Per app: tapping its switch asks for a confirmation first. */
    val asksFirst: Set<String> = emptySet(),
    /** Per app: the switch ignores taps. */
    val stuck: Set<String> = emptySet(),
    val noBootRow: Set<String> = emptySet(),
    var foreignAfter: Int = -1,
    /** Settings comes back where it was last left (ColorOS ignores CLEAR_TASK): 1 = the 应用 page, 2 = the 自启动 list. */
    val leftAt: Int = 0,
) : SwitchUi {
    var time = 0L
    val pages = ArrayDeque<FakeNode>()
    var returned = false
    var openedSettings = 0
    val clickedLabels = mutableListOf<String>()
    private var dialog: FakeNode? = null
    private var frames = 0
    private val pkgOf = mapOf("Ash" to "ai.ash.agent", "Ash 感知" to "ai.ash.senses", "Ash 屏幕助手" to "ai.ash.screen")
    private val labelOf = pkgOf.entries.associate { it.value to it.key }

    private fun row(title: String, then: () -> Unit) = FakeNode(clickable = true, onClick = { clickedLabels += title; then() }).add(FakeNode(text = title))

    private fun switchRow(app: String, title: String, store: MutableMap<String, Boolean>): FakeNode {
        val box = FakeNode(checkable = true, checked = store[app] == true)
        val r = FakeNode(clickable = true, onClick = {
            clickedLabels += title
            if (app !in stuck) {
                if (app in asksFirst && store[app] != true) dialog = FakeNode(text = "允许", clickable = true, onClick = { store[app] = true; box.checked = true; dialog = null })
                else { store[app] = !(store[app] ?: false); box.checked = store[app] == true }
            }
        }).add(FakeNode(text = title), box)
        return r
    }

    private fun main() = FakeNode(window = 3).add(row("WLAN") {}, row("蓝牙") {}, row("显示与亮度") {}, row("电池") {}, row("应用") { pages += appsPage() })
    private fun appsPage() = FakeNode(window = 3).add(row("默认应用") {}, row("应用分身") {}, row("自启动") { pages += list() }, row("权限") {})
    private fun list(): FakeNode {
        val rows = oneSwitch?.let { covers ->
            val (first, second) = apps.withIndex().partition { it.index < firstSection }
            listOf(row("拦截记录") {}, FakeNode(text = "建议开启，关闭可能无法接收消息")) + first.map { listRow(it.value, covers) } +
                FakeNode(text = "建议关闭，开启后会导致系统耗电增加") + second.map { listRow(it.value, covers) }
        } ?: apps.map { a -> row(a) { pages += appPage(a) } }
        return FakeNode(window = listWindow, endless = endlessList).add(*rows.toTypedArray())
    }

    private fun subtitle(covers: String, on: Boolean) = if (on) covers else "${covers}已禁止"

    private fun listRow(app: String, covers: Map<String, String>): FakeNode {
        val what = covers[app] ?: "开机自启动、后台自启动"
        val shown = autostart[app] == true
        val sub = FakeNode(text = subtitle(what, shown))
        val box = FakeNode(checkable = true, checked = shown, clickable = switchTakesTaps)
        val set = { on: Boolean -> autostart[app] = on; box.checked = on; if (app !in staleSubtitle) sub.text = subtitle(what, on) }
        val tap = {
            clickedLabels += app
            if (app !in stuck) {
                if (app in asksFirst && autostart[app] != true) dialog = FakeNode(text = "允许", clickable = true, onClick = { set(true); dialog = null })
                else set(autostart[app] != true)
            }
        }
        if (switchTakesTaps) box.onClick = tap
        return FakeNode(clickable = true, onClick = tap).add(FakeNode().add(FakeNode(text = app), sub), box)
    }
    private fun appPage(app: String) = FakeNode().apply {
        if (app !in noBootRow) add(switchRow(app, "开机自启动", boot))
        add(switchRow(app, "后台自启动", background))
    }
    private fun details(pkg: String) = FakeNode(window = 4).add(row("通知管理") {}, row("耗电管理") { pages += power(labelOf.getValue(pkg)) }, row("存储") {})
    private fun power(app: String) = FakeNode().add(switchRow(app, "允许应用后台行为", behavior), row("耗电异常优化") {})

    override fun root(): UiNode? {
        if (foreignAfter in 0..frames) { frames++; return FakeNode(packageName = "com.tencent.mm").add(FakeNode(text = "后台自启动", clickable = true)) }
        frames++
        val d = dialog
        if (d != null) return FakeNode(packageName = "com.oplus.battery").add(d)
        return pages.lastOrNull()
    }
    override fun settle() { time += 50 }
    override fun openSettings(): Boolean {
        openedSettings++
        if (openedSettings == 1 && leftAt > 0) { pages.clear(); pages += main(); pages += appsPage(); if (leftAt > 1) pages += list(); return true }
        pages.clear(); pages += main(); return true
    }
    override fun openAppDetails(pkg: String): Boolean { pages += details(pkg); return true }
    override fun back(): Boolean { if (pages.isNotEmpty()) pages.removeLast(); return true }
    override fun returnToAsh() { returned = true }
    override fun now() = time
    override fun sleep(ms: Long) { time += ms }
}
