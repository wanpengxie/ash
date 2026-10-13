# 第一阶段产品交付：连接电脑并在 Ash 读取 Codex 会话

2026-10-11 更新 · Astra 产品监督决定。第一步“连接并读取原会话”现已获用户真机确认，10轮消息读取成功；下文保留实现与验收过程及第二步发送计划。不继续扩材料性能、桌面设置 GUI 或通用管理设施。原68%是历史工程估算，不能转换成当前可用度，不新增百分比。

**当前执行点（2026-10-11 最新）：** 手机读取、普通发送、运行中追加与回复读取、连续输入不被刷新打断均已由用户真机确认。下一步仅交付“在 ash 项目新建会话 → 输入要求 → 打开并读取回复”：复用现有创建链，取消手填标题，唯一已授权电脑/项目自动选择。先完成界面和接口检查，再具体说明授权变更并由用户确认；当前单会话控制授权不包含新建。以下旧的尚未接受手机发送等描述为历史记录。

## 用户完成什么

前提只明示：已有可运行的 Ash 电脑命令入口、手机与电脑已经配对，本机有受支持 Codex 及指定项目的已保存会话。首次安装/配对暂非本阶段成果，完整Goal继续保留。**预写 source/runtime JSON、手填 socket/SQLite 路径不允许作为隐含前提。**

目标命令形态（只读路径已冻结供整合，尚未完成用户验收，不是当前使用说明）：

```sh
ash-device connect codex --project /用户选择的已有项目
```

用户只运行这一条命令，核对一次来源和项目范围并确认；随后在 Ash 点“电脑”→这台电脑→会话，看到原 Codex 的真实已保存消息，点刷新取得最新已保存内容。命令内部完成来源发现、连接和只读授权，不要求连续执行source/read-scope/run等管理命令。项目路径是用户意图，不是让用户处理内部数据库路径。

成功提示必须说明电脑名称、Codex来源、获准项目、当前连接状态和下一步“在 Ash 打开‘电脑’”；只获得grant或写入配置不能输出“已连接可读”。不发模型任务，不授发送/新建/材料权限。正常流程预算为一条命令＋一次确认，失败时给具体可执行的恢复动作。

## 现状：已有成果与实际阻挡

| 用户链环节 | 当前代码事实 | 本阶段判定 |
| --- | --- | --- |
| 一条命令连接 | `cli.ts`/`setup/connect.ts`只读路径已冻结，串行来源保存、v3范围及实际读检查，包含慢确认/unknown/project身份修复 | 当前进入真实配对页面整合，不能让用户调用内部IPC或拼多条命令补齐 |
| 自动找到原来源 | 默认stdio来源的真实自有fixture通过；source settings已有无control runtime时的自动发现分支 | 可行性已证，停止扩大研究；当前只验命令到默认读取链，不把fixture当真实手机交付 |
| 来源保存和v3授权 | source.status/prepare/apply、同gate撤旧read后保存descriptor、saved-source read verifier及main注入已纳只读冻结路径 | 复用并进入整合，源码/fixture通过不等于真实可用 |
| 设置门槛 | main已有独立read-only reservation；own-write迟到watch修复后root联合回归3/3通过，精确hunk独审接受 | 保存后立即普通list/read已在开发fixture完成，外部同bytes替换仍拒绝；不靠retry或增超时。control原门槛保留，尚不代表真实手机 |
| 正式读取 | protected saved reader/v3来源绑定、分页/消息读取已有；legacy v2不得广告ready | 复用，不再建reader。source配置与runtime gate接好后走默认工厂真实验证 |
| Ash入口 | Core正常app已mount DesktopWork，“电脑”按钮已有；endpoint/list/read、按需刷新、重开缓存、离线标签已有 | 优先整条实际链验收，仅修暴露的阻挡，不重做界面。fixture/Chrome模拟不替真实Ash用户验收 |

当前尚无“一条connect后真实Ash可读”的证据。最少下一交付是把CLI、自动来源、现有后端与正常Ash串成一个成功流程。

## 对source作者现有未冻结工作的裁剪

**保留并完成：** source固定IPC、实际来源proof及v3签发；来源切换不继承旧scope；saved-read预览/诊断独立controlsocket；main默认注入/真实关闭；旧测试注入迁到显式testing；实际链必需的阻断问题。

**暂停新增：** Swift/NSOpenPanel/source GUI、更多设置面板、复杂source clear管理、多来源账户/命名profile通用支持、泛诊断导出、材料性能优化、4 MiB新轮回归。既有修改保留，不还原别人的工作；已在最小共享依赖上的修复只做到可安全冻结，不借机扩展。后续完整Goal仍要交这些相关功能，但它们不应阻塞第一步。

**需要调整：** 当前source.prepare→apply→read.prepare→apply可以在内部复用，但不能让用户经历两次确认。connect在一次确认前展示最终来源＋项目权限；确认后内部串行完成且始终绑定所确认的同一候选/owner/项目。任何变化需拒绝，不自动换来源后继续。中途失败如实说明未连接/未授权，不伪装原子成功；再次同命令可恢复，不能要求用户修JSON。

