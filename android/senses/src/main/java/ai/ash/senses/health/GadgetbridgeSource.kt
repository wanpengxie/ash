package ai.ash.senses.health

import ai.ash.senses.HealthRow
import ai.ash.senses.SenseError
import ai.ash.senses.Senses
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream

/**
 * Gadgetbridge's database exports, in a folder the owner granted read-only. Gadgetbridge talks to the watch; this only
 * reads the newest export it wrote (a copy, opened read-only), and asks it to sync and export through its Intent API.
 */
object GadgetbridgeSource {
    const val PACKAGE = "nodomain.freeyourgadget.gadgetbridge"
    private const val ACTIVITY_SYNC = "nodomain.freeyourgadget.gadgetbridge.command.ACTIVITY_SYNC"
    private const val TRIGGER_EXPORT = "nodomain.freeyourgadget.gadgetbridge.command.TRIGGER_DATABASE_EXPORT"
    private const val SYNC_FINISHED = "nodomain.freeyourgadget.gadgetbridge.action.ACTIVITY_SYNC_FINISH"
    private const val EXPORT_SUCCESS = "nodomain.freeyourgadget.gadgetbridge.action.DATABASE_EXPORT_SUCCESS"
    private const val EXPORT_FAIL = "nodomain.freeyourgadget.gadgetbridge.action.DATABASE_EXPORT_FAIL"
    private const val FOLDER = "gadgetbridge_folder"

    fun installedVersion(ctx: Context): String? = runCatching { ctx.packageManager.getPackageInfo(PACKAGE, 0).versionName ?: "?" }.getOrNull()

    /** The granted folder, while the grant still holds (the owner can withdraw it in system settings). */
    fun folder(ctx: Context): Uri? {
        val uri = Senses.prefs(ctx).getString(FOLDER, null)?.let(Uri::parse) ?: return null
        return uri.takeIf { u -> ctx.contentResolver.persistedUriPermissions.any { it.uri == u && it.isReadPermission } }
    }

