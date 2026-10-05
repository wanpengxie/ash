# Ash 灵动岛胶囊 · 设计交接

目标：把 `android/app/src/main/java/ai/ash/ui/TaskCapsule.kt` 的跨应用悬浮窗，从「进度胶囊 + 步骤列表 + 三个按钮」改成「胶囊 ⇄ 卡片」的灵动岛形态。

## 0. 交付物

| 文件 | 用途 |
|---|---|
| `island.html` | **可运行的参考实现**（纯 HTML/CSS/JS，无依赖）。浏览器打开即可点完整流程。上半部分是组件（`mountIsland` / `renderIsland`），下半部分是演示用手机框，接入时删掉。样式、尺寸、动效、交互以它为准。 |
| `island-tokens.json` | 尺寸、颜色、字号、动效、头像映射的单一来源，原生实现直接照抄。 |
| `avatars/` | 同 `packages/core/ui/avatars`，`island.html` 用相对路径 `./avatars/` 引用。 |

两种复用路线，由实现方选：

- **A. 直接复用 HTML（最省事，100% 还原）**：overlay 窗口里放一个透明背景 `WebView`，从 APK assets 加载 `island.html` 的组件部分；Kotlin 通过 `evaluateJavascript("island.render({...})")` 推 model，JS 通过 `@JavascriptInterface` 回调 `onAllow/onChoose/onSend/...`。窗口尺寸跟随卡片高度（JS 量 `el.getBoundingClientRect()` 回传）。注意：`withoutOverlay()` 仍要能在两帧内移除；WebView 首次创建较慢，建议常驻复用；输入框需要时临时去掉 `FLAG_NOT_FOCUSABLE` 才能弹键盘。
- **B. 原生重写（Compose 或 View）**：按 `island-tokens.json` 和本文 §2–§7 实现，`island.html` 作为像素与行为基准对照。

## 1. 核心原则

1. **不自动跳回 Ash。** 始终停留在当前屏幕，只有用户点「回到 Ash」才 `startActivity(HomeActivity)`。
2. **界面统一成一张卡片，底层仍区分状态。** 执行中 / 等你（waiting_you）/ 本轮结束（done）在数据层保持区分，不能把「问完问题」显示成「已完成」。
3. **展开后显示正文，不显示行动历史。** 执行中只显示当前动作（如「在看网页」）；有正文时显示 Agent 原话。
4. **给你看 ≠ 等你确认。** 结果卡只展示，不加必须点的按钮。
5. **关闭 ≠ 取消任务 / 拒绝审批。** 关闭只是收起；未处理事项保留在胶囊上（琥珀色脉冲），可重新展开。停止任务、拒绝审批是独立动作。
6. **正文必须是 Agent 原话。** JEV 只决定卡片类型（标题、突出哪种交互），不得生成授权选项。正式审批 / 正式 ask / 执行错误优先用系统已有记录。

## 2. 形态

| 形态 | 尺寸 (dp) | 圆角 | 何时 |
|---|---|---|---|
| 胶囊 compact | 236 × 40（贴摄像头时 236 × 34） | 高度一半 | 执行中；卡片被收起后 |
| 卡片 card | 宽 362，高随内容 | 30 | 有正文或需要用户时自动展开；点胶囊也可展开 |
| 贴边 edge | 52 × 52 | 26 | 拖到左右边缘（可选） |

- 默认位置：顶部居中，状态栏下方 8dp（`TYPE_APPLICATION_OVERLAY` 可实现）。
- 「贴摄像头」变体：top ≈ 5dp 包住挖孔。普通 overlay 在状态栏之下，可能需要用已有 `A11yService` 开 `TYPE_ACCESSIBILITY_OVERLAY`，**未真机验证**。
- 形变：宽度和圆角动画 500ms，曲线 `cubic-bezier(.32,.72,0,1)`；内容淡入 340ms（延迟 100ms，带轻微缩放）。尊重系统「减少动画」。
- `withoutOverlay()` 截屏/点按前仍需瞬时移除窗口，回来时用淡入替代生硬闪现。

## 3. 状态 → 展示

