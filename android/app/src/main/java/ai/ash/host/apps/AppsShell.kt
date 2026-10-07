package ai.ash.host.apps

import ai.ash.BuildConfig
import ai.ash.bridge.Bridge
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager

/** The apps shell 「Ash 应用」 (ai.ash.apps), which Ash carries and installs like its other helpers. */
object AppsShell {
    fun installedVersion(ctx: Context): Long = runCatching {
        val info = ctx.packageManager.getPackageInfo(Bridge.APPS_PACKAGE, 0)
        if (android.os.Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
    }.getOrDefault(0L)

    fun trusted(ctx: Context): Boolean = installedVersion(ctx) > 0 &&
        ctx.packageManager.checkSignatures(ctx.packageName, Bridge.APPS_PACKAGE) == PackageManager.SIGNATURE_MATCH

    /** Not installed, older than the one Ash carries, or signed by someone else. */
    fun needsInstall(ctx: Context): Boolean = installedVersion(ctx) < BuildConfig.APPS_VERSION_CODE || !trusted(ctx)

    fun open(a: Activity) {
        a.startActivity(Intent().setClassName(Bridge.APPS_PACKAGE, Bridge.APPS_LAUNCHER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
