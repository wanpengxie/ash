package ai.ash.sysapps

import ai.ash.R
import android.app.Application
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class, qualifiers = "w360dp-h800dp-mdpi")
class SystemAppChromeTest {
    class Screen : SystemAppActivity() {
        override val appIdentity = AppIdentity("Codex", R.drawable.ash_ic_cpu, AppAccent.BLUE)
        var picked: String? = null
        override fun build(saved: Bundle?) {
            setDestinations(listOf(AppDestination("now", "现在", R.drawable.ash_ic_cpu), AppDestination("sessions", "会话", R.drawable.ash_ic_msg)), "now") { picked = it }
            setStatus("最近确认 · 09:39")
            showPage("Codex")
        }
        fun detail() = showPage("工作结果", detail = true, showNavigation = false)
        fun root() = showPage("Codex")
        fun picked(id: String) = selectDestination(id)
    }
    class Legacy : SystemAppActivity() { override fun build(saved: Bundle?) { title.text = "Legacy" } }
    private fun all(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { all(view.getChildAt(it)) } else emptyList()
    @Test fun rootHasAnIdentityAndStableDestinationsWhileDetailHasBack() {
        val controller = Robolectric.buildActivity(Screen::class.java).create().visible()
        try {
            val a = controller.get(); val views = all(a.window.decorView)
            assertEquals(View.GONE, views.single { it.contentDescription == "返回" }.visibility)
            assertTrue(views.filterIsInstance<TextView>().any { it.text.toString() == "Codex" })
            views.single { it.contentDescription == "会话" }.performClick(); assertEquals("sessions", a.picked)
            a.picked("sessions"); a.detail()
            assertEquals(View.VISIBLE, all(a.window.decorView).single { it.contentDescription == "返回" }.visibility)
            a.root()
            assertTrue(all(a.window.decorView).single { it.contentDescription == "会话" }.isSelected)
        } finally { controller.destroy() }
    }
    @Test fun legacySubclassKeepsItsExistingBackAndBuildContract() {
        val c = Robolectric.buildActivity(Legacy::class.java).create().visible()
        try { assertEquals(View.VISIBLE, all(c.get().window.decorView).single { it.contentDescription == "返回" }.visibility) }
        finally { c.destroy() }
    }
}
