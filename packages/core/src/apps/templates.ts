// The files apps.scaffold writes: a dependency-free app that runs as it is. The server speaks MCP over stdio by hand
// (newline-delimited JSON-RPC 2.0), so an app needs nothing but the node already in the container. docs/examples/hello
// is built from the same pieces (a test keeps its ui/app.js and ui/app.css identical to these).
import { deflateSync } from "node:zlib";

export interface ScaffoldTool { name: string; title?: string; description?: string; read_only?: boolean }
export interface ScaffoldSurface { id: string; title: string }
export interface ScaffoldInput { id: string; name: string; summary?: string; role?: string; surfaces?: ScaffoldSurface[]; tools?: ScaffoldTool[]; publisher: string }

/** Shared by every page: the conversation with the host (MCP Apps) and a few helpers. Inlined into each page by server.mjs. */
export const APP_JS = `// 页面和 Ash 之间（MCP Apps，JSON-RPC 2.0）。每一页都会带上这个文件，页面里用 window.app：
//   await app.call("工具名", {参数})  调用本应用自己的工具，返回它的 structuredContent；失败时抛出错误，message 是工具给的说明
//   app.show("视图名")               在一页里切换 <section data-view="…">（页面内跳转）
//   await app.tell("文字")            替主人给 Ash 发一句话（主人先确认）
//   await app.openLink("https://…")   在浏览器里打开链接（主人先确认）
//   app.el("div", {class: "card"}, "文字", 子元素…)  造一个元素
// 深浅色跟着 Ash：<html data-theme="light|dark">，配色用 app.css 里的变量。
(() => {
  let next = 0;
  const waiting = new Map();
  const post = (message) => window.parent.postMessage(message, "*");
  const theme = (context) => { if (context && (context.theme === "dark" || context.theme === "light")) document.documentElement.dataset.theme = context.theme; };
  window.addEventListener("message", (event) => {
    let message = event.data;
    if (typeof message === "string") { try { message = JSON.parse(message); } catch { return; } }
    if (!message || message.jsonrpc !== "2.0") return;
    if (message.id !== undefined && !message.method && waiting.has(message.id)) {
      const item = waiting.get(message.id); waiting.delete(message.id);
      if (message.error) item.reject(new Error(message.error.message || "出错了")); else item.resolve(message.result);
    } else if (message.method === "ui/notifications/host-context-changed") theme(message.params);
  });
  const request = (method, params, ms) => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    setTimeout(() => { if (waiting.delete(id)) reject(new Error("Ash 没有回应：请在「Ash 应用」里打开这一页")); }, ms);
    post({ jsonrpc: "2.0", id, method, params });
  });
  const ready = request("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: document.title, version: "1" }, appCapabilities: {} }, 10000)
    .then((result) => {
      theme(result && result.hostContext);
      post({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
      return (result && result.hostContext) || {};
    });
  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) if (key === "class") node.className = value; else node.setAttribute(key, value);
    for (const child of children) if (child !== null && child !== undefined) node.append(child);
    return node;
  };
  window.app = {
    ready,
    el,
    async call(name, args = {}) {
      await ready;
      const result = await request("tools/call", { name, arguments: args }, 120000);
      if (!result || result.isError) throw new Error((result && result.content && result.content[0] && result.content[0].text) || "没办成");
      return result.structuredContent || {};
    },
    show(view) { for (const node of document.querySelectorAll("[data-view]")) node.hidden = node.dataset.view !== view; },
    async tell(text) { await ready; await request("ui/message", { role: "user", content: [{ type: "text", text }] }, 300000); },
    async openLink(url) { await ready; await request("ui/open-link", { url }, 300000); },
  };
})();
`;

