package ai.ash.senses

/** What the store keeps: rows older than the owner's retention are deleted, once a day and on every change of it. */
object Retention {
    /** Table → its time column. The outbox is not here: an undelivered batch is kept until Ash takes it (or its rows are deleted). */
    val TABLES = linkedMapOf("location" to "ts", "activity" to "ts_start", "steps" to "ts", "health" to "ts", "outbox" to "created")

    /** One cutoff (ms) per table: rows with time < cutoff go. An open activity segment is kept. */
    fun plan(now: Long, retentionDays: Int): Map<String, Long> {
        val days = retentionDays.coerceIn(1, SenseConfig.MAX_RETENTION)
        val cutoff = now - days * SenseArgs.DAY_MS
        return TABLES.keys.associateWith { cutoff }
    }

    /** The statement deleting [table]'s expired rows (one bound argument: the cutoff). */
    fun statement(table: String): String {
        val column = TABLES[table] ?: error("unknown table $table")
        return if (table == "activity") "DELETE FROM activity WHERE ts_start < ? AND ts_end IS NOT NULL" else "DELETE FROM $table WHERE $column < ?"
    }
}
