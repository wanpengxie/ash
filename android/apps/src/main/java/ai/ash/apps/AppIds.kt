package ai.ash.apps

import java.net.URI
import java.net.URLDecoder

/** An app's id (from Ash's list, a link or a home-screen icon), and the web origin its page gets. */
object AppIds {
    private const val LABEL = "[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?"
    /** Lower case, dot-separated labels ("health", "com.example.notes"): each one also a valid host-name label. */
    private val ID = Regex("$LABEL(?:\\.$LABEL)*")
    private val SURFACE = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
    const val SCHEME = "ash-app"
    const val HOST = "open"

    fun valid(id: String?): Boolean = id != null && id.length <= 100 && ID.matches(id)
    fun validSurface(id: String?): Boolean = id != null && SURFACE.matches(id) && !id.contains("..")

    /** Each app's own origin: its storage is its own, and it can reach nothing there (.invalid never resolves). */
    fun origin(id: String): String { require(valid(id)); return "https://$id.ash-app.invalid" }

    fun link(id: String): String { require(valid(id)); return "$SCHEME://$HOST?app=$id" }

    /** The app id in ash-app://open?app=<id>, or null for anything else. */
    fun fromLink(link: String?): String? = param(link, "app")?.takeIf { valid(it) }

    /** The page in ash-app://open?app=<id>&surface=<page> (a home-screen card opens one), or null. */
    fun surfaceFromLink(link: String?): String? = if (fromLink(link) == null) null else param(link, "surface")?.takeIf { validSurface(it) }

    private fun param(link: String?, name: String): String? {
        val uri = runCatching { URI(link ?: return null) }.getOrNull() ?: return null
        if (uri.scheme != SCHEME || uri.host != HOST || uri.rawUserInfo != null || uri.port != -1) return null
        if (!uri.rawPath.isNullOrEmpty() && uri.rawPath != "/") return null
        val values = (uri.rawQuery ?: return null).split('&').mapNotNull {
            val i = it.indexOf('=')
            if (i > 0 && it.substring(0, i) == name) runCatching { URLDecoder.decode(it.substring(i + 1), "UTF-8") }.getOrNull() else null
        }
        return values.singleOrNull()
    }
}
