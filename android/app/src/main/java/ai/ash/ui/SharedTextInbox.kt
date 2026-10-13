package ai.ash.ui

import java.util.UUID

/** One unacknowledged handoff to the page. Shared text stays data, never a native command. */
internal class SharedTextInbox {
    data class Draft(val id: String, val text: String)
    enum class Rejection { UNSUPPORTED, TOO_LARGE, BUSY }
    var pending: Draft? = null
        private set

    fun receive(action: String?, mime: String?, text: String?): Rejection? {
        if (action != "android.intent.action.SEND" || mime != "text/plain" || text == null) return Rejection.UNSUPPORTED
        // Bound before encoding so a hostile extra does not allocate an unbounded UTF-8 copy.
        if (text.length > MAX_BYTES || text.toByteArray(Charsets.UTF_8).size > MAX_BYTES) return Rejection.TOO_LARGE
        if (!LINK.containsMatchIn(text)) return Rejection.UNSUPPORTED
        if (pending != null) return Rejection.BUSY
        pending = Draft(UUID.randomUUID().toString(), text)
        return null
    }

    fun acknowledge(id: String) {
        if (pending?.id == id) pending = null
    }

    fun restore(id: String?, text: String?) {
        if (id.isNullOrEmpty() || text == null) return
        if (receive("android.intent.action.SEND", "text/plain", text) == null) pending = Draft(id, text)
    }

    companion object {
        const val MAX_BYTES = 32 * 1024
        // Only recognize a link; do not resolve, fetch, decode or execute shared content.
        private val LINK = Regex("https?://[^\\s<>]+", RegexOption.IGNORE_CASE)
    }
}