/** Light and dark, following Ash (data-theme) and the system. */
export const APP_CSS = `/* 每一页共用的样式。颜色只用变量：深浅色跟着 Ash 切换。 */
:root{color-scheme:light dark;--bg:#ffffff;--card:#f6f6f8;--ink:#1c1c1e;--muted:#6e6e73;--line:#e5e5ea;--accent:#ff7a3d;--danger:#d33;--radius:14px;
  font-family:system-ui,-apple-system,"PingFang SC","Noto Sans CJK SC",sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#000000;--card:#1c1c1e;--ink:#f2f2f2;--muted:#a0a0a6;--line:#2c2c2e;--accent:#ff8a50;--danger:#ff6b6b}}
:root[data-theme=dark]{--bg:#000000;--card:#1c1c1e;--ink:#f2f2f2;--muted:#a0a0a6;--line:#2c2c2e;--accent:#ff8a50;--danger:#ff6b6b}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.5}
h1{font-size:20px;margin:0 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:14px;margin:0 0 12px}
.muted{color:var(--muted);font-size:13px}
.error{color:var(--danger)}
.row{display:flex;gap:8px;align-items:center}
.row>input,.row>textarea{flex:1;min-width:0}
button,input,textarea{font:inherit;color:inherit}
/* 按钮的字不折行：窄屏上也是一行，旁边的输入框让出位置。 */
button{border:0;background:var(--accent);color:#fff;border-radius:999px;padding:8px 16px;min-width:4.5em;white-space:nowrap;flex:none;line-height:1.3}
button.plain{background:var(--card);color:var(--ink);border:1px solid var(--line)}
button.small{padding:4px 10px;font-size:13px;min-width:0}
button:disabled{opacity:.5}
input,textarea{border:1px solid var(--line);background:var(--bg);border-radius:10px;padding:8px 10px;width:100%}
input[type=checkbox]{width:22px;height:22px;flex:none;margin:0;padding:0;accent-color:var(--accent)}
.list{list-style:none;margin:0 0 12px;padding:0}
.item{display:flex;align-items:center;gap:8px;padding:10px 2px;border-bottom:1px solid var(--line)}
.item label{display:flex;align-items:center;gap:10px;flex:1;min-width:0;overflow-wrap:anywhere}
.item.done span{color:var(--muted);text-decoration:line-through}
`;

const SERVER_HEAD = (name: string) => `// ${name} 的服务（Ash 应用契约 ash-app/1）。不依赖任何 npm 包：Ash 用 \`node server.mjs\` 启动它，
// 在 stdin/stdout 上说 MCP（每行一条 JSON-RPC 2.0 消息）。
//   要改的：TOOLS（有哪些工具）和 handle()（工具怎么做）。页面在 ui/ 里：ui/<页面 id>.html 是那一页的正文，
//   ui/app.css、ui/app.js 每页共用，由 page() 拼成一整页交给 Ash。页面列表来自 app.json 的 surfaces。
//   主人的数据放在 app.json 的 data_dir（data/）里：apps.reset 清空的就是它，apps.remove {keep_data} 留下的也是它。
//   stdout 只能走协议：日志请用 console.error（下面已把 console.log 转到 stderr）。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

console.log = (...args) => console.error(...args);
const DIR = process.env.ASH_APP_DIR || process.cwd();
const APP = JSON.parse(readFileSync(join(DIR, "app.json"), "utf8"));
const UI_MIME = "text/html;profile=mcp-app";

// ---- 数据：data_dir 里的一个 JSON 文件 ----
const DATA_DIR = join(DIR, APP.data_dir ?? "data");
const DATA = join(DATA_DIR, "data.json");
const load = () => { try { return existsSync(DATA) ? JSON.parse(readFileSync(DATA, "utf8")) : {}; } catch { return {}; } };
const save = (data) => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(\`\${DATA}.tmp\`, JSON.stringify(data, null, 1)); renameSync(\`\${DATA}.tmp\`, DATA); };

// ---- 回 Ash（ASH_MCP_URL）：只能用主人安装时批准的（app.json 的 needs）----
//   await ash("capability_call", { member: "device:phone", word: "health.read", body: { … } })
//   await ash("ash_event", { name: "app.card", body: { title: "…", text: "…" } })
// 结果是 { ok: true, result } 或 { ok: false, error: { code, message, owner_text, recent? } }；owner_text 是给主人看的一句话。
async function ash(tool, args) {
  const url = process.env.ASH_MCP_URL, token = process.env.ASH_MCP_TOKEN;
  const failed = (message, owner_text) => ({ ok: false, error: { code: "failed", message, owner_text } });
  if (!url || !token) return failed("not started by Ash", "要在 Ash 里运行才能用");
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
      authorization: \`Bearer \${token}\` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) });
    const text = await response.text();
    if (!response.ok) return failed(\`HTTP \${response.status}\`, "连不上 Ash，稍后再试");
    // 回答是一条 JSON，或一段事件流（data: {…}）。
    const json = text.trim().startsWith("{") ? text : text.split("\\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).pop();
    const message = JSON.parse(json ?? "{}");
    return message.result?.structuredContent ?? failed(message.error?.message ?? "no answer", "没办成，稍后再试");
  } catch (error) { return failed(error instanceof Error ? error.message : String(error), "连不上 Ash，稍后再试"); }
}
`;

