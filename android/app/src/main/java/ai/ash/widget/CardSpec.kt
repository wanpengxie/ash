package ai.ash.widget

import org.json.JSONArray
import org.json.JSONObject

/** A card the phone cannot draw, with the reason in words the owner (and the card's creator) can act on. */
class CardProblem(message: String) : IllegalArgumentException(message)

/** A colour for light and for dark mode (ARGB). */
data class Tint(val light: Int, val dark: Int) {
    fun pick(night: Boolean) = if (night) dark else light
    fun withAlpha(alpha: Float): Tint {
        fun a(c: Int) = (((c ushr 24) * alpha).toInt().coerceIn(0, 255) shl 24) or (c and 0xFFFFFF)
        return Tint(a(light), a(dark))
    }
}

/** A size along one axis: fill the parent, wrap the content, or a number of dp. */
sealed class Dim {
    object Fill : Dim() { override fun toString() = "Fill" }
    object Wrap : Dim() { override fun toString() = "Wrap" }
    data class Dp(val dp: Float) : Dim()
}

data class CStyle(
    val background: Tint? = null, val color: Tint? = null, val cornerRadius: Float? = null, val padding: FloatArray? = null,
    val margin: FloatArray? = null, val width: Dim? = null, val height: Dim? = null, val fontSize: Float? = null, val fontWeight: Int? = null,
    val italic: Boolean? = null, val underline: Boolean = false, val strikethrough: Boolean = false, val textAlign: String? = null,
    val maxLines: Int? = null, val ellipsize: String? = null, val lineHeight: Float? = null, val letterSpacing: Float? = null,
    val opacity: Float? = null, val place: String? = null,
) {
    override fun equals(other: Any?) = other is CStyle && toString() == other.toString()
    override fun hashCode() = toString().hashCode()
    override fun toString() = "CStyle($background,$color,$cornerRadius,${padding?.toList()},${margin?.toList()},$width,$height,$fontSize,$fontWeight," +
        "$italic,$underline,$strikethrough,$textAlign,$maxLines,$ellipsize,$lineHeight,$letterSpacing,$opacity,$place)"
}

/** What a tap does. */
sealed class CAction {
    data class Event(val name: String) : CAction()
    data class OpenApp(val app: String, val surface: String?) : CAction()
    object OpenAsh : CAction() { override fun toString() = "OpenAsh" }
    data class OpenUrl(val url: String) : CAction()
}

data class COption(val label: String, val value: String, val checked: Boolean)
data class CTab(val title: String, val child: CNode)

/** One resolved component of a card, as the core sent it, linked into a tree. */
data class CNode(
    val id: String, val kind: String, val style: CStyle = CStyle(), val weight: Float = 0f, val action: CAction? = null,
    val visible: Boolean = true, val disabled: Boolean = false, val a11y: String? = null, val item: String? = null, val bound: Boolean = false,
    val children: List<CNode> = emptyList(), val child: CNode? = null, val tabs: List<CTab> = emptyList(), val selected: Int = 0,
    val justify: String? = null, val align: String? = null, val columns: Int = 1, val text: String = "", val variant: String? = null,
    val url: String? = null, val fit: String? = null, val name: String? = null, val svgPath: String? = null, val axis: String = "horizontal",
    val checked: Boolean = false, val label: String? = null, val options: List<COption> = emptyList(), val multiple: Boolean = false,
    val chips: Boolean = false, val value: Double = 0.0, val max: Double = 100.0, val size: Float? = null, val format: String? = null,
    val timeZone: String? = null, val since: Long? = null, val until: Long? = null,
) {
    /** The id the creator wrote (without the copy suffix a template or a per-size layout adds). */
    val defId: String get() = id.substringBefore('@').substringBefore('#')
    /** Children drawn in this card's own tree (a List's items are drawn apart). */
    val inner: List<CNode> get() = children + listOfNotNull(child) + tabs.map { it.child }
}

data class CSize(val width: Float, val height: Float, val root: CNode)
data class CardRender(val root: CNode, val sizes: List<CSize>, val accent: Tint?)

/**
 * The phone's half of the card format (the core's half is packages/core/src/members/widgets-card.ts): the components
 * the core resolved, the colours and icons they name, and Android's nesting budget counted the same way.
 */
object CardSpec {
    /** RemoteViews refuses more than 10 nested RemoteViews below the top one; per-size layouts add one; list items start afresh. */
    const val LEVELS = 10
    const val LEVELS_WITH_SIZES = 9
    const val ITEM_LEVELS = 11
    /** Scrolling lists per layout: each needs its own prebuilt view id (res/layout/w_list_N.xml). */
    const val LISTS = 16

