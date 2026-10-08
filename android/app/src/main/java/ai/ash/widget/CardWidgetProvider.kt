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

        /** Redraw every card widget; [done] runs (on the main thread) once all are drawn. */
        fun updateAll(ctx: Context, done: () -> Unit = {}) {
            val manager = AppWidgetManager.getInstance(ctx)
            val ids = manager.getAppWidgetIds(ComponentName(ctx, CardWidgetProvider::class.java))
            val left = java.util.concurrent.atomic.AtomicInteger(ids.size + 1)
            val one = { if (left.decrementAndGet() == 0) done() }
            for (id in ids) update(ctx, manager, id, one)
            one()
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

        fun update(ctx: Context, manager: AppWidgetManager, id: Int, done: () -> Unit = {}) {
            val view = WidgetPlan.view(WidgetHost.state(ctx), id, WidgetHost.localCard(ctx, id), System.currentTimeMillis())
            fun show(views: RemoteViews) {
                try { manager.updateAppWidget(id, views) }
                catch (e: Exception) {
                    // Android refused the update itself (too deep, too large): say so on the widget and to the card's creator.
                    val card = (view as? CardView.Show)?.card
                    if (card != null) {
                        val why = "安卓拒绝显示这张卡片（${e.javaClass.simpleName}: ${e.message?.take(160) ?: ""}）"
                        Log.w(TAG, "card ${card.id}: $why")
                        WidgetHost.report(ctx, card, why)
                        runCatching { manager.updateAppWidget(id, broken(ctx, id, card, why)) }
                    }
                }
                done()
            }
            when (view) {
                is CardView.Unbound -> show(message(ctx, id, "Ash 卡片", "点此选择卡片", pick = true))
                is CardView.Expired -> show(message(ctx, id, view.card.title, "已过期", pick = false))
                is CardView.Broken -> { WidgetHost.report(ctx, view.card, view.problem); show(broken(ctx, id, view.card, view.problem)) }
                is CardView.Show -> {
                    val (wDp, hDp) = sizeDp(ctx, manager, id, view.card)
                    render(ctx, id, view.card, view.render, wDp, hDp) { rv, problem ->
                        WidgetHost.report(ctx, view.card, problem)
                        show(rv ?: broken(ctx, id, view.card, problem ?: "未知原因"))
                    }
                }
            }
        }

        /**
         * Build [card] at [wDp] x [hDp] (and, on Android 12+, its per-size layouts), checking each layout in Ash's own
         * process first (on the main thread): lists are drawn as plain rows while they fit, as scrolling lists when they
         * do not, and a card taller than the widget without lists scrolls as a whole. [done] gets the views, or null when
         * the card cannot be shown, and what went wrong, if anything. [single] draws only the layout for this size (not one per
         * size on Android 12+), as a preview picture needs; [onBuilt] gets the checked build of that layout.
         */
        fun render(ctx: Context, id: Int, card: WCard, render: CardRender, wDp: Float, hDp: Float, single: Boolean = false,
            onBuilt: ((CardViews.Built) -> Unit)? = null, done: (RemoteViews?, String?) -> Unit) {
            val builder = CardViews(ctx, id, card, night(ctx), WidgetHost.local(card)) { updateCard(ctx, card.id) }
            val density = ctx.resources.displayMetrics.density
            val checks = Looper.myLooper() == Looper.getMainLooper()
            val layouts = if (!single && render.sizes.isNotEmpty() && Build.VERSION.SDK_INT >= 31) render.sizes.map { Triple(it.width, it.height, it.root) }
                else listOf(Triple(wDp, hDp, WidgetPlan.pick(render, wDp, hDp)))
            val budget = if (layouts.size > 1) CardSpec.LEVELS_WITH_SIZES else CardSpec.LEVELS
            val drawn = ArrayList<Pair<SizeF?, RemoteViews>>()
            fun finish() {
                val rv = if (drawn.size > 1 && Build.VERSION.SDK_INT >= 31) RemoteViews(drawn.associate { it.first!! to it.second }) else drawn.first().second
                done(rv, builder.problems.joinToString("；").ifEmpty { null })
            }
            fun step(i: Int) {
                if (i == layouts.size) return finish()
                val (w, h, root) = layouts[i]
                val size = if (layouts.size > 1) SizeF(w, h) else null
                val lists = hasList(root)
                val plainFits = lists && CardPlan.plan(render, root, WidgetHost.local(card), builder.api31).plainDepth <= budget
                fun attempt(how: CardViews.How) {
                    val built = try { builder.frame(render, root, w, how) } catch (e: CardProblem) { return done(null, e.message) }
                    if (!checks) { onBuilt?.invoke(built); drawn.add(size to built.views); return step(i + 1) }
                    CardCheck.inspect(ctx, built, (w * density).toInt(), (h * density).toInt()) { r ->
                        when {
                            r.error != null -> done(null, r.error)
                            r.blank -> done(null, "画出来是空白的：内容都落在小组件的可见范围之外（${w.toInt()}×${h.toInt()} dp）")
                            // Rows that do not fit become a real scrolling list; a card without lists scrolls as a whole.
                            r.overflow && how == CardViews.How.PLAIN -> attempt(CardViews.How.LISTS)
                            r.overflow && how == CardViews.How.LISTS && !lists -> attempt(CardViews.How.SCROLL)
                            else -> { onBuilt?.invoke(built); drawn.add(size to built.views); step(i + 1) }
                        }
                    }
                }
                attempt(if (plainFits && checks) CardViews.How.PLAIN else CardViews.How.LISTS)
            }
            step(0)
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
