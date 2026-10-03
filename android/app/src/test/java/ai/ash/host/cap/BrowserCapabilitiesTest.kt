package ai.ash.host.cap

import ai.ash.host.browser.BrowserArguments
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserCapabilitiesTest {
    private val byName = BrowserCapabilities.list.associateBy { it.name }

    @Test fun everyBrowserWordHasAPolicyAndASpace() {
        assertEquals(setOf("browser.open", "browser.read", "browser.click", "browser.type", "browser.scroll", "browser.back",
            "browser.screenshot", "browser.show", "browser.close", "browser.spaces", "browser.run"), byName.keys)
        for ((name, cap) in byName) {
            CapabilityPolicies.require(name)
            if (name != "browser.spaces") assertTrue("$name takes space", cap.schema.getJSONObject("properties").has("space"))
        }
    }

    @Test fun theRunSchemaListsExactlyTheFieldsTheStepsTake() {
        val run = byName.getValue("browser.run").schema
        assertEquals("steps", run.getJSONArray("required").getString(0))
        val steps = run.getJSONObject("properties").getJSONObject("steps")
        assertEquals(1, steps.getInt("minItems"))
        assertEquals(BrowserArguments.MAX_STEPS, steps.getInt("maxItems"))
        val item = steps.getJSONObject("items").getJSONObject("properties")
        assertEquals(BrowserArguments.STEP_FIELDS.values.flatten().toSet() + "op", item.keys().asSequence().toSet())
        val ops = item.getJSONObject("op").getJSONArray("enum")
        assertEquals(BrowserArguments.OPS, (0 until ops.length()).map { ops.getString(it) }.toSet())
        // The description is the contract: it names every op.
        val description = byName.getValue("browser.run").description
        for (op in BrowserArguments.OPS) assertTrue(op, description.contains("$op {"))
    }
}
