# 共享 App Server / daemon 隔离验证方案

2026-10-09。**方案准备，未执行。** 用户当前只授权准备方案及必要只读核查；启动服务、配置变更、桌面重启、模型消息均未获执行授权。背景证据见 [控制入口研究](CODEX-CONTROL-RESEARCH.md)。

## 目标与判据

验证顺序是：共享协议可连接 → managed daemon 的状态确实隔离 → 桌面确实使用同一服务 → 外部客户端能给该桌面拥有的隔离测试会话追加并得到可核对回执。两个外部客户端成功连接同一 server，不能记为桌面既有会话控制成功。禁止通过 resume 真实会话来补齐 owner、复制 auth/config/历史、写源数据库或另启执行者冒充。

采用桌面随包 CLI `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`（本次 `0.162.0-alpha.17.2`），不用 Homebrew `0.154.0` 代替。执行前重读版本与 help 以检测升级。

## 本次只读核查

- `app-server --help` 支持 `--listen unix://PATH`；`proxy --help` 支持 `--sock PATH`，描述为代理 stdio **字节**。
- `daemon start/stop/version --help` 未暴露显式 socket/PID/log 路径参数。不能仅凭 `CODEX_HOME` 就保证所有系统管理状态、锁或后台 PID 完全隔离，因此阶段 A1 不调用 managed daemon。
- 桌面安装包 `application-network-startup-CfAQmSYg.js` 的 `resolveCodexHome` 使用子进程环境 `CODEX_HOME`，否则使用 OS 用户的 `.codex`。daemon 分支要求 macOS/local host、无附加配置覆盖、`CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`、未设置强制 CLI、无显式 CLI/runtime 覆盖、daemon version 兼容；不满足则回退 stdio。这不是公共配置承诺。
- 先前默认控制 socket ENOENT。`bootstrap`、`enable-remote-control`、`restart` 都不是本实验的必要动作，明确排除；不使用 launchctl 全局变量、不安装持久服务、不开放 TCP 或远程控制。

## 阶段 A1：限定测试目录的共享协议预检

**下一次推荐仅执行本阶段。** 使用新临时 `CODEX_HOME`、显式 Unix socket、临时 cwd、临时日志，以及前台进程的精确 PID；当前桌面保持运行。它是共享 server 协议预检，名称不称 managed daemon 验证。

以下是待批准命令模板，**本次没有运行**。执行器应以结构化 spawn 参数和最小 allowlist 环境实际启动，避免继承 provider key、远程连接、CODEX 覆盖和业务 MCP 环境。保留 PATH/TMPDIR/必要系统 locale；`HOME` 仍是 OS 用户目录，不重定义 `$HOME`、`$CODEX_HOME` shell 变量；`CODEX_HOME` 只在目标子进程环境传入。该隔离限制数据与监听地址，不是 OS 文件权限沙箱。

```sh
umask 077
ash_test_root=$(mktemp -d '/tmp/ash-cx.XXXXXX')
ash_test_home="$ash_test_root/codex-home"
ash_test_socket="$ash_test_root/control.sock"
ash_test_cli='/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'
mkdir -m 700 "$ash_test_home" "$ash_test_root/work"
chmod 700 "$ash_test_root"
if ! python3 - "$ash_test_socket" <<'PY'
import sys
if len(sys.argv[1].encode('utf-8')) > 100:
    raise SystemExit('Test socket path exceeds 100 UTF-8 bytes; do not start server.')
PY
then
  exit 1
fi
touch "$ash_test_root/server.log"
chmod 600 "$ash_test_root/server.log"
cd "$ash_test_root/work"
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  CODEX_HOME="$ash_test_home" \
  "$ash_test_cli" app-server --listen "unix://$ash_test_socket" \
  >"$ash_test_root/server.log" 2>&1 &
ash_test_pid=$!
```

仅新建测试目录并启动此进程，不把原目录内容放入其中。不读取或导出 account 信息。若未登录导致初始化或读取被拒绝，记录错误并停；不自动登录，不尝试现有认证复用，不配置替代 provider。

