package ai.ash.host.senses

/** Minimal, bounded data copied from a newly posted notification. Never retain the source object. */
internal object NotificationSensePolicy {
    data class Item(val app: String, val title: String, val text: String)

    fun item(
        app: String,
        title: CharSequence?,
        text: CharSequence?,
        ownPackage: String,
        optedIn: Boolean,
        accessGranted: Boolean,
    ): Item? {
        if (!optedIn || !accessGranted || app.isBlank() || app == ownPackage) return null
        val safeTitle = title?.toString()?.take(512) ?: ""
        val safeText = text?.toString()?.take(2048) ?: ""
        if (safeTitle.isBlank() && safeText.isBlank()) return null
        return Item(app.take(256), safeTitle, safeText)
    }
}
