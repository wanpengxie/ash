package ai.ash.host.cap

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/** Calendar reads and writes use only Android's calendar provider after the owner grants permission. */
object CalendarCapabilities {
    private fun canRead(ctx: Context) = ctx.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED
    private fun canWrite(ctx: Context) = ctx.checkSelfPermission(Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED

    private val search = Cap(
        name = "calendar.search",
        description = "Find events in the owner's phone calendar within a time window. Requires calendar read permission. Returns titles, times, locations and provider IDs; it does not change events.",
        schema = schema(
            "start_ms" to prop("integer", "Window start as Unix milliseconds (default now)."),
            "end_ms" to prop("integer", "Window end as Unix milliseconds (default seven days after start)."),
            "query" to prop("string", "Optional case-insensitive title or location filter."),
            "limit" to prop("integer", "Maximum matching events, 1–50 (default 20)."),
        ),
        availableIf = ::canRead,
    ) { ctx, args ->
        val start = args.optLong("start_ms", System.currentTimeMillis())
        val end = args.optLong("end_ms", start + 7L * 24 * 60 * 60 * 1000)
        if (end <= start || end - start > 366L * 24 * 60 * 60 * 1000) return@Cap CapResult.fail("calendar.search needs a positive window of at most 366 days")
        val limit = args.optInt("limit", 20)
        if (limit !in 1..50) return@Cap CapResult.fail("calendar.search limit must be 1–50")
        val query = args.optString("query").trim().lowercase()
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also { ContentUris.appendId(it, start); ContentUris.appendId(it, end) }.build()
        val columns = arrayOf(CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN, CalendarContract.Instances.END, CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.CALENDAR_ID)
        val events = JSONArray()
        ctx.contentResolver.query(uri, columns, null, null, "${CalendarContract.Instances.BEGIN} ASC")?.use { cursor ->
            while (cursor.moveToNext() && events.length() < limit) {
                val title = cursor.getString(1) ?: ""
                val location = cursor.getString(4) ?: ""
                if (query.isNotEmpty() && !title.lowercase().contains(query) && !location.lowercase().contains(query)) continue
                events.put(JSONObject().put("id", cursor.getLong(0)).put("title", title)
                    .put("start_ms", cursor.getLong(2)).put("end_ms", cursor.getLong(3))
                    .put("location", location).put("calendar_id", cursor.getLong(5)))
            }
        } ?: return@Cap CapResult.fail("calendar provider unavailable")
        CapResult.json(JSONObject().put("events", events).put("count", events.length()))
    }

    private val create = Cap(
        name = "calendar.create",
        description = "Add one event to a selected writable phone calendar. This changes the owner's calendar and must be approved before the call. Requires calendar write permission.",
        schema = schema(
            "calendar_id" to prop("integer", "ID of the writable calendar chosen by the owner.", required = true),
            "title" to prop("string", "Event title.", required = true),
            "start_ms" to prop("integer", "Start as Unix milliseconds.", required = true),
            "end_ms" to prop("integer", "End as Unix milliseconds, after start.", required = true),
            "description" to prop("string", "Optional event description."),
            "location" to prop("string", "Optional location."),
            "time_zone" to prop("string", "IANA time zone (default phone's current time zone)."),
        ),
        availableIf = { canRead(it) && canWrite(it) },
    ) { ctx, args ->
        val calendarId = args.optLong("calendar_id", -1)
        val title = args.optString("title").trim()
        val start = args.optLong("start_ms", -1)
        val end = args.optLong("end_ms", -1)
        if (calendarId < 0 || title.isEmpty() || start < 0 || end <= start) return@Cap CapResult.fail("calendar.create needs calendar_id, title and valid start/end")
        val zone = args.optString("time_zone").ifBlank { TimeZone.getDefault().id }
        if (zone !in TimeZone.getAvailableIDs()) return@Cap CapResult.fail("calendar.create time_zone is unknown")
        val writable = ctx.contentResolver.query(CalendarContract.Calendars.CONTENT_URI,
            arrayOf(CalendarContract.Calendars._ID),
            "${CalendarContract.Calendars._ID}=? AND ${CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL}>=?",
            arrayOf(calendarId.toString(), CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR.toString()), null)?.use { it.moveToFirst() } ?: false
        if (!writable) return@Cap CapResult.fail("selected calendar is unavailable or read-only")
        val values = ContentValues().apply {
            put(CalendarContract.Events.CALENDAR_ID, calendarId)
            put(CalendarContract.Events.TITLE, title)
            put(CalendarContract.Events.DTSTART, start)
            put(CalendarContract.Events.DTEND, end)
            put(CalendarContract.Events.EVENT_TIMEZONE, zone)
            if (args.has("description")) put(CalendarContract.Events.DESCRIPTION, args.optString("description"))
            if (args.has("location")) put(CalendarContract.Events.EVENT_LOCATION, args.optString("location"))
        }
        val uri = ctx.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
            ?: return@Cap CapResult.fail("calendar provider did not create the event")
        CapResult.json(JSONObject().put("id", ContentUris.parseId(uri)).put("calendar_id", calendarId))
    }

    val list: List<Capability> = listOf(search, create)
}
