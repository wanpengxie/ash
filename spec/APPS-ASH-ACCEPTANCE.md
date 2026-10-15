# Ash 应用产品整改证据（10-16）

最新范围：按总控确认，已收敛送达机制。下文旧轮次的专用通知重试证据仅作施工历史，不再是产品要求或签收门槛；当前行为见文末「批注最小简化」。

涉及 MOBILE-ARCH §2.1–2.3、§3.1–3.4、§6.1–6.2、§11.1、§13.1–13.2。保留原交付，未提前实现二期主线。

## 她记错我 → 我纠正 → 看她是否改正并回应

用户路径：我对你的了解 → 具体的「会议周二」→ 修改 / 删除 / 批注。普通修改只编辑那一件事；全文与整页批注为高级入口。保存前读取完整最新文件，只改选中的事实。她刚添加的其他偏好保留，缺失、重复同文、截断文件不猜着覆盖。改正后，事实本身、通知状态和原批注上的实际回应都可见。

真实数据流：Activity 的 AshMemoryWriter → persona/memory.get → 原文件的单条修改 → persona/memory.set → persona/note → 主 agent back lane 的 owner_note → agent 的 MCP 调词读取对象 → diary.set / memory.set → note.reply 原 id → persona.changed → 界面重读。直接改正和纯批注均明确显示「已通知」或「已保存但尚未通知」；已通知仅表示唤醒已送达，不表示理解、执行或改正，结果以 note.reply 的原文为准。

修前证据：整改任务指出默认全文编辑负担过重；旧 a0916cb7 的 memory 行确实按文件全文展示，document 仅提供全文入口。真实中枢反例中，停止主 agent 后保存批注 told:false，启动后用同 id 重试，旧服务仍固定 told:false，断言 false !== true（真实 startHub/human link，非 Model）。

修后证据：ash-app.test.ts 的真实中枢脚本已通过会议纠正链：读到「会议周二」→ USER.md 与当天日记改为「会议周三」，咖啡偏好保留 → note.reply 仍关联 meeting-correction → 账本出现来自主 agent 的 memory/diary/notes 三个变更事件。停 agent → 同 id 首次未通知 → 启动后重试成功 → 再次重试不重复记录/唤醒，也已通过。

实际 Activity/View 点击中，单条修改→保留编辑后新增的另一事实→未通知提示→重试同 id→实际 reply 提示通过；删除仅移除选中事实通过。生产写入工作流四例也通过。第一次截图准备脚本使用了错误工作目录，测试结束后才修正导出代码，因此不能把这轮测试说成已有截图。已改为标准 Robolectric Native Graphics 下直接对实际 decorView.draw(Canvas(bitmap))，等集成树复验。

## 看她接下的事 → 进展 / 受阻 / 结果

用户路径：首页同一份 subject:ash 待办 → 某件事的详情 → 「已经记下，还没开始」「正在推进」「卡在这里」「事情的结果」。原因读 note，完成结果读 result。缺内容如实说未记录；不把待做说成正在做，不从规则或代码编成果。详情可打开任务应用的同一个 id，来源和完整操作留在那里。

实际数据流：tasks/list {subject:ash,status:all} → 选择现有 task id → tasks/get → 显示 status/note/result → SystemApps.intent(tasks,{subject:ash,id}) → 返回后由共用连接回调重读。

修前证据：原路径只用混合 message/items 的 AlertDialog，缺乏明确进展/受阻/结果详情。本次点击测试已进入等待确认会议时间的详情并看到具体原因；点击打开任务应用后在叶子树失败，因为该树尚未引入统一系统应用注册，实际退到了 Web 应用入口。该失败归类为「缺集成依赖，联动待验」，没有用 mock 跳转或 null 兜底隐藏。

修后状态：该用例包含对真实原生目标 TasksActivity 与同一 task id 的断言，以及返回后读取实际 result 的界面断言；需在已含五应用和正式注册的集成树运行后再判定通过。总控已接手此项。

## 她现在和成长为什么可信

现在以 history/current 的最近读取事实为准。无数据是未确认；断连、失败和过期快照带读取时间，明确说当前待确认；已结束 progress 不伪装进行中，thinking 只称正在处理消息。成长按 why/did/effect/next、记录时间和记录人显示。无效果写尚未记录，未附出处不冒充核实成果。

