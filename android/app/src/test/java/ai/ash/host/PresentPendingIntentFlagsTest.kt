package ai.ash.host

import org.junit.Assert.assertEquals
import org.junit.Test

class PresentPendingIntentFlagsTest {
    private val update = 1
    private val immutable = 2
    private val mutable = 4

    @Test fun remoteInputIsMutableOnEverySupportedApi() {
        for (api in listOf(24, 26, 30)) assertEquals(update,
            PresentPendingIntentFlags.action(api, true, update, immutable, mutable))
        for (api in listOf(31, 35, 36)) assertEquals(update or mutable,
            PresentPendingIntentFlags.action(api, true, update, immutable, mutable))
    }

    @Test fun approvalAndDismissButtonsRemainImmutable() {
        for (api in listOf(24, 30, 31, 36)) assertEquals(update or immutable,
            PresentPendingIntentFlags.action(api, false, update, immutable, mutable))
    }
}
