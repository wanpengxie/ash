package ai.ash.widget

import kotlin.math.roundToInt

/** The prebuilt layouts a card is assembled from (res/layout/w_*.xml); each one's root view is R.id.w_self. */
enum class Lay {
    COL, ROW, STACK, PLACE, SLOT_H, SLOT_V, GAP_H, GAP_V, SPACE,
    TEXT, TEXT_START, TEXT_MIDDLE, TEXT_CLIP, ICON, BADGE, CHIP,
    IMAGE_CONTAIN, IMAGE_COVER, IMAGE_FILL, IMAGE_NONE, IMAGE_SCALEDOWN,
    BUTTON, BUTTON_PRIMARY, BUTTON_BORDERLESS, CARD, CHECK, SWITCH, RADIO, PROGRESS, DIV_H, DIV_V, LIST, GRID, CLOCK, CHRONO,
}

/** What a tap on an element does. [component] is the element's id in the card. */
sealed class Tap {
    abstract val component: String
    /** Tell the card's creator (widget.action). */
    data class Send(override val component: String) : Tap()
    /** A CheckBox/Switch, currently [checked]. */
    data class Toggle(override val component: String, val checked: Boolean) : Tap()
    /** One option of a ChoicePicker. */
    data class Choose(override val component: String, val value: String) : Tap()
    /** Show tab [index] (on the phone only). */
    data class Tab(override val component: String, val index: Int) : Tap()
    /** Open an app surface, Ash or a link. */
    data class Open(override val component: String, val target: CAction) : Tap()
}

/** An image's source: Ash's face, a fetched or embedded picture, or an icon path drawn on the phone. */
sealed class Img {
    data class Avatar(val name: String) : Img()
    data class Url(val url: String) : Img()
    data class Path(val d: String, val tint: Tint) : Img()
}

/** One RemoteViews to build: a layout and what to set on its root. */
data class VNode(
    val lay: Lay, val id: String,
    val children: List<VNode> = emptyList(),
    /** A List's items, each a RemoteViews of its own. */
    val items: List<VNode>? = null,
    val width: Dim = Dim.Wrap, val height: Dim = Dim.Wrap, val weight: Int = 0,
    val gravity: Int? = null, val padding: FloatArray? = null, val margin: FloatArray? = null,
    val bg: Tint? = null, val radius: Float? = null, val alpha: Float? = null, val visible: Boolean = true, val a11y: String? = null,
    val text: Styled? = null, val textSize: Float? = null, val textColor: Tint? = null, val maxLines: Int? = null,
    val lineHeight: Float? = null, val letterSpacing: Float? = null, val justifyText: Boolean = false,
    val tap: Tap? = null, val checked: Boolean? = null, val tint: Tint? = null, val image: Img? = null,
    val progress: Pair<Int, Int>? = null, val columns: Int = 1, val minSize: Float? = null,
    val clockFormat: String? = null, val timeZone: String? = null, val chronoSince: Long? = null, val countDown: Boolean = false,
) {
    override fun equals(other: Any?) = other is VNode && toString() == other.toString()
    override fun hashCode() = toString().hashCode()

    /** Every node, depth first (a List's items too). */
    fun walk(): Sequence<VNode> = sequence { yield(this@VNode); for (c in children) yieldAll(c.walk()); items?.forEach { yieldAll(it.walk()) } }
    /** Nested RemoteViews below and including this one (a List's items not counted: they start afresh). */
    val depth: Int get() = 1 + (children.maxOfOrNull { it.depth } ?: 0)
    /** The same, with every List drawn as plain rows ([CardPlan.plain]). */
    val plainDepth: Int get() = 1 + maxOf(children.maxOfOrNull { it.plainDepth } ?: 0,
        items?.let { (if (lay == Lay.GRID) 2 else 0) + (it.maxOfOrNull { i -> i.plainDepth } ?: 0) } ?: 0)
}

/** What the owner changed on the phone and the core has not drawn back yet: toggles, choices and tabs. */
data class Local(val checked: Map<String, Boolean> = emptyMap(), val chosen: Map<String, List<String>> = emptyMap(), val tabs: Map<String, Int> = emptyMap())