const SERVER_TAIL = `
// ---- 页面：app.json 的每个 surface 是一个 ui:// 资源；每次打开都现读文件，改了页面不用重启 ----
function page(surface) {
  const read = (name) => readFileSync(join(DIR, "ui", name), "utf8");
  return \`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\` +
    \`<title>\${APP.name}</title><style>\${read("app.css")}</style><script>\${read("app.js")}</script></head>\` +
    \`<body data-page="\${surface.id}">\${read(\`\${surface.id}.html\`)}</body></html>\`;
}
function readSurface(uri) {
  const surface = (APP.surfaces ?? []).find((item) => item.resource === uri);
  if (!surface) throw new Error(\`没有这个页面：\${uri}\`);
  // csp：页面要联网时，把域名写进 connectDomains（接口）/ resourceDomains（图片、脚本、样式）；不写就是不联网。
  return { contents: [{ uri, mimeType: UI_MIME, text: page(surface), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }] };
}

// ---- 工具调用：handle() 返回的对象就是结果（structuredContent）；抛出的错误变成 isError，message 给人看 ----
async function callTool(name, args) {
  if (!TOOLS.some((tool) => tool.name === name)) return { content: [{ type: "text", text: \`没有这个工具：\${name}\` }], isError: true };
  try {
    const result = await handle(name, args ?? {});
    const data = result && typeof result === "object" && !Array.isArray(result) ? result : { value: result ?? null };
    // 改数据的工具可以在结果里带 activity：一句话说这次改了什么（如「勾掉了：给物业打电话」）。主人在页面里改的时候，Ash 看到的就是这句话。
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data,
      ...(typeof data.activity === "string" ? { _meta: { activity: data.activity } } : {}) };
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

// ---- MCP 协议（一般不用改）：initialize、tools/list、tools/call、resources/list、resources/read、ping ----
const send = (message) => process.stdout.write(\`\${JSON.stringify(message)}\\n\`);
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  if (!line.trim()) return;
  let message;
  try { message = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  // 通知（如 notifications/initialized）和对方的回答都不用回。
  if (message.id === undefined || message.id === null || typeof message.method !== "string") return;
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code, text) => send({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
  try {
    switch (message.method) {
      case "initialize": return reply({ protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {}, resources: {} }, serverInfo: { name: APP.id, version: APP.version } });
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call": return reply(await callTool(message.params?.name, message.params?.arguments));
      case "resources/list": return reply({ resources: (APP.surfaces ?? []).map((item) => ({ uri: item.resource, name: item.title, mimeType: UI_MIME })) });
      case "resources/read": return reply(readSurface(message.params?.uri));
      default: return fail(-32601, \`Method not found: \${message.method}\`);
    }
  } catch (error) { fail(-32603, error instanceof Error ? error.message : String(error)); }
});
lines.on("close", () => process.exit(0));
`;

const js = (value: unknown) => JSON.stringify(value);

type Tool = Required<Pick<ScaffoldTool, "name" | "title" | "description" | "read_only">>;

