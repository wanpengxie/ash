package ai.ash.host

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Test

class PresentSerialGateTest {
    @Test fun hideCannotBeOvertakenByAnInFlightRender() {
        val serial = PresentSerialGate()
        val rendering = CountDownLatch(1)
        val releaseRender = CountDownLatch(1)
        val hideDone = CountDownLatch(1)
        var visible = false
        var retired = false
        val show = Thread {
            serial.run {
                rendering.countDown()
                releaseRender.await()
                if (!retired) visible = true
            }
        }
        val hide = Thread {
            serial.run { retired = true; visible = false }
            hideDone.countDown()
        }
        try {
            show.start()
            assertEquals(true, rendering.await(1, TimeUnit.SECONDS))
            hide.start()
            assertEquals(false, hideDone.await(50, TimeUnit.MILLISECONDS))
        } finally { releaseRender.countDown(); show.join(1_000); hide.join(1_000) }
        assertEquals(true, hideDone.count == 0L)
        assertEquals(true, retired)
        assertEquals(false, visible)
    }

    @Test fun restoreRereadsStateAfterAHideInsteadOfUsingAnOldSnapshot() {
        val serial = PresentSerialGate()
        val snapshotIds = listOf("fixture")
        var stored = true
        var retired = false
        var visible = true
        serial.run { stored = false; retired = true; visible = false }
        for (id in snapshotIds) serial.run { if (id == "fixture" && stored && !retired) visible = true }
        assertEquals(false, visible)

        stored = true; retired = false
        val rendering = CountDownLatch(1)
        val releaseRender = CountDownLatch(1)
        val restore = Thread {
            for (id in snapshotIds) serial.run {
                if (id == "fixture" && stored && !retired) {
                    rendering.countDown()
                    releaseRender.await()
                    visible = true
                }
            }
        }
        val hide = Thread { serial.run { stored = false; retired = true; visible = false } }
        try {
            restore.start()
            assertEquals(true, rendering.await(1, TimeUnit.SECONDS))
            hide.start()
        } finally { releaseRender.countDown(); restore.join(1_000); hide.join(1_000) }
        assertEquals(false, visible)
    }
}
