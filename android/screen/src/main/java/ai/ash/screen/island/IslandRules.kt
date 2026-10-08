package ai.ash.screen.island

/**
 * When the island opens by itself. It opens only for what needs the owner (a question or an approval waiting on a card,
 * or a step only they can take in Ash); a turn's reply or end only marks the pill, and the mark settles back to the
 * plain pill after a while if the owner never looked.
 */
object IslandRules {
    /** How long a finished turn's mark stays on the pill before it settles. */
    const val SETTLE_MS = 30_000L

    /** [kind] is the frame's kind; [waitingOnOwner] is a card waiting for an answer that has not been given yet. */
    fun opensCard(kind: String, waitingOnOwner: Boolean): Boolean = waitingOnOwner || kind == "in_app"

    /** Frames that report an outcome and need nothing from the owner: their mark settles by itself. */
    fun settles(kind: String): Boolean = kind in SETTLING

    private val SETTLING = setOf("result", "reply", "incomplete", "stopped")
}