## 仅第一步的执行包

### P1-CONNECT：一个owner交付CLI到可读取状态

**用户问题：** 已配对但不知道怎样把原Codex会话接进Ash。**可见结果：** 一条命令、一次确认后，Ash能发现获准来源；没有技术配置操作。

建议由原source作者保持单owner：新增`packages/device/src/setup/connect.ts`及`test/connect.test.ts`、`test/connect-main.test.ts`；窄改`cli.ts`、`setup/read-source-settings.ts`、`service.ts`、`material-ipc.ts`、`native-verification.ts`、`shell-status.ts`、`main.ts`及其对应测试。discovery如确需改变，仍原source owner串行；不动native性能addon/control transport、Core UI或Android。

实施次序：

1. 先冻结现有backend必需部分，明确正常默认main怎样在**无control grant/无control runtime**情况下配置并读取已有saved source；按“只读来源/范围变更”与控制变更分别判断相关busy/unknown，保留相关操作排空和current，不为只读配置要求先获得控制能力。
2. 实现connect入口：读取既有配对，自动复用当前可用助手；若助手未运行，由同一命令以既有配置安全启动/连接。可先以前台维持电脑连接并清楚提示需保持窗口，不能额外要求run命令，也不在此新增登录服务安装。避免两个main抢同state，IPC缺失不能假定没有活进程。
3. 自动来源路径必须完成：优先复用已验证source；无source时内部识别受支持安装/default home及既有可信连接。若普通原客户端仅stdio、没有已配置共享endpoint，不能要求用户手建daemon/socket；利用已有独立saved-history读取能力补出受限自动连接路径。任何新增初始化可能创建/迁移原数据库的问题必须内部解决并验证，不静默改用户原home，也不把共享桌面控制改造设为读取前置。
4. 对第3项若现有代码不能形成安全实现，作者仅做一轮定向隔离验证，交“哪条现有连接/配置识别可用、是否有文件副作用、最小所需hunk”的结论后由Astra决策；不得再扩一般daemon/安装平台研究。结果必须通向普通默认来源成功，单留source_required报错不是功能交付。
5. 预览实际来源、唯一配对设备、获准项目和只读动作；一次确认后沿现有service写source/v3scope。不要为命令重用而另建正文账本、配置数据库或泛RPC。已有相同来源/范围再次连接不无故换source_id或撤已确认权限。旧read-scope命令不得再给出写了无效v2仍“成功”的误导，可转现有有效后端或明确迁移到connect，不重建另一授权路径。
6. 保存后实际有界读检查、gateway/配对状态验证；连接与读取都成立才提示可在Ash查看。未授权项目不读取；无可用会话时准确区分“连接成功、此项目无已保存会话”与失败。整个过程零turn/start/steer/create。

**P1验收：** 当前机器的生产构造＋真实临时原生历史来源＋真实已配对传输；从无source/runtime手工配置状态运行正常命令，只有一次确认，最终实际list/read；取消零授权变化；无control runtime仍成功；来源变更不继承同cwd旧scope；同命令重开、连接断开及错误提示可恢复。记录用户动作数和真实耗时，不靠测试专用factory或直接写JSON预设成功。

### P2-ASH-READ：同一成果在正常Ash验证

**用户问题：** 命令说成功，但手机是否真能看到自己的会话。**可见结果：** “电脑”入口展示该来源，原会话消息可读、刷新与重开正常。

P1 backend接口冻结后，由原Core/UI owner仅负责`packages/core/test/collaboration-read.test.ts`、真实链fixture及已有desktop-work端到端测试；若发现实际阻挡，才精确交`packages/core/src/collaboration/read-service.ts`、server/net/desktop-work/store的对应hunk。不先授界面重做、控制或材料改动。Core/Android UI生成物只用原build；APK安装/真实设备操作在具体产物和测试步骤准备后由root核已有授权。

先开发层跑默认CLI→实际Core配对链→正常Ash页面，证明不是mock endpoint；再用受支持原Codex保存历史与实际Ash客户端完成最小用户验收。若当前只能浏览器，报告“开发层通过、手机待验”，不能宣布第一步交付。未经授权不自动在用户Codex发新模型任务；刷新可用用户已产生的最新保存消息或受控真实历史样本证明。

已核现有测试的证据边界：`core/ui/test/e2e/desktop-work.spec.js`以`page.route`直接返回endpoints/read响应，`core/test/collaboration-read.test.ts`使用FakeGatewayLink；保留作UI/DTO回归，但不能充当真实传输闭环。P2新增最小整合须复用正常页面且不拦截这两条API，连接真实Core→gateway→ClientLink。任何仍用合成历史或桌面浏览器的结果，分别注明原用户历史、实际手机仍待验。

