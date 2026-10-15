# Codex 原生应用

涉及 MOBILE-ARCH §1.1–1.4、§2.1–2.4、§3.2–3.6、§4.2–4.4、§11.1–11.2、§13.1–13.2。

id `codex`，Activity `ai.ash.sysapps.codex.CodexActivity`。继承共用底座；标题、停止动作、Insets 与返回都由同一个 Window 骨架承载。原 CodexPane 移到应用包，保留纯 CodexModel/State、KeyedRows、草稿、持久待发、client_id 和阅读锚点；不再占 HomeActivity 的标签页或聊天端口。外壳移除 CODEX 路由和聊天页 Codex 按钮，入口统一在应用格子。旧通知的 codex 入口转到新应用。

一个应用管理所有提供 x.codex 词的在线电脑；仅一台不画选择器。较旧中枢未提供 capabilities 字段时保留原兼容行为。会话列表 → 会话 / 新建的业务词全部经 HumanCall。应用前台订阅完整账本，主人或 agent 的发送/停止/审批立即触发刷新；电脑自身运行变化仍按原间隔读取。读取词不反过来触发读取，防止账本刷新循环。离页停止轮询、注销事件和失效旧读。

`person:owner/open {app:"codex",arg}` 支持 thread id，或 JSON 字符串 `{device?,thread?}`。Activity 重建优先恢复已保存的路由、草稿和锚点。通知复用已有 Activity，不另存业务状态。

为任务应用增加 `HomeActivity.EXTRA_MESSAGE_ID`（`ai.ash.extra.MESSAGE_ID`）：冷/热启动统一回到聊天并定位来源消息。初次连接/初读尚未就绪时保留跳转意图，不丢掉来源；不主动拉起键盘。

验证：Android compileDebugKotlin 与 CodexModel/State/Send、CodexOpen、HomeRoute、ChatState、ManifestClasses 相关单测；中枢 apps service / builtin 31项单测；TypeScript 编译。未操作手机：主人与 Ash 同时向真实电脑 Codex 发送、真实 IME/阅读位置/大字体/预测返回仍需后续设备验收，不以编译冒充通过。
