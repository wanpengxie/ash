package ai.ash.bridge;

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
}
