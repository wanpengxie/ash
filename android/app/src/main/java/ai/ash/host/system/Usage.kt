package ai.ash.host.system

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Process
import java.util.Calendar

/** App usage time (needs the "usage access" special permission, granted by the owner in system settings). */
object Usage {
    class Entry(val pkg: String, var foregroundMs: Long, var lastUsed: Long)

    fun granted(ctx: Context): Boolean = try {
        val ops = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        @Suppress("DEPRECATION")
        ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName) == AppOpsManager.MODE_ALLOWED
    } catch (e: Throwable) { false }

    /** Local midnight [days]-1 days ago (days = 1 → since today's midnight). */
    fun startOfRange(days: Int): Long = Calendar.getInstance().apply {
        set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        add(Calendar.DAY_OF_YEAR, -(days - 1))
    }.timeInMillis

    /**
     * Foreground time per package in [start, end]. Up to 7 days it is computed from activity
     * resume/pause events (exact, clipped to the range); beyond that the system keeps only daily
     * aggregates, so the aggregated totals are used (buckets may reach a little outside the range).
     */
    fun query(ctx: Context, start: Long, end: Long): List<Entry> {
        val usm = ctx.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        val map = HashMap<String, Entry>()
        fun e(p: String) = map.getOrPut(p) { Entry(p, 0, 0) }
        if (end - start <= 7L * 24 * 3600 * 1000) {
            val events = usm.queryEvents(start, end)
            val fgSince = HashMap<String, Long>()
            val ev = UsageEvents.Event()
            val seen = HashSet<String>()
            while (events.hasNextEvent()) {
                events.getNextEvent(ev)
                val p = ev.packageName ?: continue
                val t = ev.timeStamp
                @Suppress("DEPRECATION")
                when (ev.eventType) {
                    UsageEvents.Event.MOVE_TO_FOREGROUND -> { // == ACTIVITY_RESUMED
                        seen.add(p)
                        if (!fgSince.containsKey(p)) fgSince[p] = t
                        val x = e(p); x.lastUsed = maxOf(x.lastUsed, t)
                    }
                    UsageEvents.Event.MOVE_TO_BACKGROUND -> { // == ACTIVITY_PAUSED
                        // A pause with no resume before it: the app was already in front when the range began.
                        val s = fgSince.remove(p) ?: if (seen.add(p)) start else null
                        if (s != null) { val x = e(p); x.foregroundMs += (t - s).coerceAtLeast(0); x.lastUsed = maxOf(x.lastUsed, t) }
                    }
                }
            }
            for ((p, s) in fgSince) e(p).foregroundMs += (end - s).coerceAtLeast(0)
        } else {
            for ((p, st) in usm.queryAndAggregateUsageStats(start, end)) {
                val x = e(p)
                x.foregroundMs += st.totalTimeInForeground
                x.lastUsed = maxOf(x.lastUsed, st.lastTimeUsed)
            }
        }
        return map.values.filter { it.foregroundMs >= 1000 }.sortedByDescending { it.foregroundMs }
    }
}
