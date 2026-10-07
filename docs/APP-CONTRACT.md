# Ash 应用契约 `ash-app/1`

版本：`ash-app/1`（2026-10）。任何应用——Ash 自带的，或第三方写的——按这份契约提供一个服务，就成为 Ash 体系的一员：

- **对 Agent**：应用的 MCP 工具成为 Ash 成员 `app:<id>` 的能力（words），Agent 用已有的 `capability_list / capability_describe / capability_call` 调用。
- **对人**：应用用 [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)（`ui://` HTML 资源）提供界面，由独立的壳 App「Ash 应用」在隔离的 WebView 里画出来。Ash 的对话里最多出现一张「打开 XX」入口卡片。
- **对 Ash**：应用要用 Ash 的东西（例如手机的健康数据），只能用主人在安装时批准过的范围（grants）。

本版只定义**容器里的应用**：应用是 Ash 容器里的一个文件夹 `/root/apps/<id>/`，服务是一个 stdio MCP 服务器。手机原生 App 和电脑上的应用是以后的版本。

## 1. 应用描述 `app.json`

放在 `/root/apps/<id>/app.json`。机器校验用的 JSON Schema：[`docs/app.schema.json`](app.schema.json)（Ash 启动和 `apps.refresh` 时用它校验；不合格的应用被跳过，原因记在日志和 `apps.list` 的 `error` 里）。

| 字段 | 必填 | 说明 |
|---|---|---|
| `contract` | 是 | 固定为 `"ash-app/1"` |
| `id` | 是 | `^[a-z][a-z0-9-]{0,47}$`，必须和文件夹名相同。第三方用发布者前缀避免重名，如 `example-notes`（本版不支持点号的反向域名） |
| `name` | 是 | 显示名，≤ 40 字 |
| `version` | 是 | `主.次.修`，如 `1.0.0` |
| `icon` | 否 | 同目录下的 `.png` / `.svg` / `.webp` 文件名 |
| `summary` | 是 | 一句话说明，≤ 200 字 |
| `publisher` | 是 | 发布者 |
| `server` | 是 | `{command, args?, env?}`：MCP 服务器的启动命令，在容器里以应用目录为工作目录运行。`env` 的键不能以 `ASH_` 开头 |
| `surfaces` | 否 | `[{id, title, resource}]`：打开应用时可见的页面，`resource` 是 `ui://` URI（服务器的 MCP 资源） |
| `events` | 否 | 应用会发给 Ash 的事件名，如 `health.alert`（必须含一个点；`app.card` 是内置的，不用声明） |
| `needs` | 否 | 要用 Ash 的什么，安装时主人逐项看到、一次批准（见 §5） |
| `tools` | 否 | 仅供阅读；以服务器 `tools/list` 为准 |

`needs` 每一项是下面之一：

```jsonc
{ "member": "device:phone", "words": ["health.read"], "why": "读取你的健康数据" } // 调用某个成员的某些能力（device:* 或 app:*）
{ "notify": true, "why": "异常时提醒你" }     // 事件可以作为提醒出现在对话里（Ash 限频）
{ "card": true, "why": "每周一张小结卡片" }   // 可以发 app.card 入口卡片（每天最多 1 张）
{ "widgets": true, "why": "…" }              // 预留：桌面小组件（本版不使用）
```

## 2. 服务（MCP 服务器）

- Ash 在容器里用 stdio 启动 `server.command server.args…`，工作目录是应用目录，环境变量：

| 变量 | 含义 |
|---|---|
| `ASH_APP_ID` | 应用 id |
| `ASH_APP_DIR` | 应用目录（容器里是 `/root/apps/<id>`）；应用自己的数据放这里 |
| `ASH_MCP_URL` | 应用回调 Ash 的 MCP 端点（Streamable HTTP，本机回环） |
| `ASH_MCP_TOKEN` | 该端点的凭证（`Authorization: Bearer …`），每次启动都换 |

