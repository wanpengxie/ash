package ai.ash.host

import java.net.URI

/** Reject a stale test-package URL before it can point the WebView at another app's core. */
internal object CoreEndpoint {
    fun acceptsUiUrl(url: String, corePort: Int, isolatedProbe: Boolean): Boolean {
        if (!isolatedProbe) return true
        val parsed = runCatching { URI(url) }.getOrNull() ?: return false
        return parsed.scheme == "http" && parsed.host == "127.0.0.1" &&
            parsed.port == corePort && parsed.rawUserInfo == null && parsed.path == "/" &&
            parsed.rawFragment == null
    }
}
