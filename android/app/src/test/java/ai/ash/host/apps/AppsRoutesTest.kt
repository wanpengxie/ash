package ai.ash.host.apps

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppsRoutesTest {
    @Test fun theAppsRoutesPass() {
        assertTrue(AppsRoutes.allowed("GET", "/api/apps"))
        assertTrue(AppsRoutes.allowed("GET", "/api/apps/health/icon"))
        assertTrue(AppsRoutes.allowed("GET", "/api/apps/com.example.notes/surfaces/home"))
        assertTrue(AppsRoutes.allowed("POST", "/api/apps/health/call"))
        assertTrue(AppsRoutes.allowed("POST", "/api/apps/health/message"))
    }

    @Test fun everythingElseIsRefused() {
        for ((m, p) in listOf(
            "GET" to "/api/send", "POST" to "/api/send", "GET" to "/api/agents", "GET" to "/", "GET" to "/api/apps/",
            "POST" to "/api/apps", "GET" to "/api/apps/health/call", "POST" to "/api/apps/health/icon", "DELETE" to "/api/apps/health",
            "GET" to "/api/apps/../send", "GET" to "/api/apps/health/../../send", "GET" to "/api/apps/health/surfaces/../../x",
            "GET" to "/api/apps?x=1", "GET" to "/api/apps/health/icon?x", "GET" to "/api/apps/health/icon#x", "GET" to "/api/apps/%2e%2e/icon",
            "GET" to "/api/apps/Health/icon", "GET" to "//evil/api/apps", "GET" to "http://evil/api/apps", "get" to "/api/apps",
            "GET" to "/api/appsx", "GET" to "/api/apps/health/surfaces/home/more", "POST" to "/api/apps/health/call/x",
        )) assertFalse("$m $p", AppsRoutes.allowed(m, p))
    }

    @Test fun iconsGoAsBytes() {
        assertTrue(AppsRoutes.textual("application/json; charset=utf-8"))
        assertTrue(AppsRoutes.textual("text/plain"))
        assertFalse(AppsRoutes.textual("image/png"))
    }
}
