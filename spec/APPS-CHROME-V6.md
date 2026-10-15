# v6 最小公共原生外壳

在原 SystemAppActivity 上可选接入；原 build/content/actions/title/call/humanClient/deck/onLedger/onConnectionChanged 与返回接口不变。没有 appIdentity 的旧子类保留原返回栏。只组合现有项目令牌，不修改聊天主题、不建立渲染框架。

```kotlin
// imports ai.ash.sysapps.*
override val appIdentity = AppIdentity("Codex", R.drawable.ash_ic_cpu, AppAccent.BLUE)
override fun build(saved: Bundle?) {
    setDestinations(listOf(
        AppDestination("now", "现在", R.drawable.ash_ic_cpu),
        AppDestination("sessions", "会话", R.drawable.ash_ic_msg),
    ), selected = "now") { id -> /* 业务切原空间并 selectDestination(id) */ }
    setStatus("正在读取") // 随真实快照更新为最近确认；不由外壳编时间/计数
    showPage("Codex")
}
```

- AppAccent：TASKS（you）、TEAL、PURPLE、BLUE，均沿现有 palette。
- showPage(label, detail=false, showNavigation=true)：根页应用标识无返回箭头，详情显示返回，底部选中目的地不变；业务仍实现原 canGoBack/goBack。
- setDestinations(items, selected, onSelect)：固定2–3目的地，只触发业务选择，不自动导航或存储业务。selectDestination(id)只更新选中，不触发回调。
- setStatus(text, action?, onAction?)：标题下真实状态/最后确认/实际待处理数。新应用不留原离线大白条；连接问题替换此状态，不增加一行。先在build设置真实加载文案。
- 启用的状态槽固定预算为 `max(48dp, 当前字号两行高度+8dp)`，短确认、可选动作显隐、离线/恢复和长状态不挤内容。状态摘要最多两行，关键业务后果在正文；`setStatus(null)` 仅供页面明确切换时收起。正常字体下48dp，大字随当前字体尺度预留，不靠异步延时。
- setBottomAction(view?)：固定非输入动作，例如保存；不盖住主内容。详情按需隐藏导航，回原空间恢复。
- **带输入的dock继续置于业务 KeyboardDeck 内**，沿既定translation；不把输入单独放bottomActions，避免列表与输入分离。
- AppUi：icon(ctx,res,color,size=22)、surface(ctx,decision=false)、section(ctx,label)、button(ctx,label,accent,primary=true,click)。均无业务状态；按钮用既有触控/字体规格，卡无阴影。
- 图标统一既有资源：ash_ic_slider（不是sliders）、more、cpu、heart、laptop、shield、msg、grid、clock、list、file等。

新增 SystemAppChromeTest 验根/详情/稳定目的地与旧子类兼容。本提交按调度未运行Gradle，待总控安排相关单命令验证，不冒称已编译。

后续实际验证：d013fbb5状态几何修复首次指定回归3/3通过；5b80be54底栏标签居中后，随Codex第二轮指定命令再次3/3通过，包含Kotlin编译。日志 `/data/atoll/tmp/sysapps-base-chrome-v6.log`、`/data/atoll/tmp/sysapps-base-codex-v6-r2.log`。新增状态槽实际layout跨action显隐/断线恢复不改变content top/height、真实decor焦点、同一EditText及草稿；不是只验纯Model。
