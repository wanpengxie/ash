package ai.ash.host

import org.junit.Assert.assertEquals
import org.junit.Test

class PresentLifecycleTest {
    @Test fun hideOrDismissRetiresIdAgainstLateOrRepeatedPresent() {
        assertEquals(PresentAdmission.NEW, PresentLifecycle.admission(null, "payload", false))
        assertEquals(PresentAdmission.DUPLICATE, PresentLifecycle.admission("payload", "payload", false))
        assertEquals(PresentAdmission.CONFLICT, PresentLifecycle.admission("payload", "changed", false))
        assertEquals(PresentAdmission.RETIRED, PresentLifecycle.admission(null, "payload", true))
        assertEquals(PresentAdmission.RETIRED, PresentLifecycle.admission("payload", "payload", true))
    }

    @Test fun userDismissalAndOwnerActionStayHiddenAfterRestart() {
        assertEquals(true, PresentLifecycle.restore(false, false))
        assertEquals(false, PresentLifecycle.restore(true, false))
        assertEquals(false, PresentLifecycle.restore(false, true))
    }
}
