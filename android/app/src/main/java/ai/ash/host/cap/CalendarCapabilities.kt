package ai.ash.host.cap

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
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
        CalendarArguments.search(args, System.currentTimeMillis(), provider@{ input ->
            val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also { ContentUris.appendId(it, input.start); ContentUris.appendId(it, input.end) }.build()
            val columns = arrayOf(CalendarContract.Instances.EVENT_ID, CalendarContract.Instances.TITLE,
                CalendarContract.Instances.BEGIN, CalendarContract.Instances.END, CalendarContract.Instances.EVENT_LOCATION,
                CalendarContract.Instances.CALENDAR_ID)
            val events = JSONArray()
            val cursor = ctx.contentResolver.query(uri, columns, null, null, "${CalendarContract.Instances.BEGIN} ASC")
                ?: return@provider CapResult.fail("calendar provider unavailable")
            cursor.use {
                while (it.moveToNext() && events.length() < input.limit) {
                    val title = it.getString(1) ?: ""
                    val location = it.getString(4) ?: ""
                    if (input.query.isNotEmpty() && !title.lowercase().contains(input.query) && !location.lowercase().contains(input.query)) continue
                    events.put(JSONObject().put("id", it.getLong(0)).put("title", title)
                        .put("start_ms", it.getLong(2)).put("end_ms", it.getLong(3))
                        .put("location", location).put("calendar_id", it.getLong(5)))
                }
            }
            CapResult.json(JSONObject().put("events", events).put("count", events.length()))
        }, CapResult::fail)
    }

    private val calendars = Cap(
        name = "calendar.list",
        description = "List the owner's phone calendars: ID, name, account, whether events can be added to it (writable), shown, primary. Use an ID from here as calendar.create's calendar_id. Requires calendar read permission; it does not change anything.",
        schema = schema(),
        availableIf = ::canRead,
    ) { ctx, args ->
        CalendarArguments.list(args, provider@{
            val columns = arrayOf(CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_DISPLAY_NAME,
                CalendarContract.Calendars.ACCOUNT_NAME, CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL,
                CalendarContract.Calendars.VISIBLE, CalendarContract.Calendars.IS_PRIMARY)
            val found = JSONArray()
            val cursor = ctx.contentResolver.query(CalendarContract.Calendars.CONTENT_URI, columns, null, null, "${CalendarContract.Calendars._ID} ASC")
                ?: return@provider CapResult.fail("calendar provider unavailable")
            cursor.use {
                while (it.moveToNext() && found.length() < 100)
                    found.put(CalendarArguments.calendar(it.getLong(0), it.getString(1), it.getString(2), it.getInt(3), it.getInt(4) == 1, !it.isNull(5) && it.getInt(5) == 1))
            }
            CapResult.json(JSONObject().put("calendars", found).put("count", found.length()))
        }, CapResult::fail)
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
        CalendarArguments.create(args, provider@{ input ->
            val writable = ctx.contentResolver.query(CalendarContract.Calendars.CONTENT_URI,
                arrayOf(CalendarContract.Calendars._ID),
                "${CalendarContract.Calendars._ID}=? AND ${CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL}>=?",
                arrayOf(input.calendarId.toString(), CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR.toString()), null)?.use { it.moveToFirst() } ?: false
            if (!writable) return@provider CapResult.fail("selected calendar is unavailable or read-only")
            val values = ContentValues().apply {
                put(CalendarContract.Events.CALENDAR_ID, input.calendarId)
                put(CalendarContract.Events.TITLE, input.title)
                put(CalendarContract.Events.DTSTART, input.start)
                put(CalendarContract.Events.DTEND, input.end)
                put(CalendarContract.Events.EVENT_TIMEZONE, input.zone)
                if (input.description != null) put(CalendarContract.Events.DESCRIPTION, input.description)
                if (input.location != null) put(CalendarContract.Events.EVENT_LOCATION, input.location)
            }
            val uri = ctx.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values)
                ?: return@provider CapResult.fail("calendar provider did not create the event")
            CapResult.json(JSONObject().put("id", ContentUris.parseId(uri)).put("calendar_id", input.calendarId))
        }, CapResult::fail)
    }

    val list: List<Capability> = listOf(search, calendars, create)
}
