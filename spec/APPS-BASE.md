# 系统应用共用底座

涉及 MOBILE-ARCH §1.1–1.4、§3.6、§4.4、§11.2、§13.1。

每个应用继承 `ai.ash.sysapps.SystemAppActivity`，实现 `build(saved: Bundle?)`，把页面加入 `content: FrameLayout`。`title` 和 `actions` 是共用标题与右侧动作位。列表使用已有 `ai.ash.ui.KeyedRowsAdapter`；共用层不另存业务快照。

- `call(to, word, body = JSONObject(), done)`：经 HumanCall 发主人请求，不占 ChatBridge 的 page；完成在主线程，Activity 销毁后不再回调 View。
- `onLedger(message: JSONObject)`：STARTED 时收到完整账本消息（from/to/word/body/payload 等），自行按成员和词筛选。不是无参数变更提示，也不抹掉消息内容。
- `onConnectionChanged(connected: Boolean)`：进入页面立即给当前连接状态，其后断开/恢复也通知。应用进入前台、连接恢复时重读自己的状态。
- `onStart/onStop` 自动注册/注销共享 LedgerFeed。Feed 在现有 LinkClient 上独立 openSync，不依赖聊天 Activity，也不接管聊天 page。最后一个应用离开关闭 sync；重连重新订阅。所有监听在主线程。
- `deck: KeyboardDeck?`：会话页声明键盘平移对象，其余页面按 IME 留出空间。每 Window 只安装一次 WindowInsetsOwner。
- `canGoBack()/goBack()/syncBack()`：子路由返回；根交系统。系统返回和标题返回同语义。
- `SystemAppActivity.EXTRA_ARG`：open 的 arg 字符串，可由应用自行解析为 JSON 或路由。

注册由底座作者统一修改：SDK `SYSTEM_APPS`、Android `SystemApps` 和 Manifest。只有具体 Activity 已交付时才登记，避免格子指向尚不存在的页面。系统应用随 Ash 发布，不提供 Web 应用的安装/删除/固定到 Android 桌面动作。

验证：TypeScript 编译；SDK app/link、human channels、apps service 相关单测；Android compileDebugKotlin 与 LedgerMessages、ChatBridgeState、AppInfoNeeds、FramesConformance、ManifestClasses 单测。完整事件载荷与 open app 协议有回归。未操作手机，IME、预测返回、字体/无障碍等真实系统交互尚未验证。
