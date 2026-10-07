package ai.ash.host.apps

/**
 * The only core routes the apps shell may reach through Ash: the owner's apps, nothing else. Exact shapes, no
 * prefixes: no query, no fragment, no dot segments, no escapes, ids from a small alphabet.
 */
internal object AppsRoutes {
    private const val ID = "[a-z0-9][a-z0-9._-]{0,127}"
    private const val SURFACE = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
    private val get = listOf(Regex("/api/apps"), Regex("/api/apps/$ID/icon"), Regex("/api/apps/$ID/surfaces/$SURFACE"))
    private val post = listOf(Regex("/api/apps/$ID/call"), Regex("/api/apps/$ID/message"))

    fun allowed(method: String, path: String): Boolean {
        if (path.length > 300 || path.contains("..")) return false
        return when (method) {
            "GET" -> get.any { it.matches(path) }
            "POST" -> post.any { it.matches(path) }
            else -> false
        }
    }

    /** A reply the shell can read as text; anything else (an icon) goes over as base64. */
    fun textual(contentType: String): Boolean {
        val t = contentType.lowercase()
        return t.isEmpty() || t.startsWith("text/") || t.contains("json")
    }
}