/** The working list every new app starts with: its tools, by name suffix. */
const LIST_TOOLS: { suffix: string; title: string; description: string; read_only: boolean; input: string }[] = [
  { suffix: "list", title: "看清单", description: "Every item, open ones first: {items:[{id, title, done, at}]}.", read_only: true,
    input: `{ type: "object", properties: {}, additionalProperties: false }` },
  { suffix: "add", title: "加一条", description: "Add an item: title.", read_only: false,
    input: `{ type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 200 } }, required: ["title"], additionalProperties: false }` },
  { suffix: "done", title: "标记完成", description: "Mark an item (its id) done (done: true) or not done (done: false).", read_only: false,
    input: `{ type: "object", properties: { item: { type: "string", minLength: 1 }, done: { type: "boolean" } }, required: ["item", "done"], additionalProperties: false }` },
  { suffix: "remove", title: "删掉一条", description: "Remove an item (its id).", read_only: false,
    input: `{ type: "object", properties: { item: { type: "string", minLength: 1 } }, required: ["item"], additionalProperties: false }` },
  { suffix: "card", title: "画桌面卡片", description: "The home-screen card (A2UI) drawn from the list. Ash calls it whenever the app's data changes.", read_only: true,
    input: `{ type: "object", properties: {}, additionalProperties: false }` },
  { suffix: "card.tap", title: "在桌面卡片上勾选", description: "A tap on the home-screen card (sent by Ash): ticks or unticks the item.", read_only: false,
    input: `{ type: "object", properties: { card: { type: "string" }, action: { type: "string" }, component: { type: "string" }, item: { type: "string" }, checked: { type: "boolean" },\n      value: { type: "array", items: { type: "string" } }, context: { type: "object" } }, required: ["card", "action"], additionalProperties: false }` },
];

/** What each list tool does, in server.mjs. */
const LIST_CASES: Record<string, string> = {
  list: `{ const items = load().items ?? []; return { items: [...items.filter((item) => !item.done), ...items.filter((item) => item.done)] }; }`,
  add: `{
      const title = String(args.title ?? "").trim().slice(0, 200);
      if (!title) throw new Error("要写点什么");
      const data = load();
      const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title, done: false, at: Date.now() };
      data.items = [...(data.items ?? []), item];
      save(data);
      return { item, activity: \`加了一条：\${title}\` };
    }`,
  done: `{
      const data = load(), item = find(data, args.item);
      item.done = args.done !== false;
      save(data);
      return { item, activity: \`\${item.done ? "勾掉了" : "取消了勾选"}：\${item.title}\` };
    }`,
  remove: `{
      const data = load(), item = find(data, args.item);
      data.items = data.items.filter((entry) => entry !== item);
      save(data);
      return { removed: item.id, activity: \`删掉了：\${item.title}\` };
    }`,
  card: `return card();`,
  "card.tap": `{
      // 卡片上一条的勾选框：item 是那一条的 id，checked 是勾上还是取消。别的点击（没有 item）这里不用管。
      if (args.item === undefined) return { ignored: true };
      const data = load(), item = find(data, args.item);
      item.done = typeof args.checked === "boolean" ? args.checked : !item.done;
      save(data);
      return { item, activity: \`在桌面卡片上\${item.done ? "勾掉了" : "取消了勾选"}：\${item.title}\` };
    }`,
};

const CARD_FUNCTION = (id: string) => `
// ---- 桌面卡片（app.json 的 cards）：数据一变（页面、Agent、卡片上点的都算），Ash 就调用 ${id}.card 重画；
// 主人点卡片上的勾选框，Ash 调用 ${id}.card.tap {card, action, item, checked}。卡片的格式和 widget.card.put 的 a2ui 一样（A2UI：components + data）。
function card() {
  const items = load().items ?? [];
  const open = items.filter((item) => !item.done);
  const shown = [...open, ...items.filter((item) => item.done)].slice(0, 30);
  return {
    components: [
      { id: "root", component: "Column", children: ["head", "list", "empty"] },
      { id: "head", component: "Row", align: "center", children: ["title", "left"], action: { openApp: { app: APP.id } } },
      { id: "title", component: "Text", text: APP.name, variant: "h4", weight: 1 },
      { id: "left", component: "Badge", text: { path: "/left" } },
      { id: "list", component: "List", children: { componentId: "row", path: "/items" } },
      { id: "row", component: "CheckBox", label: { path: "title" }, value: { path: "done" }, action: { event: { name: "toggle" } } },
      { id: "empty", component: "Text", text: "还没有，或者都做完了", variant: "caption", visible: { path: "/empty" } },
    ],
    data: { left: String(open.length), empty: shown.length === 0, items: shown.map(({ id, title, done }) => ({ id, title, done })) },
  };
}
`;