/** The widget frame around a card: whether it draws its own title and background. */
data class Frame(val title: Boolean, val ownBackground: Boolean, val titleColor: Tint?)

/**
 * The card tree as RemoteViews to build, with every Android decision made here (pure, unit-tested): which prebuilt
 * layout, how wide and high, which gravity, which slot or gap, what a tap does. CardViews only executes it.
 */
object CardPlan {
    // android.view.Gravity values (kept here so the plan stays plain Kotlin).
    const val START = 0x00800003; const val END = 0x00800005; const val CENTER_H = 0x01; const val CENTER_V = 0x10
    const val TOP = 0x30; const val BOTTOM = 0x50; const val CENTER = 0x11

    /** Default text per A2UI variant: size (sp), weight, secondary colour. */
    private data class TextLook(val size: Float, val weight: Int, val secondary: Boolean)
    private val looks = mapOf("h1" to TextLook(30f, 700, false), "h2" to TextLook(17f, 700, false), "h3" to TextLook(15f, 700, false),
        "h4" to TextLook(14f, 700, false), "h5" to TextLook(13f, 700, false), "body" to TextLook(13f, 400, false), "caption" to TextLook(12f, 400, true))

    /** A child of a Row/Column sits in a weighted slot when it has a weight, or when the parent stretches all children. */
    fun slotted(parent: CNode, child: CNode): Boolean = child.weight > 0f || parent.justify == "stretch"

    /** A child of a Stack sits in a placing slot unless it stays at the top start corner. */
    fun place(stack: CNode, child: CNode): String = child.style.place ?: stack.align ?: "topStart"

    private val PLACES = mapOf("topStart" to (TOP or START), "top" to (TOP or CENTER_H), "topEnd" to (TOP or END), "start" to (CENTER_V or START),
        "center" to CENTER, "end" to (CENTER_V or END), "bottomStart" to (BOTTOM or START), "bottom" to (BOTTOM or CENTER_H), "bottomEnd" to (BOTTOM or END))

    /**
     * A List as plain rows (a Column of its items, or rows of cells for columns): what a widget draws most reliably,
     * used while the rows fit; a List that does not fit is drawn as a real scrolling list instead.
     */
    fun plain(list: VNode): VNode {
        val items = list.items ?: return list
        val children = if (list.lay != Lay.GRID) items else items.chunked(list.columns).mapIndexed { r, cells ->
            VNode(Lay.ROW, "${list.id}~row$r", width = Dim.Fill, gravity = TOP or START,
                children = cells.map { VNode(Lay.SLOT_H, "${it.id}~cell", children = listOf(it), weight = 1, width = Dim.Dp(0f)) } +
                    List(list.columns - cells.size) { VNode(Lay.SLOT_H, "${list.id}~empty$r$it", weight = 1, width = Dim.Dp(0f)) })
        }
        return list.copy(lay = Lay.COL, items = null, children = children, gravity = TOP or START)
    }

    fun frame(root: CNode, title: String, opensWithTitle: Boolean): Frame {
        val own = root.style.background != null
        return Frame(title = !own && title.isNotBlank() && !opensWithTitle, ownBackground = own, titleColor = root.style.color)
    }

    private data class Inherit(val color: Tint?, val italic: Boolean?, val textAlign: String?)
    private data class Ctx(val parent: String, val align: String?, val inherit: Inherit, val api31: Boolean, val accent: Tint, val local: Local)

    /** The whole card, its root filling the widget. */
    fun plan(render: CardRender, root: CNode = render.root, local: Local = Local(), api31: Boolean = true): VNode {
        val accent = render.accent ?: CardSpec.colors.getValue("accent")
        val ctx = Ctx("Root", null, Inherit(null, null, null), api31, accent, local)
        var v = node(root, ctx)
        if (root.style.background != null)
            v = v.copy(padding = v.padding ?: floatArrayOf(14f, 14f, 14f, 14f), radius = v.radius ?: 22f)
        return v
    }

