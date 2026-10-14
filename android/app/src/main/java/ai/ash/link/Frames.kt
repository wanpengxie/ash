package ai.ash.link

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/** `ash-link/2`: the protocol name, limits and close codes (SPEC-03 §1, §3, §7). The single definition is `packages/sdk/src/link.ts`. */
object LinkProtocol {
    const val NAME = "ash-link/2"
    /** One frame, as UTF-8 JSON text. */
    const val FRAME_BYTES = 4 * 1024 * 1024
    /** One `stream` data chunk, before base64. */
    const val STREAM_CHUNK_BYTES = 256 * 1024
    /** Calls in flight on this hand; beyond this the hand answers `unavailable`. */
    const val INFLIGHT_CALLS = 16
    const val HEARTBEAT_MS = 30_000L
    /** No frame at all for this long: the connection is dropped. */
    const val SILENCE_MS = 90_000L
}

object CloseCodes {
    const val NORMAL = 1000
    /** Identity not proven (wrong token or signature). */
    const val UNAUTHENTICATED = 4001
    /** The hand has been revoked. */
    const val REVOKED = 4003
    /** Protocol version not supported. */
    const val UNSUPPORTED = 4008
    /** A newer connection of the same hand took this one's place. */
    const val SUPERSEDED = 4009
    const val BAD_FRAME = 4400
    const val INTERNAL = 4500
    /** A hand closed with one of these codes does not reconnect. */
    val NO_RECONNECT: Set<Int> = setOf(REVOKED, UNSUPPORTED, SUPERSEDED)
}

/** What a received WebSocket message turned into. */
sealed class Decoded {
    /** A valid frame of type [type]. */
    class Ok(val type: String, val frame: JSONObject) : Decoded()
    /** Not a valid frame; [id] is the frame's id when it had a readable one. */
    class Bad(val error: String, val type: String?, val id: String?) : Decoded()
}

/**
 * The frames of `ash-link/2`: checking, decoding and encoding, in strict mode (a field the protocol does not name is
 * refused, as in the TypeScript reference).
 *
 * The rules are not written again here. They are the JSON Schemas that `packages/sdk` generates from its one
 * definition (the files in `schema/link`), checked by [SchemaCheck]; the app carries the files as assets.
 * [read] returns the text of one schema file by name, e.g. `hello.json`.
 */
class FrameCodec(read: (String) -> String) {
    /** Who may send a frame: "kernel", "hand" or "both". */
    private val senders = HashMap<String, String>()
    private val schemas = HashMap<String, JSONObject>()
    private val capabilitySchema: JSONObject
    /** The limits and codes the schema index states; a test compares them with the constants above. */
    val index: JSONObject = JSONObject(read("index.json"))

    init {
        val frames = index.getJSONObject("frames")
        for (type in frames.keys()) {
            val entry = frames.getJSONObject(type)
            senders[type] = entry.getString("from")
            schemas[type] = SchemaCheck.load(read(entry.getString("file")))
        }
        capabilitySchema = SchemaCheck.load(read("capability-spec.json"))
    }

    val frameTypes: Set<String> get() = schemas.keys

    /** The sender the protocol allows for [type]: "kernel", "hand" or "both". */
    fun senderOf(type: String): String = senders.getValue(type)

    /** The frame type [value] names in `t`, if it is one. */
    fun typeOf(value: Any?): String? {
        val t = (value as? JSONObject)?.opt("t") as? String ?: return null
        return if (schemas.containsKey(t)) t else null
    }

    /** Why [value] is not a valid frame of type [type], or null when it is. */
    fun error(type: String, value: Any?): String? = SchemaCheck.check(schemas.getValue(type), value)

    /** Why one capability of a manifest is not acceptable, or null. */
    fun capabilityError(value: Any?): String? = SchemaCheck.check(capabilitySchema, value)

    /** Checks a decoded JSON value against the schema of the type its `t` names. */
    fun validate(value: Any?): Decoded {
        val id = (value as? JSONObject)?.opt("id") as? String
        val type = typeOf(value) ?: return Decoded.Bad("unknown or missing frame type", null, id)
        val problem = error(type, value)
        return if (problem != null) Decoded.Bad("$type: $problem", type, id) else Decoded.Ok(type, value as JSONObject)
    }

