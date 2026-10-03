package ai.ash.host.browser

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class BrowserStepsTest {
    private fun rejected(what: String, block: () -> Unit): String {
        try { block() } catch (e: BrowserArguments.Rejected) { return e.message ?: "" }
        fail("accepted $what"); return ""
    }

    private fun steps(vararg items: JSONObject) = BrowserArguments.steps(JSONArray(items.toList()))
    private fun op(name: String) = JSONObject().put("op", name)

    @Test fun spacesAreNamedPlainlyAndDefaultToMain() {
        assertEquals("main", BrowserArguments.space(null))
        assertEquals("main", BrowserArguments.space(JSONObject.NULL))
        for (good in listOf("main", "trains", "task_1", "a-b", "x".repeat(24))) assertEquals(good, BrowserArguments.space(good))
        for (bad in listOf<Any?>("", "Main", "two words", "x".repeat(25), "../main", "*", "车票", 3, true))
            rejected("space $bad") { BrowserArguments.space(bad) }
        assertEquals("*", BrowserArguments.space("*", allowAll = true))
        rejected("space ** for all") { BrowserArguments.space("**", allowAll = true) }
    }

    @Test fun everyOpParsesToItsStep() {
        val parsed = steps(
            op("open").put("url", "example.com"),
            op("read"),
            op("click").put("ref", 3).put("site", "example.com").put("label", "登录"),
            op("type").put("ref", 4).put("site", "example.com").put("label", "搜索").put("text", "天气").put("submit", true),
            op("scroll").put("direction", "up"),
            op("scroll"),
            op("back"),
            op("wait").put("ms", 1500),
            op("wait").put("text", " 已登录 "),
            op("capture"),
        )
        assertEquals(listOf(
            BrowserStep.Open("example.com"), BrowserStep.Read, BrowserStep.Click(3, "example.com", "登录"),
            BrowserStep.Type(4, "example.com", "搜索", "天气", true), BrowserStep.Scroll(false), BrowserStep.Scroll(true), BrowserStep.Back,
            BrowserStep.WaitMs(1500), BrowserStep.WaitText("已登录"), BrowserStep.Capture,
        ), parsed)
    }

    @Test fun stepsAreOneToTwentyObjectsWithAKnownOp() {
        rejected("no steps") { BrowserArguments.steps(JSONArray()) }
        rejected("missing steps") { BrowserArguments.steps(null) }
        rejected("steps as text") { BrowserArguments.steps("read") }
        rejected("21 steps") { BrowserArguments.steps(JSONArray((1..21).map { op("read") })) }
        assertEquals(20, BrowserArguments.steps(JSONArray((1..20).map { op("read") })).size)
        rejected("a bare string step") { BrowserArguments.steps(JSONArray().put("read")) }
        rejected("a step without op") { steps(JSONObject().put("url", "example.com")) }
        val message = rejected("an unknown op") { steps(op("read"), op("eval").put("script", "alert(1)")) }
        assertTrue(message, message.startsWith("step 2 (eval)"))
    }

    @Test fun aStepTakesOnlyItsOwnFields() {
        rejected("read with a url") { steps(op("read").put("url", "example.com")) }
        rejected("click with a selector") { steps(op("click").put("ref", 1).put("site", "a.com").put("label", "x").put("selector", "#buy")) }
        rejected("a step naming another space") { steps(op("read").put("space", "other")) }
        // A single capability ignores what is not its business (its space, say).
        assertEquals(BrowserStep.Read, BrowserArguments.step("read", JSONObject().put("space", "main")))
    }

    @Test fun clickAndTypeNeedTheSameThingsAsTheSingleCapabilities() {
        rejected("click without site") { steps(op("click").put("ref", 1).put("label", "登录")) }
        rejected("click without label") { steps(op("click").put("ref", 1).put("site", "a.com")) }
        rejected("click with a text ref") { steps(op("click").put("ref", "1").put("site", "a.com").put("label", "登录")) }
        rejected("click with ref 0") { steps(op("click").put("ref", 0).put("site", "a.com").put("label", "登录")) }
        rejected("type without text") { steps(op("type").put("ref", 1).put("site", "a.com").put("label", "搜索")) }
        rejected("type with too much text") { steps(op("type").put("ref", 1).put("site", "a.com").put("label", "搜索").put("text", "x".repeat(BrowserArguments.MAX_TYPED + 1))) }
        rejected("type with submit as text") { steps(op("type").put("ref", 1).put("site", "a.com").put("label", "搜索").put("text", "x").put("submit", "yes")) }
        rejected("open without url") { steps(op("open")) }
        rejected("open with a blank url") { steps(op("open").put("url", "  ")) }
        rejected("scroll sideways") { steps(op("scroll").put("direction", "left")) }
    }

    @Test fun waitsAreShortAndTakeOneKind() {
        assertEquals(BrowserStep.WaitMs(0), steps(op("wait").put("ms", 0)).single())
        assertEquals(BrowserStep.WaitMs(5000), steps(op("wait").put("ms", 5000)).single())
        rejected("wait too long") { steps(op("wait").put("ms", 5001)) }
        rejected("wait negative") { steps(op("wait").put("ms", -1)) }
        rejected("wait a fraction") { steps(op("wait").put("ms", 1.5)) }
        rejected("wait for nothing") { steps(op("wait")) }
        rejected("wait both ways") { steps(op("wait").put("ms", 100).put("text", "done")) }
        rejected("wait for blank text") { steps(op("wait").put("text", "   ")) }
        rejected("wait for a novel") { steps(op("wait").put("text", "x".repeat(BrowserArguments.MAX_WAIT_TEXT + 1))) }
    }
}