    /** One List item (or a whole card shown as a scrolling list): full width, its own height. */
    fun item(render: CardRender, item: CNode, local: Local = Local(), api31: Boolean = true): VNode =
        node(item, Ctx("Item", null, Inherit(null, null, null), api31, render.accent ?: CardSpec.colors.getValue("accent"), local))

    private val stretchy = setOf("Row", "Column", "Stack", "Grid", "Card", "List", "Tabs", "ChoicePicker", "Divider", "ProgressBar", "Text", "Clock", "Timer")
    private val fullWidth = setOf("Divider", "ProgressBar", "List")
    private fun feature(n: CNode) = n.kind == "Image" && n.variant in setOf("header", "mediumFeature", "largeFeature")

    private fun width(n: CNode, ctx: Ctx): Dim = n.style.width ?: when (ctx.parent) {
        "Root", "Item", "SlotH", "GridCell" -> Dim.Fill
        "Row", "Button", "Place", "Stack" -> if (n.kind == "Divider" && n.axis == "horizontal" && ctx.parent != "Row") Dim.Fill else Dim.Wrap
        else -> { // Column, SlotV, Card, Tabs: A2UI's align (default stretch) across the column.
            val align = ctx.align ?: "stretch"
            if (align == "stretch" && (n.kind in stretchy || feature(n)) || n.kind in fullWidth || feature(n)) Dim.Fill else Dim.Wrap
        }
    }

    private fun height(n: CNode, ctx: Ctx): Dim = n.style.height ?: when (ctx.parent) {
        "Root" -> Dim.Fill
        "SlotV" -> Dim.Fill
        "Row", "SlotH" -> if ((ctx.align ?: "center") == "stretch" || n.kind == "Divider") Dim.Fill else Dim.Wrap
        else -> Dim.Wrap
    }

    /** The common part: size, box, background, visibility, tap. */
    private fun base(lay: Lay, n: CNode, ctx: Ctx, id: String = n.id): VNode {
        val s = n.style
        val tap = if (n.disabled) null else n.action?.let { if (it is CAction.Event) Tap.Send(n.id) else Tap.Open(n.id, it) }
        return VNode(lay, id, width = width(n, ctx), height = height(n, ctx), padding = s.padding, margin = s.margin, bg = s.background,
            radius = s.cornerRadius, alpha = if (n.disabled) (s.opacity ?: 1f) * 0.4f else s.opacity, visible = n.visible, a11y = n.a11y, tap = tap)
    }

    private fun styled(raw: String, n: CNode, look: TextLook, inherit: Inherit): Styled {
        var t = Markdown.parse(raw)
        val weight = n.style.fontWeight ?: look.weight
        when {
            weight >= 600 -> t = t.whole(Mark.BOLD)
            weight == 500 -> t = t.whole(Mark.MEDIUM)
            weight <= 300 -> t = t.whole(Mark.LIGHT)
        }
        if (n.style.italic ?: inherit.italic == true) t = t.whole(Mark.ITALIC)
        if (n.style.underline) t = t.whole(Mark.UNDERLINE)
        if (n.style.strikethrough) t = t.whole(Mark.STRIKE)
        return t
    }

    /** Text settings shared by Text, Badge, labels, clocks: size, colour, alignment, lines. */
    private fun texty(v: VNode, n: CNode, ctx: Ctx, raw: String?, variant: String? = n.variant, defaultColor: Tint? = null): VNode {
        val look = looks[variant ?: "body"] ?: looks.getValue("body")
        val inherited = ctx.inherit.color?.let { if (look.secondary) it.withAlpha(0.7f) else it }
        val color = n.style.color ?: inherited ?: defaultColor ?: CardSpec.colors.getValue(if (look.secondary) "textSecondary" else "text")
        val align = n.style.textAlign ?: ctx.inherit.textAlign
        val g = when (align) { "center" -> CENTER_H or CENTER_V; "end" -> END or CENTER_V; else -> null }
        return v.copy(text = raw?.let { styled(it, n, look, ctx.inherit) }, textSize = n.style.fontSize ?: look.size, textColor = color,
            gravity = g ?: v.gravity, justifyText = align == "justify", maxLines = n.style.maxLines, lineHeight = n.style.lineHeight,
            letterSpacing = n.style.letterSpacing)
    }

