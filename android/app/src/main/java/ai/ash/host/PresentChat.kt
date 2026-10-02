package ai.ash.host

/** Chat-type presentations share one conversation notification, like a messaging app. */
object PresentChat {
    const val TAG = "present:chat"
    const val KEEP = 8
    private val kinds = setOf("reply", "offer", "heads_up")

    fun isChat(kind: String) = kind in kinds

    /** Oldest first. Only the newest [KEEP] are shown; older ones are retired, never left to pile up. */
    fun split(items: List<Pair<String, Long>>): Pair<List<String>, List<String>> {
        val sorted = items.sortedWith(compareBy({ it.second }, { it.first }))
        return sorted.takeLast(KEEP).map { it.first } to sorted.dropLast(KEEP).map { it.first }
    }
}
