# 任务应用：第一期待办与第二期主线

依据 APPS-R1-BRIEF §5 和追加节、ARCH-APPS、MOBILE-ARCH。涉及 MOBILE-ARCH §1.1–1.4、§2.1–2.4、§3.2–3.6、§5.4–5.5、§6.2、§7.2、§13.1。

## 一期：已经实现的边界

唯一业务状态在中枢 `service:tasks`，与账本共用 SQLite 连接。原生 `ai.ash.sysapps.tasks.TasksActivity` 通过底座调用同一组词；Ash 应用不另建待办库。

`subject` 表示谁的事情：`owner` / `ash`。`assignee` 表示谁负责：`person:owner` / 实际 agent id。两者分开：Ash 自己的事可以交给帮手；主人的事情也可以交给 Ash。任务应用的「Ash 自己的事」与 Ash 应用的自我主线待办均读取 `subject:ash`；首页谁在推进、谁卡住按实际 assignee 展示，主人的事也可以由帮手承办。主 agent 由 service:agents 的 primary 发现，不把具体身份写进协议。

### 词和状态

| 词 | 输入 / 输出 |
|---|---|
| add | title 必填；note、subject、assignee、due_at、remind_at/remind_in、source:{message}、client_id 可选。返回 {task,created}。同调用者同 client_id 重试返回原待办；换内容则 conflict。 |
| update | id 加要改的字段，后写生效。时间 null/空文本清除；status 可重开。返回 {task}。 |
| done | id、可选 result。重复完成无额外汇报。返回 {task}。 |
| list | status=open（默认）/closed/all，subject、assignee、thread、limit（最多500）、before 可选。返回 {tasks,next_before?}，cursor 按稳定记录序号定位，不用易重复的时间戳。 |
| get | id，返回 {task,changes}；changes 按时间记录 by/change。 |
| task.changed | {id,change,by,task}，由服务发出并记账；界面按事件合并重读。 |

Task 字段：id/title/note/subject/assignee/status/due_at/remind_at/source/thread/result/created_by/created_at/updated_by/updated_at/done_at。

沿现有 taskInfo 可扩展字段返回 `task.delivery`：`saved:true` 表示 SQLite 已保存；`reminders:ready|pending|none` 表示提醒已安排、尚未安排或没有待安排时间；`conversation:ready|pending` 表示确认/结果卡已送达或仍待投递。Clock 或对话失败不能把已经保存的 add/update/done 返回成“未保存失败”。调用方看到 pending 要说清哪些部分尚未生效；结果未知时仍沿用原 client_id 核对。

手机先持久化 client_id 和请求体再发出；agent 规则要求每个逻辑待办固定 client_id。未提供 id 的 agent 调用仅在同一 caller.turn、同一参数内去重，跨轮同来源可以合法再建，不做基于内容的永久猜重。状态为 todo/doing/waiting/done/dropped。`thread` 仅保留可空关联，**没有实现任何二期主线存储或自动提炼**。

时间传 Unix 毫秒或 ISO 文本；无时区文本按中枢时区，纯日期为当日结束。原生编辑器使用系统日期/时间选择器和快捷项，明确显示本机时区，转换为 Unix 毫秒后提交，避免中枢在另一时区时误读。remind_at 是提醒时刻，due_at 是截止时刻，互不冒充。

### 捕获、提醒、恢复

- agent 的规则明确要求：主人说要办的事、要求提醒、Ash 作出承诺，当场 add；必须成功后才说记下。不把同一件事另设第二份 clock timer。自然语言理解由 agent 承担；验收替换为固定脚本，不声称单测证明了真实模型永远正确捕获。
- add 的确认卡在任务持久化后发出，有内容和提醒时间，可原地修改或取消。来源默认从本轮 turn.started 的输入消息中找到主人的那条；也可明确给 source.message。
- 原生首屏支持填写标题并在旁边直接选提醒时间，同一次 add 记下，默认不设提醒；负责人、状态、结果等完整字段在详细设置。它不会把句子里没有确认的自然时间猜成一个闹钟。
- 时钟全部使用 service:clock。到 remind_at，主人负责的待办给提醒卡；agent 负责的待办唤醒那个 agent 的 back lane，带完整任务和来源。
- 截止后仍未完成，只跟进一次：主人的事情在下一个本地 09:00 且至少相隔一小时后问完成/改期/不做；agent 的事情在截止后一小时唤醒跟进（避免提醒与跟进同时发生）。改期意味着用户明确设置了新的截止时间，才会有新一次跟进。普通编辑不重新催。
- 任务、待投递卡、提醒/跟进标记同事务保存。每张卡有稳定 id，崩溃后重复 show 的 conflict 视为已投递；状态变化后的原卡刷新也持久化，短暂失败后补上。
- 一个已建立的 clock 每分钟维护任务负责恢复时钟与失败投递。首次启动若 Clock 不可用且维护闹钟尚未建立，不承诺自动恢复：列表和确认卡显示「已保存，提醒尚未安排，请点重试提醒；此前不能保证到点提醒」，按钮沿既有 update{id} 重新对账，不增加词或新后台框架。这是中枢的持久工作，应用界面不轮询；应用关闭不影响提醒。它不会每分钟生成新提醒卡。
- 旧闹钟送达时核对当前时间和待办状态；取消、完成、改期后旧闹钟不再生效。重启时补齐尚未到达的提醒，错过的只补一次。
- 有来源的待办关闭时（包含主人关切但交给帮手承办的事），结果卡 reply_to 原来源消息，并在原确认卡显示当前结果。做不了时用 note/result 解释原因，不伪造完成；任何 agent 声称完成/放弃必须给 result，等待必须给 note；这项责任要求不取决于 subject，缺失则接口拒绝。后台唤醒在服务故障时可能重送；实际执行仍须核对待办当前状态，外部副作用沿各自接口的幂等规则。
- 系统任务卡只允许更改它自身的 service:tasks/update、done，主人点击保留真实 human 身份，经原路由与关卡。不是任意卡可以借主人身份调用中枢；普通 app 卡仍沿原授权机制。
- 提醒卡显式带 kind:due，沿用现有安静时间与通知交付策略；账本中的提醒卡始终可查，通知不是唯一入口。

