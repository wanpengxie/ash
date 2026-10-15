package ai.ash.ui

import ai.ash.apps.AppIds
import ai.ash.apps.Csp
import ai.ash.apps.HostPage
import org.json.JSONObject

/**
 * The host's checks on what a card's mini app (its Html component) says (MOBILE-ARCH §12.4): who it is is bound here when
 * the page is made ([card], [component], [app]), never read from a message. A message counts only when it came on the port
 * handed to the current page ([ticket] of the current [load]), the page is on screen ([active]), it is at most 64 KB of
 * JSON-RPC 2.0 `{jsonrpc, id, method, params}` with one of the four methods and its params in shape, and within the rate.
 * A card without an app has `ash/send` only. No Android here; unit tested on the JVM.
 */
class MiniGate(val card: String, val component: String, app: String?) {
    /** The card's app, when it has a valid one (else the card is sandboxed and only sends events). */
    val app: String? = app?.takeIf { AppIds.valid(it) }

    /** Where the page runs: its app's own origin, or the one sandbox of cards without an app. */
    val origin: String = this.app?.let { AppIds.origin(it) } ?: CARD_ORIGIN

    /** The page now: bumped on every load. */
    var generation = 0L; private set
    private var tickets = 0L
    private var current = 0L
    /** On screen and handed a port: messages are taken. */
    var active = false; private set
    private var lastSend = Long.MIN_VALUE / 2
    private val calls = ChatCardModel.Rate(2, 1000)

    /** One port handed to one page. */
    class Ticket internal constructor(val generation: Long, val id: Long)

    sealed class Verdict {
        /** `ash.send(action, context)`: as if a Button with that event was tapped. */
        class Send(val action: String, val context: JSONObject) : Verdict()
        /** `ash.call / ask / tell`: the act's `request`; the answer goes back with [id]. */
        class Act(val id: Any, val request: JSONObject) : Verdict()
        /** Refused; [id] when the page may be told so (the message came on the current port). */
        class Refuse(val reason: String, val id: Any? = null) : Verdict()
    }

    /** A new page is loaded: every port of the one before is void. */
    fun load(): Long { generation++; current = 0; active = false; return generation }

    /** A port is handed to the current page: it is the only one messages are taken on from now. */
    fun ticket(): Ticket { val t = Ticket(generation, ++tickets); current = t.id; active = true; return t }

    /** Off screen (or the card not active): its port is closed, nothing is taken until a new one. */
    fun pause() { active = false; current = 0 }

    /** Whether [t] is the port of the page now, on screen. */
    fun live(t: Ticket?): Boolean = t != null && active && t.generation == generation && t.id == current

    /** What to do with [raw], which came on the port of [t] (null: not on a port of ours) at [now] ms. */
    fun check(t: Ticket?, raw: String?, now: Long): Verdict {
        if (t == null) return Verdict.Refuse("no_port")
        if (t.generation != generation) return Verdict.Refuse("old_page")
        if (!live(t)) return Verdict.Refuse("not_current")
        if (raw == null || raw.length > MAX_BYTES || raw.toByteArray(Charsets.UTF_8).size > MAX_BYTES) return Verdict.Refuse("too_large")
        val m = runCatching { JSONObject(raw) }.getOrNull() ?: return Verdict.Refuse("not_json")
        val id = m.opt("id").takeIf { it is String && it.isNotEmpty() && it.length <= 64 || it is Int || it is Long }
            ?: return Verdict.Refuse("bad_id")
        if (m.opt("jsonrpc") != "2.0") return Verdict.Refuse("not_jsonrpc", id)
        val params = m.opt("params") as? JSONObject ?: return Verdict.Refuse("bad_params", id)
        return when (val method = m.opt("method")) {
            "ash/send" -> {
                val action = (params.opt("action") as? String)?.trim()?.takeIf { it.isNotEmpty() && it.length <= 64 } ?: return Verdict.Refuse("bad_params", id)
                val context = when (val c = params.opt("context")) { null, JSONObject.NULL -> JSONObject(); is JSONObject -> c; else -> return Verdict.Refuse("bad_params", id) }
                if (now - lastSend < SEND_GAP_MS) return Verdict.Refuse("too_fast", id)
                lastSend = now
                Verdict.Send(action, context)
            }
            "ash/call", "ash/ask", "ash/tell" -> {
                if (app == null) return Verdict.Refuse("not_allowed", id)
                val kind = (method as String).removePrefix("ash/")
                val inner = if (kind == "call") JSONObject().put("member", params.opt("member")).put("word", params.opt("word")).put("body", params.opt("body") ?: JSONObject.NULL)
                    else JSONObject().put("text", params.opt("text"))
                val request = ChatCardModel.miniRequest(JSONObject().put(kind, inner).toString()) ?: return Verdict.Refuse("bad_params", id)
                if (!calls.take(now)) return Verdict.Refuse("too_fast", id)
                Verdict.Act(id, request)
            }
            else -> Verdict.Refuse("bad_method", id)
        }
    }

