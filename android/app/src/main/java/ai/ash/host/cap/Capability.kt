package ai.ash.host.cap

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * One thing the phone can do for ash (and, through ash, for its agents).
 *
 * ash core fetches the phone's manifest (`GET /manifest` on the host bridge) and calls
 * capabilities with `POST /call`; grants and owner confirmations are enforced by ash core,
 * so a capability only does its job. `confirm = true` makes ash ask the owner before every call.
 * Capabilities run on a bridge worker thread (never the main thread) and may block.
 */
interface Capability {
    /** Dotted name, e.g. "screen.tap", "clipboard.get". */
    val name: String
    /** What it does, written for the model (English; say when it needs a system permission). */
    val description: String
    /** JSON Schema of the arguments (type: object). */
    val schema: JSONObject
    val confirm: Boolean get() = false

    /** Listed in the manifest only when it can work right now (e.g. accessibility enabled). */
    fun available(ctx: Context): Boolean = true

    fun run(ctx: Context, args: JSONObject): CapResult
}

/** Result in ash's CallResult shape: MCP-style content blocks (+ optional structured data). */
class CapResult private constructor(val ok: Boolean, val content: JSONArray, val data: Any?, val error: String?) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("ok", ok)
        put("content", content)
        if (data != null) put("data", data)
        if (error != null) put("error", error)
    }

    companion object {
        fun text(t: String, data: Any? = null) = CapResult(true, JSONArray().put(JSONObject().put("type", "text").put("text", t)), data, null)

        fun json(data: JSONObject) = text(data.toString(1), data)

        /** An image (e.g. a screenshot, base64 PNG/JPEG) with an optional caption. */
        fun image(base64: String, mime: String, caption: String? = null): CapResult {
            val c = JSONArray()
            if (caption != null) c.put(JSONObject().put("type", "text").put("text", caption))
            c.put(JSONObject().put("type", "image").put("data", base64).put("mimeType", mime))
            return CapResult(true, c, null, null)
        }

        /** Text (e.g. a page) followed by an image, with structured data. */
        fun textAndImage(t: String, base64: String, mime: String, data: Any? = null) = CapResult(true, JSONArray()
            .put(JSONObject().put("type", "text").put("text", t))
            .put(JSONObject().put("type", "image").put("data", base64).put("mimeType", mime)), data, null)

        fun fail(msg: String) = CapResult(false, JSONArray().put(JSONObject().put("type", "text").put("text", msg)), null, msg)
    }
}

/** Tiny schema builder: `schema("x" to prop("string", "…", required = true))`. */
fun schema(vararg props: Pair<String, JSONObject>): JSONObject {
    val properties = JSONObject()
    val required = JSONArray()
    for ((k, v) in props) {
        if (v.optBoolean("__required")) required.put(k)
        v.remove("__required")
        properties.put(k, v)
    }
    return JSONObject().put("type", "object").put("properties", properties).apply { if (required.length() > 0) put("required", required) }
}

fun prop(type: String, description: String, required: Boolean = false, enum: List<String>? = null): JSONObject =
    JSONObject().put("type", type).put("description", description).apply {
        if (required) put("__required", true)
        if (enum != null) put("enum", JSONArray(enum))
    }

/** Simple capability from a lambda. */
class Cap(
    override val name: String,
    override val description: String,
    override val schema: JSONObject = schema(),
    override val confirm: Boolean = false,
    private val availableIf: (Context) -> Boolean = { true },
    private val body: (Context, JSONObject) -> CapResult,
) : Capability {
    override fun available(ctx: Context) = availableIf(ctx)
    override fun run(ctx: Context, args: JSONObject) = body(ctx, args)
}
