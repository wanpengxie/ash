package ai.ash.kernel

import org.json.JSONObject

/** What the supervisor hears from the core through the host interface. */
interface HostCallbacks {
    /** Any authenticated call: the core is alive. */
    fun onActivity()
    fun onReady(version: String, linkPort: Int)
    fun onRestart(reason: String)
    fun onStatus(text: String, state: String)
}

/** The local hands (apps on this phone) the link details are handed to. */
interface HandsPort {
    /** Package names the link details were delivered to. */
    fun handoff(port: Int, token: String): List<String>
}

/**
 * The host interface of `ash-host/1` (SPEC-07 section 3): one call of the core, by method name with its parameters, and
 * the answer. It arrives over the core's private pipe ([HostPipe]), which only the host that started the core holds, so
 * there is no token. Methods of capabilities that are not declared do not exist.
 */
class HostApi(
    /** Capability groups this host declares (host.json `capabilities`). */
    val capabilities: List<String>,
    private val identity: Identity,
    private val wake: WakeManager,
    private val power: PowerPort,
    private val hands: HandsPort,
    private val callbacks: HostCallbacks,
    private val log: (String) -> Unit = {},
    /** The phone actions (vscreen / input / apps). Non-null when any of those groups is declared. */
    private val phone: PhonePort? = null,
    /** Installing a new release of Ash's packages. Non-null when `update` is declared. */
    private val update: UpdatePort? = null,
) {
    /** One call; the answer is `{"ok":true,"result":…}` or `{"ok":false,"error":{"code","message"}}`. */
    fun call(method: String, params: JSONObject): JSONObject {
        callbacks.onActivity()
        val group = METHOD_CAPABILITY[method]
        if (group == null || group !in capabilities) return error("not_found", "no $method")
        return try {
            ok(dispatch(method, params))
        } catch (e: BadRequest) {
            error("bad_request", e.message ?: "bad request")
        } catch (e: PhoneBadRequest) {
            error("bad_request", e.message ?: "bad request")
        } catch (e: PhoneUnavailable) {
            error("unavailable", e.message ?: "not available")
        } catch (e: PhoneFailed) {
            error("failed", e.message ?: "failed")
        } catch (e: Exception) {
            log("host call $method failed: ${e.javaClass.simpleName}")
            error("failed", e.javaClass.simpleName)
        }
    }

    private fun dispatch(method: String, b: JSONObject): JSONObject = when (method) {
        "identity.key" -> {
            val spki = identity.publicKey()
            JSONObject().put("id", Codec.keyId(spki)).put("public_key", Codec.b64u(spki))
        }
        "identity.sign" -> {
            val data = try { Codec.unb64u(b.str("data")) } catch (_: IllegalArgumentException) { throw BadRequest("data is not base64url") }
            if (data.size > MAX_SIGN_BYTES) throw BadRequest("data too large")
            JSONObject().put("sig", Codec.b64u(identity.sign(data)))
        }
        "lifecycle.ready" -> {
            callbacks.onReady(b.str("version"), b.int("link_port", 1, 65535))
            JSONObject()
        }
        "lifecycle.restart" -> {
            callbacks.onRestart(b.optString("reason").take(200))
            JSONObject()
        }
        "status.set" -> {
            val state = b.str("state", allowEmpty = false)
            if (state !in STATES) throw BadRequest("state must be one of ${STATES.joinToString("|")}")
            callbacks.onStatus(b.optString("text").take(200), state)
            JSONObject()
        }
        "wake.at" -> {
            wake.at(b.long("at", 1))
            JSONObject()
        }
        "wake.clear" -> {
            wake.clear()
            JSONObject()
        }
        "power.hold" -> {
            val ms = b.long("ms", 1).coerceAtMost(MAX_HOLD_MS)
            power.hold(ms, b.optString("reason").take(100))
            JSONObject()
        }
        "power.release" -> {
            power.release()
            JSONObject()
        }
        "hands.handoff" -> {
            val delivered = hands.handoff(b.int("port", 1, 65535), b.str("token"))
            JSONObject().put("delivered", org.json.JSONArray(delivered))
        }
        "update.install" -> {
            val port = update ?: throw BadRequest("unsupported $method")
            val version = b.str("version")
            if (!VERSION.matches(version)) throw BadRequest("version must look like 1.2.3")
            val list = b.optJSONArray("packages") ?: throw BadRequest("packages must be a list")
            val packages = (0 until list.length()).map { i ->
                val p = list.optJSONObject(i) ?: throw BadRequest("packages[$i] must be an object")
                val pkg = p.str("package")
                val url = p.str("url")
                val sha = p.str("sha256")
                if (pkg !in Updater.PACKAGES) throw BadRequest("packages[$i]: only ${Updater.PACKAGES.joinToString()} are updated here")
                if (!url.startsWith("https://")) throw BadRequest("packages[$i]: url must be https")
                if (!SHA256.matches(sha)) throw BadRequest("packages[$i]: sha256 must be 64 hex digits")
                UpdatePackage(pkg, url, sha)
            }
            if (packages.isEmpty() || packages.map { it.pkg }.toSet().size != packages.size) throw BadRequest("packages must name each package once")
            // The app first, the kernel last: installing the kernel ends this process.
            val ordered = packages.sortedBy { Updater.PACKAGES.indexOf(it.pkg) }
            val token = b.optString("token").takeIf { it.isNotEmpty() }
            if (token != null && token.length > 512) throw BadRequest("token too long")
            val via = try { port.start(version, ordered, token) } catch (e: IllegalStateException) { throw BadRequest(e.message ?: "busy") }
            JSONObject().put("started", true).put("via", via)
        }
        "update.status" -> (update ?: throw BadRequest("unsupported $method")).status()
        else -> {
            val port = phone ?: throw BadRequest("unsupported $method")
            // What went wrong on the phone (am start refused, the virtual screen gone) is the caller's to read.
            try { port.call(method, b) } catch (e: IllegalStateException) { throw PhoneFailed(e.message ?: e.javaClass.simpleName) }
        }
    }

    private class BadRequest(message: String) : Exception(message)

    private fun JSONObject.str(key: String, allowEmpty: Boolean = false): String {
        val v = opt(key)
        if (v !is String || (!allowEmpty && v.isEmpty())) throw BadRequest("$key must be a non-empty string")
        return v
    }

    private fun JSONObject.long(key: String, min: Long): Long {
        val v = opt(key)
        if (v !is Number || v.toDouble() != Math.floor(v.toDouble()) || v.toLong() < min) throw BadRequest("$key must be an integer >= $min")
        return v.toLong()
    }

    private fun JSONObject.int(key: String, min: Int, max: Int): Int {
        val v = long(key, min.toLong())
        if (v > max) throw BadRequest("$key must be at most $max")
        return v.toInt()
    }

    private fun ok(result: JSONObject) = JSONObject().put("ok", true).put("result", result)

    private fun error(code: String, message: String) =
        JSONObject().put("ok", false).put("error", JSONObject().put("code", code).put("message", message))

    companion object {
        /** What every host declares; `update` (and the phone actions) are added by the host that can do them. */
        val CAPABILITIES = listOf("identity", "lifecycle", "status", "wake", "power", "hands")

        private val METHOD_CAPABILITY = mapOf(
            "identity.key" to "identity", "identity.sign" to "identity",
            "lifecycle.ready" to "lifecycle", "lifecycle.restart" to "lifecycle",
            "status.set" to "status",
            "wake.at" to "wake", "wake.clear" to "wake",
            "power.hold" to "power", "power.release" to "power",
            "hands.handoff" to "hands",
            "update.install" to "update", "update.status" to "update",
            "vscreen.create" to "vscreen", "vscreen.status" to "vscreen", "vscreen.launch" to "vscreen",
            "vscreen.see" to "vscreen", "vscreen.tap" to "vscreen", "vscreen.swipe" to "vscreen",
            "vscreen.key" to "vscreen", "vscreen.type" to "vscreen", "vscreen.close" to "vscreen",
            "vscreen.record.start" to "vscreen", "vscreen.record.stop" to "vscreen",
            "input.key" to "input",
            "apps.open" to "apps",
        )
        private val STATES = listOf("starting", "running", "degraded", "stopping")
        private val VERSION = Regex("^\\d+\\.\\d+\\.\\d+$")
        private val SHA256 = Regex("^[0-9a-f]{64}$")
        private const val MAX_HOLD_MS = 600_000L
        private const val MAX_SIGN_BYTES = 64 * 1024
    }
}