真实生产者回归已通过：主人通过真实 human channel 反馈重复提醒太多 → 实际 clock 定时产生 daily wake → 主 agent back lane 实际 pulse.set 把主动时段改为 10 点和 18 点 → 写日记与成长说明，证据关联主人消息和日记，效果明确尚未核实。再读取 pulse.get 验证设置确已变化。这个测试脚本固定 agent 的决定，路由、关卡、工作区、唤醒和读写均使用真实实现，不证明真实模型会自行作出同样判断。

## 已跑结果与边界

- 真实中枢单文件 3/3：会议纠正、未通知重试、日记/成长生产者。
- 首轮 Android 编译通过；公共资源检查 1/1，生产写入工作流 4/4，Model 7/7，Activity/View 4/5。
- 第五个 View 用例缺正式应用注册，联动待集成验收；Native 截图代码是在该轮后加入，尚未运行，不算已产出截图。
- 本轮全项目 TypeScript 检查限制 512 MiB 堆后耗尽内存，未完成；不标为通过。
- 未验证真机 IME/拼音、TalkBack、大字体、系统返回手势、进程回收和实际 TasksActivity 的完整前后台联动。未安装、打包、推送或操作手机。

## 集成树定向命令与截图

在 android 目录，以标准单次 Gradle、--max-workers=1 运行 RobolectricResourcesTest、AshActivityTest、AshMemoryWriterTest、AshModelTest。先在集成树满足统一注册依赖，不修改业务以适应缺失注册的叶子树。

设置 ASH_ACCEPTANCE_ARTIFACTS 为允许的临时输出目录，AshActivityTest 可导出 memory-before-correction.png、memory-corrected-and-answered.png、promise-blocked.png、promise-result.png。这些是代表性 fixture 的实际 View 绘制，不是真机或真实账户截图，也不证明真实模型的自主理解。

## 集成首轮反馈后的产品修正

总控反馈集成树已通过 17/17、原生 TasksActivity 同任务联动和结果回读；四张 Native 图片也已打开检查。该轮图片发现动作按钮笼统叫「查看」、高级全文入口抢占首屏，以及 mdpi 下 1080dp 宽视口不代表手机。

本轮改动：任务操作直接显示「批注 / 纠正」「打开任务」「完成这件事」，不再在动作标题下面放一个含糊的「查看」。重试通知、修改约定、撤销和刷新也显示实际动作。所有具体记忆与纠正回应在前，全文高级入口移到记忆页末尾。继续使用现有 AshUi / AshTokens。

截图测试明确 w360dp-h800dp-xxhdpi；布局由 360×800dp 乘实际 density 得到 1080×2400px，同时断言 density=3、实际 metrics=1080×2400、配置=360×800dp。保留 Native Graphics、真实 decor 挂窗和图片非空检查。补充实际 View 点击：读进展、批注都不调用 done，只有「完成这件事」才对同一任务调用一次 done；手机页面需要时先滚动再点击。

本轮仅通过资源 XML 解析和 git diff --check；按串行构建安排没有启动 Gradle。新增点击断言与修正后的手机截图均待集成复验，不能沿用上一轮图片作为手机效果证据。

## 手机首屏补验入口

总控反馈 e3c9489b 在完整注册集成树实际通过 18/18，已打开四张 360dp 手机图，记忆纠正到关联回应、承诺受阻到结果两条路径本轮定向通过；这不代表整应用或真实 IME 验收通过。

首屏另增真实 Activity 用例 AshActivityTest.homeShowsCurrentWorkAndTheSharedPromisesOnAPhone，截图 ash-home-now-and-promises.png。沿用同一 TestActivity 和数据端口：history/current 返回正在整理下周行程，service:tasks/list 返回 subject:ash 的进行中和等待确认两件承诺；额外 owner 待办不应出现。不新增展示 Model 或业务状态。测试断言实际手机 View 中现在、进行中承诺与等待确认承诺均在首屏可见，并断言读取参数 subject:ash/status:all、没有 done 调用。仍是代表性 fixture 的实际 Activity 绘制，不冒充实际账户当前工作或真实模型自动行为。

保持统一 360×800dp / xxhdpi、Native Graphics 和截图非空检查。此次只增测试入口和文档，未启动 Gradle；入口与首屏图待下一时段运行。非阻断打磨记录：独立动作卡留白较多，后续可收紧，当前不因此变更框架。


## 批注最小简化

