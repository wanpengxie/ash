package ai.ash.sysapps

import ai.ash.host.BackgroundLaunch
import ai.ash.host.Notifications
import android.app.Activity
import android.app.Application
import android.app.NotificationManager
import android.content.Intent
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The actual foreground start and background notification, including the argument Android receives. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class SystemAppsEntryTest {
    @Test fun aForegroundOpenStartsTheNamedNativeAppWithItsArgument() {
        val app = RuntimeEnvironment.getApplication()
        BackgroundLaunch.install(app)
        val screen = Robolectric.buildActivity(Activity::class.java).create().start().resume()
        try {
            val arg = "{\"device\":\"device:computer-a\",\"thread\":\"refunds\"}"
            SystemApps.open(app, "codex", arg)
            val launched = shadowOf(app).nextStartedActivity
            assertEquals("ai.ash.sysapps.codex.CodexActivity", launched.component!!.className)
            assertEquals(arg, launched.getStringExtra(SystemAppActivity.EXTRA_ARG))
            assertTrue(launched.flags and Intent.FLAG_ACTIVITY_SINGLE_TOP != 0)
            assertTrue(launched.flags and Intent.FLAG_ACTIVITY_CLEAR_TOP != 0)
        } finally { screen.pause().stop().destroy() }
    }

    @Test fun aBackgroundOpenWaitsForTheOwnersTapAndKeepsTheLatestArgument() {
        val app = RuntimeEnvironment.getApplication()
        Notifications.createChannels(app)
        assertFalse(BackgroundLaunch.visible)
        SystemApps.open(app, "codex", "{\"thread\":\"old\"}")
        SystemApps.open(app, "codex", "{\"thread\":\"refunds\"}")
        assertNull(shadowOf(app).nextStartedActivity)
        val notices = app.getSystemService(NotificationManager::class.java).activeNotifications
        assertEquals(1, notices.size)
        notices.single().notification.contentIntent.send()
        val opened = shadowOf(app).nextStartedActivity
        assertEquals("ai.ash.sysapps.codex.CodexActivity", opened.component!!.className)
        assertEquals("{\"thread\":\"refunds\"}", opened.getStringExtra(SystemAppActivity.EXTRA_ARG))
    }
}
