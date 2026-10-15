# 团队应用 R1

负责任务书 §3；涉及 MOBILE-ARCH §1.1–1.4、§2.1–2.6、§3.1–3.6、§4.1–4.3、§5.4–5.6、§6.1–6.2、§7.2、§11.1。

应用 id `team`，入口 `ai.ash.sysapps.team.TeamActivity`。公共注册由底座维护。

首屏先成员、再团队往来。成员显示角色、声明的模型、真实状态、正在处理的请求、等待谁、今天已记录的美元花费；未计价另说，尚未读取不显示零。主 agent 第一。成员详情只看其发出或收到的往来，包含角色 / 模型 / 工具和接口、启停、配置、记忆与日志。

往来以请求账本 id 为 key，显示「谁 → 谁、委托 / 告知、内容 → 回答」。长文默认折叠；原文通过 history.read / blobs.read 分页读取。可向前翻页。主人的 say 和主 agent 给主人的 say 不在团队时间线；点名使用 service:agents/ask，保持后台分线，回答关联到请求而非主对话。spawn 的回答也在原委托下面。

记忆严格对应 user 模块实际载入的共享 USER.md / MEMORY.md，明确这是共享记忆；没有 user 模块时不把主 agent 记忆冒充帮手自己的记忆。日志使用 history.query 的 speaker 筛选，轮次详情使用 history.turn。

新建需名字、角色、模型，模型从 runtimes / runtime.catalog 选择。配置使用 agents/update，启停建立删除使用现有词。agent.changed 带 by；轮次和用量使用已有事件。收到事件合并刷新，不轮询、不引入修订号或锁。

状态归 Activity 的纯 Model 与每个来源 Read。失败保留快照，同源最多一个读取在途，换目标丢弃旧结果。刷新不重建输入栏。成员 key 是 agent id，往来 / 日志 key 是消息 id。KeyedRows 增量列表保首个可见 key / offset。

点名与编辑草稿按目标分开，持续保存于 UiDrafts；发送中保留内容，成功才清空相同草稿。失败 / 结果未知保留且明确提示，不自动重发。中枢已有请求和回执是发送事实，不复制业务存储。Insets / 返回 / 生命周期订阅由 SystemAppActivity 负责；离页停监听，恢复重读。

旧外壳没有独立团队管理页面，原以 agent id 打开的帮手主页改向团队成员详情。Ash / 设备旧页由各自 worker 清理，避免争写。

验证覆盖问答关联、主对话隔离、成员筛选、分页、长文引用、变更作者和今日成本。JVM 覆盖乱序 / 失败不清空、状态、稳定身份与 blob 定位。真机键盘、200% 字体、TalkBack、窗口恢复本轮未操作手机验证。

## 交付验证

- 中枢：`node --import tsx --test` 定向执行 agents 的 service / flow / team、history 的 history / exchanges、cost、SDK words，共 71 项通过。
- `tsc --noEmit -p .` 通过。
- Android：`compileDebugKotlin`、`testDebugUnitTest --tests 'ai.ash.sysapps.team.*' --tests ai.ash.human.HumanSendTest --tests ai.ash.ui.ChatStateTest` 通过（24 项 JVM）。
- 独立底座依赖：`68655210`；异步 send.result / client_id 端口：`a1714cd9`。应用注册和 Manifest 由底座批次统一登记；此应用不改公共注册表。
- 未打包、未安装、未推送、未操作手机。键盘、200% 字体、TalkBack、预测返回和真实窗口恢复未做真机验证。
- 补充 human/team 通道回归 1 项通过：帮手回答延迟时先返回持久回执，同 `client_id` 再确认只投递一次，其他调用不受阻，后续回答经 sync 挂回原委托。定向中枢覆盖合计 72 项。
