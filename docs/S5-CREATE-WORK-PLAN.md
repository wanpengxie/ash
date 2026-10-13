# S5：指定真实项目新建工作

2026-10-09 · A/B/C/D/E/F 与 G UI 已获开发层独审放行；实际创建 Chrome fake 全链作者报告5项通过，独审进行中。依据产品 v0.5、技术 v0.2 与[实施计划](CROSS-END-IMPLEMENTATION-PLAN.md)。当前 S4 分段 fake 验收不代表 S5 完成；本文只规定代码分包与验收，不授权真实配置、安装或业务调用。

当前排期：S4 开发层已通过；S5-A `create_contract`（14项）、B `create_journal`（43项）、C `codex_create_adapter`（30项）、D `create_authorization_service`（45专测及tsc）、E `create_device_wiring` 均独审放行。F Core固定接线及旧control回归已独审放行（71项及24项外层probes）；G UI monotonic receipt修复已最终独审通过（23 unit + 5 Chrome），根已完成受影响Core/device构建。实际service/store/adapter的创建Chrome fake全链作者报告5项通过，目前独审中，不能提前算独立验收。根最新整体56/100（15+18+12+6+0+5），按产品能力证据计分，测试项数不直接换算进度。真实创建、Android/Mac、生命周期、安装及完整材料双向仍未通过。本文件不自行启动agent、不授权真实配置、安装或业务调用。

## 已核对契约与范围

用户已经证实 itsallsame 指定项目新建会话且桌面侧栏可见，无需重做能力存在性或侧栏研究。已读取 `/Users/ahaha/work/xiebo/itsallsame/apps/browser-bridge/src/codex-local-service-launch.ts`：`project/list` 以 `roots[].path` 规范化后精确匹配 workspace，再调用 `thread/start({cwd, ephemeral:false, projectId})`、`thread/name/set({threadId,name})`、`turn/start({threadId,input})`。

Ash 复用该调用契约，使用本节点已选共享 daemon、版本/实例校验和当前授权。不得复制参考实现中 projectId 查不到就省略参数的 fallback；找不到、分页未完成、歧义、权限失效均不创建。项目名、目录尾部、相似路径不构成匹配。分页限定条数、页数、总字节和统一 deadline；重复 cursor 报不可确认，不将局部未命中说成不存在。多个项目共享同一 cwd 时必须匹配已选真实 projectId；默认项目只保存明确选择的 ID/cwd，失效后要求重新选择，不切换目录。首次项目列表仅返回当前 exact_cwd 授权内的项目，不泄漏其他项目。

这里只创建会话并提交第一条明确要求，不自动创建磁盘项目、安装 Skill、回答审批、切到 managed-runtime 或复制 itsallsame 的业务提示和固定 effort。源链接是来源引用，不代表视频或附件已交付。限定材料、问题回复、结果领取和双向协作另属 WP-A，仍在完整 Goal 内。

## 最小 DTO 与授权边界

现有 `ControlAction` 仅 `send_input|steer`，`ControlRequest` 和 `DeliveryFact` 强制已有 WorkRef；`OperationStore` 的 native_id 为 NOT NULL，绑定旧调用/核查语义。因此创建使用单独类型与持久映射，不预造 native_id，不将 operation_id 填进 WorkRef，也不使旧 work 字段全局可选。

冻结独立 `create-types.ts` / `create-protocol.ts`，A owner 按下文导出边界实现：

