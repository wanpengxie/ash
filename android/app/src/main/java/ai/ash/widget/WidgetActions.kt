package ai.ash.widget

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import ai.ash.apps.OpenActivity
import ai.ash.ui.HomeActivity

/** Where a card's open actions go: an app's page (its own task), Ash itself, or a link. */
object WidgetActions {
    fun openIntent(ctx: Context, target: CAction): Intent = when (target) {
        is CAction.OpenApp ->
            Intent(Intent.ACTION_VIEW, Uri.parse("ash-app://open?app=${Uri.encode(target.app)}" + (target.surface?.let { "&surface=${Uri.encode(it)}" } ?: "")))
                .setClass(ctx, OpenActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        is CAction.OpenUrl -> link(ctx, target.url)
        else -> ash(ctx)
    }

    /**
     * A card's link opens only what the owner can see and back out of (MOBILE-ARCH §6.3): a web page in the browser, a
     * number in the dialer (not called), a mail draft. Anything else (another app's scheme, a file, an intent:) opens Ash.
     */
    fun link(ctx: Context, url: String): Intent {
        val uri = runCatching { Uri.parse(url) }.getOrNull()
        return when (uri?.scheme?.lowercase()) {
            "https", "http" -> Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            "tel" -> Intent(Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            "mailto" -> Intent(Intent.ACTION_SENDTO, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            else -> ash(ctx)
        }
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
