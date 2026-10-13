package ai.ash.ui

import org.json.JSONObject

/**
 * What the 幕后 → 模型 page shows of `service:agents/runtime.catalog`: the page is a plain front end of the same words an agent uses
 * (`runtime.catalog` to read, `update` to save, `configure {login}` for Codex). All the reading of the reply is here, so it can be tested.
 */
internal object HomeCatalog {
    enum class Action { KEY, LOGIN }
    class ModelView(val id: String, val name: String, val efforts: List<String>, val info: String)
    class ProviderView(val id: String, val name: String, val ready: Boolean, val status: String, val tone: String, val action: Action?, val models: List<ModelView>, val hidden: String?)

    private val LABELS = mapOf("off" to "不思考", "minimal" to "极低", "low" to "低", "medium" to "中", "high" to "高", "xhigh" to "很高", "max" to "最高")
    fun effortLabel(effort: String): String = LABELS[effort] ?: effort

    fun contextText(tokens: Double?): String? = when {
        tokens == null || tokens <= 0 -> null
        tokens >= 1_000_000 -> "上下文 ${trim(tokens / 1_000_000)} M"
        else -> "上下文 ${(tokens / 1000).toInt()} K"
    }
    private fun trim(v: Double) = if (v == Math.floor(v)) v.toInt().toString() else String.format("%.1f", v)

    fun modelView(m: JSONObject): ModelView {
        val efforts = m.optJSONArray("efforts")?.let { a -> (0 until a.length()).mapNotNull { a.optString(it).ifEmpty { null } } } ?: emptyList()
        val info = listOfNotNull(contextText(m.dbl("context_window")), if (m.optBoolean("images")) "能看图" else null, if (efforts.isNotEmpty()) "会思考" else null).joinToString(" · ")
        return ModelView(m.str("id").orEmpty(), m.str("name")?.ifEmpty { null } ?: m.str("id").orEmpty(), efforts, info)
    }

    fun providers(catalog: JSONObject): List<ProviderView> = catalog.list("providers").map { p ->
        val auth = p.optJSONObject("auth")
        val ready = p.optBoolean("ready")
        val kind = auth?.str("kind")
        val (status, tone, action) = when {
            ready -> Triple("可用", "ok", null)
            kind == "key" -> Triple("还没配密钥", "warn", Action.KEY)
            kind == "login" && auth.str("state") == "pending" -> Triple("正在登录，等你在浏览器里输码", "warn", null)
            kind == "login" -> Triple("还没登录", "warn", Action.LOGIN)
            else -> Triple("暂不可用", "warn", null)
        }
        ProviderView(p.str("id").orEmpty(), p.str("name").orEmpty(), ready, status, tone, action, p.list("models").map(::modelView), p.str("models_hidden"))
    }

    /** The effort saved for a model: its own entry, else the declaration's effort when the declaration's model is this one. */
    fun savedEffort(saved: JSONObject?, model: String): String? =
        saved?.optJSONObject("models")?.optJSONObject(model)?.str("effort") ?: saved?.takeIf { it.str("model") == model }?.str("effort")

    /** What to send to `service:agents/update` to make `model` the one in use, with its effort. */
    fun updateBody(agent: String, model: String, effort: String?): JSONObject {
        val runtime = JSONObject().put("model", model)
        if (effort != null) runtime.put("models", JSONObject().put(model, JSONObject().put("effort", effort)))
        return JSONObject().put("agent", agent).put("runtime", runtime)
    }

    fun switchBody(agent: String, kind: String): JSONObject = JSONObject().put("agent", agent).put("runtime", JSONObject().put("kind", kind))

    /** The login card for the owner: the link, the code, and what to do first. */
    /** What the Codex card says while a login is under way (pi's browser login). */
    const val LOGIN_TEXT =
        "先打开手机的全局 VPN（要能打开 OpenAI 的页面），再点「打开登录页」，用 ChatGPT 账号登录。登录完页面会跳回手机本机，成功后会通知你，那时可以关掉 VPN。"
}
