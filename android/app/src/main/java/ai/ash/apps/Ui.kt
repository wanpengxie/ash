package ai.ash.apps

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.view.View
import android.widget.FrameLayout
import ai.ash.ui.design.AshUi
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import android.view.WindowInsetsController

/** Small shared pieces of the shell's screens. */
object Ui {
    fun dp(ctx: Context, v: Int) = (v * ctx.resources.displayMetrics.density).toInt()
    fun night(ctx: Context) = (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    // The colours are the design's tokens ([ai.ash.ui.design.AshTokens]); these four are only the names the shell's screens use.
    fun text(ctx: Context) = AshUi.p(ctx).text
    fun muted(ctx: Context) = AshUi.p(ctx).text2
    fun bar(ctx: Context) = AshUi.p(ctx).bg
    fun page(ctx: Context) = AshUi.p(ctx).bg

    /** The space, in pixels, to keep clear on each side of a screen. */
    data class Edges(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        companion object { val NONE = Edges(0, 0, 0, 0) }
    }

    /**
     * What a screen drawn edge to edge must leave free: the system bars and the cutout on every side, and at the bottom also
     * the keyboard, whichever of the three reaches further (the keyboard covers the navigation bar, it does not stack on it).
     * It is what `systemBars() | displayCutout() | ime()` gives as one inset, written out so it can be checked without a device.
     */
    fun fit(bars: Edges, cutout: Edges, ime: Edges) = Edges(
        left = maxOf(bars.left, cutout.left, ime.left),
        top = maxOf(bars.top, cutout.top, ime.top),
        right = maxOf(bars.right, cutout.right, ime.right),
        bottom = maxOf(bars.bottom, cutout.bottom, ime.bottom),
    )

    private fun edges(i: androidx.core.graphics.Insets) = Edges(i.left, i.top, i.right, i.bottom)

    /** How far the keyboard reaches above the bottom the window already keeps clear ([safeBottom]): what a deck is moved by. */
    fun keyboardOver(safeBottom: Int, imeBottom: Int) = (imeBottom - safeBottom).coerceAtLeast(0)

    /**
     * Drawn edge to edge (targetSdk 35, where `adjustResize` no longer makes room by itself): [root] keeps clear of the
     * system bars, the cutout and the keyboard by padding itself, so what it holds shrinks with the keyboard and a field
     * at the bottom sits on top of it. Every screen of the app does this the same way, through the window's one insets owner
     * ([ai.ash.ui.WindowInsetsOwner]). [onKeyboard] hears whether the keyboard is up each time the insets change.
     */
    fun insets(root: View, onKeyboard: ((Boolean) -> Unit)? = null) = ai.ash.ui.WindowInsetsOwner.install(root, onKeyboard = onKeyboard)

    /**
     * The system bars are see-through (edge to edge), so their clock and icons must contrast with the page under them:
     * dark on the light pages, light on the dark. Called again when the shell follows a dark-mode switch in place.
     */
    fun systemBars(a: Activity) {
        val light = !night(a)
        // decorView creates the window's decor if the page is not built yet (Window.insetsController would then be null
        // and throw): the app page sets its colours before its content view exists.
        val decor = a.window.decorView
        if (Build.VERSION.SDK_INT >= 30) {
            val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            decor.windowInsetsController?.setSystemBarsAppearance(if (light) mask else 0, mask)
        } else @Suppress("DEPRECATION") {
            val mask = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            decor.systemUiVisibility = if (light) decor.systemUiVisibility or mask else decor.systemUiVisibility and mask.inv()
        }
    }

    fun square(b: Bitmap, size: Int = 192): Bitmap = if (b.width == size && b.height == size) b else Bitmap.createScaledBitmap(b, size, size, true)

    /** Recents shows the app's own name and icon on its card. */
    @Suppress("DEPRECATION")
    fun taskCard(a: Activity, name: String, icon: Bitmap?) {
        runCatching { a.setTaskDescription(ActivityManager.TaskDescription(name, icon?.let { square(it) }, bar(a))) }
    }

    /** Which page to show, when the app was opened for one (a home-screen card's action). */
    const val EXTRA_SURFACE = "ai.ash.apps.surface"

    /**
     * The intent that opens one app in its own task (the same data each time, so its task is reused); [surface] asks for
     * one of its pages and travels as an extra, not in the data, so it does not make a second task.
     */
    fun appIntent(ctx: Context, id: String, surface: String? = null): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse(AppIds.link(id))).setClass(ctx, AppActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
            .apply { if (surface != null) putExtra(EXTRA_SURFACE, surface) }
}
