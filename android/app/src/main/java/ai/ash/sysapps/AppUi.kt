package ai.ash.sysapps

import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi
import android.content.Context
import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

/** Stateless composition of the existing project tokens for the five system apps. */
enum class AppAccent {
    TASKS, TEAL, PURPLE, BLUE;
    fun color(ctx: Context): Int = AshUi.p(ctx).let { p -> when (this) {
        TASKS -> p.you; TEAL -> p.helperTeal; PURPLE -> p.helperPurple; BLUE -> p.helperBlue
    } }
    fun foreground(ctx: Context): Int = if (this == TASKS) AshUi.p(ctx).onYou else AshUi.p(ctx).onHelper
}

data class AppIdentity(val name: String, val icon: Int, val accent: AppAccent)
data class AppDestination(val id: String, val label: String, val icon: Int)

object AppUi {
    fun icon(ctx: Context, resource: Int, color: Int, size: Int = 22): View = View(ctx).apply {
        background = ctx.getDrawable(resource)?.mutate()?.apply { setTint(color) }
        layoutParams = LinearLayout.LayoutParams(AshUi.dp(ctx, size), AshUi.dp(ctx, size))
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun surface(ctx: Context, decision: Boolean = false): LinearLayout = AshUi.vstack(ctx, 12).apply {
        val p = AshUi.p(ctx)
        background = AshUi.rounded(p.surface, AshUi.dpF(ctx, if (decision) 22f else 16f), p.line2, AshUi.dp(ctx, 1))
        setPadding(AshUi.dp(ctx, 16), AshUi.dp(ctx, 16), AshUi.dp(ctx, 16), AshUi.dp(ctx, 16))
    }

    fun section(ctx: Context, label: String): LinearLayout = AshUi.vstack(ctx, 12).apply {
        addView(AshUi.text(ctx, label, AshTokens.Type.headline))
        addView(View(ctx).apply { setBackgroundColor(AshUi.p(ctx).line2) }, LinearLayout.LayoutParams(-1, AshUi.dp(ctx, 1)))
    }

    /** The same 48dp+ project button, with this app's identity colour and the SPEC's local control radius. */
    fun button(ctx: Context, label: String, accent: AppAccent, primary: Boolean = true, click: () -> Unit): TextView =
        AshUi.button(ctx, label, if (primary) AshUi.Kind.PRIMARY else AshUi.Kind.NEUTRAL, AshUi.BtnSize.LG, onClick = click).apply {
            val p = AshUi.p(ctx)
            background = AshUi.rounded(if (primary) accent.color(ctx) else p.surface2, AshUi.dpF(ctx, 12f))
            setTextColor(if (primary) accent.foreground(ctx) else p.ink)
            setPadding(AshUi.dp(ctx, 16), AshUi.dp(ctx, 8), AshUi.dp(ctx, 16), AshUi.dp(ctx, 8))
            minHeight = AshUi.dp(ctx, 52); minimumWidth = AshUi.dp(ctx, 48)
            gravity = Gravity.CENTER
        }
}
