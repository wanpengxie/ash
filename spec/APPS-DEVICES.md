# 设备应用交付

对应 APPS-R1 §1；涉及 MOBILE-ARCH §1.4、§2.1–2.4、§3.1–3.4、§3.6、§5.1–5.6、§6.1–6.5、§11.1–11.2。

入口类：`ai.ash.sysapps.devices.DevicesActivity`，继承共用 `SystemAppActivity`。公共桌面注册和 Manifest 由底座作者统一提交；本任务不另写注册表。

`EXTRA_ARG` 可为空（设备列表）、`d/device:<id>`、`p/<pair_id>`、`connect`，也接受 JSON `{device}` / `{pair_id}` / `{page:"connect"}`。实体只按设备 ID 匹配，不按名字猜设备。历史 `ash://device/...` 链接转到设备应用，不再打开外壳设备页。

## 页面与状态

- 首屏是稳定 key 的 RecyclerView：中转站、待批准请求、手机及在线设备、版本与能力、可展开的已撤销设备。版本和能力不会被单行副标题截掉。
- 详情是固定表单：名称、访问范围、升级、连接诊断、撤销/恢复及最后变更者。名称草稿按设备保存在本地 UI 草稿存储，磁盘读取走 UiIo；账本刷新不重建表单、不盖掉输入。保存旧名称的回执不会清掉后来输入的新稿。
- 名称保存、访问范围、升级、撤销各有处理中/错误提示。未知结果不自动重发；刷新核对后由用户决定重试。跨重建的未确认操作留下提示。
- 配对在同一屏完成：安装命令 → 请求名称和访问范围 → 批准/拒绝 → 等连接/完成。只订阅 `pair.changed` 后读权威状态，不轮询。每秒仅在本地更新剩余时间。
- 安装命令含一次性密钥，仅留当前内存；不进 Bundle、Preferences、日志。配对页设置截屏保护，重建只恢复 ID，再经 `pair_status` / `pair_code` 取回仍有效命令。复制经手机的 `clipboard.set` 词。
- 状态读取按来源合并在途事件；失败保留上次快照，并区分各来源错误。重连和重新可见重读。详情读一页相关账本记录补最近变更，历史记录不会盖过更新事件。
- 列表保存稳定 key/offset；名称草稿、路由、配对 ID、未确认状态和配对访问选项可恢复。订阅和本地倒计时随 STARTED 生命周期停止。
- 已删 `HmHands` / `HmDevice` / `HmConnect` 及首页旧设备卡；手机体检、浏览器、已装应用入口保留。

## 验证

- Android：`compileDebugKotlin`；`testDebugUnitTest` 定向运行 `DevicesModelTest`、`LedgerMessagesTest`、`McpHostTest`。
- Model 覆盖排序/撤销筛选、版本/能力文案、失败保留、旧读取丢弃、事件刷新、按设备记录变更者、配对全过程与结束态、未知结果、只按 ID 恢复配对和迟到命令、历史变更不覆盖新事件。
- TypeScript：`tsc --noEmit -p .`。
- 中枢定向回归：devices 与 link-control，共 43 项。

未操作手机，未打包、安装、推送或合主线。中文输入组合态、IME/预测返回、主题重建、200% 字体、TalkBack 和真实设备配对尚未真机验证。诊断先展示结论和恢复步骤，原始 findings 默认折叠；RTT 使用既有心跳的同设备执行连接样本，附样本年龄，无样本明确未知，见 `DEVICE-LATENCY.md`。

## 产品路径整改与验收边界

- 新接入：首屏「让 Ash 用上你的设备」→ 接入电脑 → 生成命令并说明在电脑终端运行 → 同屏确认设备名与访问范围 → 批准 → 等上线 → 显示实际开放的能力并查看设备。命令生成、配对状态、审批分别调用既有 `service:devices/pair_start`、`pair_status`、`pair_approve`；上线后能力来自设备列表，未同步时明确说明。
- 恢复：首屏设备行显示离线及影响 → 查看如何恢复连接 → 详情顶部给出打开 Ash、检查网络、刷新等下一步 → 诊断结论与真实心跳样本。声明的能力与当前授权分开表达；版本只作辅助，不虚构自动升级保证。
- 已打开的设备 A 再收到 B / 配对请求：旧实现仅在 `build()` 读取 `EXTRA_ARG`，没有 `onNewIntent`，与公共 `SINGLE_TOP | CLEAR_TOP` 入口不相容。现按新 Intent 切换页面、更新 Activity Intent；名称草稿按设备隔离；旧页面的读取、审批回调不能覆盖新页面，旧危险确认框会关闭。
- 操作反馈：成功的权限响应立即更新实际 Switch；早于操作发出的列表结果不能把它翻回旧值。撤销需实际 AlertDialog 确认；恢复后说明还需在设备上打开 Ash。

`DevicesActivityAcceptanceTest` 使用真实 DevicesActivity、布局、RecyclerView、Switch、EditText、AlertDialog 与 Intent；只在既有 request 边界提供确定性中枢响应，生产 request 仍只调用共享中枢端口。测试不启动真实 LedgerFeed，不证明真实配对网络、Android 权限弹窗、系统输入法或 OEM 行为。

截至 `4aa442cc`，标准统一 Robolectric 配置下 Activity 10/10、Model 10/10 通过；`RobolectricResourcesTest` 在前一轮通过。人工查看发现首页截图只绘制标题栏、诊断截图未滚动到结论，不能把这批断言通过冒充完整产品验收。`470747bc` 增加真实动画帧等待、排除标题栏的截图内容检查、诊断区域滚动，并根据截图补充命令运行步骤和接通后的主操作，尚待总控串行复验。截图目录 `/data/atoll/tmp/devices-acceptance/`；必须人工看图，不以颜色数代替内容验收。

## 配对命令脱敏补充

配对命令结果（pair_start/pair_code）与 clipboard.set 的 text 使用既有 `x-ash-secret` 标记：仅账本保存 `{set,length}`，有调用权限的主人和 agent 都继续得到原命令。没有改成仅主人可见的 `sensitive`。SDK lint 允许结果中的 `secret:true`，仍拒绝其他标记值；手机的动态剪贴板声明与 SDK 标准声明一致。

两条真实 Router 回归覆盖：主人/agent 的命令返回、原对象不变、账本无命令；剪贴板执行只从 `ctx.raw` 得到原文，记录视图和账本均脱敏。Android 定向验证同时检查手机/SDK 两份剪贴板标记，防止只改标准声明而实际手机仍记录原文。

扩大 Android 能力契约检查发现既有 `anExtensionNamesItsOwnRisk` 固定快照只列 browser.show/run，当前已有 clear_logins 和 health.scale.setup/remove。本任务未修改这些扩展及其快照，定向检查未用该旧快照冒充全类通过。
