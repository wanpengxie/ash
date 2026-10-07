package ai.ash.apps

import java.net.URI

/**
 * An app page's network rules, from the domains its view declares (MCP Apps `ui.csp`): nothing but these, ever. The
 * page gets them as a Content-Security-Policy meta tag, and the WebView refuses every other request as well.
 */
class Csp(connectDomains: List<String>, resourceDomains: List<String>) {
    val connect: List<String> = connectDomains.mapNotNull(::source).distinct()
    val resource: List<String> = resourceDomains.mapNotNull(::source).distinct()

    /** The policy: the spec's restrictive default, opened only for the declared origins. */
    fun header(): String {
        val r = resource.joinToString("") { " $it" }
        val c = if (connect.isEmpty()) "'none'" else connect.joinToString(" ")
        return listOf(
            "default-src 'none'",
            "script-src 'self' 'unsafe-inline'$r",
            "style-src 'self' 'unsafe-inline'$r",
            "img-src 'self' data:$r",
            "font-src 'self'$r",
            "media-src 'self' data:$r",
            "connect-src $c",
            "frame-src 'none'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'none'",
        ).joinToString("; ")
    }

    fun meta(): String = "<meta http-equiv=\"Content-Security-Policy\" content=\"${header()}\">"

    /** A request the WebView is about to make: only to a declared origin (any of the two lists). */
    fun allows(url: String): Boolean {
        val u = runCatching { URI(url) }.getOrNull() ?: return false
        val scheme = u.scheme?.lowercase() ?: return false
        val host = u.host?.lowercase() ?: return false
        if (u.rawUserInfo != null) return false
        return (connect + resource).any { matches(it, scheme, host, u.port) }
    }

    fun toJson(): org.json.JSONObject = org.json.JSONObject()
        .put("connectDomains", org.json.JSONArray(connect)).put("resourceDomains", org.json.JSONArray(resource))

    companion object {
        private val SOURCE = Regex("(https|wss)://(\\*\\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?)(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?")

        /** One declared origin, normalised; anything else (a keyword, a path, plain http, a wildcard alone) is dropped. */
        fun source(raw: String): String? {
            val s = raw.trim().lowercase().removeSuffix("/")
            return s.takeIf { it.length <= 200 && SOURCE.matches(it) }
        }

        private fun matches(source: String, scheme: String, host: String, port: Int): Boolean {
            val sScheme = source.substringBefore("://")
            val rest = source.substringAfter("://")
            val sHost = rest.substringBefore(':')
            val sPort = rest.substringAfter(':', "").toIntOrNull()
            val okScheme = sScheme == scheme || (sScheme == "https" && scheme == "wss") || (sScheme == "wss" && scheme == "https")
            if (!okScheme) return false
            val defaultPort = 443
            if ((sPort ?: defaultPort) != (if (port == -1) defaultPort else port)) return false
            return if (sHost.startsWith("*.")) host.endsWith(sHost.substring(1)) && host.length > sHost.length - 1 else host == sHost
        }

        fun fromJson(o: org.json.JSONObject?): Csp {
            fun list(key: String) = o?.optJSONArray(key)?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? String } }.orEmpty()
            return Csp(list("connectDomains"), list("resourceDomains"))
        }
    }
}
