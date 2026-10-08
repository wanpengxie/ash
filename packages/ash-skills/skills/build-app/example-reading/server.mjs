// 阅读记录 的服务（Ash 应用契约 ash-app/1）。不依赖任何 npm 包：Ash 用 `node server.mjs` 启动它，
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

// ---- 工具：Agent 用 capability_call {member: "app:reading", word: 工具名} 调用，页面用 app.call(工具名) 调用 ----
// 读的标 readOnlyHint: true，改数据的标 false。页面上每个能做的操作，都有一个对应的工具。
const id = { type: "string", minLength: 1, description: "The book's id from reading.list" };
const TOOLS = [
  {
    name: "reading.list", title: "看书架",
    description: "The owner's books, reading first, then want-to-read, then finished: {books:[{id, title, author, status: want|reading|done, page, pages, rating, finished_at}]}. Optional status filter.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["want", "reading", "done"] } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "reading.add", title: "加一本书",
    description: "Add a book. status defaults to want (want to read); use reading for a book already started. pages is the total page count if known.",
    inputSchema: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 120 }, author: { type: "string", maxLength: 80 },
      status: { type: "string", enum: ["want", "reading"] }, pages: { type: "integer", minimum: 1, maximum: 10000 } }, required: ["title"], additionalProperties: false },
    annotations: { readOnlyHint: false },
  },
  {
    name: "reading.progress", title: "记阅读进度",
    description: "Record how far the owner has read (page). Starts the book if it was only wanted; a page at or past the total pages finishes it.",
    inputSchema: { type: "object", properties: { book: id, page: { type: "integer", minimum: 0, maximum: 10000 } }, required: ["book", "page"], additionalProperties: false },
    annotations: { readOnlyHint: false },
  },
  {
    name: "reading.finish", title: "标记读完",
    description: "Mark a book finished (done: true, the default) or put it back to reading (done: false). rating 1-5 is optional.",
    inputSchema: { type: "object", properties: { book: id, done: { type: "boolean" }, rating: { type: "integer", minimum: 1, maximum: 5 } }, required: ["book"], additionalProperties: false },
    annotations: { readOnlyHint: false },
  },
  {
    name: "reading.remove", title: "删掉一本书",
    description: "Remove a book from the shelf.",
    inputSchema: { type: "object", properties: { book: id }, required: ["book"], additionalProperties: false },
    annotations: { readOnlyHint: false },
  },
  {
    name: "reading.stats", title: "看阅读统计",
    description: "Counts by status, books finished this year, and finished per month for the last 6 months: {want, reading, done, this_year, months:[{month: 'YYYY-MM', done}]}.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "reading.card", title: "画桌面卡片",
    description: "The home-screen card (A2UI): the books being read with progress. Ash calls it whenever the data changes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "reading.card.tap", title: "在桌面卡片上标记读完",
    description: "A tick on the home-screen card (sent by Ash): item is the book's id, checked true finishes it.",
    inputSchema: { type: "object", properties: { card: { type: "string" }, action: { type: "string" }, component: { type: "string" }, item: { type: "string" }, checked: { type: "boolean" },
      value: { type: "array", items: { type: "string" } }, context: { type: "object" } }, required: ["card", "action"], additionalProperties: false },
    annotations: { readOnlyHint: false },
  },
];

const ORDER = { reading: 0, want: 1, done: 2 };
const books = (data) => data.books ?? [];
const find = (data, book) => {
  const found = books(data).find((entry) => entry.id === String(book));
  if (!found) throw new Error("书架上没有这本书：可能已经删掉了");
  return found;
};
const finish = (book, done, rating) => {
  book.status = done ? "done" : "reading";
  book.finished_at = done ? Date.now() : null;
  if (done && book.pages) book.page = book.pages;
  if (rating) book.rating = rating;
};
const stats = () => {
  const list = books(load()), year = new Date().getFullYear();
  const months = [];
  for (let back = 5; back >= 0; back--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - back);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    months.push({ month: key, done: list.filter((b) => b.status === "done" && b.finished_at && new Date(b.finished_at).toISOString().slice(0, 7) === key).length });
  }
  return { want: list.filter((b) => b.status === "want").length, reading: list.filter((b) => b.status === "reading").length, done: list.filter((b) => b.status === "done").length,
    this_year: list.filter((b) => b.status === "done" && b.finished_at && new Date(b.finished_at).getFullYear() === year).length, months };
};