- `CreateTarget = {node_id, endpoint_id, project_id, cwd}`，均来自当前可验证项目选择；cwd 为本端绝对规范路径，与 grant 使用同一规范化规则，不能靠路径前缀授权。
- `CreateWorkRequest = {version:1, request_id, operation_id, authorization_revision, target, title, input:{text}, expires_at}`。主体由可信 transport 传入；拒绝 body principal/caller、任意 native 方法和未知键。正文总量沿用 64 KiB，标题另设小上限。
- `CreateWorkFact` 保存 request/operation、target、payload_hash、expires_at、三个阶段事实、`work:WorkRef|null`、稳定首次输入 client ID、接口版本/epoch、固定错误枚举和 observed_at。返回 DTO 显式白名单，不输出 principal、输入正文、原始错误或数据库对象。
- 每阶段事实包含 `not_started|invoking|accepted|rejected|unknown`、attempt_id、owner epoch、原生回执和时间；外层另有已记录状态。`work` 仅在真实 thread ID 经验证且持久保存后赋值。命名、会话已创建、首次输入已接受、执行完成分别表达。
- 固定入口采用 `projects`、`apply`、`query`、`reconcile`（统一 create 命名空间，详见首包表）；query/reconcile 按可信 principal + operation 定位，以 target/revision 约束访问，不要求客户端已经拥有 WorkRef。query 不隐式 reconcile，两者都零写 native 调用。A owner 不改入口名称；消费者以通过独审的导出声明为准。

`control-authorization.ts` 已允许 `create_work` 出现在 `allowed_actions`，且禁止它用于 single_work grant；但现有 `ControlAuthorization.begin` 强制已有 WorkRef 并先读取 thread metadata，并不能直接授权创建。新增独立创建 lease（建议 `create-authorization.ts`），只复用已冻结 config parser/snapshot 和可信配对来源，不绕过当前 grant 检查，不假造 thread metadata。

创建 lease 必须绑定当前 owner、node/endpoint、grant revision、exact_cwd、真实 projectId 与 transport/connector epoch。`create_work` 授权涵盖本次请求的创建、命名及一次首次输入；不能延伸为该会话无限 send/steer，后续继续走已有动作授权。项目解析前后、各阶段调用前、每个异步授权等待后及最终成功/错误返回前复核；watch 的 revoke→restore 也失效旧 lease。到期只阻止新阶段写入，当前仍获准的查询可返回已有事实；撤权禁止返回事实。新 WorkRef 已知后再用同实例元数据证明 thread/cwd，不能以请求中的 cwd 作为原生归属证据。

## 持久事实、恢复与消息回收

新增单独 SQLite create store，持久关联 `(principal, operation_id) → selected project → native thread → first turn/message`。同键同规范摘要仅返回已有事实，同键不同摘要 conflict。请求 hash 覆盖版本、目标、title、input、到期和明确影响执行的参数。操作种类纳入独立路由/存储命名空间，不能把 create 记录拿给旧 control/query。不增加第二份 Core 手机消息账本；不把会话目录或标题当原生幂等键。

| 窗口 / 阶段 | 必须保存与行为 | 恢复限制 |
| --- | --- | --- |
| 记录后、创建前 | record 先提交；project 校验后原子 claim 写 FULL 调用意图 | 同键并发只有一个 claimant；尚未发起阶段可在原 operation 明确继续并重新授权 |
| thread/start 发出、回执未保存 | create=invoking，保存 attempt/epoch/version；中断后保守 unknown | 不重建，不按同标题/cwd/时间相近认领；没有可靠原生 operation→thread 证明就保持 unknown |
| 创建回执落盘 | 保存真实 WorkRef 与 create=accepted 后才进下一阶段 | 后续失败不能抹掉 WorkRef、谎称“未创建”或再次 thread/start |
| thread/name/set | 独立意图和命名事实，之后才首次 turn/start | 命名 rejected/unknown 时保留“已创建，命名失败/待核实，尚未启动”；首版不自动越过失败，不自动重放命名 |
| turn/start | 独立意图；稳定 clientUserMessageId 在发出前持久生成，仅发一次 | 回执丢失/重启后 start=unknown，不重发、不另建 operation；只读原 thread 的有界历史核查 |
| 原生接受 / 历史核查 | turn 回执只证明原生接受；持久保存 clientId→turn/item 的可靠关联及 bounded provenance | 无稳定 message 映射不得回收乐观消息；文本相同和 turn ID 相同都不足 |
| 已保存、HTTP 回执丢失 | query 返回同一已保存阶段事实 | 不再次 create/apply；到期不删除 unknown 或去重键 |

