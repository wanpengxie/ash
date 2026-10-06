package ai.ash.senses

import ai.ash.host.cap.Cap
import ai.ash.host.cap.CapResult
import ai.ash.host.cap.Capability
import ai.ash.host.cap.prop
import ai.ash.host.cap.schema
import ai.ash.senses.health.GadgetbridgeSource
import ai.ash.senses.health.HealthHub
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * The helper's tools, as Ash lists them for its agents. Reads answer from what was recorded or from the sources right
 * now; anything that changes what is recorded goes through Ash's approval (Ash sets each tool's policy). A tool that
 * cannot answer says why with a code; it never makes data up.
 */
object SenseCapabilities {
    private const val DAY = SenseArgs.DAY_MS
    private fun range(desc: String) = arrayOf(
        "from" to prop("string", "Start: ISO-8601 date/time or epoch ms. Default: $desc before `to`."),
        "to" to prop("string", "End: ISO-8601 date/time or epoch ms. Default: now."),
    )
    private fun arrayProp(description: String, items: JSONObject) = JSONObject().put("type", "array").put("description", description).put("items", items)
    private val geofenceItem = schema(
        "name" to prop("string", "Name of the place, e.g. home, office", required = true),
        "lat" to prop("number", "Latitude", required = true),
        "lon" to prop("number", "Longitude", required = true),
        "radius_m" to prop("number", "Radius in metres (20 to 50000)", required = true),
    )

    private fun now() = System.currentTimeMillis()

