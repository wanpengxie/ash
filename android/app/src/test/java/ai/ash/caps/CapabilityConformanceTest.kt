package ai.ash.caps

import ai.ash.link.Repo
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The phone's declarations held to the standard namespaces of `packages/sdk` (its generated `schema/words.json`): every
 * capability is a standard action or an `x.` extension; for a standard one the hand's input accepts at least what the
 * standard input accepts and its result promises at least what the standard result promises, and effect, risk, the
 * foreground mark and the callers are the standard's (a hand may raise the risk, never lower it). The hand's events are
 * the standard events, with bodies the standard schemas accept.
 */
class CapabilityConformanceTest {
    private val words: List<JSONObject> = JSONObject(File(Repo.root, "packages/sdk/schema/words.json").readText()).getJSONArray("words").let { a ->
        (0 until a.length()).map { a.getJSONObject(it) }
    }
    /** Standard actions the hand side can implement (`device:*`; `workspace.*` and `body.info` are the bodies', `body:*`). */
    private val standard = words.filter { it.getString("kind") == "request" && it.getString("member") == "device:*" }.associateBy { it.getString("word") }
    private val standardEvents = words.filter { it.getString("kind") == "event" }.associateBy { it.getString("word") }
    private val extension = Regex("^x\\.[a-z0-9_-]+\\.[a-z0-9_.-]+$")

    private fun capabilities(): List<Capability> = Capabilities.all

    // ---- JSON Schema helpers (the subset the standard uses)

    private fun types(s: JSONObject): Set<String> = when {
        s.has("anyOf") -> s.getJSONArray("anyOf").let { a -> (0 until a.length()).flatMap { types(a.getJSONObject(it)) }.toSet() }
        s.opt("type") is JSONArray -> s.getJSONArray("type").let { a -> (0 until a.length()).map { a.getString(it) }.toSet() }
        s.has("type") -> setOf(s.getString("type"))
        else -> emptySet()
    }
    private fun strings(a: JSONArray?): Set<String> = if (a == null) emptySet() else (0 until a.length()).map { a.get(it).toString() }.toSet()
    private fun props(s: JSONObject): JSONObject = s.optJSONObject("properties") ?: JSONObject()
    private fun keys(o: JSONObject): List<String> = o.keys().asSequence().toList()

    /** What the hand's input [hand] fails to accept of what [std] accepts. */
    private fun inputGaps(hand: JSONObject, std: JSONObject, at: String): List<String> {
        val out = ArrayList<String>()
        val stdTypes = types(std)
        if (stdTypes.isNotEmpty() && !types(hand).containsAll(stdTypes)) out += "$at: type ${types(hand)} does not cover $stdTypes"
        if (std.has("enum") && hand.has("enum") && !strings(hand.getJSONArray("enum")).containsAll(strings(std.getJSONArray("enum"))))
            out += "$at: enum lacks ${strings(std.getJSONArray("enum")) - strings(hand.getJSONArray("enum"))}"
        val handProps = props(hand)
        for (p in keys(props(std))) {
            if (!handProps.has(p)) { out += "$at.$p: missing"; continue }
            out += inputGaps(handProps.getJSONObject(p), props(std).getJSONObject(p), "$at.$p")
        }
        // Whatever the hand insists on, the standard insists on too.
        val extra = strings(hand.optJSONArray("required")) - strings(std.optJSONArray("required"))
        if (extra.isNotEmpty()) out += "$at: requires $extra which the standard does not"
        val stdItems = std.optJSONObject("items")
        val handItems = hand.optJSONObject("items")
        if (stdItems != null && handItems != null) out += inputGaps(handItems, stdItems, "$at[]")
        return out
    }

    /** What the standard result [std] promises that the hand's result [hand] does not (top-level fields). */
    private fun resultGaps(hand: JSONObject?, std: JSONObject): List<String> {
        val stdProps = props(std)
        val stdRequired = strings(std.optJSONArray("required"))
        if (stdProps.length() == 0 && stdRequired.isEmpty()) return emptyList()
        if (hand == null) return listOf("no result schema, the standard promises ${keys(stdProps)}")
        val out = ArrayList<String>()
        val handProps = props(hand)
        for (p in keys(stdProps)) {
            if (!handProps.has(p)) { out += "$p: not promised"; continue }
            val h = types(handProps.getJSONObject(p))
            val s = types(stdProps.getJSONObject(p))
            if (s.isNotEmpty() && (h.isEmpty() || !s.containsAll(h))) out += "$p: type $h is not within $s"
        }
        val missing = stdRequired - strings(hand.optJSONArray("required"))
        if (missing.isNotEmpty()) out += "not always present: $missing"
        return out
    }

    private fun rank(risk: String) = listOf("none", "outward", "structure").indexOf(risk)

    // ---- capabilities

    @Test fun everyCapabilityIsStandardOrAnExtension() {
        assertTrue(capabilities().size > 50)
        for (c in capabilities()) assertTrue("${c.name} is neither a standard action nor x.<who>.<action>", c.name in standard || extension.matches(c.name))
    }

    @Test fun noCapabilityIsDeclaredTwiceOrKeepsAnOldName() {
        val names = capabilities().map { it.name }
        assertEquals(names.toSet().size, names.size)
        for (old in listOf("intent.view", "browser.show", "browser.run", "screen.capture", "ash.keepalive_switches")) assertTrue(old, old !in names)
    }

    @Test fun theInputOfEveryStandardCapabilityAcceptsWhatTheStandardAccepts() {
        for (c in capabilities().filter { it.name in standard }) {
            val gaps = inputGaps(c.schema, standard.getValue(c.name).getJSONObject("input_schema"), c.name)
            assertTrue(gaps.toString(), gaps.isEmpty())
        }
    }