首版不做自动后台推进。query/reconcile 只读事实；只有显式继续同一 operation 才可推进确认为 not_started 的后续阶段，且逐阶段重新授权、检查 expires_at 和先前事实。任何 invoking/unknown 阶段都不得因超时、进程 epoch 改变或手机刷新而再执行。恢复 owner 检测沿用 S3 的保守原则（活 PID、PID 复用、EPERM 不证明死亡），禁止短租约到期抢占。新 store 独立实现/测试该语义，不未经交接改旧 store 抽象。

create unknown 缺 thread ID 时，当前协议没有足够证明做自动恢复；允许显示原操作待核实，不扫描其他聊天或按正文猜归属。已知 WorkRef 的首次 turn unknown 可复用 S3 有界历史核查原则，但不将 create 类型强塞旧 DeliveryFact：核查必须匹配本次 client ID、完整 WorkRef、版本与原生 turn/item，保留页数/是否穷尽。查询失败不是原生拒绝，不能把 unknown 改成 rejected 来允许重做。

UI 先按 operation 展示新建请求卡；work=null 时没有伪会话。真实 WorkRef 到达后关联到同一张请求卡与列表项。首次消息只有稳定来源映射才合并，native accepted 不显示业务完成。权限/目标切换清除不可见缓存并拒收旧响应，离线只 query 原 operation；“再做一个”是用户新的明确意图和新 ID，不能成为未知操作的默认重试。

数据库使用有界容量和保留去重 tombstone 的归档策略；容量满拒绝新操作，不删除 unknown 以腾出可重执行空间。native 回执写库失败只允许续存同 attempt 的已结束回执，不允许续发 native。close 不关闭用户 daemon，不宣称 HTTP 取消等于原生取消。

## S5-A 可直接下发的最小任务

owner：`create_contract`（Sol medium，14 项独审 final 已通过；以下保留已交付范围）。独占新增 `packages/device/src/collaboration/create-types.ts`、`packages/device/src/collaboration/create-protocol.ts`、`packages/device/test/collaboration-create-protocol.test.ts`。仅实现纯类型、严格解析/返回白名单和阶段合法性验证；不做 I/O、store、原生调用、配置写入或接线。旧 `control-types.ts`、`control-protocol.ts`、`operation-store.ts`、`control-authorization.ts`、transport、main/link/capabilities、Core/UI 与生成产物全部只读。出现必须修改旧文件的需求先向根交接，不自行扩大范围。