    /** Turns the text of a received WebSocket message into a checked frame. */
    fun decode(text: String): Decoded {
        if (tooLarge(text)) return Decoded.Bad("frame is larger than ${LinkProtocol.FRAME_BYTES} bytes", null, null)
        val value = try {
            val tokener = JSONTokener(text)
            val parsed = tokener.nextValue()
            if (tokener.nextClean().code != 0) null else parsed
        } catch (_: Exception) { null }
        if (value !is JSONObject) return Decoded.Bad("not JSON", null, null)
        return validate(value)
    }

    /** The wire text of [frame]. Throws when the frame breaks the protocol, so a bug is found where it is made. */
    fun encode(frame: JSONObject): String {
        val type = typeOf(frame) ?: throw IllegalArgumentException("not a frame")
        error(type, frame)?.let { throw IllegalArgumentException("invalid $type frame: $it") }
        val text = frame.toString()
        if (tooLarge(text)) throw FrameTooLarge("$type frame is larger than ${LinkProtocol.FRAME_BYTES} bytes; send it as a stream")
        return text
    }

    class FrameTooLarge(message: String) : RuntimeException(message)

    companion object {
        fun tooLarge(text: String): Boolean =
            text.length > LinkProtocol.FRAME_BYTES ||
                (text.length * 3L > LinkProtocol.FRAME_BYTES && text.toByteArray(Charsets.UTF_8).size > LinkProtocol.FRAME_BYTES)

        /** From a directory of schema files (unit tests read `packages/sdk/schema/link`). */
        fun fromDirectory(dir: java.io.File): FrameCodec = FrameCodec { name -> java.io.File(dir, name).readText(Charsets.UTF_8) }
    }
}

/**
 * A checker for the subset of JSON Schema 2020-12 that the files in `schema/link` use. A schema keyword it does not know
 * is refused when the schema is loaded, so a schema that grows cannot silently stop being enforced here.
 */
internal object SchemaCheck {
    private val KNOWN = setOf(
        "\$schema", "title", "type", "const", "enum", "properties", "required", "additionalProperties", "items",
        "minItems", "uniqueItems", "minLength", "maxLength", "minimum", "minProperties", "pattern",
        "oneOf", "anyOf", "not", "if", "then",
    )
    private val TYPES = setOf("object", "array", "string", "boolean", "null", "integer", "number")
    private val patterns = HashMap<String, Regex>()

    fun load(text: String): JSONObject = JSONObject(text).also(::checkKeywords)

    private fun checkKeywords(schema: JSONObject) {
        for (key in schema.keys()) {
            if (key !in KNOWN) throw IllegalArgumentException("unsupported JSON Schema keyword: $key")
            val v = schema.get(key)
            when (key) {
                "type" -> require(v is String && v in TYPES) { "unsupported JSON Schema type: $v" }
                "pattern" -> require(v is String && v.startsWith("^") && v.endsWith("$")) { "a pattern must be anchored with ^ and $" }
                "const" -> require(v is String || v is Boolean || v is Number) { "const must be a string, a boolean or a number" }
                "properties" -> (v as JSONObject).let { p -> for (name in p.keys()) checkKeywords(p.getJSONObject(name)) }
                "items", "not", "if", "then" -> checkKeywords(v as JSONObject)
                "oneOf", "anyOf" -> (v as JSONArray).let { a -> for (i in 0 until a.length()) checkKeywords(a.getJSONObject(i)) }
                "additionalProperties" -> require(v == false) { "only additionalProperties:false is supported" }
            }
        }
    }

