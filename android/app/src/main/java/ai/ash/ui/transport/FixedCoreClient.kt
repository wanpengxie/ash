package ai.ash.ui.transport

import java.io.IOException
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/** A constrained native boundary, not installed in any Activity or WebView yet. */
internal class FixedCoreClient(
    corePort: Int,
    private val bearer: () -> String,
    private val transport: CoreHttpTransport = DirectCoreHttpTransport(),
) {
    private val root = "http://127.0.0.1:$corePort"
    private var epoch = 0L
    private val active = mutableSetOf<CoreCancellation>()

    init { require(corePort in 1..65535) }

    @Synchronized fun beginPage(verifiedAssetMainFrame: Boolean): Long {
        require(verifiedAssetMainFrame) { "unverified page" }
        invalidate()
        return epoch
    }

    @Synchronized fun invalidate() {
        epoch++
        active.forEach { it.cancel() }
        active.clear()
    }

    fun execute(pageEpoch: Long, input: CoreUiRequest, onChunk: (ByteArray) -> Unit = {}): CoreUiReply {
        val route = try { coreRoute(input) } catch (_: Exception) { throw IOException("core request unavailable") }
        val cancellation = CoreCancellation()
        synchronized(this) {
            if (pageEpoch != epoch || pageEpoch == 0L) throw IOException("page no longer active")
            active.add(cancellation)
        }
        try {
            val token = bearer()
            if (token.isBlank() || token.length > 4096 || token.any { it == '\r' || it == '\n' }) throw IOException("native credential unavailable")
            val tokenBytes = token.toByteArray(Charsets.UTF_8)
            var trailing = ByteArray(0)
            fun forward(chunk: ByteArray) {
                val bytes = trailing + chunk
                if (containsBytes(bytes, tokenBytes)) throw IOException("credential in core reply")
                val safe = if (route.streaming) (bytes.size - tokenBytes.size + 1).coerceAtLeast(0) else bytes.size
                if (safe > 0) onChunk(bytes.copyOfRange(0, safe))
                trailing = bytes.copyOfRange(safe, bytes.size)
            }
            val request = CoreHttpRequest(URL(root + input.path), input.method, mapOf(
                "authorization" to "Bearer $token",
                *route.headers.entries.map { it.key to it.value }.toTypedArray(),
            ), input.body, route.streaming)
            val result = transport.execute(request, cancellation) { chunk ->
                synchronized(this) {
                    if (pageEpoch != epoch || cancellation.cancelled) throw IOException("page no longer active")
                    forward(chunk)
                }
            }
            synchronized(this) {
                if (pageEpoch != epoch || cancellation.cancelled) throw IOException("page no longer active")
                if (result.status !in 100..599) throw IOException("invalid core reply")
                if (result.body.size > 33 * 1024 * 1024 || route.streaming && result.body.isNotEmpty()) throw IOException("core reply too large")
                if (containsBytes(result.body, tokenBytes)) throw IOException("credential in core reply")
                if (route.streaming && trailing.isNotEmpty()) onChunk(trailing)
            }
            if (result.status in 300..399) throw IOException("core redirect rejected")
            // Never return upstream headers: cookies, locations and auth stay native-only.
            return CoreUiReply(result.status, result.contentType.takeIf { it.length <= 128 && !it.contains('\n') && !it.contains('\r') && !it.contains(token) }
                ?: "application/octet-stream", result.body)
        } catch (_: Exception) {
            throw IOException("core request unavailable")
        } finally { synchronized(this) { active.remove(cancellation) } }
    }
}

internal data class CoreUiRequest(val method: String, val path: String, val headers: Map<String, String> = emptyMap(), val body: ByteArray? = null)
internal data class CoreUiReply(val status: Int, val contentType: String, val body: ByteArray)
internal data class CoreHttpRequest(val url: URL, val method: String, val headers: Map<String, String>, val body: ByteArray?, val streaming: Boolean)
internal data class CoreHttpReply(val status: Int, val contentType: String, val body: ByteArray)

/** Parse a private native-only bootstrap record; callers must never load or post it to a page. */
internal fun ownerBearerFromPrivateUiUrl(record: String, corePort: Int): String {
    require(corePort in 1..65535)
    val uri = runCatching { java.net.URI(record.trimEnd('\n')) }.getOrNull() ?: throw IOException("invalid private UI record")
    val query = uri.rawQuery ?: throw IOException("invalid private UI record")
    val token = query.removePrefix("token=")
    if (uri.scheme != "http" || uri.host != "127.0.0.1" || uri.port != corePort || uri.rawUserInfo != null ||
        uri.rawPath != "/" || uri.rawFragment != null || !query.startsWith("token=") ||
        !Regex("[A-Za-z0-9_-]{16,256}").matches(token)) throw IOException("invalid private UI record")
    return token
}

private fun containsBytes(haystack: ByteArray, needle: ByteArray): Boolean {
    if (needle.isEmpty()) return false
    outer@ for (i in 0..haystack.size - needle.size) {
        for (j in needle.indices) if (haystack[i + j] != needle[j]) continue@outer
        return true
    }
    return false
}

internal class CoreCancellation {
    private val stopped = AtomicBoolean(false)
    @Volatile private var stopConnection: (() -> Unit)? = null
    val cancelled get() = stopped.get()
    fun bind(stop: () -> Unit) { stopConnection = stop; if (cancelled) stop() }
    fun cancel() { stopped.set(true); stopConnection?.invoke() }
}

