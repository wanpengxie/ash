package ai.ash.ui

import android.os.Handler
import android.os.Looper
import android.util.Base64
import ai.ash.human.ChatBridge
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID

/**
 * The native screens' one way to the kernel: a page of the [ChatBridge], speaking the frames of the human channel (SPEC-05
 * §4.1) as the web page did. Everything here is called and answered on the main thread.
 *
 *  - [call] a word and get its data (or the failure); [send] any request frame as it is.
 *  - [changed] listeners hear that the ledger moved (one follow `sync` is kept open while the channel is open); they read what
 *    they show again — nothing is mirrored here.
 *  - [stream] waits for a `stream` the kernel sends (a file a word answered with a `resource`).
 *  - [presence] tells the kernel the owner is looking / typing.
 */
class HumanPort(private val bridge: ChatBridge) : ChatBridge.Page {
    /** A failed word: [code] is one of SPEC-02 §7's error codes. */
    data class Failure(val code: String, val message: String)

    private val main = Handler(Looper.getMainLooper())
    var open = false; private set
    /** The primary agent (`service:agents list`), the one the owner talks to. */
    var primary: String? = null; private set
    private var sid: String? = null
    private val waiting = HashMap<String, (JSONObject) -> Unit>()
    private val linkListeners = ArrayList<(Boolean) -> Unit>()
    private val changeListeners = ArrayList<() -> Unit>()
    private val cardListeners = ArrayList<(JSONObject) -> Unit>()
    private class Partial(val mime: String, val bytes: ByteArrayOutputStream = ByteArrayOutputStream())
    private val incoming = HashMap<String, Partial>()
    private val arrived = LinkedHashMap<String, Pair<String, ByteArray>>()
    private val streamWaiters = HashMap<String, (String?, ByteArray?, Failure?) -> Unit>()

    fun start() = bridge.attach(this)
    fun stop() = bridge.detach(this)

    fun onLink(l: (Boolean) -> Unit) { linkListeners.add(l); l(open) }
    fun onChange(l: () -> Unit) { changeListeners.add(l) }
    fun removeChange(l: () -> Unit) { changeListeners.remove(l) }
    /** A card in the conversation changed (`chat` present `card.patch {card}`): [l] gets the whole card as it is now. */
    fun onCard(l: (JSONObject) -> Unit) { cardListeners.add(l) }
    fun removeCard(l: (JSONObject) -> Unit) { cardListeners.remove(l) }

    override fun post(message: String) { main.post { receive(message) } }

    private fun receive(message: String) {
        val m = runCatching { JSONObject(message) }.getOrNull() ?: return
        when (m.optString("type")) {
            "link" -> linkChanged(m.optBoolean("open"))
            "frame" -> frame(m.optJSONObject("frame") ?: return)
        }
    }

    private fun linkChanged(nowOpen: Boolean) {
        open = nowOpen
        sid = null
        if (!open) {
            val lost = ArrayList(waiting.values); waiting.clear()
            lost.forEach { it(JSONObject().put("ok", false).put("error", JSONObject().put("code", "result_unknown").put("message", "连接断了"))) }
            streamWaiters.values.toList().forEach { it(null, null, Failure("offline", "连接断了")) }; streamWaiters.clear(); incoming.clear()
        } else {
            val s = "y_" + UUID.randomUUID()
            sid = s
            out(JSONObject().put("t", "sync").put("ch", "human").put("sid", s).put("limit", 1).put("follow", true).put("summary", true))
            call("service:agents", "list", JSONObject()) { data, _ ->
                val agents = data?.optJSONArray("agents") ?: JSONArray()
                for (i in 0 until agents.length()) agents.optJSONObject(i)?.takeIf { it.optBoolean("primary") }?.let { primary = it.optString("id") }
            }
        }
        linkListeners.toList().forEach { it(open) }
    }

