package ai.ash.host

/** Only the creator-fixed PendingIntent data URI identifies a notification action. */
data class PresentActionIdentity(val id: String, val choice: String) {
    companion object {
        fun fromUriParts(scheme: String?, authority: String?, path: List<String>): PresentActionIdentity? {
            if (scheme != "ash" || authority != "present-action" || path.size != 2) return null
            val (id, choice) = path
            if (id.isBlank() || id.length > 128 || choice !in setOf("reply", "once", "always", "deny", "dismiss")) return null
            return PresentActionIdentity(id, choice)
        }
    }
}