**P2唯一实际派发方案：** 单owner `ash_read_chain` 只新增`packages/core/test/fixtures/desktop-read-chain.ts`与`packages/core/ui/test/e2e/desktop-read-chain.spec.ts`。复用`packages/core/ui/test/remote-approval-gateway.wrangler.jsonc`及其probe的fresh loopback worker/签名配对范式；在独立临时目录安装固定wrangler 4.143.0，独立持久目录、测试bootstrap及身份，限定127.0.0.1。使用真实startOwner/startDevice/default ClientLink和固定Codex临时synthetic realm；正式Ash shell经Core、gateway和真实配对传输读来源，不mock两API。不得改production、package/lock、现有P1 mutable文件，不部署或改用户owner。P1冻结前可准备安装、worker和配对fixture，不运行mutable后端链。

最小通过标准为页面“电脑”→正确来源/范围→核临时真实历史消息→源更新后刷新→关闭重开→未授权项目不可读→电脑断连显示缓存/离线并正常恢复，且零模型任务。记录各步骤耗时及网络链实际身份，清理自有进程/临时目录。真实临时Codex、真实gateway与正式页面通过仍只算开发层；随后使用用户已配对设备与原历史验第一步，不重做配对。Root只读确认本机已有电脑配置和pair、尚无read source/grant；未更改真实授权，因此真实验收仍可从正常connect零source状态开始。

P2准备已有实际进展：两新增文件静态bundle通过；临时wrangler 4.143.0安装完成；独立gateway 0.5.0 Worker在127.0.0.1:60597实测health为fresh/unclaimed、owner_id=null、owner offline、bootstrap configured，随后关停清理，无claim或P1 backend调用。正式链待P1冻结后另起fresh实例。作者静态发现电脑离线可能因endpoints过滤而被界面误判为撤权；保留真实device断开/刷新/恢复用例，先取DOM/API证据，不换成浏览器断网来避过。若成立只授修复该用户状态的最小hunk，不提前重做UI。

首次严格P2实际运行30.6秒：正常shell→fresh worker签名配对→Core APIs→默认ClientLink/main→临时固定native source，消息与turn/message/native IDs、未授权cwd读取403、新增刷新及正常重开均通过；真实device断开后普通刷新显示“读取范围已改变或已撤销”，随后显示没有电脑并清缓存，恢复断言尚未执行。因此整条仍红。产品不允许将离线误称撤权，也不以浏览器断网替代。已建议复用原target/revision的受保护read API区分offline与permission_denied；必须在删除性cache reconcile前判断，确证revision变化/撤权仍清缓存，离线保留选择及明确旧缓存。具体最小UI hunk待root授同一owner，不新增协议或同步系统。

随后root授同owner仅`desktop-work.js`最小hunk及原gen-ui：延后删除性reconcile、缺失目标经原revision受保护read分类，store未改。原严格test曾作者通过，test8.9秒/总14.7秒；Astra当时亲读API证据，endpoints为1→0→1、恢复items2、最终DOM已同步且4条消息。**随后root独复30.2秒失败，P2整体不接受**：重连后endpoints仍0，read permission_denied且缓存清除（`/tmp/ash-root-read-chain.log`）。UI窄独审通过不证明后台恢复；唯一owner仅诊断真实reconnect manifest/source/grant，最小后台hunk另授，禁止retry/增超时/弱化断言。普通同身份同来源重连不应要求重新配对或授权。原test-results会被后续PW清理，后续成功证据须复制到稳定docs evidence，不能依赖短暂路径。

真实用户验收另须核交付入口版本：Astra只读确认当前`~/.local/bin/ash-device`转发到`~/.ash-device/current`的10月8日旧`0.1.0-local-37af412-2id5gbdu`安装；该bundle未检出本轮connect提示字串。不能直接让用户运行旧安装并假设包含新功能。应先准备当前代码的可运行产物并说明实际命令；任何真实安装/替换与运行中助手交接按root核定授权执行。此检查未改用户安装、配置、pair或read授权。

Root当前`build:device`已exit0并生成新产物，仅build；未替换用户service/config/grant，不能把构建成功记为实际安装或真实可读。

恢复红的后续定向检查：单次诊断绿不能解释原失败，不据此接受。Root静态发现read-service manifest将ensureSource的offline/stale/draining也记为scope_required并缓存同receipt，后续刷新不再实际验证；已授仅单元红复现。Astra批准的最小产品语义：真实binding/授权不符继续拒绝，暂态失败不永久记为撤权，下一次普通用户刷新重新实际验证；不内部无界retry、不增TTL、不加设置或后台恢复平台。该hunk定向验收后必须回原严格P2，再决定开发层接受。

