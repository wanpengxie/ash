package ai.ash.host

import java.net.URI

/** The credentialed WebView may only load this build's exact core origin. */
internal object CoreEndpoint {
    fun acceptsUiUrl(url: String, corePort: Int): Boolean {
        val parsed = runCatching { URI(url) }.getOrNull() ?: return false
        return acceptsCoreOrigin(parsed, corePort) && parsed.rawPath == "/" && parsed.rawFragment == null
    }

    fun acceptsResourceUrl(url: String, corePort: Int): Boolean =
        runCatching { URI(url) }.getOrNull()?.let { acceptsCoreOrigin(it, corePort) } == true

    private fun acceptsCoreOrigin(uri: URI, corePort: Int): Boolean =
        uri.scheme == "http" && uri.host == "127.0.0.1" &&
            uri.port == corePort && uri.rawUserInfo == null
}
