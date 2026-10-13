# Codex 桌面既有会话外部控制入口调查

2026-10-09；只读调查。对应 [技术架构](CROSS-END-TECHNICAL-ARCHITECTURE.md) 第 9 节和 [产品设计](CROSS-END-PRODUCT-DESIGN-V2.md) 第 14 节。

## 后续验证更新

本文件下方保留初次只读调查的历史结论，不代表当前能力状态。后续用户授权的共享 daemon 与 GUI C2 指定场景已证明同一桌面 turn 可以通过外部 turn/steer(expectedTurnId) 追加；详见 CODEX-DAEMON-ISOLATION-PLAN.md 与 CROSS-END-DEVELOPMENT-STATUS.md。S1/S4 新模块已完成开发层独审，生产入口、手机真机、未知恢复与普通用户安装尚未整体验收。没有采用桌面私有 IPC 或写原数据库作为控制入口。

## 初次调查结论

当前本机没有验证到可供外部 ash-device 可靠发送或追加到既有桌面会话的控制入口。不能声明 `send_input`、`steer`、`cancel` 或问题回复已支持。读取能力继续独立交付；指定项目新建沿用用户确认的 itsallsame 路径，不把这项已有能力列为阻塞。

发现两类值得继续核实的入口：官方 CLI 的 daemon / proxy / Unix WebSocket 控制 socket，以及桌面主进程的私有 IPC。前者当前没有运行中的默认控制 socket；后者确实存在且安装包含会话 owner/follower 控制消息，但没有已验证的外部公共契约及授权方式。仅发现协议字符串不能证明第三方可以调用，更不能证明稳定回执、幂等和活跃 turn 归属。

## 调查边界

读取了项目两份设计文档、CLI 帮助和版本、进程可执行文件名称、打开的 socket 元数据、安装包内相关协议实现、itsallsame 的新建接入代码。未读取 auth/token/config 正文，未输出凭据，未向真实会话发送消息，未 resume 活跃会话，未启动 daemon、新任务或模型调用，未安装组件、改设置或重启桌面。唯一新增文件是本文。

先前实测由现有设计文档记录，本次未重做：独立 `codex app-server --stdio` 可以 `thread/list`、`thread/read`、`thread/turns/list` 读取既有桌面历史；对桌面活跃会话 `turn/steer` 返回 `thread not found`，历史端的 `interrupted` / `notLoaded` 与桌面实际运行状态不一致；桌面内部 `send_message_to_thread` 对照进入同一轮。内部工具可用不等于外部进程获得相同入口。

## 本机证据

| 检查 | 观察 | 能证明什么 |
| --- | --- | --- |
| `codex --version` | Homebrew CLI `0.154.0` | 外部命令版本 |
| 随包 `codex --version` | ChatGPT.app 内 CLI `0.162.0-alpha.17.2` | 桌面随包版本与外部版本不同 |
| 两个版本的 `app-server --help` | 都提供 `daemon`、`proxy`；支持 stdio、Unix socket、TCP WebSocket、off | 存在真实控制传输候选，不只是猜测端口 |
| `app-server proxy --help` | `--sock <SOCKET_PATH>`；代理 stdio 字节到运行中的控制 socket | 可选显式 socket 路径；不证明连接的是桌面 owner |
| `app-server daemon version` | 退出 1，默认 `~/.codex/app-server-control/app-server-control.sock` 不存在（ENOENT） | 当前默认 daemon 控制连接不可用 |
| 目录元数据 | 默认 control 目录不存在；daemon 目录只有两个零字节 lock 文件 | lock 文件存在不能当 daemon 运行证明 |
| 四个桌面随包 codex 进程的 `lsof -U` / TCP LISTEN | 有匿名 Unix socket pair；没有命名控制 socket，也没有 TCP listener | 当前未观察到它们对外暴露标准控制 listener；不能据此排除所有其他内部通道 |
| `~/.codex/ipc/ipc.sock` | 由 ChatGPT 主进程持有；目录 0700，socket 0600，同一 OS 用户 | 私有桌面 IPC 确实存在；文件权限不是业务授权契约 |

