package ai.ash.sysapps

import ai.ash.R
import android.app.Application
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.EditText
import android.widget.FrameLayout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class, qualifiers = "w360dp-h800dp-mdpi")
class SystemAppChromeTest {
    class Screen : SystemAppActivity() {
        override val appIdentity = AppIdentity("Codex", R.drawable.ash_ic_cpu, AppAccent.BLUE)
        var picked: String? = null
        lateinit var editor: EditText
        override fun build(saved: Bundle?) {
            editor = EditText(this).apply { setText("正在写的草稿") }
            content.addView(editor, FrameLayout.LayoutParams(-1, -2))
            setDestinations(listOf(AppDestination("now", "现在", R.drawable.ash_ic_cpu), AppDestination("sessions", "会话", R.drawable.ash_ic_msg)), "now") { picked = it }
            setStatus("最近确认 · 09:39")
            showPage("Codex")
        }
        fun detail() = showPage("工作结果", detail = true, showNavigation = false)
        fun root() = showPage("Codex")
        fun picked(id: String) = selectDestination(id)
        fun status(text: String?, action: String? = null) = setStatus(text, action) {}
        fun stageBounds() = content.top to content.height
        fun editorTop(): Int = IntArray(2).also { editor.getLocationInWindow(it) }[1]
    }
    class Legacy : SystemAppActivity() { override fun build(saved: Bundle?) { title.text = "Legacy" } }
    private fun all(view: View): List<View> = listOf(view) + if (view is ViewGroup) (0 until view.childCount).flatMap { all(view.getChildAt(it)) } else emptyList()
    private fun layout(a: Screen) {
        val b = a.windowManager.currentWindowMetrics.bounds
        a.window.decorView.apply {
            measure(View.MeasureSpec.makeMeasureSpec(b.width(), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(b.height(), View.MeasureSpec.EXACTLY))
            layout(0, 0, b.width(), b.height())
        }
    }
    @Test fun enabledStatusKeepsTheSameLayoutAndEditorAcrossActionsAndConnectionChanges() {
        val controller = Robolectric.buildActivity(Screen::class.java).create().visible().windowFocusChanged(true)
        try {
            val a = controller.get()
            // Exercise the actual connection callback used by LedgerFeed without opening a device link.
            val connection = ReflectionHelpers.getField<(Boolean) -> Unit>(a, "connection")
            connection(true); a.status("最近确认 · 09:39"); layout(a)
            val input = a.editor
            assertTrue(input.requestFocus())
            assertSame(input, a.window.decorView.findFocus())
            val bounds = a.stageBounds(); val top = a.editorTop()
            fun stable() {
                layout(a)
                assertEquals(bounds, a.stageBounds()); assertEquals(top, a.editorTop())
                assertSame(input, a.editor); assertSame(input, a.window.decorView.findFocus())
                assertEquals("正在写的草稿", input.text.toString())
            }
            a.status("最近确认 · 09:39", "刷新"); stable()
            assertTrue(all(a.window.decorView).filterIsInstance<TextView>().single { it.text.toString() == "刷新" }.height >= 48)
            a.status("最近确认 · 09:39"); stable()
            connection(false); stable(); assertTrue(all(a.window.decorView).filterIsInstance<TextView>().any { it.text.toString().contains("暂时离线") })
            connection(true); stable()
            a.status("这是一条较长的状态说明，只是当前快照；重要业务后果仍显示在页面正文中", "刷新"); stable()
        } finally { controller.destroy() }
    }
    @Test fun rootHasAnIdentityAndStableDestinationsWhileDetailHasBack() {
        val controller = Robolectric.buildActivity(Screen::class.java).create().visible()
        try {
            val a = controller.get(); val views = all(a.window.decorView)
            assertEquals(View.GONE, views.single { it.contentDescription == "返回" }.visibility)
            assertTrue(views.filterIsInstance<TextView>().any { it.text.toString() == "Codex" })
            assertEquals(android.view.Gravity.CENTER, views.filterIsInstance<TextView>().single { it.text.toString() == "会话" }.gravity)
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
