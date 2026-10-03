package ai.ash.host.cap

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CapabilityPolicyTest {
    private fun effect(name: String) = CapabilityPolicies.require(name).effect

    @Test fun everyCapabilityHasAKnownEffect() {
        for ((name, policy) in CapabilityPolicies.byName) {
            assertTrue("$name: ${policy.effect}", policy.effect in CapabilityPolicy.EFFECTS)
        }
    }

    @Test fun lookingIsRead() {
        for (n in listOf(
            "device.status", "apps.list", "apps.info", "apps.usage", "settings.get", "screen.read", "screen.see",
            "screen.screenshot", "screen.touch_status", "shell.status", "vscreen.status", "vscreen.see", "calendar.search", "clipboard.get",
            "browser.read", "browser.open", "browser.scroll", "browser.back", "browser.screenshot", "browser.show", "browser.close",
        )) assertEquals(n, "read", effect(n))
    }

    @Test fun operatingThePhoneIsAct() {
        for (n in listOf(
            "apps.open", "intent.view", "settings.open", "input.key", "screen.tap", "screen.type", "screen.scroll", "screen.swipe",
            "screen.hold", "screen.touch", "screen.gesture", "screen.global_action", "vscreen.launch", "vscreen.tap",
            "vscreen.swipe", "vscreen.key", "vscreen.type", "vscreen.create", "vscreen.close", "clipboard.set", "browser.click", "browser.type",
        )) assertEquals(n, "act", effect(n))
    }

    @Test fun storedChangesAreWriteAndShellIsExecute() {
        assertEquals("write", effect("calendar.create"))
        assertEquals("write", effect("settings.put"))
        assertEquals("execute", effect("shell.run"))
    }

    @Test fun unknownEffectIsRejected() {
        assertThrows(IllegalArgumentException::class.java) { CapabilityPolicy("none", "look", "x") }
    }
}