    private fun textLay(n: CNode) = when (n.style.ellipsize) { "start" -> Lay.TEXT_START; "middle" -> Lay.TEXT_MIDDLE; "none" -> Lay.TEXT_CLIP; else -> Lay.TEXT }

    private fun inheritFrom(n: CNode, ctx: Ctx) = Inherit(n.style.color ?: ctx.inherit.color, n.style.italic ?: ctx.inherit.italic, n.style.textAlign ?: ctx.inherit.textAlign)

    private fun node(n: CNode, ctx: Ctx): VNode = when (n.kind) {
        "Text" -> texty(base(textLay(n), n, ctx), n, ctx, n.text)
        "Badge" -> texty(base(Lay.BADGE, n, ctx), n, ctx, n.text, "caption", defaultColor = ctx.accent)
        "Clock" -> texty(base(Lay.CLOCK, n, ctx), n, ctx, null).copy(clockFormat = n.format, timeZone = n.timeZone)
        "Timer" -> texty(base(Lay.CHRONO, n, ctx), n, ctx, null).copy(chronoSince = n.since ?: n.until, countDown = n.until != null)
        "Icon" -> icon(n, ctx)
        "Image" -> image(n, ctx)
        "Row", "Column" -> box(n, ctx)
        "Stack" -> stack(n, ctx)
        "Grid" -> grid(n, ctx)
        "Card" -> {
            val inner = Ctx("Card", "stretch", inheritFrom(n, ctx), ctx.api31, ctx.accent, ctx.local)
            base(Lay.CARD, n, ctx).let { it.copy(children = listOfNotNull(n.child?.let { c -> node(c, inner) }),
                bg = it.bg ?: CardSpec.colors.getValue("surfaceVariant"), radius = it.radius ?: 16f, padding = it.padding ?: floatArrayOf(12f, 12f, 12f, 12f)) }
        }
        "Button" -> {
            val lay = when (n.variant) { "primary" -> Lay.BUTTON_PRIMARY; "borderless" -> Lay.BUTTON_BORDERLESS; else -> Lay.BUTTON }
            val onAccent = if (lay == Lay.BUTTON_PRIMARY && n.style.color == null) CardSpec.colors.getValue("onAccent") else null
            val inner = Ctx("Button", null, inheritFrom(n, ctx).let { if (onAccent != null) it.copy(color = onAccent) else it }, ctx.api31, ctx.accent, ctx.local)
            val v = base(lay, n, ctx)
            v.copy(children = listOfNotNull(n.child?.let { node(it, inner) }), gravity = CENTER,
                bg = v.bg ?: if (lay == Lay.BUTTON_PRIMARY) ctx.accent else null)
        }
        "CheckBox", "Switch" -> {
            val checked = ctx.local.checked[n.id] ?: n.checked
            val tap = if (n.disabled) null else Tap.Toggle(n.id, checked)
            if (ctx.api31) texty(base(if (n.kind == "Switch") Lay.SWITCH else Lay.CHECK, n, ctx), n, ctx, n.label ?: "")
                .copy(checked = checked, tap = tap, tint = n.style.color ?: ctx.accent)
            else texty(base(Lay.TEXT, n, ctx), n, ctx, (if (n.kind == "Switch") (if (checked) "● " else "○ ") else (if (checked) "☑ " else "☐ ")) + (n.label ?: ""))
                .copy(tap = tap)
        }
        "ChoicePicker" -> choice(n, ctx)
        "Tabs" -> tabs(n, ctx)
        "Divider" -> base(if (n.axis == "vertical") Lay.DIV_V else Lay.DIV_H, n, ctx).let {
            it.copy(bg = n.style.color ?: it.bg ?: CardSpec.colors.getValue("line"), height = if (n.axis == "vertical") it.height else n.style.height ?: Dim.Wrap)
        }
        "ProgressBar" -> {
            val scale = if (n.max > 0) (n.value / n.max * 1000).roundToInt().coerceIn(0, 1000) else 0
            texty(base(Lay.PROGRESS, n, ctx), n, ctx, n.label ?: "", "caption").copy(progress = scale to 1000, tint = n.style.color ?: ctx.accent)
        }
        "Spacer" -> {
            val size = n.size
            when {
                size != null -> base(Lay.SPACE, n, ctx).copy(minSize = size, width = Dim.Wrap, height = Dim.Wrap)
                ctx.parent == "Row" -> base(Lay.GAP_H, n, ctx).copy(weight = 1, width = Dim.Dp(0f))
                ctx.parent == "Column" -> base(Lay.GAP_V, n, ctx).copy(weight = 1, height = Dim.Dp(0f))
                else -> base(Lay.SPACE, n, ctx).copy(minSize = 0f)
            }
        }
        "List" -> {
            val v = base(if (n.columns > 1) Lay.GRID else Lay.LIST, n, ctx)
            v.copy(items = n.children.map { node(it, Ctx("Item", n.align, inheritFrom(n, ctx), ctx.api31, ctx.accent, ctx.local)) },
                columns = n.columns, height = n.style.height ?: if (ctx.parent == "Root") Dim.Fill else v.height)
        }
        else -> throw CardProblem("手机画不了「${n.kind}」组件（${n.defId}）")
    }

