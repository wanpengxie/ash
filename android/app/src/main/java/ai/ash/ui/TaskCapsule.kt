package ai.ash.ui

import android.content.Context
import android.os.Looper
import ai.ash.host.AppState
import ai.ash.host.TaskFrame
import ai.ash.host.screen.ScreenBridge

/** The task island over other apps. The screen helper draws it; Ash tells it what to show (see [ScreenBridge]). */
object TaskCapsule {
    /** The island is on screen for the owner now: what it shows needs no notification. */
    fun showing(): Boolean = ScreenBridge.islandShown()
    /** The island can be shown at all; otherwise a running task is a notification. */
    fun ready(): Boolean = ScreenBridge.islandReady()

    internal fun update(ctx: Context, frame: TaskFrame, elapsed: Long, stale: Boolean, interactive: Boolean, canStop: Boolean, notice: String?) {
        check(Looper.myLooper() == Looper.getMainLooper())
        // The helper lays its own pending answers over the cards.
        ScreenBridge.island(IslandPresentation.project(frame, elapsed, stale, interactive, canStop, notice, emptyMap(), System.currentTimeMillis()), AppState.homeVisible)
    }
    fun hide() = ScreenBridge.island(null, AppState.homeVisible)
}
