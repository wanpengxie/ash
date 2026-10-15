package ai.ash.ui

import ai.ash.ui.HomeTab.APPS
import ai.ash.ui.HomeTab.CHAT
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class HomeRouteTest {
    @Test fun anIntentThatNamesTheAppsTabOpensIt() {
        assertEquals(APPS, HomeRoute.tabFor("apps", focusInput = false, fromLauncher = false, current = CHAT))
        assertEquals(CHAT, HomeRoute.tabFor("chat", focusInput = false, fromLauncher = false, current = APPS))
    }

    @Test fun theLauncherIconLeavesTheOwnerWhereTheyWere() {
        assertEquals(APPS, HomeRoute.tabFor(null, focusInput = false, fromLauncher = true, current = APPS))
        assertEquals(CHAT, HomeRoute.tabFor(null, focusInput = false, fromLauncher = true, current = CHAT))
    }

    @Test fun notificationsWidgetsAndTheLikeShowTheChat() {
        // No tab named, not the launcher: someone wants the owner to see the conversation, even from the apps tab.
        assertEquals(CHAT, HomeRoute.tabFor(null, focusInput = false, fromLauncher = false, current = APPS))
        assertEquals(CHAT, HomeRoute.tabFor("nonsense", focusInput = false, fromLauncher = false, current = APPS))
    }

    @Test fun talkingToAshAlwaysShowsTheChat() {
        assertEquals(CHAT, HomeRoute.tabFor("apps", focusInput = true, fromLauncher = false, current = APPS))
        assertEquals(CHAT, HomeRoute.tabFor(null, focusInput = true, fromLauncher = true, current = APPS))
    }

    @Test fun anUnknownTabNameIsNone() {
        assertNull(HomeTab.of("settings")); assertNull(HomeTab.of(null)); assertNull(HomeTab.of(""))
        assertEquals(APPS, HomeTab.of(APPS.key))
        assertEquals(listOf("chat", "apps"), HomeTab.values().map { it.key })
    }

    @Test fun theLauncherIntentIsMainPlusLauncher() {
        assertTrue(HomeRoute.isLauncher("android.intent.action.MAIN", setOf("android.intent.category.LAUNCHER")))
        assertFalse(HomeRoute.isLauncher("android.intent.action.MAIN", null))
        assertFalse(HomeRoute.isLauncher("android.intent.action.VIEW", setOf("android.intent.category.LAUNCHER")))
        assertFalse(HomeRoute.isLauncher(null, setOf("android.intent.category.LAUNCHER")))
    }

    @Test fun onlyTheChatInFrontCountsAsAshInFront() {
        assertTrue(HomeRoute.chatInFront(resumed = true, tab = CHAT))
        assertFalse(HomeRoute.chatInFront(resumed = true, tab = APPS))
        assertFalse(HomeRoute.chatInFront(resumed = false, tab = CHAT))
    }

    /** The one door on the phone's home screen is Ash itself; nothing else in the manifest may be a launcher. */
    @Test fun ashIsTheOnlyLauncherIcon() {
        val manifest = listOf("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml").map(::File).first { it.exists() }
        val doc = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder().parse(manifest)
        val android = "http://schemas.android.com/apk/res/android"
        val launchers = mutableListOf<String>()
        val activities = doc.getElementsByTagName("activity")
        for (i in 0 until activities.length) {
            val a = activities.item(i) as org.w3c.dom.Element
            val cats = a.getElementsByTagName("category")
            for (j in 0 until cats.length) {
                if ((cats.item(j) as org.w3c.dom.Element).getAttributeNS(android, "name") == "android.intent.category.LAUNCHER")
                    launchers += a.getAttributeNS(android, "name")
            }
        }
        assertEquals(listOf(".ui.HomeActivity"), launchers)
    }
}