    private fun c(hex: Long) = hex.toInt()
    /** Theme colours (light, dark); the same names as the core's CARD_COLORS. */
    val colors: Map<String, Tint> = linkedMapOf(
        "text" to Tint(c(0xFF1C1C1E), c(0xFFECECEE)), "textSecondary" to Tint(c(0xFF6E6E73), c(0xFF96969C)),
        "accent" to Tint(c(0xFFFF7A3D), c(0xFFFF7A3D)), "onAccent" to Tint(c(0xFFFFFFFF), c(0xFFFFFFFF)),
        "background" to Tint(c(0xF2F7F7F5), c(0xF2141415)), "surface" to Tint(c(0xFFFFFFFF), c(0xFF1C1C1E)),
        "surfaceVariant" to Tint(c(0xFFEDEDEF), c(0xFF2A2A2D)), "line" to Tint(c(0x1F000000), c(0x26FFFFFF)),
        "transparent" to Tint(0, 0), "translucentDark" to Tint(c(0xB3000000), c(0xB3000000)),
        "translucentLight" to Tint(c(0xB3FFFFFF), c(0xB3FFFFFF)), "white" to Tint(c(0xFFFFFFFF), c(0xFFFFFFFF)),
        "black" to Tint(c(0xFF000000), c(0xFF000000)), "red" to Tint(c(0xFFE53935), c(0xFFEF5350)),
        "orange" to Tint(c(0xFFFB8C00), c(0xFFFFA726)), "yellow" to Tint(c(0xFFF9A825), c(0xFFFFEE58)),
        "green" to Tint(c(0xFF43A047), c(0xFF66BB6A)), "teal" to Tint(c(0xFF00897B), c(0xFF26A69A)),
        "blue" to Tint(c(0xFF1E88E5), c(0xFF42A5F5)), "purple" to Tint(c(0xFF8E24AA), c(0xFFAB47BC)),
        "pink" to Tint(c(0xFFD81B60), c(0xFFEC407A)), "gray" to Tint(c(0xFF8E8E93), c(0xFF8E8E93)))

    /** Built-in icons (A2UI names and Ash's own), drawn as glyphs; the same names as the core's CARD_ICONS. */
    val icons: Map<String, String> = linkedMapOf(
        "accountCircle" to "👤", "add" to "＋", "arrowBack" to "←", "arrowForward" to "→", "attachFile" to "📎", "calendarToday" to "📅",
        "call" to "📞", "camera" to "📷", "check" to "✓", "close" to "✕", "delete" to "🗑", "download" to "⤓", "edit" to "✎", "event" to "📆",
        "error" to "⛔", "fastForward" to "⏩", "favorite" to "♥", "favoriteOff" to "♡", "folder" to "📁", "help" to "？", "home" to "🏠",
        "info" to "ℹ", "locationOn" to "📍", "lock" to "🔒", "lockOpen" to "🔓", "mail" to "✉", "menu" to "☰", "moreVert" to "⋮",
        "moreHoriz" to "⋯", "notificationsOff" to "🔕", "notifications" to "🔔", "pause" to "⏸", "payment" to "💳", "person" to "👤",
        "phone" to "📱", "photo" to "🖼", "play" to "▶", "print" to "🖨", "refresh" to "⟳", "rewind" to "⏪", "search" to "🔍", "send" to "➤",
        "settings" to "⚙", "share" to "⇪", "shoppingCart" to "🛒", "skipNext" to "⏭", "skipPrevious" to "⏮", "star" to "★", "starHalf" to "⯪",
        "starOff" to "☆", "stop" to "⏹", "upload" to "⤒", "visibility" to "👁", "visibilityOff" to "🙈", "volumeDown" to "🔉",
        "volumeMute" to "🔈", "volumeOff" to "🔇", "volumeUp" to "🔊", "warning" to "⚠️",
        "sun" to "☀️", "cloud" to "☁️", "rain" to "🌧️", "snow" to "❄️", "wind" to "🌬️", "moon" to "🌙", "heart" to "❤️", "steps" to "👣",
        "weight" to "⚖️", "sleep" to "😴", "water" to "💧", "fire" to "🔥", "calendar" to "📅", "clock" to "⏰", "alert" to "⚠️", "bell" to "🔔",
        "car" to "🚗", "money" to "💰", "chart" to "📈")

    val avatars = listOf("default", "focused", "listening", "resting", "success", "thinking")

    fun glyph(name: String): String? = icons[name]

    /** "#RRGGBBAA", a theme name, or {light, dark}. */
    fun tint(raw: Any?): Tint? = when (raw) {
        null, JSONObject.NULL -> null
        is JSONObject -> {
            val l = tint(raw.opt("light")); val d = tint(raw.opt("dark"))
            if (l == null || d == null) throw CardProblem("颜色 {light, dark} 不完整")
            Tint(l.light, d.dark)
        }
        is String -> colors[raw] ?: hex(raw)?.let { Tint(it, it) } ?: throw CardProblem("不认识的颜色「$raw」")
        else -> throw CardProblem("不认识的颜色")
    }

