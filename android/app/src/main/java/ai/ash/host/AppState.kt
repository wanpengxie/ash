package ai.ash.host

/** Whether one of Ash's own screens is in front of the owner right now. */
object AppState {
    @Volatile var homeVisible = false
    @Volatile var browserVisible = false
    val inFront: Boolean get() = homeVisible || browserVisible
}