- 只有主人安装（批准 `needs`）且未停用的应用才会被启动。崩溃后 Ash 按 1 秒起、翻倍、最长 1 分钟的间隔重启；停用、撤销全部授权或删除文件夹后停止。
- 服务器的 `tools/list` 决定成员 `app:<id>` 的能力：
  - 名字必须匹配 `^[a-z][a-z0-9_.-]{0,63}$`（例如 `health.today`），否则不登记；`inputSchema` 必须是 `type: "object"` 的 JSON Schema（Ajv 严格模式编译，编译不过的工具单独被拒）。
  - **风险由 Ash 定**：只有 `annotations.readOnlyHint: true` 且不是 `destructiveHint: true` 的工具算只读（risk `none` / effect `read`）；其余一律按「改数据」（risk `structure` / effect `write`）走 Ash 的审批关口。
  - 审批卡上的名字由 Ash 写：`在<应用名>里<工具 title>`。
- 工具调用：`tools/call` 的结果原样作为 `{content, structuredContent?}` 返回；`isError: true` 视为失败。

## 3. 界面（MCP Apps）

直接采用 MCP Apps 规范（`2026-01-26`）：

- 界面是 MCP 资源，URI 以 `ui://` 开头，`mimeType` 为 `text/html;profile=mcp-app`；工具可以在 `_meta.ui.resourceUri` 里关联一个界面。
- 资源的 `_meta.ui.csp`（`connectDomains`、`resourceDomains`）声明界面要访问的域名；不声明就是不联网。
- 界面放在壳 App 的**每个应用一个**的隔离 WebView 里，和宿主之间只用 MCP Apps 的 JSON-RPC：`ui/initialize`、`ui/notifications/initialized`、`tools/call`、`ui/notifications/size-changed`、`ui/open-link`、`ui/message`，宿主发 `ui/notifications/host-context-changed`（`theme: light|dark`）。
- 传输：在 iframe 里用 `window.parent.postMessage`（对象）；在安卓 WebView 里宿主可以先递过来一个 `MessagePort`，之后两边在这个端口上收发 **JSON 字符串**。界面应同时支持两种（参考 `packages/apps/health/ui/shared.html`）。
- **界面只能调用本应用自己的工具**，调不到别的应用和 Ash 的能力。应用要用 Ash 的东西，只能由它的服务端在授权范围内去调（§5）。
- 界面发起的改数据操作经壳 App 以主人身份调用，记入 Ash 的账本；需要审批的，**审批卡由 Ash 自己弹**，不在应用界面里批。
- `ui/message` 被转成主人发给主 Agent 的一条消息，前面标明应用名。

## 4. 事件（应用 → Ash）

应用通过 Ash 端点的 `ash_event {name, body}` 发事件（body ≤ 4000 字节）：

- **声明过的事件**（`events` 里的名字）：Ash 记账（发送者是 `app:<id>`）。如果主人批准了 `notify`、且 `body.text` 有内容，Ash 让它作为入口卡片出现在对话里（每个应用每天最多 3 条）；是否叫醒主 Agent 由 Ash 的规则决定，不由应用决定。
- **`app.card {title, text}`**：需要 `card` 授权；对话里出现一张小卡「打开<应用名> · <title>」，点开进入壳 App 里的这个应用。每个应用每天最多 1 张，多出的被拒绝。

## 5. 授权（grants）

- 安装：Agent 调用 `service:apps` 的 `apps.install {id}`。这总会弹出 Ash 的审批卡，列出应用的全部 `needs` 和理由；主人批准后，这份 `needs` 原样写进 Ash 的授权表（`app-grants.json`），应用随即启动。主人自己发起的安装就是批准本身。
- 之后应用每次调用 Ash 都按授权表检查：只有批准过的「成员 + 能力」可调，范围不会自己扩大。应用版本更新后新增的 `needs` 不会自动生效，要再走一次安装。
- 应用的调用以 `app:<id>` 身份经过正常的路由和关口：只读能力直接执行；其他能力弹 Ash 的审批卡由主人决定（应用的请求不经过自动审查）。
- 撤销：`apps.revoke {id, need?}`（`need` 是成员 id 或 `notify` / `card` / `widgets`；不填则撤销全部并停止应用）；`apps.disable / apps.enable {id}` 停用和重新打开（重新打开同样要主人确认）。`apps.list / apps.describe / apps.refresh` 查看和重新发现。

