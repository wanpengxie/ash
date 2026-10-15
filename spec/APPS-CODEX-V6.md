# Codex 冻结稿原生施工

依据频道 `spec/app-design/SPEC.md`（含第8节）、`v6/BUILD-MAP.md` 与当前 `v6/release`，承接此前已验收的数据流；设计样例只在远端电脑测试夹具里出现。

## 用户路径与真实数据

- 现在：所选电脑的 `x.codex.sessions`、`x.codex.approvals`，再读一个正在运行/等待的会话和一个最近的历史会话。现有字段不足以可靠汇总所有电脑，故明确写当前电脑范围；选择电脑在原选项内。没有成功取得审批集合时，不写没有需要你的决定。
- 本次决定：实际 `device/thread/request_id` 完整绑定，调用 `x.codex.approve` 的 `approve` 或 `deny`，不会借本次许可改成 `approve_session`。显示原请求说明；没有请求时间/副作用字段就不编。
- 电脑上的工作：实际电脑、项目、会话标题/状态与 Codex 原消息。仅 `state=running` 展示暂停/停下后接手；后者说明只请求停当前轮，不声称转交 IDE。停止回执只写请求已提交；下一次真实非 running 快照才解除等待，不据此判断目标达成。
- 工作结果：实际最后一轮 file item 原文、原 agent 汇报与 turn.status。空闲不等于已结束；没有独立检查成绩或完整差异就直说未取得。模型汇报中的“通过”不会变成 UI 独立核验结论。原记录保留，可继续发送到同一 thread；工具行可查看本次返回原文，未宣称完整远端历史都已取得。
- 会话：保留原电脑/项目分组、打开旧会话、从原项目新建工作。修正新工作请求误带 SDK 未定义 `client_id` 的严格 schema 问题；`x.codex.send` 原 client_id 与精确核销不变。

## 输入与生命周期

一个持久 EditText 在现有 KeyboardDeck 中，正文列表与结果列表切换不替换它。草稿仍按电脑+会话/新项目保存，先写原 ChatOutbox 后发送，旧回执仅更新原操作。发送回执不等于 transcript；只有同电脑、同会话、同 client_id 的 user item 才核销。同电脑其他工作的账本操作不被标成当前工作的操作人。

onStart/onStop 仍由原 LedgerFeed 注册/注销完整账本消息；不抢主聊天页，读取词不触发自身无限刷新。增加实际设备 `codex.turn_ended` 与 `codex.approval_pending` 事件的刷新识别。保留原 Anchor / FollowEnd 实现；没有复活已撤销的9ba绘制屏障。详情回原目的地，根列表按原键/偏移恢复。

## 本轮提交与验证

- `e708fb3e` 公共可选身份、根/详情标题、稳定目的地和动作槽。
- `d013fbb5` 状态槽按当前字体预留两行且至少48dp；短状态→动作显隐→断线/恢复不挤内容和输入。指定 SystemAppChromeTest 当时3/3通过。
- `5b80be54` 公共底栏标签按图标居中，新增实际 TextView gravity 断言，后续与 Codex 一并复验。
- `1928c377` 本应用原生结构与原数据接线；`e2ace707` 只修远端夹具 Kotlin JSONObject 空值重载歧义；`3b3ab726` 收紧当前工作的操作归因。

第一轮唯一 Android 命令生产 Kotlin 编译通过，测试编译因夹具 `put(null)` 失败退出，未执行本轮用例。日志 `/data/atoll/tmp/sysapps-base-codex-v6.log`。修复后等待总控给下一个串行时段；不得把源码就绪或编译通过当产品验收通过。

定向范围为 SystemAppChromeTest 3、CodexActivityAcceptanceTest 7、CodexEvidenceTest 2（以实际 XML 为准）。包含原同文双来源/精确核销、未知明确重试、两电脑草稿/迟到回执、实际 InputConnection composing/选区/窗口焦点、严格阅读键+offset、停止边界；新增实际 360×800 窗口现在/结果/平静图与编辑、one-shot 决定和 stop 回执等待真实状态。

截图预定 `/data/atoll/tmp/codex-v6-native/codex-home.png`、`codex-detail.png`、`codex-quiet.png`，尚未生成前不算证据，生成后须按原始分辨率实际打开对照。远端电脑/模型应答可控，未接主人真实手机、中文 IME 或真实已登录 Codex；本轮未新跑真实中枢全链场景，历史场景证据见 APPS-CODEX-ACCEPTANCE.md，不冒称已在新布局重跑。未打包、安装、推送或合主线。