两个测试客户端只直连 Unix socket 做 HTTP Upgrade，再使用 WebSocket 文本帧 JSON-RPC；A1 不测试 proxy。`proxy --sock` 是字节代理，后续如使用，不可假设其 stdin/stdout 自动变成 JSONL。客户端本次只计划编写，不执行。

允许的方法白名单：`initialize`（不同 client name、版本）、`initialized`、`thread/loaded/list`。每次请求超时 5 秒，进程启动上限 10 秒，总测试上限 30 秒。禁止 `thread/start`、`resume`、`turn/start`、`steer`、`interrupt`、账户、配置或历史正文读取。无订阅或写方法，不需要模型调用。报告及客户端摘要只保存版本、请求方法/ID、结果类别与 loaded 数量，不保存私密正文。模板中的 server.log 是服务原始 stdout/stderr，仅用于测试目录中的临时诊断：目录 0700、文件 0600，不展示或外传原始内容，退出清理时删除；不能宣称原始日志已过滤。

检查 socket listener PID 与精确 test PID 相同；两个客户端握手成功并分别得到请求 ID 对应回复；loaded 列表预期为空。两个空列表只能证明共享 listener 和只读协议可用，不能证明跨客户端共享某个活跃 thread。可在未来另获授权后创建一个**无模型输入的空测试 thread**验证跨客户端 loaded 可见性，但该动作不包含在推荐 A1 范围内。

成功记录 A1=pass，不提升桌面控制能力。socket 路径在启动前按 UTF-8 校验不超过 100 字节，失败即停止；任一配置/认证错误、地址冲突或版本差异也停止，不自动扩大权限或改路径到真实 home。

退出：先关闭两个客户端，再向记录的精确 test PID 发 TERM、有限等待，仍未退出才对同一已验证 PID 发 KILL；不使用 `pkill codex` 或按进程名批量结束。确认 socket 无 listener；保留去敏摘要，删除原始 server.log 及此次 `ash_test_root`，先核对目录前缀与创建记录，禁止根据可篡改 socket 路径删除。原桌面无需恢复，因为未变更。

## 阶段 A2：managed daemon 自身隔离验证

单独授权后才开展。先静态核对当前随包 CLI 对 `CODEX_HOME` 的管理路径、锁、日志和 PID 行为；若不能证明不会写真实 home 或系统持久管理状态，不执行 `daemon start`，维持 A1 结果并报告限制。必要时使用单独 OS 测试用户，而非承诺当前用户里空 home 等于完整系统隔离。

通过前置核查后，使用另一全新临时 home 与临时 cwd，在最小子进程环境下调用同版本 `daemon start`；随后 `daemon version`、`proxy --sock "$ash_daemon_home/app-server-control/app-server-control.sock"`，仅执行 A1 白名单。命令模板如下，变量代表新测试 home，不代表真实 `.codex`：

```sh
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  CODEX_HOME="$ash_daemon_home" "$ash_test_cli" app-server daemon start
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  CODEX_HOME="$ash_daemon_home" "$ash_test_cli" app-server daemon version
```

后台 PID 必须通过新 socket listener 和可执行文件/cwd 元数据定位并记录，不能信任旧 PID 文件或锁文件。日志/PID/锁实际路径必须都在测试范围；存在越界副作用即停止，记录真实范围，不假称完全隔离。不得读取全量进程环境或可能含凭据的启动命令；使用受限元数据。

清理只对同一个测试 home 调用 `daemon stop`；确认该测试 listener 和记录的 PID 消失，而真实桌面进程仍在。stop 失败时，重新核对 PID 的可执行文件与 listener 归属后精确结束。没有启动 bootstrap，就不应新增 LaunchAgent/持久启动项；若实测出现该副作用，必须报告并给出具体恢复项，不自动删系统服务。

## 阶段 B：证明桌面采用同一服务

本阶段不能由 A1/A2 成功代替。当前安装包默认走 stdio；接入需要桌面启动环境和所有选择条件满足，并且存在兼容 managed daemon。不能假定打开 `open -na` 就获得独立实例、独立全局 store 或合法 peer 身份。

**优先路径是单独 OS 测试用户中的正式安装桌面**，其 home、桌面全局数据、任务和凭据与正在工作的账号分离；是否能够启动并登录该实例需用户选择。临时 `CODEX_HOME` 仅隔离 Codex 数据，不保证 ChatGPT/Electron 全局状态隔离。不得复制现有登录或把用户真实配置迁入测试。