| 项目 | 冻结规格 |
| --- | --- |
| 导出 | `CreateTarget`、`CreateWorkRequest`、`CreateStageFact`、`CreateWorkFact`、`CreateAdapter`、`CreateStore`、`CreateLease` 属于 create-types；`CreateOperation`、`CREATE_CAPABILITIES`、`CreateEnvelope`/`CoreCreateEnvelope`、`CreateFactDto`、`CreateProjectsDto`、`parseCreateEnvelope`、`validateCreateResponse`、`toCreateFactDto` 属于 create-protocol |
| 路径 | Core `POST /api/collaboration/create/{projects,apply,query,reconcile}`；device capability `collaboration.create.{projects,apply,query,reconcile}`，固定 dispatcher 选择动作，body 不接收 method/path/capability |
| 项目请求 | `{version:1,node_id,endpoint_id,authorization_revision,cwd}`；Core 另加 `device_id`。cwd 必须规范化绝对路径；授权前不查项目，返回仅 exact_cwd 下可验证项目。原生分页由 adapter 在统一预算内完成，首版不向手机发任意 native cursor |
| 项目响应 | `{target:{node_id,endpoint_id,cwd},authorization_revision,connector_epoch,native_interface_version,projects:[{project_id,cwd}],complete:true}`；严格大小/重复 ID 校验。分页不完整或歧义报固定错误，不能返回局部列表冒充完整列表。UI 展示名称不是匹配凭据，首包不增加原生任意字段 |
| apply | `{version:1,request:CreateWorkRequest,expected_connector_epoch}`；Core 另加 `device_id`。request 自带 version/target/revision，不重复外层目标；所有字段严格验证，title 非空且最多 256 UTF-8 bytes，input.text 非空；整体输入 64 KiB，输出 1 MiB，统一 30 秒 deadline |
| query/reconcile | `{version:1,target,authorization_revision,operation_id}`；Core 另加 `device_id`。返回 `{fact:CreateFactDto|null}`，apply 不允许 null。query/reconcile 不要求旧 expected epoch，也不要求 WorkRef；按当前 lease 检查，响应 target/operation 必须匹配，apply 另核 request_id/expires_at |
| 错误与阶段 | 独立 `CreateErrorCode` 复用 S4 固定错误词汇（invalid/too_large/permission_denied/expired/conflict/busy/storage_failure/unsupported/offline/stale_precondition/result_unknown），不得原样返回 native error。阶段键固定 `create`、`name`、`first_input`，各自保存 status/attempt/owner epoch/native version/receipt/error/time；字段用明确 null，不用任意 Record 装原生回执 |
| fact 白名单 | 只输出 version/authorization_revision/status（若类型声明包含）、request_id/operation_id/target/expires_at、三阶段事实、work、native_client_message_id、reconciliation/error_code/observed_at；不输出 principal、payload_hash、输入/title、进程归属细节、原始 native 结果或数据库对象。owner epoch 的内部恢复证据与可公开 connector epoch 分开 |
| 阶段一致性 | 初始三阶段 not_started 且 work=null；create accepted 必须有匹配 node/endpoint 的真实 conversation WorkRef；name 仅在 create accepted 后可推进，first_input 仅在 name accepted 后可推进。任何 invoking/unknown 均禁止重发；命名失败不自动越过。accepted 表示该阶段原生接受，不表示任务执行完成 |

A 还须给出消费者可编译的最小接口，不能仅以 `unknown` 占位：`CreateAdapter` 显式分离项目精确解析、createThread、nameThread、startFirstInput 和只读 metadata/history；每次写入都接受对应持久 attempt、connector epoch、version、请求绑定 authorize 回调，startFirstInput 接收已持久 client ID。`CreateStore` 明确 record/get、单阶段 CAS claim、同 attempt 保存 outcome、保守恢复 invoking→unknown 与 close，principal 只作为可信内部参数；保存原生已结束回执失败仅可重试保存，不再 native invoke。`CreateLease` 明确绑定 target/revision、authorize 与 run，projects 预授权仅绑定 exact_cwd，选中真实 projectId 后生成目标 lease，不能为列项目伪造 projectId。类型签名及 null 规则由 A 一次实现并独审，B/C/D 只读导入，后续变更交回 A owner。

**A 验收：**严格 unknown keys（含嵌套）、伪 principal/native overrides、路径/目标/WorkRef 不匹配、假 projectId 结构、超额、阶段逆序、accepted 缺回执、unknown 被表示为可重试、DTO 泄漏字段、Core device 映射与 response request/operation 错配均有定向测试。项目真实性由后续 C 原生解析证明，A parser 通过不等于 project 已获授权。通过专测与 device tsc，再由独立 Sol review；交接实际导出签名、测试结果和未实现列表给根。根放行后 B/C 才实现，不能以接口编译通过宣称整个 S5 ready。

## 文件分包与依赖

下表为冻结的分发边界，根协调者明确 owner 后生效；不构成提前给多个实现者共享文件写权。

