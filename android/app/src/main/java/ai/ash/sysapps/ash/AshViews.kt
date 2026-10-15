package ai.ash.sysapps.ash

import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import ai.ash.R
import ai.ash.ui.OnboardingViews
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi

/** Ash's facts and shared promises; no alternate data model or navigation frame. */
internal object AshViews {
    private fun dp(ctx: Context, value: Int) = AshUi.dp(ctx, value)
    fun region(ctx: Context, top: Int = AshTokens.Space.xl) = AshUi.vstack(ctx, AshTokens.Space.sm).apply {
        setPadding(0, dp(ctx, top), 0, 0)
    }
    fun line(ctx: Context) = View(ctx).apply {
        setBackgroundColor(AshUi.p(ctx).line)
        layoutParams = LinearLayout.LayoutParams(-1, dp(ctx, 1))
    }
    fun section(ctx: Context, text: String, count: String? = null) = region(ctx).apply {
        addView(AshUi.hstack(ctx, AshTokens.Space.sm).apply {
            addView(AshUi.text(ctx, text, AshTokens.Type.headline), LinearLayout.LayoutParams(0, -2, 1f))
            count?.let { addView(AshUi.text(ctx, it, AshTokens.Type.sub)) }
        })
    }
    fun profile(ctx: Context, name: String, state: String, confirmed: String) = region(ctx, AshTokens.Space.md).apply {
        addView(line(ctx))
        addView(AshUi.hstack(ctx, AshTokens.Space.md).apply {
            setPadding(0, dp(ctx, AshTokens.Space.md), 0, dp(ctx, AshTokens.Space.sm))
            addView(OnboardingViews.avatar(ctx, "default", AshTokens.Size.avatarPage))
            addView(AshUi.vstack(ctx, AshTokens.Space.xxs).apply {
                addView(AshUi.text(ctx, name, AshTokens.Type.title))
                addView(AshUi.text(ctx, state, AshTokens.Type.body, AshUi.p(ctx).text2))
                addView(AshUi.text(ctx, confirmed, AshTokens.Type.sub))
            }, LinearLayout.LayoutParams(0, -2, 1f))
        })
    }
    fun fact(ctx: Context, topic: String, text: String, onClick: (() -> Unit)? = null) = region(ctx, AshTokens.Space.md).apply {
        addView(AshUi.vstack(ctx, AshTokens.Space.xxs).apply {
            val gap = dp(ctx, AshTokens.Space.md)
            setPadding(gap, gap, gap, gap)
            background = AshUi.rounded(AshUi.p(ctx).surface, AshUi.dpF(ctx, AshTokens.Radius.card.toFloat()), AshUi.p(ctx).line, dp(ctx, 1))
            addView(AshUi.text(ctx, topic, AshTokens.Type.sub))
            addView(AshUi.text(ctx, text, AshTokens.Type.title.copy(weight = 500)))
            if (onClick != null) {
                isClickable = true; isFocusable = true; minimumHeight = dp(ctx, AshTokens.Size.touch)
                AshUi.role(this, android.widget.Button::class.java.name)
                contentDescription = ctx.getString(R.string.ash_correct_fact, text)
                setOnClickListener { onClick() }
            }
        })
    }
    fun promise(ctx: Context, title: String, assignee: String, primary: Boolean, status: String, onClick: () -> Unit) = AshUi.vstack(ctx).apply {
        addView(line(ctx))
        addView(AshUi.hstack(ctx, AshTokens.Space.sm).apply {
            setPadding(0, dp(ctx, AshTokens.Space.md), 0, dp(ctx, AshTokens.Space.md))
            minimumHeight = dp(ctx, 76)
            if (primary) addView(OnboardingViews.avatar(ctx, "default", AshTokens.Size.avatarTop))
            else addView(AshUi.LetterAvatarView(ctx, assignee), LinearLayout.LayoutParams(dp(ctx, AshTokens.Size.avatarTop), dp(ctx, AshTokens.Size.avatarTop)))
            addView(AshUi.vstack(ctx, AshTokens.Space.xxs).apply {
                addView(AshUi.text(ctx, title, AshTokens.Type.headline))
                addView(AshUi.text(ctx, "$assignee · $status", AshTokens.Type.sub))
            }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(View(ctx).apply { background = ctx.getDrawable(R.drawable.ash_ic_chev)?.mutate()?.apply { setTint(AshUi.p(ctx).text2) } }, LinearLayout.LayoutParams(dp(ctx, AshTokens.Size.iconSm), dp(ctx, AshTokens.Size.iconSm)))
            isClickable = true; isFocusable = true; AshUi.role(this, android.widget.Button::class.java.name)
            setOnClickListener { onClick() }
        })
    }
    fun timeline(ctx: Context, time: String, title: String, detail: String, onClick: () -> Unit) = AshUi.vstack(ctx).apply {
        addView(line(ctx))
        addView(AshUi.hstack(ctx, AshTokens.Space.sm).apply {
            gravity = Gravity.TOP
            setPadding(0, dp(ctx, AshTokens.Space.sm), 0, dp(ctx, AshTokens.Space.sm)); minimumHeight = dp(ctx, AshTokens.Size.touch)
            addView(AshUi.text(ctx, time, AshTokens.Type.sub), LinearLayout.LayoutParams(dp(ctx, AshTokens.Size.touch), -2))
            addView(AshUi.vstack(ctx, AshTokens.Space.xxs).apply {
                addView(AshUi.text(ctx, title, AshTokens.Type.body))
                if (detail.isNotEmpty()) addView(AshUi.text(ctx, detail, AshTokens.Type.sub))
            }, LinearLayout.LayoutParams(0, -2, 1f))
            isClickable = true; isFocusable = true; AshUi.role(this, android.widget.Button::class.java.name)
            setOnClickListener { onClick() }
        })
    }
}
