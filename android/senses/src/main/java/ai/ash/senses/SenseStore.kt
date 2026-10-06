package ai.ash.senses

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject
import java.util.UUID

/** A location point as stored. */
data class Fix(val ts: Long, val lat: Double, val lon: Double, val accuracyM: Double, val provider: String, val mocked: Boolean, val speed: Double?) {
    fun sample() = FixSample(ts, lat, lon, accuracyM, speed)
    fun toJson(): JSONObject = JSONObject().put("ts", ts).put("lat", lat).put("lon", lon).put("accuracy_m", accuracyM).put("provider", provider)
        .put("is_mocked", mocked).apply { if (speed != null) put("speed_mps", speed) }
    /** The sense.location item: {ts, lat, lon, accuracy_m, provider, is_mocked?}. */
    fun toEvent(): JSONObject = JSONObject().put("ts", ts).put("lat", lat).put("lon", lon).put("accuracy_m", accuracyM).put("provider", provider)
        .apply { if (mocked) put("is_mocked", true) }
}

data class Segment(val id: Long, val start: Long, val end: Long?, val state: String) {
    fun toJson(): JSONObject = JSONObject().put("ts_start", start).put("state", state).apply { if (end != null) put("ts_end", end) }
}

/** An undelivered batch for Ash. */
data class Batch(val id: String, val word: String, val body: JSONObject, val created: Long, val sentAt: Long)

/**
 * Everything the helper recorded, on this phone only: location points, activity segments, step-counter snapshots,
 * health readings, and the batches waiting for Ash. Rows not yet handed to Ash are marked pushed = 0.
 */