### Ash 给应用的 MCP 端点（`ASH_MCP_URL`）

| 工具 | 作用 |
|---|---|
| `capability_list {member?}` | 本应用被授权可用的成员和能力 |
| `capability_describe {member, word?}` | 已授权能力的完整说明（input_schema 等） |
| `capability_call {member, word, body?}` | 调用一个已授权能力；最多等 50 秒，仍在执行或等主人审批时返回 `pending` |
| `ash_event {name, body?}` | 发事件（§4） |

结果都是 `{ok: true, result}` 或 `{ok: false, error: {code, message}}`（同时在 `structuredContent` 和文本里）。

## 6. 壳 App 的接口（主人身份，Ash 已有的鉴权 HTTP 接口）

| 路由 | 返回 |
|---|---|
| `GET /api/apps` | `[{id, name, version, summary, icon: "/api/apps/<id>/icon", surfaces: [{id, title}], enabled, granted}]` |
| `GET /api/apps/<id>/icon` | 图标文件 |
| `GET /api/apps/<id>/surfaces/<surface>` | `{html, csp: {connectDomains: [], resourceDomains: []}}`（应用未运行时 503） |
| `POST /api/apps/<id>/call` `{tool, arguments}` | MCP `CallToolResult`（以主人身份调用，记账；60 秒内没结果返回 202 `{pending: true, id}`） |
| `POST /api/apps/<id>/message` `{text}` | 以主人身份给主 Agent 发一条带应用名前缀的消息，返回 `{id, seq}` |

## 7. 最小例子

```text
/root/apps/hello/
  app.json
  server.mjs
```

```json
{
  "contract": "ash-app/1",
  "id": "hello",
  "name": "你好",
  "version": "0.1.0",
  "summary": "最小的 Ash 应用",
  "publisher": "example",
  "server": { "command": "node", "args": ["server.mjs"] },
  "surfaces": [{ "id": "home", "title": "首页", "resource": "ui://hello/home" }],
  "needs": [{ "card": true, "why": "打个招呼" }]
}
```

```js
// server.mjs — @modelcontextprotocol/sdk
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "hello", version: "0.1.0" }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
  name: "hello.greet", title: "打招呼", description: "Say hello.",
  inputSchema: { type: "object", properties: { who: { type: "string" } }, additionalProperties: false },
  annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: "ui://hello/home" } } }] }));
server.setRequestHandler(CallToolRequestSchema, async (call) => {
  const text = `你好，${call.params.arguments?.who ?? "主人"}`;
  return { content: [{ type: "text", text }], structuredContent: { text } };
});
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: "ui://hello/home", name: "首页", mimeType: "text/html;profile=mcp-app" }] }));
server.setRequestHandler(ReadResourceRequestSchema, async () => ({ contents: [{ uri: "ui://hello/home", mimeType: "text/html;profile=mcp-app",
  text: "<!doctype html><p id=o>…</p><script>/* ui/initialize, then tools/call hello.greet */</script>" }] }));
await server.connect(new StdioServerTransport());
```

完整的例子是 Ash 自带的「健康」：`packages/apps/health/`。

## 8. 本版不包含

- 手机原生 App（`ai.ash.APP` 服务意图）和电脑上的应用。
- 桌面小组件（`widgets` 只是预留）。
- `_meta.ui.visibility`：仅供界面调用（`["app"]`）的工具本版仍登记为普通能力。
- 应用更新后新增的 `needs` 不会单独提醒主人；要再走一次 `apps.install` 才生效。
