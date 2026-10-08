package ai.ash.widget

import org.json.JSONArray
import org.json.JSONObject

/** One card from the core; [render] is null and [problem] says why when the phone cannot draw it. */
data class WCard(val id: String, val title: String, val size: String, val owner: String, val updatedAt: Long, val expiresAt: Long?,
    val render: CardRender?, val problem: String? = null)
/** [previews]: cards the core wants a preview picture of, each with the request number to echo back (older cores send none). */
data class WState(val revision: Long, val cards: Map<String, WCard>, val bindings: Map<String, String>, val previews: Map<String, Long> = emptyMap())

/** What one "Ash 卡片" widget shows. */
sealed class CardView {
    object Unbound : CardView()
    data class Expired(val card: WCard) : CardView()
    data class Broken(val card: WCard, val problem: String) : CardView()
    data class Show(val card: WCard, val render: CardRender) : CardView()
}

/** The phone's half of service:widgets: the pushed state, which card each widget shows, and the frame around it. */
object WidgetPlan {
    /** Roughly what a launcher gives each widget size, in dp (portrait), for checking a card before it is placed. */
    fun nominal(size: String): Pair<Float, Float> = when (size) { "2x2" -> 150f to 150f; "4x4" -> 330f to 330f; else -> 330f to 150f }

    fun parseState(b: JSONObject): WState {
        val cards = LinkedHashMap<String, WCard>()
        val list = b.optJSONArray("cards") ?: JSONArray()
        for (i in 0 until minOf(list.length(), 200)) {
            val c = list.optJSONObject(i) ?: continue
            val id = c.optString("id")
            if (id.isBlank()) continue
            var problem: String? = null
            val render = try { CardSpec.parse(c.getJSONObject("a2ui")) }
                catch (e: CardProblem) { problem = e.message; null }
                catch (e: Exception) { problem = "卡片格式手机读不懂（${e.message ?: e.javaClass.simpleName}）"; null }
            cards[id] = WCard(id, c.optString("title").take(40), c.optString("size", "4x2"), c.optString("owner"), c.optLong("updated_at"),
                if (c.isNull("expires_at") || !c.has("expires_at")) null else c.optLong("expires_at"), render, problem)
        }
        val bindings = LinkedHashMap<String, String>()
        b.optJSONObject("bindings")?.let { o -> o.keys().forEach { k -> o.optString(k).takeIf { it.isNotBlank() }?.let { bindings[k] = it } } }
        val previews = LinkedHashMap<String, Long>()
        b.optJSONObject("previews")?.let { o -> o.keys().forEach { k -> if (o.optLong(k, -1L) >= 0L) previews[k] = o.optLong(k) } }
        return WState(b.optLong("revision"), cards, bindings, previews)
    }

    /** The bound card wins over the one picked on the phone only when the core knows a binding for this widget. */
    fun view(state: WState?, widgetId: Int, localCard: String?, now: Long): CardView {
        val cardId = state?.bindings?.get(widgetId.toString()) ?: localCard ?: return CardView.Unbound
        val card = state?.cards?.get(cardId) ?: return CardView.Unbound
        if (card.expiresAt != null && card.expiresAt <= now) return CardView.Expired(card)
        val render = card.render ?: return CardView.Broken(card, card.problem ?: "卡片内容缺失")
        return CardView.Show(card, render)
    }

    /**
     * True when the card's content already opens with its title (the usual A2UI card starts with a title Text), so the
     * widget frame does not print the same words again above it. Leading icons, images and badges are looked past.
     */
    fun opensWithTitle(root: CNode, title: String): Boolean {
        val want = title.trim()
        if (want.isEmpty()) return false
        fun first(n: CNode): String? = when (n.kind) {
            "Text" -> Markdown.parse(n.text).text
            "Row", "Column", "Stack", "Card" -> n.inner.firstOrNull { it.kind !in setOf("Icon", "Image", "Badge") }?.let { first(it) }
            else -> null
        }
        return first(root)?.trim()?.startsWith(want, ignoreCase = true) == true
    }

    /** The layout for a widget of [width] x [height] dp: the largest per-size layout that fits, else the smallest. */
    fun pick(render: CardRender, width: Float, height: Float): CNode {
        if (render.sizes.isEmpty()) return render.root
        val fits = render.sizes.filter { it.width <= width + 0.5f && it.height <= height + 0.5f }
        return (fits.maxByOrNull { it.width * it.height } ?: render.sizes.minByOrNull { it.width * it.height })!!.root
    }

    /** Find a component (a template copy, a per-size copy) anywhere in the card. */
    fun find(render: CardRender, id: String): CNode? {
        fun walk(n: CNode): CNode? = if (n.id == id) n else n.inner.firstNotNullOfOrNull { walk(it) }
        return (listOf(render.root) + render.sizes.map { it.root }).firstNotNullOfOrNull { walk(it) }
    }
}