功能收敛，不改样式。服务移除 persona_note_delivery 的建表与读写；旧表原地不删。新批注先入 persona_notes，再尝试一次普通 owner_note 唤醒；唤醒失败不推翻保存结果，不补发。已有 id 校验内容和来源后只返回 id，不重建批注、不重复唤醒。原 note.reply 和对象关联保持。

Activity 删除 retryNotice、lastNoteId、跨页送达追踪及持久 notice-status/notice-payload/last-note-id 读写，删除专用通知重试按钮与送达文案；不清旧偏好，不新增兼容或迁移。普通编辑草稿、operation id 保留。反馈分别说记忆是否已保存、批注是否已保存；未知结果保留草稿，不把已通知当作已理解。回应直接读取原批注的实际 reply。

删去专用送达重试验收，保留真实服务的会议纠正→记忆/日记→原批注回应；主 agent 不可用时也要保存批注，同 id 只防重复保存。View 回归改验保存反馈与实际回应，补充失败/未知的普通草稿保留，以及记忆已保存但批注失败/未知时分别反馈。Android 用例只改未跑，等待统一时段；本轮不启动 Gradle。

本轮实际结果：persona 相关轻量服务测试 7/7，真实中枢两条定向用例 2/2（会议纠正及原批注回应；主 agent 停止时保存成功且同 id 不重复保存）。资源 XML 解析与 diff 检查通过。Android 编译、更新后的 Views 与截图未执行，不能沿用此前通过数声称此提交已全部通过。


## 当前v6原生View交付（冻结STEP2施工）

业务按当前SPEC第8节、BUILD-MAP及正常/详情/平静/地图施工，不从history/examples引后台需求。正常页含真实current/最近确认、最多两条subject:ash共享承诺和具名负责人/原状态、具体记忆；平静态由实际成功的空承诺集合产生，全部承诺入口仍在。不把todo/普通waiting当正在执行或需要人的决定，不造计数或心理。人格/约定、原批注、日记、成长和完整记忆文件编辑在稳定可达的二级空间保留。

已在本叶子执行唯一授权单命令 --max-workers=1：AshActivityTest的8项独立Views + AshMemoryWriterTest + AshModelTest。Gradle EXIT0（31s）；实际XML Views8/8、Writer4/4、Model7/7，共19/19。生产与测试Kotlin编译通过。共享承诺真实原生跳转项 aSharedPromiseOpensTheSameNativeTaskWithoutCompletingItAndReturnsToTheSameSpace 未在缺统一注册的叶子跑；留完整注册集成树验同id、返回原空间和空入口，未用假注册/Web回退代替。

本次实际Window尺寸1080×2400px=360×800dp、xxhdpi，标准Robolectric Native Graphics；同TestLink接通真实公共连接生命周期，业务端口为具名fixture，服务真实性沿此前真实中枢链，不能以fixture证明真实模型自主理解。已导出并实际打开四张PNG：ash-home.png、ash-detail.png、ash-quiet.png、ash-detail-saved.png（位于外部ASH_ACCEPTANCE_ARTIFACTS）。正文、具名帮手/待做、具体事实、未附原依据、原文件动作、输入框、实际关联reply均可见，非空背景截图。

实际交互通过：读取完整原文件；纠正一条并保留新增/其他偏好；保存后无回复明确未见新回应；实际note.reply关联同批注；删除仅一条；失败/未知保普通草稿和operation id；返回/onNewIntent/切主空间恢复原草稿，账本刷新保EditText实例及选择区。没有新增送达表/专用重试/新队列。单条patch仍由原AshMemoryWriter执行。

逐图对照后，仅补三项本业务明确偏稿：保存主按钮改满328dp，事实正文按冻结稿22/30/500，次动作按14/21/400与现有text2。另引入base的底栏居中公共补丁5b80be54。此三项业务修正及公共居中发生在本轮命令结束后，**修后未跑/当前四图仍是修前证据**，由总控最后集成统一复验并重出图；未自行第二跑。不因测试绿声称产品最终通过。

边界：真实TasksActivity同对象联动、上述三项修后图/回归待集成；真实IME/预测返回/TalkBack/200%字体/dark/真实设备生命周期未验。表单沿公共非会话WindowInsetsOwner，未改KeyboardDeck/发送焦点/持久队列。旧版日记/人格批准/规则等后台实现未改；保存人格版本仍不等于当前策略即时生效。未合主线/推送/打包/安装或操作手机。
