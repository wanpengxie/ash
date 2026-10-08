// 你好 的服务（Ash 应用契约 ash-app/1）。不依赖任何 npm 包：Ash 用 `node server.mjs` 启动它，
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
const save = (data) => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(`${DATA}.tmp`, JSON.stringify(data, null, 1)); renameSync(`${DATA}.tmp`, DATA); };

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
      authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) });
    const text = await response.text();
    if (!response.ok) return failed(`HTTP ${response.status}`, "连不上 Ash，稍后再试");
    // 回答是一条 JSON，或一段事件流（data: {…}）。
    const json = text.trim().startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).pop();
    const message = JSON.parse(json ?? "{}");
    return message.result?.structuredContent ?? failed(message.error?.message ?? "no answer", "没办成，稍后再试");
  } catch (error) { return failed(error instanceof Error ? error.message : String(error), "连不上 Ash，稍后再试"); }
}

// ---- 工具：Agent 用 capability_call {member: "app:hello", word: 工具名} 调用，页面用 app.call(工具名) 调用 ----
// readOnlyHint: true 是只读，其余都算「改数据」。Agent 和主人（页面里点）都直接用，不弹审批卡：主人安装时已经批准了这个应用。
const TOOLS = [
  {
    name: "hello.greet", title: "打招呼",
    description: "Say hello to someone (who, default 主人) with the time now.",
    inputSchema: { type: "object", properties: { who: { type: "string", minLength: 1, maxLength: 20, description: "Whom to greet" } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

// 要存东西：const data = load(); …; save(data);
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

// ---- 页面：app.json 的每个 surface 是一个 ui:// 资源；每次打开都现读文件，改了页面不用重启 ----
function page(surface) {
  const read = (name) => readFileSync(join(DIR, "ui", name), "utf8");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${APP.name}</title><style>${read("app.css")}</style><script>${read("app.js")}</script></head>` +
    `<body data-page="${surface.id}">${read(`${surface.id}.html`)}</body></html>`;
}
function readSurface(uri) {
  const surface = (APP.surfaces ?? []).find((item) => item.resource === uri);
  if (!surface) throw new Error(`没有这个页面：${uri}`);
  // csp：页面要联网时，把域名写进 connectDomains（接口）/ resourceDomains（图片、脚本、样式）；不写就是不联网。
  return { contents: [{ uri, mimeType: UI_MIME, text: page(surface), _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }] };
}

// ---- 工具调用：handle() 返回的对象就是结果（structuredContent）；抛出的错误变成 isError，message 给人看 ----
async function callTool(name, args) {
  if (!TOOLS.some((tool) => tool.name === name)) return { content: [{ type: "text", text: `没有这个工具：${name}` }], isError: true };
  try {
    const result = await handle(name, args ?? {});
    const data = result && typeof result === "object" && !Array.isArray(result) ? result : { value: result ?? null };
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

// ---- MCP 协议（一般不用改）：initialize、tools/list、tools/call、resources/list、resources/read、ping ----
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
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
      default: return fail(-32601, `Method not found: ${message.method}`);
    }
  } catch (error) { fail(-32603, error instanceof Error ? error.message : String(error)); }
});
lines.on("close", () => process.exit(0));