若用户选择在当前 OS 用户下验证，需明确授权停止当前桌面并在无活跃工作的窗口重启；关闭前人工确认任务已结束/可停止、保存未提交输入和产物。不得在 agent 仍执行本 Goal 的当前会话里贸然退出自己。先记录恢复的原启动路径和临时启动参数，环境只作用于一次启动，不用 `launchctl setenv`、shell profile 或永久设置。

在允许的测试桌面启动方式已核对后，由受控 launcher 仅向该 app 实例传 `CODEX_HOME=<测试home>`、`CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`，避免设置 `CODEX_CLI_PATH`（这会使已知 daemon 条件失败）。**具体 GUI 启动命令待核对当前 app 的单实例/环境传递行为后确定，不提供未经验证的“一条重启命令”。** 日志中若存在隐私内容，只读取白名单诊断字段或原地计算摘要。

归属证据必须同时具备：桌面与外部客户端连接相同命名 socket；socket 服务 PID 为 A2 确认的 daemon；桌面启动后没有为该 host 另开 stdio owner；桌面 GUI 中用户主动创建的空测试会话，其 ID 出现在该 daemon 的 `thread/loaded/list`；桌面呈现与服务状态一致。不靠已有历史 ID 相同或 thread/list 能列到来判定。

没有 GUI 空会话 ID/loaded 可见性或无法合法取得限定诊断时，B=inconclusive，不能用 resume 補做。任何条件不满足、桌面回退 stdio、共享 app store 冲突或意外触及真实会话，都停止 B；不继续 C。

恢复：退出**此测试 app 实例**，停测试 daemon，核对精确 PID；撤销一次启动环境（子进程结束即失效），由用户以正常图标重新打开原桌面。若当前账号被退出，则原桌面重新启动后验证原项目、历史和控制流程；测试 home 保留或删除由用户决定，不删除原 `.codex` 或 app store。若采用单独 OS 用户，不操作原账号桌面。

## 阶段 C：隔离消息追加及回执

仅 B 通过且用户另行授权测试登录、模型调用及潜在费用后执行。用户完成测试实例登录；不读取、复制或输出 auth。模型/provider 由用户测试账号选择，不假定现有订阅/额度/登录自动复用。

用桌面 GUI 在测试 cwd 创建专用会话，发送明确测试请求，让它进行短时间可观察的只读等待；不得启动上传、下载、发布或业务任务。外部客户端只控制此 GUI 已拥有会话；先取得可靠 active turn ID，再发送一条唯一测试标记的 `turn/steer(expectedTurnId)`。测试请求及追加文本提前给用户审阅。

验收：steer 返回相同 turnId；没有新 turn/started；GUI 显示补充消息；最终回复遵循补充要求；原等待工具正常结束。保存原生 item/message/turn ID 映射和时间，不能仅按文本相同强行合并。若接口只给 turnId，应明确仍缺稳定消息关联，继续标记相关能力不完整。

断线回执丢失时写 `unknown`，只读核对，不自动重放追加。停止测试如需 `turn/interrupt`，应在本阶段审批中明确包含，等待实际 interrupted 回执和 GUI 状态；不能扩展到真实会话。每次测试有总时限和一次投递限制。依次验证 idle send、active steer、消息关联、回执丢失；不把单次正常流程推广成幂等、排队或审批支持。

## 精确审批范围与推荐

| 阶段 | 执行前需批准的动作 | 影响与仍未授权动作 |
| --- | --- | --- |
| A1（推荐下一次） | 新建临时目录、启动一个前台 Unix server、两个无模型只读客户端、精确结束并清理此次目录 | 写临时测试状态；不改变桌面，不启动 managed daemon，不登录/建会话/发模型任务 |
| A2 | 已证明路径隔离后启动/停止临时 home 的 managed daemon | 后台进程/锁/日志写入；不 bootstrap、remote-control 或全局环境设置 |
| B | 用户选择测试 OS 账号或当前账号的受控桌面关闭/重启，临时启动环境，GUI 空测试会话及限定归属读取 | 测试账号可能需安装/登录；当前账号路径可能中断桌面工作，不能未经明确批准执行 |
| C | 指定测试账号登录、模型请求文本/费用、外部追加、必要时精确停止该测试轮次 | 会产生测试会话与模型用量；不控制真实会话、不扩展动作范围 |

