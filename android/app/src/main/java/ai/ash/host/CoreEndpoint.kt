package ai.ash.host

import java.net.URI

/** Validate the native-only bootstrap record's origin before extracting its bearer. */
internal object CoreEndpoint {
    fun acceptsUiUrl(url: String, corePort: Int): Boolean {
        val parsed = runCatching { URI(url) }.getOrNull() ?: return false
        return acceptsCoreOrigin(parsed, corePort) && parsed.rawPath == "/" && parsed.rawFragment == null
    }

    private fun acceptsCoreOrigin(uri: URI, corePort: Int): Boolean =
        uri.scheme == "http" && uri.host == "127.0.0.1" &&
            uri.port == corePort && uri.rawUserInfo == null
}