    /** `service:cards/act` for an accepted request: this card and component (never what the page says it is). */
    fun actBody(request: JSONObject, data: JSONObject): JSONObject = ChatCardModel.actBody(card, component, data, request)

    /** The answer to request [id]: the act's `{state, text, result?}`. */
    fun reply(id: Any, answer: JSONObject): String = JSONObject().put("jsonrpc", "2.0").put("id", id).put("result", answer).toString()

    /** A refusal the page is told about. */
    fun refusal(id: Any, reason: String): String = JSONObject().put("jsonrpc", "2.0").put("id", id)
        .put("error", JSONObject().put("code", -32600).put("message", if (reason == "too_fast") "太快了，稍后再试" else if (reason == "not_allowed") "这个小应用不能这样做" else "这个请求看不懂")).toString()

    /**
     * The document the page loads: the app page's own CSP (cards declare no network: none) and port shim ([HostPage]), then
     * the theme as CSS variables (`--ash-bg` …) and `window.ash` (JSON-RPC over that port; `call / ask / tell` only for a card
     * of an app), then the agent's HTML.
     */
    fun document(html: String, vars: Map<String, String>, dark: Boolean, token: String): String {
        val css = vars.entries.joinToString(";") { "--ash-${it.key}:${it.value}" }
        val head = "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
            "<style>:root{$css;color-scheme:${if (dark) "dark" else "light"}}</style><script>${api(app != null)}</script>"
        return HostPage.build(html, Csp.inlineOnly(), token, head)
    }

    companion object {
        /** The one origin of cards without an app (.invalid never resolves). */
        const val CARD_ORIGIN = "https://card.ash-card.invalid"
        const val MAX_BYTES = 64 * 1024
        const val SEND_GAP_MS = 800L

        /**
         * `window.ash`: `send(action, context)`; for a card of an app also `call(member, word, body)`, `ask(text)`, `tell(text)`, each a
         * Promise of `{state, text, result?}`. Requests are JSON-RPC posted to the page itself, which the shim sends on the port;
         * answers come back as message events, matched by id.
         */
        fun api(full: Boolean): String = """
(function(){
  var post = window.postMessage, seq = 0, wait = {};
  function rpc(method, params, answer){ var id = "a" + (++seq); if (answer) wait[id] = answer; post.call(window, {jsonrpc: "2.0", id: id, method: method, params: params}, "*"); }
  window.addEventListener("message", function(e){
    var m = e.data; if (!m || m.jsonrpc !== "2.0" || typeof m.id !== "string" || !wait.hasOwnProperty(m.id) || m.method !== undefined) return;
    var w = wait[m.id]; delete wait[m.id];
    w(m.error ? {state: "failed", text: String(m.error.message || "")} : m.result);
  });
  function req(method, params){ return new Promise(function(ok){ rpc(method, params, ok); }); }
  var api = {send: function(a, c){ rpc("ash/send", {action: String(a), context: c === undefined ? {} : c}); }};
  if ($full) {
    api.call = function(m, w, body){ return req("ash/call", {member: String(m), word: String(w), body: body === undefined ? {} : body}); };
    api.ask = function(t){ return req("ash/ask", {text: String(t)}); };
    api.tell = function(t){ return req("ash/tell", {text: String(t)}); };
  }
  Object.defineProperty(window, "ash", {value: Object.freeze(api), writable: false, configurable: false});
})();
""".trim()
    }
}

/** At most [max] mini apps alive at once: the one seen longest ago goes first (MOBILE-ARCH §12.3). */
class MiniBudget<T>(private val max: Int) {
    private val order = LinkedHashSet<T>()
    /** [t] is alive and was seen now; the ones to let go, oldest first. */
    fun seen(t: T): List<T> {
        order.remove(t); order.add(t)
        val out = ArrayList<T>()
        while (order.size > max) order.first().also { order.remove(it); out.add(it) }
        return out
    }
    fun gone(t: T) { order.remove(t) }
    fun size() = order.size
}
