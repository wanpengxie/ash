package ai.ash.sysapps

import ai.ash.R
import ai.ash.apps.Ui
import ai.ash.host.BackgroundLaunch
import ai.ash.link.PresentOutcome
import android.app.Activity
import android.content.Context
import android.content.Intent

/**
 * The system apps' screens on this phone, by the id the hub lists them under (`SYSTEM_APPS` of the sdk): one line per app.
 * Opening an app id that is not here opens the installed app of that id (its WebView page).
 */
object SystemApps {
    private val screens: Map<String, Class<out Activity>> = mapOf()

    /** The line icon the hub names for a system app (`icon`), when the shell has it. */
    fun icon(name: String): Int? = when (name) {
        "laptop" -> R.drawable.ash_ic_laptop
        "grid" -> R.drawable.ash_ic_grid
        else -> null
    }

    fun isSystem(id: String) = id in screens

    /** The intent that opens app [id] (asked to show [arg]): its native screen, or the installed app's page. */
    fun intent(ctx: Context, id: String, arg: String? = null): Intent =
        screens[id]?.let { Intent(ctx, it).apply { if (!arg.isNullOrEmpty()) putExtra(SystemAppActivity.EXTRA_ARG, arg) } }
            ?: Ui.appIntent(ctx, id, arg?.ifEmpty { null })

    /** `person:owner/open {app, arg}`: opens it now when the system lets Ash start a screen, else offers it in a notice. */
    fun open(ctx: Context, id: String, arg: String?): PresentOutcome {
        val route = BackgroundLaunch.start(ctx, intent(ctx, id, arg), "Ash 想给你打开一个应用", "点这里打开")
        return PresentOutcome(route == BackgroundLaunch.Route.DIRECT)
    }
}