/** server.mjs: the working list, its card, and each further tool answering with a placeholder until it is written. */
export function serverTemplate(id: string, name: string, list: Tool[], extra: Tool[]): string {
  const listed = list.map((tool, index) => `  {\n    name: ${js(tool.name)}, title: ${js(tool.title)},\n    description: ${js(tool.description)},\n` +
    `    inputSchema: ${LIST_TOOLS[index]!.input},\n    annotations: { readOnlyHint: ${tool.read_only} },\n  },`);
  const more = extra.map((tool) => `  {\n    name: ${js(tool.name)}, title: ${js(tool.title)},\n    description: ${js(tool.description)},\n` +
    `    inputSchema: { type: "object", properties: {}, additionalProperties: false },\n` +
    `    annotations: { readOnlyHint: ${tool.read_only} },\n  },`);
  const cases = [
    ...list.map((tool, index) => `    case ${js(tool.name)}: ${LIST_CASES[LIST_TOOLS[index]!.suffix]}`),
    ...extra.map((tool) => `    case ${js(tool.name)}:\n      // TODO：在这里写「${tool.title}」。args 是调用参数（按 inputSchema）。\n` +
      `      return { text: ${js(`「${tool.title}」还没写好：在 server.mjs 的 handle() 里实现它。`)}, args };`),
  ].join("\n");
  return `${SERVER_HEAD(name)}
// ---- 工具：Agent 用 capability_call {member: "app:${id}", word: 工具名} 调用，页面用 app.call(工具名) 调用 ----
// readOnlyHint: true 是只读，其余都算「改数据」。Agent 和主人（页面里点、桌面卡片上点）都直接用，不弹审批卡：主人安装时已经批准了这个应用。
// 开头这几个是一张能用的清单（data.json 的 items）：改成这个应用真正要管的东西。
const TOOLS = [
${[...listed, ...more].join("\n")}
];

// 要存东西：const data = load(); …; save(data);
const find = (data, id) => {
  const item = (data.items ?? []).find((entry) => entry.id === String(id));
  if (!item) throw new Error("没有这一条：可能已经删掉了");
  return item;
};

// 改数据的工具返回 activity（一句话说改了什么）：主人在页面或卡片上改的时候，Ash 看到的就是这句话。
async function handle(name, args) {
  switch (name) {
${cases}
  }
  throw new Error(\`没有这个工具：\${name}\`);
}
${CARD_FUNCTION(id)}${SERVER_TAIL}`;
}

/** The first page: the list with done/undone toggles and a box to add one; the other pages are empty to fill. */
export function pageTemplate(surface: ScaffoldSurface, first: boolean, id: string): string {
  if (!first) return `<h1>${surface.title}</h1>\n<div class="card muted">这一页还空着：在 ui/${surface.id}.html 里写它。</div>\n`;
  return `<h1>${surface.title}</h1>
<section data-view="main">
  <form id="add" class="card row"><input id="title" maxlength="200" placeholder="写一条…" autocomplete="off"><button type="submit">加一条</button></form>
  <ul id="list" class="list"></ul>
  <div id="out" class="muted"></div>
  <button class="plain" type="button" onclick="app.show('about')">关于</button>
</section>
<section data-view="about" hidden>
  <div class="card">同一页里的另一个视图：用 app.show("视图名") 切换，不用另开页面。这里的每个操作都是调用工具（app.call），Ash 用的是同一套工具。</div>
  <button class="plain" type="button" onclick="app.show('main')">返回</button>
</section>
<script>
(() => {
  const list = document.getElementById("list"), out = document.getElementById("out"), input = document.getElementById("title");
  const say = (text, error) => { out.className = error ? "error" : "muted"; out.textContent = text; };
  async function refresh() {
    try {
      const { items = [] } = await app.call(${js(`${id}.list`)});
      list.replaceChildren(...items.map((item) => {
        const box = app.el("input", { type: "checkbox", "aria-label": "做完了" });
        box.checked = item.done;
        box.addEventListener("change", async () => {
          box.disabled = true;
          try { await app.call(${js(`${id}.done`)}, { item: item.id, done: box.checked }); await refresh(); }
          catch (error) { box.checked = !box.checked; box.disabled = false; say(error.message, true); }
        });
        const remove = app.el("button", { type: "button", class: "plain small" }, "删掉");
        remove.addEventListener("click", async () => {
          try { await app.call(${js(`${id}.remove`)}, { item: item.id }); await refresh(); } catch (error) { say(error.message, true); }
        });
        return app.el("li", { class: item.done ? "item done" : "item" }, app.el("label", {}, box, app.el("span", {}, item.title)), remove);
      }));
      say(items.length ? "" : "还没有。写一条，或者让 Ash 帮你记。");
    } catch (error) { say(error.message, true); }
  }
  document.getElementById("add").addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = input.value.trim();
    if (!title) return;
    try { await app.call(${js(`${id}.add`)}, { title }); input.value = ""; await refresh(); } catch (error) { say(error.message, true); }
  });
  // Ash 或桌面卡片也会改数据：回到这一页时重新读。
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  refresh();
})();
</script>
`;
}

