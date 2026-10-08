package ai.ash.widget

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import ai.ash.bridge.Bridge
import ai.ash.host.apps.AppsShell
import ai.ash.ui.HomeActivity

/** Where a card's open actions go: an app's page in 「Ash 应用」, Ash itself, or a link. */
object WidgetActions {
    fun openIntent(ctx: Context, target: CAction): Intent = when (target) {
        is CAction.OpenApp -> if (AppsShell.installedVersion(ctx) > 0)
            Intent(Intent.ACTION_VIEW, Uri.parse("ash-app://open?app=${Uri.encode(target.app)}" + (target.surface?.let { "&surface=${Uri.encode(it)}" } ?: "")))
                .setClassName(Bridge.APPS_PACKAGE, Bridge.APPS_OPEN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            else ash(ctx)
        is CAction.OpenUrl -> Intent(Intent.ACTION_VIEW, Uri.parse(target.url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        else -> ash(ctx)
    }

    fun ash(ctx: Context): Intent = Intent(ctx, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
}

/**
 * A tap, toggle, choice or tab on a card (ash://widget-action/<widget>/<card>?c=<element>&k=<kind>...): toggles and
 * tabs change on the phone at once; what the card's creator should hear goes to the core as the owner's tap.
 */
class WidgetActionReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val uri = intent.data ?: return
        if (uri.scheme != "ash" || uri.host != "widget-action") return
        val parts = uri.pathSegments
        val pending = goAsync()
        // Widgets drawn before the full card format: ash://widget-action/<card>/<action>/<widget>.
        if (uri.getQueryParameter("k") == null) {
            if (parts.size == 3) WidgetHost.tapLegacy(ctx, parts[0], parts[1]) { pending.finish() } else pending.finish()
            return
        }
        val widget = parts.getOrNull(0)?.toIntOrNull()
        val card = parts.getOrNull(1)
        val component = uri.getQueryParameter("c")
        if (widget == null || card == null || component == null) { pending.finish(); return }
        WidgetHost.act(ctx, card, component, uri, intent) { pending.finish() }
    }
}