| 包 | 独占新增文件及测试 | 前置 / 禁止重叠 |
| --- | --- | --- |
| S5-A 契约 · create_contract（14 项独审通过） | device `collaboration/create-types.ts`、`create-protocol.ts`，协议验证 tests | 先冻结 DTO、错误、阶段转移、入口和 adapter/store 接口；旧 control-types/protocol/store 默认只读 |
| S5-B journal · create_journal（43 项独审通过） | device `collaboration/create-operation-store.ts`、`create-delivery.ts`，SQLite/进程故障 tests | 依赖 A；持久 map、CAS、多阶段意图及恢复；旧 operation-store.ts 仍由原 owner 独占，不在本包改 |
| S5-C 原生项目与创建 · codex_create_adapter（30 项独审通过） | device `collaboration/codex-projects.ts`、`codex-create.ts`，fake socket tests | 依赖 A，可与 B 分包；复用选定 transport 只读 API。adapter 按阶段调用，不私自把整个流程藏进一次不可观测 invoke |
| S5-D 授权与服务 · create_authorization_service（已独审通过） | device `collaboration/create-authorization.ts`、`create-service.ts`，撤权/并发 tests | 依赖 A；完整接线依赖 B/C。复用当前 grant，不另造宽权限配置；现有 authorization 文件有必要改动时先交回 owner |
| S5-E device 入口 · create_device_wiring（已独审通过） | runtime/main/link/capabilities、bounded pairing helper 及入口 tests | 必须等 S4 device 独审完成并显式交接；D 完成后接入创建 manifest/固定 dispatch/busy/close/watch，不能两个 owner 同改 main/link |
| S5-F Core · core_create_service / Core旧入口（已独审通过） | 新增 core `collaboration/create-service.ts`、专用路由 tests；server/gateway 最小挂载 | A 已冻结，纯服务与 D 并行，双方冻结 create manifest；旧入口挂载等 E/D 就绪并独占交接。Core 旧入口 owner 独占修改 server/gateway；固定 owner/screen、统一 deadline、前后 fresh check、no-store、无 ledger 正文副本 |
| S5-G UI（monotonic receipt修复已最终独审通过） | 新增 `desktop-create.js`、`desktop-create-store.js` 与单测/e2e；现有 desktop UI 最小挂载 | A/F 冻结后由 UI owner 接手；当前 S4 固化完成后交接旧 UI 文件。生成 ui.ts/Android ash-ui 只由根统一构建 |
| S5-R 独审 | 默认只读；独立 probes 与实际 adapter fake socket 全链浏览器 tests | 各包先独审，再 Astra 分段验收；修复退回各 owner，不并改共享文件 |

当前 A/B/C/D/E/F/G 已获开发层独审放行，受影响构建已完成；剩余开发门槛是实际创建Chrome fake全链的独立审与必要修复。授权 D 的隔离测试可在 A 后准备；不能用未完成 D 的恒真授权直接宣称集成 ready。S5 创建 record 和旧 S3 send/steer record 不互相迁移；若确需共享 store 原语，另列迁移方案、由原 owner 顺序改并回归旧数据，不能偷偷扩大本包。

## 验收与保留门槛

1. 项目：精确 cwd、同名不同目录、同 cwd 多 ID、已选 ID 被删除/换 root、重复 cursor/页数耗尽、未知 projectId 全部覆盖；失败 `thread/start=0`。成功明确带真实 projectId/cwd/ephemeral:false，无默认省略。
2. 原生序列：成功恰一次 thread/start→name/set→turn/start，首次输入携带持久 client ID；每阶段之前都观察到对应落盘意图。初始化/项目查询不启动任务，无 resume/steer/interrupt/审批写调用。
3. journal：各阶段前后关键崩溃窗口、重开 SQLite、活进程并发、同键同/异摘要、容量、保存失败续存、未知保留；创建和首次启动各最多一次。重传/query/reconcile 不补发未知阶段。
4. 授权：wrong/missing from、owner/pairing/grant/endpoint/cwd/project/revision 不符、到期、撤权 ABA、异步项目/metadata/最终响应期间撤权、跨请求并发 lease 隔离；成功与错误返回均最后复核。
5. Core/UI：仅明确提交产生 operation；项目失效不 fallback；创建成功但命名/启动失败仍显示同一真实会话；unknown 不出现默认再建/再发；只用稳定映射回收。普通 DeviceMember/model 无 collaboration 旁路，迟到响应不跨 screen/owner/target，ledger 不复制轮询正文。
6. 独立链：真实 Create service/store/adapter 经 fake socket、固定 Core HTTP 与 Chrome 覆盖成功和部分失败；同操作重开/丢响应后仍关联同 WorkRef。受影响 typecheck/build 通过后才记录本地产物，无关全套不重复跑。

