# 设备应用交付

对应 APPS-R1 §1；涉及 MOBILE-ARCH §1.4、§2.1–2.4、§3.1–3.4、§3.6、§5.1–5.6、§6.1–6.5、§11.1–11.2。

入口类：`ai.ash.sysapps.devices.DevicesActivity`，继承共用 `SystemAppActivity`。公共桌面注册和 Manifest 由底座作者统一提交；本任务不另写注册表。

`EXTRA_ARG` 可为空（设备列表）、`d/device:<id>`、`p/<pair_id>`、`connect`，也接受 JSON `{device}` / `{pair_id}` / `{page:"connect"}`。实体只按设备 ID 匹配，不按名字猜设备。历史 `ash://device/...` 链接转到设备应用，不再打开外壳设备页。

## 页面与状态

- 首屏是稳定 key 的 RecyclerView：中转站、待批准请求、手机及在线设备、版本与能力、可展开的已撤销设备。版本和能力不会被单行副标题截掉。
- 详情先展示状态、对 Ash 能力的影响和恢复行动；改名、访问范围、版本、升级及撤销放在可展开的设备设置中。本地帮手和完全放开审批再收进高级选项，已开启时折叠入口会提示。名称草稿按设备保存在本地 UI 草稿存储，磁盘读取走 UiIo；账本刷新不重建表单、不盖掉输入。保存旧名称的回执不会清掉后来输入的新稿。
- 名称保存、访问范围、升级、撤销各有处理中/错误提示。未知结果不自动重发；刷新核对后由用户决定重试。跨重建的未确认操作留下提示。
- 配对在同一屏完成：安装命令 → 请求名称和访问范围 → 批准/拒绝 → 等连接/完成。只订阅 `pair.changed` 后读权威状态，不轮询。每秒仅在本地更新剩余时间。
- 安装命令含一次性密钥，仅留当前内存；不进 Bundle、Preferences、日志。配对页设置截屏保护，重建只恢复 ID，再经 `pair_status` / `pair_code` 取回仍有效命令。复制经手机的 `clipboard.set` 词。
- 状态读取按来源合并在途事件；失败保留上次快照，并区分各来源错误。重连和重新可见重读。详情读一页相关账本记录补最近变更，历史记录不会盖过更新事件。
- 列表保存稳定 key/offset；名称草稿、路由、配对 ID、未确认状态和配对访问选项可恢复。订阅和本地倒计时随 STARTED 生命周期停止。
- 已删 `HmHands` / `HmDevice` / `HmConnect` 及首页旧设备卡；手机体检、浏览器、已装应用入口保留。

## 验证

- Android：前期编译与 `DevicesModelTest`、`LedgerMessagesTest`、`McpHostTest` 通过；最终集成的真实 View 验证见下节。
- Model 覆盖排序/撤销筛选、版本/能力文案、失败保留、旧读取丢弃、事件刷新、按设备记录变更者、配对全过程与结束态、未知结果、只按 ID 恢复配对和迟到命令、历史变更不覆盖新事件。
- 初次集成 TypeScript：`tsc --noEmit -p .` 通过。
- 中枢定向回归：devices 与 link-control，共 43 项。
- 独立 RTT 修改：五项新增可控测试与现有 silence/protocol/link-control，共 45 项通过；详见 `DEVICE-LATENCY.md`。

未操作手机，未打包、安装、推送或合主线。中文输入组合态、IME/预测返回、主题重建、200% 字体、TalkBack 和真实设备配对尚未真机验证。诊断先展示结论和恢复步骤，原始 findings 默认折叠；RTT 使用既有心跳的同设备执行连接样本，附样本年龄，无样本明确未知，见 `DEVICE-LATENCY.md`。

## 产品路径整改与验收边界

- 新接入：首屏「让 Ash 用上你的设备」→ 接入电脑 → 生成命令并说明在电脑终端运行 → 同屏确认设备名与访问范围 → 批准 → 等上线 → 显示实际开放的能力并查看设备。命令生成、配对状态、审批分别调用既有 `service:devices/pair_start`、`pair_status`、`pair_approve`；上线后能力来自设备列表，未同步时明确说明。
- 恢复：首屏设备行显示离线及影响 → 查看如何恢复连接 → 详情顶部给出打开 Ash、检查网络、刷新等下一步 → 诊断结论与真实心跳样本。声明的能力与当前授权分开表达；版本只作辅助，不虚构自动升级保证。
- 已打开的设备 A 再收到 B / 配对请求：旧实现仅在 `build()` 读取 `EXTRA_ARG`，没有 `onNewIntent`，与公共 `SINGLE_TOP | CLEAR_TOP` 入口不相容。现按新 Intent 切换页面、更新 Activity Intent；名称草稿按设备隔离；旧页面的读取、审批回调不能覆盖新页面，旧危险确认框会关闭。
- 操作反馈：成功的权限响应立即更新实际 Switch；早于操作发出的列表结果不能把它翻回旧值。撤销需实际 AlertDialog 确认；恢复后说明还需在设备上打开 Ash。

