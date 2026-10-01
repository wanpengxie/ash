package ai.ash.host

/** RemoteInput requires mutable PendingIntent on every API; the explicit bit exists from API 31. */
object PresentPendingIntentFlags {
    fun action(api: Int, remoteInput: Boolean, updateCurrent: Int, immutable: Int, mutable: Int): Int =
        updateCurrent or when {
            !remoteInput -> immutable
            api >= 31 -> mutable
            else -> 0
        }
}