    private fun hex(raw: String): Int? {
        if (!raw.startsWith("#")) return null
        var h = raw.substring(1)
        if (h.length == 3 || h.length == 4) h = h.map { "$it$it" }.joinToString("")
        if (h.length == 6) h += "FF"
        if (h.length != 8 || !h.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) return null
        val rgba = h.toLong(16)
        // CSS order (alpha last) to Android's ARGB.
        return (((rgba and 0xFF) shl 24) or (rgba ushr 8)).toInt()
    }

    private fun dim(raw: Any?): Dim? = when (raw) {
        null, JSONObject.NULL -> null
        "fill" -> Dim.Fill
        "wrap" -> Dim.Wrap
        is Number -> Dim.Dp(raw.toFloat())
        else -> throw CardProblem("不认识的尺寸「$raw」")
    }

    private fun box(raw: JSONArray?): FloatArray? = raw?.let { a -> FloatArray(4) { a.optDouble(it, 0.0).toFloat() } }

    private fun style(o: JSONObject?): CStyle {
        if (o == null) return CStyle()
        fun f(key: String) = if (o.has(key)) o.optDouble(key).toFloat() else null
        return CStyle(
            background = tint(o.opt("background")), color = tint(o.opt("color")), cornerRadius = f("cornerRadius"),
            padding = box(o.optJSONArray("padding")), margin = box(o.optJSONArray("margin")), width = dim(o.opt("width")), height = dim(o.opt("height")),
            fontSize = f("fontSize"), fontWeight = if (o.has("fontWeight")) o.optInt("fontWeight") else null,
            italic = if (o.has("italic")) o.optBoolean("italic") else null, underline = o.optBoolean("underline"),
            strikethrough = o.optBoolean("strikethrough"), textAlign = o.optString("textAlign").ifEmpty { null },
            maxLines = if (o.has("maxLines")) o.optInt("maxLines") else null, ellipsize = o.optString("ellipsize").ifEmpty { null },
            lineHeight = f("lineHeight"), letterSpacing = f("letterSpacing"), opacity = f("opacity"), place = o.optString("place").ifEmpty { null })
    }

    private fun action(o: JSONObject?): CAction? {
        if (o == null) return null
        o.optJSONObject("event")?.let { return CAction.Event(it.optString("name").ifEmpty { throw CardProblem("动作缺少名字") }) }
        o.optJSONObject("openApp")?.let { return CAction.OpenApp(it.optString("app"), it.optString("surface").ifEmpty { null }) }
        if (o.has("openAsh")) return CAction.OpenAsh
        o.optJSONObject("openUrl")?.let { return CAction.OpenUrl(it.optString("url")) }
        throw CardProblem("不认识的动作")
    }

    val kinds = setOf("Text", "Image", "Icon", "Row", "Column", "List", "Card", "Tabs", "Divider", "Button", "CheckBox", "ChoicePicker", "Switch",
        "Stack", "Grid", "Spacer", "ProgressBar", "Badge", "Clock", "Timer")

