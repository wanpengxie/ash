package ai.ash.host

import java.net.SocketException
import java.net.SocketTimeoutException
import org.junit.Assert.*
import org.junit.Test

class HostClientDisconnectTest {
    @Test fun brokenPipeAndReadDeadlineDoNotEscapeTheBridgeWorker() {
        hostClientRequest { throw SocketException("Broken pipe") }
        hostClientRequest { throw SocketTimeoutException("read timed out") }
        var ran = false; hostClientRequest { ran = true }; assertTrue(ran)
    }
    @Test fun unexpectedLogicFailuresAreNotSilentlySwallowed() {
        assertThrows(IllegalStateException::class.java) { hostClientRequest { throw IllegalStateException("unexpected") } }
    }
}
