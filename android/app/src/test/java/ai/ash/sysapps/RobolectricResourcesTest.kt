package ai.ash.sysapps

import ai.ash.R
import android.app.Activity
import android.app.Application
import android.widget.TextView
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The shared test setup loads an actual Activity, resources and View; it does not launch Ash's device services. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class RobolectricResourcesTest {
    @Test fun anActivityHasPackagedResourcesAndAWorkingEditableViewTree() {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        try {
            val activity = controller.get()
            assertNotNull(activity.getDrawable(R.drawable.ash_ic_back))
            val text = TextView(activity).apply { this.text = "中文界面" }
            activity.setContentView(text)
            assertEquals("中文界面", text.text.toString())
            assertSame(activity.window.decorView, text.rootView)
        } finally { controller.pause().stop().destroy() }
    }
}