首个暂态manifest也不能伪装成撤权而清缓存。允许在当前真实owner/授权snapshot仍有效时保留“范围已设置”的ready，来源runtime_availability为unknown，且不缓存来源失败；ready不表示已在线或已读验证。仅明确ReadSourceError暂态可如此分类，非法descriptor、真实source/binding mismatch、owner变化/撤权不适用。实际call仍fresh ensureSource，暂态不返回正文；当前owner/授权仍成立时stale可归offline并使下一次普通刷新重新验证，明确binding mismatch仍permission_denied。connect输出成功始终依赖实际读取检查，不能由此降为仅看manifest ready。

### 下一步：现有电脑轻量交接与真实用户确认

Astra只读核实原LaunchAgent `ai.ash.device`正在运行，PID616，KeepAlive=true，使用`~/.ash-device/current/bin/ash-device run --config ~/.ash-device/device.json`。因此不是缺少配对或安装，而是需把已有服务切到本轮产物；不新做GUI、重配对或另建助手。

Root准备本机package并核archive/bundle/helper/addon。交接方案为先解包唯一版本目录及无状态启动检查，记录旧current与原plist和敏感状态的私有一致性指纹；在真实交接授权范围内bootout旧job，有限等待原PID结束，再原子切current、bootstrap同一plist并核新PID/IPC/gateway就绪。失败仅回滚current与service，不复制回旧pair/grant或覆盖用户配置。不在KeepAlive下仅kill，也不同时运行新旧两份。此处是方案，尚不等于已执行安装。

读取范围由用户在自己终端运行`ash-device connect codex --project /Users/ahaha/work/xiebo/ash`并亲自确认，Root不得代答yes。确认前不得写read grant；既有pair/config继续沿用。随后实际Ash核“电脑”入口、原会话ID/消息、正常刷新/重开及断线恢复；手机现有Core/UI版本仍需实际核实，不能以电脑服务升级成功替代手机交付。需要实际用户动作时给已准备好的这一步，不把socket/JSON或内部安装细节甩给用户。

## 第二步：手机给已有Codex会话发指令并读回回复

**第一步真机收口。** 用户已确认手机读取10轮消息成功，并明确要求继续开发发送。该结果证明真实已有配对、电脑连接助手、原saved source及手机读取入口可用；不证明控制授权或桌面owner入口可用。

**最小用户流程。** 用户在当前已有会话输入一条指令并点发送，立即看见待发送；目标电脑确实接收后显示已送达，随后刷新读到同一原会话的用户输入及Codex回复。空闲开始下一轮；运行中仅在已证明active turn时补充到该轮，不打断工具。会话/native ID不能改变，不新建替代会话，不用独立历史reader充当原桌面执行者。发送回执与最终回复分别显示；unknown不自动重发，按现有operation/request ID查询和核对。

### 实际阻挡与产品裁定

Astra只读核实真实`~/.ash-device/state`已有read grant，但没有`collaboration-control.json`或`collaboration-control-runtime.json`；默认Codex home未发现标准控制socket。原桌面PID1837是stdio app-server，另有PID6268 stdio实例，Ash历史reader PID60395也是独立stdio。PID只是本次快照，不可当未来控制配置。DesktopControl UI/S4/state/apply/query/reconcile代码已有，无ready grant时不开放发送。当前缺的是可信同owner连接及显式发送范围，不能仅亮输入框或自动继承read grant。

复用既有已验证共享daemon＋桌面显式`CODEX_APP_SERVER_WS_URL`＋S4路径，完成有限的生产连接助手；不重研究外部控制协议，不把材料H3 work-source/proxy或通用GUI作为纯文本发送前置。现`HostSupervisor` production inventory始终为existing_engine/ownership_unproven，replaceable=false，不能作为“已有可用安装器”直接开启。单独设置USE_LOCAL_DAEMON已在旧研究失败，不再重复这条切换。

显式WS入口会跳过原桌面工厂部分登录/插件配置覆盖，既有同owner证据不等于全部原能力保留。连接助手必须先准备固定版本、原CODEX_HOME、实际socket/owner、桌面启动参数和关键原能力兼容检查及回退。未知时先报告具体缺口，不能复制凭证、假配置、改源数据库或另起并行engine绕开。真正切换桌面会影响本任务所在Codex，待可审查方案与代码/隔离验证准备后，由root核已有授权并安排一次明确关闭重开；本节不执行真实重启或写控制配置。

### 最小串行交付包

