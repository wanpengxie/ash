# 任务应用：第一期待办与第二期主线

依据 APPS-R1-BRIEF §5 和追加节、ARCH-APPS、MOBILE-ARCH。涉及 MOBILE-ARCH §1.1–1.4、§2.1–2.4、§3.2–3.6、§5.4–5.5、§6.2、§7.2、§13.1。

## 一期：已经实现的边界

唯一业务状态在中枢 `service:tasks`，与账本共用 SQLite 连接。原生 `ai.ash.sysapps.tasks.TasksActivity` 通过底座调用同一组词；Ash 应用不另建待办库。

`subject` 表示谁的事情：`owner` / `ash`。`assignee` 表示谁负责：`person:owner` / 实际 agent id。两者分开：Ash 自己的事可以交给帮手；主人的事情也可以交给 Ash。任务应用的「Ash 在做」与 Ash 应用的待办均读取 `subject:ash`。主 agent 由 service:agents 的 primary 发现，不把具体身份写进协议。

### 词和状态

| 词 | 输入 / 输出 |
|---|---|
| add | title 必填；note、subject、assignee、due_at、remind_at/remind_in、source:{message}、client_id 可选。返回 {task,created}。同调用者同 client_id 重试返回原待办；换内容则 conflict。 |
| update | id 加要改的字段，后写生效。时间 null/空文本清除；status 可重开。返回 {task}。 |
| done | id、可选 result。重复完成无额外汇报。返回 {task}。 |
| list | status=open（默认）/closed/all，subject、assignee、thread、limit（最多500）、before 可选。返回 {tasks,next_before?}，cursor 按稳定记录序号定位，不用易重复的时间戳。 |
| get | id，返回 {task,changes}；changes 按时间记录 by/change。 |
| task.changed | {id,change,by,task}，由服务发出并记账；界面按事件合并重读。 |

Task 字段：id/title/note/subject/assignee/status/due_at/remind_at/source/thread/result/created_by/created_at/updated_by/updated_at/done_at。状态为 todo/doing/waiting/done/dropped。`thread` 仅保留可空关联，**没有实现任何二期主线存储或自动提炼**。

时间传 Unix 毫秒或 ISO 文本；无时区文本按中枢时区，纯日期为当日结束。原生编辑器明确显示本机时区，转换为 Unix 毫秒后提交，避免中枢在另一时区时误读。remind_at 是提醒时刻，due_at 是截止时刻，互不冒充。

### 捕获、提醒、恢复

- agent 的规则明确要求：主人说要办的事、要求提醒、Ash 作出承诺，当场 add；必须成功后才说记下。不把同一件事另设第二份 clock timer。自然语言理解由 agent 承担；验收替换为固定脚本，不声称单测证明了真实模型永远正确捕获。
- add 的确认卡在任务持久化后发出，有内容和提醒时间，可原地修改或取消。来源默认从本轮 turn.started 的输入消息中找到主人的那条；也可明确给 source.message。
- 原生首屏支持一句话作为内容快速添加，然后点详情设置时间、负责人、状态、结果。它不会把句子里没有确认的自然时间猜成一个闹钟。
- 时钟全部使用 service:clock。到 remind_at，主人负责的待办给提醒卡；agent 负责的待办唤醒那个 agent 的 back lane，带完整任务和来源。
- 截止后仍未完成，只跟进一次：主人的事情在下一个本地 09:00 且至少相隔一小时后问完成/改期/不做；agent 的事情在截止后一小时唤醒跟进（避免提醒与跟进同时发生）。改期意味着用户明确设置了新的截止时间，才会有新一次跟进。普通编辑不重新催。
- 任务、待投递卡、提醒/跟进标记同事务保存。每张卡有稳定 id，崩溃后重复 show 的 conflict 视为已投递；状态变化后的原卡刷新也持久化，短暂失败后补上。
- 一个 clock 的每分钟维护任务负责恢复时钟与失败投递。这是中枢的持久工作，应用界面不轮询；应用关闭不影响提醒。它不会每分钟生成新提醒卡。
- 旧闹钟送达时核对当前时间和待办状态；取消、完成、改期后旧闹钟不再生效。重启时补齐尚未到达的提醒，错过的只补一次。
- Ash/帮手做完或明确放弃自己的待办，结果卡 reply_to 原来源消息，并在原确认卡显示当前结果。做不了时用 note/result 解释原因，不伪造完成；agent 完成/放弃自己的事必须给 result，等待必须给 note，缺失则接口拒绝。后台唤醒在服务故障时可能重送；实际执行仍须核对待办当前状态，外部副作用沿各自接口的幂等规则。
- 系统任务卡只允许更改它自身的 service:tasks/update、done，主人点击保留真实 human 身份，经原路由与关卡。不是任意卡可以借主人身份调用中枢；普通 app 卡仍沿原授权机制。
- 提醒卡显式带 kind:due，沿用现有安静时间与通知交付策略；账本中的提醒卡始终可查，通知不是唯一入口。

