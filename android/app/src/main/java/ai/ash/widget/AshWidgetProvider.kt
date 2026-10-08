package ai.ash.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews
import ai.ash.R
import ai.ash.host.TaskStatus
import ai.ash.ui.HomeActivity

/** The "Ash" widget: Ash's face, one status line, what the owner has not seen yet, and "跟 Ash 说". */
class AshWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, manager: AppWidgetManager, ids: IntArray) {
        val view = TaskStatus.widgetView()
        for (id in ids) draw(ctx, manager, id, view)
        WidgetHost.reportPlaced(ctx)
    }

    override fun onAppWidgetOptionsChanged(ctx: Context, manager: AppWidgetManager, id: Int, options: Bundle) {
        draw(ctx, manager, id, TaskStatus.widgetView())
    }

    override fun onDeleted(ctx: Context, ids: IntArray) { WidgetHost.reportPlaced(ctx) }

    companion object {
        @Volatile private var lastKey: String? = null
        private val items = intArrayOf(R.id.ash_item1, R.id.ash_item2, R.id.ash_item3)

        /** Called with every island render; redraws only when what the widget shows changed. Main thread. */
        fun refresh(ctx: Context, view: AshWidgetView) {
            if (view.key == lastKey) return
            val manager = AppWidgetManager.getInstance(ctx)
            val ids = runCatching { manager.getAppWidgetIds(ComponentName(ctx, AshWidgetProvider::class.java)) }.getOrNull() ?: return
            lastKey = view.key
            for (id in ids) draw(ctx, manager, id, view)
        }

        private fun open(ctx: Context, code: Int, focus: Boolean): PendingIntent = PendingIntent.getActivity(ctx, code,
            Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .apply { if (focus) putExtra(HomeActivity.EXTRA_FOCUS_INPUT, true) },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        private fun draw(ctx: Context, manager: AppWidgetManager, id: Int, view: AshWidgetView) {
            val width = runCatching { manager.getAppWidgetOptions(id).getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH) }.getOrDefault(0)
            val small = width in 1..199
            val rv = RemoteViews(ctx.packageName, if (small) R.layout.widget_ash_small else R.layout.widget_ash)
            WidgetHost.face(ctx, view.avatar)?.let { rv.setImageViewBitmap(R.id.ash_face, it) } ?: rv.setImageViewResource(R.id.ash_face, R.drawable.ic_launcher)
            rv.setTextViewText(R.id.ash_status, CardText.markdown(view.status))
            if (view.since != null) {
                rv.setChronometer(R.id.ash_clock, SystemClock.elapsedRealtime() - (System.currentTimeMillis() - view.since).coerceAtLeast(0), null, true)
                rv.setViewVisibility(R.id.ash_clock, View.VISIBLE)
            } else {
                rv.setChronometer(R.id.ash_clock, SystemClock.elapsedRealtime(), null, false)
                rv.setViewVisibility(R.id.ash_clock, View.GONE)
            }
            rv.setOnClickPendingIntent(R.id.ash_root, open(ctx, 9001, false))
            if (small) {
                rv.setTextViewText(R.id.ash_count, if (view.items.isEmpty()) "" else "${view.items.size} 条待看")
                rv.setViewVisibility(R.id.ash_count, if (view.items.isEmpty()) View.GONE else View.VISIBLE)
            } else {
                for ((i, res) in items.withIndex()) {
                    val item = view.items.getOrNull(i)
                    rv.setViewVisibility(res, if (item == null) View.GONE else View.VISIBLE)
                    rv.setTextViewText(res, CardText.markdown(item?.text ?: ""))
                }
                rv.setViewVisibility(R.id.ash_empty, if (view.items.isEmpty()) View.VISIBLE else View.GONE)
                rv.setOnClickPendingIntent(R.id.ash_say, open(ctx, 9002, true))
            }
            runCatching { manager.updateAppWidget(id, rv) }
        }
    }
}
