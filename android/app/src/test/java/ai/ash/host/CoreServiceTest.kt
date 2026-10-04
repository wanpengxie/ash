package ai.ash.host

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CoreServiceTest {
    @Test fun activityTransitionsNeverInterruptFirstInstall() {
        assertFalse(CoreService.shouldInterruptSupervisor(CoreService.ACTION_APP_OPEN, "installing"))
        assertFalse(CoreService.shouldInterruptSupervisor(CoreService.ACTION_APP_LEFT, "preparing"))
        assertFalse(CoreService.shouldInterruptSupervisor(CoreService.ACTION_APP_OPEN, "starting"))
    }

    @Test fun lifecycleCommandsWakeOnlyOutsideAtomicInstallation() {
        assertTrue(CoreService.shouldInterruptSupervisor(CoreService.ACTION_RESTART, "running"))
        assertTrue(CoreService.shouldInterruptSupervisor(CoreService.ACTION_STOP, "starting"))
        assertFalse(CoreService.shouldInterruptSupervisor(CoreService.ACTION_STOP, "installing"))
        assertFalse(CoreService.shouldInterruptSupervisor(CoreService.ACTION_START, "preparing"))
    }
}
