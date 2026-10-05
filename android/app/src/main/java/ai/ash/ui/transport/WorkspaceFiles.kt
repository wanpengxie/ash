package ai.ash.ui.transport

import java.net.URI
import java.net.URLEncoder

/** This virtual origin exposes only authenticated file GETs, never the core API or its owner credential. */
internal const val FILE_ORIGIN = "https://ash-files.invalid"
internal const val FILE_CSP = "sandbox allow-same-origin; default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors https://appassets.androidplatform.net"

internal fun workspaceContentRoute(url: String): String? = runCatching {
    val uri = URI(url)
    require(uri.scheme == "https" && uri.host == "ash-files.invalid" && uri.port == -1 && uri.rawUserInfo == null)
    require(uri.rawQuery == null && uri.normalize() == uri)
    val path = uri.rawPath
    require(Regex("/api/workspaces/[a-z0-9_-]+/content/.+").matches(path) && path.length <= 1024)
    path
}.getOrNull()

internal fun workspaceReadRoute(workspace: String, path: String): String {
    require(Regex("[a-z0-9_-]+").matches(workspace))
    require(path.isNotEmpty() && !path.contains('\\') && path.none { it.code < 32 || it.code == 127 })
    require(path.split('/').none { it.isEmpty() || it == "." || it == ".." })
    return "/api/workspaces/$workspace/files?path=${URLEncoder.encode(path, "UTF-8")}".also { require(it.length <= 1024) }
}