### 原生界面

首屏：今天（含逾期）、等你的（负责人是主人）、Ash 在做、全部、完成/不做了。列表用现有 KeyedRowsAdapter、稳定 task id 和不可变 Model。失败保留上次列表；读响应有代次，事件合并，离页不刷新；本地列表刷新保存 key/offset，若用户已另行滚动则不强行恢复旧位置。

详情是少量静态表单，不因后台事件拆掉编辑框。可改内容、补充、责任人、所属视角、截止/提醒、状态、结果；远端改动提示是谁改的，本地编辑优先。负责人选择用服务实际列出的 agents。来源按钮走桌面已有聊天消息导航。

本地 drafts/tasks.json 仅保存未发编辑和添加请求身份：有界磁盘队列原子写；先存 client_id/冻结请求体再 add。失败/未知结果保留文字，同一请求手动再试不另造任务。回执只清理自己那版文字，发送期间新输入保留。配置重建保上次成功 Model，进程重建从持久草稿恢复。

## 二期：只设计，不施工

主线是 Ash 理解用户和用户理解 Ash 的共同骨架。不会用任务看板替代它，也不把待办降为附属品；待办继续有完整入口，可不挂主线独立存在。

主线仍由任务这套接口管理，`subject:owner|ash`；另有 title、understanding、origin（explicit/inferred）、evidence（对话/记忆/反馈/技能与应用变化的引用）、state（suggested/active/quiet/archived/rejected）、created/updated by/at。不复制记忆文本，引用原记录；修正理解时保留来由。这里的字段是候选设计，不提前加入一期数据库。

- 主人侧：「为什么你在乎、现在到了哪、相关记忆/事件、具体待办、Ash 正在做什么」。
- Ash 侧：「我为什么开始、我做了什么、效果怎样、接下来做什么」。使用第一人称白话；代码、规则和日志只放在可展开的证据里。
- 显式事情可以当场记成待办或主线；推断出来的关注点先作建议，给出证据，让主人确认/改名/合并/否决。否决保留为整理依据，不在没有新依据时再次提出同一建议。
- 合并主线时待办保持自己的 id，只变更关联；不能因此重新触发提醒。归档/沉底也不取消尚未完成的明确待办，需要明确决定。
- 每日整理是 agent 经词完成的低频工作：只依据授权可读材料，更新主线理解和证据，不自动把推断变成对外承诺；明确承诺仍进入一期可靠待办机制。
- 两个应用展示同一数据的不同 subject。Ash 应用首屏将来是她现在在做什么与几条主线；身份/记忆/日记/约定仍可访问。
- 二期开工条件：一期固定验收通过，并经过主人实际使用。先用人工创建/修改主线验证解释是否易懂，再接自动提炼，不预先造复杂评分、并发修订或独立调度器。

## 验收记录

自动：TypeScript 编译；任务服务（存储重启、重复提交、时间、一次提醒/跟进、改期/完成屏蔽旧闹钟、投递恢复、共享 Ash 责任及结果）；真实中枢固定脚本两条端到端；原生 compileDebugKotlin、TasksModel JVM 单测；卡调用身份反例；SDK 契约 lint 与架构导入规则。

固定脚本位于 packages/core/test/scenarios/tasks.test.ts：

1. 主人说「提醒我周四晚上交材料」→ 固定 driver 调 add → 自动捕获来源并显示确认卡 → 主人原地修改 → 假时钟到点发提醒卡 → 主人在卡上完成。
2. Ash 承诺核对材料 → subject:ash 在共享 list 中可见 → 完成带结果 → 来源对话中有结果卡，closed 查询可查。

未验证（MOBILE-ARCH §8.1）：真实 IME/选词和焦点、旋转/分屏/进程被系统杀死后的窗口行为、预测返回、通知系统限制、200% 字体/RTL/TalkBack、真机帧耗时。未操作手机、未打包/安装/推送。注册表和来源消息导航由底座作者单独提交，集成时必须一起引入；编译通过不等同于真机通过。

实际验证命令（临时文件均放仓库外的指定临时目录）：

- `./node_modules/.bin/tsc --noEmit -p .`
- `node --import tsx tools/gen-words.mjs --check`
- `node --import tsx --test packages/sdk/test/words-lint.test.ts packages/core/test/services/tasks/tasks.test.ts packages/core/test/arch/imports.test.ts packages/core/test/edges/link-server/human/runtime.test.ts`
- `node --import tsx --test packages/core/test/scenarios/tasks.test.ts`
- android 下使用既有 SDK/JDK 21 环境：`./gradlew :app:compileDebugKotlin :app:testDebugUnitTest --tests ai.ash.sysapps.tasks.TasksModelTest`

底座集成依赖：68655210（共享 Activity），28deec0e（公共 schema strictRequired 修复）；来源导航随 fd127750 的 HomeActivity 变更交付，五应用注册在 f345ee34（需所有应用类已集成后使用）。任务分支只引入前两条公共提交，未复制其他应用。
