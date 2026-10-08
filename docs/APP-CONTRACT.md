# Ash 应用契约 `ash-app/1`

版本：`ash-app/1`（2026-10）。任何应用——Ash 自带的、Agent 写的、或别人写的——按这份契约提供一个服务，就成为 Ash 体系的一员：

- **对 Agent**：应用的工具成为 Ash 成员 `app:<id>` 的能力（words），Agent 用已有的 `capability_list / capability_describe / capability_call` 调用。
- **对人**：应用的页面是 `ui://` HTML 资源（[MCP Apps](https://github.com/modelcontextprotocol/ext-apps) 规范），由独立的壳 App「Ash 应用」在隔离的 WebView 里画出来。Ash 的对话里最多出现一张「打开 XX」入口卡片。
- **对 Ash**：应用要用 Ash 的东西（例如手机的健康数据），只能用主人在安装时批准过的范围（grants）。

本版只定义**容器里的应用**：应用是 Ash 容器里的一个文件夹 `/root/apps/<id>/`，服务是一个说 MCP 的 stdio 进程。手机原生 App 和电脑上的应用是以后的版本。

## 0. 从零写一个应用（给 Agent）

`service:apps` 的这几个能力就是写应用的全部路径，都不需要主人批准，只有最后的安装要：

| 步骤 | 能力 | 说明 |
|---|---|---|
| 读契约 | `apps.contract {}` | 返回这份文档全文、`app.json` 的 JSON Schema、最小例子 hello 的全部文件。容器里也有同样的文件：`/root/apps/APP-CONTRACT.md`、`/root/apps/_examples/hello/` |
| 生成骨架 | `apps.scaffold {id, name, summary?, surfaces?, tools?}` | 在 `/root/apps/<id>/` 写出一个能直接运行的应用（见 §9）。已有 `app.json` 的文件夹不会被覆盖 |
| 改 | 直接改文件 | `/root/apps/<id>/` 对你可写：`server.mjs` 里的工具，`ui/` 下的页面，`app.json` 的 `needs` |
| 检查 | `apps.validate {id}` 或 `{path: "/root/apps/<文件夹>"}` | 像安装一样检查，再试运行一次服务：返回 `{ok, problems:[{level, where, problem, fix?}], tools, surfaces}`。`level: "error"` 会挡住安装，`"warning"` 不挡 |
| 安装 | `apps.install {id}` | 先做同样的检查，不通过就直接拒绝（`error.detail.problems` 列出每个问题），**不会**去打扰主人；通过了才弹审批卡，主人批准后应用启动，成为 `app:<id>` |
| 用 | `capability_call {member: "app:<id>", word: "<工具名>", body}` | 主人在「Ash 应用」里打开它的页面 |

改了已安装应用的文件以后：页面每次打开都现读，不用做什么；工具列表只在启动时读一次，要再 `apps.install {id}` 一次（会重启它，并重新弹卡确认 needs）。

## 1. 应用文件夹和 `app.json`

```text
/root/apps/<id>/
  app.json        应用描述（必需）
  icon.png        图标（可选；文件名写在 app.json 的 icon）
  server.mjs      服务（文件名随意，写在 server.args 里）
  ui/…            页面文件（随意组织，服务读它们拼成页面）
  data.json …     应用自己的数据（随意）
```

`app.json` 由 Ash 在启动、`apps.refresh`、`apps.validate`、`apps.install` 时用 JSON Schema 校验：[`docs/app.schema.json`](app.schema.json)（`apps.contract` 的 `schema`）。**不允许多余字段**。

| 字段 | 必填 | 取值 |
|---|---|---|
| `contract` | 是 | 固定 `"ash-app/1"` |
| `id` | 是 | `^[a-z][a-z0-9-]{0,47}$`：小写字母开头，只有小写字母、数字、`-`，最长 48。**必须和文件夹名相同**。别人写的应用用发布者前缀避免重名，如 `example-notes` |
| `name` | 是 | 显示名，1–40 字 |
| `version` | 是 | `主.次.修`，如 `1.0.0`（可带 `-beta.1` 之类后缀）。版本变了，`apps.refresh` 会重启已安装的应用 |
| `icon` | 否 | 同目录下的文件名，`^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(png\|svg\|webp)$`。见下面「图标」 |
| `summary` | 是 | 一句话说明，1–200 字。会出现在审批卡上 |
| `publisher` | 是 | 发布者，1–80 字。Agent 写的应用写自己的成员 id（如 `agent:main`，`apps.scaffold` 会替你写好）；审批卡据此标明「Ash 自己写的，没有发布过」。只有和 Ash 自带的完全一致的应用才算「Ash 自带」 |
| `server` | 是 | `{command, args?, env?}`：服务的启动命令（§2）。`command` 1–200 字；`args` 最多 32 项、每项 ≤ 500 字；`env` 最多 32 个，名字 `^[A-Z][A-Z0-9_]{0,63}$` 且**不能以 `ASH_` 开头**，值 ≤ 2000 字 |
| `surfaces` | 否 | 页面列表 `[{id, title, resource}]`，最多 16 个：`id` 是 `^[a-z][a-z0-9-]{0,31}$`（不能重复），`title` 1–20 字，`resource` 是 `ui://…` URI（约定写 `ui://<应用 id>/<页面 id>`）。见 §4 |
| `events` | 否 | 应用会发给 Ash 的事件名，最多 32 个，如 `notes.due`：小写，**至少含一个点**。`app.card` 是内置的，不用也不能写。见 §6 |
| `needs` | 否 | 要用 Ash 的什么，最多 16 项；安装时主人在一张卡上逐项看到、一次批准。见 §5 |
| `tools` | 否 | 任意数组，仅供阅读；Ash 以服务的 `tools/list` 为准 |

**图标**：正方形，PNG（最稳）或 WebP，建议 192×192 或更大，不超过 512 KB。SVG 在 Ash 的网页里能显示，但手机上的「Ash 应用」画图标只认 PNG/WebP，SVG 会显示成默认图标（`apps.validate` 会提醒）。`apps.scaffold` 会生成一个简单的 PNG。

## 2. 服务：Ash 怎么启动它、怎么和它说话

### 启动

- 只有主人安装（批准 `needs`）且没停用的应用才会被启动。`apps.validate` 和安装前的检查会**试运行**一次（见下面 `ASH_TRIAL`）。
- Ash 在容器里以 root 身份运行 `server.command server.args…`，**工作目录是应用文件夹**。等价于：`cd /root/apps/<id> && exec <command> <args…>`。`command` 按 `PATH` 查找（`node`、`python3`、`sh` 都行），也可以写 `./run.sh` 这样的相对路径。
- 容器里有 Node.js 22（`/opt/node/bin/node`，带 npm）、`sh`；`python3` 通常也有。没有 npm 依赖最省事：`apps.scaffold` 生成的服务只用 Node 自带模块。要用 npm 包就在应用文件夹里 `npm install`（node_modules 跟着文件夹走），或像「健康」那样打成单文件。
- 环境变量只有这些（不继承 Ash 自己的环境）：

| 变量 | 含义 |
|---|---|
| `ASH_APP_ID` | 应用 id |
| `ASH_APP_DIR` | 应用文件夹（`/root/apps/<id>`）；应用自己的数据放这里 |
| `ASH_MCP_URL` | 回调 Ash 的 MCP 端点（Streamable HTTP，本机回环，§7） |
| `ASH_MCP_TOKEN` | 该端点的凭证（`Authorization: Bearer …`），每次启动都换 |
| `ASH_TRIAL` | 只在试运行时为 `1`：这时凭证无效，不要在启动时就去调 Ash 或发事件 |
| `HOME`、`PATH`、`TMPDIR`、`LANG`、`TERM` | `/root`、容器的 PATH、`/tmp`、`C.UTF-8`、`dumb` |
| `app.json` 的 `server.env` | 原样给出 |

- 崩溃（进程退出）后 Ash 按 1 秒起、翻倍、最长 1 分钟的间隔重启；停用、撤销全部授权、删除文件夹后停止。Ash 关掉 stdin 就是让它退出。
- 服务端可以用容器的网络；页面不行（§4）。容器里别的地方（例如 `/root/work`）是主人和 Agent 的，应用只用自己的文件夹。

### 通信：stdio 上的 MCP

传输是 [MCP stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)：**stdin 收、stdout 发，每行一条 JSON-RPC 2.0 消息**（UTF-8，消息里不能有换行）。**stdout 只能写协议消息**——日志、调试输出一律写 stderr（Ash 会把 stderr 记进日志，`apps.validate` 失败时会附上最后几行）。

服务要回答这些请求（Ash 是客户端，按这个顺序发）：

| 请求 | 回答 `result` |
|---|---|
| `initialize {protocolVersion, capabilities, clientInfo}` | `{protocolVersion, capabilities: {tools: {}, resources: {}}, serverInfo: {name, version}}`。`protocolVersion` 原样回对方发来的即可。有页面就必须声明 `resources`，有工具就必须声明 `tools` |
| （通知）`notifications/initialized` | 不回 |
| `tools/list {}` | `{tools: [工具…]}`，见 §3。**只在启动时读一次** |
| `tools/call {name, arguments}` | `{content: [{type: "text", text}], structuredContent?: {…}, isError?: true}`，见 §3 |
| `resources/list {}` | `{resources: [{uri, name, mimeType}]}`（可选，Ash 目前不依赖它） |
| `resources/read {uri}` | `{contents: [{uri, mimeType: "text/html;profile=mcp-app", text: "<整页 HTML>", _meta?: {ui: {csp}}}]}`，见 §4 |
| `ping` | `{}` |

不认识的方法回 JSON-RPC 错误 `{code: -32601, message}`；处理出错回 `{code: -32603, message}`（工具自己的失败不要用 JSON-RPC 错误，用 `isError`，见 §3）。请求可以并发、乱序回答，按 `id` 对应。

一个完整往返（`→` 是 Ash 发的，`←` 是服务回的）：

```text
→ {"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ash","version":"1.0.0"}}}
← {"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{},"resources":{}},"serverInfo":{"name":"hello","version":"0.1.0"}}}
→ {"jsonrpc":"2.0","method":"notifications/initialized"}
→ {"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}
← {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"hello.greet","title":"打招呼","description":"…","inputSchema":{"type":"object","properties":{"who":{"type":"string"}},"additionalProperties":false},"annotations":{"readOnlyHint":true}}]}}
→ {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hello.greet","arguments":{"who":"皮皮"}}}
← {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\"text\":\"你好，皮皮！\"}"}],"structuredContent":{"text":"你好，皮皮！"}}}
→ {"jsonrpc":"2.0","id":3,"method":"resources/read","params":{"uri":"ui://hello/home"}}
← {"jsonrpc":"2.0","id":3,"result":{"contents":[{"uri":"ui://hello/home","mimeType":"text/html;profile=mcp-app","text":"<!doctype html>…"}]}}
```

用官方 SDK（`@modelcontextprotocol/sdk` 的 `Server` + `StdioServerTransport`）写也完全可以，「健康」就是这样写的（`packages/apps/health/src/server.mjs`）。

## 3. 工具：怎么变成 `app:<id>` 的能力

`tools/list` 里的每个工具：

```jsonc
{
  "name": "notes.add",                 // ^[a-z][a-z0-9_.-]{0,63}$，约定 <应用 id>.<动作>；不合规的不登记
  "title": "记一条笔记",                // 给人看的短语：记录里写成「在<应用名>里记一条笔记」
  "description": "Add a note …",       // 给 Agent 看：做什么、参数什么意思
  "inputSchema": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"], "additionalProperties": false },
  "annotations": { "readOnlyHint": false, "destructiveHint": false },
  "_meta": { "ui": { "resourceUri": "ui://notes/home" } }   // 可选：和这个工具相关的页面
}
```

- **登记**：应用启动后，合规的工具成为成员 `app:<id>` 的能力，名字就是能力名（`word`）。Agent 用 `capability_list {member: "app:<id>"}` 看到它们，用 `capability_call {member: "app:<id>", word: "notes.add", body: {text: "…"}}` 调用。
- **参数**：`inputSchema` 必须是 `type: "object"` 的 JSON Schema（默认 draft-07；写 `$schema` 可用 2019-09 / 2020-12），用 Ajv **严格模式**编译：拼错的关键字、不认识的格式都会让这个工具被单独拒掉（`apps.validate` 会指出来）。没有参数就写 `{"type":"object","properties":{},"additionalProperties":false}`。调用时 Ash 先按它校验 `body`，不合规的调用到不了应用。
- **应用是 Ash 的器官，用它自己的工具不弹卡**：主人安装时批准了这个应用和它要用的一切（`needs`），这就是边界。之后 Agent 调用这个应用自己的工具——读也好、改数据也好——都直接执行，不再弹审批卡（只有识别出的付款仍然每次问主人）。应用自己再去用 Ash 的东西（手机能力、提醒、入口卡片），仍然只能在授权范围内（§5）。主人在应用页面里点的操作是主人自己做的，同样不用审批；两者都记账。
- **效果照实标**：只有 `annotations.readOnlyHint: true` 且没有 `destructiveHint: true` 的工具算「读」，其余一律标「改数据」。这只影响记账、超时和 Agent 看到的说明，不会因此弹卡。
- **结果**：`tools/call` 的结果原样作为能力结果 `{content, structuredContent?}` 交给调用者。建议总给 `structuredContent`（一个对象），`content` 里放它的 JSON 文本或一句话。
- **主人改了什么，Ash 会知道**：主人在页面里调用改数据的工具成功后，Ash 记一条 `app.activity {app, name, tool, summary}` 给主 Agent，并放进它每一轮看到的「应用里最近的变化」（最近一天、最新几条）。这不会叫醒它。`summary` 默认是「<工具的 title>：参数 → 结果」；改数据的工具最好在结果里带 `_meta: {activity: "勾掉了：给物业打电话"}`，一句话说清改了什么（脚手架的服务里，`handle()` 返回的对象带 `activity` 字段即可）。只读的调用不记。
- **错误**：工具失败时回 `{content: [{type: "text", text: "原因"}], isError: true}`。调用者拿到 `{ok: false, error: {code: "failed", message: "原因"}}`（最多 2000 字），页面上 `app.call` 抛出的错误 `message` 也是这句话——**它会直接显示给主人，请写清楚的中文**。服务崩溃或回 JSON-RPC 错误也算失败。
- **时间**：只读工具 60 秒内要回答，改数据的 10 分钟；页面上的一次调用最多等 60 秒。

## 4. 页面（`ui://` 资源）

### 页面是什么

- `app.json` 的每个 `surface` 是一页。主人在「Ash 应用」里打开应用时，壳 App 用 `resources/read {uri: resource}` 读出**一整页 HTML**（`text`，或 base64 的 `blob`），`mimeType` 写 `text/html;profile=mcp-app`。**每次打开都重新读**，所以改了页面文件不用重启服务。
- 页面是自包含的：CSS、JS 都内联在这一页里（壳 App 不给页面任何文件，相对路径的 `<script src>`、`<link href>` 都加载不到）。`apps.scaffold` 的服务会把 `ui/app.css`、`ui/app.js` 和 `ui/<页面 id>.html` 拼成一整页。
- 多个 surface 在壳 App 顶部显示为**标签页**（只有一个时不显示标签），顺序就是 `app.json` 里的顺序，第一个是默认页。切换标签 = 重新读那一页、换一个全新的 WebView。
- **页面内跳转**：本版没有「从一页跳到另一个 surface」的方法。一页里要有多个视图时，自己切换（例如 `<section data-view="list">` / `<section data-view="detail">`，脚手架的 `app.show("detail")`）。`localStorage` 可用，按应用隔离，可以在页面之间传一点状态。

### 运行环境

- 每个应用一个隔离的 WebView（自己的源 `https://<id>.ash-app.invalid`），没有文件访问、没有地理位置/摄像头等权限、不能开新窗口；`<a>` 链接不会在页面里跳转，主人点了会先确认再用浏览器打开。
- **联网**：默认完全不联网。要用的域名写在资源的 `_meta.ui.csp` 里：`connectDomains`（fetch/WebSocket 的源，如 `"https://api.example.com"`）、`resourceDomains`（图片、脚本、样式、字体的源）；各最多 32 个。其余请求一律被拒。
- 尺寸：页面铺满屏幕（`displayMode: "fullscreen"`，`platform: "mobile"`），宽度一般 360–430 CSS 像素；请加 `<meta name="viewport" content="width=device-width,initial-scale=1">`，按窄屏竖排设计，内容超出时页面自己滚动。状态栏、刘海、键盘由壳 App 让开。
- 深浅色：`ui/initialize` 的回答和之后的 `ui/notifications/host-context-changed` 里有 `theme: "light" | "dark"`。约定把它写到 `<html data-theme="…">`，颜色只用 CSS 变量，并用 `@media (prefers-color-scheme: dark)` 兜底。壳 App 的配色：浅色背景 `#ffffff`、正文 `#1c1c1e`、次要文字 `#6e6e73`；深色背景 `#000000`、正文 `#f2f2f2`、次要 `#a0a0a6`；强调色 `#ff7a3d`。脚手架的 `ui/app.css` 已经按这些写好变量（`--bg --card --ink --muted --line --accent --danger --radius`）。

### 页面和宿主之间（MCP Apps，JSON-RPC 2.0）

页面用 `window.parent.postMessage(消息对象, "*")` 发，用 `window.addEventListener("message", e => e.data)` 收（在手机上壳 App 会把它接到一个 MessagePort 上，页面不用管；在 iframe 里也一样能用）。

| 页面 → 宿主 | 作用 |
|---|---|
| `ui/initialize {protocolVersion: "2026-01-26", appInfo, appCapabilities}`（请求） | 第一件事。回答里 `hostContext` 有 `theme`、`locale`（`zh-CN`）、`timeZone`、`containerDimensions {width, height}`、`displayMode`、`platform` |
| `ui/notifications/initialized`（通知） | 初始化完成后发一次 |
| `tools/call {name, arguments}`（请求） | **只能调用本应用自己的工具**；以主人身份执行、记账；回答是工具的 `CallToolResult` |
| `ui/message {role: "user", content: [{type: "text", text}]}`（请求） | 替主人给 Ash 发一句话，开头标明来自哪个应用；主人先确认 |
| `ui/open-link {url}`（请求） | 用浏览器打开 http(s) 链接；主人先确认 |
| `ui/notifications/size-changed {width, height}`（通知） | 可选 |
| `ping` | `{}` |

| 宿主 → 页面 | 作用 |
|---|---|
| `ui/notifications/host-context-changed {theme…}` | 深浅色等变了 |
| `ui/notifications/tool-input {arguments: {}}` | 页面被单独打开（不是某次工具调用带出来的），没有参数 |

页面调不到别的应用和 Ash 的能力；应用要用 Ash 的东西，只能由它的服务在授权范围内去调（§5、§7）。服务去调的能力需要主人确认时，审批卡由 Ash 自己弹，不在应用页面里批。

脚手架和 hello 例子里的 `ui/app.js` 把这些包成了 `window.app`：`await app.call("工具名", 参数)`（返回 `structuredContent`，失败抛出带原因的错误）、`app.show("视图")`、`await app.tell("文字")`、`await app.openLink(url)`、`app.el(tag, attrs, ...children)`。

## 5. `needs` 与安装审批

`needs` 每一项是下面之一（`why` 必填，1–200 字，会原样出现在审批卡上，请写给主人看的中文）：

```jsonc
{ "member": "device:phone", "words": ["health.read"], "why": "读取你的健康数据" } // 调用某个成员的这些能力（device:* 或其他 app:*，最多 32 个）
{ "notify": true, "why": "到期时提醒你" }          // 声明过的事件可以作为提醒出现在对话里（§6）
{ "card": true, "why": "每周一张小结卡片" }        // 可以发 app.card 入口卡片（§6）
{ "widgets": true, "why": "…" }                   // 预留：桌面小组件（本版不使用）
```

- 同一个成员（或 `notify` / `card` / `widgets`）只能出现一次；不能写自己。成员和能力名用 `capability_list` / `capability_describe` 查（手机是 `device:phone`）；`apps.validate` 会提醒现在查不到的成员和能力（可能拼错了，也可能只是暂时不在线）。
- **安装**：Agent 调 `apps.install {id}`。先检查（同 `apps.validate`），不通过直接拒绝；通过后总会弹出 Ash 的审批卡（裁判不能替主人批，也没有「总是允许」）：
  - 标题：`安装「<应用名>」`；Agent 写的应用是 `安装 Ash 写的应用「<应用名>」`。
  - 正文：`<应用名> <版本>（来源）：<summary>`，来源是「Ash 自带」「Ash 自己写的，没有发布过，也没有别人检查过」或「发布者写的是「X」，Ash 无法核实」；然后「它需要：」逐项列出 `· <why>（device:phone：health.read、…）`、`· <why>（提醒你）`、`· <why>（在对话里放入口卡片）`，没有 needs 就写「不需要用 Ash 的其他东西」；最后说明文件在哪、会成为 `app:<id>`、可以随时撤销。
  - 主人批准后，这份 `needs` 原样写进授权表，应用随即启动。主人自己发起的安装就是批准本身。
- 之后应用每次调用 Ash 都按授权表检查：只有批准过的「成员 + 能力」可调，范围不会自己扩大。应用的调用以 `app:<id>` 身份经过正常的路由和关口：只读能力直接执行；其他能力弹 Ash 的审批卡由主人决定（应用的请求不经过自动审查）。应用更新后新增的 `needs` 不会自动生效，要再走一次 `apps.install`。
- 撤销：`apps.revoke {id, need?}`（`need` 是成员 id 或 `notify` / `card` / `widgets`；不填则撤销全部并停止应用）；`apps.disable / apps.enable {id}` 停用和重新打开（Agent 重新打开要主人确认）。`apps.list / apps.describe / apps.refresh` 查看和重新发现（结果里有 `path`、`origin: builtin | agent | other`、`running`、`error`）。

## 6. 事件和入口卡片（应用 → Ash）

应用通过 Ash 端点的 `ash_event {name, body}` 发事件（`body` 是对象，JSON 后 ≤ 4000 字节）：

- **声明过的事件**（`events` 里的名字）：Ash 记账，发送者是 `app:<id>`。如果主人批准了 `notify`、且 `body.text` 有内容，它会作为一张小卡出现在主人的对话里（标题取 `body.title`，没有就用应用名；正文 `body.text` ≤ 200 字；每个应用每天最多 3 张，多出的只记账）。是否叫醒主 Agent 由 Ash 的规则决定，不由应用决定。没声明的事件被拒绝。
- **`app.card {title, text?}`**（入口卡片）：需要 `card` 授权；对话里出现一张小卡「打开<应用名> · <title>」（`title` ≤ 40 字，`text` ≤ 200 字），主人点开就进入「Ash 应用」里的这个应用（第一个页面）。每个应用每天最多 1 张，多出的被拒绝。
- 发事件的时机由应用自己定（例如服务里的定时器）；试运行（`ASH_TRIAL=1`）时不要发。

## 7. Ash 给应用的端点（`ASH_MCP_URL`）

一个 Streamable HTTP 的 MCP 端点，只在本机回环上，`Authorization: Bearer $ASH_MCP_TOKEN`。无状态：每次 `POST` 一条 JSON-RPC 请求即可（不需要先 `initialize`），请求头带 `Accept: application/json, text/event-stream`；回答可能是一条 JSON，也可能是事件流里的 `data: {…}` 行。脚手架的 `server.mjs` 里有现成的 `ash(tool, args)`。

| 工具 | 作用 |
|---|---|
| `capability_list {member?}` | 本应用被授权可用的成员和能力 |
| `capability_describe {member, word?}` | 已授权能力的完整说明（`input_schema` 等） |
| `capability_call {member, word, body?}` | 调用一个已授权能力；最多等 50 秒，仍在执行或在等主人审批时返回 `pending` |
| `ash_event {name, body?}` | 发事件（§6） |

结果都是 `{ok: true, result}` 或 `{ok: false, error: {code, message, owner_text, recent?}}`（同时在 `structuredContent` 和文本里）：

- `code` / `message` 给程序和 Agent 看（`forbidden` 没授权、`pending` 还在等、`offline` 不在线、`failed` 能力自己报错……）。
- `owner_text`：**给主人看的一句中文**，页面上显示它而不是 `message`。例如手机的感知服务被系统暂时关掉、正在重启时是「感知暂时不在线，稍后再试」，手机没连上是「手机暂时没连上 Ash，稍后再试」，权限没开是「感知现在用不了：手机上相关的权限或服务可能没打开」。
- `recent`：设备暂时答不了、而 Ash 自己已经有记录时，附上最近的记录，`{as_of, source, …}`（`as_of` 是其中最新一条的时间，毫秒）。本版只有 `device:phone` 的 `health.read`：`recent.rows` 是 Ash 感知记录里同一时间段、同样格式的读数（`{ts, metric, value, unit, source}`）。页面应显示这些值并注明时间，而不是留白。

## 8. 壳 App 的接口（主人身份，Ash 已有的鉴权 HTTP 接口）

| 路由 | 返回 |
|---|---|
| `GET /api/apps` | `[{id, name, version, summary, icon: "/api/apps/<id>/icon", surfaces: [{id, title}], enabled, granted}]` |
| `GET /api/apps/<id>/icon` | 图标文件 |
| `GET /api/apps/<id>/surfaces/<surface>` | `{html, csp: {connectDomains: [], resourceDomains: []}}`（应用未运行时 503） |
| `POST /api/apps/<id>/call` `{tool, arguments}` | MCP `CallToolResult`（以主人身份调用，记账；60 秒内没结果返回 202 `{pending: true, id}`） |
| `POST /api/apps/<id>/message` `{text}` | 以主人身份给主 Agent 发一条带应用名前缀的消息，返回 `{id, seq}` |

## 9. 最小例子 hello（一个页面，一个工具）

完整文件在 `docs/examples/hello/`，容器里在 `/root/apps/_examples/hello/`（`apps.contract` 的 `example.files` 也有）。它就是 `apps.scaffold {id: "hello", name: "你好", tools: [{name: "hello.greet", title: "打招呼", read_only: true}]}` 生成后改了两处（工具的参数和实现、页面）。要试：把文件夹复制成 `/root/apps/hello/`，`apps.validate {id: "hello"}`，`apps.install {id: "hello"}`。

```text
hello/
  app.json        描述
  icon.png        图标
  server.mjs      服务：工具 hello.greet，页面 ui://hello/home；MCP 协议部分不用改
  ui/home.html    页面正文
  ui/app.css      共用样式（深浅色变量）
  ui/app.js       共用脚本：window.app（和宿主的 JSON-RPC）
```

`app.json`：

```json
{
  "contract": "ash-app/1",
  "id": "hello",
  "name": "你好",
  "version": "0.1.0",
  "icon": "icon.png",
  "summary": "最小的 Ash 应用：一个页面，一个工具",
  "publisher": "example",
  "server": { "command": "node", "args": ["server.mjs"] },
  "surfaces": [{ "id": "home", "title": "首页", "resource": "ui://hello/home" }],
  "needs": []
}
```

`server.mjs` 里要改的只有工具（其余是数据、页面拼装和协议，见文件本身）：

```js
const TOOLS = [
  {
    name: "hello.greet", title: "打招呼",
    description: "Say hello to someone (who, default 主人) with the time now.",
    inputSchema: { type: "object", properties: { who: { type: "string", minLength: 1, maxLength: 20, description: "Whom to greet" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

async function handle(name, args) {
  switch (name) {
    case "hello.greet": {
      const who = typeof args.who === "string" && args.who.trim() ? args.who.trim().slice(0, 20) : "主人";
      const now = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      if (who === "错误") throw new Error("这是一个故意的错误：页面会把这句话显示出来");
      return { text: `你好，${who}！现在是 ${now}。`, who };
    }
  }
  throw new Error(`没有这个工具：${name}`);
}
```

`ui/home.html`（页面正文；`app.css`、`app.js` 由服务拼进 `<head>`）：

```html
<h1>你好</h1>
<section data-view="main">
  <div class="card">
    <div class="row"><input id="who" maxlength="20" placeholder="主人"><button id="greet" type="button">打招呼</button></div>
    <div id="out"></div>
  </div>
  <button class="plain" type="button" onclick="app.show('about')">关于</button>
</section>
<section data-view="about" hidden>…<button class="plain" type="button" onclick="app.show('main')">返回</button></section>
<script>
document.getElementById("greet").addEventListener("click", async () => {
  const out = document.getElementById("out"), who = document.getElementById("who").value.trim();
  try { out.textContent = (await app.call("hello.greet", who ? { who } : {})).text; }
  catch (error) { out.className = "error"; out.textContent = error.message; }
});
</script>
```

装好以后：Agent `capability_call {member: "app:hello", word: "hello.greet", body: {who: "皮皮"}}` 得到 `{content: […], structuredContent: {text: "你好，皮皮！现在是 …", who: "皮皮"}}`；主人在「Ash 应用」里打开「你好」，点「打招呼」看到同一句话。

更完整的例子是 Ash 自带的「健康」：`packages/apps/health/`（三个页面、五个工具、调用 `device:phone`、发事件和入口卡片）。

## 10. 本版不包含

- 手机原生 App 和电脑上的应用。
- 桌面小组件（`widgets` 只是预留）。
- 从一个页面跳到另一个 surface（请在一页内切换视图）。
- `_meta.ui.visibility`：仅供页面调用（`["app"]`）的工具本版仍登记为普通能力。
- 应用更新后新增的 `needs` 不会单独提醒主人；要再走一次 `apps.install` 才生效。
