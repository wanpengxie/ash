package ai.ash.sysapps.team

import ai.ash.R
import ai.ash.ui.OnboardingViews
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

/** Team-specific content from the frozen v6 screens. Navigation and window chrome belong to the shared host. */
internal class TeamViews(private val ctx: Context) {
    private val c get() = AshUi.p(ctx)
    private fun d(v: Int) = AshUi.dp(ctx, v)
    fun text(value: String, type: AshType = AshTokens.Type.body, muted: Boolean = false) =
        AshUi.text(ctx, value, type, if (muted) c.text2 else c.text).apply { setTextIsSelectable(true) }
    // A clickable row owns its tap; only the reading surface offers text selection.
    private fun label(value: String, type: AshType = AshTokens.Type.body, muted: Boolean = false) = text(value,type,muted).apply { setTextIsSelectable(false) }
    fun divider() = View(ctx).apply { setBackgroundColor(c.line); layoutParams = LinearLayout.LayoutParams(-1, d(1)) }
    fun section(value: String) = AshUi.vstack(ctx).apply {
        setPadding(0,d(24),0,d(12)); addView(text(value,AshTokens.Type.headline))
    }
    fun panel(gap: Int = 8) = AshUi.vstack(ctx,gap).apply {
        background = AshUi.rounded(c.surface,AshUi.dpF(ctx,16f),c.line2,d(1))
        setPadding(d(16),d(16),d(16),d(16))
    }
    private fun avatar(m: TeamModel.Member, size: Int): View = if (m.primary) {
        AshUi.AvatarView(ctx).apply { image = OnboardingViews.face(ctx,"default"); layoutParams = LinearLayout.LayoutParams(d(size),d(size)) }
    } else label(m.name.take(1),if(size>36) AshTokens.Type.display else AshTokens.Type.headline).apply {
        gravity = Gravity.CENTER; setTextColor(c.helperPurple)
        background = AshUi.rounded(c.surface2,AshUi.dpF(ctx,size*0.32f))
        layoutParams = LinearLayout.LayoutParams(d(size),d(size))
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    fun member(m: TeamModel.Member, work: String, cost: String, onClick: () -> Unit) = AshUi.vstack(ctx).apply {
        addView(divider())
        addView(AshUi.hstack(ctx,12).apply {
            minimumHeight=d(76); setPadding(0,d(12),0,d(12)); gravity=Gravity.CENTER_VERTICAL
            addView(avatar(m,36))
            addView(AshUi.vstack(ctx,4).apply {
                addView(label(m.name,AshTokens.Type.headline)); addView(label(work,AshTokens.Type.sub,true))
            },LinearLayout.LayoutParams(0,-2,1f))
            addView(label(cost,AshTokens.Type.sub,true).apply { maxWidth=d(108); gravity=Gravity.END })
            isClickable=true; isFocusable=true; contentDescription="${m.name}，$work，$cost"; setOnClickListener { onClick() }
            AshUi.role(this,android.widget.Button::class.java.name)
        })
    }
    fun identity(m: TeamModel.Member) = AshUi.hstack(ctx,12).apply {
        setPadding(0,d(12),0,d(20)); addView(avatar(m,56))
        addView(AshUi.vstack(ctx,4).apply {
            addView(text(m.name,AshTokens.Type.title))
            addView(text(listOf(m.role,m.model).filter(String::isNotBlank).joinToString(" · "),AshTokens.Type.sub,true))
        },LinearLayout.LayoutParams(0,-2,1f))
    }
    fun metrics(state: String, cost: String, explanation: String) = AshUi.vstack(ctx).apply {
        addView(divider())
        addView(AshUi.hstack(ctx,12).apply {
            setPadding(0,d(16),0,d(16)); gravity=Gravity.TOP
            addView(AshUi.vstack(ctx,6).apply { addView(text(state,AshTokens.Type.headline)); addView(text("可问原成员",AshTokens.Type.sub,true)) },LinearLayout.LayoutParams(0,-2,1f))
            addView(AshUi.vstack(ctx,6).apply { addView(text(cost,AshTokens.Type.headline)); addView(text(explanation,AshTokens.Type.sub,true)) },LinearLayout.LayoutParams(0,-2,1f))
        }); addView(divider())
    }
    fun delivery(e: TeamModel.Exchange, names: Map<String,String>, onClick: () -> Unit) = panel().apply {
        val row=AshUi.hstack(ctx,12)
        row.addView(View(ctx).apply { background=ctx.getDrawable(R.drawable.ash_ic_file)?.mutate()?.apply{setTint(c.helperPurple)}; importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO },LinearLayout.LayoutParams(d(40),d(52)))
        row.addView(AshUi.vstack(ctx,4).apply {
            addView(label(e.text.lineSequence().firstOrNull().orEmpty().take(90).ifBlank{"原委托"},AshTokens.Type.headline))
            val from=if(e.from=="person:owner") "你" else names[e.from]?:e.from.removePrefix("agent:")
            val to=names[e.to]?:e.to.removePrefix("agent:")
            val direction=if(e.answer!=null) "$to → $from" else "$from → $to"
            addView(label("$direction · ${e.status}",AshTokens.Type.sub,true))
            val answer=e.answer?.let{it.error.ifBlank{it.text}} ?: e.text
            addView(label(answer.take(100)+if(answer.length>100)"…" else "",AshTokens.Type.sub,true).apply { maxLines=3; ellipsize=android.text.TextUtils.TruncateAt.END })
        },LinearLayout.LayoutParams(0,-2,1f)); addView(row)
        minimumHeight=d(100); isClickable=true; isFocusable=true; contentDescription="查看原委托与回答"; setOnClickListener{onClick()}; AshUi.role(this,android.widget.Button::class.java.name)
    }
}