    private fun frame(f: JSONObject) {
        when (f.optString("t")) {
            "send.result" -> waiting.remove(f.optString("id"))?.invoke(f)
            "sync.page", "sync.msg" -> if (f.optString("sid") == sid) changeListeners.toList().forEach { it() }
            // A `chat` present: a card that changed is drawn again where it is; focus / open: the chat is the app's front screen, it is up.
            "present" -> {
                if (f.optString("op") == "card.patch") f.optJSONObject("body")?.optJSONObject("card")?.let { card -> cardListeners.toList().forEach { it(card) } }
                out(JSONObject().put("t", "present.result").put("id", f.optString("id")).put("ok", true))
            }
            "stream" -> stream(f)
            "error" -> waiting.remove(f.optString("id"))?.invoke(JSONObject().put("ok", false)
                .put("error", JSONObject().put("code", f.optString("code", "failed")).put("message", f.optString("message"))))
        }
    }

    private fun out(frame: JSONObject) = Thread { bridge.fromPage(frame) }.start()

    /** Sends one request (`{to, kind, word, body, ...}`); [done] gets the `send.result` frame. */
    fun send(request: JSONObject, done: (JSONObject) -> Unit = {}) {
        if (!open) { done(JSONObject().put("ok", false).put("error", JSONObject().put("code", "offline").put("message", "还没连上"))); return }
        val id = "s_" + UUID.randomUUID()
        waiting[id] = done
        out(JSONObject().put("t", "send").put("ch", "human").put("id", id).put("request", request))
    }

    /** A request that waits for its answer: [done] gets the answer's data, or why there is none. */
    fun call(to: String, word: String, body: JSONObject = JSONObject(), done: (JSONObject?, Failure?) -> Unit) =
        send(JSONObject().put("to", to).put("kind", "request").put("word", word).put("body", body).put("wait", true)) { r ->
            val reply = r.optJSONObject("response")
            when {
                !r.optBoolean("ok") -> done(null, failureOf(r.optJSONObject("error")))
                reply == null -> done(null, Failure("result_unknown", "还没有收到结果"))
                reply.optBoolean("ok") -> done(reply.optJSONObject("result")?.optJSONObject("data") ?: JSONObject(), null)
                else -> done(null, failureOf(reply.optJSONObject("error")))
            }
        }

    private fun failureOf(e: JSONObject?) = Failure(e?.optString("code").orEmpty().ifEmpty { "failed" }, e?.optString("message").orEmpty().ifEmpty { "没有成功" })

    fun presence(visible: Boolean? = null, typing: Boolean? = null) {
        if (!open) return
        val f = JSONObject().put("t", "presence").put("ch", "human")
        visible?.let { f.put("visible", it) }
        typing?.let { f.put("typing", it); primary?.let { p -> f.put("agent", p) } }
        out(f)
    }

    /** Waits for the stream [sid] (up to a minute); [done] gets its media type and bytes, or why not. */
    fun stream(sid: String, done: (String?, ByteArray?, Failure?) -> Unit) {
        arrived.remove(sid)?.let { done(it.first, it.second, null); return }
        streamWaiters[sid] = done
        main.postDelayed({ streamWaiters.remove(sid)?.invoke(null, null, Failure("timeout", "文件没有送到")) }, 60_000)
    }

    private fun stream(f: JSONObject) {
        val s = f.optString("sid")
        when (f.optString("op")) {
            "open" -> incoming[s] = Partial(f.optString("mime"))
            "data" -> incoming[s]?.bytes?.write(runCatching { Base64.decode(f.optString("b64"), Base64.DEFAULT) }.getOrDefault(ByteArray(0)))
            "error" -> { incoming.remove(s); streamWaiters.remove(s)?.invoke(null, null, Failure(f.optString("code", "failed"), f.optString("message"))) }
            else -> {
                val p = incoming.remove(s) ?: return
                val bytes = p.bytes.toByteArray()
                val waiter = streamWaiters.remove(s)
                if (waiter != null) waiter(p.mime, bytes, null)
                else { arrived[s] = p.mime to bytes; if (arrived.size > 16) arrived.remove(arrived.keys.first()) }
            }
        }
    }
}