    private fun icon(n: CNode, ctx: Ctx): VNode {
        val color = n.style.color ?: ctx.inherit.color ?: CardSpec.colors.getValue("text")
        val size = n.style.fontSize ?: 22f
        if (n.svgPath != null) return base(Lay.IMAGE_CONTAIN, n, ctx).let {
            it.copy(image = Img.Path(n.svgPath, color), width = n.style.width ?: Dim.Dp(size), height = n.style.height ?: Dim.Dp(size))
        }
        val glyph = CardSpec.glyph(n.name ?: "") ?: throw CardProblem("没有叫「${n.name}」的图标")
        return base(Lay.ICON, n, ctx).copy(text = Styled(glyph), textSize = size, textColor = color)
    }

    private fun image(n: CNode, ctx: Ctx): VNode {
        val url = n.url ?: ""
        // An icon given as an image is drawn as the same glyph as Icon.
        if (url.startsWith("icon:")) return icon(n.copy(name = url.removePrefix("icon:")), ctx).let { if (n.style.fontSize == null) it.copy(textSize = 22f) else it }
        val avatar = url == "avatar" || url.startsWith("avatar:")
        val variant = n.variant ?: if (avatar) "avatar" else "mediumFeature"
        val fit = n.fit ?: if (variant in setOf("header", "mediumFeature", "largeFeature")) "cover" else "contain"
        val lay = when (fit) { "cover" -> Lay.IMAGE_COVER; "fill" -> Lay.IMAGE_FILL; "none" -> Lay.IMAGE_NONE; "scaleDown" -> Lay.IMAGE_SCALEDOWN; else -> Lay.IMAGE_CONTAIN }
        val (w, h) = when (variant) {
            "icon" -> Dim.Dp(24f) to Dim.Dp(24f)
            "avatar" -> Dim.Dp(if (n.variant == null) 36f else 40f) to Dim.Dp(if (n.variant == null) 36f else 40f)
            "smallFeature" -> Dim.Dp(64f) to Dim.Dp(64f)
            "largeFeature" -> Dim.Fill to Dim.Dp(180f)
            "header" -> Dim.Fill to Dim.Dp(100f)
            else -> Dim.Fill to Dim.Dp(120f)
        }
        val v = base(lay, n, ctx)
        val img = if (avatar) Img.Avatar(url.substringAfter(':', "default").takeIf { url.contains(':') } ?: "default") else Img.Url(url)
        return v.copy(image = img, width = n.style.width ?: (if (ctx.parent == "Row" && w == Dim.Fill) Dim.Dp(120f) else w), height = n.style.height ?: h,
            radius = v.radius ?: if (variant == "avatar") 999f else null, tint = null)
    }

