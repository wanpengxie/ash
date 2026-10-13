# WP-A：限定材料、问题回复与跨轮结果领取

2026-10-10 · 当前 A0-R、A1–A4、A5-L（148/148及完整TypeScript）、Android选材桥（18项JUnit）已在各自范围接受；H3研究与H-production首包接受，W-H1限定源码36项独审接受，但生产默认仍以ownership_unproven拒绝spawn，replaceable=false，原GUI及普通图标闭包未完成。R2 forward工厂与当前7个UI方法、exact-request修复已在限定范围接受。W-E1最终独审限定接受：38项材料、92项旧read/control/create/S-ID/index、2项最终旧link回归及完整TypeScript通过；不等于UI15ports、目标附件闭环、反向provider或生产work-origin完成。根已将材料贡献5→6，整体65%，其余贡献不变；本文不单独重新计分，上述测试为根同步记录，本次仅维护文档。原S-ID作者已正式接T1 W-TARGET，独占指定target新文件、control metadata私有port及R1 target proof窄hunk；原W-E1入口文件冻结，后续由入口owner串行合入。下一首用户链仍须完成phone local-node→获准既有Codex target→A1真实文件传输→ExplicitSend/S4，不以target proof或text-only代替。human/agent的真实work-source、反向receiver/canonical/receipt、完整UI15ports、H2及真机双向材料闭环继续待验。完整Goal保留两方向，本文件不授权真实环境切换、安装或业务操作。依据[产品 v0.5](CROSS-END-PRODUCT-DESIGN-V2.md)、[技术 v0.2](CROSS-END-TECHNICAL-ARCHITECTURE.md)、[内容生产协作](CONTENT-PRODUCTION-COLLABORATION.md)和[itsallsame消费者设计](ITSALLSAME-CROSS-DEVICE-INTEGRATION.md)。

**当前整合更新（根已采纳安装8/20、整体68%；最新I-SOURCE1串行包与验收见§14.25，性能路线见§14.24）：**根62061正常DOM独复1/1通过（35.34秒），作者53458同case通过（36.17秒）：固定production addon实际加载、regular/classic观察一致，正常screen经native driver私有FD导入/commit，Save零native turn，ExplicitSend精确accepted提示且native turn仅1次，刷新不重复、close清理完成。根41501的actualmain4/import5/Gate1 OS2/changeSafety2共13/13、39838的missing-addon完整fallback OS2/safety2共4/4通过；曾遗漏extra owner的current fallback已复现并修复，原最终uncached lsof/version不变。正式Core main已mount生产coordinator；这是材料首次正常UI完整组合的新里程碑，限定为本次UTF-8文件、模拟Android driver及临时synthetic native，不等于APK、用户原桌面或4 MiB真实消费。根新增settings28/28、真实OS source重启/WS终态1/1与focused恢复13/13已限定接受，详见§14.19；完整手机/助手故障恢复、4 MiB正常性能、真实host-source双向结果/明确ACK与真机继续待验。其他五项贡献不变；前文各轮状态是历史快照，以本条与§14.19为当前接受边界。

## 1. 首包产品判断

先交付人工选图、文本与小文件；原会话通过连接器工具发起一次局部请求，手机人工作答，原会话下一轮领取。手机有已验证的局部执行能力时，调用方也可经 agent_ask 请求该能力，Ash 只负责其局部请求/回复和结果关联。任务拆分、指标识别、视频制作、发布与业务验收继续由原 Codex / itsallsame / Mission 流程决定。不自动采集整机相册、历史聊天或项目全部文件，不增加 Mission 状态机。

手机主动向选定已有会话补充材料时，保存材料与发送要求是两个明确操作：只收藏不调用 send_input；明确发送才复用 S4 对同一 WorkRef 的可靠投递。S5 创建可消费相同材料引用，但不是反向闭环的前置。现有 S4/S5 text-only DTO 不可未经 owner 交接直接塞附件字段；首包可发送有来源的限定引用和领取方法，接收端实际领取后才标文件到达。

原会话无自动唤醒能力时，手机显示“结果可领取，等待原会话读取”；用户回原会话说“领取手机结果”即可继续。不能把结果保存在手机上、推送提示、模型说收到或 HTTP 200 说成已回写原会话。

## 2. 已核对复用点与缺口

| 代码 | 当前事实 | 本包边界 |
| --- | --- | --- |
| device collaboration/types.ts、codex-read.ts；Core read-service.ts、desktop-work.js | material_refs 是 reference_only，含源内容位置/类型；读取层过滤未授权路径与 URL | 保留旧读取契约；新 AssetRef 显式注册/授权，不从历史文本自动发布文件 |
| Core world/router.ts、ledger.ts | 请求 client_id、reply_to、持久 human-pending 和 agent job 是已有事实来源 | 建立外部主体与既有 request/pending/job 的受限映射；不复制第二本消息正文账本 |
| Core agent-mcp/server.ts | human_ask 立即创建持久问题并返回 waiting_owner；agent_ask 可返回 request_id；本地绑定有工具/成员权限 | 不让现有桌面客户端冒充 local owner/agent:main；human_ask 不用 await_result 等用户 |
| Core server.ts file()、ui/js/files.js | owner 文件区可有界读文件，GET/PUT 权限不同；路径、符号链接与硬链接有检查 | 复用防护实现思路，不把 workspace owner 权限当 request/asset grant；本地路径不是跨端文件 |
| device workspace.ts | workspace.read 能读文件，OS 账号是其文件系统边界，现有 MAX=4 MiB | 不授予外部接入者整个 workspace.read，也不继承 workspace.exec/write |
| Core world/post-journal.ts | 为消息呈现分类、通知投递与 held/dispatching/done/unknown 保存事实 | 通知 done 不证明附件到达、原会话领取或业务完成；不改成新跨端任务引擎 |

本轮已只读核实本地 gateway 的设备 → owner 签名 relay、大小限制和可信 from，具体证据见第4节；Ash Core/device 仍缺对应接线，手机 → device 控制通过不能推断反向已通。A3负责纯adapter，A5单owner接入固定relay；不得以公网Core local token、web_ui ownerProxy或伪造节点身份绕过缺口。

## 3. A0 当前事实与必须先完成的修订包

`material_contract` 的 `material-types.ts`、`material-protocol.ts` 与纯协议专测已经通过独立 11/11、device tsc 和额外 probes，原纯类型/parser 范围验收成立。本轮检查实际调用链后发现下列接口不足；这不撤销已有测试证据，但下游必须等修订独审后重新冻结，不能用假会话或兼容 fallback 绕过。A0 owner 独占上述三个文件，其他 owner 只读。

现有实际导出包括 `MATERIAL_LIMITS`、`MaterialProtocolError`、request/result/ref/transfer 类型、`MaterialRequestMapping`、`MaterialTrustedContext`、`MaterialAuthorizationScope`、`MaterialAuthorization`、`MaterialAssetService`、`MaterialRequestService`；parser 导出 `parseMaterialWork`、`sameMaterialWork`、`parseMaterialProvenance`、`parseAssetRef`、`parseLinkRef`、`parseContextBundle`、`parseMaterialTarget`、`parseCollaborationRequest`、`parseResultEnvelope`、`parseMaterialReply`、`assertMaterialReplyBinding`、`parseMaterialEnvelope`、`parseAssetEnvelope`、`decodeMaterialChunk`、`assertMaterialEnvelopeSize`、`materialPayloadHash`、`materialBytesHash`、`materialInlineSafe`、`parseAssetReceipt`、`toMaterialResultDto`、`toMaterialTransferDto`、`materialAwaitPolicy`、两个 `canTransitionMaterial*` 与 `assertMaterialResultBinding`。以下新增名称是交回 A0 owner 的修订规格，尚未存在于源码。

### A0-R：端点身份、问题回执与结果提交

**发现的阻挡。**`WorkRef.kind` 仅有 `conversation`；当前 request/source、return、asset offer 两端、receipt 和 trusted scope 都要求 WorkRef。手机主动补充和接收结果没有天然 Codex conversation，不能拿 request ID 或 screen ID 伪造 `native_id`。`human_material/agent_task.target_work=null` 又与 trusted scope 的强制 target_work 冲突。现有 `MaterialResultFact` 不返回 `pending_id/question_version/expires_at`，调用者无法构造合法 human reply。现有 reply 一律要求 pending 字段，已有 Codex 处理主动材料后的结果无法提交。

根已批准以下一次性修订，`material_contract` 已获原三个文件的独占修订权；完成后重新独审冻结；协议尚未发布、尚无 A1–A5 持久消费者，保留 `version:1`，将旧开发 stub 视为不兼容草稿并整体替换。禁止同时接受旧 `source_work` 与新字段、猜测缺失端点或静默迁移。如果开始修订前发现真实已写入消费者，先交根确定版本迁移，不能直接覆盖已有数据。

```ts
export type MaterialEndpointRef =
  | { kind: "node"; node_id: string; endpoint_id: string }
  | { kind: "work"; work: WorkRef };
export interface MaterialQuestionFact {
  pending_id: string;
  question_version: number;
  expires_at: number;
}
```

新增 `parseMaterialEndpoint(value)`、`sameMaterialEndpoint(a,b)`，严格判别且拒绝未知键。`node` 表示确切、已注册的材料入口或手机接收区，绝不表示该节点所有文件/会话的通配授权。`work` 必须保留四字段完整 WorkRef，并由实际连接器验证会话存在、归属、当前 scope；parser 只能证明结构。

| 类型 / helper | 精确修订与绑定规则 |
| --- | --- |
| `CollaborationRequest` | 将 `source_work` 替换为 `source: MaterialEndpointRef`；`return_to: MaterialEndpointRef` 必须与 source 完全相等。保留 `target: MaterialTarget` 与 `target_work: WorkRef|null`。`human_material/agent_task` 的 source 必须为经连接器验证的 work，target_work=null；`material_to_work` 的 source 可为经认证手机入口 node 或真实 work，target_work 必须为已选择、已授权真实 conversation，node/endpoint 与 target 一致。agent_task 才允许且必须有 capability_id。 |
| `ResultEnvelope` | 将 `source_work` 替换为 `source: MaterialEndpointRef`，其含义始终是原 request 来源；target_work 仍是结果所关联的生产会话，不是领取目的地。request_id/reply_to/source 与原 request 精确匹配。target_work 的验证保留原 helper 语义；human 无生产会话为 null，material_to_work 必须等于原目标 WorkRef。 |
| `MaterialReply` | 增加判别 `kind: "human_answer"|"work_result"`，共用 version/client_id/request_id/source/expires_at/result。human_answer 必须有 pending_id/question_version，且仅用于 human_material；work_result 禁止这两个字段，仅允许 material_to_work 的当前可信 target_work 连接器提交。agent_task 结果来自受限 ledger/job facade，不开放模型任意回填执行结果。 |
| `MaterialResultFact` | 增加 `question: MaterialQuestionFact|null`。human 请求 pending 落盘后，waiting_owner、result_available 及终态仍保留同一 question 关联；registered 尚未生成 pending 可为 null。非 human 请求必须 null。question.expires_at 不超过 request/grant，到期与旧问题版本 reply 拒绝。 |
| `AssetInputs.offer` | 将 source_work/target_work 替换为 `source: MaterialEndpointRef`、`destination: MaterialEndpointRef`。输入资产可 source→request target，结果资产可生产端→request.return_to；具体方向由受保护 request/asset grant 证明，正文端点不能授权自己。 |
| `AssetReceipt` | 将 target_work 替换为 `destination: MaterialEndpointRef`。transfer fact 的 receipt 必须匹配已落盘 offer；result fact 的 receipt 必须匹配可信 request.return_to 和当前资产授权范围，不能绑定 ResultEnvelope.target_work。 |
| `MaterialRequestMapping` | source_work 替换为 source endpoint；return_to 改 endpoint。保留 principal/client/hash/grant/epoch/request/pending/question/job 等元数据，不存 ContextBundle/问题正文/ResultEnvelope 正文。内部 store 可以增加状态、去重和关联字段。 |
| binding helpers | `assertMaterialReplyBinding` 接受完整原 request、已持久 question 或 null 与 now，按 reply.kind 检查；`assertMaterialResultBinding` 使用 request.source，并保留真实生产 target 的严格检查。receipt 所有权、去向与当前授权由服务验证，纯 DTO 不把正文当证明。 |

`MaterialTrustedContext` 去掉 source_work/target_work，改为 `source_binding: MaterialEndpointRef`；其余 principal_id/pairing_id/grant_revision/authorization_epoch/expires_at 保留且为可信注入。source_binding 是当前调用连接器实际证明的主体入口，不必与 request.source 相同：例如手机回复来自手机 node、桌面 work_result 来自被选目标 work。原会话 get/await/ack 只允许 request.return_to 所绑定的可信原主体；手机 human_answer 只允许当前获准目标 node。手机号、screen ID、native_id 字符串、模型字段都不单独构成身份。

授权 scope 使用显式判别，不使用 null 表示宽权限：

```ts
export type MaterialAuthorizationScope =
  | { kind: "discovery"; action: "discover"; target: MaterialTarget }
  | {
      kind: "request";
      action: Exclude<MaterialOperation, "discover"> | AssetOperation;
      request_id: string;
      source: MaterialEndpointRef;
      return_to: MaterialEndpointRef;
      target: MaterialEndpointRef; // 从原 request.target_work 或确切 target node 导出
      transfer: null | {
        asset_id: string; asset_version: number;
        source: MaterialEndpointRef; destination: MaterialEndpointRef;
      };
    };
```

request/asset scope 中 source、return_to、target 必须来自原 request 及当前受保护映射；transfer 仅资产操作非 null，且必须对应指定资产及方向，不能用缺失 asset 字段请求全盘权限。discover 无 request ID，但必须受当前主体对该 exact node/endpoint 的发现授权约束，不返回未授权能力。

`MaterialAuthorization.before(context,scope)` 仍返回独立 lease；`after(lease,scope)` 重验异步 I/O 后的当前权限；新增同步 `current(lease,scope):void` 供每个最终返回边界使用，避免 after 自身 await 后窗口复活旧 lease。每个 lease 捕获并验证 principal、pairing、grant revision、authorization epoch、source_binding、exact request/target/asset 和最早到期；任何观察到的 revoke→restore 都增加 epoch，不能只比当前配置内容。不同请求不共享 mutable currentLease。服务错误返回也须最后复核；调用取消只停止等待，不宣称撤回已提交字节或原生任务。

**A0-R 独审必测：**node/work 两种合法来源；human/agent 强制真实 work 结构、material_to_work 精确 target；旧 source_work/假 phone conversation 不能被适配层接受；source 与 return 不同拒绝；question 缺失/旧版本/错 pending/过期；human/work_result 形态错配；结果生产目标与接收目的地不同的合法情况；跨 node/endpoint/原生 ID 错配；资产输入与返回方向；receipt 关联；trusted 类型消费者编译；所有旧纯协议测试更新而非仅删除失败断言。根独审放行后公布实际导出签名，A1/A2/A3 才能开工。

## 4. 已核实的 ledger 与反向传输条件

检查的是本仓源码与本地安装的 `ash-gateway` v0.5.0，未连接真实 gateway/daemon、未读取凭据、未改配置。此处证明接口可实现性，不证明实际 Android/Mac 已连通。

| 位置 | 已核对事实 | 实施含义 |
| --- | --- | --- |
| `world/router.ts:createHumanQuestion`、`ledger.ts:createHumanAsk` | 前者强制 local agent、transportPrincipal=member 和 active turn；后者要求 AGENT_ID，原子写 messages/request_state/human_pending，但没有 client retry 参数 | 不能把外部 Codex 当 agent:main 或传 local=true。需 A5 单 owner 给既有账本加狭窄外部请求适配，A2 先通过有明确契约的 facade 注入。 |
| `WorldRouter.send`、`Ledger.append/retryMessage/responseTo` | send 有当前授权及 client_id 去重；append 与 request_state 一起提交，重复同正文返回原消息；retryMessage 能按可信 principal/client ID 找旧事实 | facade 复用此持久去重原则；跨数据库 claim→ledger commit→mapping bind 中断后按稳定键恢复，不制造第二条问题/执行。client_id 既有上限128，材料上限256需内部固定hash派生，不截断碰撞。 |
| `recordAgentJob/agentJob/pendingAgentJobs`、MCP `restoreJob` | job ownership 与真实 request/turn/member 匹配，responseTo 是持久结果；MCP Promise 可重建 | 不能只存活跃 Promise。A2 建外部稳定 principal 到既有事实的受限映射，不克隆 jobs/消息正文。 |
| `AgentMcpGateway` | binding token 随进程生成，context 固定 local agent；多数调用要求 active turn，await_result 可以恢复既有 job | 不导出本机 owner token、不把旧 AgentBinding 发给外部模型。新外部工具独立绑定稳定主体，跨工具会话重新认证同一 work，不能借 META_ALWAYS 绕过材料授权。 |
| gateway `client/client.ts:GatewayClient.envelope/verifyEnvelope`、`src/hub.ts:relay` | 签名 envelope 已支持 client→owner；gateway 验 from=已认证设备、路由、过期，接收端负责签名验证；Connection.send/onUnmatched 可接适配器 | A3 采用固定类型签名 relay，可在现有 gateway 协议上实现，不需要假装反向 HTTP 已有或先部署 gateway。gateway delivered 仅路由回执，不是请求/字节/领取回执。 |
| gateway `DeviceTunnels.fromDevice`、Ash `OwnerLink.onFrame/serve` | client tunnel 只能回复 owner 已打开的流；OwnerLink 当前忽略非 gw/tun envelope；web tunnel 赋予 web_ui ownerProxy 身份 | 新 relay receive/send 必须 A5 接线；禁止发送 client http.req 冒充既有支持，禁止靠 web_ui 获得 ownerProxy 绕过外部主体限制。 |

签名 relay 外层用既有 Envelope 和 `GatewayClient.envelope(type,to,payload,{ttlMs,replyTo,messageId})` / `GatewayClient.verifyEnvelope(e,currentSenderKey)`；固定 type 建议 `ash.material.request.v1` / `ash.material.response.v1`，payload 为严格 `{version:1,call_id,operation,input}` 或 `{version:1,call_id,result}` / 固定错误。operation 为 A0 两个固定集合的联合；不接受 path、native method、任意 capability。准确请求/响应 union 与 schema 由 A3 独占新增 adapter 定义，不能复制 A0 DTO。

对端 key 必须来自当前 pairing/device.list 的已验证记录，不能取 envelope/body 自报 key。除验证签名外，检查 from/to、message_id/reply_to/call_id、期限、连接 generation、外部主体绑定、当前 grant 和 exact request；拒绝另一设备或同机未绑定工具会话领取。relay 只认证设备，额外 source_binding/external principal 必须由持有私密凭据的本机连接器提供并被 Core 当前授权记录绑定。现有 Codex transport 的 thread/read 能证明会话存在，不能证明任意工具调用来自那一会话；A3 必须提交可信会话绑定的实际来源/API 证据，若宿主无法提供，明确待实现的连接器接入，不能接受模型提供 native_id 来填空。

## 5. 限额、I/O 与恢复的统一要求

沿 A0 `MATERIAL_LIMITS`：**每块原始字节40KiB，实际编码后的整个外层信封最多64KiB**；ContextBundle 文本16KiB、最多8 refs其中4 assets、单件4MiB、每请求8MiB、等待最多20秒、每主体64MiB/128文件。gateway 普通帧64KiB、tunnel帧约1MiB且tunnel块256KiB是传输事实，不放宽材料限额。relay 中 payload JSON 字符串再转义和签名都有开销，A3 必须对最终 `JSON.stringify(envelope)` 的 UTF-8 总字节复核；40KiB块不意味着任意元数据都可无限添加。

来源文件只从用户明确注册的安全句柄/限定快照读取，固定版本/hash/长度；显示名不参与磁盘路径。拒绝目录遍历、符号链接/硬链接逃逸、TOCTOU 替换、任意覆盖、错 hash、截断、超限、跨请求借用。文本/PNG/JPEG/WebP 可白名单呈现；未知 MIME 仅下载，不执行或自动内联。LinkRef 仅链接，不抓取登录内容或内网，也不产生 bytes receipt。

每次读写块、注册快照、commit、ledger I/O、结果查询/ACK 及签名验证/网络等待前后都验证当前授权，最终返回同步 current fence。watcher 错误、断线、pairing/grant/endpoint 变化使捕获 lease 失效；新连接可重新认证稳定身份读取持久事实，但旧 lease 永不复活。过期不删除去重键后重新开任务；请求事实、字节 receipt、领取 ACK、业务验收分别保存。结果领取和 native accepted 均不等于业务完成。

临时上传默认1小时清理，已提交资产默认7天且不超过 grant/asset 到期；容量满拒绝新数据。GC 保留 request/client/asset版本的有界去重 tombstone；不确定记录不能为腾空间被删到允许重放，达到元数据容量时拒绝新请求。每次清理有批量/时间预算；恢复不扫描整个工作区或全历史。过期结果返回已过期/不可领取而不是假装从未存在。

## 6. A1–A3 工作包（A0-R 17项及独审通过，A1/A2已派发）

所有权仅在根实际分发后生效；本文不启动 agent。三个包只新增自身文件，旧 main/link/gateway/server/agent-mcp/ledger/router/UI 和 S4/S5 文件全部只读。接口需要改动时交回原 owner，不自行补 fallback。

### A1：不可变资产与可恢复分块

**独占：**device `collaboration/material-store.ts`、`material-transfer.ts`，专用 store/transfer tests。Core 后续只读复用同一实现或注入受同协议验证的后端，不再造另一套资产语义。

**导出契约：**`MaterialAssetStore`、`MaterialAssetStoreOptions`、`MaterialTransferService implements MaterialAssetService`、`MaterialTransferServiceOptions`。options 至少提供 rootDir、clock、授权注入和仅收紧的测试 limits；store 本身不接任意模型路径。transfer service 的 `invoke<K extends AssetOperation>` 精确实现修订 A0 返回类型。owner 冻结 `registerSnapshot`、`offer/getTransfer`、`putChunk`、`commit`、`readChunk`、`ack`、`collectExpired`、`close` 的实际内部签名，参数必须含受信 principal/request/asset版本/端点与lease；仅 invoke 是 wire操作。`registerSnapshot` 只接受调用方已打开并验证的句柄/限定字节源，返回 AssetRef，不兼做业务提交。

**持久化：**受保护 metadata 索引 principal/request/asset/version/hash、端点、grant revision/epoch、期限、transfer ID、块摘要/bitmap、原子提交和 receipt；字节放独立受控目录。先持久预留配额，再接收块；offer 同主体同request/asset版本/端点/摘要返回同 transfer 和缺块事实，冲突拒绝。块使用固定 index/offset/最大长度，乱序可恢复，重复同 bytes 幂等、不同 bytes conflict。完整长度与SHA-256通过、文件及metadata达到约定durability边界后才返回 receipt；ack 丢失可查原receipt。rename前后、文件同步与metadata提交之间故障恢复必须给出可核查事实，证据不足保留unknown，不从孤立文件名猜测已提交。

**验收：**实际临时文件和真实store重开，两个独立实例经fake transport分块；零字节/尾块/4MiB边界、编码64KiB、断线缺块、重复并发/错块、错误hash、软硬链接/替换、容量预留与失败释放、到期GC/tombstone、commit/ACK丢失、revoke→restore各I/O窗口、wrong principal/request/asset/endpoint。同版本字节永不改变；一次注册/读取不调用send_input、native或ledger业务。A1通过只证明资产服务，未接线的手机双向仍pending。

### A2：既有 ledger 的受限请求与领取 facade

**独占：**Core `collaboration/material-request-service.ts`、`material-request-store.ts`、`material-ledger-facade.ts` 与专测。最后一文件是窄接口与只读可复用查询适配，不授予旧ledger/router写权。

**导出契约：**`MaterialRequestStore`、`MaterialRequestStoreOptions`、`CoreMaterialRequestService implements MaterialRequestService`、`MaterialRequestServiceOptions`、`MaterialLedgerFacade`、`MaterialLedgerLocator`、`MaterialLedgerSnapshot`。locator仅 ledger_request_id/pending_id/question_version/job_id；snapshot以既有request正文、pending/job/response为唯一来源，返回值可内存投影但store禁止保存第二份正文。

facade 明确方法：`accept(request, binding, stableKey)` 原子接受或按同摘要查回原 locator；`lookup(binding,stableKey)` 只读恢复；`read(locator,binding)` 读已有 request/pending/job/response；`answer(reply,binding,stableKey)` 按既有question或work-result规则单次提交同一响应；`wait(locator,binding,deadline,signal)` 只重建有界观察、不启动或取消业务。binding 是可信 principal/source_binding/current grant 与受限外部成员映射，不是 AgentBinding 或 body principal。stableKey由 principal+client_id+操作命名空间规范hash得到，不截断到现有128字节上限。`accept/answer` 必须原子包含 ledger 去重与事实；生产实现不具备此保证时明确未装配，不能用先createHumanQuestion后另存映射冒充 crash-safe。

**生产缺口交给 A5：**为 ledger/router 增加受限 external request admission 与 question去重/外部ownership、工作结果写入；复用现有 messages/request_state/human_pending/responseTo/agent job，不建立另一消息表。外部身份是显式映射的受限成员，不宣称其为本地 native agent turn；不得放宽通用 agent MCP权限、frozen-action redeem或整机 capability。A2先用实现同一契约的故障注入facade验证服务，生产接线通过实际ledger后才能验收真实闭环。

**store事实：**principal/client/request/payload摘要、source/return/target绑定、revision/epoch、期限、状态、stableKey/locator、提交意图、question版本、result版本、reply去重、receipt ID、claimed_result_version与tombstone。请求正文只交ledger一次；结果正文从ledger/pending/job恢复。store claim提交后ledger已提交但mapping未保存，重启必须lookup稳定键恢复；无法判定就unknown且不重发。同principal+client同摘要返回原事实、不同摘要conflict；另一principal无权查碰撞ID。human submit立即waiting_owner及完整question；human await立即返回，不长轮询；agent running await最多20s，超时仍同request，断开不取消。

结果receipt只在 destination=request.return_to、当前资产grant、版本/hash/长度精确匹配时关联；ack_result携带明确result_version，重复幂等、错误版本拒绝。get_result无隐式发送、下载、业务调用或ACK；实际受控下载验证之后才写字节receipt，明确消费之后才写领取ACK。不能把post通知done视为领取。每步authorization before/after/current，恢复后重新认证同稳定来源；过期/撤权不能通过历史mapping读取结果。

**验收：**真实service/store+故障facade的accept/answer边界重启、并发重复零新增问题/任务；human与work_result错形态、旧question、错来源/目的地、迟到结果、错版本ACK、partial assets、被删原会话、撤权ABA、turn结束与工具进程重启后领取。与实际ledger的集成列为A5硬门槛，不能仅凭mock facade通过宣称生产已通。

### A3：签名反向 relay 与可信外部会话 adapter

**独占：**device `collaboration/material-client.ts`、`external-collaboration-tools.ts`；Core `collaboration/material-gateway.ts`；新fake relay/identity tests。不修改现有link、main、agent-mcp或gateway包。

**导出契约：**`MaterialClient`、`MaterialClientOptions`、`ExternalCollaborationTools`、`ExternalMaterialBindingProvider`、`MaterialGatewayAdapter`、`MaterialGatewayAdapterOptions`，固定 request/response discriminator 与白名单。Client提供 `invoke`/`invokeAsset`/`acceptFrame`/`invalidate`/`close`；GatewayAdapter提供 `acceptFrame`/`invalidate`/`close` 并注入已冻结A1/A2服务。transport port只允许发送签名frame、获取当前对端key/身份/连接generation和同步current fence；不暴露任意HTTP URL或raw gateway control给模型。

`ExternalMaterialBindingProvider.acquire()` 从连接器持有的凭据及实际宿主会话绑定取得稳定principal与source_binding；`current(binding)` 检查同连接/会话/当前grant，返回时再核查。跨turn/工具重启以重新认证恢复稳定主体，不能复用旧lease。手机主动入口绑定当前owner/screen与具体手机node材料入口；桌面human请求绑定真实现有WorkRef。owner需给出其可实现的具体宿主/API证据及最小接线需求，尤其区分“thread存在”与“这个工具调用有权代表该thread”；没有证据先报告根，不偷偷缩成任意本地脚本可取结果。

固定操作 discover/submit/reply/get_result/await_result/ack_result 与 offer/put_chunk/commit/read_chunk/ack；tools只展示当前可用白名单，model不接触签名key或owner token。凭据不因模型知道request_id或同机进程而共享。每个frame限64KiB，累计并发和inflight map有上限，等待用统一deadline（await业务最多20s，外层固定30s预算内）；超时/close删除waiter、丢弃迟到响应，不从client自动重发submit/reply/S4业务。明确重试由相同幂等键查回持久事实，transfer仅重传缺块。

签名验证前先做大小/结构/固定type检查，再当前pairing查key、验证签名、检查完整绑定和时效；异步签名验证、设备列表与服务I/O前后都检查epoch，最终发送前同步fence。request envelope message_id可重放不导致再业务，response必须严格绑定当前call_id/reply_to及预期from/to；传输ACK不转换为应用成功。失效或不可用能力返回明确unsupported/offline，禁止降级为web_ui ownerProxy。

**验收：**两个独立endpoint/fake socket与实际签名生成/验证、本地gateway路由规则等价fixture；非法签名、过期、另一个设备、同机未绑定会话、错误reply_to、ABA、断线/重启/迟到response、外层64KiB边界、waiter清理。另测gateway `DeviceTunnels.fromDevice`拒绝client自建http.req，避免fixture提供生产不存在的反向能力。A3只证明adapter，A5必须接实际OwnerLink/ClientLink与真实连接器入口；Android/Mac与原会话跨轮验收仍在A6。

## 7. 后续接线、验收与完整范围

A0-R已获根批准→A0 owner实现→独审重冻→A1/A2/A3独占新增包→A4手机UI/A5单owner旧入口→A6独审。A4新增 desktop-materials.js/store 与UI专测，人工选图、绑定问题、保存/明确发送、引用/到端/领取分层；现有human-pending/files/net/app最小挂载由根交接。A5顺序独占device main/link/capabilities/runtime、Core server/gateway/main/agent-mcp及必要ledger/router，装配真实身份、固定relay、durable facade、store与watch/close生命周期；不得让A2/A3并改旧入口。生成产物仅根统一构建。

两条必须实际验收的链：

1. 手机可信node主动选材料→指定真实已有Codex WorkRef→分块到电脑并核hash→用户明确发送经既有S4可靠投递→该原会话以当前可信work绑定注册结果→结果回到原手机node并实际读取核hash。只保存不send；S5可以后消费相同引用，不是此闭环前置。
2. 原Codex可信work工具submit human_material→返回持久request/question→当前turn结束→手机人工回答或说明无法提供→原会话后轮/工具重启重新认证get_result→受控本地文件核hash→显式ack_result。无自动唤醒时显示“结果可领取，等待原会话读取”，不能用活跃Promise或模型自称收到替代领取。

agent_task仅限已声明、已授权手机局部能力，由原业务端决定如何拆解；不引入Mission状态机或自动审批。缺能力如实unsupported，不制造自动操作能力。

A6独审同时验证手机离线/挂起、断网/ACK丢失、原会话删除、部分资产、错误hash/源替换、主体和exact endpoint错配、容量/GC/unknown、重启与ABA；通知不改变文件或领取状态。开发fake必须经过实际service/store/transport的两个端点，不以同进程复制文件或预制fact代替。真实G-Asset/G-Bidirectional须获准Android↔Mac与原会话完成合成图双向、跨轮及结果反向实际读取；fake/Chrome不算真机。

当前根整体56/100，按能力证据15+18+12+6+0+5计分，不按测试数量累加。A0纯协议通过未计材料闭环完成。Android/macOS双向、原会话跨轮领取、S4 C4–C6真实故障/登录插件/daemon生命周期、S5真实创建、真实读取部署和普通用户无CLI安装/配对/升级全部保留。本文只准备开发分包，不连接真实daemon、不写真实grant/配置、不安装或部署，不替用户收缩原Goal。

2026-10-10实际分发：A0-R独立17项/tsc/异步current编译负向probe通过，新导出冻结。material_asset_store独占A1新store/transfer及tests；material_request_service独占A2新request-service/store/ledger-facade及tests。旧入口及A0文件只读；A3暂无owner，等待并发槽与稳定服务ports。两个实现者不得复制ledger正文、假phoneWorkRef或启动原生任务；实际身份/relay/ledger写接线仍属后续A5硬门槛。

## 8. A4/A5 执行 packet（2026-10-10，实际 ports 核对版）

本节覆盖第7节早期分包状态，以根的实际授予为准，不自行启动实现者。A1/A2 初次独审仅放行资产及请求服务；A1-R 后续修订另行收口，A3 已完成后续独审。旧 link 不可交叉修改。根状态文档只读。所有下列新增名称均为**待实现名称**，不冒充已存在导出。

### 8.1 文件所有权、依赖与顺序

| Packet | 建议独占文件 | 依赖与交接条件 |
| --- | --- | --- |
| A4-UI | 新增 `packages/core/ui/js/desktop-materials.js`、`desktop-materials-store.js`、专用 unit/Chrome tests | 可与 A5 新模块并行；仅注入冻结的 view/API port，不改旧 app/net/desktop-work/human-pending/files。挂载清单交根后由一个入口 owner 最小接线。 |
| A5-L ledger | 新增 `packages/core/src/collaboration/material-durable-ledger.ts`、实际 ledger 专测；根另行授予 `world/ledger.ts`、`world/router.ts` 的狭窄修改权 | A2 facade 为冻结依赖；单 owner 负责 SQLite 事务与 router 受限 admission；不让 A2 实现者并改旧账本。可以先于旧 link 解冻。 |
| A5-R receipt/auth/runtime | 新增 Core `collaboration/material-receipt-index.ts`、`material-runtime.ts`、`material-authorization.ts` 和 device `collaboration/material-runtime.ts`、`material-host-binding.ts` 及专测 | 复用 A1/A2；原 A1/A2 文件只读，必要接口变化交原 owner 重审。receipt index 只保存定位元数据。host binding 默认关闭直到8.5门槛成立。 |
| A5-H host research | 新增隔离 fixture/test 与宿主证据报告，建议 `packages/device/test/fixtures/material-host-ownership/` | 可以与其他新模块并行；测试计划先交根，不能运行真实 daemon、真实模型、安装或写真实配置。若授权隔离运行，只运行一次性临时 home/mock model。 |
| A5-W 旧入口接线 | Core `main.ts`、`server.ts`、`gateway/link.ts`；device `main.ts`、`link.ts`、必要 capabilities/runtime；专用入口 tests | setup 最终独审后根显式交接；A3 独审冻结后才能消费 relay。只由一个 owner 顺序接线。现有 agent-mcp 不开放权限；只有确有 host bridge 需求且根授予后才最小修改。 |
| A6 独审/全链 | 新增独立实际链测试；所有实现文件只读 | 开发链、宿主链与真机链分别签字。生成 `core/src/ui.ts`、Android UI 和 dist 仅根统一构建，不由并行 owner 写。 |

A4 与 A5 先冻结共享浏览器 port：`listRequests(cursor,limit)`、`getRequest(requestId)`、`invoke(operation,input)`、`invokeAsset(operation,input)`、`saveSelectedFile(file,requestBinding)`、`readCommittedAsset(assetBinding)`、`sendSavedMaterial(s4Operation)`。这只是宿主注入 API，不扩展 A0 wire operation；列表与本地注册是受认证 UI 入口，必须分页、有界且按当前 screen/principal 与 exact node/work 过滤。不得用 `get_result` 的来源授权充当手机目标收件箱授权；手机待回答问题从受限 ledger projection 读取，不能通过任意 `human_pending` 列表继承全 owner 权限。端点具体 URL 由 A5-W 单 owner 与 A4 冻结，浏览器不接触 binding secret、签名 key、local AgentBinding 或任意 HTTP forwarding。

### 8.2 冻结的实际源码接口与新增接线职责

- A1 `MaterialAssetStore` 当前实际方法为 `registerSnapshot(offer,{handle,user_registered:true},binding):Promise<AssetRef>`、`offer`、`getTransfer(commitInput,binding)`、`putChunk`、`commit`、`readChunk`、`ack`、`collectExpired`、`close`。`MaterialStoreBinding={context,lease,scope}`；浏览器 `File` 不能直接当 FileHandle。受认证上传先写受控临时文件，核对 File 选择行为及长度/hash，然后以已打开句柄注册；注册文件不能从模型提供路径打开。临时文件路径只在连接器内部流转。
- A1 `MaterialTransferServiceOptions` 为 `store,authorization,currentContext,resolveScope`；`resolveScope` 从 protected request、asset grant、固定方向生成 scope，不能照抄 input 作为权限来源。`getTransfer` 是内部查询，不存在新的 wire `get_transfer`；恢复可重复同 offer 获得缺块，或由可信内部查询取得原事实。
- A2 `MaterialLedgerBinding={context,owner_principal_id,external_member_id}`；生产 facade 必须实现 `accept/lookup/read/answer/wait`，返回 `MaterialLedgerLocator` 和 `MaterialLedgerSnapshot`。`MaterialLedgerQueries` 仅暴露既有查询，不负责外部 admission；`UnsupportedMaterialLedgerFacade` 不可装进已标 ready 的生产 runtime。
- A2 `CoreMaterialRequestService` 注入 `currentContext/resolveExternalMember/readReceipt/discover`；`attachReceipt(requestId,resultVersion,receiptId,context)` 仅是可信内部入口。receipt 字段不能由 relay 的 reply 或 UI 自报注入。`get_result` 不下载、不 ACK、不 `send_input`。
- A3 当前实际 `MaterialRelayTransport` 为 `capture():Promise<MaterialRelayPeer>`、同步 `current(peer):undefined`、同步 `send(envelope):undefined`；peer 固定 `local_id,peer_id,public_key,pairing_id,generation`。`MaterialCallBinding` 固定 `binding_id,deadline?,current`。`ExternalMaterialBindingProvider` 固定 `acquire/current/available`，Core resolver 固定 `resolve(bindingId,peer)` 返回 `{context,current}`。这些端口待 A3 最终独审冻结，A5 不另造兼容 fallback。
- 实际 relay payload 含 `binding_id`；它只是查表句柄。resolver 必须同时验证当前签名设备/pairing、已认证 connector session 与受保护 work/node 绑定。拿到另一会话的句柄仍不得领取。`transport.send` 要在最终 socket 写入前同步 fence；A3 内部 fence 不能替代外层封包/HTTP serializer 的 fence。

### 8.3 A5-L：唯一正文账本、稳定去重与外部受限成员

**事实边界。**现有 `Ledger.createHumanAsk` 在一个事务写 messages/request_state/human_pending，但只允许 AGENT_ID，且没有 client retry；`WorldRouter.createHumanQuestion` 只允许当前 local agent turn。不能调用它再补一张材料映射表。现有 `Ledger.append` 原子带 client_retries 与 request_state，retry clientId 最长128；`responseTo/settle`、agent_jobs、human_pending 是既有事实来源。

**实现要求。**新增专用 admission/answer ledger 方法，由生产 facade/router 狭窄调用；正文写入既有 `messages.body`，metadata 表只保存 stable key/hash、外部 principal/member、request/response/pending/job定位、question/result版本、期限和状态。完整 CollaborationRequest 只存一次，human UI 的 title/detail 从它投影；若需既有 ask 格式，给 humanPending/projector 增加材料分支，不在另一条 ask 消息复制 ContextBundle。MaterialReply/ResultEnvelope 正文以既有 response 消息为唯一来源，其他表仅引用。

受保护注册把稳定 external principal 映射为独立受限 member（确切语法由 owner 对齐 MemberStore/parser），禁止 `agent:main`、local=true、ownerProxy=true 或伪造 native turn。它只有指定 request 的材料 admission/query/reply 权限，不自动注册一般 world words、整机文件能力、审批 redeem 或任意 capability。human_pending 中的外部 ownership 允许单独表示，旧 local human_ask 与 frozen-action 权限保持原检查。手机 human_answer 的 actor 与 request owner 分开核验：目标手机可回答同一问题，不能凭 request ID 查询原会话其他结果。

每个 `accept` 的 BEGIN IMMEDIATE 事务同时完成：检查完整 trusted ownership→按稳定键检查原 payload hash→写唯一 request 消息/request_state→按 kind 写 human_pending 或真实 job 关联→写稳定去重/ownership 元数据→COMMIT。stable key 由 A2 提供的固定长度 hash 派生到 ledger 命名空间，必须明确涵盖 principal、client_id、operation；不能截断 client_id、使用随机 ID 作 dedupe 或把易变 grant revision 纳入逻辑 request identity。撤权恢复只能在新认证后查询同一事实，不产生第二个任务。

`answer` 同一事务检查原 request 与 question/pending/current state、匹配回复 kind/source/target、到期、result_version，然后写一次 canonical response、human_pending transition、reply stable-key/hash 和事件元数据。相同 retry 返回原 locator，不同正文 conflict。现有 `settle` 的“已有 response 则返回”不足以单独证明 reply stable key/hash；如需复用 SQL，抽成同一事务内的 private helper，不能嵌套调用会开启独立事务的公用方法。late/expired、旧 question、跨主体均不写入。

`material_to_work.accept` 只持久登记材料请求，不隐式调用 S4；S4 明确发送是独立 operation 并引用原 request。`human_material` 创建可恢复待回答事实且立即返回 question。`agent_task` 只映射到真实受限 router request/job，任务 dispatch 与可靠状态先落盘，不能用材料 facade 自己启动任意模型。每类 read 从 canonical ledger 恢复；没有足够证据返回 unknown，不按内存 Promise 推断完成。`wait` 仅订阅/有界轮询现有事实，关闭观察不取消任务；重启重新观察同 locator。

**必须用实际 Ledger 的验证：**新临时 DB，两个实例/进程竞争相同键；accept 前/事务内/COMMIT 后/A2 mapping 前崩溃；answer 同边界崩溃；重开后 request、human_pending、response/job 数量均唯一，原 locator 与摘要不变；不同正文 conflict；错误 external principal/target/source/旧 question/result version/到期/已删除会话拒绝；agent_task 在 claim/dispatch/response 丢回执后不重复启动。检查 canonical messages 与 metadata table 的实际行，证明 metadata 无 ContextBundle、问题正文、ResultEnvelope 的第二份存储。回归现有 human question、approval、router retry 与 agent jobs。

### 8.4 A5-R/W：receipt 双阶段、实际 relay 与生命周期

**Receipt。**新增有界 metadata index：`receipt_id → owner_principal/request_id/result_version/transfer_id/asset_id/version/hash/length/source/destination/commit_store_locator/expiry`，且索引保存配对与授权关联，不保存正文/字节，不扫描目录猜 receipt。只有 A1 实际 `commit` 成功后建立索引；若 commit 成功但 index 写入前崩溃，恢复凭原 transfer 的受保护 locator 调 A1 `getTransfer` 验证原 receipt 后补索引，不重新传/新建 receipt。索引写失败保持“字节已提交、结果关联待恢复”，不能输出假 partial 完成。

A2 `readReceipt` 的第一调用 scope.transfer=null：只在当前请求 ownership 与 expiry 下查 receipt 元数据，返回候选 receipt；这一步不打开文件、不生成资产授权。第二调用 scope.transfer 非 null：比较完整 principal/request/asset版本/方向/当前grant/epoch后，用相同授权 lease 构造 A1 binding，调用实际 `getTransfer({version,request_id,transfer_id,asset_id,asset_version},binding)` 并核验 committed/acknowledged 与全 receipt。A1不认可或重开后unknown则不能证明到端。A2已有 exact scope re-read 和每次最终 current fence，A5不得退化为同一 Map 两次读取。receipt 究竟证明 Core缓存、电脑还是手机端必须由 destination/store locator 真实决定；Core暂存不能冒充最终手机 destination。

**A1/A2身份接合技术裁定。**采用第9节的独立受信request-scoped custody resolver：A0 context继续表示真实actor，A1以受保护custody owner索引/配额，以当前actor+pairing+source_binding授权具体动作。禁止改写context冒充原owner，禁止same-principal fixture掩盖跨端身份。第9节覆盖本节早先二选一建议，由根授予原owner实施并独审，无需用户决定常规实现方式。

**手机到端部署事实修正。**只读核实Android `CoreService.kt`在本机运行ash-core，`Paths.kt`把state放在app-private files/ash/state。生产factory若证明A1 root确实在这个手机私有目录、store物理node与receipt.destination绑定，A1 commit就是手机到端证据，不需要另造Kotlin字节账本。Android bridge仅接系统picker、限定导入/读回和明确消费；浏览器hash或任意路径不能签发receipt。远程服务器Core的缓存仍只能标“可下载”，不能冒充phone destination；这类部署应把bytes交付手机实际store后再出receipt。源端registerSnapshot也不能因offer.destination写了远端而被当作远端到达，详见9.4。


**Relay。**Core `OwnerLink.onFrame` 和 device `ClientLink.onFrame` 在原 gw/tun 分支外仅接固定两个 material type，交 A3 `acceptFrame`；未知type继续拒绝。A3 当前设计一次 capture 对应一个 exact peer，多设备 Core 需每当前 pairing 的有界 adapter/transport 或等效 exact peer factory，不能任取首个 device。peer key 必须保留 gateway authenticated device.list 的当前 pubkey；现有 Core paired display DTO 不含 pubkey，A5需保存已验证材料 peer 记录，不能用 envelope key。device 从当前受保护 pairing 的 owner_key 取得 key。仍经真实 GatewayClient.envelope/verifyEnvelope 与 Connection.send，不使用 client 自建 http.req。

OwnerLink 的 `device.presence` 到达立即推进材料 generation 并 invalidate，不能等异步 refreshDevices 完成；refresh结果过期不得恢复旧 generation。ClientLink 断线、LocalStateTransaction状态变化、pairing owner替换/revoke、stop 同时失效材料。增加当前 grant/endpoint registry/host connector generation watcher，watch error或不确定状态立即拒绝新调用并失效旧lease；同步 current 还要读受保护最新状态，不能仅信watch通知或轮询间隔。禁止用 grant内容恢复相同值复活旧lease。

服务成功/失败结果在 HTTP/tunnel/tool response 最外写出前都保留私有 current fence（可复用已有 WeakMap模式，不能把函数序列化到wire）。同步检查身份、pairing、grant、endpoint、host session、deadline、result资产lease；JSON.stringify、签名与socket ready等待中的撤权/ABA必须被拒绝。发送只接受已核64KiB完整签名信封，32 inflight等A3上限不扩大，响应错误不可成为未授权查询oracle。

Runtime工厂先装 authorization→stores/index→durable facade→services→relay/binding；未完成可信host入口时不 advertise 可用桌面tools。disconnect只取消观察、失效会话和清waiter；不删dedupe或已提交字节。shutdown先禁新调用和失效generation、关watch/adapter，等已入场store I/O达到可恢复边界，再关store/index，最后关ledger；重复close与startup半失败都收尾。GC有预算/上限，expiry保留tombstone，不因容量重放旧请求。setup锁修复必须独审完成再接这些watch，不能在不可信状态根上加材料配置。

**实际入口必测。**保留实际 OwnerLink、ClientLink、GatewayClient签名/验证、A1/A2/ledger，只替换外部网络socket与模型响应；测试fixture须使用真实gateway路由判定或直接实例化隔离hub，不许fixture支持生产不支持的client http.req。双向request/result与bytes流经两个独立端点，测presence先于refresh、断线/ABA、错误reply_to/call_id/from、签名期间撤权、最外序列化期间撤权、超64KiB、并发上限、late response、close/startup失败无watch/timer/socket泄漏；S4/S5原真实入口回归不能省略。

### 8.5 A5-H：原桌面已有会话的可信工具身份硬门槛

本地证据见 [host binding evidence](../packages/device/test/fixtures/material-host-binding-evidence.md)：桌面bundled `0.162.0-alpha.17.2` 的 start 有dynamicTools、resume无该字段；server item/tool/call 有thread/turn/call，未证明connection ownership。额外只读核对 `ThreadSettingsUpdateParams` 只见disabledPluginIds等设置，无dynamicTools更新；`McpServerToolCallParams` 的threadId来自调用方RPC，不能单独当模型调用归属。现有 Ash `agents/codex.ts` 是独立进程创建的会话，不能代替这个目标。

[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)说明dynamicTools在start实验注册、写入rollout并可在resume恢复，也说明item/tool/call的client响应流程；它没有为本地这个版本证明“给任意已有桌面thread添加工具”或多连接的专属派发。文档说明与bundled schema均不足以宣称安全可用；不能借文档的resume措辞向schema私塞字段。以下保留原实验设计；H0 已实际运行，结论由第11节覆盖。H1/H2 未放行。

**H0隔离实验证明协议行为。**临时0700目录、专用临时home/配置/空凭据、本机mock Responses服务、bundled二进制、loopback或私有socket；测试进程禁止外网，固定启动/关闭deadline，输出仅合成ID及无密钥事件。只允许测试进程创建/关闭自己的app-server，不能连接真实desktop daemon或拷贝真实rollout。先人工代码审查fixture的所有路径/端口，再由根按现有授权决定运行，不把“需要实验证据”当授权真实环境。

1. A连接创建有固定合成dynamic tool的thread T；A2连接创建无tool的既有thread U。仅mock模型返回固定tool call，不执行shell/真实业务。
2. B独立连接initialize后read/resume T/U，不提供config override。记录A/B收到的server request、真实connection generation和thread/turn/call。B抢先回答A的request ID、相同ID不同call、其他thread/call、重复回答必须不能劫持；若server广播/接受任意连接回答，A3 provider不能把收到event本身视为独占可信凭据。
3. A断开/reconnect，B仍在线；跨turn与重启T是否恢复tool、pending call如何清理、错误连接回答是否生效。ID只做关联；provider必须依赖已认证宿主私有channel，而非知道这些字符串。
4. U从未注册tool。仅尝试官方/schema明确支持的MCP/plugin加载或host提供的attach入口，验证U native_id不变、原历史连续、原客户端继续拥有执行。若没有入口，实验应得到“旧会话attach尚无证据”，不能把新建T通过包装成旧会话成功。

**H1生产可行路线，按证据选择。**优先官方桌面可装的MCP/plugin，但其认证必须由宿主提供不可由模型改写的per-invocation thread/turn/call metadata，并通过私有connector credential/transport关联实际宿主；普通MCP token只证明工具用户，不证明当前thread。候选实现可由宿主受信扩展在工具派发时把这些坐标签入短时单次challenge，Ash验证签名与当前host generation；跨轮通过同一个受保护work记录重新签发，不复用旧lease。若桌面插件机制没有这个能力，需要宿主bridge/上游接口支持，不能通过模型参数、环境变量自报、通用session ID、查历史tool文本或读取thread就补齐。

第二候选是连接原桌面共享app-server的host bridge：必须有正式既有thread工具注册入口和连接专属派发/响应ownership，且桌面GUI保持原native_id及活动turn。H0只证明合成协议行为，仍需H2真实桌面验证。禁止在桥中启动Ash runner、fork/resume到另一个独立执行器、修改rollout元数据、接管整个桌面工具通道，或给外部模型发localagent token。

若两路线当前版本都缺关键API，保留全部双向目标与H门槛，继续A4/A5-L/R/W；根需选择“实现/等待宿主bridge支持或升级到已验证版本”的产品/平台取舍。不得自行把“用户指定一个thread、给通用工具token”视为等价，也不得以unsupported结束Goal。unsupported仅是未就绪期间真实能力发现结果。

**H2验收输出。**记录原桌面WorkRef、安装版本、受信connector认证来源、服务端派发与接收连接、跨轮重新认证、旧连接拒绝、同机另thread/工具会话拒绝；tool input schema不出现可选择principal/source/native_id的身份字段。模型可以提供目标WorkRef以请求操作，但source必须宿主推导；所有host event内坐标与当前授权/连接绑定后才进入A3。测试应证明原GUI同一thread正常继续、不同thread不能领取，工具重启后同主体可恢复，撤权再恢复旧binding不可用。

### 8.6 A4：手机选材、问题回复、分层状态与恢复

UI新增模块接入原会话详情/需回答问题/结果入口，展示精确目标与来源，不复制完整聊天。手机原生File picker只收用户选中的文件，取消不建request、不上传、不发送；无相册扫描或广泛媒体权限。文本、链接、单图/小文件沿A0限额；未知MIME仅下载。图片呈现只用已验证bytes生成的受限blob URL并释放，HTML/脚本/文件名/材料正文均按数据转义。

store分为本地草稿/已提交事实引用。选定bytes如需跨reload保存，用有界IndexedDB或Android私有存储，禁止base64塞localStorage；元数据、草稿文本、file总字节和条数都有硬上限，scope由origin+当前owner/screen+phone endpoint+pairing/grant generation分隔。scope变更立刻清可见缓存与blob URL，持久缓存不能绕过重新授权；quota/unavailable明确“尚未可靠保存”，不能显示已收藏。用户主动收藏才持久保存草稿；敏感正文不要无意随状态缓存到普通localStorage。

“保存材料”完成本地保存或已授权材料注册，只得到明确保存位置，不调用send_input。只有明确“发送到此会话”形成S4稳定operation/client_message_id，S4文本只包含限定来源引用与领取方法；不擅改S4 text-only DTO。发送前检查所选WorkRef仍匹配，展示已到电脑/仍在上传的各个资产；允许部分材料发送时明确列出缺少项，不等待失败文件后悄悄触发额外业务。离线/unknown先查原operation，不自动新建client ID或重发任务。

手机问题页锁定request_id/pending_id/question_version/expiry和来源WorkRef，允许选图、文字回答或明确无法提供；普通“可以”不能回答其他question或批准业务动作。提交human_answer立即显示“已回答，结果可领取，等待原会话读取”；原会话后续可信get_result+实际下载核hash+显式ack_result才前进到“原会话已领取”。现有human-pending.js的“已回答，等待Ash继续”不能照搬为已有Codex回写证据。

同一记录并列呈现：本地已保存、请求已接收、每资产传输进度/目的端commit receipt、result_available/partial/missing、claimed_result_version、业务未验收。LinkRef无bytes receipt；HTTP200/网关delivered/native accepted/通知done都不能增加文件到端或领取状态。后到旧fact不能覆盖已知request/work/question/result版本或receipt；同版本正文/身份变动conflict，更新观测时间不代表更强事实。结果只完成部分资产时显示例如“2/3文件可读，1个待重试”；结果文本可领取与全部文件可读分别呈现，明确消费的版本才ACK。

页面隐藏/切换scope停止轮询和等待，恢复只查询原request/transfer/operation；手机挂起未交付显示“打开Ash后重试”。删除原会话不自动重定向，结果仍按当前授权呈现可用事实并由用户另选目的地走新授权。UI不得自动attachReceipt；可信手机bridge/A5处理字节事实。A4 owner交付存储迁移/上限、input File、quota、重启恢复、partial、stale facts、scope切换、问题过期、取消/双击、保存零S4调用、明确发送一次S4 operation的unit及Chrome测试；Chrome不替代Android File picker与app生命周期验收。

### 8.7 完成标准、实际双向闭环及必须用户步骤

开发独审必须使用实际ledger+request store/service+asset store/transfer+签名relay+实际入口，而非fault facade或预置fact收尾。两端用独立受控目录与独立endpoint，只经协议传块；producer和consumer各读bytes核SHA-256。必须覆盖先传输入/后回结果、原turn结束/工具重启/手机重开、丢commit/ledger/reply/ACK回执、partial和unknown、原会话删除、错scope、ABA、容量GC与watch失败。A1/A2/A3单包通过不能替代这个组合证明。

G-Asset/G-Bidirectional保留以下**真机与原会话**脚本：

1. Android用户手工选一张合成图，先保存并核实原桌面无新输入；明确选既有Codex会话发送，电脑实际读到同hash文件，S4仅投递一次到同native_id。原会话受信工具注册一个合成结果，传回同一phone endpoint，Android重开后实际读取同hash，独立显示原生接收、文件到端和领取。
2. 用户在已有桌面会话明确请求“从手机取得合成图”；宿主可信tool发human_material，持久question返回后结束turn。手机手工回答，模拟手机重开及电脑工具重启；用户在同一原会话后轮说“领取手机结果”，重新认证后get_result、实际下载核hash、显式ACK。手机才显示原会话已领取；无自动唤醒仍成立。
3. 两条链各加入一次断线/丢ACK与一次撤权恢复，证明同请求/同字节/同原生会话且无重复业务；业务内容只用合成材料，不执行真实消费者项目任务。

需要用户参与的步骤只保留实际必需部分：安装/升级测试发行物、手机与电脑确认配对及限定范围、在桌面设置中启用已完成独审的connector/plugin（如选该路线）、系统File picker人工选图、在原桌面会话发起/后轮领取、观察两端真实展示。此前均须提供具体可审阅包/路径/变更范围再请求真实环境操作；本文不执行这些步骤，不改真实config/grant/login/install。用户已有授权应复用，不重复增加批准。若宿主插件路线需新平台能力或升级，先由根说明实质取舍，不能把改用Ash新会话藏进安装流程。

状态：本文作者只改本计划，源码与真实环境未修改。A3 后续已独审，H0 已产出反证；A1-R、A4、setup 的最新实施/独审状态由根维护。H1/H2、实际 ledger 和 Android 双向闭环未完成；不得以 H0 实验退出成功误报可信宿主完成。整体进度口径由根维护。

## 9. A1-R custody 技术裁定与并行启动包（2026-10-10）

本节是常规安全实现裁定，不要求用户选择技术方案。保留完整Goal、A0 wire、A2唯一正文账本与不同phone/work主体。采用**独立受信custody resolver port**；不增加模型可填的owner字段，不把多个actor折叠成一个principal。该修订必须交A1原owner与独审，A5负责生产resolver，不授予本设计者源码修改权。

### 9.1 为什么无需修改A0 trusted context

A0 `MaterialTrustedContext.principal_id`仍是当前经过连接器认证的actor principal；pairing_id是这个actor此次通道的真实pairing；source_binding是宿主证明的exact work/node。grant_revision、authorization_epoch、expires_at仍对应当前actor授权，A1现有context=lease检查保留。A2 `StoredMaterialRequest.principal_id`与`MaterialLedgerBinding.owner_principal_id`仍是原request来源owner，`binding.context.principal_id`可以是回答者，两个字段不得互换。

资产custody归属来自protected request mapping+当前exact asset grant；它是存储分区/请求授权对象，不是登录身份，不进入A0 DTO。A0已有scope.source/return_to/target/transfer可完整承载请求及方向，当前缺的是受信存储owner解析，不是wire表达能力。A1-R在内部引入如下端口（建议定义在新 `material-custody.ts`，不是实际现存签名）：

```ts
interface MaterialCustodyDescriptor {
  version: 1;
  custody_id: string;             // protected registry生成；稳定，不是调用者输入
  authority_id: string;           // 受信配对/owner registry的稳定命名空间
  owner_principal_id: string;     // 原request来源owner，不替换context.principal_id
  request_id: string;
  asset_id: string;
  asset_version: number;
  sha256: string; byte_length: number; // 登记元数据，offer须逐字段匹配
  source: MaterialEndpointRef;
  destination: MaterialEndpointRef;
  local_store_id: string;         // runtime给定物理store身份
  expires_at: number;
}
interface MaterialCustodyLease {
  readonly descriptor: Readonly<MaterialCustodyDescriptor>;
  // 其余actor、scope、grant、registry generation保存在provider私有记录。
}
interface MaterialCustodyAuthority {
  acquire(context: Readonly<MaterialTrustedContext>,
          scope: Readonly<MaterialAuthorizationScope>,
          storageRole: 'destination_transfer' | 'source_snapshot',
          purpose: 'wire' | 'snapshot_register' | 'snapshot_read'):
    Promise<MaterialCustodyLease>;
  current(lease: MaterialCustodyLease): undefined;
}
```

`MaterialAssetStoreOptions`新增**必填**custody authority与localStoreId（runtime只读固定），不能缺失时回退principal=owner。A1 store在每个run入口同时冻结input/context/scope，先原authorization.current，再acquire，await后再次原授权+custody.current；lease必须由当前provider私有WeakMap/不可伪造句柄登记，传入相同字段的对象不算已签发。不得把clone后的lease当原句柄；descriptor可freeze，私有identity保持本次调用独占。全部读写、durable commit/reacquire锁、rename/fsync、恢复、GC、成功/错误return都检查两种current。before/acquire自身等待失败也须复核actor当前授权，不能泄漏旧metadata。

服务最外fence仍必须覆盖custody变化。生产A5把material授权registry的每次custody/actor/pairing/endpoint撤销及替换推进同一单调authority epoch，使已有`currentContext`、`authorization.current`和binding.current失效；旧epoch永久拒绝。此首包可保守失效同authority的其他inflight，避免A3 parse/clone结果时遗失私有proof。不能只依靠store方法返回前检查；如果以后优化为每asset epoch，必须显式把私有响应fence保留至HTTP/tool/socket最终输出并重审。

### 9.2 protected registry：owner不变、actor逐次认证

registry只保存元数据：authority/custody ID、owner principal、canonical request locator/hash、exact source/return/target、asset ID/version/hash/length、固定direction、登记者actor及pairing来源、store身份、期限、revision/单调epoch/tombstone。正文只读既有ledger。custody tuple不可变；peer重连、actor credential轮换只改变当前授权记录，不改变custody ID或去重键。

acquire按顺序证明：

1. 当前真实actor context与连接器宿主证明有效；从registry定位唯一request（owner+request_id+protected locator），再验证scope全部端点精确等于这个request。输入里知道request_id、asset_id或custody_id不增加权限；同ID在别的owner下不能相撞，查询多义直接拒绝。
2. 从已持久request角色与当前授权记录判定actor：offer/put_chunk/commit只允许transfer.source角色；read_chunk/ack只允许transfer.destination角色。这个角色必须匹配context.source_binding，且当前actor principal及其真实pairing已被明确绑定到该角色。phone/work可用不同principal、不同pairing；只比较各自当前映射，不要求两个pairing字符串相同，也不伪造对端pairing。
3. 验证当前source、destination的grant/endpoint映射及custody资产方向均未撤销；endpoint离线不等于撤权，已到端文件可在当前授权仍有效时读取。设备换owner、pairing替换、work删除/重新绑定均是新授权epoch；新设备同名/同node字符串不能继承旧授权。
4. exact asset授权来自已登记的本次selection/result output slot以及hash/length约束：不能让offer正文自行发布任意文件。human target只可在该待回答问题授权的输出slot登记选定文件；work target只可对原material_to_work登记结果；来源只可登记本次主动输入。receipt attach还须与canonical ResultEnvelope当前版本匹配。资产注册阶段的hash先落元数据后才收块，后续offer必须完全一致。
5. localStoreId与当前factory证明的物理node一致，目标transfer的destination确实在该store可兑现的endpoint；source_snapshot则只允许真实source的本机store。没有本机拓扑证明不能接受远端destination并出receipt。lease expiry取request、asset、custody、参与授权最早期限；不因新连接延长既有字节寿命。

首次“只保存”发生在业务submit前：本地草稿不进入ledger、不开任务。若需A1不可变快照，可信UI/connector先创建有界provisional custody（本地owner、固定request候选ID、source、已选目标、asset摘要/限额/1小时期限）；仅允许source_snapshot，禁止destination receipt/外部读取/结果ACK。明确submit在canonical ledger接受后以相同owner/request/hash绑定该custody；对不上则conflict，不能改draft后沿用旧custody。单纯本地收藏也可留在受控draft store，直到发送再建立canonical request与asset grants。human/work result已有request，可先登记确切输出slot→传bytes→提交reply；reply失败留下受控孤立资产，由GC有界处理，不能自动发布结果。

A1持久记录由原`principal/pairing`归属改为custody descriptor+创建actor审计关联；`identity/reserve/load`使用authority+owner+request+asset版本+direction/storage role，比较不可变descriptor，不能再以创建actor pairing等于读取actor pairing当ownership。quota按authority+owner principal计，source/destination actor变化不重新分配额度；同一物理store的snapshot与接收副本分别占实际bytes预算，不以换角色绕开64MiB/128文件。每请求8MiB/4asset等原限额继续约束，已有版本hash/length不可变。审计字段不是新的访问许可。

旧A1开发数据库没有custody证明，不能默认为新owner映射。先确认无真实消费者；测试fixture重建，schema显式升级并保留旧记录只读隔离/tombstone，不自动把原principal当新的trusted custody。若发现真实数据，停止该迁移步骤交根制定保留方案；不删字节、不释放旧dedupe到可重放状态。

### 9.3 A2/receipt如何消费同一custody

A2方法与A0 wire不改。phone P在pairing P下回复、work W在pairing W下领取时，两者的context始终保持各自actor。`readReceipt(id,context,requestScope)`第一阶段只能按原request owner查受保护index；第二阶段以work W的exact transfer scope调用A1 getTransfer，A1 resolver证明W是这个custody的destination。存储查找按custody owner，不按P/W actor相等。若当前调用者不是owner但确有request角色，只取得该角色允许的材料，不能借custody owner查询owner的全部请求。

生产receipt index必须存custody_id、local_store_id和direction；收到peer提交receipt时要验证其受信设备签名、当前destination endpoint与同一custody，不由模型body或WebUI任意report签发。远程destination proof需要实际目的端store的当前签名查询；Core自己的index不替代该proof。重启index丢失只凭protected transfer locator+当前custody重新读目的store恢复原receipt；结果版本关联从ledger恢复。request owner重新认证后可领取同一receipt，手机上传者无法借原owner身份获取其他结果。

### 9.4 A1源快照与目的端receipt必须分开

源码`registerSnapshot`当前在本地写文件后构造`receipt.destination=input.destination`。单包测试未提供物理node证明；如果源端传入远端destination，会形成错误到端归属。A1-R必须同时闭合此点，不能只移除principal相等比较。

最小完整做法：source snapshot是内部存储记录，保留`registerSnapshot(...):AssetRef`对上层返回形态，但内部role=source_snapshot，只产生内部snapshot handle与hash/length事实，不返回/关联AssetReceipt。增加内部 `readSnapshotChunk(handle,index,actorBinding)`，仅限当前source actor与对应custody的snapshot_read许可。它没有新的A0 wire操作；内部snapshot_read沿用该source的exact offer资源scope，并额外要求custody purpose=snapshot_read，不能伪装成只准destination调用的wire read_chunk。chunk经现有目标store `offer/put_chunk/commit`发送；sourceSnapshot内部状态不投影成A0 `TransferFact`，不为了receipt=null去放宽A0 committed的parser约束。snapshot表/记录只有metadata，字节仍由A1唯一安全文件实现管理，不新建第二个资产服务。

目的端store role=destination_transfer，`offer`证明本地物理store可承接exact destination；接收全部块、长度/hash/fsync/rename/durable metadata完成后才创建AssetReceipt。本地注册可在明确“源与目标在此同一物理store且被授权”的情况下走目的端受控import快捷路径，但不能把源快照默认当这个情况；首包可统一分块以减少分支。snapshot恢复只恢复source可读状态，绝不补出destination receipt；普通getTransfer/read_chunk/ack不接受snapshot handle。禁止用A2过滤错误receipt来弥补store本身生成假的到端事实。

### 9.5 A1-R所有权与恢复/撤权必测

A1原owner独占新增`material-custody.ts`、修改`material-store.ts`及必要`material-transfer.ts`与专测；A0只读。A5-R owner独占新production registry/resolver/index/runtime消费端；A2源码只读，若发现实际接口不足先交回A2 owner。A1-R独审后冻结新内部port，A5-L不受影响可并行写实际ledger。迁移/权限/receipt关联不能由A4实现者补fallback。

独审最少需真实store重新打开和多实例覆盖：P上传→W读取/ACK，两actor与pairing确实不同；W上传→P读取反向；相同request字符串不同owner拒绝；相同actor另work/同node另endpoint/另一pairing拒绝；未登记asset、错误方向/hash/长度拒绝；snapshot本地复制零destination receipt，目标commit才有且重启不变；quota仍归同owner；两个actor并发同custody零第二transfer/receipt；actor credential换代可重新认证查原事实，旧lease不复活。

故障注入覆盖registry claim前后、A1 reservation/chunk/prepare/rename/commit后、receipt index前后、ledger result commit与A2 attach前后；恢复查原custody/transfer/request，无第二正文/问题/任务。每个await（custody.acquire、auth、读取、fsync、恢复proof）、DB提交边界、最外serialize/sign/send均注入source grant撤销、destination grant撤销、pairing owner替换、custody tombstone及revoke→restore，旧响应一律失效。异步current实现TypeScript负向probe继续保留。A1/ledger都已提交但回执丢失允许“实际已提交但调用返回unknown”，不谎称回滚已写bytes。

## 10. H0与Android/A4可立即分发的新文件包

以下包不依赖旧link写权，不等待真实桌面登录或真机安装；原有未提交Android文件保持只读，挂载由根后续单owner交接。H0只验证本地bundled协议，不能关闭原桌面H2门槛。

### 10.1 H0完全隔离native实验脚本packet

此 packet 已实施并实际运行；当前证据与裁定见第11节及 [H0 报告](../tools/research/material-host-isolation.md)。本节保留实验复现规格，不再作为待运行状态。

**独占新文件：**`tools/research/material-host-isolation.mjs`（runner）、`material-host-mock-responses.mjs`（严格本地模型fixture）、`material-host-isolation.test.mjs`（runner自身边界）、`material-host-isolation.md`（结果与复现）；可引用已生成schema，不能改`agents/codex.ts`、旧Codex transport或真实配置。runner接收显式`--codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`、`--case all`、`--output <一次性目录>`；不默认系统CLI，不提供真实daemon socket参数。输出binary version/hash、schema hash、case步骤与去敏事件JSONL、退出/cleanup结果。

**启动边界。**使用Node `spawn(executable,args,{shell:false,cwd:tempProject,env:isolatedChildEnv})`，不执行shell拼接。runner生成0700临时目录，里面放native home、project、config、model cache、logs；child env从固定allowlist创建，不继承真实HOME凭据路径、proxy、OpenAI/ChatGPT token、CODEX配置/会话变量。Codex要求的child home/state配置key只映射新目录；不修改调用者shell变量或真实home。一次性dummy模型密钥仅供mock，provider `wire_api="responses"`、`base_url=http://127.0.0.1:<mock>/v1`、`requires_openai_auth=false`、禁用WebSocket模型传输；服务端app-server使用支持的`--listen ws://127.0.0.1:<rpc>`。运行前读取本版本help/schema验证该flag，若不支持就报告该case不成立，不偷偷换binary。

“完全隔离”须由操作系统限制兑现：macOS runner生成deny-default sandbox profile或等效可验证的系统隔离，只允许bundled可执行/必要系统库只读、临时目录读写、mock与RPC指定loopback端口，禁止其他network和用户home读取；sandbox不支持时明确实验未运行，不降级裸跑。用受限子进程的无副作用selftest证明临时文件可读写、同用户真实home哨兵不可读、其他loopback监听/外网被拒绝后才启动native；哨兵在runner临时目录之外也应为新建测试文件，不读取真实秘密。不得尝试连接真实桌面socket验证隔离。监听端口由fixture实际bind分配并记录，native端口占用时失败不连接既有listener；PID/启动时间/port必须对应本次child。

这不是登录实验：mock Responses无需账户、真实API key、OAuth、网络模型或用户操作。禁止调用login、account/auth API、读取真实auth.json、复制rollout；若native误请求认证，直接终止并记录，而不是提示用户登录。后续H2原桌面真实合成调用才可能需要用户已有正常登录状态和启用connector，但这不能成为H0前提。

**mock状态机。**仅接受本地`POST /v1/responses`及本版本确需的受限model metadata请求；所有其他路由明确失败。校验请求model为fixture、工具声明包含合成固定`ash_material_probe`、工具schema无身份可选字段；不响应shell/exec/file/network等真实tool。按本版本Responses格式生成固定function_call的SSE事件（created、output item、arguments、completed），参数只有一次性case nonce；第二次响应仅回固定文本。用实际native对请求的tool名称/namespace编码建立映射，不能硬猜名称后声称成功。每case固定最多3次mock请求，超出即fail；全部日志仅合成数据，dummy token也不输出。

**两连接执行序列。**A/B是同一测试app-server的两个真实WebSocket，分别initialize并标识clientInfo，开启experimentalApi；每连接独立JSON-RPC请求表与connection generation。创建T携带`dynamicTools:[{type:'function',name:'ash_material_probe',description:'isolated probe',inputSchema:{type:'object',properties:{nonce:{type:'string'}},required:['nonce'],additionalProperties:false}}]`；创建U不带dynamicTools。持久化真实返回threadId到temp manifest，native_id绝不自造。

1. A发turn/start(T)→mock产生tool call；完整记录A/B收到的`item/tool/call`（server RPC id与threadId/turnId/callId分别记录）。B在未收到专属request时主动回答A的RPC id；观察A是否仍pending、native是否接受B nonce。若B收到广播，也必须记录“非专属”，不能过滤B日志制造ownership。
2. 正确连接回应`{contentItems:[{type:'inputText',text:'fixture result'}],success:true}`（以本版DynamicToolCallOutputContentItem schema为准），等待实际item/turn完成；重复response、错误RPC id、错thread/call不能被计成功。每个对抗步骤使用单独T/turn避免前一次response污染后续判断。
3. B `thread/read(T)`和`thread/resume(T)`后分别重复；交换turn/start发起连接，确认request派发按creator、latest resumer、turn starter还是广播。A关闭、B保留、A2重新连；验证pending call清理、旧连接response拒绝与下一轮归属。
4. 关闭本次native并重启同temp home，重新initialize/resume T，再跑一轮mock证明工具是否持久恢复；U维持相同原ID，测试“无注册旧thread”的后续turn是否看不到dynamic tool。禁止给resume私塞schema不存在字段、修改rollout或以fork/start新T代替U。
5. 仅按本版真实schema支持的MCP/plugin生命周期尝试U的受控tool attach，单独case输出。未找到有证据入口即`attachment_unproven`，不是H0整体成功；H0其他ownership结果仍可用。宿主可信MCP调用metadata是否包含thread/turn/call另作实证，app-server客户端可提交threadId并不等于工具server收到可信来源。

每case10秒、总预算60秒，超时先关测试socket/fixture再TERM本次child，短宽限后只KILL自己的PID；成功也检查无listener/timer/child残留。跨进程恢复只复用temp state；不创建LaunchAgent、daemon配置或持久后台。退出码区分test failure与环境不支持；report逐case给事件证明，不以“进程exit0”当ownership通过。

### 10.2 Android材料bridge新文件包

**独占新文件建议：**`android/app/src/main/java/ai/ash/material/MaterialImport.kt`、`MaterialUiBridge.kt`、`MaterialBinding.kt`及对应`src/test/.../material/`；Core新增`collaboration/material-local-import.ts`与tests由A5-R owner持有，与Android owner冻结窄port。旧`HomeActivity.kt`、`CoreService.kt`、`FixedCoreClient.kt`、`Paths.kt`只读到根交接，不能同时给两个owner。

现有HomeActivity使用`WebViewCompat.addWebMessageListener`限制appassets origin/mainFrame/pageEpoch；文件选择已有系统picker，CoreUI有固定native transport。新增bridge复用这个信任模式，不添加广泛JavaScriptInterface、任意URL/路径读取或相册扫描。handler构造成可注入独立类，后续旧入口只挂固定`material_select/material_import/material_read/material_consume/material_export`类型；名字是native白名单，不新增A0 wire operation。

系统picker结果由native持有URI/打开的限定stream，生成一次性selection handle；UI只看到显示名/MIME/长度和handle，不提供content://或filesystem路径授权。Core local-import从受认证本地bridge接收有界bytes（40KiB块、4MiB单件/总8MiB），当前page/screen/principal、exact request/custody及用户选择关联在native/core私有记录证明；随机handle只做定位，不是可跨screen复用的bearer。Core用A1 snapshot注册与destination transfer，Kotlin仅保留短期picker/import映射和操作元数据，不另存消息正文/第二份长期bytes。

当Core实际运行在此Android app-private时，A1目的commit可以显示“已到手机”，但领取需页面实际读回hash或明确export/consume完成后单独记录；用户只预览不能自动确认业务完成。export用ACTION_CREATE_DOCUMENT显式选目标、从A1受控read取bytes，完成写入与hash检查后只标导出成功；material_consume需明确request/result_version，不由任意文件保存推出整个result已领取。WebView导航、Activity销毁、owner/page变更关闭selection/import handle；后台已提交bytes保留，迟到回调不更新新页面。

新模块unit测试可用临时文件与fake ContentResolver/port，覆盖取消picker零upload/业务、错origin/frame/epoch/handle、重用URI、虚报size/MIME、超限、后台回调、重复提交、import中断、Core已commit回执丢失查询恢复。真正URI权限和Android重开后A1 hash须instrumented真机后验收。首包不需要用户登录、安装或配对来开发这些模块。

### 10.3 A4与组合开发的立即执行顺序

1. A4 owner立即做新UI/store及注入port测试，明确草稿保存不触发S4；phone endpoint/store到端状态只接受生产port提供的verified事实。Android bridge owner同时做新类/契约，旧入口都不改。
2. H0 owner立即实现隔离runner/mock/边界测试与可运行脚本，按根已有授权运行完全temp/native/mock实验；无登录步骤。结果交身份owner选择正式host bridge路径，不改Goal原桌面要求。
3. A1原owner实施9.1–9.5 custody+storage-role修订；A5-L独立写实际ledger admission/answer，A5-R先写protected registry/index/resolver与假host绑定tests。A2/A3旧接口保持冻结，只有发现必需变更才回原owner。
4. setup最终独审解冻后，根只授一个A5-W owner写旧Core/device main/link和Android挂载点；消费已独审新模块，不让并行包碰这些文件。统一构建与真机包仍由根掌握。

当前完成的是修订packet与源码证据，未实现/运行H0、Android bridge或A1-R。常规身份/存储技术选择已给出，不把它们转成用户决策；真实桌面插件接入能力若平台缺失才需根明确平台取舍。所有实现仍需真实ledger、不同actor/pairing的bytes链和原桌面/Android双向验收，不能以unsupported收尾。

### 10.4 A4精确UI port与稳定DTO（可先实现新模块）

A4 owner独占`desktop-materials.js`、`desktop-materials-store.js`、新增`desktop-materials-contract.js`及同名前缀unit/Chrome tests；contract是浏览器view/port约定，不复制或扩展A0 wire。A5-R/Android消费该约定，旧app/net/S4/S5/FixedCoreClient/HomeActivity由后续单入口owner挂载。生成产物、setup install/build文件均只读。A4主导出建议 `createDesktopMaterials({root,port,store}) → {bind(scope),open(view),close()}`；`DesktopMaterialsStore`可在内存+注入持久存储先测，未装生产port时显示能力未就绪，不伪造success。

稳定view DTO如下；ID都只是关联键，port实现按当前认证上下文重新授权。所有对象在port边界严格字段/长度校验与deep freeze，未知字段拒绝；显示字符串纯文本转义。时间为epoch ms，generation是opaque字符串，不从时钟推导。

```ts
type MaterialUiScope = {
  version: 1; scope_key: string; generation: string;
  phone: MaterialEndpointRef; // 必须kind=node，来自受认证host
  ready: boolean; reason: MaterialErrorCode | null;
};
type MaterialUiAsset = {
  ref: AssetRef | LinkRef;
  transfer: TransferFact | null;
  location: 'local_draft' | 'source_snapshot' | 'in_transit' | 'destination';
  readable: boolean; // 经当前目的端store proof，不由location推断
};
type MaterialUiRequest = {
  version: 1; request_id: string; source: MaterialEndpointRef;
  return_to: MaterialEndpointRef; target: MaterialEndpointRef;
  kind: CollaborationRequest['kind']; purpose: string; expires_at: number;
  role: 'source' | 'target';
  fact: MaterialResultFact; // 完整A0 DTO，原request关联另由port证明
  assets: MaterialUiAsset[];
  question_detail: string | null; // target收件箱授权投影；非任意ledger正文
  can_answer: boolean; can_consume: boolean;
  observed_at: number;
};
type MaterialUiDraft = {
  version: 1; draft_id: string; scope_key: string;
  target: WorkRef | null; text: string;
  selections: {selection_id: string; name: string; media_type: string;
               byte_length: number; sha256: string | null}[];
  saved: 'memory' | 'durable'; observed_at: number;
};
type MaterialUiRead = {
  bytes: Uint8Array; ref: AssetRef; verified_sha256: string;
  consume_handle: string; // 短时单次、私有page/scope/result映射；不是访问凭据
};
```

`fact.receipts`仍是目的端bytes证据，UI不得用assets.location构造它。draft selections不是AssetRef，只有A1快照真实注册后才能投影为asset。role=target不能调用source的get_result；list/readRequest由生产port走正确的受限projection，UI无需借owner权限。question_detail最大16KiB，purpose及其他字符串沿A0实际限制；每request assets最多4、refs最多8，列表单页最多32、总cache最多64，cursor opaque且失效后只清列表游标不重发业务。

port方法（均接当前scope/generation隐式捕获及AbortSignal，省略参数表示不省略fence）：

| 方法 | 输入→输出；幂等与副作用 |
| --- | --- |
| `currentScope()` | `Promise<MaterialUiScope>`；认证/发现只读，不生成请求。 |
| `listRequests({cursor:null|string,limit:1..32},signal)` | `{items:MaterialUiRequest[],next_cursor:null|string,observed_at}`；仅当前source/target可见记录，无后台全历史扫描。 |
| `readRequest({request_id},signal)` | `MaterialUiRequest`；主scope重查，不下载、不ACK。 |
| `selectFiles({max_files:4,max_file_bytes:4194304},signal)` | `{cancelled:boolean,selections:[...draft selection DTO]}`；native picker或浏览器File adapter持有真实handle。返回取消时零请求/零upload。 |
| `saveDraft({draft_id,target,text,selection_ids},signal)` | `MaterialUiDraft`；ID由UI一次生成，重复同摘要幂等、不同内容用明确新revision或更新草稿，实际quota/持久失败不能saved=durable；零S4调用。只收藏不必建立canonical request。 |
| `loadDraft({draft_id},signal)` / `deleteDraft({draft_id},signal)` | draft或null / void；仅本地scope，删除草稿不取消已提交业务、不删ledger事实。 |
| `submitInput({draft_id,request_id,client_id,target},signal)` | `MaterialUiRequest`；这一步由用户明确发送触发，port从当前phone身份生成A0 source/return_to，冻结draft摘要并调用A2 submit及A1输入传输。目标必须当前选定完整WorkRef；中断后仍查同request/client。它不隐式调用S4。 |
| `sendInput({request_id,operation_id,client_message_id,target},signal)` | 既有S4 ControlFact；port复用S4可靠投递入口，把已登记输入与缺少项投影成text-only限定引用。此方法只由同次明确发送流程调用；unknown先query既有operation，不能生成新ID。 |
| `queryInput({request_id,operation_id,client_message_id,target},signal)` | 既有S4 ControlFact或未开始事实；只查原operation，恢复unknown时先调用，绝不触发native write。 |
| `answer({request_id,pending_id,question_version,reply_client_id,text,selection_ids,unavailable_reason},signal)` | `MaterialUiRequest`；exact question绑定；port注册结果slot/传已选bytes/构造A0 human_answer，不伪造work_result。text与unavailable_reason可空但至少有回答/材料/无法提供之一；双击同reply_client_id。 |
| `readAsset({request_id,result_version,asset_id,asset_version},signal)` | `MaterialUiRead`；A1实际读回、长度/hash通过后返回bytes，零结果ACK；consume_handle由native/runtime绑定实际读取记录。所有bytes总量仍受原限额。 |
| `consumeResult({request_id,result_version,consume_handles},signal)` | `MaterialUiRequest`；仅用户明确领取/消费后调；生产port证明可消费内容与本次版本，再调用A0 ack_result。部分文件缺失可以明确领取文本/已读部分，但状态保留missing，不把ACK等同全部assets到端。纯文本结果用一次受保护readRequest生成的消费记录，不能靠空数组任意确认。 |
| `retryTransfer({request_id,asset_id,asset_version},signal)` | `MaterialUiRequest`；只查同offer缺块并补传，禁止重发submit/reply/S4或更换asset版本。 |
| `close()` | 同步禁新操作，abort当前UI等待、释放blob与selection handle；不撤销已入场任务或删除去重。 |

`submitInput→sendInput`由一次用户“发送”动作连续执行，不要求额外确认；先持久保存两组stable IDs与目标，然后逐阶段记录。输入未全部到端时显示partial与缺少项，当前用户明确选择允许发送可用部分后才sendInput；默认等所选材料上传完成。若submit已接受而sendInput未发，恢复保留“材料已登记，要求待发送”，不能误报整个操作完成。A4只执行port，A5 adapter决定可靠恢复，不让UI自己构造claim receipt或trusted context。

错误统一为固定MaterialErrorCode（UI可另识别用户取消，但不得透传exception/token/path）。scope/generation改变立即废弃pending UI结果，清blob/不可见cache，port仍独立fence防止异步结果先泄漏。store持久元数据默认256KiB总额、16草稿/64请求、每draft最多4selection且总bytes8MiB；bytes由注入draft/A1存储承载，localStorage不存bytes或正文。草稿正文只在用户明确saveDraft成功的受控存储保存，普通事实cache只存IDs/DTO显示所需非正文元数据；reload不恢复授权能力。

A4可立即以严格fake port跑DOM交互与真实store恢复：准确统计保存零submit/sendInput，明确发送一次submit+一次S4，双击同IDs，submit成功/send丢回执重开后先query，问题版本更新拒绝旧reply，partial/readAsset/consume分层，旧scope迟到响应丢弃，坏DTO/超quota/HTML文件名拒绝或转义。组合tests随后换真实生产port，不能把这批fake结果列为A5全链。
## 11. 原桌面宿主身份裁定与 H1 后续包（H0 实测后）

### 11.1 已证实的边界

H0 的 [实际报告](../tools/research/material-host-isolation.md) 与 `/tmp/ash-h0-isolation-20261010-g/{report.json,events.jsonl}` 是本版协议证据：bundled `0.162.0-alpha.17.2` 中，B 未收到 A 的 `item/tool/call` 也能回答该 RPC id，native 下一次发给 mock 的 `function_call_output` 实际消费了 B 的固定输出；`thread/read` 后仍可抢答；`resume` 后广播；A 断线后 B 可答；重启同一临时 state 后仍成立。错误 thread/turn/call 附加字段不阻止正确 RPC id 被消费。正确回答、跨轮、重连、重启工具恢复均已证明；U 保留原 ID 且始终无 dynamic tool，旧 thread attach 未证明。实验进程/端口已清理。

因此冻结裁定：共享 App Server 的 event、RPC id、thread/read/resume 都不能作为 A3 host binding 的 connection ownership；不得通过只接收 A 日志、记录 creator、当前 turn starter、加本地随机 token 或本地查历史来补成证明。这个结论来自隔离合成实验，不推断成公网攻击，也不等于 GUI 原会话 H2 已做。

### 11.2 原生 MCP 有候选坐标，但目前没有可放行的身份路线

下列官方源码固定在 `openai/codex` commit `4aa94dce270de668eff6e2fa8585c82385e84455`；它们证明该源码的设计，**不冒充 bundled 二进制已实测行为**。

| 证据 | 对接入的含义 |
| --- | --- |
| [core/mcp_tool_call.rs](https://github.com/openai/codex/blob/4aa94dce270de668eff6e2fa8585c82385e84455/codex-rs/core/src/mcp_tool_call.rs#L1311) 的模型 tool 调用构造 `_meta.callId`、`x-codex-turn-metadata`；`with_mcp_tool_call_ids_meta` 覆写 threadId/sessionId，并可能加入 windowId/itemId | 比模型自报参数更有价值；适合用实际 bundled 的私有 stdio MCP 实验验证。但字段存在本身不证明调用来源不可伪造。 |
| [app-server MCP processor](https://github.com/openai/codex/blob/4aa94dce270de668eff6e2fa8585c82385e84455/codex-rs/app-server/src/request_processors/mcp_processor.rs#L679) 接受 `McpServerToolCallParams.threadId/_meta`，只覆写 threadId，其余 `_meta` 透传后调用 native `call_mcp_tool` | 另一个 App Server 客户端可能经同一个 native MCP 私有 channel 注入同形元数据；必须在 bundled 实验排除此路径，不能把 stdio 的父进程身份等同于模型 invocation 身份。 |
| [thread_input.rs](https://github.com/openai/codex/blob/4aa94dce270de668eff6e2fa8585c82385e84455/codex-rs/app-server/src/request_processors/thread_input.rs#L11) 的 `ensure_direct_input_allowed` 只拒绝 multi-agent v2 子线程直接输入 | 该函数名不是 connection/thread ownership 检查，不能将它引用成安全证明。 |
| [Rust extension tool lifecycle](https://github.com/openai/codex/blob/4aa94dce270de668eff6e2fa8585c82385e84455/codex-rs/ext/extension-api/src/contributors/tool_lifecycle.rs#L248) 提供内部 thread/turn/call dispatch context | 可作为平台 bridge 的落点；尚无证据本桌面支持第三方插件加载这个 Rust host extension。不能把内部 trait 当用户可安装扩展 API。 |
| [官方 plugin auth](https://developers.openai.com/plugins/build/auth) 的 OAuth 与 mTLS | 分别用于用户授权和客户端认证；当前查到的说明未证明每次调用绑定不可伪造的原 Codex thread/turn/call。通用账户 token/用户标识不等于 conversation identity。 |

只读检查本机 `ChatGPT.app/Contents/Resources/app.asar` 的打包 JS：见 MCP app 渲染/来源 thread、内部 attestation handler 与本机桥代码，未找到足以证明可供第三方使用的 per-invocation signer 契约。这是有限静态检查，不能声称枚举排除了所有私有能力；更不能把设备 attestation 或模型请求 `x-oai-attestation` 重新解释为 Ash MCP proof。

当前裁定是“**尚无已验证且可直接部署的原桌面工具身份路线**”。不是“桌面永远不支持”，也不因此结束 Goal。H1 后续已完成，具体裁定和根批准的 R2/H3 路线见第13节。

### 11.3 H1-MCP 隔离验证 packet（已实施，结论见第13节）

独占新增 `tools/research/material-host-mcp-isolation.mjs`、`material-host-mcp-fixture.mjs`、`material-host-mcp-isolation.test.mjs`、`material-host-mcp-isolation.md`；H0 runner/mock 原文件只读，抽公共函数须交原 owner，首轮允许少量测试基础设施重复。禁止修改旧 link、agent runner、真实插件或配置。复用 H0 的 OS 隔离原则、临时 home/配置、mock Responses、bundled CLI、两个 WebSocket 和退出清理；若任何步骤要求 real API key/login，终止该依赖步骤并记录，不借用真实账号。

1. 在临时 state 创建无 dynamic tool 的 U，保存 native 返回的原 ID，完成一轮固定文本。仅在临时 config 注册本次 Node stdio MCP fixture（绝对路径、固定工具名、无网络、只回固定字符串）。用本版 help/schema 支持的 refresh/resume/plugin lifecycle 使同 U 重新发现工具；保留完整 RPC 与 mock 的工具声明。不能改 rollout、重建 U 或使用启动时已有工具的 T 冒充旧会话 attach。若本版仅能启动时注册，分别报告“工具可用”与“旧 U attach 未证”。
2. fixture 实现本版本实际需要的 initialize、notifications/initialized、tools/list、tools/call。工具 schema 只有合成 nonce，无 thread/principal 参数；将收到的完整 request `_meta`、stdio 子进程 generation、固定结果记录到私有 temp log。native 模型调用一次，记录 thread/turn/call/session 字段的存在、来源和值；用 native 下一次 mock 输入中的真实 tool output 证明调用完成。
3. B 不发模型 turn，直接调用 `mcpServer/tool/call`，指定同 U 与 fixture tool；分别测试无 `_meta`、任意 threadId/sessionId/callId/turn metadata、复制上一真实 invocation 的 `_meta`、调用者提供另一 U 的 threadId。另测 B 先 read/resume 与未 read/resume。区分 RPC 被拒绝、fixture 收到后拒绝、native 回结果；不能只看客户端返回 error 就忽略工具已执行。
4. 若模型路径与直接路径存在宿主强制不可伪造的 provenance 字段，再实测 B 添加/覆盖/重放该字段、跨 turn、跨 U、跨连接、native 重启、fixture 重启。私有 pipe 接到相同父进程不是区分这两路径的证据。只要 direct RPC 可让 fixture 收到与模型调用同形的可信字段，MCP-only 路线不得放行；不需要真业务才能得出结论。
5. 记录外部 `_meta` 经 native 是否被删除、重写、签名，source-kind 是否有强制区分；缺失字段 fail closed。只有实际存在且不能由 B 获得的 host credential/proof 才进入后续 verifier 设计。若候选证明只是模型/调用者给出的秘密字符串，即判不合格，不扩大实验权限。

根提出的 **native item 交叉证明候选** 加入 H1，不先要求用户取舍：记录实际 `item/started` 的 mcpToolCall、thread/turn/call、工具名、规范化 args hash 与 pending/completed 顺序，核实 direct MCP RPC 是否产生同形 native item、调用者是否可伪造该 event。若 direct 无对应 item，普通 forged metadata 可拒绝；但仍须测 B 在真实相同 pending 存在时复制同 args/call 的抢先调用。相同 operation 不重复执行只解决幂等，不能自动证明该 MCP request 是原调用：将缓存的 confidential get_result/bytes 返回给 direct RPC 仍可能串到 B。实验必须记录实际 result recipient，并证明有不可伪造的 request-to-item 关联或安全的原调用专属返回通路；不能仅凭“同 args 只返回原 fact”把 response custody 判通过。这个候选保留为可行性实验，尚不预先判死或放行。

每个 case 单独 nonce、请求上限和 deadline；stdout 留给 MCP JSON-RPC，证据写临时 fd/file。无 token/配置/真实路径日志。所有 child/port 均属本次 runner，报告必须核 cleanup。该包无需用户参与。H1 通过仍须 H2：原 GUI 已有会话、同 native_id/历史连续、真实启用 connector、两方向合成材料与不同会话拒绝；H1 自建 U 只证明协议支持，不取代 H2。

### 11.4 若 H1 无证明，平台 bridge 的最小契约与可审阅选项

可行的完整技术路线是让**原桌面宿主的真实工具派发边界**提供可信 bridge；Ash 在外部验证，不自己创造源身份。它须同时解决已有 thread 可发现工具和每次 invocation custody：

- 宿主从实际当前 execution context 取出 installation/connector identity、完整 native WorkRef、turn/call、tool 名与规范化参数摘要；附 audience、短 expiry、一次性 challenge/nonce、host generation 和调用来源种类。模型不得选择或覆写这些字段。
- 签名/MAC key 或私有响应 channel 必须属于宿主保护边界；所有普通 App Server/MCP direct-call 路径不能调用同一个签发器冒充 model invocation。若允许 UI 发起材料操作，要使用独立的显式 UI actor 授权，不归为模型当前会话调用。旧本地 RPC 广播 response 不能被当成签名通道。
- Ash 验证 issuer、audience、nonce、参数 hash、endpoint/current grant 后，只生成本次 request-scoped A3 binding。多个异步请求不共享 mutable source；返回前再同步 fence。host restart/revoke 推进 generation，旧 nonce 与旧 lease 失效；跨轮同 WorkRef 重新认证可恢复原 durable request，不丢去重。
- “本机用户名相同”不提供进程隔离证明；通用 local token、OAuth subject、mTLS client cert、native_id 参数、历史工具记录均不可单独替代以上契约。已签事件若能被任意本地 client 请求签发，仍不合格。

根可审阅的选项：

| 选项 | 可继续的具体工作 | 需要的外部改变 / 用户步骤 | Goal 状态 |
| --- | --- | --- | --- |
| R1：H1 证实本版 native MCP 已有可验证证明 | 原生 stdio/plugin connector、A3 verifier、H2；先用当前 bundled 实测，不换 runner | H2 时用户启用经审 connector，并在原会话发起/领取合成材料；H1 无登录步骤 | 保留全部目标；H1 未通过前不 advertise 原桌面工具 |
| R2：平台提供上述 bridge，或升级到经 H1 验证的新桌面版本 | Ash bridge verifier、A4/A5 实际账本/relay/bytes/UI、host signer fixture 和负向验收可先完成 | 平台宿主改动/正式能力交付；升级或启用桥由用户明确执行，给出具体版本和安装差异后再安排 H2 | 完整目标保持开放，宿主链是明确外部依赖 |
| R3：产品接受人工把结果交回原会话的临时流程 | 可交付手机收集、电脑下载、显式 S4 文本发送与状态展示 | 这是实质产品降级，须用户选择；人工复制不能标为受信工具领取 | 不是当前 Goal 的等价完成，不默认采用，也不能据此标完整 Goal 完成 |

普通技术决定无需用户裁定。此处为 H1 前的选项快照；当前 H1 已结束，按第13节自主继续 R2/H3、A4/A5-L/R/W 与隔离组合验收；只有需要平台交付/升级或用户接受 R3 时才由根提出具体取舍。未解决可信宿主前，已授权手机 UI 的收集、持久问题投影、bytes 传输、实际接收证明可继续；已有 S4 能力可按其原验收范围使用。原桌面自动工具发起、以原会话身份返回 work_result、get/ack 领取等必须保持关闭，不能用测试注入身份对外宣称已通。

## 12. A5-L 即时实施交接：实际 Ledger 原子外部 admission

本包不依赖 H1，也不修改旧 link/main/server/MCP；可信 binding 由测试注入的受保护 authority 产生，生产 authority 留给 A5-R/W/H。根授予单 owner：新增 `packages/core/src/collaboration/material-durable-ledger.ts`、`packages/core/test/material-durable-ledger.test.ts`；狭窄修改 `world/ledger.ts` 及对应现有 tests。`world/router.ts` 的材料恢复/dispatch 改动另列 patch 交根授予，不与未交接 owner 并写。A2 facade/request service/store、A1-R、A0/A3 均只读；需要变更其 port 先交原 owner。

### 12.1 固定端口与信任职责

实现现有 `MaterialLedgerFacade.accept/lookup/read/answer/wait`，保持 `MaterialLedgerBinding`、`MaterialLedgerLocator` 和 `MaterialLedgerSnapshot` 实际签名。constructor 接实际 `Ledger` 和受保护的窄 authority，不能接 `unknown=>true` 的生产默认值。authority 的职责是按 operation、canonical request 和 binding 返回一次性 admission permit，并提供同步 `current(permit)`；它验证 owner principal、当前 actor principal/pair、external member、source/target、grant/epoch/expiry。`binding.owner_principal_id` 只是可信 adapter 携带值，仍须对 canonical ownership 核验；phone actor 不改写为 work owner。无 authority 时构造生产 facade 失败，不静默允许或退回本地 agent。

Ledger 新方法只接受 authority 已验证的内部 permit 与 canonical parsed payload；DB 事务从 begin 到 commit 不 await，commit 前及 facade 最外返回前同步 current。故障后恢复先重新授权再按稳定键查原事实。一个 lease/permit 不跨操作复用。authority 的 capability 不进入 DTO、消息正文或 metadata 数据库；metadata 记录可审计身份/版本，但持久字符串不能重新铸造活 permit。

建议冻结的新增 TypeScript port 如下；名称为实施规格，尚非实际导出。`MaterialAdmissionPermit` 是实现模块内 opaque 类型，必须有运行时私有 registry/对象身份验证，不能只靠 TypeScript brand：

```ts
type MaterialLedgerAction = "accept" | "lookup" | "read" | "answer" | "wait";
interface MaterialAdmissionInput {
  action: MaterialLedgerAction;
  binding: MaterialLedgerBinding;
  request: CollaborationRequest | null; // lookup 时可 null；命中后须再验 canonical request
  reply: MaterialReply | null;
  stableKey: string | null;
  locator: MaterialLedgerLocator | null;
}
interface MaterialAdmissionAuthority {
  before(input: Readonly<MaterialAdmissionInput>): Promise<MaterialAdmissionPermit>;
  current(permit: MaterialAdmissionPermit): void;
  release(permit: MaterialAdmissionPermit): void;
}
interface MaterialDurableLedgerOptions {
  ledger: Ledger;
  authority: MaterialAdmissionAuthority;
  now?: () => number;
}
// new MaterialDurableLedgerFacade(options) implements MaterialLedgerFacade
// Ledger 的新窄方法只给受保护 facade；不得挂到通用 HTTP/RPC dispatch。
// permit/current 通过模块私有受信 closure 传递，不写数据库或 wire。
// admitExternalMaterial(request, binding, stableKey, permit): MaterialLedgerLocator
// answerExternalMaterial(reply, binding, stableKey, permit): MaterialLedgerLocator
// findExternalMaterialOperation(binding, stableKey, permit): MaterialLedgerLocator | null
// readExternalMaterial(locator, binding, permit): MaterialLedgerSnapshot | null
```

`lookup/read` 在读取 metadata 定位与 canonical request 后再次核 canonical ownership，避免 before(request=null) 被误用成全表授权。`wait` 每次查询/唤醒与返回都 current，finally release；authority 不应为每个 poll 铸造可复活旧请求的 permit。存储方法运行在单个实际 Ledger DB 内；没有需要调用方传 `DatabaseSync`/任意 SQL 的公共口。

外部 member 使用独立保留 namespace（建议 `external:material:<固定摘要>`），由受保护 registry 从 owner/source 稳定生成，禁止输入自选 `agent:*`/`service:*`/`person:*`。它只由材料窄方法使用，不注册普通 MemberStore 权限或拓宽一般 world parser。需要进入通用 router 的受限任务走显式专用 adapter，不能因支持这个 namespace 继承普通 member words。旧 `createHumanAsk`/`recordAgentJob` 的 AGENT_ID 与 local/turn 检查保持。

### 12.2 单数据库、单正文、可恢复事务

在既有 ledger SQLite 增加 `material_external_admissions` 与 `material_external_operations` 两张 metadata-only 索引；允许合并为等价规范化结构。admissions 保存 request/owner/member/source-binding 定位、kind、pending/job id、question/result version、期限；operations 保存 operation+owner+stable_key 唯一键、payload hash、request/response id。source/target 的有限身份字段可存索引，禁止存 ContextBundle/问题/ResultEnvelope/资产 bytes。canonical request 只在 `messages.body`，answer/result 只在既有 response body。A2 自有 mapping 表仍 metadata-only。

`accept` 在 BEGIN IMMEDIATE 内顺序验证：稳定键与 owner 不跨命名空间；已有键同 payload 返回原 locator、不同 payload conflict；生成 message request id 并写 canonical CollaborationRequest；写 request_state；human 写同 id 的 human_pending，material_to_work 只登记，agent_task 写真实 job 关联；最后写 admission/operation metadata 并 commit。传入 A2 stable key 固定摘要（不要再次随机化）；数据库 UNIQUE 是竞争兜底，不能仅进程内 mutex。不要对事务内 helper 再调用会 BEGIN 的 append/createHumanAsk 公用方法。

human question 的 `pending_id` 可等于 canonical request message id，初始 question_version=1、expiry 不超过 request/grant。humanPending 的材料分支按 admission kind 从原 request 投影标题/详情，turn=null，外部 member 归属清楚；不得复制成另一条 local ask，不得唤醒 agent:main，不得混入 approval/redeem/frozen-action。既有列表需要显式可见范围，外部 actor 不借 unrestricted humanPendingList 查询。材料自己的待答列表由 A5-R 投影并授权。

`answer` 同一事务校验原 owner/canonical request、当前 actor 的答题或 target-work 角色、pending/version/expiry、result binding/version、reply stable key/hash，再写 canonical response、human_pending state 与 result version、operation metadata。相同 retry 精确返回；已存在另一 response 即比较实际语义/版本后 conflict，不能直接以 `settle` 的“已有 response 返回”吞掉不同答复。response `reply_to` 真实指向 request id。发表通知在 commit 后，重启可重建；通知 payload 只放定位/版本，不另存完整 answer。

`read` 通过 byId/responseTo/humanPending/真实 job 投影事实，校验 locator 与 admission 不可混搭；question 在终态保留。`lookup` 不能按知道的 stable key 跨 owner/member 猜事实。`wait` 订阅 commit 通知或有界查询真实 DB，先查询再订阅/再查消除竞态；AbortSignal 仅结束观察，不取消任务、改写 outcome 或删除 dedupe。所有 expiry/GC 保留必要 tombstone，capacity 清理不能允许同 client_id 再执行。

### 12.3 agent_task 与 router 的必要交接，禁止假 job

现有 `agent_jobs.turn` 是 NOT NULL，`recordAgentJob` 强制 AGENT_ID 与真实 turn；因此不得塞 `external:<id>` 到 turn 或借用本地 agent turn。A5-L 的第一可审提交可先实现 human_material/material_to_work 原子链，但 agent_task 子包必须继续，整个 A5-L 不据此前两类完成而关闭。

A5-L/J owner 提交一种明确迁移：同一 `agent_jobs` 增加 origin discriminator，外部行允许 turn=null 且 owner 为受限 external member；local 行仍要求真实非空 turn 并保持原方法验证。原 local `agentJob/pendingAgentJobs` 必须过滤 local origin，专用 external 查询验证 admission owner；不要静默修改旧返回类型让本地 MCP 吃到 null turn。迁移备份/事务/回滚遵从 Ledger 现有机制，旧数据均标 local；用真实旧 schema fixture 验证重开。若选择其他等价方案，必须仍关联同一实际 router request/job 事实，不创建第二本执行状态账本。

dispatch adapter 只接受 authority 已映射的 exact capability_id、当前 target node/endpoint 与预算；canonical material request id 就是任务 tracked request id，工具输入在受限 handler 内从该正文投影，不再保存一份完整 ContextBundle。admission durable commit 后才 dispatch。`request_state` 标记材料 origin/recovery owner，普通 `WorldRouter.recover` 在一般 endpoint dispatch 前识别并交给材料恢复 handler；不能因未知 word 先 settle 成 bad_request，也不能普通恢复自动执行未授权材料任务。

恢复 handler 重验当前 grant/capability/target generation。accepted 尚未 dispatch 可按 exact stable operation 继续；dispatching 且不能证明目标幂等/结果时保持 unknown，不盲重放；真实 response 才生成 agent_task ResultEnvelope。重启、撤权、工具丢回执不得制造第二执行。A5-L/J 暂无生产 handler 时 discovery 必须如实不可用，不能先写假 job/假 running 后称 agent_task 成功。这个依赖须保留在最终验收清单。

### 12.4 可独立审阅的提交与必测

1. **L1 存储与 human/work 完整真实链：**实际临时 Ledger+A2 service/store，两个独立连接竞争同稳定键；accept/answer 的 BEGIN 前、事务中、COMMIT 后、A2 mapping 前故障，重开后唯一 request/pending/response 与原 locator。检查实际 SQL 行：metadata 无正文副本，原 local ask/approval/settle/retry 行为不变。测试不同 payload、不同 owner/actor/pair、错 target/source、旧问题/结果版本、expiry、query oracle、authority current 撤权与 ABA。
2. **L2 真 job 与恢复：**旧 schema migration、外部 null turn 不污染本地 agent queries；真实 router 窄 handler/capability；commit 后 dispatch、dispatch 丢回执/restart unknown、幂等可恢复与非幂等不重放；原 local agent jobs/recovery 回归。只有真实执行事实可标 task result_available。
3. **L3 组合交接：**向 A5-R 提供构造函数、authority port、metadata-only request/pending/job locator 与 commit observation；向 A5-W 提供单 runtime 生命周期入口，无 top-level 自动启动。实际 A1-R 两个不同 endpoint store + A2 + facade + A3 签名 relay 组合，证明 phone actor 与 owner 不同仍可 exact-request answer，原 work 新一轮重新认证才能 get/ack；外层 serialize 撤权由 A5-W 补测，不能因 L1 通过免测。

L1/L2 的所有执行仅在临时数据库、受控 endpoint 与合成 handler 内，不启动真实 daemon/业务。host binding 的 mock 必须标 fixture，不宣称 H1/H2 已证。待根逐项授予文件写权后立即可实施，旧 link 冻结不阻挡 L1。

## 13. H1 后的 R2 决策：受控共享原生引擎代理与 H3 实施包

### 13.1 裁定与证据

[H1 报告](../tools/research/material-host-mcp-isolation.md) 及 `/tmp/ash-h1-mcp-isolation-20261010-b/report.json` 已完成所需反证，不再重复研究假想 signer：同一合成旧 U 的 ID/历史保留，`config/mcpServer/reload`＋resume 后实际模型使用新 stdio MCP；direct RPC 的 metadata 可透传，复制真实 pending call 的坐标和相同 args 可同时到同一 MCP 子进程，结果返回 B 的 RPC，原模型另收一个结果。只有 item/started＋args hash 的方案不可放行 confidential get_result/bytes。H1 证明 attach 的协议可行性，未证明原桌面 H2 或可信调用关联。

**R2 可实施，根已批准进入 H3 全临时环境开发。**采用“原桌面共享原生引擎由受控 supervisor 管理，Ash proxy 是唯一持有原生 WebSocket credential 的客户端入口”。原生仍执行桌面原会话；GUI 与 Ash 控制服务均经 proxy 连接它。不得保留另一个公开 native control socket/无认证 listener 作为绕路，也不得并行启动第二个使用同真实 state 的引擎。此方案是原共享服务访问边界的改造，不是 Ash agent runner 接管或另建会话。

本版本实际 help（H1 `logs/help.txt`）支持 `--listen stdio://`、Unix/WS，以及 `--ws-auth capability-token --ws-token-file <absolute path>`。优先内层 authenticated WS，外层 Unix WebSocket proxy，一条下游连接对应一条原生上游连接，避免把多 GUI/client initialize/subscription 强行复用成一个 stdio session。stdio 是可用备选，但若改用它必须另做多连接会话语义适配，当前不优先。

桌面打包 `application-network-startup-CfAQmSYg.js` 的 `CODEX_APP_SERVER_WS_URL` 可指定外层 `ws+unix://localhost<socket>:/rpc`，`CODEX_APP_SERVER_FORCE_CLI=1` 会禁此路线；先前真实 GUI 已通过这一路径使用同 daemon 和已有会话，见 [共享 daemon 记录](CODEX-DAEMON-ISOLATION-PLAN.md)。因此无需先等新的桌面插件 API 才能做 H3。该环境入口仍是当前版本内部能力，必须版本固定与显式兼容检查，不能声称公开稳定 API。

信任边界固定为与本机 device 代码相同的本地可信用户环境：不声称抵御能任意读取本机代码/credential、修改进程或注入桌面的同 UID 恶意程序；无需为此添加无限攻防前提。仍严格保护远端 phone/work actor 的 Ash grant、外接连接角色与 request scope。仅“native socket 放在0700目录”不作为禁止普通客户端直连的证据；native 实际开启强制认证，H3 必须实测缺失/错误 credential 无法 initialize 或调用。

### 13.2 文件所有权与固定实现面

先由一个 H3 owner 独占新增 `tools/research/material-host-proxy.mjs`（可测试代理核心）、`material-host-proxy-isolation.mjs`（runner/supervisor fixture）、`material-host-proxy.test.mjs`、`material-host-proxy-isolation.md`。H0/H1 runner/mock/fixture、原 transport、setup/install/build、旧 link/main 全只读；可 import 已导出的纯 fixture helper。根批准成熟迁移后，生产 proxy/supervisor 另独占新目录 `packages/device/src/host-proxy/`，不由研究包顺手接实际服务。

建议接口：`createMaterialHostProxy({nativeUrl,nativeCredentialProvider,roles,protectedMcpRegistry,limits,onGenerationChange})` 返回 `listen/close/status`；native credential provider 只供 proxy 连接工厂，不序列化给下游。`roles.authenticate(connectionEvidence)` 在 upgrade 时确定 immutable role 与 scope，`roles.current(binding)` 在每次 dispatch/response 前同步复核。`protectedMcpRegistry.resolve(serverId)` 返回 protected/nonprotected/unknown，并带配置 generation；unknown 不转发可能命中 Ash 的 direct call。研究 fixture 的 role 固定于两个各自受控 Unix listener，不能从 `initialize.clientInfo.name`、body 或 query 参数自选；生产 role 在本机 GUI endpoint 与 device-runtime endpoint 的受保护连接注册中确定。远端 relay 不能取得通用 App Server 入口。

每个下游连接独占一个通过 native token 认证的上游 WS，透传初始化的实际版本/能力回执，保留原生订阅语义。GUI 当前可用方法按本版 schema 列表登记；device role 只保留现有已审 native read/control/create 子集及 exact work grant 检查，禁止 config/account/process/command/MCP direct 等扩权入口。不能用一个“any authenticated local client”角色替代 GUI/device 区分。

### 13.3 必须在实现中关闭的三类绕路

**Ash MCP direct call。**所有角色（包含 GUI）均拒绝直接调用受保护 Ash server 的 `mcpServer/tool/call`；非 Ash 的 GUI MCP app direct calls 保留。保护集合按受控 MCP 配置中的 canonical server/connector identity 建立，覆盖别名、plugin-qualified name 和大小写/规范化规则，不能只字符串比较 `server === 'ash'`。GUI 配置更新、reload、plugin install/enable、thread start/resume overrides 若触及 protected connector 或令解析不确定，先同步停止 Ash admission 并推进 generation，再允许经过验证的配置变更；重新解析受保护 registry 后才恢复。device role 无这些修改权。正常非 Ash MCP 不因材料未就绪全部停用。Ash connector 首包只提供固定 tools/list/call，不通过 resources/prompts/event stream 另开结果读取面；proxy 同样拒绝指向受保护 server 的 resource/read、event/stream 等旁路，安全的状态发现另列白名单。可信本地用户直接改配置也触发 watcher，watch 失败时只对 Ash host binding fail closed。

**server RPC 回答。**proxy 记录 native 发出的每个 server request 的上游 generation、RPC id、method、thread/turn（若协议提供）、指定接收 GUI connection，以及独立下游 id；只有收到该 request 的授权 GUI 连接可回答。device role 不收到审批/elicitation/auth/attestation 请求，也不能猜 id 回答。H0 所见同 native request 广播到不同上游时统一去重并选单一 GUI owner，不产生多个可回答记录；断线失效 owner，不把旧 id 转给任意新连接。`item/tool/call` 的 dynamic tool 回答同样必须原接收 connection；Ash MCP 自身结果走 private MCP channel，不让 proxy 注入其结果。没有当前 GUI 时显式保留原生等待或安全失败，不能自动同意审批。native `account/chatgptAuthTokens/refresh`、attestation/currentTime 等完整 server-request 家族需按 schema 安全转发至 GUI，不能因只实现工具请求而破坏桌面。

**协议与数据出口。**严格分开 client request、native server request、response、notification；未知 client notification、伪 `item/started`、method/result 混合帧与未登记响应不能上送或参与 host proof。ID 保留 string/number 语义，禁止不同连接/方向碰撞，重连 generation 不复用 pending 记录。JSON 深度/完整帧大小/在途数/排队字节有界，启用 maxPayload、禁压缩；大 frame/慢接收背压/close 后 outstanding 的处理有确定结果，禁止无限缓存。device 订阅与返回数据须按当前 work scope 过滤，不能把 GUI 全部 thread/tool-result 广播给外接角色。每个发送成功/错误前做角色、scope、配置与 native generation 同步 fence；失效时关闭相关连接并废弃缓存 proof。

受保护 MCP 仅在 native generation 与 registry 已通过当前验证时使用本次 native 模型 `_meta`，并继续核真实 native item、tool/args/WorkRef。R2 的关键新增证明是**非模型 direct 路径已在唯一入口被阻断**，不是 metadata 自身突然有了签名。H3 若发现还有受支持的等价 direct 调用路径，必须在同一次版本方法清单审查中关闭；不要无限扩展到本地可信代码恶意攻击模型。

### 13.4 H3 一次完整隔离实验与停止条件

runner 使用 H0 已验证的最小 env/OS sandbox、全新临时 home/config/project、mock Responses、只返回固定 nonce 的 stdio Ash MCP；不登录、不用真实 key、不启动 managed daemon、不连接真实 GUI 或真实 home。生成高熵一次性 native token 到私有0700目录的0600文件，只将文件路径传原生 `--ws-token-file`；不在 argv/env/log 中打印 token。native auth 的确切 WebSocket header 以本版本行为验证，不能猜中一次后忽略无认证对照。mock token/provider 与 native capability token 是不同用途，日志均去除。

1. 启动单个 native `app-server --listen ws://127.0.0.1:<owned> --ws-auth capability-token --ws-token-file <temp>`。proxy 是唯一使用 credential 的客户端。第三个对照 client 直接连接 native：无 token、错误 token 均握手拒绝/不能 initialize；正确 token 仅 proxy 内使用。测试 native 是否意外建立 control socket/第二 listener，核受控 PID 自有端点清单；若存在未认证控制入口，实验停止，不以“隐藏端口”放行。
2. 启动两个 proxy 下游角色 A=GUI fixture、B=device fixture；分别真实 initialize。A 在同引擎创建 U，无工具完成一轮；临时受控 config 加 MCP，reload/resume 同 U，验证 ID/history 连续及 native 模型真实 tool output。B 对获准 U 读历史/控制原语按既有范围通过，对 V 拒绝。原始 native token 不出现在下游、错误、日志或报告中。
3. 重放 H1 direct 和 same-pending/copied-meta：A/B 针对 Ash direct 均在 proxy 被拒绝，实际 MCP fixture 没收到该 nonce；原模型 call 完成且唯一结果到原模型。增加一个固定 non-Ash MCP fixture，A direct 调用正常完成，B 仍无通用 direct 权。测试 Ash 别名、unknown registry、protected config override、reload 期间 generation、外接伪 GUI clientInfo；只作用于 temp 配置。
4. 加一个固定动态 tool 或原生受控 server request，证明只有获分配的 A 能回；B 猜原 native id、猜下游 id、伪 started/completed、重复 response、断线后旧 id 均不被 native 消费。记录 native 实际下一 mock 请求的 tool output，不能只看 proxy 返回拒绝。纯 fixture 测 auth-refresh/elicitation/approval/attestation server 请求的路由，不实际登录/批准业务。
5. A/B 断线重连、proxy 重启、native 受控重启均检查 generation，使用同 temp state 恢复 U，不创建替代 thread；旧 token 在新 native generation 拒绝，旧 pending response/host lease 不复活。令 proxy 配置/registry 验证失败，Ash proof 立即不可用；non-Ash GUI 正常功能按策略继续。测限定 frame、同 id 不同连接、慢消费者、close/startup 失败，最后核 owned child/listener 清理。

同一 H3 报告给出 bounded case 结果、版本/hash、native唯一性、拒绝证据、模型实际收到的结果、原 ID/history、cleanup。每 case 有 deadline、总预算建议120秒，不为等待不明确 signer无限增加 case。成功代表 R2 技术路径可用于下一阶段 H2，不能声称真实桌面已切换。若 native auth 实际不可用、GUI protocol 无法保持或有无法关闭的支持路径，则本轮明确失败并转13.6的平台方案，不继续靠更多相似 metadata tests拖延决定。

### 13.5 H3 成功后准备的具体本机切换包（此时不执行）

切换包应包含：固定 native/app 版本与摘要、proxy/supervisor 可审二进制/源码、两条 proxy socket 路径及角色、受控 MCP manifest、native token 私有位置/权限、启动/就绪/停止/回滚脚本、受影响配置 diff、H3 报告、H2 合成验收脚本。优先复用已有 setup reservation/drain 与 scope settings；安装/build 文件仍由 setup owner 独占。不要在 UI 要用户理解内部 RPC/权限树。

1. 先只读列明当前真实 daemon PID/版本/控制入口、GUI 连接、活动/unknown work；用户正常完成或暂停当前工作并完全退出 GUI。不得强停未知在途任务。已有真实重启授权可复用；需用户实际手动退出时说明具体操作，不重复要求抽象同意。
2. supervisor 在取得唯一状态锁、确认旧 engine 已退出后，使用**同原 CODEX_HOME 与原生历史**启动一次 authenticated native，再启动 proxy；不复制 rollout、不改 native_id、不引入 Ash runner。旧 public daemon/control socket 与其自动重启路径必须确认停止；不可只重指 symlink 而实际旧 listener 仍存活。若普通图标/旧 LaunchAgent 会另启引擎，切换包须明确处理或失败回滚，不能同时运行两份真实 state owner。
3. 完成 native auth、proxy 角色、MCP protected registry、read-only就绪检查后，再让 GUI 通过 `CODEX_APP_SERVER_WS_URL=ws+unix://localhost<reviewed-gui-proxy.sock>:/rpc` 打开。device transport 改连 device proxy socket；它现在需要验证 proxy executable/PID/generation，并验证受保护 supervisor 的 native identity，不能将旧 `verifyUnixListener` 的“listener就是Codex二进制”检查直接删掉。该 adapter 变更交原 transport owner 独审。
4. 先核原 GUI 会话 ID/历史/当前登录状态和已启用 non-Ash MCP app；不复制 auth文件、不把 GUI 登录变成远端凭据。显式 WS 会跳过桌面 stdio 启动配置覆盖，因此 secret auth storage、host apps/plugin、auth refresh/attestation 必须逐项验证兼容。若现有登录不可用，先报告差异和原客户端所需步骤，不自动登录/降级 model provider。
5. 用户在原 GUI 的获准合成会话完成 H2：发起手机材料请求、跨轮领取、手机明确发送到同原会话、结果回同 phone endpoint、实际 bytes/hash 与 ACK；另会话拒绝。再检查 GUI普通重开、native/proxy 崩溃恢复、升级版本拒绝/回滚。回滚先禁 Ash host admission、drain、停止受控 native/proxy，确认唯一退出，再恢复原共享 daemon 和原 GUI URL，不重发任何 unknown业务。

普通双击图标持续进入 proxy 仍需经审 launcher/服务设置，不能仅一次 env 启动通过就称普通安装完成。升级时先使新业务 admission关闭并 drain，版本不匹配 fail closed；不自动下载替换桌面/原生包。切换影响是共享引擎的受控重启、GUI启动入口和材料 connector 的新增配置，原会话历史/ID保持；这个影响应在具体包准备好后告知用户。

### 13.6 有限选择与继续工作

当前选择已明确：自主实施 H3，不请求用户决定 routine proxy 技术。H3 成功后提供13.5的具体切换包，复用已有真实重启授权，并只为新增、尚未授权的安装/配置/限定 grant 操作说明实际范围。若用户不接受 proxy 管理共享引擎的部署影响，或 H3/H2 发现此版本确有无法解决的 GUI兼容问题，才需实质选择：等待/推动官方 host bridge 或经验证的新版本；或者接受人工传递作为单独临时交付。人工流程不等价于完整 Goal，原工具可信双向链仍保留未完成。

A5 实际唯一账本、A1-R custody、签名 relay、Android/UI 与组合 tests 继续并行，不等待真实切换。不得把 H1 的 hostProof unproven 写成 unsupported完工，也不得借 R2 计划把真实 GUI、普通安装或双向 bytes 验收提前计完成。

## 14. 最终 A5-R1 / A5-R2 / W1 / W2 生产集成 packet

2026-10-10，已按当前源码重新核对。本节是根当前分发依据，覆盖第8节早期文件所有权候选和浏览器port草案；A0/A1/A2/A3/A5-L已验收端口继续冻结。这里的 **A5-R2是材料runtime组装包**，与第13节名为R2的受控原生代理技术路线不是同一个工作包。没有生产宿主证明时保持host能力未就绪，不能将其作为完整Goal已交付的例外。

### 14.1 已核实的实际接线缺口与文件所有权

| 实际源码 | 当前事实 | 本轮实施职责 |
| --- | --- | --- |
| `core/src/server.ts` | 只有read/control/create attach与route；`handle`先匹配create、control，然后所有其余`/api/collaboration/`交给read route；`collaborationResponseFences`目前只有control/create | W1新增独立材料dispatch、材料错误映射与最外return fence；必须在通用read分支之前匹配，不能仅挂UI网络方法 |
| `core/src/gateway/link.ts` | OwnerLink已有read/control/create transport与tunnel体积分类；材料尚未接入，paired展示结构不是材料可信key registry | W1保留并核验当前peer key，按固定签名type分发，每peer独立generation；同步补材料tunnel限额和最外回传检查 |
| `device/src/main.ts`、`link.ts` | 当前collaboration组装read/control/create，生命周期有invalidate/close；ClientLink已有真实LocalStateTransaction与transport epoch | W1接入材料runtime，不能跳过现有状态锁、pairing或更新drain；device→Core材料走A3签名relay，不伪造反向HTTP请求 |
| `material-durable-ledger.ts` | 实际`MaterialAdmissionAuthority`含`before/currentInput/current/release`；permit使用私有登记；真实任务有单独`MaterialTaskDispatchAdapter` | R1实现生产authority；R2注入已验收facade和真实任务adapter，缺任务能力则不advertise |
| `material-custody.ts`、`material-store.ts` | 实际custody含actor lease和独立maintenance lease；store要求`custody/localStoreId`，有`getSnapshot/readSnapshotChunk/getTransfer` | R1提供生产custody与maintenance；回执第二阶段调用实际getTransfer，源snapshot不产生目的端回执 |
| `desktop-materials-contract.js`、`desktop-materials.js` | A4已消费15个实际port，尚未接入旧app/net；UI自身不是身份/receipt签发方 | W2按14.6真实port接线，消费已验收Android桥；不继续使用第8节早期port名字 |

| Packet | 最终独占写入范围 | 当前状态与边界 |
| --- | --- | --- |
| **A5-R1** | 新增`packages/core/src/collaboration/material-registry.ts`、`material-authorization.ts`、`material-receipt-index.ts`；新增`packages/core/test/material-production-authority.test.ts`、`material-receipt-index.test.ts`及必要新fixtures | 根已分发给`material_durable_ledger`作者并开始实现。生产registry、authorization、custody、maintenance、admission和receipt在这三个Core模块内合理组织，不另造同名device版本 |
| **A5-R2** | 新增Core及device各自`collaboration/material-runtime.ts`；新增Core `collaboration/material-ui-service.ts`及专用runtime/composition tests | R1独审冻结后分发；只负责工厂、生命周期、服务与UI投影port，不提前改入口。device不得直接import Core registry实现，消费明确受信适配port；无当前证明则拒绝 |
| **W1** | 狭窄修改`packages/core/src/main.ts`、`server.ts`、`gateway/link.ts`及`packages/device/src/main.ts`、`link.ts`；新增材料HTTP/relay/入口tests | 根显式交接后由一个owner顺序接线。必要既有capabilities变更先报具体文件，不与其他owner并写 |
| **W2** | 新增`packages/core/ui/js/desktop-materials-port.js`；最小修改`app.js`、`net.js`、`desktop-work.js`、`ui/index.html`及实际HTTP链Chrome tests | W1路由与R2 UI service契约冻结后，同一入口owner或明确交接的owner实施；A4模块和Android源码只读 |
| **H-production / W-H** | H-production首包见14.8，独占新增`packages/device/src/host-proxy/`列明的模块及专测；W-H原transport/宿主接线另授 | H3研究已接受，可迁移生产模块；不夹带进R1/R2，不切换真实桌面。H3 fixture或thread/read存在性不能直接签发生产work身份 |

共享docs由协调者按根授权维护。`core/src/ui.ts`、Android assets和dist只由根统一生成；不由并行实现者覆盖。A0/A1/A2/A3/A5-L、world ledger/router、Android桥、H3与setup/install源文件在本包中只读，接口不足交原owner修订并复审。以上所有权不赋予运行真实daemon、模型业务、部署或安装的权限。

### 14.2 A5-R1：真实注册入口、持久归属与授权

**稳定身份必须来自实际宿主。**authority/node ID取运行时的真实持久signer和受保护state root；localStoreId由工厂将物理node与store root绑定，不接受UI/model自报“这是phone store”。Core运行在Android app-private目录与远程服务器是两种部署，只有实际证明前者才能签发手机到端事实。screen ID是短期呈现身份，不得成为长期owner或假conversation。

生产注册入口是内部受限方法，消费已有认证边缘产生的本机owner screen/native或已验收setup管理上下文，并在读/写前后检查其live proof。W1稍后将它接入真实认证入口；R1必须给出具体可调用的注册API和实际验证器，不能只留`authorize:()=>true`可注入接口。请求正文中的`trusted`、principal、node、native_id或已知binding_id都不能自行创建证明。测试使用真实ScreenRegistry/token/currentBinding或真实LocalStateTransaction，不将allow fixture当生产授权实现。

材料grant必须独立、明确登记；既有read/control grant不是材料全盘权限。device侧原paired/read/control状态使用真实`LocalStateTransaction.capture/assertCurrent`与当前pairing校验；Core侧使用当前signer和已验证peer registry，不假设Core根目录拥有device的`paired.json`。本包不修改LocalStateName的三文件枚举、不再造旁路授权锁。涉及device配对状态和材料grant的同次管理变更应使用现有descriptor锁串行，提交前同步重验原状态及调用者；旧配置恢复相同值也不能恢复旧epoch。

新registry是有界、限制权限的SQLite元数据存储，使用事务和持久单调revision，至少保存：authority/custody ID、owner principal、request稳定键/locator/hash、exact source/return/target、角色与动作grant、asset/version/hash/length/direction、物理store绑定、最早expiry、epoch、tombstone和必要审计关联。正文、ContextBundle、问题及ResultEnvelope仍只在真实Ledger。schema、配额和元数据容量需固定上限；满容量拒绝新增，不能清掉unknown去重键后重放。

request登记先形成受限admission候选，A5-L原子accept后才绑定canonical locator/hash；跨DB窗口恢复只使用稳定键lookup，unknown不重新提交。首次只保存的provisional custody至多一小时，仅供source_snapshot；它不产生destination receipt、不允许外部领取和ACK。canonical request与候选不匹配即conflict。已选输入或human/work-result输出slot必须由当前认证角色和真实request/question版本登记，不能让offer正文自行发布任意文件。

外部member按稳定owner和来源派生保留namespace `external:material:<摘要>`，不接受自选`agent:*`、`person:*`或local/ownerProxy替代。同request字符串在不同owner下不相撞；查找多义即拒绝。重新配对/credential轮换可以在新认证后访问获准的原custody，但不会转移owner或重新分配额度。

**H3研究已通过，但生产host provider尚未安装并验证时，work actor proof仍不签发，available为空或明确unsupported。**phone node可以在真实已认证入口下登记其明确选择的草稿及目标slot，但不能凭目标会话可读伪造该work的来源身份。测试host proof仅限显式testing fixture；生产工厂缺少证明时必须not-ready，不能以测试参数默认补齐。

### 14.3 A5-R1：authorization、custody、maintenance、admission与receipt

`material-authorization.ts`实现现有`MaterialAuthorization.before/after/current`、`currentContext`、`MaterialCustodyAuthority.acquire/current/acquireMaintenance/currentMaintenance`以及A5-L `MaterialAdmissionAuthority.before/currentInput/current/release`。A0/A1/A2会clone context，不能把context对象身份当唯一证明而破坏端口；真实actor须由私有认证绑定登记、当前受保护状态和完整scope验证。custody/maintenance/admission的lease/permit则必须由私有WeakMap或等效不可伪造登记签发，clone、伪造、释放后的对象拒绝。

每次检查精确绑定actor、pairing、grant revision、authority epoch、source_binding、request、target、asset方向、physical store和最早到期。before/acquire自身失败及await返回后也须复核，成功和错误最终返回同样受fence约束。任何custody/actor/pairing/endpoint/host变化推进统一authority epoch；watch异常立即拒绝新调用，current同步读当前受保护状态，不依赖轮询恰好及时。revoke→restore不能复活旧lease。

admission permit精确绑定action、owner/member、canonical locator/request hash、reply的pending/question/result版本；`currentInput`在尚未拿到permit时也要有效。真实agent_task还须有当前capability、目标与执行预算证明，不能仅靠schema签发dispatch/complete。maintenance是独立物理store清理许可，允许有界处理过期/撤权orphan，但不提供actor身份、历史读取、字节读取或跨store权限。

`material-receipt-index.ts`只保存定位元数据和custody/local_store/direction，不保存正文和文件。记录之前必须取得真实A1 destination commit证明。A2 `readReceipt`第一阶段`scope.transfer=null`仅按当前request ownership查候选；第二阶段以当前actor的exact transfer scope、真实custody与同一授权lease调用实际`A1.getTransfer`，核验committed/acknowledged及完整receipt。禁止两次都只读同一个Map/索引；store重开后unknown、过期、撤权或descriptor不符均不能证明到端。

commit成功、index写入前崩溃时，凭受保护原transfer locator重新查询目的store并补同一receipt；index之后、A2 attach之前中断时核对canonical结果版本后补关联，不重新传字节、不生成新receipt。索引失败保持“字节已提交，结果关联待恢复”。source_snapshot永远没有destination receipt；远端store的当前证明尚未接好就unsupported，不能拿Core缓存代替手机到端。

**R1硬验收：**真实临时SQLite Ledger + 已验收A5-L facade + A2 RequestService/RequestStore + 两个独立A1 MaterialAssetStore根 + 新生产authority/index必须组合运行；只有registry单测通过不能交付。phone/work的principal和pairing不同，分别覆盖P→W、W→P的bytes/hash/ACK，host来源只在明确testing边界注入，另证生产H3缺失不就绪。检查实际数据库唯一request/question/response，metadata没有第二份正文；两实例并发及重开得到同custody/transfer/receipt。

还必须覆盖：跨owner同ID、错endpoint/store、未注册asset及错方向、伪造/clone/released permit、旧question/result、真实授权文件变化与watch error、所有await及最终输出边界的ABA、maintenance不越权、commit/index/attach三个恢复窗口、容量满保留tombstone、startup半失败和重复close无watch/DB/锁泄漏。第二阶段receipt测试须证明真正调用A1.getTransfer并在目的store unknown时拒绝。A5-L已修的hang recovery容量规则要回归：观察超时不等于底层执行settled，不能提前释放未结束任务的槽。

### 14.4 A5-R2：单runtime组装和完整生命周期

R2按明确所有权依次建立：物理node/store与受保护state证明 → R1 registry/authority → A1 stores及receipt index → A5-L真实facade及A2 request store/service → transfer service及受限UI projection → 每peer A3 relay和host binding。不得安装`UnsupportedMaterialLedgerFacade`却宣称ready，不在模块import时自动启动服务、watcher、GC或连接。

工厂提供明确`invalidate/close/busy/readiness`及供W1注入的固定入口；资源由谁创建、谁关闭要逐项登记。外部传入的Core Ledger由Core拥有，材料runtime不得提前关闭；独立材料store/index/watch/adapter由runtime拥有。缺真实taskDispatch则不advertise agent_task；缺H3 provider不advertise work-origin tools。成熟的手机node、存储和receipt组合可以独立验收，不等待真实桌面切换，但不能把这一部分记成完整双向链。

启动任何一步失败都逆序释放已取得资源。关闭顺序为：先关闭新admission并递增generation → 失效host/relay/UI租约与等待者 → 取消观察、关watch/adapter → 等已入场存储I/O到达可恢复边界 → 关闭store/index/request store → 最后由Core关闭自有Ledger。断线不删除dedupe、不撤回已提交bytes；重复close幂等，close失败不得偷偷恢复旧generation。GC有条数/时间预算，维护权限与actor读权限分开，expiry保留防重放tombstone。

`material-ui-service.ts`提供当前phone scope、获准source/target记录投影、草稿/selection slot注册、回答和消费协调；待答列表不能借A2来源`get_result`越权，必须从canonical ledger做exact target的有界投影，不能直接暴露全部human_pending。它只接受W1认证后传入的上下文，不从JSON自行恢复身份。原生选材句柄、draft、consume handle与scope/generation/版本绑定，UI缓存不是权威。

R2验收保留R1真实组合，加入实际工厂startup第N步失败、disconnect、registry/endpoint变化、重复close、挂起I/O与GC限额；独立两个根明确记录物理node。工厂不得通过依赖注入默认allow来掩盖未完成的生产验证器。freeze构造签名和生命周期后才交W1。

### 14.5 W1：真实OwnerLink/ClientLink、服务端dispatch与最外回传

**服务器必须先接。**当前`handle`通用`/api/collaboration/`分支会接管未识别子路径；新增固定`/api/collaboration/material/`分支必须位于通用read分支之前，并与R2冻结方法/URL表。未认证、未知子路径、错HTTP方法、未知operation和多余字段都有固定材料错误，不能落回read/create/control、任意capability或MCP代理。模型wire只接受A0固定material/asset集合；owner UI所需列表/选材/草稿是独立受认证本地路由，不为模型增加通用文件操作。

材料route复用真实本机token/native screen或经当前配对证明的远程screen验证，但ownerProxy只证明入口，不自动生成材料grant或work身份。每次调用需R1当前scope与R2服务授权；最外HTTP/tunnel成功和失败响应都保存私有material return fence，扩展当前仅control/create的response-fence分支或提供等价专用机制。fence须一直覆盖handler await、JSON序列化、gateway签名、排队及实际写出前；不能把closure序列化进wire。对含结果资产的响应保留每一项exact asset lease，不能退化为只检查连接仍在线。

**大小限制按整条链分类。**server HTTP body读取、OwnerLink `http.reqbody`累积、材料parser、response编码、签名Envelope和最外写出均使用材料自己的限额，不能沿用通用read的默认值。A3最终签名信封最多64KiB，每块原始40KiB；本文不因普通HTTP的28MiB上限或tunnel分块较大而放宽它们。单文件4MiB/请求8MiB通过有界块或已验收本机句柄导入；不能一次把File/base64塞入普通material JSON。UI列表最多32项且还受响应总字节上限，游标可提前截页；大正文/字节需要对应有界接口，不因合法条数而绕过总量。

OwnerLink/ClientLink仅对A3两个固定type调用adapter；继续拒绝未知type。Core按当前已认证device.list的ID、公钥、pairing和generation建立每peer有界实例，不能任取首个device；device用受保护pairing owner_key。仍通过真实GatewayClient.envelope/verifyEnvelope和Connection.send，不引入生产gateway不支持的client发起http.req。binding_id仅是受保护查表句柄，还须核对当前peer和实际宿主session。

`device.presence`到达立即invalidate材料generation，再异步刷新；旧refresh结果不能恢复旧generation。ClientLink断线、owner替换/revoke、LocalStateTransaction变化、stop、watch异常以及runtime grant/endpoint/host变化同时失效旧调用。网络恢复可重新认证同稳定主体查询持久事实，不自动重放unknown。更新入口把材料busy/drain纳入现有控制，不覆盖S4/S5恢复语义。

W1验收使用实际OwnerLink、ClientLink、GatewayClient签名验证、R1/R2、A1/A2/A5-L及隔离hub或真实gateway路由判定，只替换外部网络socket/模型。必须从真实HTTP入口走到对应store/ledger再回来，证明材料path没有落入read route；测请求/响应各边界超限、序列化/签名期间撤权、错误from/reply_to/call_id、presence先于refresh、ABA、慢连接、late响应、32 inflight与close清理。不能仅测UI net hook或纯adapter。完整回归已有read/control/create及其最外fence，生成产物交根统一构建。

### 14.6 W2：冻结的15个UI port与Android桥接

以下名称来自当前`desktop-materials-contract.js`的`MATERIAL_UI_PORTS`，为本次接线唯一名单；不更改A4 DTO来适配未完成后端。

| port | 生产来源与必须保留的行为 |
| --- | --- |
| `currentScope` | 当前认证主体、phone node、授权generation及readiness；不能硬编码ready |
| `listRequests` | canonical ledger的source/target受限分页投影，最多32项并限总字节 |
| `readRequest` | exact request/role当前授权投影，phone target不借来源领取权限 |
| `selectFiles` | 已验收Android系统picker/限定selection句柄，浏览器不可提供任意本地路径 |
| `saveDraft` | 将用户明确selection与文本可靠保存，只有durable事实才报已保存，不启动工作 |
| `loadDraft` | 同scope当前权限下恢复草稿及选择状态，已失效/UNKNOWN不宣称文件可用 |
| `deleteDraft` | 仅删除该scope草稿/允许回收的引用，不取消源任务、不抹去unknown发送证据 |
| `submitInput` | 固定request/client ID，canonical material_to_work登记与确切asset slot，不隐式send |
| `sendInput` | 用户明确动作调用原S4，固定request/operation/client_message/WorkRef，不改text-only契约 |
| `queryInput` | 只查询原S4持久事实；null仅代表当前授权下确证该exact操作从未开始 |
| `answer` | exact request/pending/question_version/reply_client_id，先登记获准输出slot再提交human reply |
| `readAsset` | 当前result/asset版本下实际读取目的store、核长度/hash，返回受保护consume_handle，无隐式ACK |
| `consumeResult` | 用户明确消费当前版本及真实consume_handle后才写ACK，不拿预览或HTTP200当领取 |
| `retryTransfer` | 恢复原custody/transfer缺块或receipt，不新建替代请求、不重发unknown业务 |
| `close` | 停观察/释放当前UI句柄，不取消已接收工作，不删除持久去重 |

W2新增`desktop-materials-port.js`连接W1固定HTTP与已验收native bridge，在app/net/desktop-work最小挂载并传播scope变化。Android源码本包只读，原UNKNOWN元数据恢复语义保持；桥能力不可用时显示实际限制，不退化为任意路径或伪造FileHandle。接入时当前配对、授权或screen变化必须清理旧呈现与consume handle，离页/后台停止观察并拒收旧响应。

queryInput遇离线、无历史、过期tombstone、lookup失败或结果不明时返回固定错误/unknown，绝不能返回null诱导重试。仅在新一次明确“发送”且已持久证明未开始时沿原ID继续。材料文件未到达时保留partial/missing；用户未明确允许部分发送就不把文本先发出。readAsset的验证字节与目的端receipt是不同事实；只有明确consume当前版本才更新claimed_result_version，业务状态始终未验收。

W2验收需要Chrome经真实W1 HTTP/R2服务的链路，覆盖同scope重开、存储故障、选材取消/UNKNOWN/失效、离页/ABA、旧版本响应、未到达部分文件、query unknown零重发、明确send才执行、明确consume才ACK。UI无权限生成trusted context、receipt或grant。Android真机完整接线与H2原桌面闭环另验收，A4组件与Android单测通过不能替代。

### 14.7 分发、独审与进度记账

当前先完成已分发R1，其不依赖H-production；R1独审冻结后组装R2，再由单入口owner顺序W1、W2。H3研究已独审接受，按14.8并行迁移生产proxy模块，再另交W-H的provider/原transport适配，随后才进入获准的H2与真机双向验证。不得为解锁UI而先安装假host provider，也不重复H3研究或扩大新的研究议题。

每包交付实际diff、导出构造/生命周期、针对性测试、完整TypeScript检查及仍缺证明，由另一Sol独审。测试夹具和生产证明严格区分；只读本文件不授予其他owner文件写权。当前A1–A4与A5-L接受、R1实施、H3研究接受，生产wiring和实际端到端仍未完成；整体维持62%，由根按真实验收更新，不以新增文档、代码行数或fixture通过自行加分。

### 14.8 H-production首包：生产TS proxy、protected registry与物理角色listener

**直接实施，不重做研究。**迁移H3已接受的原生认证代理、三类绕路拒绝和epoch修复到生产TypeScript模块；可以与R1并行。首包不启动真实native/daemon/GUI、不改真实配置、不安装服务，也不改现有transport指向。H3隔离成功不表示研究最小方法表能直接替换完整S4/S5。

根交原H3作者独占新增：`packages/device/src/host-proxy/types.ts`、`protocol.ts`、`method-policy.ts`、`protected-registry.ts`、`role-listener.ts`、`proxy.ts`；新增`packages/device/test/host-proxy-policy.test.ts`、`host-proxy-registry.test.ts`、`host-proxy-lifecycle.test.ts`、`host-proxy-integration.test.ts`及限定新fixture。研究目录、旧`codex-transport.ts`/`codex-create-transport.ts`、控制/创建runtime、main/link、setup/install/build、材料R1和Android全部只读。生产模块不得import研究runner，也不把fixture角色/registry作为生产默认值。

**生产构造边界。**`proxy.ts`持有唯一native credential使用权，构造参数必须含固定版本/方法清单、经过验证的native身份与认证连接工厂、受保护registry和physical listener factory；缺任何项拒绝就绪。credential不进入下游、argv、env、错误或日志。首包可以用受控WS fixture验证，不新发native probe；真正启动/监督原生进程和验证proxy→native唯一owner是后续W-H/supervisor包，不在此模块暗中spawn。

`role-listener.ts`在受保护runtime目录建立固定GUI/device两条Unix listener，校验规范化路径、父目录及文件类型/权限、路径字节长度，拒绝符号链接、现有不归本实例的socket和路径替换。不能照抄研究`listen`先`fs.rm(socketPath)`；不得误删正在运行的入口。角色由实际绑定的监听端与受保护本机注册决定，不能从URL、请求body或`initialize.clientInfo`自选。租约捕获listener身份/实例generation、role和exact scope；同UID本地可信用户边界沿第13节，不额外声称抵御任意同UID进程注入。

每条下游连接拥有独立原生上游连接，保留初始化、订阅和RPC ID类型。listener创建第N步失败必须精确清理已创建项；close只删除核对过身份的自有socket，清除连接、pending、队列、watch和timer。计数达到retired上限不能半退出后遗留上游；close/startup失败、重连、慢消费者均保持有界。所有queued client请求出队前重新校验captured role/registry/native epoch，所有server回答保留指定GUI owner及captured registry/role epoch，并在最终native send前同步current。

`protected-registry.ts`从受保护的当前客户端配置/已登记connector读取canonical身份及别名，使用有界只读文件/配置快照和watch；不能仅接收测试`Set(['ash'])`或凭body指定protected名称。观测配置/插件/alias变化立即递增单调epoch，重新验证完成前关闭受保护Ash admission；watch错误、快照无法核实或版本不匹配拒绝相关调用。current同步核对实际快照，防止通知延迟和ABA；拒绝protected direct tool/resource/event旁路，合法non-Ash GUI路径按已审策略保留。方法清单固定于受支持版本并与受审policy映射核对，未知方法拒绝，不能把“在schema里”当无条件放行。

**S4兼容是首包硬条件。**已核对`codex-transport.ts`实际使用initialize、thread/read、thread/resume、thread/turns/list、turn/start和turn/steer。H3研究deviceMethods没有steer/turns，methodPolicy没有steer，resume参数也未覆盖实际`excludeTurns:true`；生产必须修齐明确policy，不能为了保留小白名单丢掉已验收功能。

| 必须兼容的方法 | 按实际调用核对的参数与当前授权 |
| --- | --- |
| `initialize` / `initialized` | 受支持版本与明确capabilities；notification仅允许规定握手，clientInfo不授予role |
| `thread/read` | `threadId`、`includeTurns:false`；完整WorkRef已获授权，返回与事件不泄露其他work |
| `thread/resume` | `threadId`、`excludeTurns:true`；确切已有work租约，拒绝cwd/config/MCP/runtime等额外override，不能替代新建 |
| `thread/turns/list` | `threadId`、`limit`为1–25、可选opaque cursor、`sortDirection:'desc'`、`itemsView:'summary'|'full'`；用于现有状态和有界reconciliation，分页与响应全程exact-work fence |
| `turn/start` | `threadId`、有界text input和`clientUserMessageId`；需要当前send_input租约，原journal标识不得代理重生 |
| `turn/steer` | 上述字段加必填`expectedTurnId`；当前steer动作及同active turn租约，最终send和reply重验，不退化为turn/start/interrupt |

text input、字段名及长度以当前`codex-control.ts`/协议parser和对应版本schema为依据；不得只允许顶层键却放任嵌套任意工具/路径输入。代理保留原native回执与事件，不自行宣称stable message mapping。研究deviceMethods里的interrupt不自动成为产品cancel支持：没有独立当前grant与已验收取消链时保持拒绝，GUI自身获准回答/停止按明确GUI策略处理。

**S5必须列入替换兼容检查。**实际`codex-create-transport.ts`还使用project/list、thread/start、thread/name/set、thread/read、thread/turns/list、turn/start。项目list按明确create范围有界；thread/start仅`cwd/projectId/ephemeral:false`等已审字段，使用当前create-work scope而非假装预先有threadId；返回真实native ID后，受保护内部登记绑定原创建operation与WorkRef，name/set和首个turn只允许该关联目标。无已验收的生产create-scope/新ID登记port时明确缺项，本首包不得标记可直接替换现有transport或进行真实切换。不得通过全work通配、扩大device角色或关闭schema检查来“兼容”。

**验收。**迁移H3全部已接受回归，包括protected别名、显式method配置gate、unknown registry、server request单GUI owner、device猜ID、reconnect/ABA、retire满清理、queued forward current、server answer captured epoch与最终send fence；加入真实临时Unix双listener和受控认证WS fixture，证socket角色不可自选、错误native credential拒绝、token不泄露、非自有socket不删、半失败零残留。用实际S4 CodexNativeControl与transport注入fixture连接新proxy，证明同轮steer及summary/full history reconciliation可用、错expectedTurnId/越work/撤权/额外override拒绝，不能只单测authorize函数。

S5以实际create adapter/transport和fixture验证项目范围、创建ID绑定、name/set、首turn及reconciliation，或明确阻止可替换就绪直到该组合补齐。测试不修改旧adapter源码；需要生产listener evidence适配时单列W-H交原owner。完整TypeScript与独立Sol review通过才冻结生产模块。H-production首包现已独审接受22/22，整体由根更新为63%；这不等于provider已在真实桌面派发边界签发身份、普通GUI已兼容或H2完成，后续由具体切换包与真实双向验收负责。

### 14.9 W-H1：真实监督器、原生证明、registry attestation与transport适配

**本包现已交原H-production作者开始。**只开发生产源码和临时fixture，不再扩大H3研究，不执行真实native/daemon/GUI启动、原home切换、安装或全局环境修改。整体63%是根已接受H-production首包后的记录；R1仍实施，本包开始或新增测试不另加进度。优先完成可组合构造与失败关闭，再交独审；后续接入main/setup、普通图标安装与H2另有owner和真实环境验收。

**实际接口依据。**已核对`host-proxy/types.ts`的`NativeFactory`、`RegistryPort`、`RoleAuthority`，`ProtectedRegistry(path, version, attest)`，`PrivateRoleListeners`，`HostProxy.start/status/close`，以及collaboration下两个Codex transport和`setup/service.ts`、`scope-settings.ts`。当前registry读的是受保护JSON manifest，不自动证明native有效配置；现有fixture的`verified-fixture`、固定role map和`attest`回调不能进入生产默认。`HostProxy.status().replaceable`固定false，且没有native active turn/所有client RPC计数，不能拿其队列空或连接数判断引擎可停。`ConnectionSetupService`已要求真正的`SetupRuntime.reserveChange()`，但并未实现本次监督器。

| 独占新增文件（目录均为`packages/device/src/host-proxy/`） | 责任与真实来源 |
| --- | --- |
| `supervisor.ts` | 唯一生命周期owner；canonical CODEX_HOME、受控启动描述、engine排他、锁、child与listener先后顺序；start/reserveChange/stop/失败恢复；产生只读未来桌面启动与回退计划，不安装 |
| `native-evidence.ts` | 真实OS PID及启动身份、实际映射executable与hash、受支持native版本、schema文件及方法集合hash、native监听归属与generation；有界校验、同步current和固定错误 |
| `native-factory.ts` | 用上述证据实现冻结`NativeFactory`；独占native capability credential与Bearer WS连接；abort/timeout/晚到连接清理；不接受下游提供native URL/token |
| `registry-attestation.ts` | 受控native启动的真实配置来源与有效connector证据→私有manifest；为冻结ProtectedRegistry提供真实attest闭包与watch/current，配置变化立即失效 |
| `supervisor-role-authority.ts` | 固定物理GUI/device listener与当前原授权状态→RoleLease；已核work/turn/create操作注册、撤销及generation，不由JSON-RPC参数创建授权 |
| `proxy-transport.ts` | 真实验证proxy listener并组合native/registry/role证据；构造原CodexTransport和CodexCreateTransport所需options，保留旧默认verify与全部S4/S5行为 |

独占新增测试`packages/device/test/host-supervisor.test.ts`、`host-native-evidence.test.ts`、`host-registry-attestation.test.ts`、`host-proxy-transport.test.ts`与新`packages/device/test/fixtures/host-supervisor-*`。六个已冻结proxy模块、原transport/control/create、setup、main/link、研究runner、安装/build、R1和Android全部只读；确需改接口时先向根报告具体缺口，不偷偷扩大文件所有权。不新增依赖以绕过缺失证明，不把真实路径/凭据放进fixture。

**1. 单一engine与真实启动证明。**监督器接收本机受信安装配置给出的固定native executable与canonical原CODEX_HOME，子进程使用该home，既有native_id/历史由同一engine继续持有；不复制home、生成替代工作、编辑rollout或resume到并行engine。生命周期锁绑定home真实目录身份和本实例generation，检查旧记录与真实进程；仅持有Ash自己的锁并不能证明外部Codex engine不存在。无法排除原GUI/daemon/CLI仍持有该home时必须拒绝启动并返回具体的`existing_engine`/`ownership_unproven`状态，不杀未知进程。排他证明必须来自实际进程/受控启动所有权和已退出旧owner证据，不能接收`exclusive:true`一类调用方布尔值当证明。未来真实切换仍需要原GUI/engine退出及启动入口管控；本包不声称能阻止任意同UID程序另起Codex。

启动采用固定argv、`shell:false`、最小受控child env、预先核实的版本/launch schema；保留真实凭据来源的使用边界，但不读取或输出其内容。真实生产路径不得以`process.execPath`冒充Codex，fixture可以单独使用Node子进程模拟协议。native credential每代随机生成，私有0700目录内`wx`/0600文件，原生启动只传`--ws-token-file`路径和既有已验证认证flag；token值不进argv/env、下游、状态、错误、日志或证明manifest。仅NativeFactory内部读取并用于原生WS认证，native URL是监督器持有的固定loopback listener，禁止任意目标/重定向。

证明至少绑定native实际PID及进程启动身份、真实映射executable路径/文件身份/hash、原home身份、固定native版本、受审ClientRequest与ServerRequest/schema digest、监听地址/端口与其OS owner、supervisor/listener generation。启动时实际版本响应与initialize回执一致；schema对应同一binary与受审policy，不是客户端自报版本。`current`核对存活、文件/监听/配置身份与本代对象，PID复用、binary替换、socket替换、native退出均失效。检查工具失败、超时或输出超界也失效；不将日志中的“listening”文本当监听归属证明。无法建立生产schema发布证明时保持unsupported，不能生成任意schema后自动信任所有方法。

**2. 配置来源与manifest必须同源。**`registry-attestation.ts`记录native实际加载的配置路径与层来源、固定启动overrides、connector/plugin声明和有效canonical/aliases，绑定上一段native启动证明。来源由受控启动参数及该受支持版本有效配置/来源证据给出，不从RPC body、任意传入Set或单独旁写JSON取信。配置读取有界、固定文件描述符与身份、禁止symlink/不安全权限，并覆盖实际影响该connector的用户/项目/托管配置层；未枚举层或不支持的动态plugin来源使受保护admission不ready。不能靠不完整手写TOML匹配把未知来源当不存在；若当前native/schema无法给足该来源证明，明确该生产配置不可用。

manifest由本机受控安装/配置流程的构造器产生，固定connector身份与真实command/endpoint/plugin注册对应关系、canonical及aliases和protected标记；跨文件摘要绑定config集合、native/schema版本、launch generation与manifest原始bytes。`attest`重验当前闭包及manifest bytes，不是只验证manifest自身hash或签一个调用者自报对象。目标manifest和来源变化、alias替换、原子rename、撤销再恢复、watch丢失/错误均递增epoch并拒绝旧租约；异步watch不替代发送前同步current。不复制secret到manifest，protected connector凭据仍只存在其原受保护持有者。只有全部来源可证且匹配才生成可使用的RegistryPort。

**3. 实际角色与原授权状态。**复用已冻结PrivateRoleListeners的固定角色、私有目录和socket身份；`acquire(role, listenerIdentity)`中的identity必须是监督器自己登记的本代真实listener。GUI角色来自本机受控GUI入口，device角色来自受控Ash本地服务；本地同UID边界沿既定方案，不能把路径名或`clientInfo`宣称进程级远端认证。device可用scope必须读取原`SetupScopeStore`/`LocalStateTransaction`的paired.json、read/control授权revision、epoch和有效期，再通过原ControlAuthorization/CreateAuthorization和真实native元数据核exact WorkRef/cwd/action；不能把任意HTTP请求字段转换成RoleLease。原runtime admission完成后才用私有内部注册API建立有限work/operation租约，缺可信调用方注册即deny。

当前RoleAuthority.acquire没有每条连接的调用方token参数，因此不得伪称已实现远程per-request actor认证：其角色scope是可信本地服务可持有的有限集合，远程owner/from与每次业务授权仍在原runtime把关。若生产需要并发不同scope而现有port无法可靠区分，先限制为单一受控device admission并拒绝冲突，不能返回全work通配或悄悄改冻结接口。GUI仅已有已审方法范围就绪；完整GUI方法兼容仍须后包，不自动扩大METHOD_POLICY。

lease捕获完整node/endpoint/native_id、动作与授权generation；steer要求实际同active turn的expectedTurnId，不能从待转发请求里复制来满足检查。create仅当前exact cwd/project/operation，registerCreated从native返回并核对的真实新ID登记，name与首turn关联原操作；按原journal保持幂等。每次scope/owner/native/listener变化撤销旧lease并推进epoch；registerCreated后不能把其他连接旧权限跟着恢复。授权状态写入仍归原setup owner，本模块只读并撤销。

**4. 双重listener证据接入旧transport。**proxy socket的OS owner是proxy进程，不能让`verifyUnixListener`对它声称原生Codex executable。新adapter返回如实的proxy PID/executable/socket证据，并另外验证其受保护supervisor实例、socket dev/ino/ctime、固定device role与native PID/executable/version/schema/config generation。原ListenerEvidence的version必须来自该已验证native协议，identity绑定上述整个当前证明；不能由一个任意字符串/JSON文件直接充当证明。生产构造器使用真实OS验证后才向旧`verifyListener` hook提供闭包；fixture注入是单独测试入口。保留原transport默认`verifyUnixListener`、每次verifyCurrent和initialize版本检查，不删除或弱化它们。当前hook注释称fixture用途，本包组合构造器必须明确其新增生产用途和额外证明，不修改旧源码注释来冒充已集成。

用实际CodexTransport/CodexCreateTransport以及原control/create adapter组合新proxy和真实临时子进程监听fixture，保留S4同轮steer、summary/full history reconciliation和S5项目/创建/命名/首turn/恢复；旧adapter无需知道token。断线、native换代、scope撤销、manifest变化时旧options闭包不能重新信任新owner，必须重新取得授权及证明再建连接。不能把新options工厂存在标为main已使用或material HostBinding已具备；原生工具派发的A3 authority与provider接线另验收。

**5. 停止、drain、回退与普通图标。**状态机至少区分stopped/starting/ready/draining/blocked/failed。先关闭新业务admission并冻结新role注册，再取得原runtime真实reservation，核所有可能运行/unknown操作与native任务；只有确证可停才能关闭proxy及精确自有child。proxy队列空、收到SIGTERM、HTTP成功都不证明原生工作已完成。活动或未知工作时保留可继续处理所需连接，返回busy/unknown并恢复安全admission或保持blocked；不得为完成stop杀任务。`reserveChange`释放与异常路径有界且不留下永久占用。

正常关闭和半启动失败都按创建逆序清理；只删除经身份核实仍属本实例的socket、token及临时证明，foreign replacement保留。发信号前核child真实身份，终止超时保持失败与占用证明，不在旧engine未证退出时启动替代者。准备的rollback描述仅恢复本次改过的受控入口/配置（当前包尚未改真实环境），原home和native IDs不变；日志/unknown journal事实不删除以伪造“回到未发送”。

普通桌面图标不会自动继承当前shell环境。本包输出只读启动计划与能力状态，固定原应用版本和既有已验证`CODEX_APP_SERVER_WS_URL` GUI socket入口，指出需后续受控launcher/安装步骤才覆盖普通图标；不执行`open -na`、全局`launchctl setenv`、app修改/重签或真实安装。不支持入口继续拒绝replaceable；若原图标可能启动第二engine，切换就绪必须保持false并列明缺口。未来验证“打开原图标→连接同engine→原native_id/历史→原GUI正常工作”才可接受兼容，本包tempfixture不替代该证明。

**独审硬门槛。**使用临时home/config/runtime与真实受控子进程，验证同home并发两个supervisor仅一方可启动、已有/未知engine拒绝、子进程异常退出及PID/文件/listener替换失效、半启动逐步故障零自有残留、abort晚连接关闭、TERM不退不重启、active/unknown drain不杀任务；证明同home重开保留fixture真实生成的ID。credential无/错认证拒绝，正确代理可连，报告和错误扫描零token。native版本/schema/映射executable不匹配拒绝；使用真实OS检查路径，不以总返回true的probe替代组合验收。

registry专测要从临时真实配置及受控有效配置证据生成manifest，覆盖未知层、伪造protected名、alias、config/manifest原子替换与watch失败；实际ProtectedRegistry组合旧租约必须失效。role专测覆盖原授权缺失、owner/revision/有效期变更、跨work、错turn、create ID登记和ABA；transport组合覆盖同scope成功、双重证明任一失效、原S4/S5方法与参数保留。完整TypeScript检查及独立Sol review通过后才接受W-H1源码范围；真实原桌面切换、普通图标兼容、H2、MaterialAdmissionAuthority/provider、OwnerLink/ClientLink/HTTP/UI和真机双向字节链均仍逐项待验。


### 14.10 当前64%后的单owner接线包：W-E1 → W-U15，反向provider单列门槛

本节是最新派发顺序，覆盖14.7、14.9中旧的进度和“先补provider再接所有入口”理解。**立即可派发W-E1：把已接受forward runtime与UI服务接进实际旧入口。**不再增加同层零散guard包；其后同一接线owner继续W-U15。当前不派新作者、不碰真实环境；root交给一位Sol medium后才开始代码修改。各包以明确用户操作的实际链路验收，不以模块导出或返回unsupported作为完成。

**源码核对的范围。**CoreMaterialRuntime提供peer/acceptFrame、registry、requests/assets、ui、readiness/invalidate/close；DeviceMaterialRuntime提供真实A1 store、client/adapter、acceptFrame与close，但authorization/custody/requests/bindings仍由调用者供给。MaterialUiService的7个UI方法为currentScope/listRequests/readRequest/answer/readAsset/consumeResult/close。它们是服务方法，返回的projection与A4 DTO不同，不是已接好的15ports。

当前signed测试是device source snapshot经真实签名到Core目的store；两侧registry/request/asset由fixture管理代码分别登记，device反向binding直接unsupported，且requests注入同进程core.requests。这可证明forward工厂及字节传输，不能证明生产远程canonical provider、反向receiver custody或真实OwnerLink/ClientLink接线。MaterialReceiptIndex只接受本物理目的store重新验证出的receipt；Core不能把自己cache当desktop目的store，不能直接保存远端传来的receipt JSON当本地提交证明。

#### W-E1：实际link、main和HTTP接入（立即可派发）

**独占文件。**允许此唯一owner修改`packages/core/src/gateway/link.ts`、`packages/device/src/link.ts`、两端`src/main.ts`及`packages/core/src/server.ts`。新增`packages/core/src/collaboration/material-edge.ts`、`packages/core/src/collaboration/material-link-bindings.ts`、`packages/device/src/collaboration/material-link-bindings.ts`及`packages/core/test/material-edge-integration.test.ts`、`material-link-integration.test.ts`与限定fixture。原read/control/create及其他用户功能只作必要接线；R1/R2/A0-A4/host-proxy/Android源码全部冻结只读。旧main/link/server/ui存在先前未提交修改，开工先记录这些文件的实际diff；只改材料接线精确hunk，不格式化、不回退、不覆盖旧修改。`packages/core/src/ui.ts`等UI_HTML生成文件只由原build生成，不手改；W-E1本身不修改UI源码或生成bundle。若确需增加runtime端口，先把精确签名和组合失败交根授权，禁止用monkey-patch或直接写其SQLite替代。

**构造与生命周期。**必须修改旧默认启动路径实际调用新构造器：仅新增optional dependency/attach API而原main从不使用，或默认永久disabled，不予验收。本包明确完成transport、lifecycle与真实current-proof来源接线；host/receiver provider缺口保持单独下一包，不把它们藏成所有材料功能的默认关闭开关。main在现有signer、真实state、Ledger、EdgeRouter和link建立后构造材料服务，每物理node唯一runtime/store，明确持有关系和启动失败逆序cleanup。Core复用现有Ledger及受保护状态，不建第二本canonical任务账本；device使用自己的物理store、受保护本机custody authority，不import Core实现来冒充远程授权。只有已有生产provider能证明的服务才构造成功；缺host/reverse能力独立呈现未就绪，不阻止已授权local-owner投影工作，也不注入testing_fixture/always-allow回调。“启动点存在但没有任何生产可用服务”不能算本包完整通过，须报告精确provider缺口转后述W-RX，而非虚报已接线。

**link窄端口。**在原连接生命周期增加材料attach/detach或等价私有port，固定已有`ash.material.request.v1`/`ash.material.response.v1`签名类型，收到对应frame必须交A3验证后终止该分支；普通frame仍走原处理。transport.capture/current从真实当前Connection、GatewayClient、signer、已认证device.list/本地配对状态及单调generation构造，send只用当前连接固定forward。OwnerLink已有authorityGeneration、observedPairing与ClientLink已有LocalStateTransaction/transportEpoch必须成为当前证据，不能用一次缓存peer公钥永远有效。presence、权限/撤销、key变化、断线/重连在refresh等待前同步失效材料peer；close/update先停止新admission再关闭runtime，保持原read/control/create行为。

bindings.resolve只将受保护本机登记的binding_id映射为registry签发context，并同时绑定实际签名peer、node/endpoint/完整work、配对generation与当前grant；binding_id只作locator，签名设备身份不能直接变成任意work主体。客户端HTTP字段不能提供MaterialTrustedContext、management permit、host proof或custody lease。local owner UI必须经实际EdgeRouter caller和已登记screen核验后获取本地actor；remote web_ui ownerProxy不能调用仅本地management接口来偷偷自动enrol。生产未有host/remote登记时精确拒绝该操作，同时保留UI可说明的readiness。

**入口真实unfinished预算。**冻结A3的active观察者会在timeout/invalidate时清空，但capture/verify/binding/signer的原始异步链可能仍未settle；W-E1必须在调用acceptFrame之前取得固定最多32个真实unfinished槽，直到其raw链真正settle才归还。若现有acceptFrame返回尚不能代表raw链settle，需交根确认最小生命周期观察port，禁止在观察者timeout即返还slot、禁止只数Core业务32槽或另起无界auth任务。detach/close停止新入场，旧generation迟到结果不可发送；挂起原始工作继续计入draining并有界返回状态，不擅自放行新的等量任务。本要求属于现有入口生命周期接线，不另开A3重写或防御研究包。

**固定HTTP表。**新增`/api/collaboration/material/`专用dispatch，顺序位于通用collaboration read分支之前；错误method/path/未知字段采用固定材料错误，绝不落入通用call或MCP。首包只公开已接受7方法中有实际HTTP语义的6项：POST `scope`、`requests/list`、`requests/read`、`answer`、`asset/read`、`result/consume`；close属于本机UI/session清理，不提供关闭全runtime的网页命令。输入在material-edge严格parse，request owner/asset transfer locator由授权registry查出，不让浏览器自行指定scope。HTTP服务返回私有`{value,current}`或等价fence，向外仅序列化value。

复用并扩展当前只含control/create的最外response fence，使material成功和失败都覆盖handler await、serialization、OwnerLink排队和实际写出前；fence不进入wire。readAsset返回字节按独立受限二进制响应或有界chunk端点传输，最多单文件4MiB/单请求8MiB；不把4MiB数组JSON塞入64KiB材料envelope，不放宽A3的64KiB envelope/40KiB chunk。固定consume handle仅在实际验证当前版本字节后产生，预览/下载/HTTP200均不隐式ACK。

**W-E1验收。**测试必须调用实际OwnerLink/ClientLink/EdgeRouter入口和main构造port，经过真实GatewayClient签名、A3/R1/R2/A1/A2/唯一Ledger，到独立物理store再返回；只替换网络socket和明确标识的host fixture，不在生产使用fixture授权。至少覆盖：签名forward实际路由（无旁路直接adapter调用）、真实HTTP list/read/answer/readAsset/consume对应canonical记录、错误路径不被read吞掉、两物理node禁止共享store或core.requests内存直连、重开后的同request结果、撤销/断线后旧返回不可见、外层body限额和原read/control/create回归。无host模式可验真实scope/list及明确未就绪状态，不能建立node来源的human_material或agent_task。canonical集成测试必须使用明确testing host签发的合法work source，并经真实management screen登记；asset/read和result/consume须由私有host proof与已认证screen的exact-request/role绑定解析原source context，不能fake local context、接受浏览器自报身份或默换localNodeActor。target侧answer仍按其真实actor核验。fixture仅证明接线，不计生产work能力。未建立实际生产provider的场景须单列失败边界，禁止扩大完成声明。

完整TypeScript与另一Sol独审通过后，W-E1仅记“实际边缘与已有服务接线接受”。A4尚未挂载、未补齐15ports、反向provider和H2不能顺带计完成。

#### W-U15：同一入口owner紧接A4与Android bridge

依赖W-E1固定HTTP和R2服务冻结。独占新增`packages/core/ui/js/desktop-materials-port.js`、`packages/core/src/collaboration/material-input-service.ts`、`material-draft-store.ts`及各自专测/Chrome链测试；允许最小改`app.js`、`net.js`、`desktop-work.js`、`ui/index.html`、本包owner持有的material-edge/server/main接线。A4三个组件/contract/store与Android桥保持只读；生产port按原15项契约逐一实现，不能改变UI DTO来适配缩水后端。

| 原port集合 | 实际接线来源与交付行为 |
| --- | --- |
| currentScope/listRequests/readRequest | W-E1＋当前原screen/actor授权，明确转为A4 DTO并保留role、can_answer/can_consume、真实readiness |
| selectFiles | 原Android限定picker bridge；只持有selection_id，不接受浏览器任意路径；取消/UNKNOWN/过期沿已验收语义 |
| saveDraft/loadDraft/deleteDraft | 新受控本机持久draft store，原scope＋固定request/client IDs＋真实selection状态；不保存授权能力，不发消息 |
| submitInput | 本机受信registry登记local phone source→exact selected work目标及asset slots；选中WorkRef不是host actor证明，若目标provider未就绪呈现未就绪，禁止假注册 |
| sendInput/queryInput | 原S4持久journal与真实control route，只有明确Send调用；unknown绝不返回null或自动重发，原ID不重生，材料未到达须用户明确部分发送 |
| answer | 原pending/question_version/reply_client_id＋已准许输出slots，借W-E1真实reply；选材字节不足不得宣称已提交文件 |
| readAsset/consumeResult | 目的store真实核hash/长度＋版本私有consume handles，用户明确领取才ACK；数组handles需服务逐个精确验证，不能只取第一个 |
| retryTransfer | 原custody/transfer缺块与receipt恢复，仅修传输，不重新提交业务或创建替代request |
| close | abort当前UI观察、释放blob/handles、停止旧scope响应；不关闭共享runtime、不取消已接收任务 |

Chrome使用实际W-E1 HTTP以及Android bridge契约fixture，完成明确选材→保存草稿→重开→提交→明确Send→查询回执的顺序；另验answer→目的字节核验→明确consume，离页/后台/撤权不可见旧结果。fixture不可替代Android真机或生产host证明。15项均有真实后端实现/边界测试且可用流程不依赖假权限才接受UI包；“15个函数都存在但大部分unsupported”不合格。若首条流程被receiver provider阻断，优先交W-RX消除阻断，不新增外围UI状态包拖延。

#### W-RX：生产反向provider的必需依赖和派发条件

不把它偷偷塞进W-E1的link代码。最低交付必须是：receiver本机在当前配对、限定request/result/asset版本与本机物理store下签发custody；canonical请求/结果继续归唯一Core Ledger；device通过实际签名受限查询取得canonical证明，不能跨进程调用core.requests；来源端只承认当前目的节点验证的receipt，不拿中转cache签发。Core目前的MaterialReceiptIndex是local-only，不能直接写远程记录。

建议下一单owner独占新增device `collaboration/material-receiver-provider.ts`（本机受保护receiver registry/custody/maintenance与有限缓存）、Core `collaboration/material-remote-provider.ts`（唯一canonical受限投影/目的receipt验证）、共享`collaboration/material-provider-protocol.ts`及两物理节点反向组合tests。仅当确切固定signed协议、绑定证明和原runtime扩展签名经根同意后，才最小修改material-runtime/receipt-index；不得改A0模型wire为任意注册接口。协议必须是受保护节点间管理channel，远程签名仅证明节点，还须当前配对和已登记canonical actor/目标范围；HTTP/UI/模型不能直接发送management enrollment来授予自己work身份。

验收要求完整原ID下：Core目的canonical human reply→手机源snapshot→实际signed transfer→desktop物理store commit→目的receipt校验→原source get_result看到当前版本真实可读资产→明确ACK；独立重开仍同canonical记录和原transfer，源Core不得新增重复Ledger条目或假本地目的store。反向human canonical必须有合法work source；没有生产host proof时，只能以明确testing host证明隔离组合，不能造node human请求作为默认成功闭环。原Codex work的生产proof仍依赖H后续接线/H2。该包的必需输入不足应返回具体协议/接口差异给根裁定，不启动另一轮泛化研究。

**完成次序。**root将W-E1交现有R2作者单owner，协调文档不自行抢占旧文件或另派作者。当前先派W-E1，让已有材料实现进入真实边缘；同一owner继续W-U15，按实际阻断点接W-RX。W-H1源码独审已接受，后续不扩大本轮真实环境范围。三类进度分别记“入口可调用”“UI15ports真实完成”“双物理节点双向闭环”；任何一项不等于原GUI/H2通过。整体维持根记录的64%，只有根按独审通过的实际用户链路更新。

**W-E1实际接口交接补记。**作者已保存旧文件dirty diff并开始接线。根核实原raw生命周期port不足后，已狭窄授权同一owner修改`packages/core/src/collaboration/material-gateway.ts`、`packages/device/src/collaboration/material-client.ts`及两端`collaboration/material-runtime.ts`中必要的`observeUnfinished`声明、调用和透传hunk，并补普通relay回归。这是上述冻结只读规则的明确例外，不扩大其他文件、wire、授权或策略。

入口在pre-admission阶段按真实unfinished上限32拒绝超量工作；原始异步链创建时、进入观察者timeout/race之前必须同步登记，只有原始链真正settle才归还槽。timeout、invalidate、调用者停止观察都不能提前释放；非material frame及早期解析失败必须释放已取得的入口槽，不能泄漏容量。observer与runtime透传须覆盖实际raw认证/绑定/签名链，不能仅包住已经race后的返回Promise。新增hunk与普通relay成功、超时、失效、早期返回及容量恢复回归一并纳入W-E1独审；原A3已冻结测试结论不自动覆盖本次扩改。

### 14.11 W-RX可派发设计：现有canonical、receiver custody与远端receipt闭环

**状态与顺序。**本节仅准备设计/接口和下一单owner写权，未授新作者、未改代码。W-E1仍在实现；W-RX必须由根选择顺序，在W-E1冻结并明确交接相关hunk后实施，避免并写main/link/runtime。整体64%保持。本节细化并覆盖14.10的W-RX候选：**不新增receiver持久registry，不把Core类复制或import到device，不增加正文Ledger。**Core原R1 registry/唯一Ledger仍决定canonical request、asset slot、actor和业务事实；receiver只持有有界短时签名投影/私有租约，持久transfer、custody descriptor、bytes及receipt继续使用原A1 store。重启必须重新获得当前投影和授权后访问既有transfer。

#### 14.11.1 已确认阻断与对应接口

| 实际阻断 | 最小解除方式 |
| --- | --- |
| DeviceMaterialRuntime要求外供authorization/custody/resolveScope/requests；signed测试用Core registry及内存core.requests填充 | 增加device生产receiver provider：本机grant＋真实signed canonical投影产生短时authorization/custody；requests通过现有MaterialClient到唯一Core，禁止同进程Core service捷径 |
| Core MaterialRegistry.registerRequest/registerAsset需要本机management permit；remote pair本身不授权 | Core仍从原本机screen/setup明确操作登记原request/asset；receiver新增显式本机接收scope配置，signed查询只投影已登记且当前允许的记录，不新增远程register/enrol操作 |
| RegistryMaterialCustodyAuthority绑定Core registry类；device不能实例化Core authority | device实现同一个MaterialAuthorization/MaterialCustodyAuthority契约，数据来自原A1持久descriptor与新鲜canonical证明，无第三份registry；maintenance仅本机store证明 |
| A1仅getTransfer(已知transfer_id)，没有按当前destination custody找回记录的只读方法 | 给原MaterialAssetStore增一个受当前authorization/custody保护的`inspectDestination`，按现有transfers_v2 identity定位、核原记录及实际bytes；不以offer创建空transfer来查状态 |
| MaterialReceiptIndex.readReceipt强制registry.localStore，无法验证真实remote destination | 在同一index增加remote locator分支；通过当前目的节点signed receipt.probe重新验证，不填假local_store_id、不将JSON receipt当本机提交 |
| CoreMaterialRequestService.attachReceipt是可信integration方法，但runtime未暴露该闭环 | runtime在原source当前get_result路径内调用受限remote refresh＋原attachReceipt；仅关联真实receipt ID，不修改A2 wire、不替source ACK |

#### 14.11.2 显式grant：实际来源与默认启动

新增`collaboration-material.json`作为原LocalStateTransaction管理的第四个授权文件，继续同一descriptor lock、atomic写入和watch/ABA epoch；它是用户接收范围配置，不是request registry。配置version、pinned owner_id、endpoint_id及单调authorization_generation，最多32个显式grant；每个grant绑定当前canonical Core node/key配对、完整本机destination（单一work或已注册本机node endpoint）、动作`receive_result`、可选更窄exact request、有效期及不超过A0的限额。node_id必须等于实际signer，local_store_id由本机固定endpoint配置映射，不能由远程body指定路径或store。缺失、旧版本、owner不符或撤权均deny，不从read/control scope推导，也不因paired成功自动写入。

生产配置入口使用现有本机device CLI/setup授权事务：新增明确`material-scope`查看、授予和清除子命令，复用当前配对核对、实际endpoint/work元数据核验及运行时reserveChange，输入严格parse；本包实现入口但不在真实配置执行。选择已有work只允许为该work接收限定字节，**不签发原生work-origin/model tool身份**。Core注册request/asset仍走原local owner screen授权入口；incoming signed canonical.resolve不能自己调用management或扩大grant。setup UI后续可复用同一setter，不能另写sidecar。

默认main在W-E1实际peer/current-proof建立后自动加载该文件并构造真实receiver provider；已显式授予且满足当前canonical证明时无需额外依赖注入即可工作，缺grant时报告grant_required。不得增加默认false功能开关、测试provider、caller传allow布尔值或`environment:testing`使生产看似ready。配置撤销/restore、配对key/generation变化、store换inode及停机立即invalidate私有证明；恢复配置必须重获新证明，不恢复旧lease。无host时仅能验scope/list及非canonical的受限入口；不能假定node endpoint足以建立human canonical闭环。human_material和agent_task强制source.kind=work；material_to_work可用node source，但必须有exact target_work且与target node/endpoint一致，并取得对应当前受信work注册。接收grant不替代这些proof；material_to_work的target证明按14.12独立实现，不要求模型source dispatch。

#### 14.11.3 最小受保护节点间协议（不改A0模型wire）

新增`ash.material.provider.request.v1`和对应`response.v1`，沿W-E1真实GatewayClient签名/当前连接forward。仅两个固定操作：**canonical.resolve**由receiver向canonical Core查询；**receipt.probe**由canonical Core向实际destination查询。外层from/to/message_id/reply_to/call_id、最大30秒deadline、key/pair/generation和单次nonce必须匹配；envelope仍64KiB，真实unfinished总预算沿W-E1，不新增无界队列。协议不出现在capability/model工具、普通HTTP或浏览器net API中；不含通用register、file、SQL、path或actor impersonation操作。

`canonical.resolve`输入仅受限locator：私有binding_id、request_id、当前result_version、asset_id/asset_version与固定目的。Core从实际签名peer和私有登记解析当前actor/请求，核原registry grant、canonical locator/payload hash、非tombstone/nonprovisional asset slot、原result当前版本及真实return_to；不能根据输入owner/principal作选择。来源不同但request_id同值也必须精确隔离。输出metadata-only投影：canonical node/authority与generation、request locator/hash、真实owner/source/target/return_to与角色映射、result版本、精确asset hash/length/media/expiry及传输方向、证明到期与nonce。无需发送goal/summary/完整正文，也不向receiver复制Ledger行。

receiver验证该响应来自已配置canonical peer的当前公钥，当前本机grant确切涵盖destination，投影source/target与实际入站asset sender/配对及已登记binding一致，work字段完整，asset与offer完全相符。Core签名只证明Core说过这些metadata，必须同时有本机显式grant及Core现有当前注册；合法签名不自动enrol。原result尚未发布、版本不符、slot provisional或host身份无法证明时不签有效投影。首包顺序为先提交canonical human reply、再传其中已登记文件；UI可显示结果已产生但文件未到，不把该时序当完整到达。

canonical.resolve直接读原registry＋Ledger/facade的受限投影，不调用含remote receipt refresh的外层get_result，防止Core→receipt.probe→canonical.resolve递归死锁。receiver可以在接收/读取操作前异步刷新证明，取得后用同步current在每个IO/返回边界核本地grant、peer/registry观测generation与证明deadline；不可把待await网络查询放入同步current。远端未观测撤销依靠每次重新查询及短时有效期收敛，不宣称跨网络瞬时撤销或实时订阅。

`receipt.probe`输入是同一request/result/asset完整locator，已知receipt_id/transfer_id可以作为需匹配的期望值，不能作为权限。receiver在当前本机grant、新鲜canonical投影和固定物理store下查原A1 committed/acknowledged记录，重新核descriptor、当前file身份、全部bytes长度/hash，返回原receipt（不重生ID）以及绑定本次nonce/peer/generation的签名证明；没记录返回有权限下的not_found，partial/unknown不冒充receipt。零字节文件也须核实际file身份与存在性，不能因没有chunk就直接成功。回执读取不ack transfer、不ack result、不创建业务记录。

#### 14.11.4 receiver本机租约与A1恢复

新provider只在内存保存最多128个当前投影/租约映射，并受32真实unfinished入口限额；descriptor来自receiver自己核验的元组，不接受远端直接序列化的MaterialCustodyLease。authority_id绑定实际receiver node和store；custody_id按canonical authority/owner/request/asset/version/方向/本机store稳定计算，generation留在私有lease current记录中。descriptor业务expires_at取已登记asset/request/显式grant固定上限，不混入每次30秒传输证明的滚动期限；否则新一轮投影会改变descriptor导致原A1无法恢复。证明过期只废弃访问lease，重新授权后仍须得到同一个稳定descriptor及原transfer/receipt。

新`inspectDestination({request_id,asset_id,asset_version}, binding)`在MaterialAssetStore内部使用既有identity/transfers_v2，不导出数据库、正文、路径、descriptor注册或任意scan接口。复用run/validate/current/custody和原文件验证，限定`destination_transfer`，核零/非零文件，返回原TransferFact；不存在不创建，只有明确可恢复的原提交间隙沿既有recover语义恢复，unknown保持unknown。不改变原offer/put/commit/read/ack wire。每次read/probe都重新取得actor与custody，maintenance由固定store root/signature/文件身份签发，不能借历史actor grant做GC。

device requests port使用当前私有source binding调用原MaterialClient，返回原Core事实；入站远程provider消息只承担限定接收/probe，无权替本地work调用submit/reply/get_result/ack_result。原source业务动作仍需原host/current grant。反向asset sender的本地source snapshot沿Core现有store及registry，不复制receiver authority回Core签名。多轮与重启只恢复原A1持久事实，短时投影丢失必须再查canonical。

#### 14.11.5 Core远端receipt与原A2闭环

同一个MaterialReceiptIndex数据库使用显式local/remote locator discriminator；local现有验证保持，remote行只保存canonical request/result/asset、destination node、原receipt/transfer IDs及重查所需locator，不能装填local_store_id。旧行按local读，受保护migration不得丢旧记录或变成可重放空状态。若能够仅按request store已有receipt ID及当前canonical metadata重查而无需新locator行，优先免迁移实现；不能另建receipt数据库。

`readReceipt`的remote分支先验证当前调用context及canonical exact scope，再经真实signed receipt.probe取得当前证明，核return_to节点、result版本、asset hash/length/receipt IDs和当前peer，最终同步fence后返回标准AssetReceipt。不存在/离线/过期/unknown分别保留真实错误，不用旧缓存receipt撑成功。A2现有先request级定位、再exact asset级授权并二次readReceipt的流程完整保留；新provider不能让粗粒度locator查询绕过第二次校验。

runtime在已授权source的get_result操作中，对最多4个当前result assets刷新目的receipt并通过现有CoreMaterialRequestService.attachReceipt关联原ID，使用同一source context及request/result版本；不能拿目的节点签名直接假扮source或代行ACK。内部调用使用原request service的未包装入口，避免attachReceipt中的get_result递归刷新。提交成功到index/attach之间崩溃时，重开后probe原A1 transfer并关联原receipt，禁止重新offer/复制bytes来造回执。原source明确ack_result才更新claimed_result_version，probe/attach/预览都不更新。

#### 14.11.6 单owner文件权与默认入口交接

根可将整包交W-E1原owner顺序实现，或在W-E1独审冻结后显式交接；不得同时改同一文件。新增device `collaboration/material-provider-protocol.ts`（严格DTO/parser）、`material-provider-channel.ts`（两个固定signed操作与真实unfinished生命周期）、`material-receiver-provider.ts`（短时authority/custody）、`material-receive-scope.ts`（显式grant parser/store）；新增Core `collaboration/material-remote-provider.ts`（canonical投影/remote receipt组合）。新增普通scope/channel/receiver/reverse-runtime组合tests及临时双节点fixture，不新建研究runner。

需要根逐项授权的旧文件hunk如下；这张表是拟交接，本文未授权执行或修改代码：

| 文件 | 精确必要变更 |
| --- | --- |
| device `collaboration/local-state-transaction.ts` | 第四个材料grant文件名/限额/watch纳入现有capture/write；原三文件语义保持，补原事务回归 |
| device `cli.ts`及setup service/scope-settings | 增加material-scope显式授予/查看/撤销与同一事务setter，检查实际配对/固定endpoint及runtime reservation；不安装、不运行真实命令 |
| device `collaboration/material-store.ts` | 仅destination只读定位＋真实bytes再证明端口及其边界测试，原wire/配额/存储模型不变 |
| Core `collaboration/material-registry.ts` | 仅受当前已登记actor/receiver授权的metadata projection窄方法；从原canonical和asset取值，不新增remote register/隐式grant |
| Core `collaboration/material-receipt-index.ts` | 同一index的remote locator/probe分支及必要明确migration；local路径回归 |
| 两端`collaboration/material-runtime.ts` | 实际provider构造/lifecycle/remote request port、限定attachReceipt接入；保留W-E1 raw observer，close等待真实工作 |
| W-E1两端`material-link-bindings.ts`、link/main | 仅固定provider envelope分发、当前proof透传与默认main构造新provider；不得留下默认永远disabled的optional hook |
| Core `collaboration/material-gateway.ts`及device runtime对应import | 现有A3无Core业务依赖却在Core目录；必要时将实现机械迁到device同名模块，Core旧路径只re-export，保留W-E1 observer并跑原relay回归，消除device→Core运行时import；不顺带重写策略 |

无需修改A0模型协议、A4 DTO、Android桥、host-proxy或正文Ledger。若作者发现更多必要旧hunk，先交根精确差异，不能靠直接SQL或fixture provider绕过。每项扩改随W-RX独审，旧冻结结论不自动覆盖新分支。

#### 14.11.7 交付与验收（必须默认路径真实运行）

两个独立临时state/root/signer，通过正常main factory与W-E1实际OwnerLink/ClientLink构造；只替换外部网络socket/原生模型。先用正式scope setter写临时显式grant，Core通过正式local screen注册canonical request及输出slot，再运行Core human reply→Core snapshot→signed transfer→device目的store→signed probe→Core attachReceipt→source get_result→明确ACK。该human canonical必须用合法work source：生产验收依赖真实host provider；在其未就绪期间，组合测试须明确使用testing host proof并严格保持A0 kind/source/target_work约束，不能改造node human假闭环。两种测试结果分开记账，fixture不计生产Codex host完成。

验证源Core唯一Ledger无重复、device无Core import/内存对象调用且无新增registry/正文DB；两端重启后原request/transfer/receipt ID连续，commit到attach崩溃能只读恢复。覆盖无grant虽paired拒绝、grant撤销及ABA、错canonical节点/key/绑定、同ID跨owner、错work/result/asset/hash/方向、篡改/丢失目的bytes、零字节、partial/unknown、离线旧receipt拒绝，源端仅缓存副本不得满足目的证明。并测30秒证明刷新不使稳定descriptor/业务expiry改变，挂起provider work占真实槽不无限增长。

验收须包含正常CLI/setup临时配置→默认main自动构造→旧真实link分发；scope/list可在无host下真实通过，canonical成功链须具备前述真实host proof或明确标注为testing host组合，不能只调用新类并注入allow fixture。完整TypeScript、现有local receipt/A1/A2/A3/R1/R2及W-E1相关普通回归，再由另一Sol独审。通过只意味着双物理node provider与默认接线完成；真实宿主身份、原GUI/普通图标/H2、A4完整15ports和Android真机用户闭环仍逐项记账。根保留最终执行顺序与进度裁定。

**生产work-origin proof入口依赖（不含14.12独立material_to_work target证明）。**Core `MaterialHostProofProvider`的`currentEpoch()/capture(bindingId)`必须由实际受保护host bridge提供，返回当前principal/pairing、完整WorkRef、expiry与同步current，并绑定真实native/connector generation；W-H1进程/代理证明或S-ID手机node签名本身都不签发work身份。入口通过`MaterialRegistry.workActor(managementPermit,bindingId)`取得私有actor proof，再由真实local management screen登记request/asset；HTTP screen resolver只能把已授权screen的exact request/role映射到该当前proof所签context。source的get_result/asset-read/consume不能借target localNodeActor身份完成，浏览器选中WorkRef也不是proof。生产仍缺此host provider及私有screen→proof绑定闭包；W-RX只补receiver/canonical查询/receipt，不能凭新增receive grant关闭这些缺口。

#### 14.11.8 S-ID前置：真实Android native signer authority，保留原phone node身份

**新增实际阻断。**已核对Core `main.ts`：存在config.host时使用`await hostLink.signer()`，仅standalone使用fileSigner。`host-v2.ts`通过认证`GET /key`取得id/publicKey、`POST /sign`取得签名；Android `HostServer.kt`已有这两个受host token保护的端点，token来自app私有Secrets并由CoreProcess写进本机启动配置。R1 MaterialRegistry.open及signerFingerprint却硬要求stateDir/device.jwk，故当前生产phone路径不能直接打开材料registry。禁止为绕过此条件切换fileSigner、生成手机device.jwk、导出Android私钥或改变node identity。

根可立即交原W-H1作者并行实施独立S-ID小包，无需用户真实环境操作或新授权。main继续由W-E1作者独占，S-ID仅向其交付构造接口，不并写main；registry窄hunk由根明确交给S-ID。新增`packages/core/src/collaboration/material-signer-authority.ts`与`packages/core/test/material-signer-authority.test.ts`；精确修改`packages/core/src/host-v2.ts`、`collaboration/material-registry.ts`；main中原signer选取/registry构造hunk由W-E1作者合入。Android源码本包只读，已有/key与/sign足够做第一版真实证明；若发现必须新增native端点，报告根另授权，不假设已有同步native lifecycle接口。

**最小来源接口。**新增私有opaque `MaterialSignerCustody`，描述当前物理node签名权，不是MaterialHostProofProvider的Codex work身份。建议实现`NativeMaterialSignerAuthority`私有构造器及`static async fromHost(host: HostDeviceLink)`；对registry只暴露`capture(signer: Signer): Promise<MaterialSignerLease>`与同步`current(lease): undefined`，capture必须验证原gateway signer与该host当前固定node/key一致；lease含原signer、固定id/publicKey、本机来源generation和opaque身份，不含token/私钥/配置正文。模块私有登记或不可伪造实例校验签发对象，拒绝仅传`{source:'native_host',current:()=>undefined}`。生产来源只有原file key与真实HostDeviceLink两种；文件路径未提供新authority时保持原完整device.jwk权限/身份/JWK匹配＋challenge逻辑，不移除其默认验证。

native来源只能由真实HostDeviceLink实例在本机受信启动配置下构造。HostDeviceLink捕获不可变URL/token配置与自身实例generation；用于证明的URL限制既有本机loopback host入口、固定/key和/sign路径、拒绝redirect、超时/响应字节有界，不能接收模型或HTTP提供的host地址。配置原始token仅在HostDeviceLink私有持有并用于Authorization；authority/lease/status/error及测试报告均不携带token或其可复用替代值。真实配置来自main现有受信启动参数与Android本机生成配置，不能以远端请求携带同形对象创建host authority。

新增受控`captureSignerProof/refreshSignerProof`或等价私有方法：取得/key、验证deviceIdForKey(publicKey)等于id；对本次随机challenge调用/sign并实际verifySignature，再核/key及捕获的本机配置/lifecycle未变，才签发有界proof。原Signer.sign也必须在调用前后核本实例未closed/未失效、固定key，验证实际签名属于该key；失败、超时、key改变、观测到host失联以及close使单调generation失效。恢复同key仍重新签发，迟到响应不得复活旧lease。

authority/HostDeviceLink自己持有一个有界refresh生命周期：启动capture、证明到期前健康renew、sign前按需renew，close清timer并跟踪raw异步工作。连续成功且key/config未变可保留身份generation，current核最新私有有效证明；任何失效、到期空窗、错误或key/config改变必须递增epoch，之后恢复不能复活旧registry/session。不能只向registry交一次30秒lease而默认运行30秒后永久disabled，也不能由调用者直接延长证明expires_at。

同步current不能伪装网络实时查询：检查本实例closed状态、配置身份、已观测lifecycle/key generation及证明截止时间；需要刷新时先在异步admission/capture/sign边界执行有界key＋challenge，再同步核。短时证据的上限明确设置（建议30秒）且刷新不能无限延长已撤销旧lease；不声称能即时发现尚未观测的native重启。健康检查可触发失效，但现有60秒manifest健康轮询本身不是key证明。任何观察到的断开/错误/重配均在当前操作返回前invalidate，opaque lease不跨HostDeviceLink重建复用。

**registry适配。**open按真实authority来源获得并挑战同一个gateway signer；DB authority仍为原`material:<phone node id>`。file来源继续signerFingerprint对device.jwk核对；native来源改核私有已签发custody lease及其generation，不能返回常量fingerprint或跳过currentEpoch的身份检查。签名成功并不代表任意node可信，必须同时是main当前hostLink的原signer、已固定publicKey与当前配置。registry/factory调用期间捕获lease，异步后与最终返回前重核；authority换代使已有material contexts失效。W-E1作者在正常main的host路径使用原`await hostLink.signer()`与`await NativeMaterialSignerAuthority.fromHost(hostLink)`，向Core runtime/registry同时传入两者；standalone不传新authority且完整保留旧验证，不留只供测试构造的optional注入入口。

**S-ID验收。**临时真实HTTP host fixture实现现有/key、/sign并持实际测试私钥，走HostDeviceLink.probe→signer proof→正常Core材料构造：没有device.jwk仍以原phone id成功；未授权host、伪id/key、错误签名、响应超限/redirect、关闭/过期/重建/迟到proof均拒绝，旧lease在恢复后仍失效。standalone原file校验及registry组合回归，禁止测试写device.jwk偷渡phone模式，日志零token。完整TypeScript与独审通过才接受物理签名来源适配；不计Codex work host、receiver grant、W-RX反向字节或H2完成。

### 14.12 W-TARGET：手机material_to_work不等待模型来源proof

**核实结论。**产品v0.5的“继续已有工作/补充材料”和技术v0.2的目标节点再次授权、读取/控制分离，允许并要求独立实现targetWork proof。手机是`material_to_work`的合法node source，target_work必须完整且与target node/endpoint一致；目标存在且获准接收输入的证明，不是该原生模型正在代表work调用工具的证明。此前14.10–14.11将所有canonical目标登记都归入workActor/host-source门槛的表述，以本节按kind拆分为准。human_material与agent_task的work source仍需要真实模型来源proof，完整双向Goal不变。

已读实际`ControlAuthorization.begin`：由ClientLink赋予的TrustedCallContext、pinned owner、独立control授权revision/action/期限、完整WorkRef，以及native metadata中的exact cwd组成目标授权；每次异步metadata后重验原配置。`createDeviceControlRuntime`的私有metadata通道仅initialize＋`thread/read(includeTurns:false)`，核实际listener/executable/version/连接epoch，不依赖模型tool dispatch、不resume或start。`codex-read.ts`也先核thread id/cwd，但其保存历史只证明目标存在于当前获准目录，不能证明可发送、忙闲或拥有活跃会话。故W-TARGET可先于H-source provider完成；真实Send仍依赖原已配置可用的S4控制入口，未配置时诚实offline/config_required，不启动替代引擎。

#### 14.12.1 最小生产包与proof方向

新增device `collaboration/material-target-work.ts`，提供受保护`captureTarget`及current/check/release生命周期；新增Core `collaboration/material-target-provider.ts`，只从实际当前目标节点的认证响应签发私有opaque `MaterialTargetWorkProof`。输入是完整WorkRef、当前read/control授权revision及固定用途；transportOwnerId、配对身份、公钥和节点来源由原link/current-proof注入。浏览器选中WorkRef只是选择，不是proof；Core不能仅把read列表行包装成获准send。

将proof分为明确事实而非混合ready：`target_known`经当前受限metadata核exact WorkRef/cwd；`send_authorized`还要求原ControlAuthorization对send_input（或明确steer）成功及当前真实control runtime可用。首包可直接以原control metadata实现两项的交集；若control不可用时支持read-only目标预览，必须保持send=false，不能为了目标proof偷偷放宽control。发送调用始终由原S4重新authorize，不把签发target proof当作后续不可撤销的写票据。

目标metadata未知时执行一次有deadline、精确thread ID及includeTurns:false的真实查询；可用已授权保存历史入口核target_known，或者原control metadata核send资格，不以`native-source-notready`一概拒绝目标选择。查询失败分别报告offline/not_found/permission/unsupported，禁止无界扫描历史、重复resume或模型探针。短时proof freshness与请求业务有效期分开：capture deadline只限制该次使用，registry request及A1 descriptor期限仍来自请求/明确grant的固定上限，不能因一次30秒proof把原材料请求永久缩成30秒。

跨端采用一个固定受保护`target.resolve`操作，复用W-E1 signed provider通道的peer/key/pair/generation/deadline与unfinished限制；若W-RX provider协议尚未实现，由本包先建立其窄基础及此单操作，后续W-RX添加canonical.resolve/receipt.probe，不造第二套relay。响应仅包含验证后的work/cwd、目标节点generation、授权revision、可用动作和短时期限，不包含模型principal/source身份。Core签发的opaque proof只能用作`kind=material_to_work`的target参数，不能转成MaterialActorProof、MaterialTrustedContext或workActor；禁止作为human/agent source、agent producer、reply/work_result作者或source get/ack能力。

原R1 `registerRequest`目前一律给target `reply`，因此新增`registerInputTarget`窄入口或明确proof判别分支：source必须是当前phone localNodeActor，request必须material_to_work，target必须等于proof的exact target_work，回执关联原request/client IDs。target登记是“投递目标”，不签发模型actor；其目标侧默认不写reply grant，generic context(proof)/currentProducer必须拒绝此proof。持久记录要保留target proof用途discriminator，重开后重新查询当前target证明；不能把row中target_actor字符串重新解释成真实work-origin。以后真实模型work_result需要另行受信host绑定核同一目标并授予reply，该交接不在本包伪造完成。

CoreMaterialRuntime不得因缺hostProofs而拒绝构造整个材料runtime：保留真实peer/signer/registry来源，允许local-node→受保护target的material_to_work子集；`workActor`无host provider仍拒绝，work_origin/agent_task仍false。不安装假的hostBridge或always-unsupported对象满足构造参数，不修改human/agent kind限制。source phone的注册/查询来自本机management screen actor，与desktop目标proof分属不同role和节点，不能互换。

#### 14.12.2 W-U15的直接用户链

同一用户操作顺序：原按需列表/详情选定已有Codex工作→系统picker选材/输入文本→受控草稿保存→submitInput登记phone source及确切target/slots→用户明确Send→原S4发送并查询原journal。submitInput只登记材料，不启动工作；sendInput/queryInput直接保留原operation_id/client_message_id、authorization_revision和expectedTurnId语义，unknown只查不自动重发。S4接收回执与material结果分开展示：发送accepted不宣称模型已读文件、不写work_result或claimed_result_version。

单纯发送文本或明确标示的link_only引用可先走既有S4，不需要模型source proof；真实附件必须另外有desktop显式`receive_input`权限和当前目的store custody/receipt，不把send_input grant当文件访问权。材料未到时不得无提示先发正文；只有用户明确允许部分发送，才沿原ID发送并列明缺项。传到desktop受保护store也不自动证明模型可读：若原生输入adapter只支持text，先使用当前实际受支持的限定引用/文件消费接口并验证可用性；未有模型文件消费路径时保持“已到设备、待工作读取”，不注入file路径/工作目录副本冒充附件消费。该限制不阻止文本与明确引用用户链，但完整附件验收仍待对应provider/消费接口。

#### 14.12.3 W-RX按kind拆依赖

| 流程 | canonical及方向证明 | 不可借用的角色 |
| --- | --- | --- |
| 手机material_to_work输入 | phone local-node source＋targetWork proof；源phone snapshot→target_work目的store；显式receive_input grant；canonical可处于registered，按已登记输入asset slot/hash查询 | 不需native模型来源dispatch；目标proof不得发表work_result，不给source actor身份 |
| 原work human_material请求手机 | 真host work-source proof＋phone target actor；reply发布后phone snapshot→原source/return_to work目的store；receive_result grant | phone/local screen或target metadata不能替work source发起请求 |
| agent_task | 真work-source及已验收实际目标capability/producer授权 | 目标可接收输入不等于能代表agent执行或回报 |

因此14.11的canonical.resolve必须显式区分`input_asset`和`result_asset`用途：输入分支只允许material_to_work当前注册的request/context.refs及非provisional input slot，方向source→target_work，不强制等待result_version；结果分支保留当前result_version与return_to校验。provider响应及custody绑定用途/原request/hash/asset/方向，不能跨分支复用。receive_input与receive_result均走同一显式material scope配置和A1库，不因已有其一自动授予另一方向。既有node/work source parser约束不变；手机material_to_work是有真实target证明的合法生产例外，不是假node human测试。

#### 14.12.4 可派发写权、依赖与ordinary验收

这是下一设计packet，根决定实际分发与顺序。W-E1冻结后交单owner实施；S-ID仍归原owner，不能抢其host-v2/signer-authority hunk。新增上述device/Core target模块、必要provider协议/通道基础及`material-target-work.test.ts`、`material-target-integration.test.ts`。精确申请旧hunk：

具体分发建议为原S-ID作者承担T1新增target provider、device control-runtime私有只读capture port及R1 opaque target proof窄hunk；W-E1 link/main/runtime在其review期间不并写，导出接口交原入口作者串行合入。T1后紧接T2已登记输入slot的A1 source snapshot→真实desktop store transfer，以及W-U15 ExplicitSend/S4；不得把T1证明类完成作为首用户链结束。T2复用14.11中输入方向所需的显式scope/receiver custody与同一A1库，不等待human result/provider全包或模型source dispatch。

- device control-runtime的受保护metadata/授权capture窄port，复用原watch/generation/ControlAuthorization/真实listener；不暴露任意native method、token或未经授权metadata，不改S4 journal/invoke策略。
- Core registry增加target proof私有签发/用途和material_to_work登记分支；target reply grant及currentProducer/context严格区分；必要小schema migration保留旧数据原角色，不把旧未知row升级为target或source证明。
- Core material-runtime按kind允许无hostProofs构造目标传材子集，readiness拆target_input/work_origin；Core admission/registry discovery只为material_to_work走targetCurrent，不以currentProducer强迫等待模型source，也不让agent_task走该分支。
- W-E1两端material-link-bindings/link/main仅固定target.resolve分发和真实默认provider构造；原transport证明及peer权限来源保留。W-U15新增material-input-service实际调用target provider与原S4，旧UI/main由根交同一owner顺序接线，不并写。

ordinary tests必须不使用testing host证明：两个真实临时节点及配对/显式control配置、原native metadata/control socket fixture，正常生产构造→phone本机screen actor→target.resolve→登记合法material_to_work→用户明确Send→实际S4 adapter/OperationStore→query原回执。prove目标capture只读不会resume/turn；同名不同ID、错node/endpoint/cwd、删除/metadata变化、control grant撤销/ABA、read-only无send、listener换代均拒绝或准确降级。target proof放进source/reply/agent dispatch/context全部拒绝；没有host provider时该手机输入链可成功，但human/agent work-source仍失败。

另验save/submit不send、unknown查询零重发、原ID冲突、explicit steer同turn、原read/control/create回归。**首手机材料用户链的接受条件必须包含真实两物理store＋receive_input权限＋当前receipt/hash字节验证，再ExplicitSend/S4；不能退化成text-only或仅proof类收口。**text/link_only成功可单列阶段证据，但目标文件未到达时整条材料链仍未完成，模型消费证明继续准确分层。完整TypeScript和独立review通过后按实际用户链记账；不需要本轮真实桌面切换、安装或模型source研究，不提前关闭反向human材料/H2/完整Goal。

### 14.13 T2首文件链：受保护reader、输入manifest与原S4幂等

**状态与范围。**T1作者已落target port源码，仍以根最终独审为准。本节记录设计及后续限定证据；协调者本次仅只读核报告/源码并维护文档，未启动native、daemon或模型，未改配置/安装依赖，整体仍为65%。后续独立的临时native消费测试已有一张小PNG及UTF-8全文的证据，详见14.13.5；该证据不覆盖原桌面、默认Link、真实A1或4 MiB真实native消费。T2首个消费profile设计为真实PNG/JPEG图片及严格UTF-8文本文件；PDF/DOCX、扫描页、其他媒体解析仍是明确未完成项，不能把unsupported计为完整附件Goal完成。T2与输入方向receiver/canonical/A1接线共同构成首链，单独reader测试不意味着手机用户链完成。

#### 14.13.1 固定版本证据与消费路径选择

本地已生成的`/tmp/ash-h3-proxy-isolation-20261010-d/schema/v2/UserInput.ts`来自研究记录中的`codex-cli 0.162.0-alpha.17.2`；实际二进制SHA-256为`0d5ac7aae20c4eda6242428d5e218c55ba96d8763fda2a271088ff37104b9d28`，ClientRequest schema SHA-256为`29df6f372314d84d00436b23a3f6f0bfbcb81e646379464344f140ba18dd7019`，可复核[原H3证据](../tools/research/material-host-proxy-isolation.md)。UserInput实际联合是text、image（url或fileId）、localImage、audio、localAudio、skill、mention；`TurnStartParams`与`TurnSteerParams`均接受UserInput数组，**没有generic file/PDF/document输入类型**。当前项目`codex-control.ts`和`host-proxy/method-policy.ts`却只允许单个text，因此仅上传A1不能把附件送到模型。

上游[UserInput定义](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/user_input.rs)及[local media转换实现](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/local_media.rs)佐证图片可进入模型输入；后者把localImage读取为图片data URL。上游main不是本地固定版本的消费实测，不能代替该版本验证。mention/skill的path不是通用文档读取接口。

**最终推荐为内部受保护reader→图片私有staging/localImage＋小UTF-8实际正文。**设备端从自己的目的A1 store读取已经提交的原字节，图片写入自己持有的不可变staging并构造`{type:"localImage",path:privateStagedPath}`；这个path仅由受保护reader派生，不是浏览器或用户文本提供的路径。UTF-8文件把实际完整内容编入text条目并标明asset ID/version/hash及文件内容边界；没有“仅文件名/路径/下载链接”代替正文。原用户说明与文件内容始终是user输入，不提升为系统指令。UI不能提交url、fileId、path或native input对象；无workspace复制、无全盘reader或远程URL取数，也无需模型来源MCP proof。512 KiB内联图片方案仅能作为中间阶段，不是T2最终消费范围，最终实现应直接选择本staging路径。

首profile `staged-image-utf8/v1`：最多4个资产，单图片覆盖原4 MiB上限，总量沿既有MATERIAL_LIMITS.request_bytes；Ash不重新压缩/缩放、不改原hash。所有内联UTF-8文件实际内容、固定来源标记及用户说明合计不超过64 KiB，严格解码拒绝无效UTF-8，首包拒绝含NUL的二进制伪文本。按实际序列化再次核整个native请求不超过原1 MiB；图片路径很短，因此4 MiB原图无需扩大wire限制，原公开control envelope仍受64 KiB限制。图片核MIME/签名及有界头部尺寸，native完整解码失败保留真实错误，不能凭头部核验宣称可消费。超限或未知类型在发送前明确列出待处理资产，默认零native发送，不能静默截断/降质/漏图。UTF-8大于64 KiB以及PDF/DOCX仍是T2-D未完成项，原4 MiB选材/存储范围不缩小，只有小文件profile通过时不接受完整T2。

静态实现可行性：官方local_media实现通过path打开并有界读入，随后解码并生成data URL；它不接受我们提前打开的fd，故“发前fstat通过”本身不能消除后续path竞态。生产reader必须在私有0700根下用不可预测文件名/O_EXCL/O_NOFOLLOW创建0600文件，写完fsync、核hash/length、记录目录及文件dev/ino/nlink并只读持有；无其他Ash路径可覆盖/替换此文件，staging maintenance遵守active pin。每次RPC前重核fd和path及目录身份、当前lease；原A1维护不能删除staging副本。保护范围是本机可信进程/账号边界，不冒称防御同UID任意恶意代码。它是受控消费缓存，不是第三本材料账本；原A1仍是事实来源。

staging pin绑定原operation/attempt/client message/native generation及manifest。不能在turn accepted时假定native已读而立即删除；保持至已证明该输入快照进入native模型请求/可验证持久历史，或关联turn终止并排空原native读取，unknown只查询不重发。重启后仅由当前A1与同manifest重新验证已有私有cache，不能新建operation或凭路径复活授权；旧claim未知时保留原unknown。缓存总量/文件数计入原材料配额；到业务TTL尚无消费证据，明确消费过期/未知并停止新send，不报告完成；只有相关进程/读取已结束才清除活动pin文件。持久cache元数据仅操作ID/hash/文件身份/期限，归既有材料store管理，不存新canonical正文。固定native可能resize，最终模型图像编码hash与原文件hash分别记录，不能要求默认转换后仍字节相等。

#### 14.13.2 公开选择与私有证明分离

对现有`ControlRequest.input`做向后兼容的显式可选扩展：`{text, material?:{version:1, profile:"staged-image-utf8/v1", request_id, assets:[{asset_id,asset_version,sha256,byte_length,media_type}]}}`。此处material.request_id是canonical材料请求ID，与S4 request_id分别绑定，不能混用。assets保持明确顺序，1–4项且asset ID/version不重复；字段严格解析、未知键拒绝。每个公开字段都是待核断言，不是授权。无material时现有v1文本行为、限制、digest与历史row完全保持；新字段只在确认支持该profile的目标暴露，旧端严格拒绝而非退化为只发text。submitInput/sendInput由服务从canonical slot构造这些描述，浏览器即使直接调用普通control/apply也必须走同一目的端验证。

新增device `collaboration/material-input-reader.ts`，私有入口`prepare(selection, trustedControlContext, exactWork)`：核当前配对/peer、原ControlAuthorization与明确send动作、material_to_work canonical request、source phone actor、目标proof与exact target_work；按input_asset方向读取非provisional canonical input slots，并逐项比较版本/hash/长度/MIME。再核显式receive_input及目的store custody、当前transfer/receipt，按原`readChunk`有界读完并重新计算完整hash/length。仅有receipt ID或仅调用getTransfer不够；从Core源副本读到相同bytes也不够。复用T2输入receiver的canonical/current port和A1库，不让device import Core，不创建第三个registry/正文账本。

返回模块私有opaque `PreparedMaterialInput`（对象身份登记，普通JSON不可伪造），内容包括精确manifest、确定性内容hash、本次native序列化hash、staging pin和current/release。reader在读取前、每次await后、journal claim前及最后send前同步current检查；配对/配置/target/provider generation变化作废。读取任务受32真实unfinished上限、每操作资产/字节限额及原deadline约束，timeout不能提前归还仍在执行的槽。UTF-8内联字节只在内存保留，raw send settle后释放；staging按前述pin生命周期保留，不落OperationStore正文、不写日志或第三库。销毁/失效时阻止后续send；已经送出的unknown保持unknown，不靠清空内存推断未发送。

#### 14.13.3 journal必须绑定实际素材

当前`delivery.ts`有独立于control-protocol的严格envelope解析及digest，二者必须同时改；仅扩ControlRequest类型或在adapter中替换text是错误实现。新material请求使用domain-separated digest，固定顺序绑定原全部字段及material request_id/profile/ordered asset ID/version/hash/length/media_type。生成内容仅取不可变manifest字段（不要取后来可改的显示文件名）；UTF-8原字节与staged原图内容由此profile确定性产生。临时path不是素材身份，不参与跨重启payload_hash；本次native-input hash另含实际路径并与私有staging proof绑定，必须在准备与发送之间一致。若后续加入Ash变换/新decoder，必须新profile，不得在同profile下改变渲染规则。

沿用原OperationStore `(principal,operation_id)`唯一性与payload_hash列：同operation、同文字但换asset/version/hash/顺序/profile必须conflict，原request/client_message/attempt ID不重建。**无material保持原digest逐字节不变**，避免老操作重放被误判或静默新发。本包无需把附件正文或data URL存入journal，也无需仅为manifest另建操作库；若实现确需新列，先给根具体migration，不可擅改持久契约。

执行顺序：解析/原授权→计算含素材的确定hash并查旧fact→若非recorded返回原fact（query/reconcile不要求再下载过期文件）→新/recorded操作受保护prepare及完整bytes验证→原record/claim→再次核prepared proof与原授权→同一native_client_message_id调用原adapter。既有invoking/unknown不重发；同manifest并发最多一个claim，未获claim的prepared input立即release。prepare失败不能先发文字；record后、claim前崩溃可用相同manifest重新准备，claim后崩溃仍沿原unknown及有界history reconciliation。不使用“文本匹配”证明含附件原操作已投递。

host-proxy继续显式策略：text-only原分支保持；材料分支只认由原runtime私有reader登记的exact WorkRef/action/operation/clientUserMessageId/profile/input digest以及当前角色/配置/native generation。`WorkGrant`新增窄prepared-input约束或由角色authority查询私有proof，绝不从client params自行生成grant。只允许本profile确定的text与对应私有staging proof的localImage；字符串落在某目录下不等于proof。禁止fileId/外网url/任意localImage/audio/mention/skill，保留steer的exact expectedTurnId与原S4 scope。原GUI的文本授权不自动获得材料reader权限，目标proof也不能转为模型source/reply权限。经过受保护proxy时必须做此适配，不能为了图片绕过proxy或扩大所有角色的输入白名单。

#### 14.13.4 可直接派发的单owner写边界

建议把受控reader与journal作为一个T2-C单owner实现包，入口集成T2-I随后由原W-E1 owner串行完成；根决定实际分发，本文不占用现有T1文件。先确认T1与input receiver提供的私有canonical/receipt/current端口，缺少生产端口必须连同T2-I补齐，不能以fixture allow依赖收口。

| 所有权 | 文件与精确hunk |
| --- | --- |
| T2-C新文件 | device `collaboration/material-input-manifest.ts`（严格selection/profile/确定性hash）、`material-input-reader.ts`（当前证明＋A1真实bytes→typed输入）、`material-input-staging.ts`（私有缓存及pin）；相应manifest/reader/staging/delivery组合tests。无需新增解析依赖即可做PNG/JPEG及UTF-8首profile；既有material-store只允许缓存维护/配额窄hunk，不改A1 wire或canonical身份 |
| T2-C旧S4窄hunks | device `control-types.ts`、`control-protocol.ts`、`delivery.ts`同时支持可选material；`control-service.ts`以真实trusted context构造私有preparation；`codex-control.ts`只消费prepared input，保留metadata/current、start/steer及reconcile；`control-native-types.ts`仅必要私有类型。不改旧OperationStore唯一性/重放策略，补其原row兼容回归 |
| T2-C受保护proxy窄hunks | `host-proxy/types.ts`、`method-policy.ts`、`supervisor-role-authority.ts`仅prepared-input私有约束及当前性；必要`proxy-transport.ts`透传物理私有proof，禁止正文伪造。不得重写W-H1 supervisor或扩大native方法集；旧proxy接受不自动覆盖这次扩改 |
| T2-I串行入口 | 两端material-runtime与device control-runtime/main真实默认工厂构造reader并连接同一input receiver/A1 store；Core `material-input-service.ts`新增submit/send/query组合服务，`material-edge.ts`/server独立材料dispatch、15ports桥的sendInput/queryInput调用原Core control-service；core control-service仅解析/转发必要兼容hunk。原OwnerLink/ClientLink如无需新wire则保持，确需改由原owner报精确hunk |
| T2-I UI | `ui/js/desktop-materials-contract.js`/store/view、真实net桥与原desktop-work的ExplicitSend只交同一入口owner；展示文件到设备、已送原生、消费未证实的不同事实。UI_HTML只用原build生成，不手写旧长行 |

公开control请求没有bytes，因此不增加gateway/control公开字节上限。核心server不能把通用collaboration route当材料路由，保留W-E1独立dispatch、outer fence与raw unfinished上限。作者不得为了先跑通把readiness默认关掉、临时注入alwaysallow、伪造native或跳过旧listener验证；未配置真实控制入口仍诚实offline/config_required。

#### 14.13.5 验收层次及剩余文档reader

ordinary组合用两个物理临时A1 store、正常显式scope、T1真实target端口＋受限native socket fixture：phone选择真实PNG/JPEG（包含超过512 KiB及接近4 MiB的合法图片）和含非ASCII的UTF-8文件→合法material_to_work/输入slots→A1传完并目的hash再验→用户ExplicitSend→实际DeliveryJournal/adapter序列化出受保护localImage与完整文件内容→query原ID。fixture真正打开私有path读完比较原SHA，检查文件正文及来源标记，不能仅断言收到字符串path。保存/上传/submit均零turn；至少一个case包含真图片，不能全用文本替代附件。另测accepted后延迟读取、unknown/restart、maintenance并行不换inode/删pin，路径/目录替换拒绝及收尾配额释放；只测小内联图不能接受4 MiB图片范围。

必须覆盖：任意path/url/fileId/native array被拒绝；未commit/假receipt/源副本/错方向/错work/错版本/篡改bytes拒绝；配对、receive_input或control撤销/ABA在read、record、claim及send窗口有效；超字节/像素/资产数/无效UTF-8无隐式部分发送；同operation换素材conflict、同manifest并发/重启/unknown零重复；legacy text row digest不变；steer原turn、旧read/control/create/proxy普通回归及完整TypeScript。数据与token不得进入日志/失败消息。

上述ordinary socket fixture证明其覆盖的源码接线与真实字节读取，不自动证明固定native已把图交到模型。原设计要求另核临时隔离native＋本地Responses fixture中的实际模型请求，不能用native accepted或模型口头“收到”替代。该项现已有下面的**限定小样本新证据**，后补静态来源核实与旧H3相同的实际native hash；完整生产材料链的消费仍不能据此宣告通过。

2026-10-10补录：根已读取且协调者只读复核[本次report.json](/private/var/folders/f8/t0pkxcmn3rlb178j0ph40cjr0000gn/T/ash-t2-native-J9zDjK/report.json)与仓库[material-input-native.mjs](../packages/device/test/fixtures/material-input-native.mjs)。报告started_at为`2026-10-10T05:00:53.057Z`，status为`consumption_observed`；这是隔离临时目录、bundled binary、synthetic thread与本地mock Responses端点的测试，没有经过原桌面会话、生产默认Link或真实两端A1。mock端捕获native实际发出的`input_image`及`input_text`，不是模拟RPC仅断言路径，也不是实际云模型业务执行。

| 本次事实 | 证据与限制 |
| --- | --- |
| 图片 | 单张2396 B PNG，实际模型请求解码hash与原图均为`37f5d95d4fd29f49c0a9c31e22c04bd26e0feaaff78c463e1cee36339a81a850`；exact_image_bytes=true，仅证明这一张小PNG |
| UTF-8 | 包含中文的完整合成输入在actual input_text中逐字一致，exact_utf8_text=true；text SHA-256为`b486ad6cb63e06e7f3005d2c435d0fde6c7ff7ac3944a454d9efdb0f1643a628`；不是大文本分页或真实picker文件链证明 |
| 调用与清理 | calls=1、turn_completed=true；OS isolation selftest退出0并记录isolation_ok；native_stopped/mock_closed/deny_closed/sentinel_removed均true |
| 本次launcher | version=`codex-cli 0.162.0-alpha.17.2`；原binary_sha256与后补launcher_sha256均为`50ab38ba21d0d9f8346f32f41848382f15b556190f3c7a07e885a4fb73e379c8`，对应`/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`。fixture从研究模块导入该BINARY；它是launcher，不是原H3所记录的实际Mach-O |
| 实际native | 作者仅只读补原报告：native_executable_sourcepath=`/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`，native_executable_sha256=`0d5ac7aae20c4eda6242428d5e218c55ba96d8763fda2a271088ff37104b9d28`，与14.13.1旧H3实际native hash相同；此为后补静态来源核实，不冒称新增运行时进程attestation |
| 本次schema | schema_sha256=`8822b2ac74b727709098d0c32551cc07835207c31dbfe70a1ac5d002a3a03cff`是整个生成目录的排序路径＋内容聚合摘要；后补UserInput.ts单文件hash=`c033ab3da70c17ceae32e8b4770a2557f8ef9f59c07c5419387a45c55193fc59`，ClientRequest.ts单文件hash=`29df6f372314d84d00436b23a3f6f0bfbcb81e646379464344f140ba18dd7019`，两者均与旧固定schema证据精确匹配 |

**hash口径已澄清。**最初`50ab38…`与`0d5ac7…`的差别是launcher与实际Mach-O这两个不同对象，不是已证明更换固定native artifact；同版本字符串本身并未用于证明一致。作者后补了源路径、实际native及两个schema单文件hash，协调者已重新只读报告核实上述字段，未重新运行native。旧H3记录与本次原binary_sha256保留，分层注明计算对象，不覆盖旧值。本次schema目录聚合hash不可直接与旧ClientRequest单文件hash比较；能确认的是另行计算的两个同名schema文件hash精确匹配，不能由此宣称目录所有文件都相同。

本次接受范围只到“上述明确hash的native在隔离mock模型请求中送出了这张2396 B PNG及合成UTF-8全文”。近4 MiB图片现有证据仅为ordinary socket fixture，不能外推真实native已消费4 MiB；JPEG及其他尺寸/解码行为、默认main/Link→真实A1→受保护reader/staging→原S4完整链、原GUI/H2与业务消费分别待验。此次补录不新增任何native运行或环境动作，不提升65%进度。

PDF/DOCX不能塞进image/mention/path冒充支持。后续T2-D独立profile需要受保护reader内部有界解析器（PDF文本提取/页渲染、DOCX正文及嵌入材料），明确原文件hash、页/段位置、提取是否完整、输出限额与变换版本；超限分页需明确用户消费方式，不能暗截断。可在同reader加入固定依赖的隔离worker，白名单输入字节、禁止外链/任意文件访问、限制解压/页数/CPU/输出，仍复用A1与manifest/journal。解析依赖及package/lockfile写权由根另包批准，未实现前保持明确缺项。

**大UTF-8具体下一包T2-D1，不以缺项代替设计。**新增device `collaboration/material-input-pages.ts`复用同一个reader/A1与immutable manifest；固定`material_input.read`参数只有material request ID、asset ID/version/hash与opaque cursor，禁止path、URL、调用方principal/work以及任意byte range。每页最多32 KiB UTF-8、边界不切断码点；cursor绑定exact asset hash/profile/offset及当前work访问，不授权自身。返回实际页内容、起止位置、文件总字节数、next cursor与完整性状态；最多4 MiB、32真实unfinished及短deadline，直接读取原A1，不建全文索引/第三正文库。模型领取到哪些页和领取全文分别记录事实，不将第一页面成功标为完整消费，不静默生成多个turn或自动重复send。

该接口通过受保护native MCP bridge进入现有会话，真实host invoke/current proof必须把模型调用与本次ExplicitSend/WorkRef绑定，并保证结果归原pending tool call；public material/control routes不能裸露此reader。H1已证明直接MCP RPC可能仿造调用metadata，故不能拿target proof、工具入参或浏览器asset ticket充当模型来源。当前缺少此生产host-source入口，**因此大UTF-8仍是具体未解除依赖，T2完整范围不能接受**。解除方式是根后续授权原H owner把真实protected调用/结果custody port接给本pages模块，再在同一会话本地Responses fixture观察多页实际function_call_output、完整页顺序与末页，测试跨work/cursor/撤销/直接RPC均拒绝；不得通过放宽角色完成。普通图片和小UTF-8用户链可以先交付，完整人机双向、4 MiB文本及通用文档Goal保持未完成。

### 14.14 T2-RI：输入方向receiver与默认入口接线前置包

**派发状态。**本节冻结§14.13的消费边界，并将§14.11中input_asset方向单独收成可实施包；整体65%，无本包要求的用户环境操作。根最初仅授原W-E1作者T2-C第一阶段manifest/staging新模块，不含reader整包、旧S4或proxy写权；后续授权逐项以根交接为准。当前RI作者已落receive_input scope/LocalState/SetupScopeStore，正在接默认生产入口；control/create只读changeSafety端口另由其独占C作者处理，RI只消费该接口。T1旧provider/registry必须先根独审再串行交接，不得并写；reader及旧S4消费接线继续等待后续明确授权。根承担独审，额外agent/thread槽不足不是用户阻塞。T2-RI必须交真实默认receiver与源传输入口，不以可注入issuer类交付。完整ExplicitSend消费验收在T2-RI与T2-C合入后完成，本包可以先通过原S4文本回归但不能据此报文件已进模型。

#### 14.14.1 现状与唯一生命周期

已核源码：device `main.ts`配对后只有`link.createMaterialClient()`，没有创建DeviceMaterialRuntime；该runtime强制要求requests、bindings、custody、authorization、resolveScope及physicalCurrent。ClientLink已有attachMaterialReceiver/materialTransport/materialWork，但只分发identity/request/response三种旧材料type。Core `main.ts`已用真实file/Host signer和唯一Ledger构造CoreMaterialEntry，OwnerLink已有materialTransport及peer/current证明，仍没有输入源snapshot/sender与目标provider组合。Core runtime的assets入口调用storeFor(destination)，因此不能拿它读取phone源snapshot；源端需明确snapshot窄port。Core ReceiptIndex目前仅支持本机destination，不能把远端receipt塞入local_store_id。

同一物理phone/Core是canonical与source snapshot所有者；desktop/device是destination A1与短期custody projection所有者。Core唯一Ledger保存canonical request，R1唯一registry保存输入slots；receiver不建立request/actor持久registry，不落canonical正文。receiver持久事实仅原A1 metadata/bytes及T2-C受控cache，canonical proof和context投影在内存最多128项。重连/重启只重查当前canonical并恢复原A1 ID，不能重建业务request。

正常链为本机management screen→localNodeActor→T1 target.resolve→registerInputTarget＋canonical submit＋输入slot→原A1 source_snapshot→固定signed offer/put/commit→desktop receiver核Core canonical.resolve及receive_input→原A1目的commit→signed receipt.probe→Core只更新输入transfer展示→用户ExplicitSend时目的端T2-C再次captureInput/read hash→原S4 journal。上传与保存不调用turn；input receipt不挂到虚构result_version，也不触发ack_result/claimed_result_version。

#### 14.14.2 显式receive_input配置，配对不是授权

新增`collaboration-material.json`（version:1，最大64 KiB），纳入原LocalStateTransaction descriptor锁、原子写、同步revision/epoch与watch。配置字段为owner_id、endpoint_id、authorization_generation、expires_at及至多32条exact grants；每条固定action=receive_input、source_node_id/source_endpoint_id和完整target WorkRef。首版不给通配node/work/cwd，不包含receive_result；配置source节点须等于当前配对owner，source endpoint是其固定materials入口，target node/endpoint必须是本机实际ID。路径及实际store ID由runtime派生，不在配置中任填。receive_input独立于read/send_input，两个权限缺任何一个都不能完成ExplicitSend；接收权限不授予reply、work-origin或agent producer。

新增正式`material-scope`查看/授予/清除入口（CLI flags由作者采用现有风格实现，至少明确target native ID及期限），必须经本机固定材料Unix IPC调用main内ConnectionSetupService，再走SetupScopeStore同一transaction setter；CLI不能离线直接写scope，socket missing不能证明无人活跃，只返回service_unavailable并提示先启动连接器。核当前配对和runtime保留/繁忙状态；本机setup UI复用同一受保护service，不使用直接writeFile捷径。解析/写入普通测试只操作临时state。默认缺文件或过期必须显示grant_required；**默认生产构造仍启动receiver控制面并能够在正式setter写入后生效**，不要求代码注入flag或重新安装。每次改动/ABA同步失效所有旧lease，业务expiry与30秒proof有效期分开；实际IPC门槛见14.14.8。

#### 14.14.3 两个固定provider操作与binding发行

复用T1 `ash.material.provider.request.v1/response.v1`签名envelope；只增加`canonical.resolve`和`receipt.probe`，每次固定purpose=input_asset。共同使用call_id/message_id/reply_to、真实peer key/id/pair/generation、≤30秒deadline及完整签名/外层current验证；原32真实unfinished槽覆盖verify/capture/sign与业务raw链，不因timeout提前归槽。不得另建HTTP token后门或第二套relay。

Core源端在已授权screen/source context下创建短期opaque input-transfer binding，私有记录绑定canonical authority/owner/request/asset ID/version/hash/length/source/destination及当前peer，不创建目标work actor。binding_id是定位键，不是授权；即使猜中ID，非指定peer/key/pair也拒绝。重启后经同一管理/source授权可发行新binding，descriptor与A1 transfer仍保持稳定。不能直接复用CoreMaterialLinkBindings.register：它要求远端actor且source node为peer，正好与本地phone source相反。

| 操作 | 方向及严格语义 |
| --- | --- |
| canonical.resolve | desktop→phone Core；输入为purpose/input binding_id及exact request/asset/version/hash。Core核当前指定receiver peer、原source授权/请求未撤销、T1 currentInputTarget与canonical Ledger真实slot；仅material_to_work、source为本机node、destination为exact target_work、非provisional且在context.refs中，允许registered输入不要求result。返回最小metadata（authority/owner/request原payload hash、source/return/target_work、asset原hash/length/MIME/业务期限、grant revision、proof期限）；无正文、store路径或可序列化custody lease。接收端核本机receive_input及当前T1 target metadata再发行自己的lease |
| receipt.probe | phone Core→desktop；输入同一purpose及exact canonical/asset/destination，并可携原transfer/receipt IDs。receiver再次核当前canonical与receive_input，按本机稳定descriptor定位原A1 destination记录，重验真实已提交文件hash/length，返回原AssetReceipt与当前短期proof。无文件/partial/unknown不能成功；probe只读，不offer、不重新写bytes、不ACK |

T1 MaterialTargetEndpoint目前对同provider type但非target.resolve请求仍返回true，TargetProvider也消费所有provider responses；不能按`endpoint.acceptFrame() || other.acceptFrame()`拼接。T2-RI先建立一个固定provider mux，按严格operation及当前call_id owner分流，未知请求拒绝、未知响应不被别的pending误领；target.resolve既有签名/current逻辑保留。仅T1 owner冻结后交接此路由hunk，不能边review边修改T1 proof策略。

#### 14.14.4 receiver生产issuer及交给T2-C的私有port

新增device `material-receiver-provider.ts`实际实现DeviceMaterialBindingIssuer、MaterialAuthorization和MaterialCustodyAuthority。入站binding resolve先用已核peer发canonical.resolve，再交叉核显式grant及本机target capture，私有发行wire_source context、transfer scope与lease。context可采用canonical证明的source principal/pairing，但不是从收到的DTO直接复制授权；issuer私有登记每个精确context与用途，current核配置/peer/target/canonical generation。只允许该输入方向offer/put/commit，拒绝用它调用submit/reply/get_result/ack_result或代表目标模型。目标文件读取用另一私有local_input_reader lease，只给T2-C，不能把targetWork proof包装成通用MaterialActorProof。

custody descriptor绑定receiver真实signer/node/store root和canonical authority/owner/request/asset/version/source/destination，custody_id固定推导；expires_at取原请求/asset/明确grant业务期限，不混入短期proof刷新时间。authority_id、本机store ID及文件身份来自物理factory，不让Core或浏览器指定。维护lease单独绑定真实store与signer/current，不依赖已撤销历史actor；权限回收阻止访问但不把GC变成任意读。source_snapshot角色在receiver拒绝，destination_transfer的wire/local-reader用途分别签发并在每次await后核current。

交T2-C的**具体依赖契约**是`captureInput({material_request_id,asset_id,asset_version,sha256,byte_length,media_type,work}, currentControlProof)`返回私有`InputAssetLease`：`ref`（不可变canonical描述）、`receipt`、`readChunk(index)`、`current()`、`release()`。实现先复验canonical+receive_input+目的store committed bytes；readChunk沿现有A1授权/文件验证，不返回raw path、SQL或泛用MaterialTrustedContext。currentControlProof由原ControlAuthorization执行链提供，并由T2-C在其owner范围连接；T2-RI不改control文件、不伪造普通struct当proof。reader自己读取全体chunk后复算hash，零字节通过独立committed-file验证，不尝试不存在的chunk0。另提供`probeInputReceipt`供Core及UI、`currentPhysicalStore`/维护生命周期供staging组合；释放lease与删除文件分开。

当前DeviceMaterialRuntime的requests不能要求伪造host request service才能收文件：本包将requests端口明确变为按capability可缺省，MaterialGatewayAdapter固定拒绝缺失的业务请求并保持asset可用，不传一个假的always-unsupported实现充就绪。此窄变化及原relay回归随本包独审。device目前从Core目录import material-gateway；将无Core业务依赖的A3实现机械移动到device同名模块，Core旧路径仅re-export，保留所有W-E1 raw-observer/重放语义；不得因迁移改wire或策略。

#### 14.14.5 Core源传输与恢复端口

新增Core `material-input-transfer.ts`，只接受management/source私有proof与既有canonical/slot，不接受任意source路径：从Android已选文件桥获得受保护fd或已有snapshot handle，走原MaterialAssetStore.registerSnapshot/getSnapshot/readSnapshotChunk与RegistryMaterialCustodyAuthority的source_snapshot用途。runtime提供窄snapshot facade，不暴露stores Map，绝不调用按destination选本机store的现有assets.invoke来伪装源读取。hash/length/version与原登记slot相符才发送；路径、picker临时许可等具体输入沿现有A4桥，不用任意workspace文件填fixture。

sender使用当前OwnerLink transport及原MaterialClient依次offer、40 KiB chunk、commit，所有chunk与重试保持原request/asset/transfer IDs。commit响应必须先核receipt exact destination/hash，再用receipt.probe取得本机字节当前证明；sender只保存输入transport元数据，不把接收证明当模型消费。若网络在commit后断开，重新授权后先probe/定位原A1，已有committed只返回原ID，不重新复制文件造receipt。Core可由既有registry slot定位每次probe，无需为input方向扩result ReceiptIndex或新DB；刷新后UI current fence失败仍不输出成功。input没有result_version，禁止调用attachReceipt/get_result的result链绕行。

#### 14.14.6 单owner文件边界与启动/关闭顺序

| 写权 | 精确范围 |
| --- | --- |
| T2-RI新device文件 | `collaboration/material-provider-protocol.ts`、`material-provider-channel.ts`（复用T1固定mux/签名生命周期）、`material-receiver-provider.ts`、`material-receive-scope.ts`；对应scope/provider/receiver与双物理store组合tests |
| T2-RI新Core文件 | `collaboration/material-input-transfer.ts`、`material-input-provider.ts`（唯一registry/Ledger的input canonical投影及sender/probe）；不得新增canonical持久registry |
| T2-RI配置旧hunks | device `local-state-transaction.ts`第四配置/watch、`setup/scope-settings.ts`快照/setter、已核存在的`setup/service.ts`路由入口及`cli.ts`正式material-scope；不修改原control policy |
| T2-RI存储/authority旧hunks | device `material-store.ts`新增`inspectDestination`窄读定位＋完整文件再验证（沿transfers_v2稳定identity），原A1 wire不变；Core `material-registry.ts`仅input canonical投影/source当前校验，先等T1独审冻结；Core runtime窄source snapshot facade及provider组合；不改OperationStore |
| T2-RI旧入口 | device/Core `material-runtime.ts`、`material-link-bindings.ts`、device `main.ts`/`link.ts`、Core `main.ts`/`gateway/link.ts`，固定provider分发与真实默认factory/close；T1 `material-target-work.ts`/Core `material-target-provider.ts`只交接mux路由和生命周期，不改opaque proof发行语义 |
| T2-RI受限A3迁移 | device新增`material-gateway.ts`承接旧实现、Core旧同名re-export及相关import；requests按capability缺省窄hunk须独审，保留原有raw observer及bounded work |
| 不可写 | T2-C manifest/reader/staging、control-types/protocol/service/runtime、delivery、codex-control、OperationStore、host-proxy整组；不改Android picker/15ports内容视图，本包导出生产入口供后续同owner桥接 |

先串行接T1生产target endpoint/provider，再在两端link增加provider types。device main先attach受保护receiver coordinator，再启动link.run；DeviceMaterialRuntime.open需要已连接transport.capture，故由真实on-connected/current generation触发有界创建，不能在run之前await open造成死锁。首次身份握手完成即自动构造，不要求首次恶意offer来触发授权初始化；配置缺失时控制面可报告grant_required，写入正式scope后新generation自动ready。重连仅换临时proof/adapter，原A1 store受单owner持有，不同时打开两个同root实例。

断连/撤权先invalidate provider/bindings/current、停止新入站，未完成raw链继续占槽；关闭先停link admission→排空provider/transfer/readers→关闭store，draining状态不提前释放root锁或启动第二实例。Core entry沿原Host signer authority（手机模式）或fileSigner（standalone），不能创建device.jwk替手机身份；device沿原真实file signer。所有当前状态由正常main构造，testing仅替外部socket/native metadata，不提供可注入allow issuer。

#### 14.14.7 ordinary双物理store与最终组合门槛

临时phone/Core及desktop/device各有独立物理state/root/signer；使用正常production factories、旧OwnerLink/ClientLink签名frame与正式material-scope setter，native只用既有metadata/socket fixture。phone source为真实localNodeActor，kind=material_to_work，target由T1核存在/授权；不使用testing host或node human。正常source snapshot→signed transfer→目的A1→signed probe逐字节及原ID验证；包含零字节、近4 MiB图片、UTF-8、最多4 assets。测试应通过默认main/entry构造，而非直接new receiver注入allow fixture。

必须覆盖paired但无receive_input、只read/control grant、错target/方向/owner/key、旧binding ID、target proof过期刷新、配置/配对/metadata ABA、provisional或不在canonical input slot、源副本假receipt、目的文件篡改/丢失、commit到响应崩溃、两端重启原ID恢复；旧30秒proof刷新不得改变业务descriptor或使原文件不可恢复。32 pre-admission真实unfinished含挂起verify/sign/provider，timeout不能开新槽；无host仍允许本输入方向，所有human/agent/reply业务仍拒绝。T1 target.resolve与新增两操作并发正确路由，原relay/read/control/create/配置事务及完整TypeScript通过，再独审。

给T2-C交付实际默认`captureInput`后，在同一组合测试继续ExplicitSend：小UTF-8全文与受保护4 MiB图片路径由native fixture实际读取，原journal一次发送/unknown零重发。T2-RI通过只计“手机文件真实到达指定目标且可受控读取”；T2-C接入并获得§14.13消费证据后才计“已投递模型”。大UTF-8的T2-D1现已有具体pages/host-custody实现包，依赖未解除前保持未完成；通用文档、人机反向、15ports完整UI及真实native环境不在本包冒称完成。

#### 14.14.8 固定本机材料IPC：配置必须经过活runtime

**现状审查与裁定。**已读当前service.ts：ConnectionSetupService只实现read/control，已有reserveChange→previewScope异步验证→同步store.write的顺序；新writeMaterial setter已落，但没有正式在线CLI/service通路。main目前只有update分支检查busy，不能将该检查或socket缺失作为安全配置证明。根已裁定新增下面的材料专用IPC，无需用户作技术取舍；本轮不执行实际授权、启动连接器或安装。IPC仅允许material.status、material.prepare、material.apply（selection为明确授予或清除receive_input），不暴露通用配置、read/control设置、pair/login、任意文件或native方法。

**固定路径、认证与生命周期所有权。**由main按自己的规范stateDir构造0700专用目录（例如`.material-setup`），所有组件核本机UID、非symlink、固定dev/ino；IPC socket为目录内固定短名、权限0600。启动前按UTF-8计算Unix path长度并采用≤100字节边界；过长明确unavailable，不改用TCP、不在公共/tmp放可替换symlink。macOS/Linux为本包平台，其他平台明确unsupported；不得把Windows named pipe猜成已支持。缺少已验证native锁helper同样unavailable，无PID文件/定时mtime抢锁fallback。

main启动时先在该专用目录持有独立lifetime descriptor lock（可复用现acquireDescriptorStateLock对这个目录操作），随后创建listener/认证描述；**不长期持有主stateDir的.authorization.lock**，否则正式setter会自锁。该锁只证明本版IPC owner唯一，不单凭它或PID/kill(0)宣称其他旧连接器/原生任务不存在。默认新main实例必须在开放任何工作入口前获得此owner锁；竞争失败整个新实例回滚，不能保留无IPC的第二套可写runtime。持锁且核旧文件身份后才清理自己的遗留socket；活动listener的路径冲突不得强删。崩溃后OS释放锁，下一实例用新generation/secret启动，旧nonce全部失效。

每启动生成随机generation及至少256-bit秘密，写入0600、单硬链、当前UID、原子生成的认证描述，绑定规范state目录身份、endpoint与固定socket名；CLI只能从它选定的device config派生此目录并在连接前后重验描述/目录身份。请求与回应用HMAC挑战进行双向认证，双方随机nonce、generation、state身份、endpoint、request_id/operation/规范参数摘要和deadline全部纳入域分离MAC；不把secret作为请求正文传输，不打印secret/token/完整帧。签名比较使用constant-time，重放nonce有界记录。Node标准net接口不提供本包已验证的peer UID证明，不能声称已做getpeereid；实际边界是上述私有文件权限和同UID可读取的启动秘密，同UID恶意进程不在隔离承诺内。换socket/描述/generation或state路径即拒绝，无认证失败后直写fallback。

**协议及prepare/apply跨await。**使用单一有界frame格式，例如4-byte BE长度＋UTF-8 JSON，64 KiB最大body；严格固定keys/enum、请求ID/nonce长度及≤30秒deadline，最多8连接、32真实unfinished，重复frame/尾随frame/超长/慢发超时拒绝并关闭。status返回配置事实及precondition，不能把诊断unknown包装成可改。prepare规范化grant/clear并执行只读exact target检查，返回服务端私有存储的一次性preview nonce（≤30秒）和不可变selection hash/precondition；客户端apply只引用该nonce及同一摘要，不可替换owner/work/expiry。prepare不长期占runtime reservation，防止用户停留页面阻塞工作。

apply原子标记nonce已领取，再进入ConnectionSetupService的material专用apply/revoke方法；服务重新取得reservation、复验同一selection、precondition以及当前配对/target，所有await前后重新assert。配置写入最后一步沿LocalStateTransaction descriptor锁→state/precondition/current→同步rename，不在最终fence和写入之间await。空grant/clear也必须经同一reservation。过期/已消费nonce、重启旧generation、另一个连接改配置均拒绝；认证secret或nonce不能替代当前state证明。失败/响应超时不能自动重新apply：客户端查status核最终revision/generation，显示成功/未变/结果不确定；不误称已回滚。若commit后status诊断await失败，服务应返回已提交revision的有限事实或让客户端查询，不能根据诊断错误再次写入。

**main真实reservation与busy。**reserveChange实现必须在第一个await之前同步取得单一admission gate并增加generation，然后重新检查stopping/updating、AgentHost/workspace/browser/Kimi、collaboration raw busy、materialWork/provider/receiver/staging raw工作及C作者提供的control/create只读changeSafety。busy=false不够：durable invoking/unknown、native active或状态未知仍拒绝，不能只观察JS Promise数量，也不能为了配置查询而改旧journal状态/启动native探针。changeSafety缺失/抛错按unavailable；功能未配置可由该端口给出有依据的disabled-safe状态，不能把所有unknown一律解释成idle。RI不读SQL猜测S4状态，不修改control/create内部实现。

gate必须覆盖main call、agent stream、update和材料入站/出站新admission；旧已接受工作由真实pending计数排空/检查，不能用invalidate制造busy=0。reservation持有期间允许本次service内部只读verification，不能把自己算成材料业务忙导致永久拒绝；其他新的业务调用明确busy。每个await后以及write fence同步重核gate token、安全predicate和shutdown epoch。释放仅释放自己的token，不无条件恢复agents.accepting；stopping/updating或新generation仍保持关闭。多个apply/配置更新/软件update竞争只允许一个owner；grant修改成功后同步invalidate旧receiver/control上下文后再解gate。

**shutdown与资源清理。**先设置stopping并关闭新IPC及工作admission，再失效未消费nonce和未提交reservation；等待实际apply/raw验证完成后关闭setup service/store、listener及已接受socket。能证明未commit的操作拒绝；已commit但回包失败保持可查询事实，不补偿性回滚。仅删除本实例generation且dev/ino仍匹配的socket/认证描述，最后释放lifetime锁；不得删新实例文件、在仍draining时释放锁或重开工作gate。shutdown deadline到达报告draining并保留资源所有权，不宣称关闭完成。

**可执行写权及ordinary门槛。**RI新增`setup/material-ipc.ts`（固定server/client协议可同模块，避免泛RPC）与`test/material-setup-ipc.test.ts`、`test/material-setup-main.test.ts`；只窄改setup/service.ts的material方法、scope-settings.ts正式setter、main.ts gate/construct/close、cli.ts材料命令。必要Link gate回调只交同一RI owner；现descriptor-lock实现不需改名或扩大任意路径API，在私有子目录使用原helper即可。control/create changeSafety只消费C作者export，不并写其文件。

验收通过临时真实Unix socket＋临时state＋正式CLI/client→main service→原transaction完成一次grant与clear，不能测试中让CLI直写。覆盖：未认证/错MAC/重放/过期nonce、prepare后换selection、state/owner/target ABA、描述/目录/socket替换、坏权限/hardlink、第二进程锁竞争、missing socket不改磁盘、长度/平台拒绝、半帧/超帧/挂起验证保持槽；busy与durable unknown拒绝、prepare后新任务在apply前启动、reserve后新任务被gate挡住、每个await阶段撤销及shutdown、commit后断连仅status恢复、release不复活stopping。现setup/LocalState/read/control/create及材料ordinary回归、完整TypeScript、根独审通过才接受。以上是实现门槛，不新增真实机器配置操作或用户许可流程。

### 14.15 从65%到完整首期：按用户流程收口的整合门槛

**本轮状态快照（根最新结论）。**C最小独复23/23通过（reader12＋memo2＋safety2＋create-runtime7）；先前13/14中首material scope=false来自pre-native fixture初始写入的迟到watch事件，稳定grant后同一grant/connection第一material与第二text均accepted，旧prepared重放零forward。作者另报194/194大回归与TS通过；根已接受这一有限窄修，不外推默认接线或手机验收。RI零字节实际双A1＋signed fresh proof的41.9秒通过仍有效；大于512 KiB非零组合session36306终态为120秒MaterialClient timeout，未验收，作者继续定位。IPC shutdown晚到apply缺口的根两项回归通过仍只覆盖该修复，main配置reservation整链尚未因此接受。W-U15-I已派C，先与RI协调真实接口再落UI及新bridge；RI独占main/runtime/input-transfer/registry/link，C不得并写。后续表格/执行纪律中“G1后再派”按此最新分发修正，RI未通过仍是整链验收依赖。整体65%保持；已有A0–A4/A5-L、T1、第一阶段manifest/staging与先前read/control/create独审不重开，不把同批测试次数重复加分。

**实际working tree缺口。**本次只读见device main已构造MaterialInputReader与MaterialReceiverCoordinator，默认staging的verifyRetirement仍抛unsupported；Core OwnerLink已有materialInputPeer生产窄口，但正常main/UI尚未消费这个source入口。MaterialEdgeService仍是scope、requests/list、requests/read、answer、asset/read、result/consume六路由；createDesktopMaterials只有独立定义，没有正常UI shell挂载与真实15ports适配。host-proxy supervisor默认仍ownership_unproven/replaceable:false。上述源码在作者继续修改中，本快照不覆盖后续根冻结结论；这些是必须完成的默认路径，不应拿额外孤立unit模块替代。

首期范围依据产品v0.5§19第一项和技术v0.2§13：**手机↔Mac Codex**的真实项目新建、已有会话按需读取、同会话发送/运行中追加、材料交付、问题回复与结果领取，并能由普通用户安装/配对/设置/恢复。第二种客户端、Windows完整连接器与云作业按原产品扩展路线另排；不把扩展路线偷偷算入本轮100%，也不删当前已承诺的双向材料或普通用户交付。下面按依赖推进，完整Goal由根综合记分，不为每个阶段预分百分比。

| 顺序与交付包 | 必须产生的用户价值／门槛 | owner与接受证据 |
| --- | --- | --- |
| G1 当前C/RI收尾 | 同一个真实grant/连接可发材料，随后可发普通文本；旧material claim不能重放。RI非零真实bytes到目的A1且fresh probe可核，main配置gate及shutdown正常 | 现C/RI各自旧写权，根独审后冻结。修实际proof/current生命周期，不在测试加invalidate/re-admit、改grant或重连绕过“同grant”要求；非零未完不接受RI完整输入链 |
| G2 W-U15-I默认手机输入桥 | 普通手机页面选既有工作→选文件→保存→明确发送；真正调用Core source→default Link→receiver→control reader→同WorkRef journal，无需开发者手工注册context/slot/transfer | G1后由**单入口owner**串行修改下述Core/UI/main/Android桥hunks，C内部仅经原owner导出已冻port。真实HTTP＋现UI shell＋双物理store＋native socket fixture一条链验收，保留实际image与UTF-8，不用fixture port替15ports |
| G3 当前桌面归属与普通启动 | 原CODEX_HOME/native IDs不变；用户常用桌面图标打开的GUI与设备control使用同owner，旧工作仍可读/发/steer，新建在桌面可见；关闭/休眠/重启/升级后恢复 | 原H owner提供真实受保护factory/配置发现/launcher拥有权及rollback实现，production不再永久ownership_unproven。先源码/temp验证，真实环境阶段按根明确授权执行；既有C2成功与2396 B消费证据复用，只补实际生产链未覆盖的owner/GUI/4 MiB输入组合 |
| G4 反向与完整限定材料 | 原Codex发局部问题→手机回答/选材→原请求关联结果可领取；已有工作结果在手机实际读到/明确ACK；大UTF-8及承诺文档类型有真实消费路径 | W-RX result_asset＋真实host-source/结果custody、T2-D1 pages/文档parser按§14.11/14.13既定包实现。target-only proof不升级为模型来源；4 MiB文本不能永久以unsupported算完成。复用原唯一Ledger/A1，结果文件实际目的receipt与跨轮领取验收 |
| G5 普通用户发布与从零验收 | 不要求Node/终端/手写JSON；安装→配对→选范围/默认项目→只读/可控/可接材分别就绪；手机更新后真实可用；失败可恢复且能撤销/卸载 | 连接助手GUI/随包runtime/签名与版本校验/服务启动和更新rollback；Android原签名连续性、生成UI与Core版本一致。干净测试安装与真实手机清单通过，不能把本地dist或临时archive当已安装版本；真实安装由根在具体产物及回退准备完毕后执行已授权步骤 |

#### 14.15.1 紧接G1的最小完整W-U15-I写权与接口

本包必须调用现有MaterialInputTransfer和OwnerLink.materialInputPeer，而非再造sender。Core新增/补齐`collaboration/material-input-service.ts`作为source组合入口：当前management screen→原localNodeActor→T1 target capture→canonical submit/asset slot→选材桥真实fd/原A1 snapshot→transfer/probe→原Core control service的manifest/epoch/action/operation绑定。request_id、operation_id、client_message_id由原UI outbox生成并全程保持，缓存重开先query，明确Send才从可证明未启动状态继续。

单owner精确hunks：Core `material-edge.ts`增加input submit/send/query/retry及真实draft入口，`material-ui-service.ts`投影到既有A4 DTO，`main.ts`注入真实OwnerLink source端口、picker/native bridge与screen/current；必要server材料独立dispatch仍保持outer fence/byte limits；`ui/js/desktop-materials-{contract,store}.js`及desktop-materials.js/desktop-work.js/正常shell入口/网络bridge将15ports逐项接实。不能把六HTTP返回原R2结构原样冒充A4的15ports。Android只改正式picker/共享导入handle→Core受控fd的必要hunks，由根交原Android owner串行确认，保留已有18 JUnit与dirty改动；不把浏览器自报path或fixture bytes当系统选材。生成Core ui.ts与Android index.html仅跑原gen:ui，不手写bundle。

15ports分工必须可逐项审查：scope/list/read来自真实材料HTTP投影；selectFiles来自Android已受限系统桥；save/load/deleteDraft为原metadata持久化＋受控selected handle生命周期；submitInput登记与传输；sendInput/queryInput复用S4；answer/readAsset/consumeResult复用原受限请求/receipt/ACK；retryTransfer只恢复原A1且不重复模型投递；close停止轮询、释放picker/read handle并保留未知journal事实。缺哪一项就列具体未完，不能用整页“材料能力未就绪”长期遮蔽。

G2接受必须从正常shell实际DOM进入，不从测试直接调用新类：点击“保存材料”零turn；点击“发送到此会话”经系统选材、两个物理store及受限native实际读取图文件；同页面再发文本、active时expectedTurnId steer、从历史clientId核回原消息并显示后续回复。另从默认项目入口新建一次并返回真实WorkRef，不重复研究itsallsame是否支持创建。页面切后台停止按需刷新、重开恢复原草稿/操作与时间标签；同名目标、默认项目变更均不能改旧请求目标。

#### 14.15.2 正常成功与恢复门槛，不能以永久unknown收口

unknown是确实缺回执/来源证明时保留的事实，正常已授权/已连接路径应获得accepted及有界历史核查，不能因为当前实现无法保持lease而总返回unknown。query/reconcile由明确刷新或有界页面活动触发，绝不自动重发；有限查询仍无法证明的操作保留可解释状态与下一步，不自动换work/新建会话。原turn结束后新一次同grant输入必须可用，不要求用户重新配对或反复授权。

staging普通成功文件要有真实retirement proof后回收：native读取/快照与关联turn/进程结束的证据接物理维护port，不从旧访问grant推断；accepted/unknown仍不能按TTL乱删。但main永久verifyRetirement=unsupported也不能作为最终交付，因为正常使用最终耗尽配额。G1/G2收口应有“已知完成可退休、未知保留、重新启动可恢复”的实际默认factory测试，不能只注入测试retire。

整合故障集限定在用户链：发送前网络断开、commit后回执丢失、native接收后S4回执丢失、手机进程被杀、电脑休眠/助手重启、grant撤销与scope改动、升级失败。每次保留原request/asset/transfer/client IDs，恢复后不重复业务；源/目的文件状态、原生接收、历史确认、结果领取分开展示。G2先ordinary全链，G3/G5再真实手机＋原桌面；需要登录/授权/真正环境切换时根提出具体步骤与回退，不把尚未准备的安装当本轮用户阻塞。

**执行纪律。**现在先完成正在运行的RI非零测试与C同grant修复并冻结，再直接派W-U15-I完整默认接线；G3生命周期源码准备可在不抢文件时推进，G4沿已有具体provider/pages包接入，不重开已验收的基础协议研究。首次源码冻结后使用一次可追溯构建/完整检查集收口，新增失败才扩大定向回归。普通GUI、真机与发行门槛未通过前，整体Goal保持active，不因模块多或临时fixture全绿宣告100%。

### 14.16 在线配置新里程碑与当前整合证据

本次只读核对device main、material-main-setup.test、Core native import/review及新input service源码，并按根报告更新；未运行测试、native或用户环境。下表区分根独审、作者报告和未完链，不用组件通过数推算整体可用性。

| 范围 | 最新证据 | 接受界限与剩余 |
| --- | --- | --- |
| 默认main在线配置 | 根独复material-main-setup 1/1；实际startDevice→真实临时Unix IPC→main内ConnectionSetupService→reserveChange gate→原locked setter，正式CLI沿IPC授予。期间update/public call/material新raw admission被挡，完成后恢复，关闭后旧apply拒绝 | 新的生产构造组合门槛通过。外部gateway/native环境为受限fixture；不是用户机器安装、无终端GUI、真实配对或所有shutdown场景已完成 |
| native选材导入 | actual native credentials＋已登记management screen，root含并发review共5/5 | 私有导入nonce/current、并发配额和受保护fd范围接受；浏览器不能自报native身份。尚未等于Android UI到Core source/A1完整链 |
| Android窄mount | Home exact-origin、私有picker/native stream已冻结；根handle46586退出0，模块编译＋真实Home聚焦编译＋JUnit28/28独复通过 | 限定源码编译与普通测试接受；实际Gradle构建、APK、手机picker真实跨端投递或签名发布仍未验收 |
| transport/target/reader | 根新增独复16/16 | 仅该组合范围。actualControlProof小PNG集成仍101.5秒失败（lsof调用3013次），RI实现同步after性能窄port，未冻结/未验收；禁止降低权限或把超时当正常unknown验收 |
| W-U15-I | Core material-draft-store/material-native-import/material-input-service及edge attach源码已出现，shell继续实现 | 新draft/import/coordinator整体与正常shell未冻结；不能沿旧“六route”快照断言毫无实现，也不能因源码出现就报15ports/phone用户链已通 |

**根已采纳六权重评估：安装配置6→7，整体66%，其他项不抬。**既有该类6/20覆盖配置后端、darwin锁和临时archive；现在新增了默认main实际持有的在线管理通路，权限写入必经活runtime reservation而不是离线setter，且独审证实工作admission、CLI和关闭边界。这是用户配置链的一个新增整合成果，故加1；剩余13/20仍留给无终端设置GUI、实际安装/配对、签名/包装、普通图标/native生命周期、升级回退和真机整合。不能将这1分解释为“已经可供普通用户安装使用”。Android28、native import5及transport16不另加其他五项权重。

| 既有交付类别 | 权重 | 当前贡献 | 本次变化 |
| --- | ---: | ---: | --- |
| 会话发现、按需读取与历史界面 | 20 | 15 | 无；Android窄mount独复通过，真机用户链未完成 |
| 原桌面会话控制与手机发送 | 25 | 19 | 无；小PNG actualControlProof仍失败，普通桌面归属未闭合 |
| 持久投递、核查及恢复 | 15 | 12 | 无；默认完整断线/回执丢失/恢复待验 |
| 指定项目新建路径复用 | 10 | 7 | 无；真实手机新建及原桌面显示待验 |
| 限定材料、结果及双向请求 | 10 | 6 | 无；导入与16项组合不能替完整同会话消费和反向结果 |
| 普通用户安装、配对、兼容与最终整合 | 20 | 7 | 根采纳＋1，仅在线配置默认main里程碑 |
| 合计 | 100 | 66 | 根统一记分；本计划只同步依据，不改Goal/status |

下一接受门槛仍是普通成功用户链：RI修复重复lsof/异步after造成的性能放大后，当前actualControlProof小PNG在原deadline内完成，再验非零及≤4 MiB材料；C完成正常shell/15ports到Core source coordinator并由根独审。同步current检查必须保留配置/peer/目标/字节与最终send约束，不能通过缓存永不过期、延长所有wire TTL或撤除授权来换性能。Android本次独复终态已记，尚未完成的GUI/安装/手机不借本次配置加分提前关闭。

### 14.17 当前验收队列及完整结果／零CLI交付

**当前不加分。**根同步的native修正93496为1/1；receiver35713同root/不同root与draining为1/1；这些关闭各自窄缺口。DOM53203已经真正导入并保存，但Send100秒未accepted，不能记为完整手机发送。包装研究冻结不等于生产包验收，根96158尚未终态。源码可见material-edge.stopInputAdmission已落；C负责Gate1常规inspection，RI负责main的真实装配/close/rollback。原最终uncached lsof/version核验不因性能优化移除。独立观察模块仅Darwin支持、Linux明确unsupported的边界不变，不把平台缺口藏成跨平台就绪。

#### 14.17.1 先封当前整合，再移交后续业务链

| 当前排队门槛 | 必须冻结的证据 | 后续解锁 |
| --- | --- | --- |
| Gate1固定观察与包装 | 根96158终态；实际release manifest/artifact hash与descriptor核验、Darwin完整可见owner集合、无缓存OS观察；包构建产物含固定模块并由正常runtime加载，原最终native验证不变 | C将常规调用开销降到正常deadline内；不重开新的native方法研究 |
| C正常DOM Send | 沿本次真实DOM、private import、save、Core source、signed Link、receiver A1、actualControlProof、原S4，取得一次accepted并能query原ID；材料后同grant文本与active steer保持正常 | W-U15-I可在限定fixture层冻结；仅保存成功不能越过此门槛 |
| RI默认生命周期 | material-edge先stopInputAdmission；main默认装配真实reader/receiver/IPC，关闭与启动半失败排空imports/coordinator/raw工作后再释放store/root/锁；原不同root隔离与同root拒绝证据保留 | 同一生产工厂可进入受控实际桌面/手机验收，不靠测试专用close弥补main |

这三项之后立即回到剩余19/25控制与7/20安装交付；不以继续扩大材料unit覆盖代替用户主链。复用已接受的A1/L/A2、C2同轮追加、S4/S5与Android模块证据，只补未覆盖的生产组合和真实平台边界。

#### 14.17.2 C-FINAL：原桌面控制与用户可恢复生命周期

下一控制包不是新adapter。由原host owner在已审NativeFactory/RoleAuthority/transport上完成**生产同owner入口**：原CODEX_HOME/native IDs、普通图标/快捷方式与连接助手归同一受保护engine；已有项目/会话不迁移、不另起替代会话。当前supervisor的replaceable:false/ownership_unproven不能充作最终正常路径。先完成可审查的发现、接管/启动、drain、受控stop、回退代码和fixture；真正重启/配置切换必须由根按具体回退及已有授权安排，本节不执行。

正式验收从手机普通页面完成四件事：读取原已有会话；同会话idle发送；桌面发起active后手机晚加入并用expectedTurnId追加且原工具正常结束；默认真实项目新建并在原桌面看到同一新WorkRef。客户端名字、项目同名及页面cache不能代替ID归属。正常配置成功时不能永久unknown/config_required，也不能要求用户每轮重新授权；真实不支持的版本必须在连接助手中说明可操作的恢复步骤，不偷偷降级managed runtime。

故障验收仍用原journal：接收后断网/丢回执、手机被杀、助手退出、休眠恢复、native重启或版本变化，按原ID查询/有限历史核查，不重发未知、不中断未授权原任务。证据分原生accepted、history-confirmed和业务完成；这组生产/真机门槛未过，控制贡献保持19/25。

#### 14.17.3 R-FINAL：完整结果回收与逆向选材

两个方向分别验收，不把目前input_asset provider冒称双向。当前Core material-runtime仍沿本机ReceiptIndex.locateTransfer关联结果，readAssetForUi只处理本机目的store；readiness.work_origin仍依赖真实hostProofs/hostReadiness。因此需要以下按原§14.11拆出的生产接口交接：

| 流程／owner包 | 必须补齐的实际端口 | 用户级接受条件 |
| --- | --- | --- |
| R-SOURCE 原work发起问题 | 原host owner实现MaterialHostProofProvider.capture/currentEpoch与真实protected工具调用/结果custody，绑定source WorkRef、peer及native/connector generation；交Core registry.workActor，不能用T1 target proof或工具自报thread字段 | 原Codex会话发human_material，手机正常UI显示来源与原question ID/version/期限；手机仅输入回答也能回到该原请求，不是node伪造human |
| R-RETURN 手机选材给原work | 原RI owner扩同一canonical.resolve/receipt.probe的result_asset分支、明确receive_result配置、device receiver custody及Core remote receipt locator；仍用原唯一Ledger/registry/A1，不新结果正文库 | 手机系统picker选材→phone source A1→原work目的A1→当前receipt再验→原result_available；原会话下一轮领取真实字节，不能只显示引用/手机缓存 |
| R-OUTPUT Codex结果回手机 | 真实host producer为同target发布work_result、登记当前result_version/asset；desktop source snapshot→phone目的A1，原Core读取/consume ports用当前canonical/receipt | 手机从原请求看到结果，多轮版本分明；预览/下载核完整bytes，明确consume/ACK才claimed，通知或打开卡片不自动ACK |

没有自动唤醒时沿产品已有“可领取，等待原会话读取”行为，但必须存在原会话可调用的真实受保护领取入口；不能永久只留下等待文案。大UTF-8用T2-D1分页reader，PDF/DOCX用既定解析包；metadata-only、未取得实际页或任意path不能算消费。target-input能力不授予work_result/human/agent来源权限，agent_task仍需真实目标capability/producer证明。

验收至少覆盖一张手机图片往返、一份结果文件到手机、重复问答/结果版本、原请求过期、源会话删除、断线后按原transfer/receipt恢复、旧question答复拒绝及preview≠ACK。source unavailable时缓存标明时间，重新连接后可按需领取。先生产工厂ordinary完整组合，再受控原Codex＋真实Android；读写角色与当前权限不靠testing host完成最终验收。

文件交接遵守原owner：host proof/原native port交host owner；device receiver/provider/scope、Core receipt-index/registry/runtime/main/link交RI owner串行；UI answer/readAsset/consumeResult与投影交C/UI owner，Android picker沿原私有stream桥。每个包接口先协调，T2仍活跃文件不并写；这里是后续队列，不自动扩大任何作者现有写权。

#### 14.17.4 I-FINAL：普通用户零CLI安装、配对和设置

安装配置剩余13/20不能被材料IPC通过代替。下一安装包应交**一个设置壳／发行owner**，复用ConnectionSetupService和真实main reservation，交付以下连续旅程：下载安装可校验包→打开连接助手→检测现有Codex版本/登录状态→手机一次性配对→选择获准项目/默认项目及read/control/receive_input（以后receive_result）→分别显示可读/可控/可接材→从手机完成首操作。用户不安装Node、不执行命令、不编辑scope JSON、不自己设置daemon环境变量。

当前IPC只允许固定material方法；零CLI设置还缺正式read/control/default-project及配对UI的受保护backend桥。须按现有typed service增加具体允许方法及认证/current/reservation，不能开放任意配置RPC，也不能让设置壳写文件绕过main。与现有配对/登录入口复用，原生登录凭据留本机；未登录/版本不支持/daemon owner不就绪分别显示原因和下一动作，健康检查只读，不自动跑付费模型任务。

发行物必须包含匹配Node运行时、device bundle、固定native helper/Gate1模块及manifest/hash，按OS/arch选包；Mac签名/公证、Android签名与升级连续性据实际产物验收。先完成本地可追溯构建和干净测试目录安装/升级失败rollback；真实安装前根再核具体版本、用户数据保持、停机窗口及回退。登录启动、关闭、卸载撤销入口、配置/数据库权限、诊断脱敏、兼容版本说明均进入普通UI流程。Mac为当前首期目标，Linux/Windows未支持的native观察不得打包假ready；扩平台不替代Mac主链。

最后用真实Android安装版本（Gradle/APK而非仅focused compile）及普通Mac启动方式，从无开发配置状态走一次上述流程；验证一次性配对到期重试、权限撤销即停、助手离线缓存标签、恢复不重复发送及默认项目改动不改变旧请求。默认托管用户无需自部署网关；自托管另交既定配置/启动/备份恢复说明，不混入普通用户引导。托管地址、签名身份/证书与实际发布渠道如果尚未在根上下文确定，只报为具体交付输入，不自行换技术路线或在此提前请求用户操作。

**需要先报告的交接输入。**工程端口：真实host-origin/custody、same-owner launcher归属、receive_result远端receipt与设置壳typed配置桥尚待上述owners交付。可能的人类输入仅在源码/产物与回退准备后出现：原客户端登录、具体真机安装/重启授权、发行签名凭据或未确定的托管渠道；由根核已有授权再决定是否询问。本轮无新的用户阻塞，不改变产品取舍、不安装、不发布。六贡献仍为15＋19＋12＋7＋6＋7＝66，只有对应完整里程碑新证据才加分。


### 14.18 正常UI首次发送接受与材料7/10评估

**建议材料贡献6/10→7/10，整体66→67；本文件记录验收建议，由根统一更新总进度。**原6分已包含材料组件及旧生产edge的限定接受；此次新增的是正常页面到生产导入、source/receiver、control reader和明确发送的完整组合，用户的“先保存，再发到指定会话”得到可观察结果，故可单独计一个整合里程碑。安装配置仍7/20、控制仍19/25，不能对同一组合重复加分。

| 本轮证据 | 接受事实 | 不覆盖的范围 |
| --- | --- | --- |
| 根62061：normal DOM 1/1，35.34秒；作者53458同case 36.17秒 | 固定production addon真正加载；regular/classic listener观察一致。正常index页面与ScreenNet经私有native driver导入selected.txt，实际FD写入/commit；Save显示可靠保存且turn为0；ExplicitSend显示精确“原生已接收 · 业务未验收”，native turn/start为1且输入含真实文件全文；刷新仍1次；close清理完成 | driver为模拟Android、native为临时synthetic进程；不是ContentResolver真机、APK、用户原Codex desktop，也不是4 MiB性能证明。accepted不等于模型业务验收 |
| 根41501：actualmain4/import5/Gate1 OS2/changeSafety2，共13/13 | 默认构造、私有导入、OS观察与配置安全的指定回归接受；源码另核Core main实际构造MaterialDraftStore、MaterialNativeImport、MaterialInputService并attachInput/attachMaterial | 不据此宣布完整安装、所有平台或用户原桌面owner就绪 |
| 根39838：missing-addon full fallback OS2/safety2，共4/4 | 缺失addon仍走完整fallback；current漏extra owner曾由research12096复现，C退修后通过。最终uncached lsof/version保持 | 不以观察缓存、缩小owner集合或移除最终验证换取正常耗时 |

上述通过替代§14.17中DOM53203“保存成功、Send100秒失败”的当前状态；旧失败仍保留为历史证据。main生产mount与normal DOM组合是两组互相补充的证据，不把直接构造fixture的DOM用例描述为用户原环境的整机测试。既有原生小PNG隔离证据及近4 MiB普通socket fixture仍维持各自界限。

建议六项贡献为读取15/20、控制19/25、持久投递12/15、新建7/10、材料7/10、安装7/20，合计67/100。材料剩余3分待完整恢复、满范围消费、双向结果与真实手机验收；不预先将每项测试机械折分，也不以永久unknown替代成功用户流程。

#### 14.18.1 下一门槛：原request在新screen和重启后继续

C下一包先覆盖同request新screen重开，沿现有draft/import/coordinator、原canonical Ledger及OperationStore，不新增第二本正文账本或复制测试内存状态。原screen token、picker handle和upload ticket是临时身份，不可持久复活；新screen须经过真实management认证及当前权限检查，再按稳定node/request/asset/operation身份取得获准投影。不得把浏览器body中自报work/principal变成授权，也不得把新screen等同新业务请求。

| 顺序与写权交接 | 必须通过的普通组合验收 |
| --- | --- |
| C现有UI/coordinator owner：同request、新screen恢复；涉及RI的registry/link/main/runtime旧hunk先移交、串行写 | 两个不同真实screen身份先后打开同一请求；关掉旧screen并释放原桥，新screen仍显示原request和已保存材料。旧screen迟到callback不能覆盖新状态；撤权、不同owner/work及失效源均拒绝。已提交A1 snapshot沿当前custody再验，不能继续使用已过期picker handle |
| 原operation查询与再次操作 | 已accepted操作按原ID查询和显示，不产生第二次native turn；unknown先查询/有限核查，不能盲目重发。用户明确新一次发送才产生新的operation，并继续绑定准确material manifest/version/hash。保存和重开仍是零native操作 |
| C与RI串行完成真实root restart | 关闭原生产service/factory并排空，保留同一物理root的原SQLite与A1内容，再构造新service和新screen。重建当前签名/peer/target proof，重查原canonical/receipt和实际bytes；不能通过沿用旧闭包、复制内存map或创建新request冒充恢复。root删除、权限撤销、current不再成立有明确可恢复错误 |

恢复包只继承已验收端口，不重新研究Gate1或扩大native方法。新screen重开先完成后立即推进物理root restart；若缺少稳定身份查询或当前receipt端口，先向对应owner交明确接口，不能只给UI保留卡片文案。原accepted回执、发送状态与业务完成状态继续分开。

#### 14.18.2 后续完整Goal队列

1. **满范围材料消费与性能：**普通正常UI链覆盖接近4 MiB图片、超过64 KiB直到4 MiB的UTF-8，并有实际受保护staging/reader消费、字节一致和原deadline内终态；不能拿小selected.txt或近4 MiB socketfixture外推。PDF/DOCX等普通文档沿既定解析/reader包单独验收，不缩成text-only。
2. **原桌面控制闭包：**并行保留§14.17.2的同CODEX_HOME、同native/WorkRef、普通图标生命周期、idle发送、active late-join steer、默认项目创建及丢回执恢复；此轮fixture不提高19/25。实际环境操作由根按已授权范围安排。
3. **真实host-source双向结果：**按§14.17.3先接原work受保护来源与工具领取，再完成手机回答/图片到原work，以及原work结果文件到手机；同question/version的可领取、真实字节、preview不自动ACK和明确consume都必须成立。T1 target proof不授予source/producer角色。
4. **零CLI安装及真机：**按§14.17.4交付可审查设置/发行物，实际Gradle/APK、Android picker、普通Mac启动和一次配对后的完整连续旅程；签名、更新、撤权、退出与回退合并验收。当前7/20安装贡献不因模拟driver重复提高。

本轮无新增用户决策或操作阻塞，不安装、不切换原桌面、不扩作者当前文件权限；需要原桌面/真机操作或发行输入时，由根在具体产物、步骤与回退准备后报告。


### 14.19 I-UI1：电脑连接助手的零CLI设置窗口

**当前67%保持，不因后台或本包源码完成加分。**根98036已独复settings新9＋旧19共28/28（exit0，15.69秒），包含final版本尾窗与生产默认拒绝boolean proof；本包的RI settings依赖已解除。根25868已独复真实OS source worker重启1/1（exit0，64.70秒）：保留原IDs、只读恢复零asset RPC、native仍1次，真实WS完成后actualEdge idle，用户明确发送未发送项后native为2；focused emitter/recovery/UI另13/13通过（exit0，0.14秒）。这些接受原范围内的恢复与生命周期门槛；focused退修证据不冒称重跑full DOM，source worker也不是用户原桌面或真机安装。本包不与其他活跃材料文件共占写权。依据产品v0.5 §20、技术v0.2 §11：用户从助手窗口管理真实范围，默认项目来自明确授权，配对、在线、可读、可控分别展示；不自动改Codex配置、不自动创建模型任务。这里补已安装、已配对助手的普通设置旅程，首次安装/一次性配对/发行和同owner控制仍在I-FINAL，不能缩成“有网页就交付”。

#### 14.19.1 当前实现核对与设计约束

- `setup/material-ipc.ts`已经提供`setup.status/prepare/apply`及typed `callConnectionSetup`，有私有同UID Unix IPC、实例generation/HMAC/nonce、30秒preview期限及一次性claim。无需新通用配置RPC。`setup.prepare`返回服务器normalize后的selection；apply只能提交原preview_id/selection_hash，scope写入必经main内reservation与原locked setter。
- `ConnectionSetupService.scopeStatus`已返回read/control实际grant，以及仅在未过期`exact_cwd`且显式含`create_work`时出现的defaultProject。UI没有独立默认目录写入口；grant只支持一份control scope，改变默认项目可能替换原send/steer等动作的项目范围，必须完整展示变更，不能暗中合并、扩大或迁移。
- `SetupNativeVerification`目前对read/control preview均依赖受保护control-runtime、真实目录及native retained proof；single_work还取`thread/read`精确metadata。此限制是当前实现事实：缺控制入口时显示“当前无法验证此范围”，不能假装read adapter自身不能读，也不能fallback到CLI离线setter。独立只读授权体验需要专门的真实read-source proof后续窄包，不能以永远unknown结案。
- 当前diagnostics仅给有限socket/version/client观察；login及read/control capability没有完整生产证据，gateway也未接实际Link观察。`Link.connected`在onConnected之前置true，单读该布尔值不足以证明配对后的就绪。`credentials.openPairing/openOriginalClientLogin`尚未在main接实，UI不得把空实现按钮称可用。
- 当前`install.ts`/`tools/package-device.mjs`有随包Node、helper/addon及archive/校验/服务定义，但未见电脑GUI设置壳；现有Core手机settings不具本机管理权，不能把其HTTP路由直接提升为电脑配置入口。CLI read-scope仍有直接写路径，设置壳绝不调用它绕过在线service。

#### 14.19.2 一个owner的可执行文件包与接线顺序

根已只读确认`xcrun --find swiftc`成功、现有Xcode工具链可用，不需要安装开发工具。建议Mac首包采用**AppKit菜单项＋WKWebView本地窗口**，私有stdio桥调用现有Unix管理IPC，避免对外开配置HTTP服务；这是建议技术实现，由根派发时确认文件清单，不要求用户为源码选择技术栈。Windows/Linux壳及签名发行不冒充本包支持。

| 写权阶段 | 单owner文件范围 | 完成物与依赖 |
| --- | --- | --- |
| I-UI1a 新文件，可在RI冻结前准备 | 新`packages/device/macos/ConnectionAssistant.swift`；新`packages/device/ui/setup/index.html`、`setup.js`、`setup.css`；新`packages/device/src/setup/shell-bridge.ts`、`shell-status.ts`；对应新`packages/device/test/setup-shell-bridge.test.ts`、`setup-shell-browser.test.ts`、`setup-shell-status.test.ts` | 原生窗口只载bundle固定assets，NSOpenPanel选已有目录；固定消息桥处理status/prepare/apply/选择目录。Node桥使用固定随包node/entry和助手选定的受保护config root，renderer不提供stateDir、endpoint、executable、shell命令或IPC secret。实现实际默认构造，不停在injectable mock |
| I-UI1b 旧文件窄接线，必须等RI移交 | `packages/device/src/setup/diagnostics.ts`、`service.ts`、`native-verification.ts`必要诊断/source port；`packages/device/src/link.ts`只读连接状态proof；`packages/device/src/main.ts`只注入实际connection evidence/diagnostic port与关闭所有权；`setup/material-ipc.ts`仅在固定状态投影确有需要时扩typed返回，不改已审prepare/apply协议 | 不并写RI retained/final proof尾窗、main生命周期或C reader/control文件。不重写验证/锁/业务授权。Link当前proof由私有conn、pair观察、transport epoch和stop状态共同产生，状态在跨await后再验；不把renderer自报paired/online传入service |
| I-UI1c 本地可双击产物与测试 | 新`tools/build-device-setup-shell.mjs`；`tools/package-device.mjs`及根`package.json`仅增加已构建设置壳/固定assets/bridge的构建包装接线，根明确交权后改 | 先在临时输出目录构造可双击.app，复用原device bundle和随包Node；固定bundle manifest校验运行时/bridge，不PATH寻node。不得修改用户LaunchAgent、Codex配置或执行真实安装。正式签名、公证与发行另验 |

本包owner不能修改Core UI_HTML、Android Home、material runtime/registry、control/delivery/proxy。新assets有独立build，不手改Core生成长行文件。完成a后必须串行接b和c，不能把只会在测试里注入service的空壳作为最终交付。若根先授a，其余明确保持待交接，不自行抢旧文件。

#### 14.19.3 用户流程与真实权限投影

1. **打开设置：**菜单显示电脑名称、已配对设备的可辨认身份及“已配对／当前离线／已连接”；页面加载只读status，不写grant。未安装配置或IPC不可达显示“连接助手尚未运行”等具体动作，不能socket missing就创建配置/离线写入。关闭窗口只关UI和管理桥，不停原助手/native任务；退出助手是另一个明确生命周期动作，本包未接实前不伪造成功。
2. **读取范围：**显示当前准确allowedCwds，允许通过原生目录选择添加/移除；preview显示所选真实目录、覆盖哪些历史读取范围、不包含何种控制权。保留协议最多128个目录、规范化/存在/current校验；不得默认home或所有Codex历史。清除是单独明确操作，仍走prepare/apply。预览和取消零写入。
3. **控制范围：**显示当前`single_work`完整目标或`exact_cwd`与逐项allowed_actions及有效期。初期新增exact_cwd通过原生选目录，现有single_work可准确查看、缩减动作、撤销；不提供需手输native ID的伪普通用户选择器。新增single_work选择器必须来自受保护metadata并完整核WorkRef，若本包未实现明确列后续，不用可读grant冒充可控。动作名单从真实GrantedControlAction契约生成，不凭名称加能力；未选的动作不自动授权。
4. **默认新建项目：**只展示scopeStatus的defaultProject。选择新目录要生成明确`create_work + exact_cwd`的完整控制grant预览；已有控制grant与新目录冲突时列出被替换的旧范围与所有动作，不自动迁移旧send/steer权限或增授create。保存后重新取status确认；只改未来新请求，原journal、WorkRef及未完成请求不改。过期、被撤销、single_work或无create时标“未设置”，不可从read目录、workdir或最近会话推断默认项目。
5. **预览→保存：**显示服务器返回的规范化selection及与当前范围差异。用户点击保存才apply；preview到期、pair/grant/目录/native generation变化、busy、shutdown均返回可理解的失败/刷新再预览，不能客户端自动确认新范围。30秒后重预览需用户看到最新结果；apply响应丢失先status核当前配置，不能自动重放一次性preview。打开/保存设置均不turn/start、steer或create_work。
6. **分项诊断：**分别显示助手运行、已配对、gateway/实际连接、客户端安装/版本、源身份、读取能力、发送入口、默认范围。只有真实证据verified才绿；有grant≠能力可用、native存在≠已登录、read成功≠控制。登录无受支持证据就显示“登录状态尚未核实”，引导用户自行打开原Codex，不能索取/导出原凭据。保留无业务副作用的重新检查按钮，限定initialize/metadata/已授权有界读取；严禁安装检查自动模型调用。

状态port应先解决可可靠判断的paired/online/native/version/scope，不为“全部绿色”虚造login proof。实际读取探测须沿生产read来源与当前授权；尚未授予read时不扫描所有历史。完整权限grant只能在本机私有设置窗口显示；诊断导出只列版本、阶段、错误类别、时间和关联ID，默认删除token、公私钥、聊天正文和完整路径。路径在本机选择/预览中按用户操作显示，不混入日志。

#### 14.19.4 壳的边界与普通验收门槛

WKWebView仅允许固定bundle主frame，禁远程导航、iframe调用、任意new window及网络脚本；bridge核main-frame origin/实例generation及固定消息schema。Swift持有NSOpenPanel结果与窗口会话，renderer拿不到IPC auth.json、signer或系统命令接口。stdio每帧有request ID、有界64 KiB、有限inflight/timeout，进程stdout只协议、错误脱敏；窗口关闭后拒迟到apply，桥重启使旧preview失效或由原IPC拒绝。浏览器不能用任意path覆盖固定config root；bridge验证protected root/current endpoint，不能仅相信启动字符串。安全取舍不等于宣称能抵御同UID恶意任意代码。

必须一次完成以下接受，不以backend green代替：

- 实际临时生产startDevice＋真实Unix IPC＋正常本地设置DOM：读取status、原生目录选择、read/control分别preview、取消零写、显式保存实际scope变更、刷新准确显示；在有原grant时改变默认项目显示整份替换差异，当前默认从create grant投影。
- 真实临时WS连断/重连和配对撤销：窗口区分paired与online；跨诊断await更换conn/owner不得返回前任的ready。未登录证据不足与control socket缺失均有具体提示；read-only可用不得泛化为send ready。
- 预览后目录inode/owner/grant/native变化、保留proof尾窗、busy/unknown操作及shutdown拒写；过期preview/重复apply/响应丢失后查询、旧窗口迟到事件可恢复。沿已冻结final验证，不撤旧proof或把同步current改成bool fixture。
- 实际WKWebView固定入口及bridge验收：任意URL/子frame/未知方法/超大消息拒绝；关闭设置不停止后台工作；同实例重开可重新status。用普通Chrome DOM只能证明UI状态机，不能代替WKWebView origin/NSOpenPanel/stdio边界。
- 临时.app双击可打开设置且无需终端/外装Node/复制token；实际产物含固定assets/bridge/随包runtime，错误版本或缺失组件有明确提示。这里可做临时fixture验收，不注册真实系统服务、不改用户原Codex。使用root当前环境真实安装/登录的验收另行授权。

**后续必须保留的I-FINAL：**首次无配置启动、真实一次性二维码配对及过期重试、受托管入口（不得让用户填写网关/令牌）、登录启动/退出/撤销、签名公证/升级回退、干净Mac和APK真机完整旅程均未被本包替代。配对协议当前CLI从手机取得码再发request；产品目标助手出码/手机扫的方向须复用实际gateway能力做明确下一包，不把占位二维码当完成或静默改产品流程。

**真实授权边界：**写源码、构建临时.app、fixture/临时scope验收是已授权开发，不需要用户介入。真正写用户read/control/create/receive范围必须由用户在本机预览后明确保存；本轮代理不代保存。原Codex登录/系统权限由用户在原客户端完成；切换共享owner配置、重启原客户端/助手、注册登录启动、安装真实APK或签名发行凭据须根先核已有授权并给具体步骤/回退，设置UI不自动执行。工程端口或签名渠道未就绪先报具体依赖，不为当前开发新增笼统审批。


**本轮评分结论：继续67。**settings 28项是已计入安装7分的在线配置生产通路的最终尾窗修正；source真实OS重启和WS终态是材料7分已列的恢复验收取得实质进展，focused13项为相应回归。它们应关闭对应待办，但尚不覆盖整套手机/助手断网恢复、4 MiB消费、真实双向结果或普通设置/安装旅程，故本轮不单独增加持久、材料或安装贡献。下一可评分安装里程碑必须交付此节的真实本地设置壳、默认生产IPC接线及普通操作证据；再之后仍须完成无配置安装、一次配对、发行和真实两端，不以本包已配对前提缩窄首期。


### 14.20 I-UI1限定接受、安装8/20建议及WK／真实reader交接

**验收建议：安装7→8，整体67→68，由根统一记分；其余五项不变。**本轮不是分别奖励40项、9项或8项测试，而是出现了与原在线backend不同的完整子成果：可构建、可核manifest的Mac设置.app包含独立随包runtime/固定bridge，正常设置页面已通过真实IPC保存完整范围及取消零写。原安装7分的在线管理通路现在具备实际设置界面和自含产物。可以接受“设置UI与自含产物整合”这1分，不能表述为普通用户安装就绪或WK边界已验收。剩余12/20继续覆盖真实原生窗口/选择器、首次无配置安装与配对、签名/更新/生命周期、同owner正常桌面以及真机整体交付。

| 根独复证据 | 本次接受边界 |
| --- | --- |
| 91593 settings40/40，exit0，19.96秒 | expiry握手与merge持有真实proof；missing/default unavailable不写grant；retained最终为0。属于设置生产安全回归，不单独再加分 |
| 41895 正常settings UI9/9，exit0，20.55秒 | 三次actualIPC完整scope保存；取消零写、business零调用。Chrome模拟native chooser，不是WKWebView或NSOpenPanel接受 |
| official standalone Node22.22.1临时.app构建；根校全部manifest SHA，实际Resources/node及bridge在隔离HOME、allowlist env下返回脱敏status并EOF exit0；otool仅4个系统dylib；helper4/4 | 产物含可独立运行runtime、固定bridge及assets，无外部Node/dylib依赖；不证明已双击窗口、已签名/公证、安装到用户系统或已配对首装 |
| 89895 readsource resolver/probe/configopaque绑定8/8，exit0，9.50秒 | 新protected source来源与探针在指定范围接受。旧reader尚未接线；config.toml opaque identity不证明外部state_db_path的物理realm，不能对正式读取或默认read授权宣称闭合 |

本轮静态复核：`ConnectionAssistant.swift`已固定本地WK入口、manifest、NSOpenPanel与stdio；build脚本实际调用Swift编译并构造.app。`codex-read.ts`仍默认PATH上的`codex app-server --stdio`，尚未调用`captureProtectedReadSource/startReadSourceProcess`。新read-source明确注明CODEX_HOME不证明外部history root，必须保留该区别。

#### 14.20.1 I-WK2：真实WK的临时隔离验收包

**单owner：原设置壳作者。**写权限定`packages/device/macos/ConnectionAssistant.swift`的可复用class/生命周期与测试入口分离窄hunk、新`packages/device/macos/SetupIsolationHarness.swift`、新`packages/device/test/setup-shell-wk.test.ts`及必要fixture；`tools/build-device-setup-shell.mjs`只为独立测试产物构建复用类，不给生产app增加任意root/command/env开关。其他setup/service/main/reader文件不并写。reviewer独立看实际产物和报告。

**隔离不能只靠HOME。**生产Swift使用`FileManager.default.homeDirectoryForCurrentUser`，Node桥默认`homedir()`；不能假定两者都尊重测试HOME。先核真实执行出的配置root；测试构建入口由测试父进程在新建0700目录中提供私有fixture root/已打开descriptor，经native侧校验后仅传给测试构造器，renderer仍不能选root/endpoint/executable。生产入口继续固定真实安装root且构建不包含测试override。报告核生产和测试的入口差异，只将共同WK/stdio代码行为算本轮证据；若无法保证测试路径在进程启动前已固定，停止此方案，改独立OS测试用户，不启动会访问用户root的app。

测试仅启动新临时fixture app/engine/IPC，不通过`open -a`匹配已安装助手，不注册LaunchAgent，不访问用户`.ash-device`/`.codex`或用户现有native。父进程保留实际子PID/pipe，结束先关窗口/stdio，等待子进程和IPC原始工作排空，再核fixture目录可清理。不能用广泛pkill或退出用户助手。是否能无人值守操控真实NSOpenPanel取决于现有测试权限；不得为测试自行授Accessibility权限。无法控制时将该项留待受控人工验收，不能用JS chooser替代。

最低实际WK证据：固定index主frame加载；真实NSOpenPanel选择fixture已有目录及取消；服务器返回整份normalized范围预览；原生保存确认后actualIPC完成，取消零grant变更/零业务；close窗口仅停设置bridge、后台IPC及原native继续；重开新session旧callback无效。另实际WK拒远程跳转、iframe/其他file消息、未知方法和超大帧；fixture app临时Resources变更导致manifest拒启动bridge。失效/expiry/关闭时的原始工作归槽由已审service保留。Chrome9项继续作为UI逻辑证据，不替这些原生项。

#### 14.20.2 R-READ2：固定真实CLI的物理history realm与旧reader接线

**单owner：原read-source作者；与I-WK2并行只读接口，旧setup/main需要串行移交。**新增`packages/device/src/collaboration/read-source-realm.ts`、新`packages/device/test/read-source-realm.test.ts`及`fixtures/read-source-native-realm.mjs`；窄改`read-source.ts`、`read-source-probe.ts`、`codex-read.ts`、`read-service.ts`和原read相关tests。`setup/native-verification.ts`、`shell-status.ts`及`main.ts`只在源码/接口冻结后由根交同一owner或原入口owner串行合入；不改control/native proxy/材料provider。不能先让旧reader默认永久disabled而只交一个resolver构造器；整包包含可运行的production factory接线。

先做**固定真实CLI的隔离realm验证**，只读固定artifact/生成schema，使用新的临时CODEX_HOME、配置和history roots，禁止用户home、登录、turn/start或付费模型。已接受的Python CLI fixture不能证明真实CLI如何解释state_db_path。用固定版支持的只读配置接口/本地schema确定最终有效history位置；不得用手写TOML正则猜全部覆盖规则，不能把config原文写日志。若原生不暴露有效路径，明确受支持配置子集并对未知覆盖失败关闭，同时交可用的默认realm路径；不能默默覆盖state_db_path把用户切到空历史。

至少两组物理fixture：默认CODEX_HOME history与显式外部state_db_path。用离线合成、仅供测试的最小历史数据区分两个realm，真实CLI bounded thread/list及thread/read识别该数据且不得越到另一root；不向用户或真实业务库写SQLite。若固定版不能安全构造合成历史，可先用其只读有效配置响应和实际进程打开的文件路径交叉核对物理root，并把含历史字节的组合明确留为整包未完，不拿空列表“成功”替代realm证明。相对路径、missing root、symlink/rename、config变更、profile/环境覆盖及进程cwd影响必须有确定支持/拒绝行为。

`ProtectedReadSource`需绑定真实生效realm的受保护目录/文件身份、来源revision与config连续性，字段本身不是grant。DB常规更新/轮换和源替换须按实际reader生命周期处理：旧lease不偷换root，新factory重取current；不能对每次普通DB写永久拒绝。环境仅固定allowlist，不复制凭据、不从PATH选CLI，不跨进程转移source token；外部root未证明不可进入正式source verified。source chooser/descriptor的普通用户授权入口仍是独立设置依赖，不能要求普通用户手写JSON；本包不替用户选择源。

旧reader最终从production read-service获得**私有、当前的source lease及process factory**；before/after每次read检查source与当前pair/read grant，scope仍是已有allowedCwds。无显式源时给具体source_required而非退回PATH或控制socket。保留list的cwd/useStateDbOnly、有界分页、thread metadata复核、1 MiB输出/原传输边界、abort/raw drain以及factory重建；允许的方法仍只有initialize/list/read/turns-list，绝不resume/create/steer。source变更同时清cursor及关闭旧进程group，真实settle后release全部fd，不提前归槽。

最后同一个protected source要供“设置read preview/诊断”与“默认实际列表详情”消费，防一套probe通过、另一套旧reader仍读PATH。验收从实际read grant和paired transport→生产main/read-service→固定真实临时CLI→授权list/read，control socket缺失不阻断独立saved-history读；原control配置与grant不变、native业务调用0。metadata/source verified不推断登录、活跃runtime或控制ready。源码新8项是此前基础，只有完成本段realm＋factory组合才关闭剩余读取缺口。

**从零交付保持完整。**上述两包仍非首装配对完成；I-FINAL须继续实现无配置首次启动、助手/手机配对码方向与过期重试、托管gateway入口、source选择、原客户端登录引导、同owner兼容、签名安装和升级/退出/撤销，再实际Android APK及普通Mac两端验收。本轮只给源码/隔离fixture写权；不启动真实用户app、不更改桌面配置、不安装发布，所需真实授权按§14.19执行。


### 14.21 正式saved reader、来源发现与普通设置的交付顺序

**当前68%保持。**根5455已独复source/realm21项，独审发现的同版本任意artifact与child/pipe提前归槽两项退修已接受。固定真实CLI为`0.162.0-alpha.17.2`及已核Mach-O SHA，默认／外部物理realm的离线合成历史可被准确list/metadata read，另一root的条目不能误读。此证据替代§14.20的realm待核状态，但不代表旧reader、设置source选择或用户原来源发现已经接线。I-WK2仍未通过真实NSOpenPanel；CUA exactpath返回-10005且inventory无entry，host在只读检查raw executable与Bundle plist。该失败尚不能归因为用户未授Accessibility，更不能据此要求用户开权限或把Chrome模拟chooser作为真WK通过。

**关键协议更正：实际生效配置键是`sqlite_home`，固定版忽略`state_db_path`。**§14.20以state_db_path命名的研究问题是历史假设，不能进入生产DTO/文案。已接受代码要求显式既存sqlite_home，持有root/`state_5.sqlite` FD/dev/ino，并核exact factory child真正打开的REG FD。当前`-c sqlite_home=...`证明“reader受限于选定realm”；它本身不证明这个选定root就是原Codex原有效来源。后一事实是下一发现包必须交的独立证明，不能因override成功就自动把home当原来源。

#### 14.21.1 三个串行包，复用一套来源及原scope体系

| 顺序／owner | 精确源码边界，均须根派发交权 | 完成门槛 |
| --- | --- | --- |
| R-READ2b 原source作者：旧reader正式迁移 | 原`packages/device/src/collaboration/codex-read.ts`、`read-service.ts`及对应tests；`read-source.ts`仅必要私有process/current接口hunk，已审realm逻辑冻结；`main.ts`仅确需factory接线时交原入口owner串行 | 生产默认reader消费同一ProtectedReadSource及realm，撤除生产PATH fallback；grant/pair current、cwd过滤、分页和full-history行为保持。真实临时CLI＋生产read-service的授权list/read成功，缺control socket仍可读；root/源替换关闭旧child并原始排空后重建，不移除旧验证。未配source给具体设置动作，不能称默认source配置已完成 |
| R-DISC1 原source作者：有效来源定向发现与proof | 新`packages/device/src/setup/read-source-discovery.ts`、新`packages/device/test/read-source-discovery.test.ts`及必要真实CLI隔离fixture；`read-source-realm.ts`只由原owner补复用的私有attestation接口，禁止公开任意PID探针 | 从固定安装artifact＋受保护候选home得到**无sqlite override时**的有效root，再核原配置/current与物理身份；已核默认/外部root、相对配置/环境/工作目录影响及明确不支持项。返回私有candidate/proof，不写descriptor/grant、不返回原配置/凭据 |
| I-SOURCE1 原设置owner：普通选择→preview→保存 | 新`packages/device/src/setup/read-source-settings.ts`及专测；旧`service.ts`、`scope-settings.ts`、`material-ipc.ts`固定source status/prepare/apply分支；`shell-bridge.ts`、`ui/setup/setup.js`/index只接opaque candidate；Swift仅实际需要的原生Codex app/home选择窄hunk。`local-state-transaction.ts`及其LocalStateName来源仅为原`collaboration-read-runtime.json`增加受保护观察/写权限；main/诊断由原入口owner串行 | 普通UI不手填JSON、SHA、SQLite文件或CLI。明确选择一个Codex来源→显示实际找到的资料范围与版本→当前proof下保存原descriptor→再明确选择read scope，生产列表读取同一来源。完整actualIPC/正常DOM先验，再等真实WK/native chooser门槛；不由浏览器自报路径/token建proof |

R-READ2b可以先完成现有显式descriptor的生产读取接线，不能停在那里将“管理员预写配置”作为首期用户体验。R-DISC1和I-SOURCE1是同一交付序列的必需后段，不是无限后续研究。root正在收原作者最小迁移包，以其实际接口清单交权，本文不抢活跃旧文件。

#### 14.21.2 R-DISC1的有限研究出口及来源发现规则

先读固定版已有schema/原生配置命令契约，再只在临时home/SQLite roots验证：受支持的只读有效配置入口能否提供最终sqlite_home；若可，配置返回只在私有backend挑出相关字段并立即丢弃其余，不将完整config传renderer或报告。再用未override的同artifact子进程实际打开FD交叉核对应root。不得把手写TOML正则、目录同名、PATH命令输出、空list成功或单纯config hash当有效来源证明。

如果原生没有可靠有效配置接口，则固定版已有无override进程的真实opened FD和已保留配置/home来源是候选证据路线；只有前后current且唯一匹配才生成candidate。必须先在临时树证明启动/查询的实际文件副作用；App Server的initialize或list“读取方法”并不保证其启动不会创建/迁移数据库。会新建缺失DB、迁移或写额外用户状态的发现路径不能自动在用户home试跑。选择可只读评估的配置路径／已运行且归属可验证进程；若仍无安全来源发现，报告这个具体工程阻挡与可审查操作，不静默加sqlite override或迁到空home。

普通默认来源从固定受支持Codex安装实例和经验证的默认home规则提出候选，先展示给用户选择；自定义home允许原生“选择Codex资料目录”，但不要求用户知道SQLite文件名或手输路径。候选home仍必须证明所属来源、当前配置和真实有效realm；目录选择只是用户意图，不授予所有项目历史。named profile、未知layout/版本暂不支持时给明确兼容说明和可操作入口，不声称全部客户端兼容；这不取消首期受支持Mac Codex普通默认来源必须成功的门槛。

发现proof绑定artifact/hash、home及config观察、有效sqlite root/dev/ino、实例generation和有限期限。UI只持candidate ID，不能回传raw source_id/SQLite path构造descriptor。discover/preview不是配对、grant或control ready；原home内登录材料不复制到手机或新home，source selection不修改Codex配置、不启动模型任务。

#### 14.21.3 source设置保存与既有权限的组合

沿既有Unix IPC认证与在线reservation增加固定source操作，不创建通用文件写RPC。prepare绑定当前owner/endpoint、旧source revision及上述私有candidate；apply前后再核current、final source proof与runtime安全。descriptor只有backend从proof生成：实际executable/hash/home/sqlite_home/profile/version，source_id由服务管理，renderer不能自报兼容artifact。UI显示变更前后来源，取消零写；busy/unknown、过期、目录/配置替换、实例退出均不改旧配置。

**切换来源不可隐式复用旧read授权，且必须由实际读授权本身强制绑定来源。**旧v2 grant只有endpoint＋allowedCwds；仅在正式chooser里先撤scope再写descriptor，挡不住管理员或外部合法替换descriptor后相同cwd继承旧权限。必需的新v3含`source_id`和`binding_revision`，manifest与每次reader admission/current都核对私有当前source绑定；缺失、不匹配、旧v2只能scope_required，不广告可读、不返回历史。旧v2目录可留作本机重新确认的建议，但不得自动升级为v3或显示verified。binding_revision绑定选定descriptor/config/artifact/home/物理realm身份，与普通历史增长、DB常规写入区分，不能每条消息到来就撤读授权。外部合法source替换即使同cwd也由此拒绝，不能只依赖UI写路径。

正式source保存另在持有同一reservation/gate时先撤销旧read grant、刷新expected token，再写新descriptor，最后由用户另行确认新v3读取范围；中途失败保持read未授权并给出恢复状态，不能自动恢复旧grant到新source。两步写不是原子事务，不把它描述为原子成功；失败后status须准确显示。若实现采用真正事务，则必须有实际事务/恢复测试，不能凭两次rename宣称原子。control/create/receive授权不因改读取来源被扩权或迁移；旧未完成请求的WorkRef不重定向。

取消/过期preview保持旧读权限不变；明确切换source才进入上述失效流程。文件/配置变更导致旧source失效时，读服务停旧进程并报“来源已变化，需要重新核对”，用户确认后可完成普通流程，不永久unknown。后续read scope预览与诊断必须复用新source，不能再为独立saved-history授权硬依赖control socket；控制预览仍沿原控制proof，不可混用读取来源。

#### 14.21.4 首期接受矩阵与是否需要用户决定

完成顺序是：真实临时CLI的现descriptor→生产reader成功；真实有效来源发现（不override）→物理FD一致；实际IPC source保存→read scope预览保存→默认列表/详情；最后真实WK/native选择器和干净系统首次安装配对。至少验默认home、外部sqlite_home、候选取消、source变更同cwd不继承授权、原source revocation、断开后恢复及child/pipe清理。读取检查零模型调用，原桌面控制配置零变更；unknown只表示当下证据不足，不作为正常配置成功的最终结果。

**目前没有需用户决定的产品取舍。**无需手写JSON是既定产品要求；固定source操作、私有proof、reader接线及临时fixture是工程实施，root可按文件owner继续派发。真实用户home探测若存在原生启动副作用、原客户端登录、真实TCC/原生panel操作、安装/重启或发行证书才需根按具体步骤核已有授权。CUA启动失败本身不是授权依据，先完成host当前只读诊断并区分Bundle/launch缺陷与OS权限。此前未完成的双向材料、4 MiB、原桌面same-owner控制、从零配对与APK真机继续在完整Goal内；本轮源码规划/21项接受不另加权重。


### 14.22 当前退修状态与4 MiB材料性能验收包

**整体68%保持；本节状态覆盖此前作者冻结声明。**

| 当前门槛 | 最新实际证据 | 结论 |
| --- | --- | --- |
| R-READ2b正式reader | 作者46/46及TS通过；根13268为45/46、exit1。独审发现rawpipe drain后manifest负cache不能自然恢复P2，已退作者修成功settlement＋无manualdispatch恢复回归 | 尚未接受。source/realm先前21项接受不转移给新reader组合；不得依靠手动业务dispatch刷新cache才恢复正常发现 |
| 4 MiB正常UI | 首跑55850在180秒失败。4188477字节PNG经103次private import耗时4.724秒，Save返回200且native turn0；ExplicitSend未返回，native initialize1、thread/read40、turn/start0 | 导入/保存事实成立，但传输到模型消费未成立。计数只表示停在native提交前，尚不能认定某一函数或loop为根因；不能把start0报accepted/unknown成功 |
| I-WK2 | root65179及review在其明确窄scope接受 | 不是完整WK/选择/安装旅程全部通过，不提高安装权重；完整证据边界沿该报告，不把其替换为Chrome模拟或完整首装 |

#### 14.22.1 Reader退修必须覆盖普通恢复入口

原reader owner维持同文件写权，修复busy/draining结束后source/manifest缓存的恢复条件。实际child与pipe全部close前拒新reader；真实settlement后仅靠普通manifest/status或正常刷新可重新发现，再按当前v3 grant/source成功list/read。不能要求先调用隐藏业务dispatch、重新写grant或重启助手；旧source/old work/cursor仍不得复活。验收必须包含挂住pipe→负manifest→实际drain→不手动dispatch的正常manifest恢复→新reader成功，及source切换同cwd旧v3拒绝、legacy v2重新确认。修后由根重跑原失败组合，不以作者旧46绿色宣告放行。

#### 14.22.2 M-PERF1：先一轮聚合诊断，再授精确生产hunk

当前作者**只获测试内聚合计数/耗时诊断及唯一重跑**，没有本节授予的生产修改权。诊断保留同4188477B PNG、原normal UI、实际private import/Save/ExplicitSend链、原TTL/deadline、当前授权和正常native fixture；不换小样本、不跳过A1或reader、不自动重试未知send。只输出阶段耗时、数量、错误类别和关联ID，不能输出图像正文、token、完整配置或原用户数据。

沿一次operation收集有限聚合：UI explicitSend与Core source canonical/target阶段；offer/put/commit与每阶段块数/实际传输字节；receiver custody和receipt再验；input reader capture/read/hash/staging；target metadata/current/final native检查的调用数和总耗时；control journal admission、最后send及实际native回应。标明是正在运行、明确拒绝还是deadline收尾，并记录raw工作何时真正settle。thread/read40可能来自多次合法边界，也可能由重复proof取得放大；诊断前不做归因。

| 定位结果 | 待根授权的唯一owner精确候选写边界 | 修复所需保留的语义 |
| --- | --- | --- |
| Core source重复canonical/target准备或UI重复触发 | 原C owner的`packages/core/src/material-input-service.ts`及对应service/browser tests；若实际文件中无该调用则只按诊断指向的coordinator hunk交权 | 保存不发送；一次explicit send绑定一个原operation/request/manifest，不因刷新/重入多次启动。不能缓存撤权后的target proof |
| receiver/A1或逐块检查重复远端metadata导致放大 | 原RI owner的`packages/device/src/collaboration/material-receiver-provider.ts`、实际input-transfer/runtime窄hunk及对应双物理store tests；先冻结后交权 | 已核字节hash/receipt、canonical版本、pair及当前scope仍逐边界核。可复用同operation私有lease及廉价同步current，最终需要的真实metadata/final verification不移除 |
| input消费/target reader重复昂贵检查 | 原C/control owner的`material-input-reader.ts`、`material-input-staging.ts`或`control-runtime.ts`中诊断确定的一处调用边界，原input/target测试 | 保留自有staging不可变pin、每RPC路径/fd身份、unknown保留、same work/native generation与最终uncached检查。memo仅在同请求/受保护lease/current成立时复用；不可用墙钟缓存跨revocation或连接epoch |

这是条件文件候选，**不是同时开放上述全部文件**。根拿到阶段统计后选择最小一个owner/hunk；如确需跨owner接口，先定义返回值/current与所有权再串行交权。没有证据时不改generic transport、gateway协议、统一TTL、授权模型或测试deadline。

最终接受必须重跑原近4 MiB普通UI，完成准确A1目的receipt及真实reader字节验证，明确native accepted且只有一个turn，刷新/查询不重复、关闭实际排空；Save仍零native。原小UTF-8及同grant文本保持；至少相关撤权/epoch变化与staging替换拒绝回归不退。若native仍临时synthetic，对真实Codex大图消费的边界继续单列，不能用此通过宣称用户桌面或APK已验收。4 MiB文本及双向结果仍在Goal，图片性能包不替它们。


### 14.23 M-PERF1诊断终态与串行生产修复次序

**68%保持，4 MiB仍未通过。**根提供的`/tmp/ash-large-image-first-evidence/diagnostic-run.json`已直接核读：5259 exit1，整体194794.5毫秒（原case timeout180000毫秒），cleanup于194190毫秒完成；4188477B PNG、103次import耗时4405.1毫秒；103次put、292个signed relay frame、最大55353字节；initialize1、thread/read76、turn/start0，accepted/native_consumed均false。此为测试内聚合，production TTL未改；不能把cleanup期间总耗时当新业务deadline。

| 聚合项 | 次数 | 总耗时 |
| --- | ---: | ---: |
| lsof | 2541 | 54.883秒 |
| executable --version | 5485 | 30.734秒 |
| receiver final | 538 | 39.921秒 |
| target capture | 20 | 12.817秒 |
| whole-file verify | 2 | 7.912秒 |

**这些计时嵌套，不能相加成总耗时占比。**可确定的主要性能问题是物理身份/版本及最终授权检查被大量重复调用，文件导入不是180秒失败的主阶段；仅这些聚合尚不能证明每次调用可以删除。root输入的前轮read40已被完整终态read76覆盖。不得归因为中继frame过大：实际最大55353字节仍在当前链限制内；也不得通过减小文件、删hash验证、延长TTL或缓存跨await的安全结果使测试变绿。

静态调用点与聚合一致：`codex-transport.inspectUnixListener`虽已使用fixed addon取得fresh OS观察，仍每次执行`--version`；`verifyUnixListener`/`finalCurrent`沿原uncached lsof/version。`control-runtime`已有单同步段listener memo，但force final绕过；receiver `finalContext`调用target final及control proof final后再current。`material-gateway`在`await envelope(...)`前后分别final，二者隔着await，**不是可以合并的同同步段重复**。A1 store自己的提交final也承担物理提交边界，不能因receiver另有final就全删。

#### 14.23.1 M-PERF-N：原native owner先只读提出最小方案

当前可用slot仅交原native owner（host）做只读调用图/成本方案，不抢research的reader退修或source-discovery；本文不直接授生产修改。方案须按regular cheap-current、真正uncached final、同期版本/可执行体核查拆清楚每个boundary，给出“调用者→验证事实→是否跨await/同步系统调用→为何重复→保留的最终验证”。特别核fixed addon已提供哪些fresh事实、未提供哪些version/artifact事实，不能把kernel observation当持续identity证明。

待根接受方案后的候选生产写权为`packages/device/src/collaboration/codex-transport.ts`及必要`control-runtime.ts`窄hunk，加各自transport/target regression；若需`native-listener-evidence.ts`只由同owner列明确接口差异再交权，不默认重写已审addon/registry/proxy。先冻结N包并独审，保留原final uncached行为及missing-addon完整fallback、extra-owner拒绝、socket/executable/epoch/config变化拒绝、same-work当前验证。任何版本结果复用都不得成为跨await的安全缓存；纯结构整理只有在保留同一边界全部核查时可行。目标是减少同边界冗余，不另起更宽松的快验证通道。

N包验证先用局部真实临时native及普通target/control组合，记录相同操作量的lsof/version/final调用数与耗时变化；保留权限撤销、额外owner、可执行体变化、断开/重连和最终send前变化拒绝。此阶段若不够解释4 MiB改善，不连环扩改其他模块，转下一明确owner包。

#### 14.23.2 M-PERF-R：再处理A1 receiver同同步段冗余

N包冻结后，由原RI/receiver owner针对诊断确定的重复点串行接`material-receiver-provider.ts`；只有调用图证明必须改变接口时，再精确交`material-gateway.ts`或`material-store.ts`的单个final/current交接hunk。不同时由N/R改control-runtime。不得跨`gateway.envelope`签名await、文件I/O await、native metadata await或不同chunk保留“刚验证过所以安全”的结果；每段真实peer/pair/scope/current仍核。

允许审查的方向是同一私有lease、同一无await同步段内多个包装层重复调用同一final，明确一个所有者执行物理final，其余包装层保留自身scope/epoch/current检查。必须证明没有把不同boundary、不同target/control身份或中间发生的外部可观察变化合并；不能仅用“同tick”作为安全证明。每次put/commit、物理写/提交和返回签名前后各自职责写入代码契约；任何新token均私有、不可wire传入、不能跨段复用。

R包需要A1真实两store及gateway签名ordinary回归：撤权发生于签名await中、配置/target变化、put与commit之间变更、原始工作挂起后关闭、最终回执来源核验均拒旧proof或准确drain。随后才用原4188477B normal UI完整复验；只有真实A1到达、reader消费、native accepted一次、刷新不重发、原deadline内结束且cleanup完成才关闭4 MiB门槛。保留图像hash与实际native输入引用绑定，不用速度改善替成功终态。

reader退修当前仅research作者冻结，根独复/独审进行，未接收到最终接受前维持§14.22未accept。M-PERF-N/R与R-READ2b、R-DISC1分别归原owner，不扩同一slot为全库性能重构。I-WK2仍按根65179及review限定scope，百分比不因新的诊断、计数下降或单项测试green变化。


### 14.24 N-PROC1→N-VERSION1→原4 MiB：下一性能门槛

**68%保持。**第一窄包已由根84524独复30/30及review限定接受；原近4 MiB唯一复验96184仍失败，222.99秒（较前轮约＋14.5%），turn/start0、lsof2469、version5469，进程已清理。局部包接受不等于性能目标达成；明显剩余成本仍是regular版本执行与最终验证，不能再用“少了一些调用”宣称材料发送成功。

下一方案由根明确改为**跨await持有可执行artifact的私有版本证明，但每次regular仍新取kernel owner/current事实，最终final保持uncached**。这修订§14.23对版本结果一律不跨await复用的方案限制，不允许跨await缓存“授权/owner仍安全”的结论。被核对象是实际约246 MB Mach-O，不是约328 B launcher；版本字符串同名、launcher hash或已映射文件都不足以证明当前主执行体。

#### 14.24.1 N-PROC1：先补OS真正主执行体证据

**原native owner单owner。**候选写权：`packages/device/native/listener-evidence.c`、`packages/device/src/collaboration/native-listener-evidence.ts`、`packages/device/test/native-listener-evidence.test.ts`和`test/fixtures/listener-evidence-server.c`；若测试需要新增same-PID exec helper则单独fixture。`tools/build-device-listener-evidence.mjs`及native packaging tests只为新artifact/manifest一致性需要的hunk交权。此包不改transport版本cache、control权限或receiver。

实际缺口：目前C模块用`mapped_executable`扫描VMregion，加process start与listener集合；某文件存在于进程映射里并不等于它是当前main executable，process start也不能单独区分同PID exec。新增Darwin `proc_pidpath`主执行体观察，与expected actual Mach-O canonical路径/受保护文件身份相符；在已有进程身份/所有visible socket owner观察前后检查一致。保留mapped/owner既有约束，不能用main path替代全owner扫描。查不到、路径不一致、观察中变化均offline；不能因新API失败fallback为旧弱证据。

报告须明确这是当前OS快照，不是完整exec历史或跨await连续性证明；same-PID在两次观察之间exec再恢复不能仅凭process_start/path宣称从未发生。实例/transport epoch、配置/current与最终native检查仍承担原职责。新主exe字段只在私有native/TS observation使用，不把kernel地址/PID工具暴露到wire。

必要回归：正确主exe普通listener通过；另一主exe仅映射原文件拒；保留listener FD的同PID exec到不同主exe拒；PID复用/exit与检查中exec拒；accepted/fork/fileport及extra owner仍按完整集合判定。实际构建新addon、manifest SHA/N-API/arch核对且原loader每call核release不变。N-PROC1先独审，通过后才允许N-VERSION1依赖它，不先落能使用弱VMregion证明的cache。

#### 14.24.2 N-VERSION1：retained FD/hash/version私有证明

**同原native owner，等N-PROC1冻结后串行。**新增`packages/device/src/collaboration/native-artifact-version.ts`及对应专测；窄接`codex-transport.ts`、`control-runtime.ts`的regular观察调用及生命周期释放。旧`verifyUnixListener`/`discoverControlListener`的final路径与最终uncached lsof/version保持；fallback仅在真实unsupported时走原完整校验，ownership失败不能降级。receiver/store/gateway本包不改。

首次构造proof时打开实际Mach-O的O_NOFOLLOW只读FD，核canonical path、regular file/permissions/link、size/dev/ino/mtime/ctime和既定artifact兼容性；有界读取全文件SHA，真实`--version`与原生initialize版本匹配，前后重核FD和路径身份。proof由私有WeakMap发行，绑定当前native配置、expectedPID/当前main executable、transport/target生命周期；不能从字符串hash/version或descriptor自称签发。不要为每个chunk重复hash246 MB，按明确受限生命周期持有一个proof并设资源上限，关闭/失败/配置更新/原始工作完成后实际释放FD。

每次regular观察必须新取N-PROC1 kernel owner/main-exe事实，并同步核held FD与当前path的文件身份/元数据、配置/epoch/current及proof未释放；任一不一致丢弃proof并拒旧操作，不无声更新。只在当前物理artifact仍与初次hash/version一致时复用该版本值，不复用socket owner、scope或pair结论。不用墙钟TTL替代current，不缓存越过final；原最终lsof/version要在同实际动作边界重新执行。

验收覆盖：约246 MB实际artifact首次hash/version及多次跨awaitregular复用；跨await换文件/同path原地写/权限或link变化/不同主exe exec/owner变化/配置epoch变化均拒旧proof；原mutation后恢复不能复活旧lease；普通history增加不影响无关artifact proof。明确真实可检测边界，不写“stat/hash证明绝对不可变”的过强结论。测试核regular省下的version次数和proof/FD数量，但不为降低计数牺牲final；真实原生final仍调用version、missing addon/fullfallback仍完整拒extra owner。

#### 14.24.3 最后重跑原4 MiB，不先扩receiver包

N-PROC1与N-VERSION1局部独审通过后，根安排原4188477B PNG、103块normal UI的完整单轮复验，原TTL/deadline、目的A1/hash、reader/staging、native一次accepted、刷新不重复及关闭清理标准不变。计数报告分regular与final，嵌套耗时不相加。若仍失败，再依新诊断决定§14.23.2 receiver包，不预先并写A1层。small input回归只验证兼容，不替4 MiB成功；synthetic native通过仍不代用户原桌面大图消费或APK真机。

#### 14.24.4 R-DISC1来源发现路线更新：仅已有native endpoint

research已在真实临时树确认：无override启动固定CLI的initialize阶段即打开有效`state_5.sqlite`；`config/read {includeLayers:false,cwd:...}`的`config.sqlite_home`默认返回null、外部配置返回物理root，两个fixture均与actual opened FD dev/ino一致。**initialize可能创建DB**，因此不能把这种新起server的探针自动用于用户home。

根已选择生产发现走**已有且受保护的native endpoint→私有config/read→同owner实际opened SQLite FD**，不启动userhome新server。候选owner/executable/version/socket必须来自原真实可信NativeFactory/当前listener身份，不能枚举随便一个PID或让UI自报。config/read为本机管理专用窄方法，不能开放到普通控制wire或任意原生RPC；默认null由该已核owner实际FD说明有效root，不能自动拼home推断。配置响应仅私有提取相关字段，原owner/epoch/root在await前后和候选提交前复核，返回opaque candidate并沿v3 source绑定授权。

发现入口不可用时显示“请打开原Codex并重新检测”及确切支持状态，不暗起新server、不复制凭据、不改sqlite_home、不默默退到另一home。已有明确source descriptor的正式saved reader仍可以独立工作，不能把每次历史读取也绑到桌面必须在线；这里的existing-endpoint要求只用于新来源发现/重新确认。完成发现后read-only新reader仅按已选existing realm有界读取，另保留原启动副作用评估。此路线是根确认的工程选择，暂无用户产品决策；真正打开用户客户端或权限操作不由本轮自动执行。


### 14.25 I-SOURCE1：来源后端、v3授权与普通原生选择的串行包

**当前68%保持。**N-PROC1根97852独复4/4（5.86秒）及review接受，host进入N-VERSION1；I-SOURCE1不占native性能文件。R-DISC1根59050原6/6后独审发现socket tail P2，作者已补7项＋TS；根44985新suite仍在运行，独审自有tmp同次拒绝且sticky保持已通过。未收到根最终放行前仅准备接口，不将旧6项算最终接受。

已核实际API：`captureNativeReadDiscoveryInput({stateDir,endpointId,codexHome,current})`读取固定受保护runtime配置并绑定选定home；`discoverSavedHistorySource(input)`通过existing Unix WS `config/read`及同owner SQLite REG FD产生opaque candidate；`nativeSavedHistorySourceSelection(candidate)`只供native writer取得descriptor字段；候选整个生命周期必须保留issuing input。两文件本身没有chooser、source writer、scope迁移或默认main/UI接线，不能以它们通过就关闭普通source设置。

#### 14.25.1 S1-B：先授source作者完整生产backend

| 文件写权 | 精确改动及禁止扩张 |
| --- | --- |
| 新`packages/device/src/setup/read-source-settings.ts`及`test/setup-read-source-settings.test.ts` | 生产来源candidate/preview生命周期、固定current、持有与释放、来源保存。生产默认调用已审discovery，不只允许fixture注入；最多4个有界待选candidate，超限busy，过期/关闭释放candidate后input |
| `collaboration/local-state-transaction.ts`及对应专测 | 在原LocalStateName/limits增加`collaboration-read-runtime.json`的16 KiB观察和locked write，不新数据库/registry，不改通用锁语义；新增name会影响全部revision，保留旧各类授权回归 |
| `setup/scope-settings.ts`、`service.ts` | source status及先撤read scope再descriptor的生产写路径；read v3 issuer只能从当前私有source proof取得source_id/binding_revision。旧read v2只本机review，不能继续以configured/verified表示已可读 |
| `setup/material-ipc.ts`及对应固定IPC tests | 增加固定`source.status/source.prepare/source.apply`操作族；沿既有HMAC/generation/nonce/TTL/current/bounds。source与scope/material preview分family，不能交叉重放。不开放任意native RPC、文件写、argv或PID |
| `setup/native-verification.ts`、`setup/shell-status.ts`及专测 | read selection分支使用当前protected saved source＋有界probe并发行私有read proof；control仍原control proof。status的read/source与control/socket分项独立，saved read缺control socket仍可正常核验 |
| `main.ts`和`test/setup-online-main.test.ts`、其他实际受影响main tests | 注入生产source service/生命周期与真实现有read工厂；旧readFactory测试注入迁移到显式testing接口，production undefined继续默认运行。不得为使fixture绿恢复生产PATH fallback或宽松proof |

原冻结discovery/realm/reader只读；若新backend缺一个私有接口，先报root具体hunk后串行交权。S1-B不修改Swift、设置UI、native addon、codex-transport/control-runtime或材料provider；UI最后由原壳owner接，main串行避免与其他作者冲突。

**固定端口建议。**source.status返回本机来源投影与`missing/configured/changed/unsupported`状态、是否需重授read、当前precondition，不返回密钥/原始config/PID句柄。source.prepare接收私有native producer所选home（默认选择或本机NSOpenPanel结果），自行capture/discover；renderer的路径不被直接传入这个可信入口。响应只有preview_id/selection_hash、可展示的来源摘要、旧read授权将失效的差异。source.apply只接原preview_id/hash，不能接受用户重传descriptor。输入给discovery的endpoint/root/runtime path由main受保护配置确定，不能从UI字段选择。

跨进程不能假装传递WeakMap proof：Swift/Node native bridge保留home选择ID→真实目录的私有映射，认证IPC由bridge翻译为本机native选材参数；后台收到后重新取得实际input/candidate proof，浏览器只看opaque ID。初期没有UI时生产backend仍可被固定私有桥调用并由真实IPC测试验收，但不得把这个阶段宣告完整无JSON用户旅程。

#### 14.25.2 scope撤销、descriptor写与v3签发的精确时序

prepare在当前paired owner/endpoint、旧source revision和选定home下取得input/candidate，配置/Socket/进程/realm变化即时sticky失效；清理候选不会关闭用户原native。保存前先reserveChange，核owner/grant/source/preview、candidate当前及实际安全状态，UI明确知晓会重置旧read授权。然后沿原locked setter撤旧read grant；**保持同一个reservation**，核这次确切自有删除结果、未发生额外pair/source/权限变化，再取得下一LocalStateToken并写descriptor。不能拿旧全state token在第一写后必然stale，也不能为继续第二写把所有并发变化忽略或任意重签旧candidate。

proof的不可变native/home/config/realm事实与这次自有read文件变更应分开核；如果producer current直接绑定整个初始state revision，作者必须设计可验证的自有transition交接或重取current证明，不能把private proof标成always-current。第二写前再验candidate/native/socket tail及pair。第二写失败保留read未授权、status准确说明“来源未完成保存，需要重新选择/授权”；不得恢复旧scope到可能已变化的source。descriptor id由服务管理，binding revision沿当前私有source实现产生，不能UI自报。

source保存成功后**仍未授read**。用户另行选择范围→read preview取正式新source→read apply生成v3完整grant；允许v2旧目录作为待确认列表，不自动迁移。每次读admission/manifest继续核source_id/binding_revision，所以外部合法descriptor替换同cwd也拒旧grant。普通DB内容增加不改变artifact/realm绑定，不导致每消息重新授权；source/config/artifact或realm身份实际变化则旧proof和grant不再ready。control/create/receive grants不随source切换扩大或迁移。

#### 14.25.3 S1-U：原壳owner接普通默认home和原生选择

等S1-B接口冻结且独审后，原壳owner独占`packages/device/macos/ConnectionAssistant.swift`、`src/setup/shell-bridge.ts`、`ui/setup/index.html/setup.js/setup.css`及shell/WK专测的source相关hunk。I-WK2活跃入口先冻结再交，禁止并写。固定production bridge在可信本机进程取得OS home，提出受支持默认Codex资料目录候选；不能让renderer提交HOME环境、JSON、SQLite路径、executable或兼容SHA。默认按钮是“检测已有Codex来源”，先检查目录已存在，再用现有受保护endpoint核该来源，不能自动mkdir、新起server或改Codex配置。

自定义home走真实NSOpenPanel选择既有Codex资料目录，用户无需知道`state_5.sqlite`或`sqlite_home`；backend仍根据existing endpoint真实config/read及同owner openedFD验证。默认null必须由实际该home的DB FD支持，外部root必须有受支持配置来源及实际FD；selectedhome与运行endpoint来源不符则明确显示“所选资料目录不属于当前连接”，不能因都存在而verified。

正常UI连续流程为：来源检测→显示来源/版本/当前是否可读→预览切换影响→明确保存→显示需选择读取范围→原生目录选择和read范围preview/save→列表/详情按新source成功。首次没source和旧v2同样给该流程，不要求用户开终端或编辑JSON；候选过期可重新检测，不能自动确认变化后的范围。来源可读、control可用、已配对、当前在线分别显示。已有source保存之后的saved read不再依赖桌面control socket在线。

若普通默认runtime endpoint还未由安装助手/同owner生命周期发现与写入，UI具体显示“尚未连接原Codex”，并接完整安装/客户端连接包；不能为本包绿让用户手填runtime JSON。这个依赖不阻止已配对fixture交付S1-B/S1-U，但必须保留为首次安装正式接受前置。

#### 14.25.4 必须回收的接受证据

- actual existing native fixture＋production source service＋真实认证IPC：默认home与外部sqlite root选择成功，保存前零写；取消/过期/错误family/重放拒；不spawn任何userhome reader/server来做来源发现。
- 在source.apply两个写之间分别注入失败、owner/grant变更、source/socket/realm替换与shutdown：无旧scope泄露、没有半完成状态误verified；reservation释放且retained input/candidate/fd实际归零。证明自有第一写可正常前进、外来写不能被伪装成自有transition。
- 同cwd两个source、外部合法descriptor替换、旧v2迁移全部要求明确v3重授；普通历史增长不撤权。独立saved-source read preview/diagnostic在control socket缺失时成功，control指示仍不可用，不同类别权限不互授。
- 默认main实际注入和旧read测试fixture迁移通过，正常刷新发现能力，rawpipe drain后不靠手动dispatch才能恢复。保留原control/create/material行为回归。
- 正常设置DOM到actualIPC完整source＋v3scope旅程后，再实际WK/default native producer/NSOpenPanel验证；Chrome模拟只算逻辑层。最终从零安装、一次配对、原Codex来源发现、scope选择和第一请求仍完整必验，不被“已配对GUI”替代。

当前不需要用户作产品决定或配置操作；root可在R-DISC1终态接受后授权S1-B。真实用户登录、客户端启动/重启、TCC或发行安装仍沿已有具体授权边界。本节只规划owned文档，不先改源码或开启真实用户应用。
