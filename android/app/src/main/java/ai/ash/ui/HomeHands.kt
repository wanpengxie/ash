package ai.ash.ui

import ai.ash.link.Link
import ai.ash.ui.design.AshTokens
import ai.ash.ui.design.AshType
import ai.ash.ui.design.AshUi
import ai.ash.ui.design.AshUi.Kind
import ai.ash.ui.design.Role

/** Her browser: the logins she holds are kept on this phone; here they can all be cleared. */
class HmBrowser(env: HomeEnv, arg: String?) : HomePage(env, arg) {
    override val title = "她的浏览器"
    private val status = Hk.note(ctx, "")
    private var warn = ""

    init {
        body.addView(AshUi.card(ctx).apply {
            setPadding(dp(16), dp(16), dp(16), dp(16))
            addView(AshUi.text(ctx, "登录过的网站", AshType(20f, 28f, 700, Role.INK)))
            addView(AshUi.text(ctx, "她用自己的浏览器帮你上网。你在里面登录过的网站只保存在这台手机上。", AshTokens.Type.sub))
        })
        body.addView(Hk.twoTap(ctx, "清除浏览器里的所有登录", "再点一次确认清除", "会清掉所有网站的登录并关闭浏览器，之后她需要你重新登录。", { status.text = it }) {
            status.text = "正在清除…"
            call(Link.get(ctx).deviceId, "x.android.browser.clear_logins") { r -> status.text = if (r.ok) "已清除所有登录。" else "清除失败，请重试。" }
        })
        body.addView(status)
    }
}