    private fun box(n: CNode, ctx: Ctx): VNode {
        val column = n.kind == "Column"
        val align = n.align
        val justify = n.justify ?: "start"
        val cross = when (align) { "center" -> if (column) CENTER_H else CENTER_V; "end" -> if (column) END else BOTTOM
            "start", "stretch" -> if (column) START else TOP; else -> if (column) START else CENTER_V }
        val main = when (justify) { "center" -> if (column) CENTER_V else CENTER_H; "end" -> if (column) BOTTOM else END; else -> if (column) TOP else START }
        val inherit = inheritFrom(n, ctx)
        val childCtx = Ctx(if (column) "Column" else "Row", align, inherit, ctx.api31, ctx.accent, ctx.local)
        val slotCtx = Ctx(if (column) "SlotV" else "SlotH", align, inherit, ctx.api31, ctx.accent, ctx.local)
        // Weights become integer layout weights 1..12 relative to the largest one in this box.
        val maxWeight = n.children.maxOfOrNull { if (slotted(n, it)) (if (it.weight > 0) it.weight else 1f) else 0f } ?: 0f
        val planned = n.children.map { child ->
            if (!slotted(n, child)) node(child, childCtx)
            else {
                val w = ((if (child.weight > 0) child.weight else 1f) / maxWeight * 12).roundToInt().coerceIn(1, 12)
                val inner = node(child, slotCtx)
                VNode(if (column) Lay.SLOT_V else Lay.SLOT_H, "${child.id}~slot", children = listOf(inner), weight = w,
                    width = if (column) Dim.Fill else Dim.Dp(0f), height = if (column) Dim.Dp(0f) else inner.height.takeIf { it == Dim.Fill } ?: Dim.Wrap,
                    visible = child.visible)
            }
        }
        val gap = { w: Int -> if (column) VNode(Lay.GAP_V, "gap", weight = w, width = Dim.Dp(1f), height = Dim.Dp(0f)) else VNode(Lay.GAP_H, "gap", weight = w, width = Dim.Dp(0f), height = Dim.Dp(1f)) }
        val children = when (justify) {
            "spaceBetween", "spaceAround", "spaceEvenly" -> buildList {
                val between = if (justify == "spaceAround") 2 else 1
                if (justify != "spaceBetween") add(gap(1))
                planned.forEachIndexed { i, child ->
                    add(child)
                    // In a spread Row an icon keeps to what follows it ("☁️ 霾 ……… 19℃", not three islands).
                    val sticky = !column && justify == "spaceBetween" && n.children[i].let { it.kind == "Icon" || it.kind == "Image" && (it.url?.startsWith("icon:") == true || it.url?.startsWith("avatar") == true) }
                    if (i < planned.lastIndex && !sticky) add(gap(between))
                }
                if (justify != "spaceBetween" && planned.isNotEmpty()) add(gap(1))
            }
            else -> planned
        }
        return base(if (column) Lay.COL else Lay.ROW, n, ctx).copy(children = children, gravity = main or cross)
    }

    private fun stack(n: CNode, ctx: Ctx): VNode {
        val inner = Ctx("Stack", null, inheritFrom(n, ctx), ctx.api31, ctx.accent, ctx.local)
        val placeCtx = inner.copy(parent = "Place")
        val children = n.children.map { child ->
            val where = place(n, child)
            if (where == "topStart") node(child, inner)
            else VNode(Lay.PLACE, "${child.id}~place", children = listOf(node(child, placeCtx)), width = Dim.Fill, height = Dim.Fill,
                gravity = PLACES[where] ?: (TOP or START), visible = child.visible)
        }
        return base(Lay.STACK, n, ctx).copy(children = children)
    }