class SenseStore(ctx: Context) : SQLiteOpenHelper(ctx, "senses.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE location (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, accuracy_m REAL NOT NULL, provider TEXT NOT NULL, mocked INTEGER NOT NULL, speed REAL, pushed INTEGER NOT NULL DEFAULT 0)")
        db.execSQL("CREATE INDEX location_ts ON location(ts)")
        db.execSQL("CREATE TABLE activity (id INTEGER PRIMARY KEY, ts_start INTEGER NOT NULL, ts_end INTEGER, state TEXT NOT NULL, pushed INTEGER NOT NULL DEFAULT 0)")
        db.execSQL("CREATE INDEX activity_ts ON activity(ts_start)")
        db.execSQL("CREATE TABLE steps (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, counter INTEGER NOT NULL, boot INTEGER NOT NULL)")
        db.execSQL("CREATE INDEX steps_ts ON steps(ts)")
        db.execSQL("CREATE TABLE health (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, metric TEXT NOT NULL, value REAL NOT NULL, source TEXT NOT NULL, ts_end INTEGER, kind TEXT NOT NULL DEFAULT '', pushed INTEGER NOT NULL DEFAULT 0, UNIQUE(ts, metric, source, kind))")
        db.execSQL("CREATE INDEX health_ts ON health(ts)")
        db.execSQL("CREATE TABLE outbox (id TEXT PRIMARY KEY, word TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL, sent_at INTEGER NOT NULL DEFAULT 0)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    // ---- location ----

    fun addFix(f: Fix) {
        writableDatabase.insert("location", null, ContentValues().apply {
            put("ts", f.ts); put("lat", f.lat); put("lon", f.lon); put("accuracy_m", f.accuracyM); put("provider", f.provider)
            put("mocked", if (f.mocked) 1 else 0); if (f.speed != null) put("speed", f.speed)
        })
    }

    fun fixes(range: LongRange): List<Fix> =
        readableDatabase.rawQuery("SELECT ts, lat, lon, accuracy_m, provider, mocked, speed FROM location WHERE ts >= ? AND ts <= ? ORDER BY ts",
            arrayOf(range.first.toString(), range.last.toString())).use { c -> c.all { fix(it) } }

    fun lastFix(): Fix? = readableDatabase.rawQuery("SELECT ts, lat, lon, accuracy_m, provider, mocked, speed FROM location ORDER BY ts DESC LIMIT 1", null)
        .use { c -> if (c.moveToFirst()) fix(c) else null }

    private fun fix(c: Cursor) = Fix(c.getLong(0), c.getDouble(1), c.getDouble(2), c.getDouble(3), c.getString(4), c.getInt(5) != 0,
        if (c.isNull(6)) null else c.getDouble(6))

    // ---- activity segments ----

    fun openSegment(): Segment? = readableDatabase.rawQuery("SELECT id, ts_start, ts_end, state FROM activity WHERE ts_end IS NULL ORDER BY ts_start DESC LIMIT 1", null)
        .use { c -> if (c.moveToFirst()) segment(c) else null }

    /** Closes the open segment at [ts] and opens one in [state] (none when null). A closed segment is pushed again, with its end. */
    fun switchSegment(state: String?, ts: Long) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.execSQL("UPDATE activity SET ts_end = ?, pushed = 0 WHERE ts_end IS NULL", arrayOf<Any>(ts))
            if (state != null) db.insert("activity", null, ContentValues().apply { put("ts_start", ts); put("state", state) })
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    fun segments(range: LongRange): List<Segment> =
        readableDatabase.rawQuery("SELECT id, ts_start, ts_end, state FROM activity WHERE ts_start <= ? AND (ts_end IS NULL OR ts_end >= ?) ORDER BY ts_start",
            arrayOf(range.last.toString(), range.first.toString())).use { c -> c.all { segment(it) } }

    private fun segment(c: Cursor) = Segment(c.getLong(0), c.getLong(1), if (c.isNull(2)) null else c.getLong(2), c.getString(3))

    // ---- steps ----

    fun addSteps(s: StepSample) {
        writableDatabase.insert("steps", null, ContentValues().apply { put("ts", s.ts); put("counter", s.counter); put("boot", s.boot) })
    }

    fun steps(range: LongRange): List<StepSample> =
        readableDatabase.rawQuery("SELECT ts, counter, boot FROM steps WHERE ts >= ? AND ts <= ? ORDER BY ts", arrayOf(range.first.toString(), range.last.toString()))
            .use { c -> c.all { StepSample(it.getLong(0), it.getLong(1), it.getInt(2)) } }

    /** The latest snapshot before [ts]: the baseline a day's count starts from. */
    fun stepsBefore(ts: Long): StepSample? = readableDatabase.rawQuery("SELECT ts, counter, boot FROM steps WHERE ts < ? ORDER BY ts DESC LIMIT 1", arrayOf(ts.toString()))
        .use { c -> if (c.moveToFirst()) StepSample(c.getLong(0), c.getLong(1), c.getInt(2)) else null }

    fun lastSteps(): StepSample? = stepsBefore(Long.MAX_VALUE)

    // ---- health ----

    /** Readings not seen before; returns how many were new. */
    fun addHealth(rows: List<HealthRow>): Int {
        val db = writableDatabase
        var added = 0
        db.beginTransaction()
        try {
            for (r in rows) {
                val id = db.insertWithOnConflict("health", null, ContentValues().apply {
                    put("ts", r.ts); put("metric", r.metric); put("value", r.value); put("source", r.source); put("kind", r.kind.orEmpty())
                    if (r.tsEnd != null) put("ts_end", r.tsEnd)
                }, SQLiteDatabase.CONFLICT_IGNORE)
                if (id != -1L) added++
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        return added
    }

    // ---- deleting ----

    /** Deletes [kind]'s rows in [range] (and those still waiting in undelivered batches). Returns rows deleted. */
    fun delete(kind: String, range: LongRange): Int {
        val db = writableDatabase
        var n = 0
        db.beginTransaction()
        try {
            fun del(table: String, column: String) { n += db.compileStatement("DELETE FROM $table WHERE $column >= ? AND $column <= ?").use { s -> s.bindLong(1, range.first); s.bindLong(2, range.last); s.executeUpdateDelete() } }
            if (kind == "location" || kind == "all") del("location", "ts")
            if (kind == "activity" || kind == "all") del("activity", "ts_start")
            if (kind == "steps" || kind == "all") del("steps", "ts")
            if (kind == "health" || kind == "all") del("health", "ts")
            for (b in outbox()) {
                if (kind != "all" && Batches.kindOf(b.word) != kind) continue
                val kept = Batches.without(b.word, b.body, range)
                if (kept == null) db.delete("outbox", "id = ?", arrayOf(b.id))
                else db.update("outbox", ContentValues().apply { put("body", kept.toString()) }, "id = ?", arrayOf(b.id))
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        return n
    }

    /** Applies the owner's retention ([Retention.plan]). */
    fun purge(now: Long, retentionDays: Int) {
        val db = writableDatabase
        for ((table, cutoff) in Retention.plan(now, retentionDays)) db.execSQL(Retention.statement(table), arrayOf<Any>(cutoff))
    }

    fun counts(): JSONObject {
        val o = JSONObject()
        for (t in listOf("location", "activity", "steps", "health", "outbox"))
            readableDatabase.rawQuery("SELECT COUNT(*), MIN(${Retention.TABLES[t]}), MAX(${Retention.TABLES[t]}) FROM $t", null).use { c ->
                c.moveToFirst()
                o.put(t, JSONObject().put("rows", c.getLong(0)).apply { if (!c.isNull(1)) { put("oldest", c.getLong(1)); put("newest", c.getLong(2)) } })
            }
        return o
    }

    // ---- batches for Ash ----

    /** Moves rows Ash has not had into batches of at most [Batches.MAX_ITEMS] (in one transaction). */
    fun collect(now: Long) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            collectTable(db, now, Batches.LOCATION, "SELECT id, ts, lat, lon, accuracy_m, provider, mocked, speed FROM location WHERE pushed = 0 ORDER BY ts", "location") { c ->
                Fix(c.getLong(1), c.getDouble(2), c.getDouble(3), c.getDouble(4), c.getString(5), c.getInt(6) != 0, if (c.isNull(7)) null else c.getDouble(7)).toEvent()
            }
            collectTable(db, now, Batches.ACTIVITY, "SELECT id, ts_start, ts_end, state FROM activity WHERE pushed = 0 ORDER BY ts_start", "activity") { c ->
                Segment(c.getLong(0), c.getLong(1), if (c.isNull(2)) null else c.getLong(2), c.getString(3)).toJson()
            }
            collectTable(db, now, Batches.HEALTH, "SELECT id, ts, metric, value, source FROM health WHERE pushed = 0 ORDER BY ts", "health") { c ->
                HealthRow(c.getLong(1), c.getString(2), c.getDouble(3), c.getString(4)).toEvent()
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    private fun collectTable(db: SQLiteDatabase, now: Long, word: String, sql: String, table: String, item: (Cursor) -> JSONObject) {
        val ids = mutableListOf<Long>()
        val items = mutableListOf<JSONObject>()
        db.rawQuery(sql, null).use { c -> while (c.moveToNext()) { ids += c.getLong(0); items += item(c) } }
        if (items.isEmpty()) return
        for (body in Batches.split(items) { UUID.randomUUID().toString() }) insertBatch(db, body.getString("batch_id"), word, body, now)
        for (chunk in ids.chunked(500)) db.execSQL("UPDATE $table SET pushed = 1 WHERE id IN (${chunk.joinToString(",")})")
    }

    /** A batch of its own (a geofence crossing): queued whether or not Ash is attached. */
    fun enqueue(word: String, body: JSONObject, now: Long): String {
        val id = UUID.randomUUID().toString()
        insertBatch(writableDatabase, id, word, body, now)
        return id
    }

    private fun insertBatch(db: SQLiteDatabase, id: String, word: String, body: JSONObject, now: Long) {
        db.insert("outbox", null, ContentValues().apply { put("id", id); put("word", word); put("body", body.toString()); put("created", now) })
    }

    fun outbox(): List<Batch> = readableDatabase.rawQuery("SELECT id, word, body, created, sent_at FROM outbox ORDER BY created, rowid", null)
        .use { c -> c.all { Batch(it.getString(0), it.getString(1), JSONObject(it.getString(2)), it.getLong(3), it.getLong(4)) } }

    fun markSent(id: String, ts: Long) { writableDatabase.execSQL("UPDATE outbox SET sent_at = ? WHERE id = ?", arrayOf<Any>(ts, id)) }
    fun ack(id: String) { writableDatabase.delete("outbox", "id = ?", arrayOf(id)) }
    fun pendingBatches(): Long = readableDatabase.rawQuery("SELECT COUNT(*) FROM outbox", null).use { it.moveToFirst(); it.getLong(0) }

    private fun <T> Cursor.all(row: (Cursor) -> T): List<T> { val out = ArrayList<T>(count.coerceAtLeast(0)); while (moveToNext()) out += row(this); return out }
}
