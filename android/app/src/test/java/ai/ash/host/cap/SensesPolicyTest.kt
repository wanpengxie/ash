package ai.ash.host.cap

import ai.ash.bridge.Bridge
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Test

/** The senses helper's tools are only offered with a policy of Ash's: every one has one, and only reads skip approval. */
class SensesPolicyTest {
    private val writes = setOf("location.track", "sense.configure", "sense.delete", "health.sync")

    @Test fun everySensesToolHasAPolicy() {
        for (name in Bridge.SENSES_TOOLS) assertNotNull(name, CapabilityPolicies.byName[name])
    }

    @Test fun readsNeedNoApproval() {
        for (name in Bridge.SENSES_TOOLS - writes) {
            val p = CapabilityPolicies.require(name)
            assertEquals(name, "none", p.risk)
            assertEquals(name, "read", p.effect)
        }
    }

    @Test fun changingRecordingDeletingAndSyncingNeedApproval() {
        for (name in writes) assertNotEquals(name, "none", CapabilityPolicies.require(name).risk)
        assertEquals("write", CapabilityPolicies.require("sense.configure").effect)
        assertEquals("write", CapabilityPolicies.require("sense.delete").effect)
        assertEquals("write", CapabilityPolicies.require("location.track").effect)
        assertEquals("act", CapabilityPolicies.require("health.sync").effect)
    }
}