### 原生界面

首屏顶部「需要补上」始终显示提醒/对话待恢复的事项，即使时间在下周也可立即重试。其余分区先回答“今天轮到谁”：今天轮到你的到期/逾期事项、Ash 卡在哪里（直接写原因）、Ash 正在推进、Ash 负责但还未开始。用实际 assignee 和状态解释工作进度，不把 subject 当执行者。未定时间的个人事项放「待我处理」，subject:ash 单独叫「Ash 自己的事」。

常用操作直接在任务行：完成、改期（系统选时/快捷项）、给 agent 负责的事写一句结果、回来源对话跟进。无需重新填一张总表；完整字段移到「详细设置」。任务行用已有 Flow 换行承载按钮和现有 token，保留 KeyedRowsAdapter 稳定 id、失败快照、请求代次与阅读位置。

详细设置里的时间为原生选择器，负责人为明确单选列表，取消不会轮换负责人。无时间新增、改负责人、把状态记成在做都不发 wake。界面写明只更新记录、有提醒时间到点才通知，不把记名说成已交办或已开工。若以后增加「交办」，最小方案是一个用户明确点击的动作，向已选 agent 发包含 task id 的委托并记录是否接收；接收前仍为待做。本期未实现该动作，也没有自动派单系统。

原生快速添加可直接选提醒；想用一句话安排提醒，引导在对话告诉 Ash，不做本地假时间理解。成功确认明确列出记下的标题、未设置提醒/已安排时间/尚未安排，不被随后的列表刷新覆盖。未知结果重试冻结的原 body；期间另改标题或提醒时间时，两者一起保留为新草稿，旧请求回执只确认旧任务。配置重建保快照，onNewIntent 每次解析新 arg、保存的草稿按 task id 隔离、旧读写回执不抢新路由。
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

自动：TypeScript 编译；任务服务（存储重启、重复提交、时间、一次提醒/跟进、改期/完成屏蔽旧闹钟、投递恢复、共享 Ash 责任及结果）；真实中枢固定脚本三条端到端；原生 compileDebugKotlin、TasksModel JVM 单测；卡调用身份反例；SDK 契约 lint 与架构导入规则。

固定脚本位于 packages/core/test/scenarios/tasks.test.ts：

1. 主人说「提醒我周四晚上交材料」→ 固定 driver 调 add → 自动捕获来源并显示确认卡 → 主人原地修改 → 假时钟到点发提醒卡 → 主人在卡上完成。
2. Ash 承诺核对材料 → subject:ash 在共享 list 中可见 → 完成带结果 → 来源对话中有结果卡，closed 查询可查。
3. 服务已成功但手机随后断线 → 重连后使用同一 client_id 核对 → 重复完成仍仅一次变更和来源结果。

未验证（MOBILE-ARCH §8.1）：真实 IME/选词和焦点、旋转/分屏/进程被系统杀死后的窗口行为、预测返回、通知系统限制、200% 字体/RTL/TalkBack、真机帧耗时。未操作手机、未打包/安装/推送。注册表和来源消息导航由底座作者单独提交，集成时必须一起引入；编译通过不等同于真机通过。

实际验证命令（临时文件均放仓库外的指定临时目录）：

- `./node_modules/.bin/tsc --noEmit -p .`
- `node --import tsx tools/gen-words.mjs --check`
- `node --import tsx --test packages/sdk/test/words-lint.test.ts packages/core/test/services/tasks/tasks.test.ts packages/core/test/arch/imports.test.ts packages/core/test/edges/link-server/human/runtime.test.ts`
- `node --import tsx --test packages/core/test/scenarios/tasks.test.ts`
- android 下使用既有 SDK/JDK 21 环境：`./gradlew :app:compileDebugKotlin :app:testDebugUnitTest --tests ai.ash.sysapps.tasks.TasksModelTest`

