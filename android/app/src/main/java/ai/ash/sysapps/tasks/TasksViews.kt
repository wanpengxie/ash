package ai.ash.sysapps.tasks

import ai.ash.R
import ai.ash.sysapps.AppUi
import ai.ash.sysapps.AppAccent
import ai.ash.ui.OnboardingViews
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshUi
import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/** Task facts and object rows; navigation and window chrome belong to SystemAppActivity. */
internal class TasksViews(private val ctx: Context) {
    private val c get() = AshUi.p(ctx)
    private fun dp(v: Int) = AshUi.dp(ctx,v)
    fun line() = View(ctx).apply { setBackgroundColor(c.line);layoutParams=LinearLayout.LayoutParams(-1,dp(1)) }
    fun section(label:String,count:Int?=null) = AshUi.hstack(ctx,8).apply {
        setPadding(0,dp(24),0,dp(8))
        addView(AshUi.text(ctx,label,AshTokens.Type.headline),LinearLayout.LayoutParams(0,-2,1f))
        count?.let { addView(AshUi.text(ctx,it.toString(),AshTokens.Type.sub,c.text2)) }
    }
    fun text(value:String) = AshUi.text(ctx,value,AshTokens.Type.body)
    fun icon(id:Int) = ImageView(ctx).apply { setImageResource(id);setColorFilter(c.text2);importantForAccessibility=View.IMPORTANT_FOR_ACCESSIBILITY_NO;layoutParams=LinearLayout.LayoutParams(dp(22),dp(22)) }
    fun avatar(t:TasksModel.Task,names:Map<String,String>):View = when {
        t.assignee=="person:owner" -> AshUi.text(ctx,"你",AshTokens.Type.body,c.text2).apply {
            gravity=Gravity.CENTER;background=AshUi.rounded(c.surface3,dp(18).toFloat());layoutParams=LinearLayout.LayoutParams(dp(36),dp(36))
        }
        names[t.assignee]=="Ash" -> OnboardingViews.avatar(ctx,"default",36)
        else -> AshUi.letterAvatar(ctx,TasksModel.assignee(t,names),36)
    }
    fun row(t:TasksModel.Task,names:Map<String,String>,subtitle:String,onOpen:()->Unit):View = AshUi.vstack(ctx).apply {
        tag=t.key;addView(line())
        addView(AshUi.hstack(ctx,12).apply {
            minimumHeight=dp(76);setPadding(0,dp(12),0,dp(12))
            addView(avatar(t,names))
            addView(AshUi.vstack(ctx,4).apply {
                addView(AshUi.text(ctx,t.title,AshTokens.Type.headline))
                addView(AshUi.text(ctx,subtitle,AshTokens.Type.sub,c.text2))
            },LinearLayout.LayoutParams(0,-2,1f))
            addView(icon(R.drawable.ash_ic_chev))
            isClickable=true;isFocusable=true;AshUi.role(this,android.widget.Button::class.java.name);setOnClickListener { onOpen() }
        })
    }
    fun note(value:String) = text(value).apply {
        setTextIsSelectable(true);setPadding(dp(16),dp(16),dp(16),dp(16))
        background=AshUi.rounded(c.surface,dp(AshTokens.Radius.md).toFloat(),c.line2,dp(1))
    }
    fun action(label:String,primary:Boolean=false,outline:Boolean=false,onClick:()->Unit):TextView = AppUi.button(ctx,label,AppAccent.TASKS,primary,onClick).apply {
        if(outline)background=AshUi.rounded(c.surface,dp(AshTokens.Radius.sm).toFloat(),c.line2,dp(1))
    }
    fun actions(vararg buttons:TextView) = AshUi.hstack(ctx,8).apply {
        buttons.forEach { addView(it,LinearLayout.LayoutParams(0,-2,1f)) }
    }
    fun recovery(t:TasksModel.Task,onOpen:()->Unit,onRetry:()->Unit,enabled:Boolean=true):View = AshUi.vstack(ctx,12).apply {
        tag="recovery:${t.id}";setPadding(dp(16),dp(16),dp(16),dp(16))
        background=AshUi.rounded(c.surface,dp(AshTokens.Radius.card).toFloat(),c.line,dp(1))
        addView(AshUi.hstack(ctx,8).apply {
            minimumHeight=dp(48)
            addView(AshUi.text(ctx,t.title,AshTokens.Type.headline),LinearLayout.LayoutParams(0,-2,1f));addView(icon(R.drawable.ash_ic_chev))
            isClickable=true;isFocusable=true;AshUi.role(this,android.widget.Button::class.java.name);setOnClickListener { onOpen() }
        })
        addView(AshUi.text(ctx,TasksModel.delivery(t),AshTokens.Type.body,c.text2))
        addView(AshUi.hstack(ctx).apply { gravity=Gravity.END;addView(action(TasksModel.recoveryAction(t),outline=true,onClick=onRetry).apply { isEnabled=enabled }) })
    }
}
