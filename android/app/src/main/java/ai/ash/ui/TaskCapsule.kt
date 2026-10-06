package ai.ash.ui

import android.content.Context
import android.graphics.Rect
import android.os.Looper
import ai.ash.host.TaskFrame
import ai.ash.ui.island.NativeIsland

/** The task island over other apps: the task frame, projected for the native island (ui/island). */
object TaskCapsule {
    fun ownsWindow(bounds: Rect): Boolean = NativeIsland.ownsWindow(bounds)
    fun isEditing(): Boolean = NativeIsland.isEditing()
    /** The island is on screen for the owner now: what it shows needs no notification. */
    fun showing(): Boolean = NativeIsland.showing()

    fun prewarm(ctx: Context) = NativeIsland.prewarm(ctx)

    internal fun update(ctx: Context, frame: TaskFrame, elapsed: Long, stale: Boolean, interactive: Boolean, canStop: Boolean, notice: String?) {
        check(Looper.myLooper() == Looper.getMainLooper())
        val projected = IslandPresentation.project(frame, elapsed, stale, interactive, canStop, notice, NativeIsland.submitted, System.currentTimeMillis())
        NativeIsland.update(ctx, projected) { update(ctx, frame, elapsed, stale, interactive, canStop, notice) }
    }
    fun hide() = NativeIsland.hide()
    fun release() = NativeIsland.release()

    /** Model gestures never type into the owner's composer. */
    fun <T> withTouchPassthrough(action: () -> T): T = NativeIsland.withTouchPassthrough(action)
    /** Screen captures never include the island. */
    fun <T> withoutOverlay(action: () -> T): T = NativeIsland.withoutOverlay(action)
}