1. **S2-A 同owner连接入口。** 原native/control owner单独负责新的`packages/device/src/setup/connect-control.ts`与`control-runtime-settings.ts`及对应测试；先复用`control-runtime.ts`的固定config/实际listener校验和已有daemon生命周期证据，只在必要时由root另授main/CLI/固定私有setup IPC的精确hunk。自动定位受支持安装与原home，生成受保护runtime配置；用户不手填PID/socket/JSON。原GUI/其他stdio owner仍活跃时只能准备交接，不另起执行者。来源与owner验证必须包含GUI实际属于该共享服务、目标原native ID可核，不能以saved thread/read存在性代替。先给一条可执行的有限方案和临时fixture，再做具体环境交接，禁止不断增加通用host平台模块。
2. **S2-B 一次发送范围确认。** 同owner接现有ConnectionSetupService control prepare/apply及native verification，不新建授权系统。选择要控制的现有WorkRef；首条验收使用实际schema的`single_work`单会话范围，若未来面向整个ash项目则另明确显示exact_cwd及send_input/steer动作，不能从read grant暗授。原owner、目标、原生接口或范围变化要重新核对；慢确认不得消耗短事务deadline，取消零授权变化。连接就绪与grant就绪分开报告。用户一次确认后，普通Ash刷新应自然出现已有发送控件；不要求重新配对或重启手机。
3. **S2-C 正常发送与回复整合。** 在A/B接口冻结后，唯一Core/UI owner负责新增真实链fixture/spec，复用`desktop-control.js`、net、Core控制接口及原S4，默认不授UI重做或新队列。遇实际阻挡才授对应hunk。路径必须是正常手机页面→真实签名配对/gateway→默认ClientLink→同owner native控制→现有saved-read回收回复，不能mock API或只证明外部client自己开的任务。

### 阶段验收与止损

- **连接门槛：** 同原home/原native ID，同一共享owner；GUI没有偷偷回退stdio或另开第二engine。现有登录、关键原工具与原会话可继续；如需切换先具备回退，未证前不能广告send ready。只读链持续可用。
- **发送门槛：** 手机一次点击造成一次native turn/start，或运行中精确expectedTurnId的turn/steer；桌面同会话出现输入及最终回复，手机按原生ID读回并合并待发送记录，不按文本相等推断成功。首条真实输入采用用户审阅/发出的具体指令，不向业务会话自动发探针。
- **失败门槛：** 发送前离线准确待发送；提交后回执丢失为unknown并查询、不重放；撤权/跨work/过期拒绝；普通重连能恢复同请求核对，不让用户修配置。只验证本次必要场景，不为首发扩新材料/GUI平台。
- **开发层先行、真机收口：** 固定native临时同owner与正式页面真实链通过后，用户手机在已选原会话发一条指令，电脑处理，手机刷新看到对应回复，才记第二步完成。源码单测、独立reader模型调用、临时双外部client互控均不替此结果。

Astra主动监督每包是否直接解锁上述用户步骤。当前必要工程取舍由团队解决；需要用户实际关闭桌面或确认控制范围时，只提交已准备好的具体动作，不让用户选择socket/proxy实现，也不因此转做无关功能。完整Goal的新建、材料、双向结果及普通安装生命周期仍保留，分阶段交付不缩减最终范围。

### S2-A已落代码的产品审查边界

Astra已直接读`connect-control.ts`与`control-runtime-settings.ts`。方向未偏离：仅单会话send_input/steer，一次确认前释放展示lease，确认后重核pair/目标，复用现有setup prepare/apply，取消不写，不自动发送、resume或启动daemon。`authorized`仅描述保存控制范围，不是输入已送达；partial/unknown保存也未伪装成功。本轮可报告“控制接入后端已落”，不能报告“手机发送已交付”。

`captureLoadedControlWork`实际证据只有指定listener、该listener上loaded的native ID、metadata cwd与目录身份；其中owner_id是Ash配对owner，**不是GUI归属证明**。不能将connect模块注释/错误中的“original shared owner”理解成已验证当前GUI。后续真实接入必须证明桌面GUI与该服务同owner；未经此证据，loaded/list或grant authorized均不足以宣称可控制原桌面。

S2-A初审时main/CLI/固定IPC尚未接这两个新模块，runtime settings仍接内部candidate，connect仍要求既有受保护runtime文件；当时真实机器无控制socket/config的用户阻挡尚未消失。后续按下节接可信原生candidate生产者及必要入口，再做同owner交接与发送链，禁止增加泛设置页面/后台平台。候选不得来自手机自报PID/socket；用户确认应显示能识别的会话标题/项目并保留native ID核对，不让普通用户靠复制UUID配置会话。

### S2正式入口本轮限定：项目、编号、一次确认

本轮root独占service/main/固定私有IPC，Sol独占CLI及默认candidate模块；不并写、不新增通用设置。普通命令收敛为`ash-device connect codex --control --project PATH`，当前处于开发验收，尚非已交付使用说明。命令内部从可信候选发现连接，并列选定canonical项目的已加载会话“编号｜标题”；最近时间或短ID可帮助同名会话核对，但用户只选编号，不输入UUID/PID/socket。无标题显示“未命名会话”。编号绑定本次冻结的WorkRef与项目快照，后续不重排后复用、不按标题匹配另一个会话。

用户选编号后仅一次确认单会话send_input/steer权限、项目及替换旧控制范围；确认等待不占apply短事务期限，确认后重新核原pair、物理项目/目标及listener。取消不写权限，不触发模型。读/控授权保持独立；本机native loaded列表用于选择，不必新增read grant作为control后端前置，若复用远端saved-read列表则仍遵循原读取范围。