    private fun grid(n: CNode, ctx: Ctx): VNode {
        val cellCtx = Ctx("GridCell", null, inheritFrom(n, ctx), ctx.api31, ctx.accent, ctx.local)
        val rows = n.children.chunked(n.columns).mapIndexed { r, cells ->
            val slots = cells.map { VNode(Lay.SLOT_H, "${it.id}~cell", children = listOf(node(it, cellCtx)), weight = 1, width = Dim.Dp(0f)) } +
                List(n.columns - cells.size) { VNode(Lay.SLOT_H, "${n.id}~empty$r$it", weight = 1, width = Dim.Dp(0f)) }
            VNode(Lay.ROW, "${n.id}~row$r", children = slots, width = Dim.Fill, gravity = TOP or START)
        }
        return base(Lay.COL, n, ctx).copy(children = rows, gravity = TOP or START)
    }

    private fun choice(n: CNode, ctx: Ctx): VNode {
        val chosen = ctx.local.chosen[n.id] ?: n.options.filter { it.checked }.map { it.value }
        val inner = Ctx(if (n.chips) "Row" else "Column", null, inheritFrom(n, ctx), ctx.api31, ctx.accent, ctx.local)
        val label = n.label?.let { texty(VNode(Lay.TEXT, "${n.id}~label", width = if (n.chips) Dim.Wrap else Dim.Fill), n.copy(style = CStyle()), inner, if (n.chips) "$it  " else it, "caption") }
        val options = n.options.mapIndexed { i, o ->
            val on = o.value in chosen
            val tap = if (n.disabled) null else Tap.Choose(n.id, o.value)
            val plain = n.copy(style = CStyle(), action = null)
            when {
                n.chips -> texty(VNode(Lay.CHIP, "${n.id}~opt$i", margin = floatArrayOf(0f, 6f, 0f, 0f)), plain, inner, o.label)
                    .copy(tap = tap, bg = if (on) ctx.accent else CardSpec.colors.getValue("surfaceVariant"),
                        textColor = if (on) CardSpec.colors.getValue("onAccent") else n.style.color ?: inner.inherit.color ?: CardSpec.colors.getValue("text"))
                ctx.api31 -> texty(VNode(if (n.multiple) Lay.CHECK else Lay.RADIO, "${n.id}~opt$i", width = Dim.Wrap), plain, inner, o.label)
                    .copy(checked = on, tap = tap, tint = n.style.color ?: ctx.accent)
                else -> texty(VNode(Lay.TEXT, "${n.id}~opt$i"), plain, inner, (if (n.multiple) (if (on) "☑ " else "☐ ") else (if (on) "◉ " else "○ ")) + o.label).copy(tap = tap)
            }
        }
        return base(if (n.chips) Lay.ROW else Lay.COL, n, ctx).copy(children = listOfNotNull(label) + options, gravity = if (n.chips) CENTER_V or START else TOP or START, tap = null)
    }

    private fun tabs(n: CNode, ctx: Ctx): VNode {
        val selected = (ctx.local.tabs[n.id] ?: n.selected).coerceIn(0, n.tabs.lastIndex)
        val inner = Ctx("Column", "stretch", inheritFrom(n, ctx), ctx.api31, ctx.accent, ctx.local)
        val plain = n.copy(style = CStyle(), action = null)
        val titles = n.tabs.mapIndexed { i, t ->
            val on = i == selected
            texty(VNode(Lay.CHIP, "${n.id}~tab$i", margin = floatArrayOf(0f, 6f, 6f, 0f)), plain, inner, t.title)
                .copy(tap = Tap.Tab(n.id, i), bg = if (on) ctx.accent else CardSpec.colors.getValue("surfaceVariant"),
                    textColor = if (on) CardSpec.colors.getValue("onAccent") else inner.inherit.color ?: CardSpec.colors.getValue("text"))
        }
        val bar = VNode(Lay.ROW, "${n.id}~bar", children = titles, width = Dim.Fill, gravity = CENTER_V or START)
        return base(Lay.COL, n, ctx).copy(children = listOf(bar, node(n.tabs[selected].child, inner)), gravity = TOP or START)
    }
}