`DevicesActivityAcceptanceTest` 使用真实 DevicesActivity、布局、RecyclerView、Switch、EditText、AlertDialog 与 Intent；只在既有 request 边界提供确定性中枢响应，生产 request 仍只调用共享中枢端口。测试不启动真实 LedgerFeed，不证明真实配对网络、Android 权限弹窗、系统输入法或 OEM 行为。

最终集成验收：总控集成共享按钮布局修复与 `96003037` 后，设备 Activity 11/11、Model 10/10 全过，并人工核对首页、离线恢复、配对三阶段、失败诊断与 RTT 图。连接失败不再同时声称可操作；旧的 online 读取不能抹掉较新的失败，后续被接受的当前设备新读取或成功诊断可恢复页面声明，不改写设备的 online 事实。`808e18ed` 去除重复恢复步骤后，总控再运行该条真实 View 回归，EXIT 0，并人工确认新版诊断图保留次级指标和原文入口。

本轮通过的产品路径：接入、授权、在线能力、离线恢复、撤销/恢复、诊断。截图包括 `devices-home.png`、`devices-offline-row.png`、`offline-recovery.png`、`pairing-install-command.png`、`pairing-confirm-abilities.png`、`pairing-connected.png`、`diagnosis-conclusion.png`、`measured-device-latency.png`。它们由真实 Activity/View 以确定性端口回执绘制；配对命令和 RTT 数值为验收数据，未执行真实跨设备安装、配对或网络性能基准。系统权限、IME、OEM 行为与真实设备安装不属于本轮已验证范围。未重新运行全量测试矩阵。

## 最终任务提交链

以下为本任务业务与验收提交，按分支顺序列出；不应直接合并含公共底座副本的整条分支：

- 前置事件与 Model：`b299f871`、`e403fa19`。
- 原生页面、旧入口清理、草稿和回执、命令脱敏：`f47ecc32`、`60ff019d`、`a0a19ce3`。
- warm open 与旧回调隔离：`2495d8cb`。
- 独立连接层 RTT（单独复审的业务提交）：`6095e8f5`。
- 接入/恢复产品路径与真实 Activity 验收：`0264a4c6`、`4aa442cc`、`470747bc`、`194fe95e`（阶段记录）、`ef7cf4eb`、`cac26b7c`。
- 诊断一致性、读取新鲜度与断言修正：`01f133c0`、`570f898a`、`96003037`。
- 诊断文案视觉去重：`808e18ed`。

排除的公共依赖副本：`b073fdab`（底座 `68655210`）、`6c01c204`（公共 schema 修复 `28deec0e`）、`bbaeb13e`（统一 View 测试配置 `bd76b539`）。公共注册表、Manifest、共享按钮布局由总控使用公共作者提交统一集成，不属于设备应用的独立提交链。

## 配对命令脱敏补充

配对命令结果（pair_start/pair_code）与 clipboard.set 的 text 使用既有 `x-ash-secret` 标记：仅账本保存 `{set,length}`，有调用权限的主人和 agent 都继续得到原命令。没有改成仅主人可见的 `sensitive`。SDK lint 允许结果中的 `secret:true`，仍拒绝其他标记值；手机的动态剪贴板声明与 SDK 标准声明一致。

两条真实 Router 回归覆盖：主人/agent 的命令返回、原对象不变、账本无命令；剪贴板执行只从 `ctx.raw` 得到原文，记录视图和账本均脱敏。Android 定向验证同时检查手机/SDK 两份剪贴板标记，防止只改标准声明而实际手机仍记录原文。

扩大 Android 能力契约检查发现既有 `anExtensionNamesItsOwnRisk` 固定快照只列 browser.show/run，当前已有 clear_logins 和 health.scale.setup/remove。本任务未修改这些扩展及其快照，定向检查未用该旧快照冒充全类通过。