    fun setFolder(ctx: Context, uri: Uri) {
        ctx.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        // Only one folder is kept: an earlier grant is given back.
        Senses.prefs(ctx).getString(FOLDER, null)?.let(Uri::parse)?.takeIf { it != uri }?.let { old ->
            runCatching { ctx.contentResolver.releasePersistableUriPermission(old, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
        }
        Senses.prefs(ctx).edit().putString(FOLDER, uri.toString()).apply()
    }

    private fun docs(ctx: Context, tree: Uri): List<GadgetbridgeFiles.Doc> {
        val out = mutableListOf<GadgetbridgeFiles.Doc>()
        fun walk(parent: String, depth: Int) {
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parent)
            val cols = arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE, DocumentsContract.Document.COLUMN_LAST_MODIFIED, DocumentsContract.Document.COLUMN_SIZE)
            val dirs = mutableListOf<String>()
            ctx.contentResolver.query(children, cols, null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val mime = c.getString(2)
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) dirs += c.getString(0)
                    else out += GadgetbridgeFiles.Doc(c.getString(0), c.getString(1) ?: "", mime, if (c.isNull(3)) 0 else c.getLong(3), if (c.isNull(4)) 0 else c.getLong(4))
                }
            }
            if (depth < 2) for (d in dirs) walk(d, depth + 1)
        }
        walk(DocumentsContract.getTreeDocumentId(tree), 0)
        return out
    }

    fun newest(ctx: Context): GadgetbridgeFiles.Doc? {
        val tree = folder(ctx) ?: return null
        return GadgetbridgeFiles.newest(runCatching { docs(ctx, tree) }.getOrDefault(emptyList()))
    }

    private fun ready(ctx: Context): Pair<Uri, GadgetbridgeFiles.Doc> {
        val tree = folder(ctx) ?: throw SenseError("source_unavailable",
            if (installedVersion(ctx) == null) "Gadgetbridge is not installed, and no export folder is granted" else "no Gadgetbridge export folder is granted (pick it on Ash 感知's setup page)")
        val doc = GadgetbridgeFiles.newest(try { docs(ctx, tree) } catch (e: Exception) { throw SenseError("source_unavailable", "the export folder could not be listed: ${e.message}") })
            ?: throw SenseError("source_unavailable", "no Gadgetbridge export in the granted folder (turn on auto export in Gadgetbridge, into this folder)")
        return tree to doc
    }

    /** A private copy of the newest export (reused while the export is unchanged). */
    @Synchronized private fun copy(ctx: Context, tree: Uri, doc: GadgetbridgeFiles.Doc): File {
        val dir = File(ctx.cacheDir, "gadgetbridge").apply { mkdirs() }
        val db = File(dir, "export.db")
        val key = File(dir, "export.key")
        val stamp = "${doc.id}|${doc.modified}|${doc.size}"
        if (db.isFile && key.isFile && key.readText() == stamp) return db
        val uri = DocumentsContract.buildDocumentUriUsingTree(tree, doc.id)
        val tmp = File(dir, "export.tmp")
        val input = ctx.contentResolver.openInputStream(uri) ?: throw SenseError("source_unavailable", "the export ${doc.name} could not be opened")
        input.use { raw ->
            if (doc.name.lowercase().endsWith(".zip")) {
                ZipInputStream(raw).use { zip ->
                    var found = false
                    while (true) {
                        val e = zip.nextEntry ?: break
                        if (!e.isDirectory && GadgetbridgeFiles.zipEntry(e.name)) { tmp.outputStream().use { zip.copyTo(it) }; found = true; break }
                    }
                    if (!found) throw SenseError("unsupported_schema", "the zip ${doc.name} holds no Gadgetbridge database")
                }
            } else tmp.outputStream().use { raw.copyTo(it) }
        }
        val head = tmp.inputStream().use { s -> ByteArray(16).also { s.read(it) } }
        if (!head.contentEquals(GadgetbridgeFiles.MAGIC)) { tmp.delete(); throw SenseError("unsupported_schema", "${doc.name} is not an SQLite database") }
        if (!tmp.renameTo(db)) { tmp.copyTo(db, overwrite = true); tmp.delete() }
        key.writeText(stamp)
        return db
    }

    private class Opened(val db: SQLiteDatabase, val doc: GadgetbridgeFiles.Doc, val plan: GadgetbridgeSchema.Result, val version: Int, val devices: Map<Long, String>)

    private fun <T> open(ctx: Context, body: (Opened) -> T): T {
        val (tree, doc) = ready(ctx)
        val file = copy(ctx, tree, doc)
        val db = try { SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READONLY or SQLiteDatabase.NO_LOCALIZED_COLLATORS) }
        catch (e: Exception) { throw SenseError("unsupported_schema", "the export could not be opened: ${e.message}") }
        db.use {
            val names = db.rawQuery("SELECT name FROM sqlite_master WHERE type = 'table'", null).use { c -> buildList { while (c.moveToNext()) add(c.getString(0)) } }
            val tables = names.map { n -> GadgetbridgeSchema.Table(n, db.rawQuery("PRAGMA table_info(${quote(n)})", null).use { c ->
                val i = c.getColumnIndexOrThrow("name"); buildList { while (c.moveToNext()) add(c.getString(i)) } }) }
            val version = db.rawQuery("PRAGMA user_version", null).use { c -> if (c.moveToFirst()) c.getInt(0) else 0 }
            val plan = GadgetbridgeSchema.plan(tables)
            val devices = (plan as? GadgetbridgeSchema.Plan)?.devices?.let { t ->
                val id = t.column("_id", "ID") ?: return@let emptyMap()
                val name = t.column("ALIAS", "NAME", "MODEL") ?: return@let emptyMap()
                db.rawQuery("SELECT ${quote(id)}, ${quote(name)} FROM ${quote(t.name)}", null).use { c ->
                    buildMap { while (c.moveToNext()) if (!c.isNull(0) && !c.isNull(1)) put(c.getLong(0), c.getString(1)) } }
            } ?: emptyMap()
            return body(Opened(db, doc, plan, version, devices))
        }
    }

    private fun quote(name: String) = "\"" + name.replace("\"", "\"\"") + "\""

    private fun rows(c: Cursor): List<Map<String, Any?>> {
        val out = ArrayList<Map<String, Any?>>(c.count.coerceAtLeast(0))
        while (c.moveToNext()) out += (0 until c.columnCount).associate { i ->
            c.getColumnName(i) to when (c.getType(i)) {
                Cursor.FIELD_TYPE_INTEGER -> c.getLong(i)
                Cursor.FIELD_TYPE_FLOAT -> c.getDouble(i)
                Cursor.FIELD_TYPE_STRING -> c.getString(i)
                else -> null
            }
        }
        return out
    }

    /** The readings of [metrics] in [range] from the newest export. Throws [SenseError]. */
    fun read(ctx: Context, metrics: List<String>, range: LongRange, max: Int): List<HealthRow> = open(ctx) { o ->
        val plan = when (val p = o.plan) {
            is GadgetbridgeSchema.Unsupported -> throw SenseError("unsupported_schema",
                "no recognised sample tables in the Gadgetbridge export (database version ${o.version}); tables: ${p.tables.joinToString()}")
            is GadgetbridgeSchema.Plan -> p
        }
        val out = mutableListOf<HealthRow>()
        for (s in plan.samples) {
            if (s.metrics.keys.none { it in metrics }) continue
            val maxTs = o.db.rawQuery("SELECT MAX(${quote(s.ts)}) FROM ${quote(s.table)}", null).use { c -> if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null } ?: continue
            val r = GadgetbridgeSchema.rangeIn(maxTs, range)
            val cols = (listOf(s.ts) + listOfNotNull(s.device) + s.metrics.filterKeys { it in metrics }.values).distinct().joinToString { quote(it) }
            val raw = o.db.rawQuery("SELECT $cols FROM ${quote(s.table)} WHERE ${quote(s.ts)} >= ? AND ${quote(s.ts)} <= ? ORDER BY ${quote(s.ts)} LIMIT 400000",
                arrayOf(r.first.toString(), r.last.toString())).use { rows(it) }
            out += GadgetbridgeSchema.samples(s, raw, o.devices, metrics, range)
        }
        for (s in plan.sessions) {
            if (s.metric !in metrics) continue
            val cols = (listOf(s.start, s.end) + listOfNotNull(s.device, s.kind)).distinct().joinToString { quote(it) }
            val raw = o.db.rawQuery("SELECT $cols FROM ${quote(s.table)} ORDER BY ${quote(s.start)} DESC LIMIT 5000", null).use { rows(it) }
            out += GadgetbridgeSchema.sessions(s, raw, o.devices, range)
        }
        out.sortedBy { it.ts }.take(max)
    }

    /**
     * The newest real reading in the export: sample rows with a real value (not Gadgetbridge's "no reading" marks) and
     * finished sessions. A row stamped in the future (a watch with a wrong clock) is not counted. This is the data's
     * time; the export file can be rewritten on time while nothing new came from the watch.
     */
    private fun latest(o: Opened, plan: GadgetbridgeSchema.Plan, now: Long): GadgetbridgeSchema.Latest {
        val found = mutableListOf<GadgetbridgeSchema.Found>()
        val horizon = 0L..(now + 3_600_000L)
        fun max(table: String, ts: String): Long? = o.db.rawQuery("SELECT MAX(${quote(ts)}) FROM ${quote(table)}", null)
            .use { c -> if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null }
        fun collect(metric: String, table: String, ts: String, device: String?, where: String) {
            val limit = GadgetbridgeSchema.rangeIn(max(table, ts) ?: return, horizon).last
            val dev = device?.let { quote(it) }
            val sql = "SELECT ${dev ?: "NULL"}, MAX(${quote(ts)}) FROM ${quote(table)} WHERE ${quote(ts)} <= ? AND $where" + (dev?.let { " GROUP BY $it" } ?: "")
            o.db.rawQuery(sql, arrayOf(limit.toString())).use { c ->
                while (c.moveToNext()) {
                    if (c.isNull(1)) continue
                    val source = GadgetbridgeSchema.source(if (c.isNull(0)) null else o.devices[c.getLong(0)])
                    found += GadgetbridgeSchema.Found(metric, source, GadgetbridgeSchema.toMillis(c.getLong(1)))
                }
            }
        }
        for (s in plan.samples) for ((metric, column) in s.metrics) collect(metric, s.table, s.ts, s.device, GadgetbridgeSchema.validSql(metric, quote(column)))
        for (s in plan.sessions) collect(s.metric, s.table, s.end, s.device, "${quote(s.end)} > ${quote(s.start)}")
        return GadgetbridgeSchema.latest(found)
    }

    fun status(ctx: Context, now: Long = System.currentTimeMillis()): JSONObject {
        val o = JSONObject().put("id", "gadgetbridge").put("installed", installedVersion(ctx) != null)
        installedVersion(ctx)?.let { o.put("version", it) }
        val tree = folder(ctx)
        o.put("folder_granted", tree != null)
        if (tree == null) return o
        val doc = newest(ctx)
        if (doc == null) { o.put("export", JSONObject.NULL).put("latest_error", "no export in the granted folder"); return o }
        // modified is the file's time: Gadgetbridge can rewrite it on schedule with nothing new from the watch.
        o.put("export", JSONObject().put("name", doc.name).put("modified", doc.modified).put("size", doc.size))
        runCatching {
            open(ctx) { op ->
                o.put("database_version", op.version)
                when (val p = op.plan) {
                    is GadgetbridgeSchema.Unsupported -> o.put("schema", "unsupported").put("tables", JSONArray(p.tables)).put("latest_error", "unsupported export")
                    is GadgetbridgeSchema.Plan -> {
                        o.put("schema", "ok")
                            .put("metrics", JSONArray((p.samples.flatMap { it.metrics.keys } + p.sessions.map { it.metric }).distinct()))
                            .put("devices", JSONArray(op.devices.values.distinct().map { GadgetbridgeSchema.source(it) }))
                            .put("notes", JSONArray(p.notes))
                        val latest = latest(op, p, now)
                        o.put("latest_data_ts", latest.ts ?: JSONObject.NULL)
                            .put("latest_by_metric", JSONObject(latest.byMetric as Map<*, *>))
                            .put("latest_by_device", JSONObject(latest.bySource as Map<*, *>))
                    }
                }
            }
        }.onFailure {
            val why = (it as? SenseError)?.let { e -> "${e.code}: ${e.message}" } ?: it.toString()
            o.put("schema_error", why)
            if (!o.has("latest_data_ts")) o.put("latest_error", why)
        }
        return o
    }

    /**
     * Asks Gadgetbridge to fetch from the watch and export, and waits for its confirmation. Gadgetbridge only obeys
     * when its Intent API is turned on (Settings → Developer options → Intent API: allow activity sync, allow
     * database export).
     */
    fun sync(ctx: Context, timeoutMs: Long = 90_000): JSONObject {
        if (installedVersion(ctx) == null) throw SenseError("source_unavailable", "Gadgetbridge is not installed")
        ready(ctx)
        val events = LinkedBlockingQueue<String>()
        val receiver = object : BroadcastReceiver() { override fun onReceive(c: Context, i: Intent) { i.action?.let { events.offer(it) } } }
        val filter = IntentFilter().apply { addAction(SYNC_FINISHED); addAction(EXPORT_SUCCESS); addAction(EXPORT_FAIL) }
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED) else ctx.registerReceiver(receiver, filter)
        val started = System.currentTimeMillis()
        try {
            ctx.sendBroadcast(Intent(ACTIVITY_SYNC).setPackage(PACKAGE))
            val synced = waitFor(events, setOf(SYNC_FINISHED), timeoutMs / 2) == SYNC_FINISHED
            ctx.sendBroadcast(Intent(TRIGGER_EXPORT).setPackage(PACKAGE))
            when (waitFor(events, setOf(EXPORT_SUCCESS, EXPORT_FAIL), timeoutMs - (System.currentTimeMillis() - started))) {
                EXPORT_SUCCESS -> {}
                EXPORT_FAIL -> throw SenseError("source_unavailable", "Gadgetbridge reported that its database export failed (check its auto-export folder)")
                else -> throw SenseError("timeout", "Gadgetbridge did not confirm an export within ${timeoutMs / 1000}s. Turn on its Intent API " +
                    "(Gadgetbridge → Settings → Developer options → Intent API: allow activity sync and allow database export), keep it allowed to run in the background, and try again")
            }
            Thread.sleep(1_500)
            val doc = newest(ctx)
            return JSONObject().put("synced_from_watch", synced).put("exported", true).put("seconds", (System.currentTimeMillis() - started) / 1000)
                .apply { if (doc != null) put("export", JSONObject().put("name", doc.name).put("modified", doc.modified)) }
        } finally { runCatching { ctx.unregisterReceiver(receiver) } }
    }

    private fun waitFor(q: LinkedBlockingQueue<String>, wanted: Set<String>, timeoutMs: Long): String? {
        val deadline = System.currentTimeMillis() + timeoutMs.coerceAtLeast(0)
        while (true) {
            val left = deadline - System.currentTimeMillis()
            if (left <= 0) return null
            val e = q.poll(left, TimeUnit.MILLISECONDS) ?: return null
            if (e in wanted) return e
        }
    }
}
