package ai.ash.host.cap

import java.util.TimeZone
import org.json.JSONObject

data class CalendarSearchArgs(val start: Long, val end: Long, val query: String, val limit: Int)
data class CalendarCreateArgs(val calendarId: Long, val title: String, val start: Long, val end: Long,
    val description: String?, val location: String?, val zone: String)

/** Parse every field before invoking the calendar provider; JSONObject opt* coercion is not validation. */
object CalendarArguments {
    private const val MAX_SAFE = 9_007_199_254_740_991L
    private const val DAY_MS = 86_400_000L
    private val zones by lazy { TimeZone.getAvailableIDs().toSet() }

    private fun integer(value: Any?): Long? {
        if (value !is Number) return null
        val number = value.toDouble()
        if (!number.isFinite() || number < 0 || number > MAX_SAFE.toDouble() || number % 1.0 != 0.0) return null
        val asLong = number.toLong()
        return if (asLong <= MAX_SAFE && value.toString().toBigDecimalOrNull()?.compareTo(asLong.toBigDecimal()) == 0) asLong else null
    }

    private fun keysOnly(input: JSONObject, allowed: Set<String>): Boolean = input.keys().asSequence().all { it in allowed }
    private fun optionalText(input: JSONObject, key: String): String? = if (!input.has(key)) null else input.opt(key) as? String

    fun <T> search(input: JSONObject, now: Long, provider: (CalendarSearchArgs) -> T, invalid: (String) -> T): T {
        if (!keysOnly(input, setOf("start_ms", "end_ms", "query", "limit"))) return invalid("calendar.search has unsupported fields")
        val start = if (input.has("start_ms")) integer(input.opt("start_ms")) else now
        if (start == null || start < 0 || start > MAX_SAFE - 7 * DAY_MS) return invalid("calendar.search start_ms must be a safe nonnegative integer")
        val end = if (input.has("end_ms")) integer(input.opt("end_ms")) else start + 7 * DAY_MS
        if (end == null || end <= start || end - start > 366 * DAY_MS) return invalid("calendar.search needs a positive window of at most 366 days")
        val limit = if (input.has("limit")) integer(input.opt("limit")) else 20L
        if (limit == null || limit !in 1..50) return invalid("calendar.search limit must be an integer from 1 to 50")
        val query = optionalText(input, "query")
        if (input.has("query") && query == null) return invalid("calendar.search query must be text")
        return provider(CalendarSearchArgs(start, end, query?.trim()?.lowercase() ?: "", limit.toInt()))
    }

    /** calendar.list takes no arguments: anything given is refused rather than ignored. */
    fun <T> list(input: JSONObject, provider: () -> T, invalid: (String) -> T): T =
        if (input.length() == 0) provider() else invalid("calendar.list takes no arguments")

    /**
     * One calendar as calendar.list returns it. [accessLevel] is the provider's CALENDAR_ACCESS_LEVEL: contributor (500)
     * and above may add events, which is what calendar.create needs.
     */
    fun calendar(id: Long, name: String?, account: String?, accessLevel: Int, visible: Boolean, primary: Boolean): JSONObject =
        JSONObject().put("id", id).put("name", name.orEmpty()).put("account", account.orEmpty())
            .put("writable", accessLevel >= CONTRIBUTOR).put("visible", visible).put("primary", primary)

    /** CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR. */
    const val CONTRIBUTOR = 500

    fun <T> create(input: JSONObject, provider: (CalendarCreateArgs) -> T, invalid: (String) -> T): T {
        if (!keysOnly(input, setOf("calendar_id", "title", "start_ms", "end_ms", "description", "location", "time_zone")))
            return invalid("calendar.create has unsupported fields")
        val id = integer(input.opt("calendar_id"))
        val title = (input.opt("title") as? String)?.trim()
        val start = integer(input.opt("start_ms"))
        val end = integer(input.opt("end_ms"))
        if (id == null || id < 1 || title.isNullOrEmpty() || start == null || end == null || end <= start)
            return invalid("calendar.create needs integer calendar_id, text title and valid integer start/end")
        val description = optionalText(input, "description")
        val location = optionalText(input, "location")
        if ((input.has("description") && description == null) || (input.has("location") && location == null))
            return invalid("calendar.create description/location must be text")
        val zone = if (input.has("time_zone")) optionalText(input, "time_zone") else TimeZone.getDefault().id
        if (zone == null || zone !in zones) return invalid("calendar.create time_zone is unknown")
        return provider(CalendarCreateArgs(id, title, start, end, description, location, zone))
    }
}
