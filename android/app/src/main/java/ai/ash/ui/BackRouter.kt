package ai.ash.ui

import android.app.Activity
import android.os.Build
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher

/**
 * The back of one activity (MOBILE-ARCH §11.2), through the supported interface: on Android 13+ a callback on the window's
 * [OnBackInvokedDispatcher], registered only while the page has somewhere to go back to ([canGoBack]) — so at the root the
 * system does its own back (and its predictive animation), and the keyboard or a dialog of the window takes back before the
 * page does. A predictive back that is cancelled never reaches [goBack]. Older systems come through [onBackPressed].
 * Call [sync] whenever what [canGoBack] answers may have changed.
 */
class BackRouter(private val activity: Activity, private val canGoBack: () -> Boolean, private val goBack: () -> Unit) {
    private var registered = false
    private val callback: Any? = if (Build.VERSION.SDK_INT >= 33) OnBackInvokedCallback { if (canGoBack()) goBack(); sync() } else null

    fun sync() {
        if (Build.VERSION.SDK_INT < 33) return
        val want = canGoBack()
        if (want == registered) return
        val dispatcher = activity.onBackInvokedDispatcher
        if (want) dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, callback as OnBackInvokedCallback)
        else dispatcher.unregisterOnBackInvokedCallback(callback as OnBackInvokedCallback)
        registered = want
    }

    /** The older path: true when the page went back, false when the system's own back should happen. */
    fun onBackPressed(): Boolean {
        if (!canGoBack()) return false
        goBack(); sync()
        return true
    }
}
