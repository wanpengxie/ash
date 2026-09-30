package ai.ash.host.senses

import org.json.JSONObject

/** Last accepted occurrence state can be ahead of a batch snapshot after partial delivery. */
internal object CalendarDelivery {
    const val ABSENT = "__absent__"
    private const val PREFIX = "delivered:"
    private const val GENERATION_PREFIX = "generation:"
    private const val ATTEMPT_PREFIX = "attempt:"

    data class Change(val occurrence: String, val previous: String?, val current: String?)
    data class Attempt(val occurrence: String, val event: String, val target: String, val generation: Long) {
        val action: String get() = if (target == ABSENT) "removed" else "changed"
        val deliveryKey: String get() = "$action:$occurrence:v$generation:$event"
        fun encode(): String = JSONObject().put("occurrence", occurrence).put("event", event)
            .put("target", target).put("generation", generation).toString()
    }

    fun key(occurrence: String): String = "$PREFIX$occurrence"
    fun attemptKey(occurrence: String): String = "$ATTEMPT_PREFIX$occurrence"
    fun generationKey(occurrence: String): String = "$GENERATION_PREFIX$occurrence"
    fun nextGeneration(store: Map<String, *>, occurrence: String): Long =
        ((store[generationKey(occurrence)] as? String)?.toLongOrNull() ?: 0L) + 1L
    fun attempts(store: Map<String, *>): List<Attempt> = store.entries.mapNotNull { (key, value) ->
        if (!key.startsWith(ATTEMPT_PREFIX) || value !is String) return@mapNotNull null
        val data = runCatching { JSONObject(value) }.getOrNull() ?: return@mapNotNull null
        val occurrence = data.optString("occurrence")
        val event = data.optString("event")
        val target = data.optString("target")
        val generation = data.optLong("generation", 0L)
        if (occurrence.isEmpty() || key != attemptKey(occurrence) || event.isEmpty() || target.isEmpty() || generation <= 0L) null
        else Attempt(occurrence, event, target, generation)
    }
    fun journal(store: Map<String, *>): Map<String, String> = store.entries.mapNotNull { (key, value) ->
        if (key.startsWith(PREFIX) && value is String) key.removePrefix(PREFIX) to value else null
    }.toMap()

    fun diff(snapshot: Map<String, String>, delivered: Map<String, String>, current: Map<String, String>): List<Change> {
        val occurrences = (snapshot.keys + delivered.keys + current.keys).toSet()
        return occurrences.mapNotNull { occurrence ->
            val previous = if (delivered.containsKey(occurrence)) {
                delivered[occurrence]?.takeUnless { it == ABSENT }
            } else snapshot[occurrence]
            val now = current[occurrence]
            if (previous == now) null else Change(occurrence, previous, now)
        }
    }

    fun completedKeys(store: Map<String, *>): Set<String> = store.keys.filterTo(mutableSetOf()) {
        it.startsWith(PREFIX) || it.startsWith(GENERATION_PREFIX) || it.startsWith(ATTEMPT_PREFIX)
    }
}
