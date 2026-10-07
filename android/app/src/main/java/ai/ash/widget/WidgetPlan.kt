package ai.ash.widget

import org.json.JSONArray
import org.json.JSONObject

/** How a card's text is drawn: A2UI h1 is a big number, h2/h3 a title, caption secondary, anything else body. */
enum class TextStyle { NUMBER, TITLE, BODY, CAPTION }

/** One drawable piece of a card; the Android side turns it into RemoteViews without further decisions. */
sealed class WNode {
    data class Box(val vertical: Boolean, val center: Boolean, val spread: Boolean, val children: List<WNode>) : WNode()
    data class Text(val text: String, val style: TextStyle) : WNode()
    data class Icon(val glyph: String) : WNode()
    object Avatar : WNode()
    data class Button(val label: String, val action: String) : WNode()
    object Divider : WNode()
    data class Progress(val value: Int, val label: String) : WNode()
    data class Badge(val text: String) : WNode()
}

data class WCard(val id: String, val title: String, val size: String, val owner: String, val expiresAt: Long?, val root: WNode?)
data class WState(val revision: Long, val cards: Map<String, WCard>, val bindings: Map<String, String>)

/** What one "Ash 卡片" widget shows. */
sealed class CardView {
    object Unbound : CardView()
    data class Expired(val card: WCard) : CardView()
    data class Show(val card: WCard, val root: WNode) : CardView()
}

/**
 * The phone's half of the card format: the core already checked the A2UI subset and resolved data bindings; this maps
 * the pushed component list to a render plan, re-checking the limits so a bad state can never draw something else.
 */
object WidgetPlan {
    const val MAX_LEVELS = 3
    const val MAX_BUTTONS = 2
    const val MAX_COMPONENTS = 40

    private val glyphs = mapOf(
        "sun" to "☀️", "cloud" to "☁️", "rain" to "🌧️", "snow" to "❄️", "wind" to "🌬️", "moon" to "🌙", "heart" to "❤️",
        "steps" to "👣", "weight" to "⚖️", "sleep" to "😴", "water" to "💧", "fire" to "🔥", "calendar" to "📅", "clock" to "⏰",
        "check" to "✅", "alert" to "⚠️", "star" to "⭐", "bell" to "🔔", "mail" to "✉️", "home" to "🏠", "car" to "🚗",
        "money" to "💰", "chart" to "📈")

    fun glyph(name: String): String? = glyphs[name]

    fun parseState(b: JSONObject): WState {
        val cards = LinkedHashMap<String, WCard>()
        val list = b.optJSONArray("cards") ?: JSONArray()
        for (i in 0 until minOf(list.length(), 100)) {
            val c = list.optJSONObject(i) ?: continue
            val id = c.optString("id")
            if (id.isBlank()) continue
            val root = runCatching { plan(c.getJSONObject("a2ui")) }.getOrNull()
            cards[id] = WCard(id, c.optString("title").take(40), c.optString("size", "4x2"), c.optString("owner"),
                if (c.isNull("expires_at") || !c.has("expires_at")) null else c.optLong("expires_at"), root)
        }
        val bindings = LinkedHashMap<String, String>()
        b.optJSONObject("bindings")?.let { o -> o.keys().forEach { k -> o.optString(k).takeIf { it.isNotBlank() }?.let { bindings[k] = it } } }
        return WState(b.optLong("revision"), cards, bindings)
    }

    /** The bound card wins over the one picked on the phone only when the core knows a binding for this widget. */
    fun view(state: WState?, widgetId: Int, localCard: String?, now: Long): CardView {
        val cardId = state?.bindings?.get(widgetId.toString()) ?: localCard ?: return CardView.Unbound
        val card = state?.cards?.get(cardId) ?: return CardView.Unbound
        if (card.expiresAt != null && card.expiresAt <= now) return CardView.Expired(card)
        val root = card.root ?: return CardView.Unbound
        return CardView.Show(card, root)
    }

    fun plan(a2ui: JSONObject): WNode {
        val list = a2ui.getJSONArray("components")
        require(list.length() in 1..MAX_COMPONENTS)
        val byId = HashMap<String, JSONObject>()
        for (i in 0 until list.length()) list.getJSONObject(i).let { byId[it.getString("id")] = it }
        val used = HashSet<String>()
        var buttons = 0
        fun text(c: JSONObject, max: Int) = c.optString("text").replace(Regex("[\\p{Cc}&&[^\\n]]"), " ").take(max)
        fun node(id: String, levels: Int): WNode {
            require(used.add(id)) { "component $id used twice" }
            val c = byId[id] ?: throw IllegalArgumentException("missing $id")
            return when (val kind = c.getString("component")) {
                "Column", "Row" -> {
                    require(levels + 1 <= MAX_LEVELS) { "too deep" }
                    val kids = c.optJSONArray("children") ?: JSONArray()
                    Box(kind == "Column", c.optString("align") == "center" || c.optString("justify") == "center",
                        c.optString("justify") in setOf("spaceBetween", "spaceAround", "spaceEvenly", "stretch"),
                        (0 until kids.length()).map { node(kids.getString(it), levels + 1) })
                }
                "Text" -> WNode.Text(text(c, 300), when (c.optString("variant")) {
                    "h1" -> TextStyle.NUMBER; "h2", "h3" -> TextStyle.TITLE; "caption" -> TextStyle.CAPTION; else -> TextStyle.BODY })
                "Image" -> {
                    val url = c.optString("url")
                    if (url == "avatar") WNode.Avatar
                    else WNode.Icon(glyph(url.removePrefix("icon:")).takeIf { url.startsWith("icon:") } ?: throw IllegalArgumentException("unknown image"))
                }
                "Button" -> {
                    require(++buttons <= MAX_BUTTONS) { "too many buttons" }
                    val labelId = c.getString("child")
                    val label = byId[labelId] ?: throw IllegalArgumentException("missing label")
                    used.add(labelId)
                    val action = c.getJSONObject("action").getJSONObject("event").getString("name")
                    require(Regex("[A-Za-z0-9_.:-]{1,64}").matches(action))
                    WNode.Button(text(label, 20), action)
                }
                "Divider" -> WNode.Divider
                "ProgressBar" -> WNode.Progress(c.optInt("value").coerceIn(0, 100), c.optString("label").take(40))
                "Badge" -> WNode.Badge(text(c, 8))
                else -> throw IllegalArgumentException("unsupported $kind")
            }
        }
        return node(a2ui.optString("root", "root"), 0)
    }

    /** Button actions in drawing order, for the owner's taps. */
    fun actions(node: WNode): List<WNode.Button> = when (node) {
        is WNode.Box -> node.children.flatMap { actions(it) }
        is WNode.Button -> listOf(node)
        else -> emptyList()
    }
}

private typealias Box = WNode.Box
