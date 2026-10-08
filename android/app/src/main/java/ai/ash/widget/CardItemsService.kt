package ai.ash.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.net.Uri
import android.widget.RemoteViews
import android.widget.RemoteViewsService

/**
 * A card's scrolling list on Android before 12, which cannot carry list items inside the widget update: the launcher
 * asks this service for them. (Android 12+ gets them in the update itself.)
 */
class CardItemsService : RemoteViewsService() {
    companion object {
        /** The list id of a whole card shown as a one-item list because it is taller than the widget. */
        const val WHOLE_CARD = "~card"
        @Volatile private var draws = 0L

        fun intent(ctx: Context, widgetId: Int, card: WCard, listId: String): Intent = Intent(ctx, CardItemsService::class.java)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            // A new address every draw, so the launcher asks again instead of keeping old items.
            .setData(Uri.Builder().scheme("ash").authority("card-items").appendPath(widgetId.toString()).appendPath(card.id).appendPath(listId)
                .appendQueryParameter("d", (++draws).toString()).build())
    }

    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = Factory(applicationContext, intent.data)

    private class Factory(private val ctx: Context, private val uri: Uri?) : RemoteViewsFactory {
        private var views: List<RemoteViews> = emptyList()

        private fun load() {
            views = runCatching {
                val parts = uri?.pathSegments ?: return
                val widgetId = parts[0].toInt(); val cardId = parts[1]; val listId = parts[2]
                val card = WidgetHost.state(ctx)?.cards?.get(cardId) ?: return
                val render = card.render ?: return
                val (w, h) = CardWidgetProvider.sizeDp(ctx, AppWidgetManager.getInstance(ctx), widgetId, card)
                val root = WidgetPlan.pick(render, w, h)
                val local = WidgetHost.local(card)
                val night = (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
                val builder = CardViews(ctx, widgetId, card, night, local) { CardWidgetProvider.updateCard(ctx, card.id) }
                val availW = (w * ctx.resources.displayMetrics.density).toInt()
                if (listId == WHOLE_CARD) builder.items(listOf(CardPlan.item(render, root, local, false)), availW)
                else {
                    val list = CardPlan.plan(render, root, local, false).walk().firstOrNull { it.id == listId && it.items != null } ?: return
                    builder.items(list.items!!, availW)
                }
            }.getOrDefault(emptyList())
        }

        override fun onCreate() = load()
        override fun onDataSetChanged() = load()
        override fun onDestroy() { views = emptyList() }
        override fun getCount() = views.size
        override fun getViewAt(position: Int): RemoteViews? = views.getOrNull(position)
        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount() = views.map { it.layoutId }.distinct().size.coerceAtLeast(1)
        override fun getItemId(position: Int) = position.toLong()
        override fun hasStableIds() = false
    }
}