建议下一次仅批准 A1。它能消除传输与多客户端连接的基础不确定性，无需改正在使用的桌面。A1 通过后再给用户审阅 A2 实际隔离证据与 B 的具体启动方案；若无法证明 managed 状态隔离或 GUI 实例独立，保留限制，停止而不自动采用侵入性方案。

## A1 执行记录：2026-10-09

用户明确回复“测试吧”后，仅执行 A1 范围。使用桌面同捆 CLI 0.162.0-alpha.17.2、新临时 home/cwd、白名单环境、前台 Unix listener。没有启动 managed daemon、登录、创建会话、发模型消息或重启桌面。

结果为 **未通过进程/socket 归属前置检查，双客户端阶段未执行**，不能认定共享协议失败或成功。

首次精确路径检查未通过；修正 macOS /tmp 与 /private/tmp 路径别名处理后复查，lsof 显示测试进程实际监听 `/private/tmp/codex-daemon-501/<哈希>`，不是指定临时目录中的 control.sock。指定路径虽出现，当前检查不能证明它与真实监听的映射。CLI 可能存在 socket 重定位/间接路径机制，但尚未核实，不作为事实结论。该行为也说明“显式 --listen 路径一定限制所有监听落点”的方案假设不成立。

两次测试均在建立客户端之前退出，精确结束各自测试进程并清理各自临时目录。第二次额外检查所观察的哈希 socket：文件已不存在，lsof 无 listener。未按进程名批量终止其他进程，未修改真实 Codex 数据或桌面配置。

后续应先只读核查当前 CLI 的 Unix socket 路径解析/重定位契约，修订 listener 身份校验及隔离范围，再决定重试；不自动越过前置检查，不把 A1 放行到 A2/B/C。当前没有证据证明需要桌面重启来解决此预检问题。

## A1 重试结果：2026-10-09 16:37（Asia/Shanghai）

用户授权“做下一步”后，核查指定路径的 lstat / realpath，并在同一 A1 范围重试。

**A1=pass。** 当前同捆 CLI 0.162.0-alpha.17.2 将指定 control.sock 建为符号链接，实际 Unix socket 位于 `/private/tmp/codex-daemon-501/<哈希>`。因此前次失败来自把符号链接路径与 lsof 实际路径直接比较，并非共享连接不支持。

本次核对：指定路径类型确为 symlink；解析目标是当前 OS 用户拥有的 socket；目标父目录由当前用户拥有且权限不开放给其他用户；lsof 显示精确测试 PID 持有解析后的 socket。之后两个客户端均通过指定链接路径连接，initialize 成功，thread/loaded/list 返回空数组，并且同时保持 OPEN。仅调用白名单方法，没有创建线程或模型任务。

清理核对：测试进程结束、实际 socket 无 listener 且文件已由服务移除、测试目录和日志已删除。保留了已有共享 socket 父目录，没有按名字批量删除或停止任何其他 Codex 实例。

实现方案修正：路径归属应解析符号链接后，校验目标类型、用户、父目录权限及精确 listener PID；不能仅比较输入路径。显式 socket 路径不等于全部文件都落在测试目录，测试边界须包括该服务生成的实际 socket，并检查退出后的清理。不要将此机制视作 OS 权限沙箱。

A1 只证明同一前台服务可以接受两个只读客户端。managed daemon 的管理状态隔离（A2）、桌面采用该 daemon（B）、原桌面运行中消息追加（C）均未验证，不能据此开启 Ash 控制能力或重启桌面。

## A2 生命周期结果：2026-10-09

用户授权“下一步”后，先参考官方 daemon 源码的 home 派生路径与包准备逻辑，再在全新 `/tmp/ash-dm.*` 下使用同捆 0.162.0-alpha.17.2 测试。官方 main 源码仅作参考，不等同所装二进制的完整版本证明；以下是本机实际结果。

