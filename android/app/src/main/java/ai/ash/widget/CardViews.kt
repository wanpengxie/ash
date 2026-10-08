package ai.ash.widget

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.text.style.UnderlineSpan
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
import android.widget.Chronometer
import android.widget.CompoundButton
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.ProgressBar
import android.widget.RemoteViews
import android.widget.TextClock
import android.widget.TextView
import ai.ash.R

/**
 * Executes a [CardPlan] as RemoteViews for one widget: prebuilt layouts nested with addView, sizes, boxes and colours
 * (following dark mode on Android 12+), taps, toggles, scrolling lists and images. What it cannot draw it notes in
 * [problems] (the widget still draws the rest), so the card's creator hears about it.
 */
class CardViews(private val ctx: Context, private val widgetId: Int, private val card: WCard, private val night: Boolean,
    private val local: Local, private val redraw: () -> Unit) {
    val api31 = Build.VERSION.SDK_INT >= 31
    private val pkg = ctx.packageName
    private val density = ctx.resources.displayMetrics.density
    val problems = LinkedHashSet<String>()
    /** Bitmap bytes in this widget so far, against Android's cap (1.5 screens of ARGB), kept at half to be safe. */
    private var bitmapBytes = 0L
    private val bitmapBudget = ctx.resources.displayMetrics.let { 6L * it.widthPixels * it.heightPixels } / 2

    private fun px(dp: Float) = (dp * density).toInt()

    // ---------------------------------------------------------------------------------------------------------------
    // The frame around the card.

    /** How a card's lists are drawn: as plain rows (when they fit), as scrolling lists, or the whole card as one scrolling item. */
    enum class How { PLAIN, LISTS, SCROLL }

    /** A built widget, and how many rows each scrolling list (by view id) must show, for [CardCheck]. */
    class Built(val views: RemoteViews, val lists: Map<Int, Int>)

    /** A scrolling list waiting for its adapter, which only the top-level RemoteViews can set (see [frame]). */
    private class PendingList(val viewId: Int, val items: List<VNode>, val listId: String, val availW: Int)
    private val pendingLists = ArrayList<PendingList>()
    private var plainLists = false

    /** The whole widget for [root] at [wDp] wide, its lists drawn as [how] says. */
    fun frame(render: CardRender, root: CNode, wDp: Float, how: How): Built {
        val plan = CardPlan.plan(render, root, local, api31)
        val f = CardPlan.frame(root, card.title, WidgetPlan.opensWithTitle(root, card.title))
        val scroll = how == How.SCROLL
        val rv = RemoteViews(pkg, if (scroll) R.layout.widget_card_scroll else R.layout.widget_card)
        rv.setTextViewText(R.id.card_title, card.title)
        rv.setViewVisibility(R.id.card_title, if (f.title) View.VISIBLE else View.GONE)
        f.titleColor?.let { color(rv, R.id.card_title, "setTextColor", it) }
        val widthPx = px(wDp)
        rv.setOnClickPendingIntent(R.id.card_root, PendingIntent.getActivity(ctx, 9100 + widgetId, WidgetActions.ash(ctx),
            PendingIntent.FLAG_UPDATE_CURRENT or immutable))
        pendingLists.clear()
        plainLists = how == How.PLAIN
        val lists = LinkedHashMap<Int, Int>()
        if (!scroll) {
            if (f.ownBackground) {
                rv.setInt(R.id.card_root, "setBackgroundColor", 0)
                rv.setViewPadding(R.id.card_root, 0, 0, 0, 0)
            }
            rv.removeAllViews(R.id.card_body)
            add(rv, R.id.card_body, plan, build(plan, false, if (f.ownBackground) widthPx else widthPx - px(28f)))
            // Android applies setRemoteAdapter only from the widget's top-level RemoteViews: in a nested one (added with
            // addView) a launcher that applies asynchronously, as ColorOS's does, drops it and the list stays empty.
            for (p in pendingLists) { collection(rv, p.viewId, p.items, p.listId, p.availW); lists[p.viewId] = p.items.size }
        } else {
            // The card's own background and corners move to the frame; the scrolling item carries the content.
            var item = CardPlan.item(render, root, local, api31)
            if (f.ownBackground) {
                plan.bg?.let { color(rv, R.id.card_root, "setBackgroundColor", it) }
                val p = plan.padding ?: floatArrayOf(14f, 14f, 14f, 14f)
                rv.setViewPadding(R.id.card_root, px(p[3]), px(p[0]), px(p[1]), px(p[2]))
                if (api31) rv.setViewOutlinePreferredRadius(R.id.card_root, plan.radius ?: 22f, TypedValue.COMPLEX_UNIT_DIP)
                item = item.copy(bg = null, padding = null, radius = null)
            }
            collection(rv, R.id.card_list, listOf(item), CardItemsService.WHOLE_CARD, widthPx)
            lists[R.id.card_list] = 1
        }
        return Built(rv, lists)
    }

    private val listIds = intArrayOf(R.id.w_list_0, R.id.w_list_1, R.id.w_list_2, R.id.w_list_3, R.id.w_list_4, R.id.w_list_5, R.id.w_list_6, R.id.w_list_7,
        R.id.w_list_8, R.id.w_list_9, R.id.w_list_10, R.id.w_list_11, R.id.w_list_12, R.id.w_list_13, R.id.w_list_14, R.id.w_list_15)
    private val listLayouts = intArrayOf(R.layout.w_list_0, R.layout.w_list_1, R.layout.w_list_2, R.layout.w_list_3, R.layout.w_list_4, R.layout.w_list_5,
        R.layout.w_list_6, R.layout.w_list_7, R.layout.w_list_8, R.layout.w_list_9, R.layout.w_list_10, R.layout.w_list_11, R.layout.w_list_12,
        R.layout.w_list_13, R.layout.w_list_14, R.layout.w_list_15)
    private val gridLayouts = intArrayOf(R.layout.w_grid_0, R.layout.w_grid_1, R.layout.w_grid_2, R.layout.w_grid_3, R.layout.w_grid_4, R.layout.w_grid_5,
        R.layout.w_grid_6, R.layout.w_grid_7, R.layout.w_grid_8, R.layout.w_grid_9, R.layout.w_grid_10, R.layout.w_grid_11, R.layout.w_grid_12,
        R.layout.w_grid_13, R.layout.w_grid_14, R.layout.w_grid_15)

    // ---------------------------------------------------------------------------------------------------------------
    // One node.

    private val slotsH = intArrayOf(R.layout.w_slot_h1, R.layout.w_slot_h2, R.layout.w_slot_h3, R.layout.w_slot_h4, R.layout.w_slot_h5, R.layout.w_slot_h6,
        R.layout.w_slot_h7, R.layout.w_slot_h8, R.layout.w_slot_h9, R.layout.w_slot_h10, R.layout.w_slot_h11, R.layout.w_slot_h12)
    private val slotsV = intArrayOf(R.layout.w_slot_v1, R.layout.w_slot_v2, R.layout.w_slot_v3, R.layout.w_slot_v4, R.layout.w_slot_v5, R.layout.w_slot_v6,
        R.layout.w_slot_v7, R.layout.w_slot_v8, R.layout.w_slot_v9, R.layout.w_slot_v10, R.layout.w_slot_v11, R.layout.w_slot_v12)

    private fun layout(v: VNode): Int {
        val wrap = !api31 && v.width != Dim.Fill
        return when (v.lay) {
            Lay.COL -> if (wrap) R.layout.w_col_wrap else R.layout.w_col
            Lay.ROW -> if (wrap) R.layout.w_row_wrap else R.layout.w_row
            Lay.STACK -> if (wrap) R.layout.w_stack_wrap else R.layout.w_stack
            Lay.PLACE -> R.layout.w_place
            Lay.SLOT_H -> slotsH[v.weight.coerceIn(1, 12) - 1]
            Lay.SLOT_V -> slotsV[v.weight.coerceIn(1, 12) - 1]
            Lay.GAP_H -> if (v.weight >= 2) R.layout.w_gap_h2 else R.layout.w_gap_h1
            Lay.GAP_V -> if (v.weight >= 2) R.layout.w_gap_v2 else R.layout.w_gap_v1
            Lay.SPACE -> R.layout.w_space
            Lay.TEXT -> R.layout.w_text
            Lay.TEXT_START -> R.layout.w_text_start
            Lay.TEXT_MIDDLE -> R.layout.w_text_middle
            Lay.TEXT_CLIP -> R.layout.w_text_clip
            Lay.ICON -> R.layout.w_icon
            Lay.BADGE -> R.layout.w_badge
            Lay.CHIP -> R.layout.w_chip
            Lay.IMAGE_CONTAIN -> R.layout.w_image_contain
            Lay.IMAGE_COVER -> R.layout.w_image_cover
            Lay.IMAGE_FILL -> R.layout.w_image_fill
            Lay.IMAGE_NONE -> R.layout.w_image_none
            Lay.IMAGE_SCALEDOWN -> R.layout.w_image_scaledown
            Lay.BUTTON -> R.layout.w_button
            Lay.BUTTON_PRIMARY -> R.layout.w_button_primary
            Lay.BUTTON_BORDERLESS -> R.layout.w_button_borderless
            Lay.CARD -> R.layout.w_card
            Lay.CHECK -> R.layout.w_check
            Lay.SWITCH -> R.layout.w_switch
            Lay.RADIO -> R.layout.w_radio
            Lay.PROGRESS -> R.layout.w_progress
            Lay.DIV_H -> R.layout.w_div_h
            Lay.DIV_V -> R.layout.w_div_v
            Lay.LIST, Lay.GRID -> {
                val k = pendingLists.size
                if (k >= listLayouts.size) throw CardProblem("一张卡片最多 ${listLayouts.size} 个滚动列表")
                if (v.lay == Lay.GRID) gridLayouts[k] else listLayouts[k]
            }
            Lay.CLOCK -> R.layout.w_clock
            Lay.CHRONO -> R.layout.w_chrono
        }
    }

    private fun color(rv: RemoteViews, id: Int, method: String, t: Tint) {
        if (api31) rv.setColorInt(id, method, t.light, t.dark) else rv.setInt(id, method, t.pick(night))
    }

    private fun tintList(rv: RemoteViews, id: Int, method: String, t: Tint) {
        if (api31) rv.setColorStateList(id, method, ColorStateList.valueOf(t.light), ColorStateList.valueOf(t.dark))
    }

    private fun size(rv: RemoteViews, d: Dim, width: Boolean) {
        val (value, unit) = when (d) {
            Dim.Fill -> ViewGroup.LayoutParams.MATCH_PARENT.toFloat() to TypedValue.COMPLEX_UNIT_PX
            Dim.Wrap -> ViewGroup.LayoutParams.WRAP_CONTENT.toFloat() to TypedValue.COMPLEX_UNIT_PX
            is Dim.Dp -> d.dp to TypedValue.COMPLEX_UNIT_DIP
        }
        if (width) rv.setViewLayoutWidth(R.id.w_self, value, unit) else rv.setViewLayoutHeight(R.id.w_self, value, unit)
    }

    /** The RemoteViews for [v] and everything inside it. [inItem]: inside a scrolling list's item (taps fill in a template). */
    fun build(v: VNode, inItem: Boolean, availW: Int): RemoteViews {
        if (plainLists && v.items != null) return build(CardPlan.plain(v), inItem, availW)
        val rv = RemoteViews(pkg, layout(v))
        val id = R.id.w_self
        if (!v.visible) rv.setViewVisibility(id, View.GONE)
        if (api31) {
            val xmlWidth = v.lay in setOf(Lay.SLOT_H, Lay.GAP_H, Lay.GAP_V, Lay.DIV_V)
            val xmlHeight = v.lay in setOf(Lay.SLOT_V, Lay.GAP_H, Lay.GAP_V, Lay.DIV_H) || (v.lay == Lay.LIST || v.lay == Lay.GRID) && v.height !is Dim.Dp
            if (!xmlWidth) size(rv, v.width, true)
            if (!xmlHeight) size(rv, v.height, false)
            v.margin?.let { m ->
                rv.setViewLayoutMargin(id, RemoteViews.MARGIN_TOP, m[0], TypedValue.COMPLEX_UNIT_DIP)
                rv.setViewLayoutMargin(id, RemoteViews.MARGIN_END, m[1], TypedValue.COMPLEX_UNIT_DIP)
                rv.setViewLayoutMargin(id, RemoteViews.MARGIN_BOTTOM, m[2], TypedValue.COMPLEX_UNIT_DIP)
                rv.setViewLayoutMargin(id, RemoteViews.MARGIN_START, m[3], TypedValue.COMPLEX_UNIT_DIP)
            }
            v.radius?.let { rv.setViewOutlinePreferredRadius(id, it, TypedValue.COMPLEX_UNIT_DIP); rv.setBoolean(id, "setClipToOutline", true) }
        }
        v.padding?.let { p -> rv.setViewPadding(id, px(p[3]), px(p[0]), px(p[1]), px(p[2])) }
        v.bg?.let { color(rv, id, "setBackgroundColor", it) }
        v.alpha?.let { rv.setFloat(id, "setAlpha", it) }
        v.a11y?.let { rv.setContentDescription(id, it) }
        v.minSize?.let { rv.setInt(id, "setMinimumWidth", px(it)); rv.setInt(id, "setMinimumHeight", px(it)) }
        if (v.gravity != null && v.lay in setOf(Lay.COL, Lay.ROW, Lay.PLACE, Lay.BUTTON, Lay.BUTTON_PRIMARY, Lay.BUTTON_BORDERLESS, Lay.CARD,
                Lay.TEXT, Lay.TEXT_START, Lay.TEXT_MIDDLE, Lay.TEXT_CLIP, Lay.CLOCK, Lay.CHRONO, Lay.BADGE, Lay.CHIP))
            rv.setInt(id, "setGravity", v.gravity)
        val accent = CardSpec.colors.getValue("accent").pick(night)
        val textId = if (v.lay == Lay.PROGRESS) R.id.w_label else id
        v.text?.let { rv.setTextViewText(textId, CardText.spanned(it, accent)) }
        if (v.lay == Lay.PROGRESS) rv.setViewVisibility(R.id.w_label, if (v.text?.text.isNullOrBlank()) View.GONE else View.VISIBLE)
        v.textSize?.let { rv.setTextViewTextSize(textId, TypedValue.COMPLEX_UNIT_SP, it) }
        v.textColor?.let { color(rv, textId, "setTextColor", it) }
        v.maxLines?.let { rv.setInt(textId, "setMaxLines", it) }
        v.lineHeight?.let { if (Build.VERSION.SDK_INT >= 28) rv.setInt(textId, "setLineHeight", px(it)) }
        v.letterSpacing?.let { rv.setFloat(textId, "setLetterSpacing", it) }
        if (v.justifyText && Build.VERSION.SDK_INT >= 26) rv.setInt(textId, "setJustificationMode", 1)
        v.progress?.let { (value, max) -> rv.setProgressBar(R.id.w_bar, max, value, false) }
        v.tint?.let { t ->
            when (v.lay) {
                Lay.PROGRESS -> tintList(rv, R.id.w_bar, "setProgressTintList", t)
                Lay.CHECK, Lay.SWITCH, Lay.RADIO -> tintList(rv, id, "setButtonTintList", t)
                else -> {}
            }
        }
        if (v.checked != null && api31 && v.lay in setOf(Lay.CHECK, Lay.SWITCH, Lay.RADIO)) rv.setCompoundButtonChecked(id, v.checked)
        v.clockFormat?.let { rv.setCharSequence(id, "setFormat24Hour", it); rv.setCharSequence(id, "setFormat12Hour", it) }
        v.timeZone?.let { rv.setString(id, "setTimeZone", it) }
        v.chronoSince?.let { t ->
            val now = System.currentTimeMillis()
            val base = android.os.SystemClock.elapsedRealtime() - (now - t)
            rv.setChronometer(id, base, null, true)
            if (v.countDown) rv.setChronometerCountDown(id, true)
        }
        v.image?.let { image(rv, v, it, availW) }
        v.tap?.let { tap(rv, v, it, inItem) }
        // Android 12+ recycles children added with a stable id when the card is drawn again, which needs this first.
        // (Only boxes get children here; the list and progress layouts keep the children their XML gives them.)
        if (api31 && v.children.isNotEmpty()) rv.removeAllViews(id)
        for (child in v.children) add(rv, id, child, build(child, inItem, availW))
        v.items?.let { items ->
            val listId = listIds[pendingLists.size]
            if (v.lay == Lay.GRID) rv.setInt(listId, "setNumColumns", v.columns)
            pendingLists.add(PendingList(listId, items, v.id, if (v.lay == Lay.GRID) availW / v.columns.coerceAtLeast(1) else availW))
        }
        return rv
    }

    /**
     * Add [child]'s views under [parent]. On Android 12+ under its [VNode.stableKey]: when the widget is drawn again (a
     * toggle, a new version from the core) the launcher reapplies onto the views it has instead of making new ones,
     * as long as the node looks the same. A scrolling list inside then keeps its view, and its new rows go into the
     * same adapter, so it stays where the owner had scrolled instead of jumping back to the top.
     */
    private fun add(rv: RemoteViews, parent: Int, child: VNode, views: RemoteViews) {
        if (api31) rv.addStableView(parent, views, child.stableKey) else rv.addView(parent, views)
    }

    private fun image(rv: RemoteViews, v: VNode, img: Img, availW: Int) {
        val w = (v.width as? Dim.Dp)?.let { px(it.dp) } ?: availW
        val h = (v.height as? Dim.Dp)?.let { px(it.dp) } ?: availW
        if (img is Img.Url && img.url.startsWith("data:") && !CardImages.decodes(img.url)) problems.add("图片（${v.id}）的数据解不开")
        val bmp = CardImages.get(ctx, img, w, h, redraw)
        if (bmp != null && bitmapBytes + bmp.allocationByteCount <= bitmapBudget) {
            bitmapBytes += bmp.allocationByteCount
            rv.setImageViewBitmap(R.id.w_self, bmp)
            if (img is Img.Path) { if (api31) tintList(rv, R.id.w_self, "setImageTintList", img.tint) else rv.setInt(R.id.w_self, "setColorFilter", img.tint.pick(night)) }
            return
        }
        if (bmp != null) problems.add("图片太多太大，超过安卓给小组件的图片内存，有的没画（${v.id}）")
        if (img is Img.Url && !img.url.startsWith("data:")) CardImages.failed[img.url]?.let { problems.add("图片没取到（${img.url.take(120)}）：$it") }
        if (img is Img.Path && bmp == null) problems.add("图标路径画不出来（${v.id}）")
        rv.setImageViewResource(R.id.w_self, R.drawable.w_image_placeholder)
    }

    // ---------------------------------------------------------------------------------------------------------------
    // Taps.

    private fun uri(tap: Tap): Uri {
        val b = Uri.Builder().scheme("ash").authority("widget-action").appendPath(widgetId.toString()).appendPath(card.id)
            .appendQueryParameter("c", tap.component)
        when (tap) {
            is Tap.Send -> b.appendQueryParameter("k", "send")
            is Tap.Toggle -> b.appendQueryParameter("k", "toggle").appendQueryParameter("ck", tap.checked.toString())
            is Tap.Choose -> b.appendQueryParameter("k", "choose").appendQueryParameter("v", tap.value)
            is Tap.Tab -> b.appendQueryParameter("k", "tab").appendQueryParameter("i", tap.index.toString())
            is Tap.Open -> b.appendQueryParameter("k", "open")
        }
        return b.build()
    }

    private val mutable = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
    private val immutable = if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0

    private fun tap(rv: RemoteViews, v: VNode, tap: Tap, inItem: Boolean) {
        val id = R.id.w_self
        val compound = api31 && v.lay in setOf(Lay.CHECK, Lay.SWITCH, Lay.RADIO)
        if (inItem) {
            val fill = Intent().setData(uri(tap))
            if (compound) rv.setOnCheckedChangeResponse(id, RemoteViews.RemoteResponse.fromFillInIntent(fill))
            else rv.setOnClickFillInIntent(id, fill)
            return
        }
        if (tap is Tap.Open) {
            val open = WidgetActions.openIntent(ctx, tap.target)
            rv.setOnClickPendingIntent(id, PendingIntent.getActivity(ctx, open.dataString.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT or immutable))
            return
        }
        val pi = PendingIntent.getBroadcast(ctx, 0, Intent(ctx, WidgetActionReceiver::class.java).setData(uri(tap)),
            PendingIntent.FLAG_UPDATE_CURRENT or if (compound) mutable else immutable)
        if (compound) rv.setOnCheckedChangeResponse(id, RemoteViews.RemoteResponse.fromPendingIntent(pi)) else rv.setOnClickPendingIntent(id, pi)
    }

    /** A scrolling list: on Android 12+ its items go in the update itself; earlier ones read them from [CardItemsService]. */
    private fun collection(rv: RemoteViews, viewId: Int, items: List<VNode>, listId: String, availW: Int) {
        val template = PendingIntent.getBroadcast(ctx, widgetId, Intent(ctx, WidgetActionReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or mutable)
        rv.setPendingIntentTemplate(viewId, template)
        if (api31) {
            val built = items.map { build(it, true, availW) }
            val b = RemoteViews.RemoteCollectionItems.Builder().setHasStableIds(true)
                .setViewTypeCount(built.map { it.layoutId }.distinct().size.coerceAtLeast(1))
            val seen = HashSet<Long>()
            items.forEachIndexed { i, item ->
                var key = item.id.hashCode().toLong() shl 20 or i.toLong()
                while (!seen.add(key)) key++
                b.addItem(key, built[i])
            }
            rv.setRemoteAdapter(viewId, b.build())
        } else {
            @Suppress("DEPRECATION")
            rv.setRemoteAdapter(viewId, CardItemsService.intent(ctx, widgetId, card, listId))
        }
    }

    /** Pre-Android-12 list items for [CardItemsService]. */
    fun items(items: List<VNode>, availW: Int): List<RemoteViews> = items.map { build(it, true, availW) }
}

/**
 * Draws a widget's RemoteViews in Ash's own process before the launcher does, the way a launcher does it (applied
 * asynchronously under an AppWidgetHostView), to catch what would fail to apply, come out blank, leave a list empty,
 * or not fit. Main thread only; [done] runs on the main thread.
 */
object CardCheck {
    data class Result(val error: String?, val blank: Boolean, val overflow: Boolean)

    private val main = android.os.Handler(android.os.Looper.getMainLooper())

    @Volatile private var provider: android.appwidget.AppWidgetProviderInfo? = null

    fun inspect(ctx: Context, built: CardViews.Built, wPx: Int, hPx: Int, done: (Result) -> Unit) {
        var finished = false
        fun finish(r: Result) { if (!finished) { finished = true; done(r) } }
        // Should the check itself hang, the widget is still drawn (unchecked) after a moment.
        main.postDelayed({ finish(Result(null, blank = false, overflow = false)) }, 1500)
        try {
            val info = provider ?: android.appwidget.AppWidgetManager.getInstance(ctx).installedProviders
                .firstOrNull { it.provider.packageName == ctx.packageName && it.provider.className == CardWidgetProvider::class.java.name }
                ?.also { provider = it }
            // A real widget host, inflating on an executor as launchers do: actions of nested RemoteViews then see their
            // direct parent, not the host, exactly as on the home screen.
            val host = android.appwidget.AppWidgetHostView(ctx)
            if (info != null) host.setAppWidget(0, info)
            if (Build.VERSION.SDK_INT >= 29) host.setExecutor { it.run() }
            host.updateAppWidget(built.views)
            fun look(tries: Int) {
                if (finished) return
                val content = host.getChildAt(0)
                when {
                    content != null && content.findViewById<View>(R.id.card_root) != null -> finish(measure(content, built.lists, wPx, hPx))
                    content != null && tries > 3 -> finish(Result("安卓拒绝了这张卡片的画法（桌面显示了出错的样子）", blank = false, overflow = false))
                    else -> main.postDelayed({ look(tries + 1) }, 20)
                }
            }
            main.post { look(0) }
        } catch (e: Exception) {
            finish(Result("安卓拒绝了这张卡片的画法（${e.javaClass.simpleName}: ${e.message?.take(200) ?: ""}）", false, false))
        }
    }

    private fun measure(root: View, lists: Map<Int, Int>, wPx: Int, hPx: Int): Result = try {
        root.measure(View.MeasureSpec.makeMeasureSpec(wPx, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(hPx, View.MeasureSpec.EXACTLY))
        root.layout(0, 0, wPx, hPx)
        // Every scrolling list must have its rows (Android 12+ carries them in the update; earlier ones fetch them later).
        val empty = if (Build.VERSION.SDK_INT >= 31) lists.entries.firstOrNull { (id, rows) ->
            rows > 0 && ((root.findViewById<View>(id) as? AdapterView<*>)?.adapter?.count ?: 0) == 0 } else null
        if (empty != null) Result("列表画出来是空的（应有 ${empty.value} 行，桌面没有接上列表内容）", blank = false, overflow = false)
        else {
            val body = root.findViewById<View>(R.id.card_body) ?: root.findViewById(R.id.card_list)
            val content = (body as? ViewGroup)?.takeIf { it.id == R.id.card_body }?.getChildAt(0)
            var overflow = false
            if (content != null && body.height > 0) {
                content.measure(View.MeasureSpec.makeMeasureSpec(body.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
                overflow = content.measuredHeight > body.height + 2
                body.measure(View.MeasureSpec.makeMeasureSpec(body.width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(body.height, View.MeasureSpec.EXACTLY))
                body.layout(body.left, body.top, body.right, body.bottom)
            }
            Result(null, blank = body != null && !visible(body, body.width, body.height, 0, 0), overflow = overflow)
        }
    } catch (e: Exception) {
        Result("这张卡片排版时出错（${e.javaClass.simpleName}: ${e.message?.take(200) ?: ""}）", blank = false, overflow = false)
    }

    /** Whether anything with content shows inside a [w] x [h] box, [x],[y] being this view's offset in it. */
    private fun visible(v: View, w: Int, h: Int, x: Int, y: Int): Boolean {
        if (v.visibility != View.VISIBLE || v.alpha <= 0.01f) return false
        val inside = v.width > 0 && v.height > 0 && x < w && y < h && x + v.width > 0 && y + v.height > 0
        val content = when (v) {
            is AdapterView<*> -> (v.adapter?.count ?: 0) > 0
            is TextClock, is Chronometer, is ProgressBar, is CompoundButton -> true
            is TextView -> !v.text.isNullOrBlank()
            is ImageView -> v.drawable != null
            // A coloured block with nothing in it (a swatch, a bar, a divider) shows even without text.
            else -> (v !is ViewGroup || v.childCount == 0) && v.background.let { it != null && (it !is android.graphics.drawable.ColorDrawable || it.alpha > 0) }
        }
        if (content && inside) return true
        if (v is ViewGroup && v !is AdapterView<*>) for (i in 0 until v.childCount) {
            val c = v.getChildAt(i)
            if (visible(c, w, h, x + c.left - v.scrollX, y + c.top - v.scrollY)) return true
        }
        return false
    }
}

/** Formatted text ([Styled], e.g. from Markdown) as Android spans, which RemoteViews carries to the launcher. */
object CardText {
    fun spanned(t: Styled, accent: Int): CharSequence {
        if (t.spans.isEmpty()) return t.text
        val sb = SpannableStringBuilder(t.text)
        fun on(s: Span, what: Any) = sb.setSpan(what, s.start.coerceIn(0, sb.length), s.end.coerceIn(0, sb.length), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        for (s in t.spans) when (s.mark) {
            Mark.BOLD -> on(s, StyleSpan(Typeface.BOLD))
            Mark.ITALIC -> on(s, StyleSpan(Typeface.ITALIC))
            Mark.CODE -> { on(s, TypefaceSpan("monospace")); on(s, BackgroundColorSpan(0x26808080)) }
            Mark.STRIKE -> on(s, StrikethroughSpan())
            Mark.UNDERLINE -> on(s, UnderlineSpan())
            Mark.LINK -> { on(s, UnderlineSpan()); on(s, ForegroundColorSpan(accent)) }
            Mark.HEADING -> { on(s, StyleSpan(Typeface.BOLD)); on(s, RelativeSizeSpan(when (s.level) { 1 -> 1.4f; 2 -> 1.25f; 3 -> 1.1f; else -> 1f })) }
            Mark.QUOTE -> on(s, StyleSpan(Typeface.ITALIC))
            Mark.MEDIUM -> on(s, TypefaceSpan("sans-serif-medium"))
            Mark.LIGHT -> on(s, TypefaceSpan("sans-serif-light"))
        }
        return sb
    }

    /** Markdown drawn as formatting (for the Ash widget's lines, which come from replies). */
    fun markdown(raw: String, accent: Int = 0xFFFF7A3D.toInt()): CharSequence = spanned(Markdown.parse(raw), accent)
}
