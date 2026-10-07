package ai.ash.apps

import android.app.Application
import android.os.Build
import android.webkit.WebView

/** The app pages run in the ":app" process, whose WebView keeps its data in a directory of its own. */
class AppsApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 28 && getProcessName().endsWith(":app")) runCatching { WebView.setDataDirectorySuffix("app") }
    }
}