// 改数据的工具返回 activity（一句话说改了什么）：主人在页面或卡片上改的时候，Ash 看到的就是这句话。
async function handle(name, args) {
  switch (name) {
    case "reading.list": {
      const list = books(load()).filter((b) => !args.status || b.status === args.status);
      return { books: [...list].sort((a, b) => ORDER[a.status] - ORDER[b.status] || b.at - a.at) };
    }
    case "reading.add": {
      const title = String(args.title ?? "").trim().slice(0, 120);
      if (!title) throw new Error("书名不能是空的");
      const data = load();
      if (books(data).some((b) => b.title === title && b.status !== "done")) throw new Error(`书架上已经有《${title}》了`);
      const book = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), title, author: args.author ?? "", status: args.status ?? "want",
        page: 0, pages: args.pages ?? null, rating: null, finished_at: null, at: Date.now() };
      data.books = [...books(data), book];
      save(data);
      return { book, activity: `加了一本书：《${title}》（${book.status === "reading" ? "在读" : "想读"}）` };
    }
    case "reading.progress": {
      const data = load(), book = find(data, args.book);
      book.page = args.page;
      if (book.pages && args.page >= book.pages) finish(book, true);
      else if (book.status !== "done") book.status = args.page > 0 ? "reading" : book.status;
      save(data);
      return { book, activity: `《${book.title}》读到第 ${book.page} 页${book.status === "done" ? "，读完了" : ""}` };
    }
    case "reading.finish": {
      const data = load(), book = find(data, args.book);
      finish(book, args.done !== false, args.rating);
      save(data);
      return { book, activity: `${book.status === "done" ? "读完了" : "又翻开了"}《${book.title}》` };
    }
    case "reading.remove": {
      const data = load(), book = find(data, args.book);
      data.books = books(data).filter((entry) => entry !== book);
      save(data);
      return { removed: book.id, activity: `从书架删掉了《${book.title}》` };
    }
    case "reading.stats": return stats();
    case "reading.card": return card();
    case "reading.card.tap": {
      // 卡片上一行的勾选框：item 是那本书的 id，checked 是勾上还是取消。别的点击（没有 item）不用管。
      if (args.item === undefined) return { ignored: true };
      const data = load(), book = find(data, args.item);
      finish(book, typeof args.checked === "boolean" ? args.checked : book.status !== "done");
      save(data);
      return { book, activity: `在桌面卡片上${book.status === "done" ? "标记读完了" : "取消了读完"}《${book.title}》` };
    }
  }
  throw new Error(`没有这个工具：${name}`);
}

// ---- 桌面卡片（4x2）：只放在读的书，最多 3 本，每本一个「读完了」勾选框和一条进度；其余只写个数。数据一变 Ash 就重画。----
function card() {
  const list = books(load());
  const reading = list.filter((b) => b.status === "reading").sort((a, b) => b.at - a.at);
  const shown = reading.slice(0, 3).map((b) => ({ id: b.id, title: b.title, done: false, page: b.page || 0, pages: b.pages || 100,
    pct: b.pages ? Math.min(100, Math.round((b.page / b.pages) * 100)) : null }));
  const wait = list.filter((b) => b.status === "want").length, done = list.filter((b) => b.status === "done").length;
  return {
    components: [
      { id: "root", component: "Column", children: ["head", "list", "none", "foot"] },
      { id: "head", component: "Row", align: "center", children: ["title", "count"], action: { openApp: { app: APP.id } } },
      { id: "title", component: "Text", text: "在读", variant: "h4", weight: 1 },
      { id: "count", component: "Badge", text: { path: "/count" } },
      { id: "list", component: "List", children: { componentId: "row", path: "/books" }, style: { margin: [4, 0, 0, 0] } },
      { id: "row", component: "Column", children: ["tick", "bar"], style: { margin: [0, 0, 4, 0] } },
      { id: "tick", component: "CheckBox", label: { path: "title" }, value: { path: "done" }, action: { event: { name: "finish" } }, style: { maxLines: 1 } },
      { id: "bar", component: "ProgressBar", value: { path: "page" }, max: { path: "pages" }, visible: { path: "known" } },
      { id: "none", component: "Text", text: "现在没有在读的书", variant: "caption", visible: { path: "/empty" } },
      { id: "foot", component: "Text", text: { path: "/foot" }, variant: "caption", style: { maxLines: 1 }, action: { openApp: { app: APP.id, surface: "stats" } } },
    ],
    data: { count: `${reading.length} 本`, empty: shown.length === 0, books: shown.map((b) => ({ ...b, known: b.pct !== null })),
      foot: `想读 ${wait} 本 · 读完 ${done} 本` },
  };
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
    // 改数据的工具可以在结果里带 activity：一句话说这次改了什么（如「勾掉了：给物业打电话」）。主人在页面里改的时候，Ash 看到的就是这句话。
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data,
      ...(typeof data.activity === "string" ? { _meta: { activity: data.activity } } : {}) };
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