缺少可信共享连接时，命令只指出连接尚未完成和下一项具体接入动作；不得让用户手写内部配置。目标未加载可指引在原桌面打开该会话，不可自动resume制造“已加载”。配置saved、grant authorized或loaded/list通过都不足以报告“原Codex可发送”：还要完成原GUI同owner验证。尚欠该验证时明确显示“控制权限/配置已保存，原桌面接入待验证”，不得以模糊成功提示或输入框可见替代ready门槛。

本轮结束前只验正式入口的编号映射/一次确认/取消/同目标重核及真实私有IPC接线。接着准备共享daemon与GUI的一组有限切换步骤，核原home、原会话、关键原能力、停止/回退与当前任务影响；再进入手机同会话发送→回复闭环。不得由此扩为GUI设置中心或重复研究已知控制协议。

### 共享daemon连接助手：本次最少交接与兼容门槛

参考既有`build/research/daemon-switch/RECOVERY.md`和已验显式WS入口，复用成功路线及恢复方式；历史`restart.py`的15秒自动退出不是本次产品行为。当前Codex承载活跃开发，助手不得自动quit、强杀或重启它，不把旧次重启授权推断为此刻可以中断任务。

**用户步骤只保留三段。**

1. 助手先prepare：核固定安装版本、原canonical home、当前原桌面owner、可信daemon/socket及必要兼容信息，生成可执行helper、去敏状态说明和恢复入口。此时不退出GUI，不发模型、不写发送grant，也不启动并行控制owner。缺什么应给具体原因，不能回用户填写PID/socket/JSON。helper在离开本Codex后仍可从外部终端运行。
2. 准备完成后明确告知用户先保存输入、等待任务结束并正常退出Codex，再执行已准备的helper。helper核原桌面owner确实退出；不按进程名批量结束其他Codex/CLI，不把Ash已知只读metadata child当原桌面控制owner。归属仍有歧义则准确停止。复用符合证据的现有daemon或启动一次，完成固定版本/listener及只读握手就绪检查后，才通过已验`CODEX_APP_SERVER_WS_URL`一次启动环境打开原应用。只用USE_LOCAL_DAEMON的旧失败路线不再重复，不写全局launchctl/shell环境。
3. 桌面打开后验证GUI确实接到同一个服务、所选原会话/native ID属于该服务及关键原能力正常，再回既有项目→编号/标题→一次send/steer确认。GUI打开、daemon ready、loaded/list或配置保存任何单项都不能提前称“原会话可发送”。最后由用户手机在选定会话发实际指令并读回复。

**本包兼容验收只覆盖实际阻挡。**

| 项目 | 必须看到的结果 | 不合格时 |
| --- | --- | --- |
| 原身份与历史 | 固定版本、原home、项目和原native ID，原会话仍可见 | 不复制home/auth/历史，不创建替代会话 |
| GUI归属 | GUI真实连接相同listener/服务；没有原桌面回退成另一个stdio owner；原会话归属可核 | 仅“连接待验证”，不能ready；不resume制造loaded证据 |
| 原有登录 | 用户原登录仍有效；不要求重复搬运凭证 | 如真实需要登录明确说明，不能输出/复制auth |
| 必要工具与插件 | 原启用、与当前使用有关的内建工具/插件元数据状态保留；明确验证WS绕过原factory覆盖的影响 | 具体列缺项并停在不兼容，不静默禁用插件换取green；不扩全部插件矩阵 |
| 第一次手机输入 | 用户那一次指令只产生预期原生turn/item；桌面与手机同会话可读回输入/回复 | unknown只查询核对，不重发，不另加业务探针 |
| 恢复 | GUI可正常退出后以不带WS环境的原启动方式恢复；配置/pair/read授权保留 | 不强停active/unknown daemon，不回滚用户产生的历史或授权 |

恢复入口必须在切换前可执行：正常退出本次GUI后，按原应用路径不带环境打开。若要停daemon，只能在当前归属及任务确实idle可证时停止本次助手管理的实例；任何active/unknown保持运行并说明原因。helper重复执行应识别已接入的同一服务，不再开第二份或强迫重新授权。状态报告不含凭证或原会话正文。

本轮交付是有限可执行helper及其恢复、隔离验收、随后具体用户交接；不承诺永久替换普通桌面图标，不新增开机GUI平台。普通图标/升级等完整生命周期仍保留在最终Goal，不能靠本次一次启动成功宣告全部安装完成。上述为切换前计划；2026-10-11用户已外部重开，本轮实际结果见文末。

## 唯一第一阶段交付判据

