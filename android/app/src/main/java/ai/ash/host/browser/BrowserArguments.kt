package ai.ash.host.browser

import java.net.InetAddress
import java.net.URI
import org.json.JSONArray
import org.json.JSONObject

/** One browser action, parsed and checked for shape before anything runs (single capabilities and browser.run share these). */
sealed class BrowserStep {
    data class Open(val url: String) : BrowserStep()
    object Read : BrowserStep()
    data class Click(val ref: Int, val site: String, val label: String) : BrowserStep()
    data class Type(val ref: Int, val site: String, val label: String, val text: String, val submit: Boolean) : BrowserStep()
    data class Scroll(val down: Boolean) : BrowserStep()
    object Back : BrowserStep()
    data class WaitMs(val ms: Long) : BrowserStep()
    data class WaitText(val text: String) : BrowserStep()
    object Capture : BrowserStep()
}

/** Validation for the agent's browser: what it may open, and what a click or typed text must match. Pure, no Android. */
object BrowserArguments {
    const val MAX_URL = 2048
    const val MAX_TYPED = 2000
    const val MAIN_SPACE = "main"
    const val ALL_SPACES = "*"
    const val MAX_STEPS = 20
    const val MAX_WAIT_MS = 5_000L
    const val MAX_WAIT_TEXT = 200
    private val SPACE = Regex("^[a-z0-9_-]{1,24}$")

    /** Which browser space a call is about; absent means the main one. */
    fun space(raw: Any?, allowAll: Boolean = false): String {
        if (raw == null || raw == JSONObject.NULL) return MAIN_SPACE
        val text = raw as? String ?: throw Rejected("space must be text")
        if (allowAll && text == ALL_SPACES) return text
        if (!SPACE.matches(text)) throw Rejected("space must be 1-24 lowercase letters, digits, _ or - (e.g. main, trains)")
        return text
    }

    /** The fields each browser.run op takes (op itself aside). */
    val STEP_FIELDS: Map<String, Set<String>> = mapOf(
        "open" to setOf("url"), "read" to emptySet(), "click" to setOf("ref", "site", "label"),
        "type" to setOf("ref", "site", "label", "text", "submit"), "scroll" to setOf("direction"), "back" to emptySet(),
        "wait" to setOf("ms", "text"), "capture" to emptySet(),
    )
    val OPS: Set<String> get() = STEP_FIELDS.keys

    /**
     * Parses one action. In browser.run every field must be one the op knows ([strict]); a single capability only
     * reads the fields it needs (its other arguments, like space, are not the step's business).
     */
    fun step(op: String, input: JSONObject, strict: Boolean = false): BrowserStep {
        val fields = STEP_FIELDS[op] ?: throw Rejected("unknown op \"$op\" (use one of ${OPS.joinToString(", ")})")
        if (strict) for (key in input.keys()) if (key != "op" && key !in fields) throw Rejected("$op does not take \"$key\"")
        return when (op) {
            "open" -> BrowserStep.Open((input.opt("url") as? String)?.takeIf { it.isNotBlank() } ?: throw Rejected("url is required"))
            "read" -> BrowserStep.Read
            "click" -> BrowserStep.Click(ref(input.opt("ref")), required(input.opt("site"), "site"), required(input.opt("label"), "label"))
            "type" -> BrowserStep.Type(ref(input.opt("ref")), required(input.opt("site"), "site"), required(input.opt("label"), "label"),
                typed(input.opt("text")), flag(input, "submit"))
            "scroll" -> BrowserStep.Scroll(when (val d = input.opt("direction")) {
                null, JSONObject.NULL, "down" -> true
                "up" -> false
                else -> throw Rejected("direction must be down or up, not $d")
            })
            "back" -> BrowserStep.Back
            "wait" -> wait(input)
            else -> BrowserStep.Capture
        }
    }

    private fun flag(input: JSONObject, key: String): Boolean = when (val v = input.opt(key)) {
        null, JSONObject.NULL -> false
        is Boolean -> v
        else -> throw Rejected("$key must be true or false")
    }

    private fun wait(input: JSONObject): BrowserStep {
        val ms = input.opt("ms").takeIf { it != JSONObject.NULL }
        val text = input.opt("text").takeIf { it != JSONObject.NULL }
        if ((ms == null) == (text == null)) throw Rejected("wait takes either ms (at most $MAX_WAIT_MS) or text, not both")
        if (ms != null) {
            val value = (ms as? Number)?.toDouble() ?: throw Rejected("wait ms must be a number")
            if (value != Math.floor(value) || value < 0 || value > MAX_WAIT_MS) throw Rejected("wait ms must be a whole number from 0 to $MAX_WAIT_MS")
            return BrowserStep.WaitMs(value.toLong())
        }
        val wanted = (text as? String)?.trim().orEmpty()
        if (wanted.isEmpty() || wanted.length > MAX_WAIT_TEXT) throw Rejected("wait text must be 1-$MAX_WAIT_TEXT characters")
        return BrowserStep.WaitText(wanted)
    }

    /** browser.run's steps: all of them are checked before the first one runs, so a typo never leaves half a script done. */
    fun steps(raw: Any?): List<BrowserStep> {
        val list = raw as? JSONArray ?: throw Rejected("steps must be a list of {op, ...}")
        if (list.length() < 1 || list.length() > MAX_STEPS) throw Rejected("steps must have 1 to $MAX_STEPS entries")
        return (0 until list.length()).map { i ->
            val item = list.opt(i) as? JSONObject ?: throw Rejected("step ${i + 1} must be an object with an op")
            val op = item.opt("op") as? String ?: throw Rejected("step ${i + 1} needs an op")
            try { step(op, item, strict = true) } catch (e: Rejected) { throw Rejected("step ${i + 1} ($op): ${e.message}") }
        }
    }

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