/** Every file of a new app, by its path inside the app folder. */
export function scaffoldFiles(input: ScaffoldInput): Record<string, string | Buffer> {
  const surfaces = input.surfaces?.length ? input.surfaces : [{ id: "home", title: "首页" }];
  // The working list's tools; a tool the agent named the same keeps its title and description.
  const given = new Map((input.tools ?? []).map((tool) => [tool.name, tool]));
  const list = LIST_TOOLS.map((tool) => {
    const name = `${input.id}.${tool.suffix}`, mine = given.get(name);
    return { name, title: mine?.title ?? tool.title, description: mine?.description ?? tool.description, read_only: tool.read_only };
  });
  const extra = (input.tools ?? []).filter((tool) => !list.some((item) => item.name === tool.name))
    .map((tool) => ({ name: tool.name, title: tool.title ?? tool.name, description: tool.description ?? tool.title ?? tool.name, read_only: tool.read_only ?? false }));
  const manifest = {
    contract: "ash-app/1", id: input.id, name: input.name, version: "0.1.0", icon: "icon.png", summary: input.summary ?? input.name,
    // What this organ is for and when Ash uses it; the agent sees it in every conversation. Sharpen it when the app grows.
    role: input.role ?? input.summary ?? input.name, publisher: input.publisher,
    server: { command: "node", args: ["server.mjs"] },
    // The owner's data lives here: apps.reset empties it, apps.remove {keep_data} keeps it.
    data_dir: "data",
    surfaces: surfaces.map((surface) => ({ id: surface.id, title: surface.title, resource: `ui://${input.id}/${surface.id}` })),
    // A home-screen card drawn from the app's data (server.mjs card()); a tick on it calls the action tool.
    cards: [{ id: "main", title: input.name.slice(0, 40), size: "4x4", tool: `${input.id}.card`, action: `${input.id}.card.tap` }],
    needs: [],
  };
  const files: Record<string, string | Buffer> = {
    "app.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "server.mjs": serverTemplate(input.id, input.name, list, extra),
    "ui/app.js": APP_JS,
    "ui/app.css": APP_CSS,
    "icon.png": iconPng(input.id),
  };
  surfaces.forEach((surface, index) => { files[`ui/${surface.id}.html`] = pageTemplate(surface, index === 0, input.id); });
  return files;
}

// ---- A plain icon (PNG, so the phone can draw it): a rounded square in a colour of the id, with a white dot. ----
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (bytes: Buffer) => { let c = 0xffffffff; for (const byte of bytes) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => {
  const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
};

export function iconPng(seed: string, size = 192): Buffer {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  const hue = hash % 360, s = 0.62, l = 0.52;
  const f = (n: number) => { const k = (n + hue / 30) % 12; return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  const [r, g, b] = [f(0), f(8), f(4)];
  const radius = size * 0.22, dot = size * 0.2, c = (size - 1) / 2;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const dx = Math.max(radius - x, 0, x - (size - 1 - radius)), dy = Math.max(radius - y, 0, y - (size - 1 - radius));
      const inside = dx * dx + dy * dy <= radius * radius;
      const white = (x - c) ** 2 + (y - c) ** 2 <= dot * dot;
      const at = y * (size * 4 + 1) + 1 + x * 4;
      if (inside) { raw[at] = white ? 255 : r; raw[at + 1] = white ? 255 : g; raw[at + 2] = white ? 255 : b; raw[at + 3] = 255; }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