internal fun interface CoreHttpTransport {
    fun execute(request: CoreHttpRequest, cancellation: CoreCancellation, onChunk: (ByteArray) -> Unit): CoreHttpReply
}

private data class CoreRoute(val headers: Map<String, String>, val streaming: Boolean)

private fun coreRoute(input: CoreUiRequest): CoreRoute {
    val raw = input.path
    require(raw.startsWith("/") && !raw.startsWith("//") && !raw.contains('\\') && !raw.contains('#') && raw.length <= 1024)
    val url = java.net.URI("http://ui.invalid$raw")
    require(url.scheme == "http" && url.host == "ui.invalid" && url.rawUserInfo == null && url.normalize() == url)
    val params = url.rawQuery?.split('&')?.map { it.substringBefore('=') } ?: emptyList()
    val headerNames = input.headers.keys.map { it.lowercase() }
    require(headerNames.size == headerNames.toSet().size)
    require(input.headers.all { (key, value) -> value.length <= 256 && !value.contains('\r') && !value.contains('\n') &&
        key.lowercase() in setOf("content-type", "ash-screen", "last-event-id") })
    val headers = input.headers.mapKeys { it.key.lowercase() }
    return when {
        url.rawPath == "/api/send" && input.method == "POST" && url.rawQuery == null && input.body != null &&
            input.body.size <= 28 * 1024 * 1024 && headers["content-type"] == "application/json" && "last-event-id" !in headers -> CoreRoute(headers, false)
        url.rawPath == "/api/stream" && input.method == "GET" && input.body == null &&
            params.size == params.toSet().size && params.all { it in setOf("after", "before", "follow", "summary", "limit", "label") } &&
            headers.keys.all { it == "last-event-id" } -> CoreRoute(headers, url.rawQuery?.split('&')?.contains("follow=true") == true)
        Regex("/api/workspaces/[a-z0-9_-]+/files").matches(url.rawPath) && input.method == "GET" && input.body == null &&
            params == listOf("path") && headers.isEmpty() && validFilePath(url.rawQuery!!.substringAfter('=')) -> CoreRoute(emptyMap(), false)
        else -> throw IllegalArgumentException("unapproved core route")
    }
}

private fun validFilePath(encoded: String): Boolean {
    val decoded = runCatching { java.net.URLDecoder.decode(encoded, "UTF-8") }.getOrNull() ?: return false
    return decoded.isNotEmpty() && !decoded.startsWith('/') && !decoded.contains('\\') && !decoded.contains('\u0000') &&
        !decoded.contains("//") && decoded.split('/').none { it.isEmpty() || it == "." || it == ".." } &&
        encodeUriComponent(decoded) == encoded
}

private fun encodeUriComponent(value: String): String = buildString {
    val digits = "0123456789ABCDEF"
    for (byte in value.toByteArray(Charsets.UTF_8)) {
        val n = byte.toInt() and 0xff
        val safe = n in 65..90 || n in 97..122 || n in 48..57 || n.toChar() in "-_.!~*'()"
        if (safe) append(n.toChar()) else { append('%'); append(digits[n ushr 4]); append(digits[n and 15]) }
    }
}

/** No proxy, no redirect and bounded non-live responses; a live stream is delivered in chunks. */
internal class DirectCoreHttpTransport : CoreHttpTransport {
    override fun execute(request: CoreHttpRequest, cancellation: CoreCancellation, onChunk: (ByteArray) -> Unit): CoreHttpReply {
        val connection = request.url.openConnection(Proxy.NO_PROXY) as HttpURLConnection
        cancellation.bind { connection.disconnect() }
        connection.instanceFollowRedirects = false
        connection.requestMethod = request.method
        connection.connectTimeout = 3_000
        connection.readTimeout = if (request.streaming) 35_000 else 10_000
        request.headers.forEach { (key, value) -> connection.setRequestProperty(key, value) }
        if (request.body != null) {
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(request.body.size)
            connection.outputStream.use { it.write(request.body) }
        }
        val status = connection.responseCode
        if (status in 300..399) { connection.disconnect(); return CoreHttpReply(status, "application/octet-stream", ByteArray(0)) }
        val stream = if (status < 400) connection.inputStream else connection.errorStream
        val collected = java.io.ByteArrayOutputStream()
        var previousLf = false
        try { stream?.use { source ->
            val buffer = ByteArray(64 * 1024)
            var frameBytes = 0
            while (true) {
                if (cancellation.cancelled) throw IOException("cancelled")
                val count = source.read(buffer)
                if (count < 0) break
                val chunk = buffer.copyOf(count)
                if (request.streaming) {
                    for (byte in chunk) {
                        frameBytes++
                        if (frameBytes > 2 * 1024 * 1024) throw IOException("stream frame too large")
                        if (byte == '\n'.code.toByte() && previousLf) frameBytes = 0
                        if (byte != '\r'.code.toByte()) previousLf = byte == '\n'.code.toByte()
                    }
                    onChunk(chunk)
                } else {
                    if (collected.size().toLong() + count > 33L * 1024 * 1024) throw IOException("core reply too large")
                    collected.write(chunk)
                }
            }
        } } finally { connection.disconnect() }
        return CoreHttpReply(status, connection.contentType ?: "application/octet-stream", collected.toByteArray())
    }
}
