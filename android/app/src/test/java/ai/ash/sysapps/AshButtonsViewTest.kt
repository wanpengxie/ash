package ai.ash.sysapps

import ai.ash.ui.design.AshUi
import android.app.Activity
import android.app.Application
import android.view.View
import android.widget.LinearLayout
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Measure the actual common button, including the Drawable/background path, at a phone density. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class, qualifiers = "w393dp-h851dp-xxhdpi")
class AshButtonsViewTest {
    @Test fun shortLabelsKeepTheirHorizontalPaddingAndHaveAFingerSizedTarget() {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        try {
            val activity = controller.get()
            val row = LinearLayout(activity)
            val button = AshUi.button(activity, "批准", size = AshUi.BtnSize.SM)
            row.addView(button); activity.setContentView(row)
            row.measure(View.MeasureSpec.makeMeasureSpec(AshUi.dp(activity, 393), View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(AshUi.dp(activity, 851), View.MeasureSpec.AT_MOST))
            row.layout(0, 0, row.measuredWidth, row.measuredHeight)
            println("AshUi.button SM actual: padding=${button.paddingLeft},${button.paddingRight}; bounds=${button.width}x${button.height}; density=${activity.resources.displayMetrics.density}")
            assertEquals(AshUi.dp(activity, AshUi.BtnSize.SM.padXDp), button.paddingLeft)
            assertEquals(AshUi.dp(activity, AshUi.BtnSize.SM.padXDp), button.paddingRight)
            assertTrue("button width >=48dp", button.width >= AshUi.dp(activity, 48))
            assertTrue("button height >=48dp", button.height >= AshUi.dp(activity, 48))
        } finally { controller.pause().stop().destroy() }
    }
}
