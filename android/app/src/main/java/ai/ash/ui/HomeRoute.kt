package ai.ash.ui

import android.content.Context
import android.content.Intent

/** The pages of Ash's home screen: there is no tab bar, the chat is the screen and the apps grid opens over it. */
enum class HomeTab(val key: String) {
    /** The chat, drawn natively. */
    CHAT("chat"),
    /** The owner's apps (each one opens in its own task, in the isolated process). */
    APPS("apps");

    companion object {
        fun of(key: String?): HomeTab? = values().firstOrNull { it.key == key }
    }
}

/**
 * Which tab the home screen shows when it is opened or brought forward again. Plain logic, so it can be checked without a device;
 * [HomeActivity] only asks.
 */
object HomeRoute {
    /** Extra on the intent that opens Ash: the tab to show ([HomeTab.key]). */
    const val EXTRA_TAB = "ai.ash.extra.TAB"

    /**
     * The tab to show for an intent: the one it names; otherwise the chat for the widget's 「跟 Ash 说」, notifications and the
     * like (they want the owner to see the conversation); and only the launcher icon, tapped again, leaves the owner on the
     * tab they were on. An unknown name is the same as none.
     */
    fun tabFor(requested: String?, focusInput: Boolean, fromLauncher: Boolean, current: HomeTab): HomeTab {
        val named = HomeTab.of(requested)
        return when {
            focusInput -> HomeTab.CHAT
            named != null -> named
            fromLauncher -> current
            else -> HomeTab.CHAT
        }
    }

    /** Whether this is the launcher icon's own intent (MAIN + LAUNCHER). */
    fun isLauncher(action: String?, categories: Set<String>?): Boolean =
        action == Intent.ACTION_MAIN && categories?.contains(Intent.CATEGORY_LAUNCHER) == true

    /** Whether the chat is what the owner is looking at: it is what the presence, the island and notifications go by. */
    fun chatInFront(resumed: Boolean, tab: HomeTab): Boolean = resumed && tab == HomeTab.CHAT

    /** Opens Ash with the [HomeTab.APPS] page in front (from anywhere, the apps' own process included). */
    fun appsIntent(ctx: Context): Intent =
        Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(EXTRA_TAB, HomeTab.APPS.key)
}
