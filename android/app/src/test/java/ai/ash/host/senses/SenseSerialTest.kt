package ai.ash.host.senses

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class SenseSerialTest {
    @Test fun queuedRefreshCannotRegisterAfterStopCleanup() {
        val serial = SenseSerial()
        val started = CountDownLatch(1)
        val release = CountDownLatch(1)
        val cleaned = CountDownLatch(1)
        val order = mutableListOf<String>()
        assertTrue(serial.submit {
            started.countDown()
            release.await(1, TimeUnit.SECONDS)
            order += "in-flight"
        })
        assertTrue(started.await(1, TimeUnit.SECONDS))
        assertTrue(serial.submit { order += "late-register" })
        serial.close { order += "unregister"; cleaned.countDown() }
        assertFalse(serial.submit { order += "after-close" })
        release.countDown()
        assertTrue(cleaned.await(1, TimeUnit.SECONDS))
        assertEquals(listOf("in-flight", "unregister"), order)
    }

    @Test fun repeatedCloseIsIdempotent() {
        val serial = SenseSerial()
        val cleaned = CountDownLatch(1)
        var calls = 0
        serial.close { calls++; cleaned.countDown() }
        serial.close { calls++ }
        assertTrue(cleaned.await(1, TimeUnit.SECONDS))
        assertEquals(1, calls)
    }
}
