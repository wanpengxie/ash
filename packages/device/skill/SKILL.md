---
name: ash
description: 通过 Ash 使用主人的手机和 Ash 中枢的能力（屏幕、应用、通知、位置、相机、其他设备等），并和 Ash 的 agent 对话。需要动手机、给主人发消息、问或交代 Ash 的 agent 时用它。
whenToUse: 任务要用到主人的手机或 Ash 里的东西，比如看手机屏幕、在手机应用里办事、给主人的手机发通知或消息、读位置或日历、让 Ash 的 agent 帮忙或打听情况；用 capability_*、agent_ask、agent_tell 之前。
---

# 用 Ash

Ash 是主人手机上的个人助理系统，和你的 Codex 是平级的两个产品，服务同一个人。它有一个常驻的**中枢**，管着手机这台设备（屏幕、应用、通知、位置、相机……）、主人的其他电脑、Ash 自己的应用，还有一组 **agent**（有名字、有记忆、能自己干活的帮手，其中有一位是主人默认对话的主 agent）。你通过本机的 `ash-device` 连到它，**不需要先在 Ash 里开一轮对话**，在任何 Codex 会话里都能直接调。

你在 Ash 里的身份是「这台电脑上的 Codex」：每次调用都会记进 Ash 的账本，能看出来自哪台电脑、哪个 Codex 会话。你**不是** Ash 的 agent，Ash 不会给你派活；你对它只有两件事：**用它的能力**，和**跟它的 agent 说话**。

## 什么时候找 Ash

- 要在手机上做事：看屏幕、打开应用、在应用里查东西、点按钮、填内容（`screen.*`、`apps.*`、`vscreen.*`）。
- 要让主人知道：任务做完、卡住需要他决定、出了他该看的东西，给他的手机发一条消息（`person:owner` 的 `say`）。
- 要读手机上的信息：位置、日历、通知、电量等（`service:senses`、设备的 `sense.*`）。
- 要问或交代 Ash 的 agent：它记得主人的偏好和近况，你不确定的事先问它，比问主人省事；要它帮你办的事用「交代」。
- **不要**用 Ash 做你在电脑上自己就能做的事（读写本机文件、跑命令、改代码）。

## 工具（Codex 里显示为 `mcp__ash__<名字>`）

| 工具 | 作用 |
|---|---|
| `capability_list` | 列出现在能用的一切：每个成员（手机、其他设备、应用、Ash 的服务）和它们的词，带一句话说明、读写属性、要不要主人批准。`member` 可只看一个。设备一连上就会出现，每次用之前先看，别凭记忆写设备编号 |
| `capability_describe` | 看一个成员的词的完整说明：参数怎么写（`input_schema`）、返回什么、风险。**调用前先看**，参数照它写 |
| `capability_call` | 真正调用：`member` + `word` + `body`（按说明写的参数）。可选 `purpose`（一句主人看得懂的话，会显示在批准卡上）、`wait`、`approval_ttl_minutes` |
| `await_result` / `list_pending` / `cancel` | 一次调用超过约 15 秒会先给收据（`status: accepted` + `request_id`）：用 `await_result` 取结果，`list_pending` 看还在跑的，`cancel` 取消 |
| `agent_list` | 列出 Ash 的 agent |
| `agent_ask` | 问某个 agent 并等回答（最多等约 50 秒；没等到会给收据，用 `await_result` 接着等）。回答回到你这一次调用里 |
| `agent_tell` | 给某个 agent 交代一件事，不等回答 |

例子：

```
capability_list {}
capability_list {"member": "device:<手机的编号>"}
capability_describe {"member": "device:<手机的编号>", "word": "screen.read"}
capability_call {"member": "device:<手机的编号>", "word": "screen.read", "purpose": "正在看手机当前屏幕"}
capability_call {"member": "person:owner", "word": "say", "body": {"text": "构建完成，测试全过。"}}
agent_list {}
agent_ask {"agent": "<agent_list 里的名字>", "text": "主人最近常去的那家打印店叫什么？"}
agent_tell {"agent": "<agent_list 里的名字>", "text": "我在电脑上把周报改好了，放在 ~/Documents/周报.md，主人问起就告诉他。"}
```

手机的编号、agent 的名字都从 `capability_list` / `agent_list` 里拿，**不要写死**。手机显示 offline、或列表里没有手机，就如实告诉用户手机没连上，不要重试很多次。

## 批准：哪些动作会弹卡、要等主人

Ash 按每个词的性质决定放行还是问主人，**你的身份不会多给也不会少给**，和 Ash 自己的 agent 同一套规则：

- **读**一般直接放行（看屏幕、读列表、读位置）。
- **改东西、对外做事、花钱、发消息给别人、删除、装卸应用**等，会在主人的手机上弹一张批准卡，要等他点。`capability_list` 里这类词带 `needs_approval`。
- 看屏幕和点屏幕还要主人先借出真实屏幕（屏幕租约），没借时会被拒绝或先问他。

调用要批准时，你会立刻拿到 `status: waiting_owner` 和一个 `pending_id`。这时：

1. **告诉用户**：手机上有一张批准卡等他点，说清楚是什么事。
2. **不要原地反复查**。主人答了之后，用 `capability_call {"member": "service:gate", "word": "pending.get", "body": {"id": "<pending_id>"}}` 看他的回答（`state`、`answer`）。
3. 答的是同意：用 `pending.redeem` 执行（`capability_call {"member":"service:gate","word":"pending.redeem","body":{"id":"<pending_id>"}}`）。答的是拒绝或不再需要：不要硬做，换办法或停下告诉用户。执行前先想一想事情是不是还需要做。
4. 同一件事被拒绝后，别换个说法再问一遍。

## 出错了怎么办

- `ash-device is not running`：这台电脑上的 Ash 程序没开，让用户启动它（它是个后台服务）。
- `not connected to Ash`：ash-device 在，但没连上中枢（网络、中转站或还没配对），让用户检查，不要自己重试很多遍。
- `forbidden` / `not_found`：词或成员不存在、或不允许，回 `capability_list` 看现在真正能用的。
- 一次调用的结果说「结果不明（result_unknown）」或连接中途断了：先查状态再决定要不要重做，尤其是发消息、点按钮这类动作，别盲目重放。
