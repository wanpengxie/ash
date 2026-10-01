package ai.ash.host

/** Serializes state transitions with notification rendering/cancellation for one process. */
class PresentSerialGate {
    @PublishedApi internal val monitor = Any()
    inline fun <T> run(block: () -> T): T = synchronized(monitor, block)
}
