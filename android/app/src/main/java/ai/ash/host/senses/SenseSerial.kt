package ai.ash.host.senses

import java.util.concurrent.Executors

/** Serializes callbacks with shutdown so a late callback cannot re-register a listener. */
internal class SenseSerial {
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var closed = false

    @Synchronized fun submit(job: () -> Unit): Boolean {
        if (closed) return false
        executor.execute { if (!closed) job() }
        return true
    }

    @Synchronized fun close(cleanup: () -> Unit = {}) {
        if (closed) return
        closed = true
        executor.execute(cleanup)
        executor.shutdown()
    }
}