本机桌面实际宿主是 `/Applications/ChatGPT.app`。随包 CLI 路径为 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`；旧的 `/Applications/Codex.app` 路径不存在。适配器不能硬编码旧安装路径。

### 安装包中的 daemon 选择条件

`/Applications/ChatGPT.app/Contents/Resources/app.asar` 内 `/.vite/build/application-network-startup-CfAQmSYg.js` 显示：本地桌面连接只在非 Windows、本地 host、无附加配置覆盖、`CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`、未强制 CLI、无显式 CLI/runtime 覆盖、daemon version 兼容等条件全部成立时，连接默认 control socket（WebSocket over Unix）；否则使用 stdio 启动方式。

这是当前版本的实现线索，不是承诺给第三方的配置接口。本次没有读取桌面环境或修改该变量。即使另启 daemon 后 proxy 可以连接，也只证明 daemon 自己的会话可控；桌面现有会话必须实际归属该 daemon 才可能控制，不能自动迁移或 resume 后宣告同一执行者。

### 私有 IPC 与内部工具管道

安装包 IPC 帧是 4 字节 little-endian 长度加 JSON 正文，区别于标准 stdio JSONL 和 Unix WebSocket HTTP Upgrade。包内还包含 `thread-owner-discovery`、`thread-follower-start-turn`、`thread-follower-steer-turn`、`thread-follower-interrupt-turn`、`thread-stream-state-changed` 等内部方法名称，说明桌面内部有 owner/follower 协调机制；本次只检查静态代码，没有连接 socket 或发协议探针。

`main-39FdJ_vp.js` 内另一条 `dynamic-app-tools-native-pipe` 包含 `tools/call`，要求 callerSource、callId、hostId、namespace、threadId、turnId 等上下文，并包含 macOS native `authorizeSocketPeer` 的授权逻辑（是否强制取决于 package build flavor）。不能假定它等同于 `ipc.sock`，不能假装桌面原生调用方，也不能绕过 peer authorization。已发现的 `send_message_to_thread` 公开工具描述只证明桌面内代理工具能力，不提供外部 ash-device 调用地址或凭据契约。

## 官方契约与其限制

[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server) 描述 stdio、TCP WebSocket、Unix WebSocket 和关闭监听四种传输；Unix socket 使用 HTTP Upgrade。文档把 WebSocket / app-server 相关传输标为实验性质，并没有说明第三方会自动连接正在运行的桌面会话。

该文档说明 `thread/loaded/list` 返回当前 server 内存中的会话；`thread/read` 读取保存历史而不订阅；`turn/steer` 需要匹配的 `expectedTurnId` 及当前活跃轮次。它们提供了未来验证同进程归属的检查方法，不能用另一个 server 的历史状态代替桌面状态。steer 回执的 `turnId` 仍不足以自行建立稳定用户消息 ID 映射；需核对当前版本原生 item 事件或后续读取。

## 接入决策与下一步门槛

| 路径 | 当前决策 | 后续门槛 |
| --- | --- | --- |
| 独立 stdio 历史读取 | 可继续按需读取 | 有界请求、分页及缓存合并；不 resume/start 来查看历史 |
| itsallsame 指定项目新建 | 保留已确认能力 | 源码 `codex-local-service-launch.ts` 使用独立 stdio 查项目 → thread/start(projectId,cwd) → name/set → turn/start；不是既有活跃会话控制证据 |
| 默认 daemon / proxy | 控制不可用 | socket 存在、协议版本兼容，且 `thread/loaded/list` 能证明目标被该实例拥有；之后仍需隔离会话验证发送、追加和回执 |
| 现有桌面私有 IPC | 研究候选，暂不实现控制 | 受支持的外部契约或明确维护该私有适配器的决定；合法身份/peer 授权；owner 发现、状态、错误、回执的只读确认后，再做隔离写测试 |
| 内部 app-tools 管道 | 不当外部 API 使用 | 官方第三方接入或清楚的授权桥接方式，不能伪造 thread/turn 调用上下文 |

当前无需用户为继续只读或实现 read adapter 额外介入。若后续要切换桌面 daemon，必须先给用户审阅具体版本、启动条件、恢复方案和影响，再授权执行；不能自行设环境变量、重启桌面、resume 活跃工作或启 remote-control。风险包括现有活跃任务中断、桌面仍落回 stdio、历史与运行 owner 混淆，以及连接多客户端后的审批/事件责任不明。

推荐未来有界验证步骤：先获受支持接入契约；或在明确授权的隔离测试环境配置 daemon 并验证桌面采用该实例；只读 `initialize`、`thread/loaded/list` 和状态检查确认 owner；使用用户授权创建的隔离会话测试 idle send、active steer、停止及断线回执；验证消息关联、未知结果、幂等和授权撤销后才宣告控制能力就绪。不要把这套步骤在真实会话上当健康检查执行。

若可靠外部入口最终不可用，产品明确显示“可读取、不能远程追加到此会话”，继续提供既有新建入口和人工回到桌面。禁止写源数据库、注入 JSONL、另起运行器或创建替代会话来伪装投递成功。