    val list: List<Capability> = listOf(
        Cap("location.get", "The phone's location now (one fresh fix; nothing is stored unless recording is on). Errors: permission_denied, location_off, no_fix.",
            schema(
                "accuracy" to prop("string", "high (GPS), balanced (default) or low (network)", enum = SenseConfig.ACCURACIES),
                "timeout_s" to prop("integer", "Seconds to wait for a fix (5 to 120, default 30)"),
            )) { ctx, args ->
            SenseArgs.only(args, setOf("accuracy", "timeout_s"))
            val accuracy = args.opt("accuracy") as? String ?: Senses.config(ctx).accuracy
            if (accuracy !in SenseConfig.ACCURACIES) throw SenseError.badArgs("accuracy must be one of ${SenseConfig.ACCURACIES.joinToString()}")
            val timeout = SenseArgs.limit(args, "timeout_s", 30, 120).coerceAtLeast(5)
            val fix = LocationReader.fix(ctx, accuracy, timeout * 1000L)
            CapResult.json(fix.toJson().put("timestamp", fix.ts).put("age_s", (now() - fix.ts) / 1000))
        },
        Cap("location.track", "Turn location and motion recording on or off. While on, the companion app keeps a notification with a stop button, takes a point when movement starts or stops and every interval_min minutes (still or moving), and pushes new points to Ash. Errors: permission_denied.",
            schema(
                "on" to prop("boolean", "true to record, false to stop", required = true),
                "interval_min" to prop("integer", "Minutes between points (${SenseConfig.MIN_INTERVAL} to ${SenseConfig.MAX_INTERVAL}, default 30)"),
            )) { ctx, args ->
            SenseArgs.only(args, setOf("on", "interval_min"))
            val c = JSONObject().put("recording", SenseArgs.bool(args, "on"))
            if (args.has("interval_min")) c.put("interval_min", args.get("interval_min"))
            configure(ctx, c)
        },
        Cap("location.history", "Recorded location points in a time range (default: the last 24 hours), thinned evenly to max_points.",
            schema(*range("24 hours"), "max_points" to prop("integer", "At most this many points (1 to 5000, default 500)"))) { ctx, args ->
            SenseArgs.only(args, setOf("from", "to", "max_points"))
            val r = SenseArgs.range(args, now(), DAY)
            val max = SenseArgs.limit(args, "max_points", 500, 5000)
            val all = Senses.store.fixes(r)
            val points = Batches.thin(all, max)
            CapResult.json(JSONObject().put("from", r.first).put("to", r.last + 1).put("recording", Senses.config(ctx).recording)
                .put("total", all.size).put("returned", points.size).put("points", JSONArray().apply { points.forEach { put(it.toJson()) } }))
        },
        Cap("activity.current", "What the owner is doing now (still, walking, running, cycling, in_vehicle) and since when, from step cadence and location speed. Needs recording on. Errors: not_recording.") { ctx, args ->
            SenseArgs.only(args, emptySet())
            if (!Senses.config(ctx).recording) throw SenseError("not_recording", "motion is only followed while recording is on (location.track or sense.configure)")
            val current = Recorder.sampler?.current() ?: Senses.store.openSegment()?.toJson()?.let { JSONObject().put("state", it.getString("state")).put("since", it.getLong("ts_start")) }
            CapResult.json(current ?: JSONObject().put("state", JSONObject.NULL).put("reason", "recording just started: no motion data yet"))
        },
        Cap("activity.history", "Recorded activity segments (still, walking, running, cycling, in_vehicle) in a time range (default: the last 24 hours), with minutes per state.",
            schema(*range("24 hours"))) { ctx, args ->
            SenseArgs.only(args, setOf("from", "to"))
            val r = SenseArgs.range(args, now(), DAY)
            val segs = Senses.store.segments(r)
            val minutes = linkedMapOf<String, Double>()
            for (s in segs) {
                val a = maxOf(s.start, r.first); val b = minOf(s.end ?: now(), r.last + 1)
                if (b > a) minutes[s.state] = (minutes[s.state] ?: 0.0) + (b - a) / 60_000.0
            }
            CapResult.json(JSONObject().put("from", r.first).put("to", r.last + 1).put("recording", Senses.config(ctx).recording)
                .put("segments", JSONArray().apply { segs.forEach { put(it.toJson()) } })
                .put("minutes", JSONObject().apply { minutes.forEach { (k, v) -> put(k, Math.round(v * 10) / 10.0) } }))
        },
        Cap("sensors.steps", "Steps today from the phone's step counter. A complete count needs recording on since midnight; otherwise `complete` is false and `since` says from when it counts. Errors: permission_denied, source_unavailable.") { ctx, args ->
            SenseArgs.only(args, emptySet())
            val now = StepReader.read(ctx)
            if (Senses.config(ctx).recording) Senses.store.addSteps(now)
            val dayStart = SenseArgs.startOfDay(now.ts)
            val snaps = listOfNotNull(Senses.store.stepsBefore(dayStart)) + Senses.store.steps(dayStart..now.ts) + now
            val today = StepMath.today(snaps.distinct(), dayStart, now.ts)
            val o = JSONObject().put("counter", now.counter).put("ts", now.ts)
            if (today == null || (today.steps == 0L && !today.complete)) o.put("steps_today", JSONObject.NULL).put("complete", false)
                .put("reason", "no earlier step-counter reading today: turn recording on to count from midnight")
            else o.put("steps_today", today.steps).put("since", today.since).put("complete", today.complete)
            CapResult.json(o)
        },
        Cap("health.sources", "Health data sources and their state: Health Connect (installed, which permissions granted) and Gadgetbridge (installed, export folder granted, newest export, recognised metrics).") { ctx, args ->
            SenseArgs.only(args, emptySet())
            CapResult.json(JSONObject().put("sources", HealthHub.sources(ctx)))
        },
        Cap("health.read", "Health readings in a time range (default: the last 7 days): rows {ts, metric, value, unit, source}. Metrics: ${HealthMetric.names.joinToString()}. Read only. Errors: permission_denied, source_unavailable, unsupported_schema.",
            schema(
                "metrics" to arrayProp("Metrics to read (default: all)", JSONObject().put("type", "string").put("enum", JSONArray(HealthMetric.names))),
                *range("7 days"),
                "sources" to arrayProp("Sources to read (default: all)", JSONObject().put("type", "string").put("enum", JSONArray(HealthHub.SOURCES))),
                "max_rows" to prop("integer", "At most this many rows (1 to 20000, default 2000)"),
            )) { ctx, args ->
            SenseArgs.only(args, setOf("metrics", "from", "to", "sources", "max_rows"))
            val metrics = SenseArgs.metrics(args)
            val r = SenseArgs.range(args, now(), 7 * DAY)
            val max = SenseArgs.limit(args, "max_rows", 2000, 20_000)
            val reading = HealthHub.read(ctx, metrics, r, sources(args), max)
            CapResult.json(JSONObject().put("from", r.first).put("to", r.last + 1).put("rows", JSONArray().apply { reading.rows.forEach { put(it.toJson()) } })
                .apply { if (reading.errors.length() > 0) put("source_errors", reading.errors) })
        },
        Cap("health.summary", "A day's or a week's health in a few numbers (steps, heart rate, sleep, weight, ...), computed by rule from health.read.",
            schema(
                "period" to prop("string", "day (default) or week (the 7 days ending with date)", enum = listOf("day", "week")),
                "date" to prop("string", "YYYY-MM-DD (default: today)"),
            )) { ctx, args ->
            SenseArgs.only(args, setOf("period", "date"))
            val (period, r) = SenseArgs.summaryRange(args, now())
            val reading = HealthHub.read(ctx, HealthMetric.names, r, HealthHub.SOURCES, 200_000)
            CapResult.json(JSONObject().put("period", period).put("from", r.first).put("to", r.last + 1).put("summary", HealthSummary.of(reading.rows, r))
                .apply { if (reading.errors.length() > 0) put("source_errors", reading.errors) })
        },
        Cap("health.sync", "Ask Gadgetbridge to fetch new data from the watch and export its database now, and wait (up to 90 s) for the export. Needs Gadgetbridge's Intent API enabled. Errors: source_unavailable, timeout.") { ctx, args ->
            SenseArgs.only(args, emptySet())
            val result = GadgetbridgeSource.sync(ctx)
            if (Senses.config(ctx).recording) ai.ash.senses.health.HealthImport.run(ctx)
            CapResult.json(result)
        },
        Cap("sense.status", "The companion app's state: recording on/off and its settings, permissions granted, location on, batches waiting for Ash, stored rows per kind.") { ctx, args ->
            SenseArgs.only(args, emptySet())
            CapResult.json(AshLink.status(ctx).put("stored", Senses.store.counts()))
        },
        Cap("sense.configure", "Change what is recorded: recording on/off, interval_min, accuracy (high|balanced|low), retention_days, geofences (named circles; crossing one is reported to Ash). Only the given keys change. Errors: permission_denied, bad_args.",
            schema(
                "recording" to prop("boolean", "Record location and motion"),
                "interval_min" to prop("integer", "Minutes between points (${SenseConfig.MIN_INTERVAL} to ${SenseConfig.MAX_INTERVAL})"),
                "accuracy" to prop("string", "Location accuracy", enum = SenseConfig.ACCURACIES),
                "retention_days" to prop("integer", "Days to keep recorded rows (1 to ${SenseConfig.MAX_RETENTION})"),
                "geofences" to arrayProp("All geofences (replaces the list; [] removes them)", geofenceItem),
            )) { ctx, args -> configure(ctx, args) },
        Cap("sense.delete", "Delete recorded rows of a kind (location, activity, steps, health, all) in a time range (default: everything), including rows not yet delivered to Ash.",
            schema(
                "kind" to prop("string", "What to delete", required = true, enum = SenseArgs.DELETE_KINDS),
                "from" to prop("string", "Start: ISO-8601 date/time or epoch ms (default: the beginning)"),
                "to" to prop("string", "End: ISO-8601 date/time or epoch ms (default: now and later)"),
            )) { ctx, args ->
            SenseArgs.only(args, setOf("kind", "from", "to"))
            val kind = SenseArgs.deleteKind(args)
            val r = SenseArgs.deleteRange(args)
            val n = Senses.store.delete(kind, r)
            if (kind == "location" || kind == "all") Senses.prefs(ctx).edit().remove("geofence_inside").apply()
            CapResult.json(JSONObject().put("kind", kind).put("deleted", n))
        },
    )