- 用户一条connect命令＋一次范围确认，不手写内部配置；已有配对/安装前提明确，自动来源连接没有藏人工步骤。
- 实际Ash点“电脑”看到正确设备/来源与获准项目的既有会话，打开后显示对应真实user/assistant消息；ID与原来源核对，不能仅标题相似。
- 按需刷新能显示源中新增的已保存消息；关闭再打开仍进入同一范围，缓存有时间/新鲜度标识。
- 未授权项目不可见/不可读；撤权后不返回旧结果。电脑离线显示离线及旧缓存，恢复后正常读取，不需要重新编辑配置。
- 输出真实操作步骤、耗时、结果和剩余限制；局部测试数量与旧68%不作为通过依据。

Astra在每次派发/验收检查上述用户结果。不能改善或解锁这些结果的工作立即暂缓；遇失败先提出一个具体阻挡假设、有限验证和最小修复，再回用户链，不连续追加外围模块。纯技术方案由团队解决；只有确实改变产品范围或必须真实登录/权限/安装等用户动作时，准备具体内容后再提交用户。

## P1已授权裁定与监督点

Root确认后，P1按上述用户闭环授权原source作者实施，不再将缺control/shared daemon当只读的用户前提。source/read-only reservation只阻相关读取请求、当前来源原始工作及实际变更竞争；不依赖control/create safe来批准只读范围变更。控制/材料的既有安全门槛保持原职责。

自动来源首选原已运行、固定受支持Codex进程的真实main executable/UID及唯一opened SQLite REG FD，保留home canonical/config、artifact和owner current证明；默认原客户端只有stdio也必须能完成。内部产生saved-source descriptor后，独立metadata stdio只用已确定的existing root，不冒称原桌面控制，不创建新home/空库。外部root无endpoint时也须由原PID实际FD和所选home/config连续性证明，不回到手写socket或猜root。多个有效候选必须明确选择，来源与项目权限合成一次最终授权；未知或没有运行来源可以明确提示“打开Codex后重新连接”。

技术实现仅允许一轮定向fixture验证后收最小方案，由Astra审是否直接解锁这个步骤；不把全体安全helper重构放进P1。作者须同时报告普通stdio/no endpoint的来源证据、一次确认调用链、无control的实际main读取及剩余失败点。Astra保持跟进，发现额外GUI、daemon安装或与该步骤无关的重构立即暂停扩张并向root说明。

P2正常UI真实paired链等P1冻结后再交原UI owner。现有页面“运行状态未知/控制不支持”的技术文案不是本轮重做理由；先验实际可读用户链，若确实误导读成功状态再作最小文案修正，不提前mockclaim。

### 连接成功后的发现传播也是P1门槛

connect成功不仅是本机授权写入。默认Link提供的新read capability与authorization revision必须经正常配对链被Ash读取，用户在“电脑”正常打开/刷新即可发现；不能要求重启助手、手动调用manifest或执行第二条命令。源/范围变更后旧revision不能继续返回历史，重新授权后的正常刷新能恢复。Root负责核默认Link传播，Astra在作者冻结报告中检查该证据；没有这一步不进入P2用户交付声明。

Root已核现有机制足够：ClientLink的GET /ash/manifest对每次手机请求调用local.manifest，trustedContext每请求重新capture当前epoch/grant；不是只在初连推送一次的静态cache。**不新增manifest push或同步层**，只验正常refresh实际看到新cap/revision。global state变化会触发collaborationDisconnected使旧reader失效；正常链应等真实raw drain后恢复，不能通过无界retry或手动dispatch掩盖错误。

### P1监督检查点：自动来源可行，立即转用户闭环

作者报告默认stdio自动来源的一轮真实自有fixture exit0、0.70秒，无live handle：fixed actual main/UID、唯一实际SQLite FD、默认home/devino匹配；无endpoint、未另起探测源。Astra接受其为本轮可行性门槛，已要求停止研究，直接接已授权的connect一次综合确认→无control依赖read-only gate→actualmain→正常paired manifest/list/read。此时connect入口尚未实现、S1B仍mutable，不能报第一步通过。

默认来源先完成可用路径，不追加external profile、多home GUI、manifest push或daemon安装。冻结报告必须提供一次确认的正常命令、无endpoint/control配置依赖、实际list/read以及重开/未授权/离线结果；P2等此冻结后才进入正常Ash真实链验收。

### P1当前整合证据与冻结前必查

后续实现已出现connect及actualmain整合测试，但尚未冻结。Root核实`connect-main.test.ts`运行真实Codex进程和实际main/IPC/Link服务分发，手机侧为`PairedFixtureLink`且历史为自造样本；这是开发层主路径证据，**不是实际手机或用户原历史验收**。P1冻结后仍须正常已配对设备打开/刷新，并核对原来源消息。

