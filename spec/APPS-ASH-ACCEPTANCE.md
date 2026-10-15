# Ash 应用产品整改证据（10-16）

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