    @Test fun theResultOfEveryStandardCapabilityPromisesWhatTheStandardPromises() {
        for (c in capabilities().filter { it.name in standard }) {
            val gaps = resultGaps(c.result, standard.getValue(c.name).getJSONObject("result_schema"))
            assertTrue("${c.name}: $gaps", gaps.isEmpty())
        }
    }

    @Test fun effectRiskForegroundAndCallersAreTheStandards() {
        for (c in capabilities().filter { it.name in standard }) {
            val s = standard.getValue(c.name)
            assertEquals("${c.name} effect", s.getString("effect"), c.effect)
            assertTrue("${c.name}: risk ${c.risk} is lower than the standard's ${s.getString("risk")}", rank(c.risk) >= rank(s.getString("risk")))
            assertEquals("${c.name} risk", s.getString("risk"), c.risk)
            assertEquals("${c.name} foreground", s.optBoolean("foreground", false), c.foreground)
            assertEquals("${c.name} callers", strings(s.getJSONArray("callers")).filter { it == "kernel" }.toSet(), (c.callers ?: emptyList()).toSet())
            assertEquals("${c.name} label", s.getJSONObject("label").getString("doing"), c.label)
        }
    }

    @Test fun copiedPairingCommandsStayOutOfTheLedgerThroughBothClipboardDeclarations() {
        val handText = capabilities().single { it.name == "clipboard.set" }.schema.getJSONObject("properties").getJSONObject("text")
        val standardText = standard.getValue("clipboard.set").getJSONObject("input_schema").getJSONObject("properties").getJSONObject("text")
        assertTrue(handText.optBoolean("x-ash-secret"))
        assertTrue(standardText.optBoolean("x-ash-secret"))
    }

    @Test fun anExtensionNamesItsOwnRisk() {
        val extensions = capabilities().filter { it.name !in standard }
        assertEquals(setOf("x.android.browser.show", "x.android.browser.run"), extensions.map { it.name }.toSet())
        for (c in extensions) { assertTrue(c.label.isNotBlank()); assertTrue(c.risk in Risk.ALL); assertTrue(c.effect in Effect.ALL) }
    }

    @Test fun everyStandardCapabilityTheHandSideCouldHaveIsThereExceptTheBrowserScriptOnes() {
        val missing = standard.keys - capabilities().map { it.name }.toSet()
        // browser.evaluate is the computer's (the phone's browser runs scripts through x.android.browser.run).
        assertEquals(setOf("browser.evaluate"), missing)
    }

    @Test fun everySpecIsOneTheKernelAccepts() {
        val codec = Repo.codec
        for (c in capabilities()) {
            val spec = Manifest.spec(c)
            assertNull("${c.name}: ${codec.capabilityError(spec)}", codec.capabilityError(spec))
        }
    }

    // ---- error codes

    @Test fun theErrorCodesAreTheStandardsFourteen() {
        val std = JSONObject(File(Repo.root, "packages/sdk/schema/words.json").readText()).getJSONArray("error_codes")
        assertEquals(strings(std), ERROR_CODES)
        assertEquals(14, ERROR_CODES.size)
    }

    @Test fun everyErrorCodeTheAppRaisesIsAUnifiedOne() {
        val sources = File(System.getProperty("user.dir"), "src/main/java/ai/ash/caps").walk().filter { it.extension == "kt" }.toList()
        assertTrue(sources.size > 50)
        // The first argument of the calls that make a failed result or a sense error.
        val raise = Regex("""(?:CapResult\.error|SenseError|\bfail)\(\s*"([a-z_]+)"\s*,""")
        val found = HashMap<String, MutableList<String>>()
        for (f in sources) for (m in raise.findAll(f.readText())) found.getOrPut(m.groupValues[1]) { mutableListOf() }.add(f.name)
        assertTrue(found.keys.containsAll(listOf("forbidden", "unavailable", "bad_request")))
        for ((code, where) in found) assertTrue("$code is not an error code (in $where)", code in ERROR_CODES)
    }

    // ---- events

    @Test fun everyDeclaredEventIsAStandardOneAndItsBodyAcceptsNothingTheStandardRefuses() {
        assertEquals(Events.all.map { it.word }, Manifest.events.map { it.getString("word") })
        for (e in Events.all) {
            val std = standardEvents[e.word]
            assertTrue("${e.word} is not a standard event", std != null)
            val stdSchema = std!!.getJSONObject("input_schema")
            // The standard's fields are the hand's, and every one the standard insists on the hand insists on.
            assertEquals(e.word, keys(props(stdSchema)).toSet(), keys(props(e.schema)).toSet())
            assertEquals(e.word, strings(stdSchema.optJSONArray("required")), strings(e.schema.optJSONArray("required")))
            assertEquals(e.word, stdSchema.optBoolean("additionalProperties", true), e.schema.optBoolean("additionalProperties", true))
        }
    }

    @Test fun theHandSendsTheStandardSenseWidgetAndConfigEvents() {
        val expected = setOf("sense.location", "sense.activity", "sense.health", "sense.geofence", "sense.source", "sense.calendar", "sense.battery",
            "sense.screen", "sense.notification", "widget.placed", "widget.bind", "config.changed", "checkup.changed")
        assertEquals(expected, Events.all.map { it.word }.toSet())
    }

    @Test fun onlyTheNotificationEventIsNotQueued() {
        assertEquals(listOf("sense.notification"), Events.all.filter { !it.durable }.map { it.word })
    }
}
