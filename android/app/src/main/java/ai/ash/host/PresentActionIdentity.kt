package ai.ash.host

/** Only the creator-fixed PendingIntent data URI identifies a notification action. */
data class PresentActionIdentity(val id: String, val choice: String) {
    companion object {
        fun fromUriParts(scheme: String?, authority: String?, path: List<String>): PresentActionIdentity? {
            if (scheme != "ash" || authority != "present-action" || path.size != 2) return null
            val (id, choice) = path
            // The stored presentation, not this syntactic parser, checks that the choice was offered.
            if (id.isBlank() || id.length > 128 || !Regex("^[A-Za-z0-9_-]{1,64}$").matches(choice)) return null
            return PresentActionIdentity(id, choice)
        }
    }
}
