# 团队应用：原委托、原回答与原成员

本轮按 app-design SPEC（含 §8）、v6 BUILD-MAP 与 STEP2 校正稿实现。应用 id 为 `team`，原生入口 `ai.ash.sysapps.team.TeamActivity`。公共注册由总控集成，不在业务分支另建。

## 三个稳定空间

- **现在**：先显示实际 Exchange 返回的最近原回答，再显示成员手上的事、真实等待与费用；关系另进二级。没有原交付时显示空态；成员状态缺失写未知，不推为空闲。不生成审批卡、阶段、核验或假产物链接。
- **往来**：按原 Exchange 展示谁问谁、原状态与原回答，保留分页、原文与 blob 读取。主对话不混入此处。
- **成员**：真实名字、角色、工作与原币种费用。招人、角色/模型/工具、启停/重启、记忆与日志可达，管理留在二级。

根页由共享 AppIdentity/AppDestination 提供标识与底栏，不显示返回 Ash 的箭头。原成员详情返回进入前的空间与阅读锚点。路由仍用原 Activity、增量 KeyedRows 与事件读取，不建立新的导航或消息后台。

## 原回答详情和追问

详情保留原成员身份、原 Exchange、完整已取得的回答及原始往来入口。回答标明来自帮手，不能当独立核验或现实目标完成。实际文件/链接缺失时只给原文；history/blob 读取失败留原内容和原因。

追问使用原有 `service:agents/ask {agent,text}`、`wait:false`、`client_id`。文本附原委托 id/摘要，界面继续显示原 Exchange；没有 `thread` 参数，也不声称后端已将新回答持久串入原线程。结果未知继续使用原编号确认，绝不换帮手或新编号自动重派。

未发草稿按成员保留；待发请求保留原目标、正文、引用和 client_id。旧读取、晚回执不清掉另一成员的新稿。输入保持同一 EditText，位于既有 KeyboardDeck 内，键盘仍用 translation。配置表单草稿、保存后的就绪提示与受控重启影响继续可见。

费用保留 `US$` 和未计价次数；未取得费用不编零。成员记忆只展示实际载入的共享记忆，没有 user 模块时明确说明，不冒充成员私有记忆。

## 本轮可复核证据

- 真实 agents service/manager/inbox/history + 两个 human-channel 客户端，只有模型驱动用确定性脚本：一次投递、先回执、原回答跨端可见、原成员追问携原委托引用；执行中换工具受控重启、原请求结果未知。该 Node 回归 **1/1 通过**，TypeScript 检查通过。
- `team-session.json` 来自该服务测试实际返回，包括 quiet/during/answered/continued 与真实 answerEvent。Activity 监听此事件后必须产生新的 list/exchanges 请求，才向回调喂入最新快照，不能靠复用旧回调伪造刷新。
- 首轮真实 MotionEvent 点交付标题没有打开详情，原因是卡内可选文字吞掉父级点击。`749b69ed` 只关闭可点行内文字选择，阅读详情全文仍可选择；没有把测试改为直接调用回调。
- 复验标准单命令 `testDebugUnitTest`，仅 TeamActivityAcceptanceTest / TeamModelTest / TeamSendTest，`--max-workers=1`：**22/22 通过**（9 Activity、9 Model、4 Send），含手机 360dp/mdpi 资源与实际布局、真实点击、草稿路由、成员身份、配置提示、焦点/选区、未知请求同编号确认及原空间阅读位置。日志文件 `team-v6-android-r2-20261016.log`。
- 已实际打开 `android/app/build/reports/team-acceptance/` 下 `v6-team-home.png`、`v6-team-detail.png`、`v6-team-quiet.png`、`v6-team-editing.png`。本轮四图生成于 2026-10-16 06:19（Asia/Singapore），为有效 360×800px/mdpi 窗口。

## 最后详情窄收口的验证边界

`33acebb9` 在上述 22/22 与四图之后：关系变成无底展开行，去掉重复的「继续问」，成员管理集中到顶栏更多；原角色、模型、启停、重启、记忆、日志全部仍在管理二级。测试改为直接真实触摸底部输入与发送，原成员/Exchange 引用、client_id、草稿及焦点断言保留。**此窄收口尚未重跑 Android；现有详情/编辑图是修前证据，最终集成需定向看更新图。**

实际真机 IME、系统返回手势、TalkBack、200% 字体、深色与后台恢复未验证。Robolectric 不证明这些行为。未打包、未安装、未推送、未合主线，产品最终验收由总控另做。

业务提交顺序：`d8171187` → `ab4cffec` → `749b69ed` → `33acebb9`。
本轮依赖副本须排除：`05f0b9b2`（e708fb3e）、`54512efe`（d013fbb5）、`690b1cbd`（5b80be54）。
