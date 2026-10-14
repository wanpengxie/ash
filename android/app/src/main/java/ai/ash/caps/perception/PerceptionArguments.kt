package ai.ash.caps.perception

import org.json.JSONObject
import java.util.Locale

data class OcrReadArgs(val path: String?, val data: String?, val maxSide: Int, val minScore: Float)
data class TtsSpeakArgs(val text: String, val lang: String?, val voice: String?, val rate: Float, val pitch: Float, val play: Boolean)

/** The input of ocr.read and tts.speak, parsed before anything is loaded (JSONObject opt* coercion is not validation). */
object PerceptionArguments {
    const val MAX_IMAGE_BYTES = 10 * 1024 * 1024
    const val MAX_TEXT = 4000

    private fun keysOnly(input: JSONObject, allowed: Set<String>): String? = input.keys().asSequence().firstOrNull { it !in allowed }

    private fun text(input: JSONObject, key: String): Result<String?> {
        if (!input.has(key) || input.isNull(key)) return Result.success(null)
        val v = input.opt(key) as? String ?: return Result.failure(IllegalArgumentException("$key must be text"))
        return Result.success(v.trim().ifEmpty { null })
    }

    private fun number(input: JSONObject, key: String, default: Double, range: ClosedFloatingPointRange<Double>): Double? {
        if (!input.has(key)) return default
        val v = (input.opt(key) as? Number)?.toDouble() ?: return null
        return v.takeIf { it.isFinite() && it in range }
    }

    fun <T> ocr(input: JSONObject, ok: (OcrReadArgs) -> T, invalid: (String) -> T): T {
        keysOnly(input, setOf("path", "data", "max_side", "min_score"))?.let { return invalid("ocr.read has no field $it") }
        val path = text(input, "path").getOrElse { return invalid("ocr.read ${it.message}") }
        val data = text(input, "data").getOrElse { return invalid("ocr.read ${it.message}") }
        if ((path == null) == (data == null)) return invalid("ocr.read needs exactly one of path (an image file in shared storage) or data (base64)")
        if (path != null && !path.startsWith("/")) return invalid("ocr.read path must be absolute")
        if (data != null && !Regex("^[A-Za-z0-9+/\\s]+={0,2}\\s*$").matches(data)) return invalid("ocr.read data must be base64")
        val side = if (input.has("max_side")) (input.opt("max_side") as? Number)?.takeIf { it.toDouble() % 1.0 == 0.0 }?.toInt() else OcrPipeline.DEFAULT_MAX_SIDE
        if (side == null || side !in 320..2048) return invalid("ocr.read max_side must be an integer from 320 to 2048")
        val score = number(input, "min_score", OcrPipeline.DEFAULT_MIN_SCORE.toDouble(), 0.0..1.0) ?: return invalid("ocr.read min_score must be a number from 0 to 1")
        return ok(OcrReadArgs(path, data, side, score.toFloat()))
    }

    fun <T> speak(input: JSONObject, ok: (TtsSpeakArgs) -> T, invalid: (String) -> T): T {
        keysOnly(input, setOf("text", "lang", "voice", "rate", "pitch", "play"))?.let { return invalid("tts.speak has no field $it") }
        val text = text(input, "text").getOrElse { return invalid("tts.speak ${it.message}") } ?: return invalid("tts.speak needs the text to say")
        val lang = text(input, "lang").getOrElse { return invalid("tts.speak ${it.message}") }
        if (lang != null && !Regex("^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8}){0,2}$").matches(lang)) return invalid("tts.speak lang must be a language tag such as zh-CN or en-US")
        val voice = text(input, "voice").getOrElse { return invalid("tts.speak ${it.message}") }
        if ((voice?.length ?: 0) > 200) return invalid("tts.speak voice is at most 200 characters")
        val rate = number(input, "rate", 1.0, 0.25..4.0) ?: return invalid("tts.speak rate must be a number from 0.25 to 4")
        val pitch = number(input, "pitch", 1.0, 0.5..2.0) ?: return invalid("tts.speak pitch must be a number from 0.5 to 2")
        val play = if (input.has("play")) input.opt("play") as? Boolean ?: return invalid("tts.speak play must be true or false") else true
        return ok(TtsSpeakArgs(text, lang, voice, rate.toFloat(), pitch.toFloat(), play))
    }

    /** The language to speak [text] in when none was asked for: Japanese when it holds kana, Chinese when it holds Han characters, else English. */
    fun languageOf(text: String): Locale {
        val scripts = text.codePoints().mapToObj { Character.UnicodeScript.of(it) }.toList().toSet()
        return when {
            Character.UnicodeScript.HIRAGANA in scripts || Character.UnicodeScript.KATAKANA in scripts -> Locale.JAPAN
            Character.UnicodeScript.HAN in scripts -> Locale.CHINA
            else -> Locale.US
        }
    }

    fun locale(tag: String): Locale = Locale.forLanguageTag(tag.replace('_', '-'))
}