读连接proof的有限修复持续绑定原conn/ws/ready/stopped/state及原认证revocationBinding对应的配对身份；自身source/grant写不被无关grant epoch误拒。初次capture必须核原连接binding仍等于当前pair；换pair后旧proof及重新capture都拒绝，断线拒绝。Root已复验原setup connection与新read grant/pair断言通过，不继续扩证明平台。`/tmp/ash-p1-connect-main10.log`曾单次1/1通过、2.84秒；随后root独复`/tmp/ash-root-connect-main-current.log`在3.68秒以`P1-list-code cancelled`失败，故主路径**未接受**，单次green不能证明稳定。该测试仍属真实临时Codex来源/main/IPC/Link dispatch及模拟手机传输。当前只定位并修复主路径取消的实际原因，收慢确认与unknown两项独审、清理debug并完成当前TS/定向复测；不无界retry、不扩大超时。收齐后直接进入真实Core/Ash用户链。

一次确认摘要必须来自实际configured source或本次候选，已有非默认来源不能固定显示“默认profile”；同一确认的来源、项目和pair不能在apply中悄悄改变。冷启动助手须在有界等待后确认真实连接ready，不能靠用户第二次运行碰时序。真实CLI/readline交互证据与测试注入confirm回调分别记录。

CLI独审发现确认前prepare的30秒期限会消耗在用户阅读期间；这是首用阻挡，不能当用户操作太慢。有限修复方案为确认前取得并释放展示快照，yes后才创建实际prepare/apply事务，保留原事务期限。服务重新核同一物理来源、canonical项目及原pair binding；已配置来源核source_id/binding_revision，新候选核服务派生的稳定物理/config/artifact身份，不能只比较label或随机preview ID。身份改变则明确重新确认，不静默改选、不扩大TTL或新建通用确认平台。验收须包括等待超过原30秒后同源成功、等待中换源/换pair拒绝、取消零apply。

另一项独审要求准确描述不确定结果：source已提交但响应丢失，或旧read grant已撤而descriptor保存失败，都不能仅凭客户端`await`未返回而说“未改变授权”。提示连接未确认、授权可能已变更，并可重跑同一connect重新检查/确认；不声称已连接，不要求手修JSON，也不为此新增事务账本。

取消原因的有限复现已成立：root自有临时树中，LocalStateTransaction自身write receipt即刻current，无任何外部写，40ms后仍收到`write,write,after-receipt`并令receipt失效。授权最小修仅去重已被同步commit receipt结算、且当前实际文件identity仍完全对应该commit的迟到通知；不能按文件名/内容相似或TTL忽略。普通保存后立即list/read须成功，旧请求应按实际变更失效，外部不同物理identity及未知事件仍取消。此问题直接阻挡connect，修完回用户链，不开展历史证明重构。

上述修复落地后，root独立联合own-watch两case及actualmain为3/3、3.90秒通过（`/tmp/ash-root-own-watch-main.log`）：正常list/read完整fixture成功，外部同bytes物理替换拒绝。此为针对已定位原因的修复证据，精确receipt去重hunk独审仍进行；仅待CLI慢确认/unknown、当前TS及freeze收齐后转Core/Ash链，不替真实设备验收。

Root独复现有`desktop-work-store.test.js`为7/7通过，覆盖缓存身份/权限revision隔离、刷新重新绑定、分页gap和重复cursor停止；仅支持缓存层复用，不替代正常配对/UI验收，不因此重做界面或宣称阶段交付。

## 2026-10-11真实共享连接：本轮已通过的产品门槛

用户已按准备好的外部步骤重开桌面。Root报告并核实本轮daemon PID38668、GUI PID38689：lsof显示GUI fd145的Unix peer身份与daemon accepted fd35的DEVICE一致，后者NAME对应实际canonical control socket。初始化后同服务的loaded IDs包含当前会话`01a10ace-3acd-7f93-92be-239c49555b84`。本次结论同时依赖实际GUI连接对应与当前会话加载，**不是由loaded/list单项推断GUI归属**。PID/FD仅是本轮观测，不得写死为未来可信配置；重连后仍须当前校验。

据此接受“本次原桌面已连接同一共享服务”门槛。不能外推普通图标永久兼容、所有插件/工具完整兼容、控制范围已授权或手机发送成功。本子任务只记录root的真实证据，没有执行桌面重启、模型输入或授权写入。

实际managed release可执行文件与同捆binary的SHA相等，但物理路径不同；逻辑control路径为符号链接。CLI owner仅修可信发现对这两个实际形态的适配，保留canonical socket、实际listener/PID、固定binary/version及当前性验证；不能为方便接受任意路径/同名进程，也不因此重构控制平台或重开协议研究。

**下一步授权边界固定。** 只向用户请求当前ash会话的`single_work`控制确认，动作限send_input/steer；显示当前项目和可识别会话名称，编号选择绑定原WorkRef。不得默认为整个ash项目、所有已加载会话或create/cancel/材料权限。用户手动重开只完成接入，不替代这一次明确范围确认，Root不得代答yes。

CLI发现修复与当前接口验证通过后，由用户确认该单会话范围；再在手机同会话发一条明确指令，核原native turn/item、桌面处理与手机读回回复，才接受第二步发送闭环。消息送达与完成仍分别报告；未知回执不盲目重放。无需新增GUI设置或无关研究包。
