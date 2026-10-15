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

未操作手机，未打包、安装、推送或合主线。中文输入组合态、IME/预测返回、主题重建、200% 字体、TalkBack 和真实设备配对尚未真机验证。诊断展示中转站、连接路径、连接数及接口 findings；现有 link 接口不提供真实设备往返延迟，本实现不把中枢调用耗时冒充设备 RTT。