    private fun sources(args: JSONObject): List<String> {
        if (!args.has("sources") || args.isNull("sources")) return HealthHub.SOURCES
        val a = args.opt("sources") as? JSONArray ?: throw SenseError.badArgs("sources must be an array of ${HealthHub.SOURCES.joinToString()}")
        val out = (0 until a.length()).map { a.opt(it) as? String ?: "" }
        if (out.isEmpty() || out.any { it !in HealthHub.SOURCES }) throw SenseError.badArgs("sources must name some of ${HealthHub.SOURCES.joinToString()}")
        return out.distinct()
    }

    /** sense.configure (and location.track): checked, saved, applied. */
    fun configure(ctx: Context, args: JSONObject): CapResult {
        val before = Senses.config(ctx)
        val next = SenseConfig.apply(before, args)
        if (next.recording && !before.recording && !Senses.locationPermission(ctx))
            throw SenseError("permission_denied", "location permission is not granted to Ash 感知: the owner grants it on its setup page")
        val warnings = JSONArray()
        if (next.recording && !Senses.backgroundLocation(ctx)) warnings.put("background location is not allowed: no points while the phone is locked (set location to 「始终允许」)")
        if (next.recording && !Senses.locationOn(ctx)) warnings.put("location_off: location is turned off; points start once it is on")
        if (next.recording && !Senses.activityRecognition(ctx)) warnings.put("physical activity is not granted: no steps, motion from location speed only")
        Senses.configure(ctx, next)?.let { warnings.put(it) }
        return CapResult.json(JSONObject().put("config", next.toJson()).apply { if (warnings.length() > 0) put("warnings", warnings) })
    }
}
