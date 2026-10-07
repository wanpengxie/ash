package ai.ash.apps

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController

/** Small shared pieces of the shell's screens. */
object Ui {
    fun dp(ctx: Context, v: Int) = (v * ctx.resources.displayMetrics.density).toInt()
    fun night(ctx: Context) = (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    fun text(ctx: Context) = if (night(ctx)) Color.rgb(0xF2, 0xF2, 0xF2) else Color.rgb(0x1C, 0x1C, 0x1E)
    fun muted(ctx: Context) = if (night(ctx)) Color.rgb(0xA0, 0xA0, 0xA6) else Color.rgb(0x6E, 0x6E, 0x73)
    fun bar(ctx: Context) = if (night(ctx)) Color.rgb(0x1C, 0x1C, 0x1E) else Color.rgb(0xF4, 0xF4, 0xF6)
    fun page(ctx: Context) = if (night(ctx)) Color.rgb(0x00, 0x00, 0x00) else Color.WHITE
    const val ACCENT = 0xFFFF7A3D.toInt()

    /** Drawn edge to edge (targetSdk 35): keep clear of the system bars, the cutout and the keyboard. */
    fun insets(root: View) {
        root.setOnApplyWindowInsetsListener { v, insets ->
            if (Build.VERSION.SDK_INT >= 30) {
                val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                v.setPadding(i.left, i.top, i.right, i.bottom)
            } else @Suppress("DEPRECATION") v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
    }

    /**
     * The system bars are see-through (edge to edge), so their clock and icons must contrast with the page under them:
     * dark on the light pages, light on the dark. Called again when the shell follows a dark-mode switch in place.
     */
    fun systemBars(a: Activity) {
        val light = !night(a)
        if (Build.VERSION.SDK_INT >= 30) {
            val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            a.window.insetsController?.setSystemBarsAppearance(if (light) mask else 0, mask)
        } else @Suppress("DEPRECATION") {
            val decor = a.window.decorView
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

    /** The intent that opens one app in its own task (the same intent each time, so its task is reused). */
    fun appIntent(ctx: Context, id: String): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse(AppIds.link(id))).setClass(ctx, AppActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT)
}
