package ai.ash.caps.perception

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Locale

class PerceptionArgumentsTest {
    private fun ocr(input: JSONObject): OcrReadArgs? = PerceptionArguments.ocr(input, { it }, { null })
    private fun speak(input: JSONObject): TtsSpeakArgs? = PerceptionArguments.speak(input, { it }, { null })
    private fun ocrProblem(input: JSONObject): String? = PerceptionArguments.ocr(input, { null }, { it })
    private fun speakProblem(input: JSONObject): String? = PerceptionArguments.speak(input, { null }, { it })

    @Test fun ocrTakesAPathOrDataWithDefaults() {
        val a = ocr(JSONObject().put("path", "/sdcard/Pictures/a.png"))!!
        assertEquals("/sdcard/Pictures/a.png", a.path)
        assertNull(a.data)
        assertEquals(960, a.maxSide)
        assertEquals(0.5f, a.minScore, 0f)
        val d = ocr(JSONObject().put("data", "aGVsbG8=").put("max_side", 1280).put("min_score", 0.8))!!
        assertEquals("aGVsbG8=", d.data)
        assertEquals(1280, d.maxSide)
        assertEquals(0.8f, d.minScore, 1e-6f)
    }

    @Test fun malformedOcrNeverReachesTheReader() {
        val bad = listOf(
            JSONObject(),
            JSONObject().put("path", "/a.png").put("data", "aGVsbG8="),
            JSONObject().put("path", "relative/a.png"),
            JSONObject().put("path", 5),
            JSONObject().put("data", "not base64!"),
            JSONObject().put("path", "/a.png").put("max_side", 100),
            JSONObject().put("path", "/a.png").put("max_side", 5000),
            JSONObject().put("path", "/a.png").put("max_side", 960.5),
            JSONObject().put("path", "/a.png").put("max_side", "960"),
            JSONObject().put("path", "/a.png").put("min_score", 1.5),
            JSONObject().put("path", "/a.png").put("min_score", "0.5"),
            JSONObject().put("path", "/a.png").put("lang", "zh"),
        )
        for (input in bad) assertNull(input.toString(), ocr(input))
        assertTrue(ocrProblem(JSONObject().put("path", "/a.png").put("lang", "zh"))!!.contains("no field lang"))
    }

    @Test fun speakDefaultsToPlayingAtNormalSpeed() {
        val a = speak(JSONObject().put("text", "  你好  "))!!
        assertEquals("你好", a.text)
        assertTrue(a.play)
        assertEquals(1f, a.rate, 0f)
        assertEquals(1f, a.pitch, 0f)
        assertNull(a.lang)
        val b = speak(JSONObject().put("text", "hi").put("lang", "en-US").put("voice", "x").put("rate", 1.5).put("pitch", 0.8).put("play", false))!!
        assertFalse(b.play)
        assertEquals("en-US", b.lang)
        assertEquals(1.5f, b.rate, 1e-6f)
    }

    @Test fun malformedSpeakNeverReachesTheEngine() {
        val bad = listOf(
            JSONObject(),
            JSONObject().put("text", "   "),
            JSONObject().put("text", 5),
            JSONObject().put("text", "a").put("lang", "not a tag"),
            JSONObject().put("text", "a").put("rate", 0.1),
            JSONObject().put("text", "a").put("rate", 9),
            JSONObject().put("text", "a").put("pitch", 3),
            JSONObject().put("text", "a").put("play", "yes"),
            JSONObject().put("text", "a").put("voice", "v".repeat(201)),
            JSONObject().put("text", "a").put("volume", 1),
        )
        for (input in bad) assertNull(input.toString(), speak(input))
        assertNotNull(speakProblem(JSONObject()))
    }

    @Test fun languageFollowsTheScriptOfTheText() {
        assertEquals(Locale.CHINA, PerceptionArguments.languageOf("今天下午三点开会"))
        assertEquals(Locale.CHINA, PerceptionArguments.languageOf("Meeting at 3 在会议室"))
        assertEquals(Locale.JAPAN, PerceptionArguments.languageOf("こんにちは世界"))
        assertEquals(Locale.US, PerceptionArguments.languageOf("Hello there"))
        assertEquals("zh-CN", PerceptionArguments.locale("zh_CN").toLanguageTag())
    }
}
