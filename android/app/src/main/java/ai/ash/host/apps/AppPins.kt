package ai.ash.host.apps

import ai.ash.R
import ai.ash.bridge.Bridge
import ai.ash.widget.CAction
import ai.ash.widget.WidgetActions
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.content.pm.ShortcutInfo
import android.content.pm.ShortcutManager
import android.graphics.Bitmap
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Bundle
import android.util.Log

/**
 * 「添加到桌面」 for an app of the shell, asked by Ash. On ColorOS the shell (which requests no runtime permission) gets
 * no permission page where the owner could allow 「创建桌面快捷方式」, so its own request goes nowhere; Ash has one.
 * The shortcut is Ash's own and opens [AppShortcutActivity], which hands the app to the shell.
 */
object AppPins {
    private const val TAG = "ash.apps"
    /** The core's app ids (contract ash-app/1). */
    private val APP_ID = Regex("[a-z][a-z0-9-]{0,47}")

    fun valid(app: String?): Boolean = app != null && APP_ID.matches(app)
    fun shortcutId(app: String) = "app:$app"
    fun link(app: String): Uri = Uri.parse("ash-app://open?app=${Uri.encode(app)}")

    /** The app id in Ash's shortcut link, or null. */
    fun fromLink(uri: Uri?): String? = uri?.takeIf { it.scheme == "ash-app" && it.host == "open" }?.getQueryParameter("app")?.takeIf { valid(it) }

    fun request(ctx: Context, app: String, label: String, icon: Bitmap?, result: IntentSender?): Int {
        if (!valid(app)) return Bridge.PIN_FAILED
        val sm = ctx.getSystemService(ShortcutManager::class.java) ?: return Bridge.PIN_UNSUPPORTED
        if (!runCatching { sm.isRequestPinShortcutSupported }.getOrDefault(false)) return Bridge.PIN_UNSUPPORTED
        val name = label.trim().ifBlank { app }
        val info = ShortcutInfo.Builder(ctx, shortcutId(app))
            .setShortLabel(name.take(24)).setLongLabel(name.take(60))
            .setIcon(icon?.let { Icon.createWithBitmap(it) } ?: Icon.createWithResource(ctx, R.drawable.ic_launcher))
            .setIntent(Intent(Intent.ACTION_VIEW, link(app)).setClass(ctx, AppShortcutActivity::class.java))
            .build()
        // The system only lets an app in front ask; the shell bound to Ash from its own screen, which normally counts.
        return runCatching { if (sm.requestPinShortcut(info, result)) Bridge.PIN_ASKED else Bridge.PIN_FAILED }
            .onFailure { Log.w(TAG, "pin request refused: ${it.javaClass.simpleName}: ${it.message}") }
            .getOrDefault(Bridge.PIN_FAILED)
    }

    fun pinned(ctx: Context, app: String): Boolean = valid(app) && runCatching {
        ctx.getSystemService(ShortcutManager::class.java)?.pinnedShortcuts?.any { it.id == shortcutId(app) && it.isPinned } == true
    }.getOrDefault(false)
}

/** Ash's home-screen shortcut for an app (ash-app://open?app=<id>): opens it in 「Ash 应用」, or Ash if the shell is gone. */
class AppShortcutActivity : Activity() {
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val app = AppPins.fromLink(intent?.data)
        runCatching { startActivity(if (app != null) WidgetActions.openIntent(this, CAction.OpenApp(app, null)) else WidgetActions.ash(this)) }
        finish()
    }
}
