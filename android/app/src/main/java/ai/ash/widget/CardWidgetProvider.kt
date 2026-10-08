package ai.ash.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.util.Log
import android.util.SizeF
import android.widget.RemoteViews
import ai.ash.R

/**
 * "Ash 卡片": one card from service:widgets, drawn natively. Unbound asks the owner to pick; expired says so; a card the
 * phone cannot draw says why ("这张卡片画不出来：…") instead of staying blank, and its creator is told.
 */
class CardWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) update(ctx, manager, id)
        WidgetHost.reportPlaced(ctx)
    }

    override fun onAppWidgetOptionsChanged(ctx: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        update(ctx, manager, id)
    }

    override fun onDeleted(ctx: Context, ids: IntArray) {
        WidgetHost.forget(ctx, ids)
        WidgetHost.reportPlaced(ctx)
    }

    companion object {
        private const val TAG = "ash.widgets"

        fun updateAll(ctx: Context) {
            val manager = AppWidgetManager.getInstance(ctx)
            for (id in manager.getAppWidgetIds(ComponentName(ctx, CardWidgetProvider::class.java))) update(ctx, manager, id)
        }

        /** Redraw the widgets showing [card] (after a toggle, a tab or an image that arrived). */
        fun updateCard(ctx: Context, card: String) {
            val manager = AppWidgetManager.getInstance(ctx)
            val state = WidgetHost.state(ctx)
            for (id in manager.getAppWidgetIds(ComponentName(ctx, CardWidgetProvider::class.java)))
                if ((state?.bindings?.get(id.toString()) ?: WidgetHost.localCard(ctx, id)) == card) update(ctx, manager, id)
        }

        /** The widget's size in dp as placed (portrait: its width and its height), or the card's nominal size. */
        fun sizeDp(ctx: Context, manager: AppWidgetManager, id: Int, card: WCard): Pair<Float, Float> {
            val o = runCatching { manager.getAppWidgetOptions(id) }.getOrNull()
            val w = o?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH) ?: 0
            val h = o?.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT) ?: 0
            return if (w > 0 && h > 0) w.toFloat() to h.toFloat() else WidgetPlan.nominal(card.size)
        }

        private fun night(ctx: Context) = (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

        fun update(ctx: Context, manager: AppWidgetManager, id: Int) {
            val view = WidgetPlan.view(WidgetHost.state(ctx), id, WidgetHost.localCard(ctx, id), System.currentTimeMillis())
            val views = when (view) {
                is CardView.Unbound -> message(ctx, id, "Ash 卡片", "点此选择卡片", pick = true)
                is CardView.Expired -> message(ctx, id, view.card.title, "已过期", pick = false)
                is CardView.Broken -> { WidgetHost.report(ctx, view.card, view.problem); broken(ctx, id, view.card, view.problem) }
                is CardView.Show -> draw(ctx, manager, id, view.card, view.render)
            }
            try { manager.updateAppWidget(id, views) }
            catch (e: Exception) {
                // Android refused the update itself (too deep, too large): say so on the widget and to the card's creator.
                val card = (view as? CardView.Show)?.card ?: return
                val why = "安卓拒绝显示这张卡片（${e.javaClass.simpleName}: ${e.message?.take(160) ?: ""}）"
                Log.w(TAG, "card ${card.id}: $why")
                WidgetHost.report(ctx, card, why)
                runCatching { manager.updateAppWidget(id, broken(ctx, id, card, why)) }
            }
        }

        /** Draw a card for one widget, checking it in Ash's own process first; the problems found go to the card's creator. */
        private fun draw(ctx: Context, manager: AppWidgetManager, id: Int, card: WCard, render: CardRender): RemoteViews {
            val (wDp, hDp) = sizeDp(ctx, manager, id, card)
            val result = render(ctx, id, card, render, wDp, hDp)
            WidgetHost.report(ctx, card, result.second)
            return result.first ?: broken(ctx, id, card, result.second ?: "未知原因")
        }

        /**
         * The RemoteViews for [card] at [wDp] x [hDp] (and, on Android 12+, its per-size layouts), or null when it cannot
         * be shown; the second value is what went wrong, if anything. Checks run on the main thread only.
         */
        fun render(ctx: Context, id: Int, card: WCard, render: CardRender, wDp: Float, hDp: Float): Pair<RemoteViews?, String?> {
            val builder = CardViews(ctx, id, card, night(ctx), WidgetHost.local(card)) { updateCard(ctx, card.id) }
            val density = ctx.resources.displayMetrics.density
            val checks = Looper.myLooper() == Looper.getMainLooper()
            val layouts = if (render.sizes.isNotEmpty() && Build.VERSION.SDK_INT >= 31) render.sizes.map { Triple(it.width, it.height, it.root) }
                else listOf(Triple(wDp, hDp, WidgetPlan.pick(render, wDp, hDp)))
            val problems = LinkedHashSet<String>()
            val drawn = ArrayList<Pair<SizeF?, RemoteViews>>()
            for ((w, h, root) in layouts) {
                var rv = try { builder.frame(render, root, w, scroll = false) } catch (e: CardProblem) { return null to e.message }
                if (checks) {
                    val r = CardCheck.inspect(ctx, rv, (w * density).toInt(), (h * density).toInt())
                    if (r.error != null) return null to r.error
                    if (r.overflow && !hasList(root)) {
                        // Taller than the widget: the card becomes the one item of a list, so it scrolls.
                        rv = builder.frame(render, root, w, scroll = true)
                    } else if (r.blank) return null to "画出来是空白的：内容都落在小组件的可见范围之外（${w.toInt()}×${h.toInt()} dp）"
                }
                drawn.add((if (layouts.size > 1) SizeF(w, h) else null) to rv)
            }
            problems.addAll(builder.problems)
            val rv = if (drawn.size > 1 && Build.VERSION.SDK_INT >= 31) RemoteViews(drawn.associate { it.first!! to it.second }) else drawn.first().second
            return rv to problems.joinToString("；").ifEmpty { null }
        }

        private fun hasList(n: CNode): Boolean = n.kind == "List" || n.inner.any { hasList(it) }

        private fun openAsh(ctx: Context, id: Int): PendingIntent = PendingIntent.getActivity(ctx, 9100 + id, WidgetActions.ash(ctx),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        private fun pickCard(ctx: Context, id: Int): PendingIntent = PendingIntent.getActivity(ctx, 9200 + id,
            Intent(ctx, CardPickerActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .setData(Uri.parse("ash://widget-pick/$id")).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        private fun message(ctx: Context, id: Int, title: String, text: String, pick: Boolean): RemoteViews =
            RemoteViews(ctx.packageName, R.layout.widget_card_message).apply {
                setTextViewText(R.id.card_title, title)
                setTextViewText(R.id.card_message, text)
                setOnClickPendingIntent(R.id.card_root, if (pick) pickCard(ctx, id) else openAsh(ctx, id))
            }

        private fun broken(ctx: Context, id: Int, card: WCard, problem: String) =
            message(ctx, id, card.title.ifBlank { "Ash 卡片" }, "这张卡片画不出来：$problem", pick = false)
    }
}
