# Ash 跨端协作实施与验收计划

2026-10-09 · 开发中。产品依据：[v0.6](CROSS-END-PRODUCT-DESIGN-V2.md)；技术依据：[v0.2](CROSS-END-TECHNICAL-ARCHITECTURE.md)。本文件记录开发分工、可证明的进度和验收条件，不把计划当成已交付能力。

## 2026-10-11 执行修订

后续实施与已有界面审减均遵守[产品主稿第 0 节](CROSS-END-PRODUCT-DESIGN-V2.md#0-首要原则从最简单开始)和[Goal 执行约束](CROSS-END-GOAL-PRODUCT-SUPERVISION.md)：默认不加，先完成最简单的当前任务；新增需有明确实际需求。下文历史技术分工不是增加常驻控件或扩展设置系统的依据。完整首阶段功能与真实验收要求保留。

## 1. 目标、首期范围与完成定义

用户已授权按上述文档开启开发 Goal。GPT-6 Astra 负责拆解、协调、验收与进度；GPT-6.1 Sol medium 负责实现、测试与代码 review。根协调者统一分发，本文维护者不另外启动 agent。实现者在同一工作区协作，按下列文件所有权交接。

首期对象是一位用户、一部 Android Ash、一台 Mac、一个已安装的 Codex Desktop 实例。完整首期保留以下目标：

1. 手机发现授权范围内已有桌面会话，按需读取最近消息、上滑历史、缓存与离线提示。
2. 手机在用户指定的真实项目创建并关联新会话，或向选定的已有会话发送增量要求；运行中追加遵循桌面的原处理节奏。
3. 请求、原生会话、问题、材料和结果有稳定关联；能回答具体问题、补充材料并实际领取结果。
4. 请求重试、断线、连接器重启及回执丢失不导致错投、盲目重做或虚假成功。
5. 原桌面会话请求手机提供一份材料，手机人工提交后，原身份在后续轮次可领取；没有唤醒能力时明确等待领取。
6. 手机协作入口与连接助手具有可理解的范围选择、能力显示、配对与诊断；普通用户从零安装和发行验证作为独立发布门槛保留。

读取是可先验收的开发阶段，不是对整个目标的降级。外部控制未通过时可以交付可审阅的读取代码，但不能将开发 Goal 或首期闭环标记完成。无法满足的产品目标应报告其具体阻塞与可选决策，不能悄悄替换为 Ash 托管的新运行器。

首期不做全量历史云备份、后台实时订阅、逐字同步、自动个人记忆、视频业务状态机、自动模型分派、第二客户端或 Windows 的已支持承诺。第二系统/客户端与云作业适配器属于后续通用性验证。签名安装包、系统启动项和部署只准备可审阅产物；未授权提交、推送、发布部署或向真实业务会话发送测试消息。用户已授权的共享 daemon 测试、真实桌面重启及开发继续有效，不与发行部署混为一谈。

## 2. 已知事实与工作区边界

| 事实 | 开发约束 |
| --- | --- |
| 独立 `codex app-server` 已实测能列出当前桌面会话并分页读已保存消息 | 可作为只读数据源，必须去重、限制范围和请求大小；不推断未落盘内容 |
| 独立 App Server 对桌面活跃会话追加返回 `thread not found`；共享 daemon 显式 WebSocket 入口已接入当前桌面 | 不把独立历史进程当控制 owner；共享路线仍按下文分项门槛验收 |
| 桌面内部/外部跨连接追加曾成功；GUI run034927a7 现已确认同轮追加、历史 clientId 映射和桌面双标记 | C2 指定场景通过；手机链路、完整控制恢复与服务生命周期仍另验 |
| 独立历史源的 `notLoaded` / `interrupted` 与桌面活动不一致；共享服务只读观测已返回当前会话 active | 不将不同来源状态混用；现有读取适配器继续报告 unknown，共享状态须另附实例和观测来源 |
| 用户确认 itsallsame 已能指定项目新建且桌面可见 | 集成时核对调用契约和真实项目 ID；不重复研究该能力是否存在 |
| Core 已有 router、ledger、`client_id`、`reply_to` 和凭证来源检查 | 复用逻辑请求与回复账本；新增节点投递记录仅覆盖原生调用的恢复缺口 |
| `AgentHost` / `CodexSession` 管理 Ash 自己启动的执行进程 | 与 existing-desktop 使用不同 endpoint 标识；不预先重构或混用 |
| `package.json` 当前依赖 `ash-gateway` Git tag `v0.5.0` | 以实际依赖及其锁定代码为准；device README 的 sibling file 依赖描述已过时 |
| ClientLink 已补可信 `http.req.from`、pinned owner 与当前授权校验；I1 开发层独立审通过 | Core/UI 与实机完整授权链仍分别验收，不能以 I1 局部通过宣称 G-Identity 全部完成 |

开始时分支为 `coworker`，Android 集成屏幕相关文件、README、payload manifest 已有大量未提交变更。不得覆盖、还原或顺手格式化它们。尚未发现适用的 `AGENTS.md`；后续进入新目录仍需检查新增局部说明。所有测试产物与生成文件先核对差异归属，不借测试之名清理已有修改。

授权历史：开发曾因控制路线需要用户介入而暂停，隔离方案也曾仅获文档授权；这些是历史状态。用户随后已授权测试、共享 daemon 路线、真实桌面重启并确认继续验证，用户现已再次明确同意继续，开发已恢复。Goal 工具曾暂留 blocked，现根协调者 get_goal 已确认 active，并收到自动 continuation；继续沿原 Goal 开发，不新造 Goal，也不在完整目标达成前标记 complete。允许继续实现、测试、review 和验收，不需再次申请已经取得的授权。真实控制测试限已授权的独立模拟会话，不向当前业务会话投递测试消息。若后续实际需要新的登录、系统权限、安装部署或未选择的关键路线，先完成可审阅准备，再按具体缺项请求用户介入；不得把尚未通过 G-Control 当成禁止 WP-R、WP-I1/I2 或 fake journal 开发的理由。

## 3. 阶段与关键路径

```text
P0 控制入口研究 ───────────→ G-Control → P3 控制与持久投递 ─┐
P1 独立读取适配器 → P2 授权、通道与手机按需界面 ──────────┼→ P4 双向材料与结果闭环
既有 Core 账本审计 ────────→ 持久投递记录与协议契约 ───────┘
P4 → P5 故障与端到端验收 → P6 安装、升级及发行验收
```

| 阶段 | 输出 | 进入下一阶段的证据 |
| --- | --- | --- |
| P0 | 外部桌面控制入口、认证、回执、版本与能力报告 | 已选入口能由 Ash 外部节点调用，并逐项满足第 7 节验证；实验入口如实标版本限制，不能仅以内置工具成功放行 |
| P1 | 独立 Codex 读取适配器与假进程测试 | 白名单读取、范围限制、分页、脱敏及关闭验证通过 |
| P2 | 配置范围、可信身份、设备能力、Core 读接口、手机列表与详情 | 可从手机界面经完整授权链读取；离页停止、缓存隔离、无全历史泄漏 |
| P3 | 控制适配器、原生引用映射、目标节点持久投递记录 | 空闲发送、运行中追加、重复请求与崩溃窗口行为有可靠证据 |
| P4 | 分享启动、具体问题回复、限定材料及结果领取、反向请求 | 同一请求和 WorkRef 的双向小闭环；文件到达经摘要核对 |
| P5 | 集成测试、异常注入、独立 Sol review 与 Astra 验收 | 所有首期硬条件满足；已知限制与结果逐项列出 |
| P6 | 可审阅安装包方案、连接助手与发布验证材料 | 干净环境无 CLI 配对、能力检查、恢复、升级和撤权；签名/安装/部署待相应授权 |

P0 和 P1 可并行；P2 不必等待控制问题解决。P3 的 journal、已选原生接口适配及 fake 控制测试可提前做；公开真实发送仍须相应控制、授权与投递门槛，不能用代码完成解除 G-Control。P6 与业务协议独立准备；开发测试通过不等于普通用户发行验收通过。

## 4. 工作包、文件所有权与交接

每次只给一个实现者授予一个文件的写入权。表内“候选既有文件”先由执行者确认最小改动后回报，根协调者登记后才写。新增文件的命名可在首个实现前微调，一旦消费者接入则通过显式契约交接，不让两个实现者同时改共享 types。

### WP-R：独立读取适配器（开发层已验收）

**独占文件：** `packages/device/src/collaboration/types.ts`、`codex-read.ts`；`packages/device/test/codex-read.test.ts`；`packages/device/test/fixtures/codex-read-cli.mjs`。读取复用 `agents/process.ts` 的 `JsonProcess`，不改 `AgentHost`、`CodexSession`、`main.ts` 或 `link.ts`。

输出独立 `CodexReadAdapter` 和注入式 command/config。契约至少包含 endpoint、完整 WorkRef、原生会话/轮次/消息 ID、`observed_at`、分页游标与读取完整性。`cwd` 是源目录，不冒充真实项目 ID；未接项目元数据时 UI 标记目录分组。默认无范围配置拒绝读取；范围由连接器配置提供，不接受请求自行授予。直接 readWork 也须验证源会话属于范围，不能只在列表过滤。

调用白名单：`initialize`、`initialized`、`thread/list`、`thread/read`、`thread/turns/list`。禁止因读取触发 `thread/start`、`thread/resume`、任何 `turn/*` 写入、审批、动态工具或模型执行。传入 AbortSignal / 超时，清理连接和子进程；源错误脱敏。

列表按原生 ID 去重，游标视为 opaque，分页有界，防止重复游标死循环。历史返回用户输入、助手可见回复、可识别的材料引用，过滤 reasoning；同 ID 最近项在刷新时允许更新，不因 ID 已见就丢弃变化。没有可靠状态来源时输出运行状态 unknown，保留有来源的原始历史状态只供诊断。

验收：fake CLI 断言实际方法序列；跨页重复会话、重复/失效游标、无范围及越界直读、空白/损坏响应、消息更新、reasoning 排除、超时/退出/取消/关闭、错误脱敏。真实只读烟测仅记录版本、计数、稳定 ID 和采样一致性，默认不在日志输出正文。

### WP-C：控制入口研究（Sol，已分发）

只读检查已安装 Codex、已验证 itsallsame 新建路径、公开或随程序提供的本地接口及认证契约。交付方法/版本/权限/回执字段与证据；明确已验证、推断和失败边界。不得探测凭据绕过、写桌面数据库或复用其他程序的私有授权冒充接入。

研究结果必须回答：Ash 外部进程如何连接；目标 thread 如何定位到拥有者；空闲 send 与活动 steer 如何区分；原生回执是否带稳定消息/turn ID；调用后丢回执能否查询；停止和排队是否真支持。查不到合法入口时，报告具体需要的供应方接口或用户决策，并保持 G-Control 未通过。

### WP-I1：设备授权与读取通道（开发层已验收）

**独占新增：** `packages/device/src/collaboration/authorization.ts`、`capabilities.ts`、`read-service.ts` 及对应 test。**候选既有文件：** `packages/device/src/main.ts`、`link.ts`、`cli.ts`（只在配置解析确需时）；`packages/core/src/gateway/link.ts`（仅必要协议适配）与对应网关测试。不得改 WP-R 类型；需要扩展由 WP-R owner 或完成后的接任 owner 统一负责。

在 `main.ts` 的 browser/workspace 分发中增加明确的桌面读取分支；manifest 声明已核实的 read 能力，不宣称 send/steer/cancel。默认没有授权范围时保持不可读并给出设置状态。支持有版本的本地配置：endpoint 实例、允许项目/目录/会话范围、默认新建范围，读取与控制各自授权。范围修改后立即影响下一次读取，不能因缓存或连接仍在就继续访问旧范围。

保留并验证网关服务端附加的 `frame.from`，先核对 v0.5.0 的可信来源约定，再与有效配对 owner 身份匹配；缺失、错误或撤销身份一律拒绝。正文 `caller` 只是已认证 owner 通道代传的受限成员，不是身份证明。未来节点到节点独立身份在未实现前明确不支持，不能允许任意设备自称 owner。该校验及范围限制至少适用于新增协作入口；旧能力兼容性另测。

验收：假冒 caller、错误/missing from、撤销配对、未配置范围、相似目录前缀与同名项目、越界 thread 直读、请求取消、停机清理、manifest 不误报控制能力；既有 workspace/browser/managed-runtime 行为无回归。

### WP-I2：Core 只读边缘接口与手机按需界面（I1 后，同一 Sol 顺序实施）

**独占新增：** `packages/core/src/collaboration/read-service.ts`；`packages/core/ui/js/desktop-work.js`、`desktop-work-store.js` 及对应单元/浏览器测试。**候选既有文件：** `packages/core/src/server.ts`、`packages/core/ui/js/app.js`、`settings.js`、`net.js` 和页面样式/HTML 的最小挂载处。生成的 `packages/core/src/ui.ts` 由最终集成构建统一生成，不手工编辑；不改已有 Android 屏幕文件。

界面从已连接电脑进入执行端和授权范围，显示目录/项目来源、标题、最后同步时间、最近消息及加载旧页。缓存键必须包含当前授权主体/授权世代、node、endpoint、kind、native ID；切换身份或范围、撤权时清除不可见缓存。不得仅按裸 thread ID 或标题归并。

打开先读缓存再刷新列表；进入详情刷新最近页；页面可见且选中该会话时单次完成后延迟约 3–5 秒再查，失败退避，离页/后台/切目标 abort 并拒收旧响应。旧页滚动位置保留，新消息提示不强拉到底。同 ID 消息更新；源页缺项不直接判删除。离线和无缓存使用不同提示。

**Core 接口决策门槛：** 不得每几秒把完整桌面历史快照通过普通 `/api/send` 永久重复存入 ledger。优先增加专用有界只读路由，但须复用等价的已认证 screen/owner、设备访问和目标范围检查；不能绕过原规则直接执行任意 capability。只开放固定读取动作，拒绝通过方法字符串隧穿写操作。若实现者选择复用现有路由，先给出不会反复复制历史正文的证据。

缓存是有上限的读取副本；实现并记录容量/条数/保留期与清理行为，不承诺永久离线历史。UI 显示只读能力时禁用发送，且不自动换运行器或新会话。Core 只读接口测试、真实 DOM 浏览器测试覆盖身份变化、离页取消、同 ID 更新、页码边界、无缓存离线、滚动位置和能力提示。

### WP-J：节点持久投递记录（开发层已验收，真实控制核查未接入）

**独占新增：** `packages/device/src/collaboration/operation-store.ts`、`delivery.ts`、`control-types.ts`；`packages/device/test/collaboration-delivery.test.ts`。与 I1/I2 文件不重叠；落地前由 types owner 审核类型边界，协议通用部分不复制两份。

使用现有 Node SQLite 技术，目标节点单独保留原生调用事实。Core ledger 继续拥有原逻辑请求、`client_id`、`reply_to`；本包不再创建第二份手机消息账本。目标约束为 authenticated principal + operation_id 唯一，同时绑定 endpoint/WorkRef、规范化 payload hash、到期时间、attempt_id、connector_epoch 和原生回执。

最小状态为 recorded → invoking → accepted / rejected / unknown；accepted 必须明确 native/connector 接收层级。写 invoking 意图事务成功后才调用外部接口；崩溃恢复时 invoking 变为 unknown，只核查不自动重放。相同键同摘要返回已保存事实；相同键不同摘要返回 conflict。没有原生幂等/操作查询契约时不得宣称 exactly once。

保存 request 到 operation 到原生 turn/message 的映射，只有稳定返回关联能回收手机乐观消息；文本相同不能证明是同一发送。权限和过期在开始调用前重验；权限撤销后查询也受范围约束。日志不存正文和 Token，数据库保留策略与清理不得让仍未知的操作因记录消失而重新执行。

验收故障窗口：记录前、记录后未调用、调用开始后、原生接收后未保存、保存后未返回；每个窗口跨进程重开 SQLite 验证。加并发同键、不同摘要、过期、撤权、错误 endpoint、原生查询不可用、凭据脱敏和上限测试。mock 的原生成功不等于 G-Control 通过。

### WP-S：控制、新建与手机发送整合（代码可分包推进，真实能力开放仍受 G-Control / G-Delivery 约束）

**候选新增：** `packages/device/src/collaboration/codex-control.ts` 及测试；修改 I1 capability/dispatch 与 I2 UI 时先交接所有权。itsallsame 项目本身不在本包写入范围。

复用既有指定项目新建路径，提交时绑定真实 scope ID，不按同名或目录尾部猜项目；获得真实 WorkRef 才显示已创建。已有会话 send/steer 使用拥有该会话的已验证入口。默认追加不终止当前工具；不支持排队/停止就明确显示限制。失败不静默新建，不调用 ManagedRuntimeAdapter 替代。

本地消息 → 节点记录 → 原生接受 → 历史映射分层显示；调用结果未知只能待核查。手机只保存材料不产生执行操作。运行中追加与空闲新轮分别测试；原生工具正常结束、同一会话关联、最终采用增量要求由授权模拟场景证明。

### WP-A：问题、材料、结果与反向协作

具体接口、代码复用与独占分包见 [WP-A 材料与结果实施计划](CROSS-END-MATERIAL-IMPLEMENTATION-PLAN.md)。当前完成设计，代码未分发；包含手机 → existing Codex 与原会话 → 手机 → 跨轮领取两条闭环。

先复用 Core 既有请求、human-pending、附件和结果读取的可用契约，列出具体映射后由根协调者授予文件。新增只承担限定 asset 引用、版本/摘要、授权领取、返回请求关联，不引入 Mission 对象。

问题回复绑定问题 ID、版本、原 WorkRef 与有效期；历史出现问题不等于当前还能批准。文件有尺寸上限、内容摘要与接收端确认，电脑路径/URL 文本不能显示成已交付。反向原会话工具使用独立外部身份，不借 Core local owner token；结束一轮及重启后同一身份可以 get_result，另一身份不可以。

以一张合成图片或小文件完成闭环及故障测试。真实生产业务只在额外明确授权后验证；Ash 验收交接，业务验收留给源项目。

## 5. 硬性验收门槛

| 门槛 | 必须有的证据 | 不足以放行的证据 |
| --- | --- | --- |
| G-Read | 授权链列表与直读、分页去重、内容更新、只读调用序列 | CLI 能列出全机历史 |
| G-Identity | 网关认证身份来自传输、目标范围检查、撤权与冒充测试 | 正文写 `person:owner`；capability 标 `read` |
| G-Control | 已选共享路线的实例归属、GUI 发起对照、可靠原生关联、断线核查、兼容性与生命周期逐项验收（见第 7 节） | 桌面内部工具成功；独立 App Server 可读；单次外部 start/steer 成功 |
| G-Delivery | 持久操作与原生结果映射、关键崩溃窗口、未知不重放 | 内存 Map 去重；只有 `client_id` |
| G-UI | 真实浏览器检查按需刷新、离页取消、缓存来源、滚动和能力限制 | 纯数据 helper 单测或截图静态稿 |
| G-Asset | 获准接收方实际取得匹配摘要的文件、拒绝越权与版本变更 | 返回文件路径或模型说“上传成功” |
| G-Bidirectional | 原会话发起，手机回复，跨轮次领取同一 request | 结果只保存在手机或活跃 turn Promise |
| G-Release | 干净系统安装/配对/更新恢复，所宣称系统和版本分别验证 | 开发机 build 成功或现有用户配置可运行 |

硬条件：错会话投递为零；同一重传不自动启动第二次工作；未知不标成功；授权材料不跨连接领取；不存在/未到达文件不标交付。任何一个失败都阻止对应阶段验收，不能用“主路径正常”抵消。

## 6. 验证与 review 规则

每包提交给协调者的是未提交 diff、运行过的命令/结果、真实限制和复现说明。实现者运行有意义的针对性测试；另一 Sol 对关键授权、投递恢复和 UI 生命周期独立 review，修复后仅重跑受影响测试和必要回归。Astra 按本表验收，根协调者最终运行集成 typecheck/build 与受影响套件。测试若触及已有变更，先区分基线失败。

不在日志、协调消息或文档粘贴完整聊天正文、Token 或敏感本机路径。真实只读样本使用最小标识与计数；控制场景只使用单独获准模拟会话。所有 fake 结果与实机证据分开记录。

## 7. 当前进度与证据

以下状态以 2026-10-09 当前代码和已保存实测为准。产品 v0.5、技术 v0.2 与隔离方案开头保留了形成时的“研究 / 尚未授权”措辞；不能用这些历史措辞覆盖后续授权及执行记录。本计划第 2 节和下表记录现阶段状态，原始探针证据详见[隔离验证记录](CODEX-DAEMON-ISOLATION-PLAN.md)，开发快照见[首阶段开发记录](CROSS-END-DEVELOPMENT-STATUS.md)。本次阶段验收复用根协调者和独立 Sol 的已报告测试结果，并核对当前代码契约，不冒充重新运行过这些测试。

| 工作 | 状态 | 证据 / 下一步 |
| --- | --- | --- |
| 产品/技术目标与工作区边界 | 已验收 | 保留完整首期目标；已有 Android 等未提交修改归原工作所有 |
| 设备测试基线 | 已验收（仅基线） | 根协调者此前运行设备套件：29 tests，28 pass，0 fail，1 skip；不能记为新功能验收 |
| Core 相关测试基线 | 已验收（仅基线） | devices / gateway-start / agent-mcp：16/16 pass；既有 MCP 重启恢复不代替桌面控制回执 |
| WP-R 独立读取实现 | 已验收（开发层） | 根针对性 14/14 pass；collaboration_foundation_review 复审通过，包括退出清理、分页遍历世代、invalid cursor、材料引用、原生 clientId 和 128 条游标关系上限。material_refs 仅引用；真实端到端读取另验 |
| WP-C / A1 共享协议 | 已验收（限定预检） | 同捆 CLI 0.162.0-alpha.17.2；两个外部只读连接同一前台 Unix 服务成功；socket symlink / 实际 listener 归属与清理已核对 |
| A2 临时 daemon 启停 | 已验收（限定生命周期预检） | 临时 home 下 start/version/stop 通过，管理文件路径和清理已观测；不等于全系统写入审计或真实运行生命周期已完成 |
| B 桌面采用共享服务 | 待验收（核心归属已证实） | 显式 WebSocket 接入后 loaded 列表含当前业务会话，读取状态为 active；未用外部 resume 制造该业务会话归属；GUI 新发起对照及兼容性仍缺 |
| C 跨外部连接追加与桌面显示 | 待验收（协议主路径已证实） | 独立旧测试会话 start/steer 同 turn；25 秒工具正常结束、最终采纳追加，第二连接可读同轮，用户截图确认完成后桌面显示 |
| WP-I1 | 已验收（开发层） | owner：authorization_read_channel；实现者 42 tests；独立审 37 pass / 1 既有 skip / 0 fail、tsc pass，旧读取取消不误关新范围读取的独立 race probe 通过。固定 owner transport 当前性前后复核，必填 authorization_revision 绑定规范化实际范围，CLI UUID/wx/0600 临时文件及 finally 清理；未安装真实范围配置 |
| WP-I2-Core | 已验收（开发层） | owner：core_read_channel；独立审两项阻挡已闭合：最终 transportCurrent 等待中 screen 过期的原探针现为 403 且无 page；入口 browser auth 纳入同一总 deadline，35 ms 预算探针约 36 ms 单次 504、晚 auth 不触发 device call。48 定向回归及 tsc pass；固定来源、大小、前后授权、无普通 ledger/model 旁路已复审；实机仍未验收 |
| WP-I2-UI | 已验收（开发层） | owner：desktop_read_ui；独立审的 P1 范围隔离、分页缺口排序/inclusive 边界、send-error 停轮询和 source desc 仅由 UI 归一化均经独立 probe 闭合。7 store/controller tests pass；实施者最终真实 Chrome 3/3、build、tsc pass。缓存 24 小时/100 works/2 MiB；实际 Android/已配对 Mac 尚待整合验收 |
| 最终统一构建与整合测试 | 已验收（本地产物） | 根统一 typecheck、build:core 8.5 MiB、build:device 529.2 KiB 与 diff 检查通过；Core/UI 定向 20/20、device 定向 48/48 pass；两产物 SHA-256 已记录开发快照。统一生成 Core ui.ts 和 Android ash-ui/index.html，其余用户 Android 源码保留；未安装/替换实际服务 |
| T-C2 GUI 发起对照 | 已验收（指定研究场景） | 最终脚本 42 fake tests 及独立竞态复验通过；自动发起 8bf403a4 实机通过后，GUI run034927a7 的同轮唯一 clientId→item、唯一期待 sleep25 exit0、末条 final 双标记经固定历史核对；用户截图确认初始/追加/同 final、31 秒。原 exec handle 缺失、仅留 fsync intent 无终态 ack，未重发、不伪造即时回执/实时工具时间；尚非手机控制链 |
| 真实读取部署前置 | 等待外部条件（尚不操作） | 根只读核查已有 ai.ash.device 服务 running（当次 PID 2056）、current 为旧 0.1.0-local、内置 Node 22.22.1；已配对但 collaboration-read.json 缺失。新构建未安装，未重启服务/修改范围；C2 已独立完成；可继续不依赖真实配置的 WP-S 开发 |
| WP-J | 已验收（开发层） | owner：delivery_implementation；20 tests；R/J 独立复审合计 34/34 pass，额外 8×4 冷启动进程均成功且每轮 fake native 仅一次，unknown/expired/lock/fact 探针通过。WAL 有界 busy 重试、过期后仍可查已存事实、native 结束后写库失败只续存回执不重放已修。单 host/PID namespace、默认 10,000 永久键满则拒绝、unknown 不删除；未接真实原生核查 |
| WP-S | S1–S4 已验收（开发层）；S5 A/B/C 已独审，D/F 开发中 | device 实际入口/lifecycle 最终独审 67 项串行 + tsc、独立 pairing probes 通过；runtime 12 项及新增 lifecycle 回归通过；Core 48 项、持久 Chrome fake 全链 3 项独审通过。close/busy 阻挡已闭合，生产代码冻结，作者仅同步一条并行 disconnect fixture。未操作真实配置、手机或安装 |
| WP-A / P5 / P6 | WP-A 实施设计已整理，代码及其余验收未开始 | 材料双向、端到端和发行门槛分别保留；未宣称手机链路完成 |

状态词采用未开始、已分发、进行中、待验收、已验收、等待外部条件。按用户要求持续报告加权交付进度；百分比不是测试通过率、代码量或 token 消耗，也不能替代剩余门槛。

**当前整体约 57%（此前 56%）。**固定总权重为读取 20、控制 25、持久恢复 15、创建 10、材料双向 10、安装发行 20；当前分别计入 15、18、12、7、0、5，共 57/100，采用根协调者最新验收口径。当前创建增量来自实际Core接线与旧control回归独审放行，不按测试数或 token 折算。S4 gateway prefix 修复 124 项及 reconcile 34 项独审通过，最新受影响构建 Core 8.6 MiB / device 628.3 KiB；早期 8.5 MiB/529.2 KiB 属历史批次。真实端/C4–C6、S5 接线、WP-A 与普通用户安装发行尚未交付，Goal 保持 active。

| 当前包 | 实际 owner 与状态 | 仍保留边界 |
| --- | --- | --- |
| S5-A | create_contract；14 项独审 final 放行 | 纯创建契约，不是入口能力 |
| S5-B | create_journal；43 项独审 final 放行 | 创建阶段持久事实与恢复，不是生产接线 |
| S5-C | codex_create_adapter；30 项独审 final 放行 | 原生项目/创建 adapter 与 fake 协议，不是实际业务创建 |
| S5-D | create_authorization_service；45项独审放行 | 独立创建授权/服务，真实配置未设置 |
| S5-F | core_create_service；15项及9独立probe放行 | 纯服务已闭合最终权限窗口，不代表真实入口 |
| S5-E | create_device_wiring；独审放行 | 设备开发接线与fake回归，不代表安装/真机 |
| Core接线 | create_core_wiring；71项及24独立probe独审放行 | 实际Core路由已闭合falsy错误和presence即时失效；actualDevice链待补 |
| S5-G | desktop_create_ui；23unit/5Chrome及单调性独审放行 | Chrome DTO界面证据，actual创建全链待补 |
| WP-A | material_contract；A0原纯协议11项独审通过；Astra准备节点来源/问题及work_result契约修订，后续依赖待重新冻结 | 只限定材料、问题与结果通用交接；不迁移 Mission 内容业务 |

S4 开发层已全部通过；device lifecycle 的开发测试不等于真实 daemon 生命周期、实际 Android 链路或安装验收。后续按影响构建，不用已通过的测试数量替代未完成产品门槛。

### 已选择的共享路线与真实证据边界

当前安装版本的普通 `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` 分支被桌面自动附加的配置覆盖阻挡；重复设置此标志不能解决。用户已采用显式 `CODEX_APP_SERVER_WS_URL` 的 Unix WebSocket 路线连接真实 daemon。具体本机 URL、启动及恢复步骤保留在隔离验证记录，不把用户路径固化进产品代码。实际同捆 CLI 为 `0.162.0-alpha.17.2`，不能以另一个 Homebrew 版本的行为替代。此入口来自当前安装包实现，尚无公开稳定第三方接口承诺；适配需版本检测、能力降级和可恢复连接。

外部只读 loaded 列表已包含当前桌面会话，当前会话状态 active；这是业务会话的只读归属观测，没有对业务会话发送测试消息。随后两个外部客户端只在获准旧测试会话执行 start/steer：只观察到一次 turn/started、steer 回执指向同一 turn、约 25 秒等待工具正常退出、最终回复遵循追加；第二连接读取同轮历史成功，事件和历史原生 item ID 一致。用户截图确认完成后初始输入、追加和最终回复显示在桌面。执行记录为 `build/research/daemon-switch/steer-result.json`；这不是 Ash 手机实际调用链证据。

原生消息关联结论已纠正：输入字段为 `clientUserMessageId`，保存历史字段为 `userMessage.clientId`。初次探针只投影同名输入字段而误报缺关联；根协调者按当前 schema 只读复核同一真实测试轮，start 与 steer 的两个自有 ID 均准确回显为 clientId，并各自对应原生 item.id。C3 因此已有当前版本真实证据，WP-R 将其输出为 `source_client_message_id`。关联必须限定完整 WorkRef 和 turn/item；不是按文本猜测，也不等于原生重试幂等、任意回执丢失窗口可核查或消息已执行。steer 即时回执仍只有 turnId，后续历史核查需真实接入。原等待工具在完成后处理追加，不承诺修改任意已经运行的工具。

| 控制分项 | 当前证据 | 尚需验收 / 开放边界 |
| --- | --- | --- |
| C1 同服务与目标归属 | 当前桌面业务会话可由共享服务只读观测；外部测试记录能在桌面显示 | 核心归属已有证据；维持实例绑定与版本检查，不能将裸 thread ID 当全局身份 |
| C2 GUI 发起、外部追加 | 已验收指定 run034927a7：用户 GUI 新轮，同轮唯一追加 clientId→item，唯一 sleep25 正常 exit0，最终双标记；用户截图确认桌面显示 31 秒 | 仅该正常场景通过。原 exec handle/终态 ack 缺失，不从末态历史反推工具实时先后，不泛化所有工具/断线场景或手机链路 |
| C3 原生稳定关联 | 已证实：真实 start/steer 的 clientUserMessageId 均保存为 userMessage.clientId，关联到不同 native item.id；WP-R 已输出 source_client_message_id | 当前版本历史关联子门槛通过；WP-S 仍需接入持久映射/核查，缺字段或版本不符时保留待核对；不外推重试幂等 |
| C4 断线与回执丢失 | GUI run034927a7 在 exec handle 缺失后，以 fsync intent 和唯一 clientId 只读核查同轮接受，未重发 | 这是一项有限恢复证据；连接器真实网络断线/崩溃、重复请求、跨进程持久核查及所有关键窗口仍未完整验收，不伪造丢失 ack |
| C5 登录、插件及配置兼容 | 模型请求及等待工具可用 | 显式入口跳过原工厂的 secretAuthStorage / 插件覆盖，需只检查当前所需能力；不复制凭据或擅改插件来消除未知 |
| C6 daemon 生命周期 | 曾发生 socket/PID 消失，重新 start 恢复；临时 home 启停通过 | 桌面启动前就绪检查、服务退出/重连、退出归属、版本升级和恢复路径；不强停其他客户端工作 |

**G-Control 总门槛仍未通过。** C1 与协议主路径足以支持共享路线的后续实现和有界验证；C4–C6 及真实链路整合缺口不阻止授权、读取、持久 journal 或 fake adapter 开发，也不允许提前宣称 Ash 已支持完整原桌面会话控制。private IPC 未被选作实施路线。

### 已验收开发批次：WP-R、WP-J 与 WP-I1

本批实现 owner 为 delivery_implementation（J）、authorization_read_channel（I1）及 read_adapter_review（R 修复）；独立 Sol review 与根协调者复核已完成上述开发层验收。R/J 的 WAL、过期查询、回执续存问题和 I1 的旧取消误关新实例、同 generation 改范围、owner 当前性问题均已有修复与针对性证据。下列边界继续约束后续接线；开发层通过不等于全链路 G-Read、G-Identity、G-Delivery 或 G-Control 放行。

| 包 | 此次必须交付 | 此次可验收终点 |
| --- | --- | --- |
| WP-J1 | `control-types.ts` 引用已有 WorkRef；`operation-store.ts` 使用 Node SQLite；`delivery.ts` 依赖注入原生 adapter、当前授权检查与时钟；新增故障测试及必要子进程 fixture | 持久主键、摘要冲突、原子调用意图、accepted 层级、unknown 恢复及只读核查全部通过；无 main/网关/真实 daemon 接线 |
| WP-I1 | `authorization.ts`、`capabilities.ts`、设备侧 `read-service.ts` 及测试；已获 root 分配的 main/link/cli；当前授权快照/世代传入只读协作分支 | 可信 owner 身份来自传输并与有效配对匹配；默认拒绝、撤权立即生效、明确 endpoint/目录范围、可取消关闭；manifest 只声明已实现 read 能力 |

WP-J1 具体验收边界：

1. `principal + operation_id` 唯一，摘要覆盖 action、完整目标/WorkRef、规范化 payload、前置条件及期限。重传同键同摘要返回保存事实；不同摘要 conflict；不同 principal 不得查询或复用对方记录。
2. `recorded → invoking → accepted / rejected / unknown` 持久化；必须先事务写调用意图才进入 adapter。恢复中的 invoking 只变 unknown，不能把它当未调用。recorded 的恢复也须重新校验权限、期限和目标，不因记录存在便自动执行。
3. 正常调用最多一次；并发同键只让一个调用者取得执行权。明确存储实例/进程的所有权：打开第二实例不能将仍活跃进程的 invoking 错判为崩溃；用排他所有权或等价 fencing，并测试其实际边界。
4. 只存必要元数据、摘要、原生引用及去敏错误，不新增聊天正文账本。原生 receipt 没有 message ID 时该映射保持缺失；查询不支持时保留 unknown。授权撤销后读取已有回执也要拒绝。
5. 期限限制新的 invoke，不能隐藏已经保存的投递事实；同键重传和只读 query 在期限过去后仍返回已保存事实，当前授权/范围核验仍适用。并发首次打开空数据库要覆盖 WAL 初始化竞争，有界重试后失败清理句柄，不无限重试。
6. 记录前、recorded 后未调用、invoking 后、原生接收后未保存、保存后未返回，均以子进程退出/跨进程重新打开数据库验证；另测过期、撤权、错误 endpoint、并发与摘要冲突。容量不足应拒绝新操作；不得清除未知记录后允许同键重新执行。已终结记录清理后仍须有明确去重保留边界或 tombstone。

WP-I1 具体验收边界：

1. 先审计锁定 `ash-gateway v0.5.0` 的 `from` 服务端赋值与 owner key → owner ID 的真实契约；保留传输来源，不接受请求 body/header 自称授权。若契约不具备所需保证，新增协作保持拒绝并报告具体缺口。
2. 配置至少版本、endpoint、允许读取的精确目录、授权世代；由规范化实际配置计算 SHA-256 authorization_revision，读取必须携带该 revision，数字 generation 不能单独代表授权内容；首个包可以按已有 ReadAdapter 的精确 cwd 契约落地，不假造 projectId。项目/单会话授权未实现时不在 UI 或能力中宣称支持，后续仍按首期计划补齐范围选择。
3. `list_work` 与 `read_work` 固定分支，不接受任意原生 method 字符串。改变本地范围或撤权时关闭旧读取实例、取消在途请求、拒收旧授权世代响应；下一请求使用新授权。跨包类型扩展先归原 types owner，不各自复制 WorkRef。
4. 假冒 caller、missing/wrong from、错误 owner、撤销配对、无范围、同名/相似目录、越界直读、取消及关闭均有自动测试；原 workspace/browser/managed-runtime 定向回归通过。实际手机读链留待 I2，不能以 I1 helper 单测宣称 G-Read 完整通过。

两包完成的共同交接物为未提交 diff、命令及结果、明确不支持的能力和 reviewer 结论。当前 R/J/I1/I2-Core/I2-UI 开发层及最终统一本地产物均已验收，C2 指定研究场景也已通过；下一批推进 WP-S 适配/授权/核查代码，真实范围和设备切换仍需具体授权。C4–C6 的有界探针另列证据，不让实机研究阻断已有明确边界的开发。

### 当前包 WP-I2：Core 专用只读接口与手机会话浏览

**分发状态：** Core 与 UI 均已通过开发层独立审，各 finding 与闭合证据见进度表；根协调者已完成最终统一构建和定向整合测试。本文不启动 agent。真实读取仍不依赖 GUI 发起控制测试。进入真实手机/电脑烟测前单独确认设备已配对且目标目录已由用户授权，不自动安装真实范围配置。

**最小文件写权限：**

- 新增 `packages/core/src/collaboration/read-service.ts`（Core 边界，与 device 同名文件职责不同）；新增 `packages/core/test/collaboration-read.test.ts`，必要时新增专用 gateway 测试文件。
- 修改 `packages/core/src/server.ts` 仅增加固定只读路由与可取消请求生命周期；修改 `packages/core/src/gateway/link.ts` 仅增加有界协作发现/读取方法、保留规范化 manifest 元数据及当前授权复核；`packages/core/src/main.ts` 仅在服务装配不能由现有入口完成时允许最小注入。
- 新增 `packages/core/ui/js/desktop-work.js`、`desktop-work-store.js`，对应单测及 `packages/core/ui/test/desktop-work-browser-probe.mjs`；修改 `net.js` 增加专用读取方法，`app.js` 接入授权/可见性生命周期，`settings.js` 仅在需要时增加已有设备页入口，主要电脑页头入口必须向已认证远程 owner 开放，不受 localManagement 设置页权限误挡；`packages/core/ui/index.html` 只允许必要容器/样式。
- 不改 device WP-I1/R/J 文件、sdk 公共协议或 Android 文件；确需扩展先向根协调者交接。`packages/core/src/ui.ts` 只由最终集成构建生成，实施者不手工编辑。

**沿用的 I1 契约：**设备 capability 固定为 `collaboration.work.list` 和 `collaboration.work.read`，输入 `{version:1, endpoint_id, authorization_revision, page:{cursor?,limit?}, work?}`；read 才有完整 WorkRef。响应成功为 `{ok:true, content:[], data:ReadPage}`，错误为 `{ok:false, content:[], error, data:{code}}`。manifest.collaboration 提供 version、node_id、endpoint_id、adapter、authorization_state、runtime_availability、authorization_generation、authorization_revision、scope_kind、source、runtime_state 和 control。当前 node_id/endpoint_id 是设备实现分配的值，Core 必须从验证后的 manifest 取得并关联 transport device ID，不从标题、cwd 或 UI 输入猜测。

`authorization_state=ready` 只表示本地读取范围有效、可尝试读取；`runtime_availability=unknown` 明确未证明原生接口可用，不表示 Codex 已运行、账号已登录或原生调用一定成功；列表请求成功后才说明该次读取可用。界面使用“已设置读取范围”“读取中”“暂时无法读取”等实际状态，继续标运行状态未知、控制不支持。material_refs 只是引用，不展示成文件已经下载；本包保留 source_client_message_id 字段但不引入控制投递或乐观发送。

**已通过开发层独立审的 Core 路由契约：**

| 路由 | 最小契约 | 授权与边界 |
| --- | --- | --- |
| `GET /api/collaboration/endpoints` | 返回当前可见设备及规范化协作 manifest；包含授权 generation/revision；页面返回 observed_at | 只向已认证 owner/screen 提供；不返回长期凭据、所有设备完整 manifest 或会话正文 |
| `POST /api/collaboration/read` | `{version:1, device_id, endpoint_id, authorization_generation, authorization_revision, action:"list_work"|"read_work", page?, work?}`；成功返回 `{target,page}`，target 带当前 generation/revision，page 为 ReadPage | body 不接受 caller、principal、capability、任意 method/path、配置或范围授权；入站 64 KiB、出站 1 MiB、整个读取链 30 秒上限；`Cache-Control: no-store` |

Core 入口复用 `EdgeRouter.context` 的 owner/screen 校验，显式拒绝 agent/device/service 冒充 owner；远程 web_ui 必须有有效 screen 绑定。异步返回前再次核验相同 caller/screen 与授权世代；不能仅因开始时有效就返回撤权后的正文。普通 owner API 和手机现有认证如何适用，以现有可信调用者模型实现，不从请求正文扩张 ownerProxy。

OwnerLink 增加固定动作方法，在请求前及响应后都核对同一个 connection/epoch、当前配对未撤销、设备具备 expose_capability、验证后的 manifest 指向所选 endpoint、固定 capability 存在、authorization_generation 与 authorization_revision 均未变化（revision 必填，绑定实际规范化范围）。设备离线、撤权、manifest 改变或超时均返回明确失败；缺少可信状态时拒绝，不能只用上次在线的缓存条目。响应必须来自目标设备（复用既有 frame.from 对 outbound device 的校验），解析和正文大小有界；检查返回 WorkRef 与所选目标一致。原 capability 到 /ash/call 的映射在 Core 内部固定生成，caller 固定来自可信 owner 通道，不能替客户端转发任意 capability。

读取通过该专用路径直接返回，禁止调用 `world.send` / `/api/send` / `DeviceMember` 常规消息路由反复保存历史。普通 DeviceMember 不借入 collaboration.* 能力，避免通用模型/ledger 路由形成旁路；验证连续刷新前后 Core ledger 消息数与正文记录不增长。请求的 AbortSignal 应从 UI → HTTP/网关 request → device 读取传播；如现有 EdgeRequest 尚未携带断开信号，在本包最小扩展，同时保留世代校验防止迟到响应写缓存。

**界面与缓存：**从页头“电脑”入口进入电脑 / Codex 会话列表；远程 owner 与本地 owner 均可见（设备管理权限另处理），显示原生标题、目录分组及最后同步时间；选择后显示最近用户/助手消息，上滑或“加载更早消息”请求旧页。每次进入刷新列表/最近页，详情可见且选中时一次请求完成后再延迟约 4 秒刷新；失败退避，隐藏、退出、切目标或授权变化都取消定时器与请求。列表不扫描全部历史，不为未打开会话持续读取。

缓存键至少含 Core endpoint + 当前 auth_scope + transport device ID + manifest authorization_revision（并核对 generation）+ 完整 WorkRef（列表为对应 endpoint）；缓存是有界读取副本。当前实现常量为全局 2 MiB、最多 100 works、24 小时保留，替代早期建议值；任一上限先到即清理，超限内容拒绝缓存或明确标示不完整，不无限保存当前页。存储错误降级到有界内存并说明离线保存不可用。容量/保留期与失败降级仍须浏览器和 store 测试验收，不将代码常量本身当测试通过。

收到新 authorization_revision（包括数字 generation 未变但实际范围变化）/撤权/身份切换时清除旧范围缓存、递增响应世代，拒收旧响应；离线仅展示当前已知身份和最后已确认范围的缓存并显示时间，无法确认身份时不展示旧主体内容。按 WorkRef + turn_id + source_message_id upsert；同 ID 内容可更新，源页缺项不能当删除。最新页的游标与旧页加载会话分开管理，刷新后游标变化不重复追加或死循环。渲染保留旧页锚点，收到新消息提示而不强拉到底。读取材料只显示“引用，尚未传输”，不把电脑路径变成可领取文件。

**本包验收：**

1. Core 路由拒绝无 owner/screen、过期 screen、正文身份伪造、任意方法、错误 endpoint/WorkRef、撤权配对和过大响应；请求中撤权/换连接/变 manifest 后正文不返回。OwnerLink 的前后检查通过真实契约 fake gateway 验证。
2. 单次读取及重复可见刷新不增加 ledger 消息；取消、超时、设备离线与无范围分别返回明确状态；manifest ready、runtime unknown 不被 UI 提升为全功能可用。
3. Store 单测覆盖身份/世代隔离、容量/保留期、同 ID 更新、重复页面、无效游标与存储失败；响应世代保证先发后到的旧请求不能覆盖新目标或新范围。
4. 真实浏览器 DOM 检查：进入列表/详情、离页和 visibilitychange 停止读取、失败退避、切目标拒收迟到响应、有缓存/无缓存离线、上滑锚点不跳、收新消息不强滚、能力提示及材料引用。纯 helper 单测或静态截图不足以通过 G-UI。
5. 独立 Sol review 授权复核、无 ledger 复制和 UI 生命周期；Astra 对代码证据分段验收。fake gateway / 浏览器探针证明本包行为，实际 Android → Core → 已配对 Mac 只读烟测仍单列；不能因此提前完成全部 G-Read 或首期 Goal。

### 阶段验收结论与剩余硬门槛顺序

**本次放行仅限开发基础：** R 的有界只读适配器、J 的本地投递事实/fake adapter 故障恢复、I1 的可信传输与范围授权、I2-Core 的专用读取边界和 I2-UI 的界面/缓存生命周期已满足本批开发验收条件。当前没有未解决的已报告阻断级 R/J/I1/I2-Core/I2-UI 问题；后续真实整合发现的新问题仍需回到对应 owner 修复。测试中 fake native 每键一次不外推原生 exactly-once，局部 owner 检查通过也不外推手机端全链路授权已完成。

| 顺序 | 下一硬门槛 / 产物 | 放行证据与保留边界 |
| --- | --- | --- |
| 1（已完成） | I2-UI 开发层独立审 | 范围/排序/分页缺口与 inclusive 边界/send-error/source desc 归一化 finding 全部闭合，7 单测及最终 Chrome 3/3 通过；尚非 Android 实机验收 |
| 2（已完成本地部分） | 最终源码构建与读取整合 | 最新源码统一 typecheck/build/diff 通过，Core 8.5 MiB / device 529.2 KiB；Core/UI 20 tests、device 48 tests pass，hash 见开发快照。真实服务仍为旧安装，不自动视为已升级；后续源码变化按影响重建 |
| 3 | G-Read / G-Identity / G-UI 全链路读取 | 在获准范围内验证真实 Android → Core → 已配对 Mac → 同一历史源：列表/直读、分页、更新、离页取消、实际撤权、离线缓存与重连；不通过额外读取其他 chat 来凑证据。配对/配置若需用户操作，准备具体步骤后才请求 |
| 4（C2 已完成指定场景） | C4–C6 控制核查 | 保留 C2 历史/截图证据与缺失即时 ack 边界；补真实断线/崩溃窗口、持久 clientId 核查、登录/插件兼容、daemon 就绪/重连/退出归属；不重新申请既有测试授权 |
| 5 | WP-S / G-Delivery 真实控制整合 | 接入已选 native adapter、持久回执/消息映射和只读 reconcile；未知不重放，接收后丢回执及重启窗口在真实源核查。复用已验证真实项目新建路径，取得完整 WorkRef；不能以 journal fake 测试或外部探针替代手机控制链 |
| 6 | WP-A / G-Asset / G-Bidirectional | 手机问题按来源 ID/版本回复，限定材料到端摘要确认，原会话跨轮次/重启按同一授权身份领取结果；反向请求及越权/版本变化测试通过 |
| 7 | P5 完整回归与 P6 / G-Release | 全首期端到端与故障验收，再核对普通用户安装/配对、图形范围选择、版本升级/恢复与发布材料；签名、安装、部署依既有具体授权边界，不把开发通过当发行完成 |

最终统一构建/定向整合与 C2 指定研究场景均已通过，下一批可直接推进下文 WP-S 分包代码与 fake 故障测试；不因尚未配置真实 scope 停止这些独立开发。C2 没有替换生产连接器或扩大读取范围，不需为重演同一正常场景再次请求用户操作。真实读取的授权 scope 当前尚缺且实际设备仍运行旧版；这两项后续单独给出已核对配置、拟授权精确目录、读取目标、切换/恢复步骤，由用户作具体范围和执行选择。不能从工作区 cwd 推定授权，也不自动扩大配置或替换服务。G-Control、真实 G-Delivery、材料双向、P6 和整个 Goal 均未完成。

### 本地产物、真实读取准备与 C2 已验证场景

本节区分已完成的 T-Build / C2 与未执行的真实读取部署。C2 真实动作由根协调者此前在已授权独立会话完成；当前更新只整理证据，没有新增发送、范围配置或设备替换。后续分包由根协调者登记 owner；计划维护者不写代码、不执行实机操作。

**T-Build：统一产物（已完成）。**UI 独立审与最终真实 Chrome 3/3 已通过；根统一 typecheck、build:core 8.5 MiB、build:device 529.2 KiB、diff 检查及 Core/UI 20、device 48 定向测试均通过。产物摘要在开发快照记录；Core ui.ts 与 Android ash-ui/index.html 同源生成，其余既有 Android 修改保留。后续源码改变按影响重建，不为重复进度再跑整套。验收终点是可审阅、同协议 revision 的本地产物，不是安装或部署。

**T-Read：真实范围与设备切换。**先只读核对已有配对/运行实例、其 stateDir 对应关系、manifest 协议及执行版本，输出脱敏诊断；不得导出 owner key、令牌或完整配置。已有实例若支持最新读取协议，直接使用其已授权范围；不要为 smoke test 先替换服务。真实范围尚未配置时，只准备 `read-scope --config <已核对配置> --allow-cwd <用户已明确授权的精确目录>` 的具体可审阅命令。不得把 cwd 当作用户已经授权该目录全部聊天的证据；默认无范围保持拒绝，不自动授权 HOME、整个代码根或其他项目。

确需用新构建替换正在运行的连接器时，先记录现有可执行文件/版本、精确服务/PID、已配对身份对应的 stateDir、恢复入口，以及是否有进行中的 managed-runtime、workspace/browser 或协作调用。没有可靠空闲证据就不切换；不批量 kill、不停止 Codex daemon、不清理配对/队列/数据库。使用独立构建路径保留原二进制；同一 stateDir/身份只能有一个连接器 owner，不能并行启动旧新版本抢连接。既有授权不含该具体设备重启/安装时，先准备切换与回退命令再请用户批准或执行；不把“允许开发测试”自动扩成生产服务替换。

切换在获准窗口进行：精确停止已确认的旧连接器，启动新构建复用原身份/配置（不复制凭据到新 home），先检查状态/manifest，再访问明确范围；失败则停止本次新 PID，并以原二进制/启动方式恢复。读取范围变更前保留原文件是否存在及受限本地备份，测试结束按原状态恢复，核验 authorization_revision 和范围已恢复；不要用 `--clear` 粗暴抹掉用户原有授权。若现有身份不能安全使用，则准备独立测试设备配对流程，请用户按原配对 UI 批准；不伪造 owner 身份或复用其他设备授权。

真实读取仅围绕用户批准的目标/目录执行有界列表和指定 thread 最近页、一次旧页读取、同 ID 更新及退出页面停止请求；记录方法/计数/稳定 ID/时间/授权 revision，不保存完整聊天正文。实际撤权、离线/重连和切范围用受控测试配置或临时测试身份验证，不能为了证明边界改坏正常设备。Android 未具备当前 Core UI/读路由时，先报告实际版本缺口和替换方案，不能以桌面浏览器通过代称 Android 已验收。

**T-C2：GUI 发起对照（指定场景已验收）。**脚本 owner 为 gui_control_probe（Sol medium），独审为 gui_probe_review。最终 42 fake tests 及独立竞态复验通过，自动 starter 场景 8bf403a4 已有真实 ackSameTurn/historyVerified 证据；随后用户 GUI run034927a7 完成同轮追加，用户截图确认初始输入、追加与末条 final 双标记，桌面显示 31 秒。固定历史只读 reconcile 唯一匹配 clientId→native item、同 turn 的唯一期待 sleep25 completed/exit0。原 exec handle 缺失，仅有 fsync 调用意图，无终态 ack；本次没有重发，不把历史接受证明写成即时 ack 或工具实时先后证据。证据摘要见开发记录及 `build/research/daemon-switch/gui-c2/reconcile-034927a7.json`。

**运行中状态语义已由实测修正：**自动诊断 b005d508 的 12 次运行中历史快照没有 command item，同一连接已收到 command started；工具完成后才入历史。因此已保存历史只用于身份/本次标记和已出现的冲突核对，不能要求“历史已有运行中工具”作为发送前提。原生控制的活动依据必须是同连接、同 epoch、同 turn 的实时 started/未 ended 事件，结合当前 thread 状态与 expectedTurnId；断线丢失事件时状态回 unknown。完成后再从历史核对完整工具、final 和 clientId。以下为该探针继续保留的边界，后续产品 adapter 不直接复用研究脚本硬编码。
- **固定目标：**唯一 thread 为 `01a11f8f-7ff8-7ab2-9ad7-0607832213a9`。目标 ID 硬校验；不得遍历或读取别的 chat。只连接当前已验证的共享 Unix daemon，核对同捆版本与 listener 归属；脚本不启动/停止 daemon、不重启桌面。
- **只读布防：**初始化后读取目标元数据与最近一页轮次，保存基线 turn IDs 和连接 epoch；目标已有活动 turn 时退出，不能中断。输出 ARMED 后才请用户从桌面 GUI 在该测试会话发起新一轮。脚本禁止 `thread/start`、`turn/start`、`turn/interrupt`。当前 schema 无 `thread/subscribe`；基于此前真实探针，允许仅对上述固定旧测试会话调用 `thread/resume({threadId, excludeTurns:true})` 建立观察订阅，不传模型、cwd、配置、工具或其他覆盖参数。此许可不属于 WP-R 历史读取白名单，不扩大到其他会话。禁止用 resume 代替 GUI 发起，含义是 resume 不得被当作新 turn 或 GUI owner 证据；并非禁止这个已明确允许的观察订阅。必须仍等待用户 GUI 发出本次 run_id 输入后才认定新 turn；订阅无法观察则 inconclusive，不增加 start/interrupt 弥补。
- **用户输入稿：**“这是 Ash GUI 发起对照 `<run_id>`。只执行一次 `sleep 25`，不要读写项目文件或调用其他工具。等待结束后仅回复 `GUI-BASE-<run_id>`；若收到本轮补充标记，将它附在同一条最终回复。”标记由本次 UUID 派生，脚本与用户文本使用同一 run_id；用户手动选择固定测试会话并发送，脚本绝不代发初始输入。
- **单次追加前置：**观察到该固定 thread 恰好一个不在基线内的新 turn，且该 turn 中唯一测试等待命令的 commandExecution 已 started，才允许一次 `turn/steer(expectedTurnId)`。还须核对本轮 GUI 输入的 run_id；出现多个新 turn、其他命令、目标/epoch 改变、已有审批等待、缺少等待事件或超时，均不 steer，并报告具体未满足条件。
- **消息与工具边界：**追加只要求最终回复带 `GUI-APPEND-<run_id>`；clientUserMessageId 使用独立唯一 UUID（含本次 run_id 关联），本地先记本次调用意图。只允许一次发送，不重试，不执行 interrupt，不触碰其他会话。审批请求仅报告给用户处理；脚本不自动答复批准、拒绝或伪造 approval。意外审批/工具出现时停止自动控制，只保留有界观测和必要的只读核查。
- **回执核对：**核验 steer ack 的 turnId 等于 GUI 新 turn；同一等待 command 正常完成且 exitCode=0；无第二个 turn/started；最终回复包含两枚本次标记。对固定目标有界读取历史，以 `userMessage.clientId == 本次 clientUserMessageId` 找到原生 item.id，并核对同一 WorkRef/turn，不按文本合并消息。用户确认该 GUI 会话显示本次初始/追加/结果，不能拿旧轮次截图代替。
- **超时与断线：**单请求最长 5 秒；布防/执行观测按修订脚本采用有界窗口（当前执行观测最长 10 分钟），不再使用已被实机证明不足的旧 120 秒前提；脚本退出仅关闭自己的 socket。steer 后断线/回执丢失记 unknown，只允许重新连接同一实例对固定目标做有界历史核查（最多 4 页、每页 25 轮），绝不重发；查不到唯一 clientId 则保留 unknown。没有 GUI 新轮或等待事件记 inconclusive，不能伪报失败或通过。
- **输出与 fake 验收：**只保存版本、目标/turn/item/client ID、run_id、时间、调用次数、工具退出码与各项 pass/fail/inconclusive，不记录凭据或其他聊天内容。fake 测试至少覆盖错误 thread、旧 turn、多个新 turn、缺等待、等待已结束、审批、断线、重复事件、重复 ack、过期与超时，断言所有负例 `steerCalls=0`（发送后故障则最多 1）、任何路径 `turn/start=0`、`interrupt=0`。

T-C2 已有一次指定 GUI 正常场景通过，只关闭 GUI 发起/外部追加这一子门槛；回执丢失、插件登录兼容与服务生命周期仍需各自的受控场景。探针产物不等于 WP-S 真实 adapter、手机发送或持久 reconcile 已交付。

### 当前批 WP-S：S1–S4 开发层完成，冻结 S5 首包

用户已明确同意继续，原 Goal 当前 active。S1/S4 新模块 79/79、S2/S3 原开发层证据保持有效；runtime 12 项及新增 lifecycle 回归、Core 旧入口 48 项、UI 持久 Chrome fake 全链 3 项均独审通过。device 实际 main/link/capabilities/bounded pairing 与 lifecycle 最终独审为 67 项串行 + tsc，并通过独立 pairing probes。apply deadline 后 native pending 导致 close/busy 的阻挡已闭合；生产代码冻结，作者只同步一条并行 disconnect fixture，不再以该 fixture 将功能标成未完成。这些证据基于 fake socket，不等于真实 daemon、Android 或发行验收。

根已完成受影响统一构建：Core 8.6 MiB，SHA-256 `2263c184975bc592d9e96087a6e2857496b8527d990c62017498af176cf21b37`；device 628 KiB，SHA-256 `0afdb02ced6932ecd5cfc8f6861aa51796e628667193af60d9b33599b8bdfc53`。这是当前 S4 本地产物，前表读取批次 8.5 MiB/529.2 KiB 是历史证据。无真实配置变更、手机测试、安装或部署。

根已下发 Sol medium 的 S5-A 给 `create_contract`，只新增 create-types/create-protocol 及专测；契约独审冻结后 B journal 与 C 项目/原生 adapter 可并行独占新增文件，D 创建 lease 的隔离工作也可开始。具体 DTO、路径、接口、禁止修改范围与测试门槛见 [S5 首包分发规格](S5-CREATE-WORK-PLAN.md)。不重复 GUI 侧栏能力验证，不泛化旧 ControlRequest/WorkRef 或旧 SQLite 表。

| 子包 / owner 槽位 | 独占文件边界 | 可验收交付与进入下一包条件 |
| --- | --- | --- |
| S1 · native_control_adapter · 已验收（开发层） | 新增 device collaboration 下 `codex-transport.ts`、`codex-control.ts`、`codex-live-state.ts`、`control-native-types.ts` 及专用测试/fixture；只读使用现有 WorkRef/ControlAdapter 类型 | 同捆版本/Unix socket 归属、有限协议、epoch 与实时活动/回执；terminal error、observe/reconnect 与安全 needsObservation 已修复独审通过；46 项包含晚加入与保留 pendingStart 的恢复，交接完整 snapshot/version getter/有界 history API。先不改 main/link/capabilities/ledger |
| S2 · control_grants · 已验收（开发层） | 新增 device collaboration 下 `control-authorization.ts` 及专用测试；已有 authorization.ts 的 TrustedCallContext 只读复用 | 与 read-scope 分开的本地控制 grant、SHA-256 revision、固定 owner/endpoint/动作/范围、调用前及返回前当前性检查；默认无 grant 拒绝，撤权不泄漏已有 receipt。不写真实配置、不改读取授权 |
| S3 · persistent_reconcile · 已验收（开发层） | 接管现有 `control-types.ts`、`delivery.ts`、`operation-store.ts`、delivery tests/fixture；新增 `reconciliation.ts` 及测试 | 调用前持久 native client ID/目标/attempt 映射，原生接受与消息关联分层；只读 reconcile 可推进 unknown/补全 accepted 关联，不能触发重发。独立审 54 tests/tsc、6 额外边界及 CAS probe 通过；版本、重复匹配、撤权、cursor、未找到均不误给 stable，迟到核查不覆盖新事实；真实 C4 窗口仍另验 |
| S4 · 已验收（开发层，含旧入口/lifecycle） | S1–S3 交接后新增 device `control-service.ts`、Core `collaboration/control-service.ts` 及测试；根按顺序授予 device main/link/cli/capabilities、Core server/gateway、UI net/desktop-work/store 的最小修改 | 可信 owner/screen→固定 control endpoint→J→native adapter 完整接线；读取 grant 不自动获得控制，手机每次提交唯一 operation，查询和乐观消息按稳定映射合并；未通过的 C4–C6 能力仍如实显示，不默认宣布全就绪 |
| S5 · 首包已分发 create_contract（Sol medium） | S5-A 独占新增 device `collaboration/create-types.ts`、`create-protocol.ts` 和专测；随后 B/C 按 S5 文档并行，旧共享文件保持只读 | 独立 create DTO/store/lease，真实 projectId + exact_cwd；同一 operation 的 create/name/first_input 三阶段；缺 thread ID 的创建 unknown 保持未知且不重建；A 契约独审后再放行消费者 |

**本轮独立审结论与修复验收：**

- S2 的 native metadata 查询期间撤权/到期、过期后已存事实 query 等边界已由独立 probe 复验，13 tests 通过；可验收授权模块开发层，不外推真实 grant 已安装或 S4 全链路成立。
- S1 先前 terminal error 与 observe 最终 await/reconnect 竞态已关闭；原 44 项通过后，新增安全 needsObservation 回归共 46 项最终通过。普通 unknown 和 pendingStart 不能被重观察改成可自动新发的 idle。
- S4 独审以实际 CodexControlAdapter/CodexTransport + fake socket 发现并复验关闭三项：重复 connect 改变 epoch 阻断 apply、连接失败 scope 泄漏耗尽 registry、同 epoch scoped error 后无法安全恢复。最终 79/79 与 tsc 通过，额外 8 并发 ABA 撤权和旧 socket 清理 probe 通过。该证据不包含旧入口、真实 grant 或手机操作。
- S3 已独立审 54 tests/tsc、额外 6 边界/CAS probe 通过；第 4 页匹配保存 stable 关联时仍保留 pages_observed=4/history_exhausted=false，不宣称全历史唯一。S1 接口已交接；下一包直接验证生产 factory 和完整入口仍保留这些授权与持久事实契约。

**S4 必须承接的授权生命周期：**S2 提供 `invalidate()`，但仅比较当前 grant 内容不能识别已观察到的“撤销→恢复同内容”ABA。S4 的 grant/pairing watcher 必须对每一次观察到的变更调用 invalidate，即使最终文件内容/revision 恢复相同；旧 lease 在 revoke 后永久失效，新请求重新 acquire。测试需覆盖撤销和恢复发生于异步 native metadata/发送前/返回前窗口，并断言旧调用不能复活；不能把未观测到的文件变化宣传为已保证检测。控制通道接线前这项是硬验收条件，S2 当前通过不免除它。

**S1/S2 → S3 接口交接（开发层已验收，整合须保持）：**当前 S1 的 `NativeControlInvocation extends Invocation` 已明确必填 `native_client_message_id` 与 `native_interface_version`；`codex-control.invoke` 读取这两个字段，要求 ID 合法且版本等于当前 transport.version。S3 已将它们纳入共享 Invocation，ControlAdapter 也明确提供 native_interface_version；S4 必须继续在持久调用边界满足契约，不使用旧结构绕过字段。下表用于本轮交接与测试，不代替独立审。

| 边界 | S1/S2 应提供的明确契约 | S3 消费规则 |
| --- | --- | --- |
| Native 调用身份 | S1 NativeControlInvocation 必填 native_client_message_id、native_interface_version，并继承完整 WorkRef、action、expected turn、connector_epoch；ID/版本由上层在 invoke 前持久保存，S1 不临时生成后才回传 | S3 进入 native 发送前事务保存这两个字段及 attempt/epoch 绑定；同 operation 重传复用原映射，不能换 ID 或以当前版本覆盖旧事实；缺字段/版本不符不得触发 native 写入 |
| 活动快照 | S1 返回关联目标、epoch、状态来源/观测时间、unknown/idle/active、可靠 active turn 与审批等待；断线或 epoch 变化使旧快照失效 | snapshot 不是持久授权；claim 后、native 实际发送前仍核对相同 epoch/前置，变化则不静默换 action/turn |
| 结果与失败 | S1 明分 native accepted（可能只有 turnId）、确认 rejected、结果 unknown；timeout/断线若可能已发出绝不能当确认 rejected | 保持已有 J monotonic 事实；原生接受不等于业务完成，uncertain 关联不回收乐观消息 |
| 只读核查 | S1 提供有限历史查询/唯一 clientId 匹配候选或明确“不确定”，带 WorkRef/turn/item/版本/来源；无 invoke/replay 副作用 | S3 负责当前授权复核、冲突判断和事务保存 provenance；不能让 adapter 直接改 journal 或把未找到当未接受 |
| Grant 证明 | S2 从可信 transport context 派生 principal，输出 grant revision/动作/目标范围与当前性检查；native cwd/会话 metadata 必须来自可信解析，不来自请求 body 自称 | 请求入口、实际 invoke 前、query/reconcile 返回前分别重验；范围撤销不能被旧 grant 对象或缓存绕过 |
| 类型/文件所有权 | S1 拥有新增 control-native-types.ts，S2 拥有新增 control-authorization.ts；两者只读既有 control-types.ts/authorization.ts，不各自复制 WorkRef 或变更既有协议 | S3 获授后统一修改 control-types/delivery/store 及迁移，所需 S1/S2 API 变更先交回其 owner；main/link/CLI/UI 留 S4 |

S3 开发层已按该边界验收，根协调者仍需统一裁决后续整合引发的导出类型变更，避免两个 owner 同时改既有 control-types.ts。验收至少断言 fake S1 实际收到已落盘的 client ID 与版本，重开/重传仍一致；旧 journal 缺映射的 invoking/unknown 不能临时补一个新 ID 当作原操作再发，需保持可查询且未知。当前主要风险仍是字段漏传、native clientId 在 journal 外生成、或 grant 只在入站校验；须直接测试。S1/S2 不应提前开放 create_work 调用、真实 CLI grant 写入或手机 capability ready。

**S1 的活动与调用契约。**读取历史保持 WP-R 原接口独立；控制连接只接用户选择的共享实例。连接成功只是 transport ready，模型/插件可用性另有观测。每次重连递增 connector epoch，旧事件/响应失效；没有当前来源证明时 busy/idle 为 unknown，禁止根据旧 history interrupted/notLoaded 猜测。同连接原生 turn started/completed/工具 started/ended 事件更新活动状态；工具尚未入 saved history 不是不存在。来源错误、目标 ID、active turn 冲突或丢事件必须显式拒绝/unknown，不能静默启动另一个执行者。

`send_input` 在可靠空闲快照后至多调用一次 `turn/start`；`steer` 对可靠当前 active turn 调用一次 `turn/steer(expectedTurnId)`，原生 expectedTurnId 提供目标轮次匹配约束。**turn/start 没有原子 idle 前置条件：**快照到原生处理之间，其他客户端可能先启动工作，原生可能将输入追加到活动轮；本地再查或加锁不能封住其他客户端的这个窗口。不得把 send_input 宣称为“强保证新开一轮”，也不能把源行为变化伪记为本地成功新轮。实际收到的 turnId/接受事实照实记录；已发送后发现竞态不能谎报确定未发送或重发。若用户明确要求严格另开一轮/排在下一轮，未有原生契约前应报告该精确语义不支持，不擅自转成 steer/新建会话。动作、前置条件及可证明限制须进入能力声明与 UI；steer 仍使用 expectedTurnId，不以当前快照替代原子轮次约束。默认追加保持原端工具节奏；探针使用 sleep25 是测试条件，产品 adapter 不得只允许 sleep25，也不能把无法即时修改运行工具包装为失败。首包不开 cancel、队列、动态工具或审批代理；native 审批仅暴露“需在原端处理”，不自动回批准/拒绝。固定目标的 resume 仅在已验证订阅契约及 grant 内使用，不扫描所有 loaded chat、不在 initialize 健康检查自动发模型任务。

S1 fake 验收至少包含：错误 endpoint/thread/turn、重复和迟到事件、connected 后无可靠活动、steer 前已 completed、其他 turn 取代、idle snapshot 后其他客户端启动且 turn/start 返回实际活动 turn、网络发送前/后断线、进程重连、超时、源 method 不支持、最大消息体与错误脱敏。该竞态测试证明限制被正确表达和事实被保留，不证明 turn/start 原子 idle。`invoke` 超时或连接丢失不能轻率返回 rejected（原生可能已接受）；交给 J 保留 unknown。原生 ack 只有 turnId 时 receipt 为 native accepted / correlation uncertain；只有源 clientId 唯一关联 item 后才变 stable_message_id。

**S2 的信任与范围契约。**principal 必须由现有 pinned owner transport 和当前配对派生，不从 body/caller 或 native 文本生成。控制 grant 至少含协议版本、endpoint、允许动作、明确的精确 cwd 或单会话 WorkRef、有效期（如配置）及规范化 revision；范围的 native metadata 二次核验不可省。读取与控制是两份授权；不给现有 read-scope 追加隐式 send 权限。grant revision 在请求进入、J 实际 invoke 前及异步返回前均核查；撤权后既有事实也不得向该主体泄露，已开始 native 执行则不能承诺撤销回滚。CLI 写 grant 的交接最后集中改，继续沿用 UUID 临时文件、wx/0600、原子替换和 finally 清理。fake 验证同 generation 改范围、wrong owner/endpoint、同名目录、跨主体 query、执行前撤权、执行后撤权、旧请求迟到及无授权配置。

**S3 的原生关联与核查契约。**调用前必须将可重建的 `clientUserMessageId` 与 principal/operation/WorkRef/attempt/native 接口版本持久绑定；不能到 native 接受后才生成或只存在临时脚本内。无论选随机 ID 持久保存还是确定性派生，唯一键和规范化摘要规则须固定并可跨进程恢复，不含原始凭据。重传同 operation 使用同一映射，不触发第二次 invoke；主动再发是新 operation。

reconcile 只能通过有限历史页和真实来源字段核查本操作。恰好一个同 WorkRef 的 userMessage.clientId 对应原生 item/turn，才可原子保存 native accepted/stable mapping；多个、跨 turn 冲突、无字段、页限内未找到、授权或版本不符均保留 unknown/uncertain，不根据文本相同或“没有查到”判断 rejected。accepted 但缺 message ID 也可以只补关联；终态事实不可被迟到失败覆盖。保存核查 provenance（来源/版本/观测时间/ID），不得伪造丢失的即时 ack、执行完成或工具时间。过期只限制新 invoke，当前获准主体仍可核查；撤权拒查。损坏/迁移/持久失败仍 fail closed，已完成 native 写库失败只续存事实。

S3 故障验收按实际进程重开 SQLite 覆盖：调用前持久映射、发送后连接中断、原生接受后回执丢失、回执到达后写库失败、reconcile 成功前后崩溃、并发 query/reconcile、重复 native clientId 冲突、授权在核查中变化。通过 fake 不等于 C4 真实窗口通过；run034927a7 提供核查可行证据，不能代替这些产品路径测试。

**S5 的项目新建边界。**先核对既有 itsallsame 指定项目创建契约，不重复研究用户已确认存在的能力，不改其项目代码。现有 J 仅覆盖已有 WorkRef 的 send_input/steer；create_work 需要显式 scope target 和创建 receipt，按真实协议扩展独立状态/类型，不能凭空造 conversation native_id。创建、命名和首次输入使用同一 create operation 内的独立阶段意图及回执；首次输入使用独立持久 client ID。失败/未知时保留已建 WorkRef 与请求关系，不盲目重建或另造 operation 重发。原生无法按操作查找新建结果时必须报告该恢复缺口并保留 unknown，不以清空 journal 或换目标绕过。新建 scope/default-project UI 与安装范围设置需用户作实际选择，代码阶段不替用户决定默认项目。

**本批开放门槛仍在：**C4 要求真实产品路径的丢回执/重启核查，C5 要求已选 daemon 路线下登录与必要插件/配置兼容，C6 要求服务就绪、退出归属和重连/升级恢复。代码与 fake 可以先完成并独立审；只有已验证并获 grant 的动作才向实际手机声明 ready。真实读取部署、WP-A 材料双向与 P6 也仍未完成；不把新的研究探针改名为手机交付。

### S4 已实现服务契约与待接入口：固定控制服务、Core 接口和后续 UI

S1–S3 与 S4 独立新文件/fake 接线已通过开发层独审，允许按下方所有权推进生产 factory 与旧入口；完整产品路径尚未验收。S4 不写真实 grant/config、不重启/替换生产服务、不连接真实 daemon、不部署；实例、授权、store、时钟和原生适配器均可注入。仅限 send_input/steer、状态检查、已存事实查询与显式只读 reconcile；create_work 留 S5，cancel/排队/审批代理不在本包。

**所有权与分包：**

| 包 / 建议 owner 槽位 | 立即可独占新增 | 既有文件交接与终点 |
| --- | --- | --- |
| S4-device | `packages/device/src/collaboration/control-protocol.ts`（唯一 DTO owner）、`control-service.ts`、`control-watch.ts` 及 `packages/device/test/collaboration-control-service.test.ts`/watch tests | 初包只新增文件，整合 S1/S2/S3 注入边界；DTO 冻结后通知 S4-Core。之后由 root 单独授予 device main/link/capabilities 最小分发与停机接线，CLI grant 写入暂不做 |
| S4-Core | `packages/core/src/collaboration/control-service.ts`、`packages/core/test/collaboration-control.test.ts` 及必要 fake gateway fixture | 与 device 新文件并行，只读 import 共享 control-protocol。新服务审过后 root 授予 Core server/gateway/link 和必要 main 装配；device main/link/capabilities 与 Core 入口每次集中交接，不让两个 agent 改同一协议或共用入口 |
| S4-UI（后续独立 owner） | DTO/服务稳定后，新增 `packages/core/ui/js/desktop-control.js` 与专用测试/浏览器 probe | 独占必要 net/desktop-work/store/app/index.html 修改；他人只读。ui.ts 与 Android ash-ui 由最终统一生成，不手工编辑；不改原 Android 业务源码 |

上述 S4-device/Core 新服务已实现并独审通过，S4-UI 已分发 desktop_control_ui（Sol medium），独占 desktop-control.js、必要 net/desktop-work/store/app/index 与 UI 专测，生成产物由根统一处理；旧入口由下一包独占接管，Core 已登记 core_control_wiring。`control-types.ts`、delivery/store/reconciliation 仍属 S3 交接范围，S4 不顺手改；需要补契约先 root 交回 owner。S4-Core 先做 pure DTO/transport service 测试，避免等待 device 入口接线而复制第二套 DTO。

**DTO v1（建议首个 control-protocol.ts 即冻结）：**所有对象拒绝未知键，WorkRef 复用既有类型，native ID 按既有有界格式验证；不接受 principal、caller、grant 文件内容、native method、path、provider/model overrides。`authorization_revision` 在这组接口专指 S2 控制 grant revision，不接受 I1 read revision；Core 的 `device_id` 为 `device:<id>`，endpoint/work 必须匹配当前已认证设备映射。

| 固定动作 | Core HTTP 路由 / device 内部固定动作 | 最小输入与输出 |
| --- | --- | --- |
| 状态 | `POST /api/collaboration/control/state` / `state` | 输入 `{version:1,device_id,endpoint_id,authorization_revision,work,action}`；action 为待检查的 send_input/steer。输出 `{target,authorization_revision,connector_epoch,native_interface_version,snapshot,allowed_actions,limitations}`；snapshot 含完整 WorkRef/source/observed_at/state/turn_id（如可靠）与 revision。不能由状态查询触发 send/steer |
| 明确投递 | `POST /api/collaboration/control/apply` / `apply` | 输入上述目标/revision、`expected_connector_epoch` 及 `request:ControlRequest`；request.work 与外层目标严格一致，action 从 request 取得，不另设可能冲突的第二 action。输出 `{fact:ControlFactDto}`，fact 来自 J，不是模型最终结果 |
| 已存事实 | `POST /api/collaboration/control/query` / `query` | 输入 `{version:1,device_id,endpoint_id,authorization_revision,work,action,operation_id}`。action 只用于 grant 绑定，必须与找到的保存事实一致；返回 `{fact:ControlFactDto|null}`。不要求旧 connector_epoch 等于当前，以支持重启后查询；必要授权 metadata 读取之外不发原生写/不自动 reconcile |
| 显式核查 | `POST /api/collaboration/control/reconcile` / `reconcile` | 与 query 相同输入，当前 lease 允许后执行最多 4 页/每页 25 的 saved-history 核查；返回当前 `{fact}`。只更新保存事实/provenance，不调用 native start/steer/resume、不把 null/unknown 变成重发提示 |

设备 capability 白名单固定为 `collaboration.control.state`、`collaboration.control.apply`、`collaboration.control.query`、`collaboration.control.reconcile`；Core 根据固定路由生成 capability，客户端 body 不能传 capability。设备服务收到去掉 Core device_id 的相应严格 envelope，动作由内部固定 dispatcher 决定；不是将外部 method/path 透传给 native。控制 manifest 使用独立 `collaboration_control` 元数据块，至少 version/endpoint/grant state/revision/已实现 actions/limitations；不得直接把现有 `collaboration` 读取 DTO 的固定字段换成不兼容对象。Core 校验器仅接受新块的白名单字段，grant ready 与 runtime/control source ready 分开。apply 的 expected_connector_epoch 只允许在进入 J 调用前匹配当前已观察实例，防 UI 使用旧连接状态；query/reconcile 按当前 grant 与当前来源核查历史事实，不用旧 epoch 阻止恢复。state 的 action 只是查看该已获 grant 动作所需状态，不构成执行授权；allowed_actions 是当前 grant 与已实现能力的交集，不等于自动执行或原生运行已就绪。limitations 明确 `atomic_idle_start:false`、`cancel:false`、`queue:false`，以及未知运行/订阅状态。

`ControlFactDto` 采用显式白名单，保留 owner 核查所需完整映射：request_id、operation_id、WorkRef、action、expires_at、delivery_status、attempt_id、connector_epoch、native_client_message_id、native_interface_version、expected_turn_id、receipt、reconciliation provenance、error_code、observed_at。不得把输入正文、原始 source error、凭据或数据库对象直接转发；principal 由当前 owner 已知身份验证，不让请求选择别人的主键。provenance 必须保留 pages_observed/history_exhausted/lookup_scope，不能将有界唯一伪称全历史唯一。

Core/设备沿用 64 KiB 输入、1 MiB 输出、30 秒全链 deadline（包括 owner/screen、gateway 配对、native metadata 与最终复核），错误固定枚举和 `no-store`；正文整体限额优先于 input.text 字段单独上限。尚未受理的 invalid/permission/unsupported/conflict/expired/offline 用明确错误；已经存在或可能已调用的操作返回持久 fact 的 recorded/invoking/accepted/rejected/unknown，不用 HTTP 成功声称业务完成。Core 超时发生在设备可能接受之后时，UI 保留原 operation_id 并只查询/核查，不能新造 operation 或自动再 invoke。

**S4-device 必须落实的生命周期：**

1. 由可信 `TrustedCallContext` 和 pinned pairing 派生主体，读取控制 grant 后用 `ControlAuthorization.begin` 取得绑定 endpoint/work/action/revision 的 lease。`lease.authorize` 注入对应 J/DeliveryReconciler，`lease.run("invoke"|"query", ...)` 包住异步操作与最终 DTO 输出；任何错误正文也要经过返回前复核。query 读取的 fact.action 必须匹配绑定 action，不能只因 operation_id 存在就返数据。
2. grant/pairing watcher 对每个已观察变更 `invalidate()`，包括 revoke→restore 同 revision；同时取消旧观察/在途响应，清除旧授权订阅。native 连接 epoch 变化使 state/expected epoch 失效，已发送操作保留持久 unknown/已知事实；不将取消 HTTP 等同取消 native。禁止用跨请求可变的 `currentLease` 全局变量给共享 adapter 回调授权，以免并发 owner/work 混用；采用请求绑定或明确串行/会话隔离的 callback wiring。
3. state 只能在 lease 允许的固定目标建立必要 observe 订阅；无任何 apply。重复 state 要复用仍有效观察，不因已 observe 返回 busy，也不重复 resume；grant/epoch 改变后按新 lease 重建。遇审批等待只返回原端处理提示，不自动回复批准/拒绝。snapshot 检查与实际发送之间仍有 native turn/start 竞态，不能被 state API 包装为强新轮保证。
4. query 只向当前获准 owner 返回完整映射；reconcile 每页及保存/输出前均使用原请求 lease。grant 过期/撤权与操作 expires_at 区分：操作过期不隐藏旧事实，当前 grant 无效则拒绝访问；不得为了查询而生成新调用记录或重放正文。
5. 稳定 client ID 由 J 持久分配，service 不覆盖；apply 重复同 operation 同摘要返回旧事实，不在 UI 轮询/重连时自动调用 apply。订阅、文件 watcher、计时器、store 句柄在 close/error 清理，关闭时不停止用户 daemon/任务；活跃调用退出后的持久 unknown 按 J 契约恢复。

**S4-Core 必须落实的入口：**固定 owner/screen 路由复用 I2 已修正的前后 transportCurrent/screen 检查及统一 deadline；OwnerLink 在前后都 fresh 校验当前 paired/expose、target manifest、control grant revision 与 conn epoch。普通 DeviceMember/model `/api/send` 路径继续排除全部 collaboration.*，不让新 control capabilities 形成旁路。query/reconcile 无聊天正文、无 world.send/ledger 拷贝；state/query 不带隐式 apply、query 不带隐式 reconcile。apply 属于明确操作，只复用节点 journal，Core 不新造第二本手机消息账本。返回 fact 的完整 WorkRef/request/operation 必须与请求一致，跨主体/设备/范围/过期 screen 的迟到响应不出边界。

**S4-UI 后续边界：**只有用户明确提交才持久生成一次 operation_id；相同提交重试保持 ID，主动再次发送生成新 ID。先显示本地待发送；节点 recorded/invoking 为等待确认，native accepted 为已送达而非完成，unknown 为待核实。state/actions 变化只改变可用入口，不自动应用之前文本；新状态不得静默改写已提交 operation 的 action/expected turn。乐观消息只在完整 WorkRef 与稳定原生 clientId/item 映射一致后合并；重复文本不合并。轮询/query/reconcile 均不能引起再次执行，reconcile 的 bounded provenance 保留诊断。

**S4 分段验收：**device fake 证明 state/query/reconcile 的执行写调用（turn/start + turn/steer）计数为 0；state 合法 observe 的 resume 单独计数且无 overrides，query/reconcile 不调用 resume；apply 正常/重复/并发仅一份调用意图，grant/epoch/ABA/metadata await/return await 撤权不泄漏；Core fake 证明固定路由、屏幕过期、统一 deadline、跨 owner/设备返回拒绝及 ledger 数量不增长。集成断言实际 adapter 收到落盘 native_client_message_id/native_interface_version，与返回事实一致；断线/超时后同 operation 只 query/reconcile。UI 独立 DOM 验证状态显示、唯一 operation、稳定映射合并与错误恢复。各段独立 Sol review 后再 Astra 验收，新模块通过不得宣传尚未整合的整个控制链 ready；C4–C6 真实门槛、S5、材料双向及发行仍未完成。


### 下一包 S4-I：生产 factory、device 生命周期、Core 旧入口

本包是可运行的生产代码接线，不以测试注入 factory 代替生产路径；运行测试仍只用 fake socket、临时配置和临时 SQLite，不安装真实 grant、不控制真实会话。所有权以下表为准，前述候选共享文件不构成多人写入授权。

| 包 / owner | 最小独占文件 | 前置与交付 |
| --- | --- | --- |
| S4-I-Core · core_control_wiring（已分发，Sol medium） | `packages/core/src/server.ts`、`packages/core/src/gateway/link.ts`、必要 `packages/core/src/main.ts` 与新增控制路由 tests | 只读使用已冻结 DTO/Core service；固定四路由、owner/screen 与 pairing fresh checks、统一 deadline/返回复核、no-store；普通 DeviceMember/model 不能借 collaboration.* 绕过授权，无 world.send/ledger 正文拷贝 |
| S4-I-Factory · device_control_runtime（已分发，Sol medium） | 新增 `packages/device/src/collaboration/control-runtime.ts` 与专用 runtime tests；必要拆出的配置/只读发现 helper 同属本 owner | 生产加载当前配对与控制 grant、选定 daemon 的本地配置与只读发现、独立 metadata transport、OperationStore/ControlAuthorization/DeviceControlService 装配；先冻结返回的 manifest/call/invalidate/close 与 busy/update 契约，再交 device 入口 |
| S4-I-Device · 建议同一 device owner 顺序接管 | `packages/device/src/main.ts`、`packages/device/src/link.ts`、`packages/device/src/collaboration/capabilities.ts` 与新增入口 tests | factory 契约完成后由根明确授予；四个固定 capability 分发、独立 collaboration_control manifest、断线/配对/watch/update/close 清理。CLI 真实 grant 写入暂不做 |
| S4-I-Review · 独立 Sol medium；Astra 验收 | 默认只读上述文件，新增独立 probes；修复交回 owner | 实际 factory→实际 adapter/transport→fake socket，及 Core 固定 HTTP→gateway→device 入口契约测试；不只 mock service 方法 |

Core 与 factory 可并行；device 旧入口依赖 factory 契约，推荐由同一 Sol owner 顺序完成，减少共享 main/link 交接。S1 原生文件、S2 授权、S3 journal/types/store 与已审 S4 service/protocol/watch 默认只读；确需修改时先根协调者收回原 owner 并明确转授。UI owner 待 manifest、入口与错误契约冻结后接手；生成 ui.ts/Android ash-ui 由最终构建统一处理。

**生产配置与归属发现。**必须有正式、版本化的本地 runtime 配置读取入口，至少绑定 endpoint、选定 Unix socket 的绝对路径、已安装 Codex executable 的绝对路径与明确 supportedVersions；默认缺失/损坏/不支持时控制不可用，读取功能仍可用。已有读取 endpoint 当前等于 nodeId，首包控制必须明确复用该已选实例的 endpoint 或提供显式映射，不能产生 UI 无法对应的随机新 endpoint。配置引用的是用户已选共享 daemon，不是新运行器。PID 不从研究脚本复制，也不把一次启动 PID 当永久配置：由所选 socket 的只读 listener 查询解析当前唯一 PID，再由 verifyUnixListener 核对 socket、真实 executable、版本与 identity；多 owner、路径替换、PID 复用、版本变化或无法证明当前归属均闭锁。每次新连接及 transport.verifyCurrent 使用当前证据，重启须重新发现并失效旧 epoch/lease；不能静默切换 socket/实例。这里只读检查已有 daemon，不启动/杀死/重启 daemon、不遍历所有聊天；已有 verifyUnixListener 的可执行文件检查不能被 injection 默认绕过。

**metadata 授权独立。**ControlAuthorization.begin 在 scope 创建之前已调用 metadata，因此不能令 metadata 通过 scope.allowHistory/lease.check 回调自身形成递归。factory 提供同一选定 daemon 上独立、受限的只读 metadata transport，只执行初始化及固定目标 thread/read(includeTurns:false)，验证完整 WorkRef、thread ID、绝对 cwd、listener 身份和版本；不调用 resume/start/steer，不读取正文或扫描目录。S2 在读取前已检查当前 pinned owner、grant、revision、动作和 WorkRef，读取返回后再验相同授权；factory 不从 read-scope 衍生控制权限，不借用 managed-runtime。scope 的 validateMetadata、validateHistoryMetadata、allowSubscription 分别绑定本次服务提供的 authorize/allowHistory/allowSubscription 与实际原生 metadata，不能用恒真校验或全局 currentLease。metadata 连接有界，失败/关闭清理，query 也只做必要 metadata 校验，不观察或执行。

**当前配对与资源寿命。**生产 pinnedOwnerId 必须从当前未撤销 paired.json 的 owner key 按现有身份算法派生，不缓存一份永久 owner、不接受 body principal。加载独立 collaboration-control.json，缺失 grant 拒绝。watch grant、pairing 及 runtime 配置的每个已观察事件都 invalidate；watcher 出错必须禁用控制并释放旧 scopes，而非只写日志继续使用旧 grant。断网、revoke→restore 同 revision、配置改变、升级进入与关机均失效旧请求，持久 unknown 保留。factory 统一拥有 store、metadata transport、服务 scopes 和 watcher，close 幂等；构造/配对失败亦释放全部已分配资源，不停止用户 daemon。device 更新检查必须包含控制在途调用；不得趁读 busy=false 中断控制后自动重放。HTTP/调用取消只停止等待与泄露迟到响应，不宣称取消原生任务。

**验收终点。**factory 测试覆盖默认禁用、坏配置、多 listener/错误 executable/版本、PID/identity 变化、metadata 递归隔离与零写方法、当前配对/撤权/ABA、初始化失败/关机资源释放；device 测试经过可信 from 与固定 dispatcher，控制 manifest 不冒充运行 ready，state→state→apply 保持 epoch、仅一次原生 invoke。Core 测试覆盖本地 owner/远端 owner screen、过期与撤销、fresh target manifest/grant/connection 检查、统一 deadline 与迟到响应，四路由不复制 ledger。之后独立 review 和统一 typecheck/受影响构建；无新改动与风险时不重复整套测试。

本批 S4 UI 持久 Chrome fake 链、device 接线及 lifecycle 均已通过开发层独审，统一构建完成。后续仍保留：Android/真实端链路、C4 产品路径丢回执/重启核查、C5 登录/插件兼容、C6 daemon 生命周期、S5 真实项目新建、WP-A 问题/材料/结果与跨轮反向领取、真实读取部署与 P6 普通用户安装/配对/升级发行。C2 GUI 正常对照已完成，不再作为等待项；整个 Goal 仍 active，不能因本包通过而 complete。

## 8. 停止条件与需要用户处理的情况

- 原客户端需要登录：停止工作并说明用户应在哪个客户端登录，等用户决定后按授权范围恢复。
- 需要扩大历史/项目/文件范围：先提供具体范围设置与用途，不默认开放全部；保持未授权范围拒绝。
- 已选共享入口在某个版本失效或出现新鉴权限制：报告版本、失败边界与恢复选择；不自动切私有 IPC、修改应用签名、扩大权限或换运行器。正常能力验证和已有授权内开发继续。
- 需要安装连接助手、配置桌面插件、系统权限、签名凭据或部署：先完成可审阅代码/配置/安装材料，列出用户需执行或授权的具体步骤。
- 需要 GUI 发起对照：当前 Computer Use 曾明确拒绝操作 Codex，不能换自动化方式绕过。准备独立测试会话、具体一次性输入和观测脚本后，请用户完成必要 GUI 动作；已有模拟发送/追加授权不重复申请，不向业务会话测试。

当前 S1–S4 新模块、factory、Core/device 旧入口、lifecycle 及持久 UI/Chrome fake 链已通过开发层验收，S5 A/B/C/D/E/F/G及实际创建fake链已独审放行，Core路由与UI已接且构建完成；实际gateway身份全链/Android与真实daemon仍待验收；无需用户再做 GUI 正常对照或路线选择。新的真实 control grant、读取 scope 或安装部署仍留到具体配置与恢复步骤准备后按相应授权处理。遵循用户“如果需要我介入，就停止”的要求：真正走到必须用户登录、GUI 操作、新安装/权限或产品取舍的步骤时，停止该步并报告具体需要；不反复提出已经批准的测试与重启问题，不用历史暂停状态推翻当前继续开发授权。只有全部要求实际达成才由根协调者完成 Goal。