    /** The first reason [value] does not satisfy [schema], or null when it does. */
    fun check(schema: JSONObject, value: Any?, path: String = ""): String? {
        val at = path.ifEmpty { "/" }
        if (schema.has("type") && !typeIs(schema.getString("type"), value)) return "$at must be ${schema.getString("type")}"
        if (schema.has("const") && !same(schema.get("const"), value)) return "$at must be ${schema.get("const")}"
        if (schema.has("enum")) {
            val options = schema.getJSONArray("enum")
            if ((0 until options.length()).none { same(options.get(it), value) }) return "$at must be one of the allowed values"
        }
        if (value is String) {
            val length = value.codePointCount(0, value.length)
            if (schema.has("minLength") && length < schema.getInt("minLength")) return "$at is too short"
            if (schema.has("maxLength") && length > schema.getInt("maxLength")) return "$at is too long"
            if (schema.has("pattern") && !pattern(schema.getString("pattern")).matches(value)) return "$at has a wrong format"
        }
        if (value is Number && schema.has("minimum") && value.toDouble() < schema.getDouble("minimum")) return "$at is below the minimum"
        if (value is JSONObject) objectError(schema, value, path)?.let { return it }
        if (value is JSONArray) {
            if (schema.has("minItems") && value.length() < schema.getInt("minItems")) return "$at has too few items"
            if (schema.optBoolean("uniqueItems")) {
                val seen = HashSet<String>()
                for (i in 0 until value.length()) if (!seen.add(value.get(i).toString())) return "$at has a repeated item"
            }
            val item = schema.optJSONObject("items")
            if (item != null) for (i in 0 until value.length()) check(item, value.get(i), "$path/$i")?.let { return it }
        }
        schema.optJSONArray("anyOf")?.let { variants ->
            if ((0 until variants.length()).none { check(variants.getJSONObject(it), value, path) == null }) return "$at matches none of the allowed shapes"
        }
        schema.optJSONArray("oneOf")?.let { variants ->
            val failures = ArrayList<String>()
            var matched = 0
            for (i in 0 until variants.length()) {
                val problem = check(variants.getJSONObject(i), value, path)
                if (problem == null) matched++ else failures.add(problem)
            }
            if (matched == 0) return "$at matches none of the allowed shapes (${failures.firstOrNull().orEmpty()})"
            if (matched > 1) return "$at matches more than one shape"
        }
        schema.optJSONObject("not")?.let { if (check(it, value, path) == null) return "$at is not allowed" }
        schema.optJSONObject("if")?.let { cond ->
            val then = schema.optJSONObject("then")
            if (then != null && check(cond, value, path) == null) check(then, value, path)?.let { return it }
        }
        return null
    }

    private fun objectError(schema: JSONObject, value: JSONObject, path: String): String? {
        val at = path.ifEmpty { "/" }
        val required = schema.optJSONArray("required")
        if (required != null) for (i in 0 until required.length()) {
            if (!value.has(required.getString(i))) return "$at must have ${required.getString(i)}"
        }
        if (schema.has("minProperties") && value.length() < schema.getInt("minProperties")) return "$at has too few properties"
        val properties = schema.optJSONObject("properties")
        for (key in value.keys()) {
            val sub = properties?.optJSONObject(key)
            if (sub == null) {
                if (schema.has("additionalProperties")) return "$at must not have the field $key"
            } else check(sub, value.get(key), "$path/$key")?.let { return it }
        }
        return null
    }

    private fun pattern(source: String): Regex = synchronized(patterns) { patterns.getOrPut(source) { Regex(source.removePrefix("^").removeSuffix("$")) } }

    private fun typeIs(type: String, v: Any?): Boolean = when (type) {
        "object" -> v is JSONObject
        "array" -> v is JSONArray
        "string" -> v is String
        "boolean" -> v is Boolean
        "null" -> v == null || v == JSONObject.NULL
        "integer" -> isInteger(v)
        "number" -> v is Number
        else -> throw IllegalArgumentException("unsupported type $type")
    }

    /** JSON has one number type: 2.0 is an integer, as it is in the TypeScript reference. */
    private fun isInteger(v: Any?): Boolean = when (v) {
        is Int, is Long, is Short, is Byte, is java.math.BigInteger -> true
        is Double -> !v.isNaN() && !v.isInfinite() && v == Math.floor(v)
        is Float -> !v.isNaN() && !v.isInfinite() && v == Math.floor(v.toDouble()).toFloat()
        is java.math.BigDecimal -> v.stripTrailingZeros().scale() <= 0
        else -> false
    }

    private fun same(a: Any?, b: Any?): Boolean = when {
        a is Number && b is Number -> a.toDouble() == b.toDouble()
        else -> a == b
    }
}