底座集成依赖：68655210（共享 Activity），28deec0e（公共 schema strictRequired 修复）；来源导航随 fd127750 的 HomeActivity 变更交付，五应用注册在 f345ee34（需所有应用类已集成后使用）。任务分支只引入前两条公共提交，未复制其他应用。


## 2026-10-16 产品复审：用户路径与证据

| 用户目的 / 路径 | 真实数据流 | 修复前失败证据 | 修复后证据 |
|---|---|---|---|
| 快速记提醒，不必先记无时间事项再进总表 | 标题 + 直接选明天 → 持久化 client_id/body → add 同时带 remind_at → 回执反馈 → 列表重读 | 原版只提交标题且提示“点待办可选提醒”，但整行没有该入口；成功提示随后被重读覆盖 | 新真实 View 用例检查选明天后的 add 参数、未设提醒/已安排/尚未安排三种反馈；未知重试保持原请求且保留新标题与时间。最终运行结果见交付报告 |
| 同一个任务窗口从第一件事打开第二件，再返回未发草稿 | Activity.onNewIntent → 新路由代次 → 保留 task-id 草稿 → 丢弃旧回执 | 真实 Robolectric Activity 的 reusedActivityOpensNewTaskAndKeepsPreviousDraft 在旧版断言 selected 为 two 失败，仍为 one | TasksActivityProductTest 的热路由、草稿及迟到读写回执用例；最终运行结果见交付报告 |
| 改负责人、选时间，不读总表 | 单选列表 / DatePickerDialog / TimePickerDialog → 固定数值参数 → service:tasks/update | 旧 Activity 的时间选择用例发现 EditText；负责人用例点击按钮后直接从主人轮换成 agent | View 用例直接操作原生选择器与单选列表，核对送出的数字时间及 subject/assignee/status；最终运行结果见交付报告 |
| 一眼看到今天轮到自己、Ash 在推进什么、卡在哪里 | service:tasks/list 同一快照 → 实际负责人分组 → 真实列表行和按钮 → done/update | 旧首屏仅有状态列表、只能打开全字段表单；不能证明今天轮到谁，也没有直接完成/改期操作 | View 用例用“今天交报税材料 / Ash 正在比较跑鞋价格 / 等待收货地址”真实文案检查分区、原因和行按钮请求；最终运行结果见交付报告 |
| 已保存但 Clock 出错，不再误判保存失败 | 真实 Router → TasksService SQLite → 故障 Clock/list 或 set → 返回已保存与 pending | router.test.ts 在旧版明确收到 unavailable，尽管 list 已有记录；重试捕获能新增重复条目 | 同一真实 Router+Clock 用例检查 saved/pending、稳定身份、推进真实维护闹钟自动恢复并收到提醒 |
| 首次启动还没有维护闹钟 | 真实 Router/Clock 故障 → 已保存与明确未安排警示 → 点击既有 update{id} → Clock 恢复 → 到点发出 | 旧版返回失败，且没有可见重试或已保存状态 | first boot 用例覆盖 list/set 两种故障，检查确认卡的警示与重试按钮，恢复后实际提醒到达 |
| 主人的事情由帮手负责，结果仍要交代 | subject:owner + assignee:agent:helper → helper done(result) → 来源结果卡 | 旧版允许 helper 空 result 完成且不回来源；真实 Router 责任用例先失败 | 同例拒绝空结果、接受实际结果并检查 reply_to；无时间新增及修改责任/状态均不产生 wake |
| 对话交代 → 可改确认 → 改期 → 旧时间不响 → 新时间提醒 → 完成结果回原话 | 真实 human channel、Router、任务服务、Clock、卡片 runtime 与 history | 原验收只证明部分阶段，缺少改期旧时刻和重连重复确认 | scenarios/tasks.test.ts 完整路径通过；真实旧时间 fence 到达时确认无旧提醒，新时刻提醒可完成，结果 reply_to 原来源 |
| 服务已成功但手机随后断线 | 同一服务 client_id → 新 human 连接重试 → 原 task id；done 再确认 → 一次结果记录 | 原来 Clock 故障时已存却返回失败，容易诱发另建；原脚本未覆盖断线后再确认 | scenarios/tasks.test.ts 新增断连/重连/重复完成用例，检查仅一个 task、一个 done 变化和一张来源结果卡 |

修复前日志保存在施工临时目录，分别为 tasks-review-before-views.log（3 个真实 Activity 反例）、tasks-review-before-router.log（2 个真实 Router 反例）、tasks-review-before-responsibility.log（责任反例）。不把编译、纯 Model 测试或静态代码审查当这些产品路径的通过证据。

真实 IME、预测返回手势、OEM 通知限制、字体/无障碍的真机交互仍未验证；本次不操作手机、不安装、不打包、不推送、不合主线。真实 View 的验证基于统一 bd76b539 测试依赖，按总控安排串行运行。产品截图由标准 NATIVE graphics 绘制 Activity 实际 decor 和附着的 RecyclerView 行，不拼接背景图或脱屏组件。