测试 home 内设置 remoteControlEnabled=false、autoUpdateEnabled=false、shutdownGraceSeconds=2；不更改真实 home、系统启动项或桌面环境。daemon start 成功返回 status=started、backend=pid；managedCodexPath 和逻辑 socketPath 均位于测试 home。包由 start 准备在测试 home/packages/app-server-daemon 下。daemon version 返回 running，CLI 与服务版本一致。daemon stop 返回 stopped。随后核对测试 PID 不存在、测试 socket 不存在、测试目录已清理；真实默认 control socket仍不存在。

管理状态实际观察到 daemon.lock、daemon.pid/lock、daemon.stderr.log、daemon-updater.pid.lock 和 settings.json，均在测试 home/app-server-daemon。仅存在 updater 锁文件不是 updater 运行的证据。本次未登录、未创建会话、未调用模型或启用远程控制。

结论：临时 home 的 managed daemon 启停及版本查询通过；这不是全系统写入审计，也未在此 managed 实例重复 A1 的两个客户端请求。桌面同 owner 验证（B）与消息追加（C）仍未进行。下一步须准备并确认桌面切换方式；不得将本结果记为 Ash 可控制当前桌面会话。

参考：[官方 daemon 实现](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/src/lib.rs)、[包准备逻辑](https://github.com/openai/codex/blob/main/codex-rs/app-server-daemon/src/prepare_install.rs)。

## 桌面重启后的复核：2026-10-09

用户授权真实桌面切换后，daemon 已在真实 home 启动且版本匹配。但恢复对话时检查 restart helper 的 status.json，阶段为 quit_not_completed_no_force；因此不能认为已执行带 CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 的重新启动。

本轮只读连接真实 daemon，initialize 和 thread/loaded/list 成功，返回 loadedCount=0、无当前会话、无下一页。桌面同 owner（B）仍未通过。

尝试通过 Computer Use 只读查看桌面退出阻挡时，工具以安全限制明确拒绝访问 com.openai.codex；未改用其他 UI 自动化绕过。需要用户手动正常退出桌面后，在终端执行已审阅的一次性启动命令：`open -a /Applications/ChatGPT.app --env CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`。之后再只读核对同一 daemon 是否持有桌面会话。没有向业务会话发送测试消息。

## 手动重开后的阻挡定位：2026-10-09

用户回复“已重开”后只读复核：真实 daemon 的 thread/loaded/list 仍为空，当前桌面会话不在其中。桌面主进程启动时间为 16:51:31，存在其直接派生的同捆 CLI 进程。本会话命令环境继承的 CODEX_APP_SERVER_USE_LOCAL_DAEMON=1，说明不能简单归因为用户没有设置标志；子进程环境不是主进程完整环境证明。

读取当前安装包 app.asar 的实际代码发现确定性阻挡：

- `.vite/build/application-network-startup-CfAQmSYg.js` 的本地连接选择要求 `!e?.length`（getConfigOverrides 返回空）才可能采用共享 daemon，还要求启动标志、版本和其他条件满足。
- `.vite/build/main-39FdJ_vp.js` 的普通本地 transport 工厂始终给 getConfigOverrides 数组追加 `yYe(e)`；该函数返回 `plugins.code-review@openai-bundled.mcp_servers.code-review.enabled=<boolean>` 字符串，即使 enabled=false 也不是空数组。
- 本地分支还由 Yc(e) 返回 codex-app-tools 的 enabled 配置项。因此沿该工厂创建的本地 transport 无法满足 daemon 分支的“空覆盖配置”要求。
- 子命令环境还观察到 CODEX_CLI_PATH 非空，但未读取/输出具体值，也不能用它断言桌面主进程启动时有相同覆盖。无需依赖此项即可确认前述代码条件冲突。

结论：当前安装版本的普通桌面连接路径，单靠 CODEX_APP_SERVER_USE_LOCAL_DAEMON=1 无法完成共享 owner 切换。B 未通过，C 未执行。未发送模型测试任务，未修改应用包/签名、插件配置或用户认证。停止重复重启；后续需单独设计支持的桌面桥接路线，或验证可显式配置的 WebSocket transport 是否保留桌面能力，不能宣称已具备外部追加控制。

真实 daemon 保留运行，避免未经归属核查停止可能使用它的其他客户端；其 remote control 和自动更新仍关闭。恢复普通桌面启动可在下次正常退出后不带 env 参数打开。若需要清理测试 daemon，应先复核其活动会话及连接，再精确停止。

## 显式 WebSocket 入口预检：2026-10-09

当前安装包实际存在另一个入口：`CODEX_APP_SERVER_WS_URL`。main 的 j5 工厂先调用 A5；普通本地主机由 c.D（网络模块导出的 Yo）读取该环境变量，非空则直接创建 c.E（Jo WebSocket transport），不会进入附加配置的 stdio 工厂。FORCE_CLI=1 仍会禁止这条路线。该结论来自本机安装代码，不视为公开稳定产品接口。

为复用现有 Unix daemon、避免开放 TCP 端口，准备一次性 URL：

```text
ws+unix://localhost/Users/ahaha/.codex/app-server-control/app-server-control.sock:/rpc
```

安装包内置 WebSocket 实现接受 ws+unix，并将 pathname 按冒号拆为 socketPath 和 HTTP path。显式 localhost 主机还使桌面 xYe 的非本地主机代理分支不生效；不是向 localhost 新建网络 listener。

实际预检使用仓库 ws 库、同 URL、handshakeTimeout=5000、空 headers、perMessageDeflate=false，initialize 和 thread/loaded/list 成功，loadedCount=0、无下一页。它证明 URL 和当前服务握手可用；并未加载整个桌面 transport 或证明 GUI 已接入。没有创建/恢复会话、调用模型或更改 daemon。

此入口跳过原工厂的 secretAuthStorageConfigOverrides、插件和其他启动配置覆盖，登录及插件能力兼容性未确认，不能把能连接当成功能齐全。下一步仅按此前授权切换桌面并只读验证 owner；随后需要验证登录、工具可用性、测试会话与追加消息行为。不可为了消除未知而复制认证文件或修改安装包。

手动操作：正常完全退出 Codex 桌面，在终端运行：

```sh
open -a /Applications/ChatGPT.app --env CODEX_APP_SERVER_WS_URL='ws+unix://localhost/Users/ahaha/.codex/app-server-control/app-server-control.sock:/rpc'
```

继续使用用户既有重启授权；不再次请求同一权限。此前 Computer Use 明确拒绝访问该应用、正常自动退出也未完成，因此由用户完成退出/重开，不采用替代 UI 自动化绕过。若不能打开或能力异常，正常退出后用不带环境参数的 open 命令恢复；不强停 daemon 中未知归属的任务。仅重开不代表 B 通过。

## 显式连接启动失败与恢复：2026-10-09

用户截图显示 connect ENOENT，路径为预期 app-server-control.sock。只读复核发现 socket 已不存在，之前 daemon PID 61048 也不存在；daemon version 同样报 ENOENT。确认服务已经退出，但尚无证据确定退出原因，不能归因为正常退出桌面必然停止 daemon。此前连接预检只证明当时可连接，未保证用户重开时服务仍存活，启动步骤缺少 daemon 就绪检查。

沿既有切换授权重新执行同捆 CLI app-server daemon start，成功返回新 PID 76675 和匹配版本。随后用相同显式 ws+unix URL 完成 initialize、thread/loaded/list（0条），daemon version 返回 running。没有发模型任务。需要用户关闭错误对话框并重开桌面后再验证 owner；桌面尚未接入。后续部署必须包含服务生命周期管理和启动前就绪检查，不能只提供桌面 env 命令。

## 显式 WebSocket 桌面接入成功：2026-10-09

用户在退出桌面后从外部终端启动 daemon，并按显式 CODEX_APP_SERVER_WS_URL 方式重开，回复“重启了”。外部只读 WebSocket 客户端 initialize 成功，分页 thread/loaded/list 返回4个已加载会话，包含当前桌面会话 01a10ace-3acd-7f93-92be-239c49555b84；thread/read(includeTurns=false) 返回相同 ID、status.type=active、activeFlags=[]。没有人为调用 thread/resume、thread/start 来制造加载状态，也没有向业务会话发送模型消息。

据此，B 的核心同服务/会话归属检查通过：外部连接可访问桌面正在运行的会话。未完成插件/登录完整兼容性测试，也未完成 C 的外部追加、桌面显示及最终回复一致性测试。不能把连接成功等同 Ash 成品功能已交付。下一阶段在隔离测试会话验证运行中追加及消息关联。

## C 协议侧跨连接追加测试：2026-10-09

沿用户“继续验证”授权，复用独立测试会话“ Ash 跨连接追加消息测试”（01a11f8f-7ff8-7ab2-9ad7-0607832213a9），未向业务会话发送输入。使用当前 CLI 生成协议 schema，建立两个独立 WebSocket 客户端到同一真实 daemon。starter/observer 分别 resume 此测试会话；starter 发起一次25秒只读等待任务，observer 在 commandExecution started 事件后只发送一次 turn/steer(expectedTurnId)。无重试、无 interrupt，没有修改项目文件。

结果：

- turnId=01a11fec-1706-7b02-b770-a85f365ebc85；只观察到一次 turn/started。
- 工具 started 在14600ms，steer ack 在14602ms，回执为同一 turnId。
- 同一个等待工具在39558ms完成，exitCode=0，耗时约24.96秒；没有中断或重复等待。
- 追加 userMessage 在39572ms出现，即本次在工具完成后处理。
- 最终回复在46922ms为 `SHARED-BASE-DONE ASH-SHARED-APPEND-OK`；47068ms turn completed。
- 第二连接 thread/turns/list(itemsView=full) 读回同一轮、初始输入、追加输入、同一工具及最终回复；追加事件与历史中 itemId 一致（01a11fec-b162-7d92-8b66-646d60bf9297）。

初次 probe 仅投影 clientUserMessageId 字段而未检查原生 clientId，导致最初误判为未回显；下方复核已纠正。steer 回执本身只包含 turnId，不能仅凭其宣称已完成消息关联或幂等。保存的证据：build/research/daemon-switch/steer-result.json；执行脚本：steer-probe.mjs。

边界：本轮任务由外部 starter 发起、另一外部连接追加，证明共享服务跨连接协议成立；不是桌面 GUI 发起测试，不能据此声称已完成“桌面发起运行中任务收到 Ash 追加”或 GUI 消息即时显示验收。仍需用户在桌面打开该测试会话确认显示；桌面发起对照、断线核对、登录插件兼容性及生命周期管理仍待完成。本次等待结果不保证所有工具/执行阶段都具有同样时序。

## 桌面消息显示确认：2026-10-09

用户提供测试会话的桌面截图，明确显示本次17:08的初始等待指令、追加要求，以及最终 `SHARED-BASE-DONE ASH-SHARED-APPEND-OK`，桌面显示用时47秒，与协议记录相符。由此确认外部共享服务输入与最终回复可以出现在现有桌面会话历史中。截图同时包含上一轮 TEST-BASE-DONE ASH-APPEND-OK，但本次结论依据下方 SHARED 标记，未混淆两轮。

此验收是完成后打开会话的显示确认，不证明消息在GUI打开期间即时刷新。任务仍由外部starter发起，桌面发起/外部追加的对照尚未完成。Ash实际手机链路、自有messageId关联、断线恢复和daemon生命周期仍未交付。

## 原生消息关联字段复核与纠正：2026-10-09

依据当前CLI生成schema，UserMessageThreadItem保存的是 `clientId`，输入参数才叫 `clientUserMessageId`。对同一个已完成测试turn（01a11fec-1706-7b02-b770-a85f365ebc85）再次只读调用 thread/turns/list(full)：

| 请求自有ID | 历史userMessage.clientId | 原生item.id |
| --- | --- | --- |
| ash-daemon-probe-base-20261009 | ash-daemon-probe-base-20261009 | 01a11fec-3a7e-7622-b9a8-38c35bb8817b |
| ash-daemon-probe-append-20261009 | ash-daemon-probe-append-20261009 | 01a11fec-b162-7d92-8b66-646d60bf9297 |

因此当前版本的两种请求都具备可从保存历史核对的消息关联证据。初次probe投影字段错误，不是原生未保存关联；已更正先前结论。关联必须限定WorkRef和原生turn/item，不通过文本相等猜测。不代表同ID原生重试幂等、消息已经执行、任意版本均支持，亦未证明所有回执丢失窗口都可核查。
