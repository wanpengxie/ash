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
//   数据放在 ASH_APP_DIR（就是这个文件夹）里，例如 data.json。
//   stdout 只能走协议：日志请用 console.error（下面已把 console.log 转到 stderr）。
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

console.log = (...args) => console.error(...args);
const DIR = process.env.ASH_APP_DIR || process.cwd();
const APP = JSON.parse(readFileSync(join(DIR, "app.json"), "utf8"));
const UI_MIME = "text/html;profile=mcp-app";

// ---- 数据：这个应用自己的一个 JSON 文件 ----
const DATA = join(DIR, "data.json");
const load = () => { try { return existsSync(DATA) ? JSON.parse(readFileSync(DATA, "utf8")) : {}; } catch { return {}; } };
const save = (data) => { writeFileSync(\`\${DATA}.tmp\`, JSON.stringify(data, null, 1)); renameSync(\`\${DATA}.tmp\`, DATA); };

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

/** server.mjs for the given tools: each answers with a placeholder until it is written. */
export function serverTemplate(id: string, name: string, tools: Required<Pick<ScaffoldTool, "name" | "title" | "description" | "read_only">>[]): string {
  const list = tools.map((tool) => `  {\n    name: ${js(tool.name)}, title: ${js(tool.title)},\n    description: ${js(tool.description)},\n` +
    `    inputSchema: { type: "object", properties: {}, additionalProperties: false },\n` +
    `    annotations: { readOnlyHint: ${tool.read_only} },\n  },`).join("\n");
  const cases = tools.map((tool) => `    case ${js(tool.name)}:\n      // TODO：在这里写「${tool.title}」。args 是调用参数（按 inputSchema）。\n` +
    `      return { text: ${js(`「${tool.title}」还没写好：在 server.mjs 的 handle() 里实现它。`)}, args };`).join("\n");
  return `${SERVER_HEAD(name)}
// ---- 工具：Agent 用 capability_call {member: "app:${id}", word: 工具名} 调用，页面用 app.call(工具名) 调用 ----
// readOnlyHint: true 是只读，其余都算「改数据」。Agent 和主人（页面里点）都直接用，不弹审批卡：主人安装时已经批准了这个应用。
const TOOLS = [
${list}
];

// 要存东西：const data = load(); …; save(data);
async function handle(name, args) {
  switch (name) {
${cases}
  }
  throw new Error(\`没有这个工具：\${name}\`);
}
${SERVER_TAIL}`;
}

/** The body of one page: the first page tries the first tool; the others are empty pages to fill. */
export function pageTemplate(surface: ScaffoldSurface, first: boolean, tool: { name: string; title: string } | null): string {
  if (!first || !tool) return `<h1>${surface.title}</h1>\n<div class="card muted">这一页还空着：在 ui/${surface.id}.html 里写它。</div>\n`;
  return `<h1>${surface.title}</h1>
<section data-view="main">
  <div class="card">
    <div class="muted">点一下，调用工具 ${tool.name}</div>
    <div class="row" style="margin-top:8px"><button id="run" type="button">${tool.title}</button></div>
    <div id="out" style="margin-top:8px"></div>
  </div>
  <button class="plain" type="button" onclick="app.show('about')">关于</button>
</section>
<section data-view="about" hidden>
  <div class="card">同一页里的另一个视图：用 app.show("视图名") 切换，不用另开页面。</div>
  <button class="plain" type="button" onclick="app.show('main')">返回</button>
</section>
<script>
(() => {
  const out = document.getElementById("out");
  document.getElementById("run").addEventListener("click", async () => {
    out.className = "muted"; out.textContent = "正在调用…";
    try { const result = await app.call(${js(tool.name)}); out.className = ""; out.textContent = result.text ?? JSON.stringify(result); }
    catch (error) { out.className = "error"; out.textContent = error.message; }
  });
})();
</script>
`;
}

/** Every file of a new app, by its path inside the app folder. */
export function scaffoldFiles(input: ScaffoldInput): Record<string, string | Buffer> {
  const surfaces = input.surfaces?.length ? input.surfaces : [{ id: "home", title: "首页" }];
  const tools = (input.tools?.length ? input.tools : [{ name: `${input.id}.status`, title: "看状态", description: "What the app has now.", read_only: true }])
    .map((tool) => ({ name: tool.name, title: tool.title ?? tool.name, description: tool.description ?? tool.title ?? tool.name, read_only: tool.read_only ?? false }));
  const manifest = {
    contract: "ash-app/1", id: input.id, name: input.name, version: "0.1.0", icon: "icon.png", summary: input.summary ?? input.name,
    // What this organ is for and when Ash uses it; the agent sees it in every conversation. Sharpen it when the app grows.
    role: input.role ?? input.summary ?? input.name, publisher: input.publisher,
    server: { command: "node", args: ["server.mjs"] },
    surfaces: surfaces.map((surface) => ({ id: surface.id, title: surface.title, resource: `ui://${input.id}/${surface.id}` })),
    needs: [],
  };
  const files: Record<string, string | Buffer> = {
    "app.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "server.mjs": serverTemplate(input.id, input.name, tools),
    "ui/app.js": APP_JS,
    "ui/app.css": APP_CSS,
    "icon.png": iconPng(input.id),
  };
  const firstTool = tools.find((tool) => tool.read_only) ?? tools[0] ?? null;
  surfaces.forEach((surface, index) => { files[`ui/${surface.id}.html`] = pageTemplate(surface, index === 0, firstTool); });
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