    /** The core's resolved components (an "a2ui" in the pushed state) as a tree, with Android's nesting budget checked. */
    fun parse(a2ui: JSONObject): CardRender {
        val list = a2ui.optJSONArray("components") ?: throw CardProblem("卡片没有组件")
        val byId = HashMap<String, JSONObject>()
        for (i in 0 until list.length()) list.optJSONObject(i)?.let { byId[it.optString("id")] = it }
        val built = HashMap<String, CNode>()
        fun node(id: String, path: List<String>): CNode {
            if (id in path) throw CardProblem("组件「$id」包含了它自己")
            built[id]?.let { return it }
            val c = byId[id] ?: throw CardProblem("缺少组件「$id」")
            val kind = c.optString("component")
            if (kind !in kinds) throw CardProblem("手机画不了「$kind」组件（$id）")
            val next = path + id
            fun ids(key: String) = c.optJSONArray(key)?.let { a -> (0 until a.length()).map { node(a.getString(it), next) } } ?: emptyList()
            val n = CNode(
                id = id, kind = kind, style = style(c.optJSONObject("style")), weight = c.optDouble("weight", 0.0).toFloat(),
                action = action(c.optJSONObject("action")), visible = c.optBoolean("visible", true), disabled = c.optBoolean("disabled"),
                a11y = c.optString("a11y").ifEmpty { null }, item = if (c.has("item")) c.optString("item") else null, bound = c.has("bind"),
                children = ids("children"), child = c.optString("child").ifEmpty { null }?.let { node(it, next) },
                tabs = c.optJSONArray("tabs")?.let { a -> (0 until a.length()).map { a.getJSONObject(it).let { t -> CTab(t.optString("title"), node(t.getString("child"), next)) } } } ?: emptyList(),
                selected = c.optInt("selected"), justify = c.optString("justify").ifEmpty { null }, align = c.optString("align").ifEmpty { null },
                columns = c.optInt("columns", 1).coerceIn(1, 12), text = c.optString("text"), variant = c.optString("variant").ifEmpty { null },
                url = c.optString("url").ifEmpty { null }, fit = c.optString("fit").ifEmpty { null }, name = c.optString("name").ifEmpty { null },
                svgPath = c.optString("svgPath").ifEmpty { null }, axis = c.optString("axis", "horizontal"), checked = c.optBoolean("checked"),
                label = if (c.has("label")) c.optString("label") else null,
                options = c.optJSONArray("options")?.let { a -> (0 until a.length()).map { a.getJSONObject(it).let { o -> COption(o.optString("label"), o.optString("value"), o.optBoolean("checked")) } } } ?: emptyList(),
                multiple = c.optBoolean("multiple"), chips = c.optBoolean("chips"), value = c.optDouble("value", 0.0), max = c.optDouble("max", 100.0),
                size = if (c.has("size")) c.optDouble("size").toFloat() else null, format = c.optString("format").ifEmpty { null },
                timeZone = c.optString("timeZone").ifEmpty { null }, since = if (c.has("since")) c.optLong("since") else null,
                until = if (c.has("until")) c.optLong("until") else null)
            built[id] = n
            return n
        }
        val root = node(a2ui.optString("root", "root"), emptyList())
        val sizes = a2ui.optJSONArray("sizes")?.let { a ->
            (0 until a.length()).map { a.getJSONObject(it).let { s -> CSize(s.optDouble("width").toFloat(), s.optDouble("height").toFloat(), node(s.getString("root"), emptyList())) } }
        } ?: emptyList()
        val budget = if (sizes.isEmpty()) LEVELS else LEVELS_WITH_SIZES
        for (r in listOf(root) + sizes.map { it.root }) {
            val n = levels(r)
            if (n > budget) throw CardProblem("这张卡片嵌套了 $n 层，安卓小组件最多 $budget 层（${deepest(r).joinToString(" > ")}）")
            checkLists(r)
            fun count(n: CNode): Int = (if (n.kind == "List") 1 else 0) + n.inner.sumOf { count(it) }
            if (count(r) > LISTS) throw CardProblem("这张卡片有 ${count(r)} 个滚动列表，安卓小组件最多 $LISTS 个")
        }
        return CardRender(root, sizes, a2ui.optJSONObject("theme")?.opt("accent")?.let { tint(it) })
    }

    private fun checkLists(n: CNode, list: String? = null) {
        if (n.kind == "List") {
            if (list != null) throw CardProblem("列表「${n.defId}」在另一个列表「$list」的一项里，安卓小组件不能在列表里再滚动列表")
            for (item in n.children) {
                val l = levels(item)
                if (l > ITEM_LEVELS) throw CardProblem("列表「${n.defId}」的一项嵌套了 $l 层，安卓最多 $ITEM_LEVELS 层")
                checkLists(item, n.defId)
            }
            return
        }
        for (k in n.inner) checkLists(k, list)
    }

    /**
     * Nested RemoteViews a component needs, counted exactly as [CardPlan] builds it (and as the core counts):
     * itself, plus a slot for a weighted child of a Row/Column (or every child when it justifies "stretch") and for a
     * placed child of a Stack, and a Grid's rows and cells. A List counts once: its items are RemoteViews of their own.
     */
    fun levels(n: CNode): Int = when (n.kind) {
        "Row", "Column" -> 1 + (n.children.maxOfOrNull { levels(it) + if (CardPlan.slotted(n, it)) 1 else 0 } ?: 0)
        "Stack" -> 1 + (n.children.maxOfOrNull { levels(it) + if (CardPlan.place(n, it) != "topStart") 1 else 0 } ?: 0)
        "Grid" -> 3 + (n.children.maxOfOrNull { levels(it) } ?: 0)
        "Card", "Button" -> 1 + (n.child?.let { levels(it) } ?: 0)
        "Tabs" -> 1 + maxOf(2, n.tabs.maxOfOrNull { levels(it.child) } ?: 0)
        "ChoicePicker" -> 2
        else -> 1
    }

    private fun deepest(n: CNode): List<String> {
        val kids = if (n.kind == "List") emptyList() else n.inner
        return listOf(n.defId) + (kids.map { deepest(it) }.maxByOrNull { it.size } ?: emptyList())
    }
}