| 卡片类型 | 底层来源 | 胶囊文案 / 指示 | 卡片标题 | 正文 | 交互区 |
|---|---|---|---|---|---|
| listening | status=listening | 在听 · 声波 | 在听 | 当前动作 | — |
| thinking | status=thinking | 在想 · 三点呼吸 | 正在处理 | 当前动作 | — |
| working | status=working | 动词（在看网页…）· 转圈 | 正在处理 | 当前动作 + 提示「需要你时这里会展开」 | 停止任务 |
| ask | waiting_you · 正式 ask | 等你回答 · 琥珀脉冲 | 等你回答 | Agent 原话 | 选项按钮（来自原话/正式问题） |
| approval | waiting_you · gate 审批 | 需要批准 · 琥珀脉冲 | 需要你批准 | 要做什么、对谁、提交什么 + 引用框 + 「查看完整原文」 | 见 §4 |
| in_app | done · JEV「需要在 App 中操作」 | 去 Ash 操作 · 琥珀脉冲 | 需要你在 Ash 里操作 | Agent 原话 | 主按钮「去 Ash 里操作」 |
| result | done · JEV「已交付」 | 已完成 · 绿勾 | 已完成 | Agent 最后一组回复，4 行折叠 + 展开全文 | — |
| incomplete | done · JEV「未完成」/ 执行错误 | 未完成 · 红色感叹 | 未完成 | Agent 原话（卡在哪、要什么） | 输入框提示具体内容 |
| stopped | turn.end reason=cancelled | 已停止 · 红方块 | 已停止 | 「后面的步骤没有执行」 | — |
| stale | 15s 未收到帧 | 连接中断 · 灰虚线圈 | 连接中断 | 状态待确认 | 不可停止 |

自动展开：ask / approval / in_app / result / incomplete / stopped 到达时自动展开成卡片（不跳转）。执行类状态保持胶囊。

跨应用隐私沿用现状：执行中文案只取动词，不带网址、搜索词（core 已 `split(" · ")[0]`）。

## 4. 审批按钮状态

| 审批状态 | 显示 | 可点 |
|---|---|---|
| pending | 「允许并继续」（主色）+「拒绝」 | 是 |
| approved | 「✓ 已批准，等待继续」 | 否，禁止重复提交 |
| denied | 「已拒绝 · 这一步不会执行」 | 否 |
| expired | 「已过期 · 未执行，需要时让 Ash 重新申请」 | 否 |

「允许并继续」只批准绑定的这一次操作；Agent 收到后重新核对现场再继续，不是盲目执行。普通补充信息走输入框，不另设「继续」按钮。

## 5. 卡片通用结构

```
[头像 40dp] 标题（前面状态色圆点，等你类脉冲）        [收起 ⌃]
            Ash · 已用 0:35 / 用时 1 分 05 秒 / 刚刚
正文（Agent 原话）或 当前动作块
交互区（选项 / 审批按钮 / 去 Ash 主按钮，按需出现）
───────────────────────────────
[ 输入框：回复 Ash… ]                              [发送 ↑]
停止任务（仅执行中，红色，左对齐）      回到 Ash    关闭
```

- 头像用 `packages/core/ui/avatars/*.webp`，按状态换脸：listening→listening，thinking→thinking，working/approval→focused，result→success，其余→default。
- 输入框发送 = 给 agent:main 发普通消息；回答 ask 的选项 = 回复对应请求（reply_to），Agent 再继续。
- 所有可点元素 ≥ 44dp；图标按钮带 contentDescription。

## 6. 关闭 / 收起行为

| 当前 | 点「关闭」 |
|---|---|
| 执行中 | 收成胶囊 |
| ask / approval(pending) / in_app / incomplete | 收成胶囊，琥珀脉冲保留，可重新展开；不取消、不拒绝 |
| result / stopped / approval 已决 | 隐藏悬浮窗；内容在 Ash 对话里可找到 |

「收起 ⌃」（卡片右上）始终只是回到胶囊。原「收起并隐藏本次悬浮窗」可由「关闭」或上滑甩出承担。

## 7. 颜色（深色，沿用 Ash UI token）

| 用途 | 值 |
|---|---|
| 岛底 | #101011（内描边 rgba(255,255,255,.06)） |
| 卡内块 / 输入框 | #1A1A1C / #1E1E21 |
| 主文字 / 次文字 | #F2F2F4 / #A1A1A7 |
| 进行中 | #5AD8DB |
| 等你 | #F5A623 |
| 完成 | #2BB673 |
| 停止 / 错误 | #FF6B6B（文字 #FF8A8A） |
| 失联 | #8D8D93 |
| 主按钮 | #3B74FF |

字体：系统字体（PingFang SC / Noto Sans SC），数字等宽。

## 8. 数据层需要补的东西（建议）

现有 `TaskFrame` 只有 `state/text/steps/can_stop`，卡片需要额外字段（字段名仅建议）：

- `card_kind`: ask | approval | in_app | result | incomplete | stopped（由正式记录或 JEV 给出）
- `body`: Agent 原话（跨应用展示，需确认隐私边界）
- `options`: 选项文本数组（仅来自原话/正式 ask）
- `request_id`: 对应 ask / 审批请求，用于回答与批准
- `approval`: pending | approved | denied | expired，及要做什么/对谁/内容摘要与完整原文入口
- `steps` 可废弃（卡片不再展示历史）

另：保持在当前屏幕不等于保留后台虚拟屏，虚拟屏回收独立处理。
