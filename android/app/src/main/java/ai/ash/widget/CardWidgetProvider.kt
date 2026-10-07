package ai.ash.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import ai.ash.R
import ai.ash.ui.HomeActivity

/** "Ash 卡片": one card from service:widgets, drawn natively. Unbound asks the owner to pick; expired says so. */
class CardWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) update(ctx, manager, id)
        WidgetHost.reportPlaced(ctx)
    }

    override fun onDeleted(ctx: Context, ids: IntArray) {
        WidgetHost.forget(ctx, ids)
        WidgetHost.reportPlaced(ctx)
    }

    companion object {
        fun updateAll(ctx: Context) {
            val manager = AppWidgetManager.getInstance(ctx)
            for (id in manager.getAppWidgetIds(ComponentName(ctx, CardWidgetProvider::class.java))) update(ctx, manager, id)
        }

        fun update(ctx: Context, manager: AppWidgetManager, id: Int) {
            val view = WidgetPlan.view(WidgetHost.state(ctx), id, WidgetHost.localCard(ctx, id), System.currentTimeMillis())
            val views = runCatching { render(ctx, id, view) }.getOrElse { message(ctx, id, "卡片", "这张卡片画不出来，点此换一张", pick = true) }
            runCatching { manager.updateAppWidget(id, views) }
        }

        private fun openAsh(ctx: Context, id: Int): PendingIntent = PendingIntent.getActivity(ctx, 9100 + id,
            Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
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

        private fun render(ctx: Context, id: Int, view: CardView): RemoteViews = when (view) {
            is CardView.Unbound -> message(ctx, id, "Ash 卡片", "点此选择卡片", pick = true)
            is CardView.Expired -> message(ctx, id, view.card.title, "已过期", pick = false)
            is CardView.Show -> RemoteViews(ctx.packageName, R.layout.widget_card).apply {
                setTextViewText(R.id.card_title, view.card.title)
                setViewVisibility(R.id.card_title, if (view.card.title.isBlank()) View.GONE else View.VISIBLE)
                removeAllViews(R.id.card_body)
                addView(R.id.card_body, node(ctx, id, view.card.id, view.root))
                setOnClickPendingIntent(R.id.card_root, openAsh(ctx, id))
            }
        }

        private fun node(ctx: Context, widget: Int, card: String, n: WNode): RemoteViews {
            val pkg = ctx.packageName
            return when (n) {
                is WNode.Box -> RemoteViews(pkg, if (n.vertical) (if (n.center) R.layout.w_col_center else R.layout.w_col) else R.layout.w_row).apply {
                    for (child in n.children) {
                        val drawn = node(ctx, widget, card, child)
                        if (!n.vertical && n.spread) addView(R.id.w_box, RemoteViews(pkg, R.layout.w_cell).apply { addView(R.id.w_box, drawn) })
                        else addView(R.id.w_box, drawn)
                    }
                }
                is WNode.Text -> RemoteViews(pkg, when (n.style) {
                    TextStyle.NUMBER -> R.layout.w_text_number; TextStyle.TITLE -> R.layout.w_text_title
                    TextStyle.CAPTION -> R.layout.w_text_caption; TextStyle.BODY -> R.layout.w_text_body
                }).apply { setTextViewText(R.id.w_text, n.text) }
                is WNode.Icon -> RemoteViews(pkg, R.layout.w_icon).apply { setTextViewText(R.id.w_text, n.glyph) }
                is WNode.Avatar -> RemoteViews(pkg, R.layout.w_avatar).apply {
                    WidgetHost.face(ctx, "default")?.let { setImageViewBitmap(R.id.w_image, it) } ?: setImageViewResource(R.id.w_image, R.drawable.ic_launcher)
                }
                is WNode.Button -> RemoteViews(pkg, R.layout.w_button).apply {
                    setTextViewText(R.id.w_text, n.label)
                    val intent = Intent(ctx, WidgetActionReceiver::class.java)
                        .setData(Uri.Builder().scheme("ash").authority("widget-action").appendPath(card).appendPath(n.action).appendPath(widget.toString()).build())
                    setOnClickPendingIntent(R.id.w_text, PendingIntent.getBroadcast(ctx, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                }
                is WNode.Divider -> RemoteViews(pkg, R.layout.w_divider)
                is WNode.Progress -> RemoteViews(pkg, R.layout.w_progress).apply {
                    setProgressBar(R.id.w_progress, 100, n.value, false)
                    setTextViewText(R.id.w_text, n.label)
                    setViewVisibility(R.id.w_text, if (n.label.isBlank()) View.GONE else View.VISIBLE)
                }
                is WNode.Badge -> RemoteViews(pkg, R.layout.w_badge).apply { setTextViewText(R.id.w_text, n.text) }
            }
        }
    }
}

/** A card button: passed to the card's creator through the core as the owner's tap; it does nothing else by itself. */
class WidgetActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val uri = intent.data ?: return
        val parts = uri.pathSegments
        if (uri.scheme != "ash" || uri.host != "widget-action" || parts.size != 3) return
        val pending = goAsync()
        WidgetHost.tap(ctx, parts[0], parts[1]) { pending.finish() }
    }
}
