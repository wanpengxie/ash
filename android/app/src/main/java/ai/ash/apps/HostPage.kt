package ai.ash.apps

/**
 * The document an app's WebView loads: the app's own HTML with, first thing in its head, the CSP meta tag and the
 * bridge shim. An MCP Apps view expects to sit in an iframe and talk JSON-RPC to `window.parent` with postMessage;
 * here it is the top page (so `window.parent === window`), and the shim makes that work over a WebMessagePort.
 */
object HostPage {
    private val DOCTYPE = Regex("^\\s*<!doctype[^>]*>", RegexOption.IGNORE_CASE)

    /** [extraHead] goes right after the shim (a card's mini app: its theme and `window.ash`). */
    fun build(html: String, csp: Csp, token: String, extraHead: String = ""): String {
        require(Regex("[A-Za-z0-9_-]{8,64}").matches(token))
        val body = html.removePrefix("﻿")
        val head = csp.meta() + "<script>" + shim(token) + "</script>" + extraHead
        val doctype = DOCTYPE.find(body)
        // Before the app's own markup: the parser puts both in the head, ahead of any script of the app's.
        return if (doctype != null) doctype.value + head + body.substring(doctype.range.last + 1) else head + body
    }

    /**
     * The shim. Outgoing: a JSON-RPC message the view posts to its "parent" (itself) goes to the host's port instead;
     * any other postMessage behaves as before. Incoming: the host hands over its port once (a message carrying
     * [token], hidden from the app; the same handshake again is ignored); what arrives on it is dispatched to the view as a
     * `message` event from its parent. Messages sent before the port arrives wait in a queue. A host that closed its port
     * (a card's mini app off screen) hands a new one as `token#n`, n counting up: it replaces the one before.
     */
    fun shim(token: String): String = """
(function(){
  var TOKEN = "$token";
  var port = null, queue = [], epoch = 0;
  var post = window.postMessage;
  function rpc(m){ return m !== null && typeof m === "object" && m.jsonrpc === "2.0"; }
  function send(m){ var s; try { s = JSON.stringify(m); } catch (e) { return; } if (port) port.postMessage(s); else if (queue.length < 200) queue.push(s); }
  window.postMessage = function(message){ if (rpc(message)) { send(message); return; } return post.apply(window, arguments); };
  window.addEventListener("message", function(e){
    var d = e.data, n = 0;
    if (d !== TOKEN) {
      if (typeof d !== "string" || d.indexOf(TOKEN + "#") !== 0) return;
      n = Number(d.slice(TOKEN.length + 1));
      if (!(n > 0)) return;
    }
    e.stopImmediatePropagation();
    if ((port !== null && n <= epoch) || !e.ports || e.ports.length !== 1) { for (var i = 0; e.ports && i < e.ports.length; i++) e.ports[i].close(); return; }
    if (port !== null) port.close();
    epoch = n;
    port = e.ports[0];
    port.onmessage = function(ev){
      var data; try { data = JSON.parse(ev.data); } catch (x) { return; }
      window.dispatchEvent(new MessageEvent("message", { data: data, origin: location.origin, source: window }));
    };
    for (var j = 0; j < queue.length; j++) port.postMessage(queue[j]);
    queue = [];
  }, true);
})();
""".trim()
}
