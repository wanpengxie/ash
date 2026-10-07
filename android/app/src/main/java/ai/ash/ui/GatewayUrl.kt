package ai.ash.ui

import java.net.URI

/**
 * The gateway address the owner typed, reduced to its origin, or null when it is not acceptable. A gateway is reached
 * over https; plain http is accepted only on this phone itself (127.0.0.1 or localhost), for a development gateway
 * forwarded over USB.
 */
internal fun normalizeGatewayUrl(url: String): String? = runCatching {
    val parsed = URI(url)
    val host = parsed.host
    val loopback = host == "127.0.0.1" || host.equals("localhost", ignoreCase = true)
    require((parsed.scheme == "https" || (parsed.scheme == "http" && loopback)) && !host.isNullOrBlank() &&
        parsed.userInfo == null && parsed.query == null && parsed.fragment == null &&
        (parsed.path.isNullOrEmpty() || parsed.path == "/") && (parsed.port == -1 || parsed.port in 1..65535))
    URI(parsed.scheme, null, host, parsed.port, null, null, null).toString()
}.getOrNull()
