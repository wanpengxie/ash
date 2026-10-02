package ai.ash.host.browser

import java.net.InetAddress
import java.net.URI

/** Validation for the agent's browser: what it may open, and what a click or typed text must match. Pure, no Android. */
object BrowserArguments {
    const val MAX_URL = 2048
    const val MAX_TYPED = 2000

    class Rejected(message: String) : IllegalArgumentException(message)

    /** Only public web pages: http(s), a real host, no credentials, nothing on this phone or its local network. */
    fun url(raw: Any?, resolve: (String) -> List<InetAddress> = { host -> InetAddress.getAllByName(host).toList() }): String {
        val text = (raw as? String)?.trim().orEmpty()
        if (text.isEmpty() || text.length > MAX_URL) throw Rejected("url is required (at most $MAX_URL characters)")
        val withScheme = if (Regex("^[A-Za-z][A-Za-z0-9+.-]*:").containsMatchIn(text)) text else "https://$text"
        val uri = try { URI(withScheme) } catch (_: Exception) { throw Rejected("not a valid web address") }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") throw Rejected("only http and https pages can be opened")
        if (uri.userInfo != null) throw Rejected("addresses with a user name or password are not allowed")
        val host = uri.host?.lowercase()?.trimEnd('.') ?: throw Rejected("the address has no host")
        if (isLocalName(host)) throw Rejected("pages on this phone or its local network cannot be opened")
        val addresses = try { resolve(host) } catch (_: Exception) { throw Rejected("the host could not be found") }
        if (addresses.isEmpty() || addresses.any { isPrivate(it) }) throw Rejected("pages on this phone or its local network cannot be opened")
        return uri.toString()
    }

    private val PUBLIC: InetAddress = InetAddress.getByAddress(byteArrayOf(93.toByte(), 184.toByte(), 216.toByte(), 34))

    /** The same checks without a DNS lookup, for navigation events on the main thread. */
    fun navigable(raw: String): String = url(raw) { host ->
        if (Regex("^[0-9.]+$").matches(host) || host.contains(':')) listOf(InetAddress.getByName(host)) else listOf(PUBLIC)
    }

    fun isLocalName(host: String): Boolean =
        host == "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
            host.endsWith(".lan") || host.endsWith(".home.arpa") || !host.contains('.') && !host.contains(':')

    fun isPrivate(address: InetAddress): Boolean {
        if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress || address.isSiteLocalAddress || address.isMulticastAddress) return true
        val bytes = address.address
        if (bytes.size == 4) {
            val first = bytes[0].toInt() and 0xff
            val second = bytes[1].toInt() and 0xff
            if (first == 100 && second in 64..127) return true // carrier-grade NAT
            if (first == 0 || first >= 240) return true
        } else if (bytes.size == 16) {
            if ((bytes[0].toInt() and 0xfe) == 0xfc) return true // fc00::/7 unique local
        }
        return false
    }

    fun host(url: String): String? = try { URI(url).host?.lowercase()?.trimEnd('.') } catch (_: Exception) { null }

    /** "www.example.com" and "example.com" are the same site for an approval. */
    fun sameSite(claimed: String, current: String?): Boolean {
        if (current == null) return false
        fun norm(value: String) = value.lowercase().trimEnd('.').removePrefix("www.")
        return claimed.isNotBlank() && norm(claimed) == norm(current)
    }

    fun ref(raw: Any?): Int {
        val value = (raw as? Number)?.toDouble() ?: throw Rejected("ref is required (the number shown by browser.read)")
        if (value != Math.floor(value) || value < 1 || value > 500) throw Rejected("ref must be a whole number from browser.read")
        return value.toInt()
    }

    private fun squash(value: String) = value.lowercase().replace(Regex("\\s+"), " ").trim()

    /** The owner approves by this label, so it must really describe the element the ref points at. */
    fun labelMatches(label: String, actual: String): Boolean {
        val want = squash(label)
        val have = squash(actual)
        if (want.isEmpty() || have.isEmpty()) return false
        return have.contains(want) || want.contains(have)
    }

    fun typed(raw: Any?): String {
        val text = raw as? String ?: throw Rejected("text is required")
        if (text.length > MAX_TYPED) throw Rejected("text is too long (at most $MAX_TYPED characters)")
        return text
    }

    fun required(raw: Any?, what: String): String {
        val text = (raw as? String)?.trim().orEmpty()
        if (text.isEmpty() || text.length > 200) throw Rejected("$what is required")
        return text
    }

    /** Controls the agent may type into; passwords and files are the owner's own business. */
    fun typable(tag: String, type: String?): Boolean {
        if (tag == "textarea") return true
        if (tag == "div" || tag == "span") return true // contenteditable
        if (tag != "input") return false
        return type == null || type in setOf("text", "search", "email", "url", "tel", "number", "")
    }
}
