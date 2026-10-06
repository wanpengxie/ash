package ai.ash.host

/** Whether one of Ash's own screens is in front of the owner right now. */
object AppState {
    @Volatile var homeVisible = false
        set(value) { if (field != value) { field = value; visibilityEpoch.incrementAndGet(); TaskStatus.refresh() } }
    val visibilityEpoch = java.util.concurrent.atomic.AtomicLong(0)
    @Volatile var homePageLive = false
    @Volatile var browserVisible = false
    val inFront: Boolean get() = homeVisible || browserVisible
}
