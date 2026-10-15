# 团队应用 R1

负责任务书 §3；涉及 MOBILE-ARCH §1.1–1.4、§2.1–2.6、§3.1–3.6、§4.1–4.3、§5.4–5.6、§6.1–6.2、§7.2、§11.1。

应用 id `team`，入口 `ai.ash.sysapps.team.TeamActivity`。公共注册由底座维护。

首屏以委托与回复为工作区。顶部只有一块紧凑概览，概述实际在工作 / 等待谁的成员，并提供成员快捷入口；完整成员列表另开。等待回复的委托优先，答复挂在原委托下面，可继续问同一成员。成员详情显示工作、角色、配置模型、花费与相关往来；启停 / 修改配置直接可用，重启 / 记忆 / 日志保留在更多操作。工具与接口清单放进高级配置。

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


## 产品整改（10-16，验证进行中）

- 路径一：打开团队 → 首屏直接看到「整理这次应用验收结果，先检查团队入口复用」及负责的资料帮手、等待回复；不会先排完十位成员卡片。
- 路径二：点名交代 → 明确提交中枢的回执 → 回复挂回委托 → 点继续问 → 仍发给资料帮手；另一端同时收到同一条回答。
- 数据来自实际 agents service / manager / inbox / history 与两个真实 human-channel 端点，只有模型驱动被确定性脚本替代。`team-session.json` 是该场景服务返回的快照，Activity/View 回归直接载入它，不另造页面状态。
- 修前证据：真实 Activity 的 A → 新 Intent B 仍停在 A（expected agent:b, actual agent:a）；工具 read 改 write 后 driver allowed 仍为 read；改名后能力目录仍为旧名。新增回归已分别复现。
- 配置语义：工具、完整角色或模块更改会受控重启；原运行轮先被切断并返回结果未知，不在旧执行过程中热换授权。停止的成员只保存配置，下次启动使用。支持热配置的纯模型更改仍遵从运行时的下一轮配置机制。成员重命名不改变执行 id，目录同时更新。
- Android/View 修后验证待统一测试依赖与串行构建时段；当前没有以编译或 Model 测试冒充产品验收。