真实 S5 后续仅在已有授权内选定独立测试项目/会话，核查 Ash 链路的项目 ID、WorkRef 和首次消息映射；用户已经证实的侧栏能力无需再次请求证明。真实范围、安装切换等必要前置仍按实施计划具体授权，开发不因此停摆。

S5 通过也不缩减原 Goal：C4 产品路径故障/重启核查、C5 登录插件兼容、C6 daemon 生命周期、Android 真实链路、限定材料摘要交付、问题/结果关联及原会话跨轮反向领取、普通用户无 CLI 安装/配对/升级和发行全部保留。只有完整首期条件达成才完成 Goal。

限定材料与双向结果接口见 [WP-A 分包计划](CROSS-END-MATERIAL-IMPLEMENTATION-PLAN.md)。S5 的 text-only 输入与 WP-A 附件引用接线须独占交接；WP-A 纯新增契约/服务可提前开发，不以创建完成替代跨轮反向领取。

最新接线交接：D与共享manifest、E生产factory/生命周期接线已独审放行；F最终异步owner复核后的pairing/grant/connection窗口与旧control同类窗口已修复并独审通过。TrustedCreateContext必须继续提供真实同步current()，不能用空函数替代owner/screen证明；最终fresh device inspect后同步owner及session fence，成功与错误均适用。该契约已经由实际旧入口和24项外层probes核查，后续材料接线不得回归。当前仍未启动真实创建或安装。

Core旧入口接线验收补充：必须通过server真实owner API token/screen身份的同步current谓词与gateway同连接同步fence闭合最外层Promise返回窗口，不能只在纯服务fixture中传current空函数。远端screen的transportCurrent异步检查之后还需可验证的本地连接/主体generation门槛；无法在同步门槛获知的远端权限变化应以最后fresh检查的观察时刻表述，不伪造零延迟全局撤权。创建GET endpoints也须具备相同最终门槛；四POST接线必须把CreateReturnGate原样传至固定transport，不能被wrapper丢弃。旧control同类窗口已由独占owner修复并独审回归；server/gateway共享文件后续仍只给单一接线owner。

S5真实实现fake链验收（已分发；作者5项Chrome通过，独审进行中）：独占新增desktop-create-chain.spec.ts（及必要新fixture），从Chrome用户明确选择真实project与submit，经实际Core固定transport/router、DeviceCreateService、CreateAuthorization、CreateOperationStore、CodexCreateAdapter/CodexCreateTransport到唯一fake socket peer；只有原生socketpeer可fake，不能用预造fact替代整个服务。至少验证成功三阶段各一次且SQLite保存同WorkRef；命名失败保留work并首次输入零写；首次输入回执丢失后页面重开及store重开只query/reconcile，原稳定clientId证据可核查且不再turn/start；projects离线保存事实仍可查询；撤权等待中不展示迟到work。应断言真实projectId/cwd/ephemeral参数、nativeclientId落盘及固定能力白名单。该开发fake链通过也不替代真实Android/Mac及安装门槛。


WP-A最新交接：A0 `material_contract` 原纯协议独审11/11、tsc与probes通过；下游复核发现真实节点/会话来源与目的地、问题回执和work_result提交缺口。根已批准[WP-A第3节A0-R修订](CROSS-END-MATERIAL-IMPLEMENTATION-PLAN.md#3-a0-当前事实与必须先完成的修订包)，由原owner独占三个协议文件修订并重新独审冻结。A1资产、A2 ledger facade、A3可信身份/签名反向relay工作包已准备，尚未正式分发。手机主动材料必须使用可信node来源和真实目标WorkRef，原会话工具必须有连接器验证绑定；不得假造手机conversation。Core/device旧入口、agent-mcp与ledger/router的材料挂载继续留A5单owner，不能因S5文件释放而由多个包并改。
