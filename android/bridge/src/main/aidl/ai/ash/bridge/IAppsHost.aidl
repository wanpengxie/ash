package ai.ash.bridge;

import android.content.IntentSender;
import android.graphics.Bitmap;

/**
 * Ash, as its apps shell (ai.ash.apps) reaches it: the owner's apps, through Ash's core. Only an app signed like Ash
 * may call it, and only the apps routes are forwarded (see Bridge.APPS_* and Ash's AppsRoutes).
 */
interface IAppsHost {
    /** Bridge.PROTOCOL of Ash. */
    int protocol();
    /**
     * One request to the core's apps API, e.g. ("GET", "/api/apps", "") or ("POST", "/api/apps/health/call", "{...}").
     * The pipe carries {status, type, body} (text) or {status, type, base64} (an image); status 403 for a path that is
     * not an apps route, 503 when the core is not running.
     */
    ParcelFileDescriptor request(String method, String path, String body);
    /**
     * 「添加到桌面」 on the shell's behalf, for systems where the shell itself cannot get the shortcut permission
     * (ColorOS lists none for it): Ash asks the launcher to pin a shortcut of its own that opens app <app> in the shell.
     * [result] is sent when the launcher accepts. Returns Bridge.PIN_ASKED, PIN_UNSUPPORTED or PIN_FAILED; an Ash
     * without this method answers 0.
     */
    int requestPin(String app, String label, in Bitmap icon, in IntentSender result);
    /** Whether Ash's shortcut for app <app> is on the home screen. */
    boolean pinned(String app);
}
