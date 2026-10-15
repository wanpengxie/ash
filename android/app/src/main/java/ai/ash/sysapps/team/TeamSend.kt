package ai.ash.sysapps.team

import org.json.JSONObject

/** One durable owner question. An uncertain retry keeps its client id, target and text (MOBILE-ARCH §3.5, §6.2). */
data class TeamSend(val clientId: String, val agent: String, val text: String, val ledgerId: String? = null, val error: String? = null, val code: String? = null) {
    val refused get() = code in setOf("bad_request", "unauthorized", "forbidden", "not_found", "denied", "cancelled", "conflict", "too_large")
    fun request(): JSONObject = JSONObject().put("to", "service:agents").put("kind", "request").put("word", "ask")
        .put("body", JSONObject().put("agent", agent).put("text", text)).put("wait", false).put("client_id", clientId)
    fun json() = JSONObject().put("client", clientId).put("agent", agent).put("text", text).put("ledger", ledgerId).put("error", error).put("code", code)
    fun receipt(result: JSONObject): TeamSend? = result.optJSONObject("message")?.opt("id")?.let { id ->
        (id as? String)?.takeIf { it.isNotBlank() }?.let { copy(ledgerId = it, error = null, code = null) }
    }
    companion object {
        fun read(j: JSONObject): TeamSend? {
            val id = j.opt("client") as? String ?: return null
            val agent = j.opt("agent") as? String ?: return null
            val text = j.opt("text") as? String ?: return null
            if (id.isBlank() || !agent.startsWith("agent:") || text.isBlank()) return null
            return TeamSend(id, agent, text, j.opt("ledger") as? String, j.opt("error") as? String, j.opt("code") as? String)
        }
    }
}
