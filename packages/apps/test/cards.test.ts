// 卡片 (packages/apps/cards): its tools against a fake Ash, its manifest and page, and the bundled server the core installs,
// end to end over stdio against a fake Ash MCP endpoint.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { appToolContract } from "../../sdk/src/app";
import { wordsOf } from "../../sdk/src/words";
import { bundleApp } from "../bundle.mjs";
import { checkManifest } from "../../core/src/edges/apps/check";

const here = dirname(fileURLToPath(import.meta.url));
// Plain ESM without type declarations: loaded by path so the checker treats them as untyped.
const load = async (rel: string) => await import(join(here, rel)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const CARD = { id: "c1", message: "m1", owner: "agent:main", app: "parcel", temporary_app: false, life: "active", pinned: false, text: "快递到哪了", sources: ["/status", "/eta"], last_seen: 1, last_used: 2 };
const AGENT_CARD = { id: "c2", message: "m2", owner: "agent:main", temporary_app: false, life: "dormant", pinned: false, text: "", sources: [], last_seen: 0, last_used: 0 };
const LIMITS = { max_active: 8, max_sources: 16 };
const APPS = { apps: [{ id: "parcel", name: "快递", version: "1.0.0", enabled: true, granted: true, running: true }] };

/** What the hub answers for one word through capability_call: the word's `{content, data}`. */
function answer(member: string, word: string, body: Record<string, unknown>): unknown {
  const data = member === "service:apps" ? APPS
    : word === "list" ? { cards: [CARD, AGENT_CARD], limits: LIMITS }
    : word === "sleep" ? { life: "dormant" } : word === "wake" ? { life: "active" } : word === "close" ? { closed: true } : { pinned: body.pinned };
  return { content: [{ type: "text", text: JSON.stringify(data) }], data };
}

function fakeAsh(fail?: { word: string; ownerText: string }) {
  const calls: string[] = [];
  return { calls, ash: {
    async call(member: string, word: string, body: Record<string, unknown>) {
      calls.push(`${member}/${word} ${JSON.stringify(body)}`);
      if (fail && word === fail.word) throw Object.assign(new Error("forbidden: not granted"), { code: "forbidden", ownerText: fail.ownerText });
      return answer(member, word, body);
    },
  } };
}

test("the manifest asks for the service:cards words it calls, in words the owner reads, and the tools map to read and plain writes", async () => {
  const text = readFileSync(join(here, "../cards/app.json"), "utf8");
  const checked = checkManifest(text, "cards");
  assert.deepEqual(checked.problems.filter((problem) => problem.level === "error"), []);
  const manifest = JSON.parse(text);
  const cards = manifest.needs.find((need: { member?: string }) => need.member === "service:cards");
  assert.deepEqual(cards.words, ["list", "sleep", "wake", "close", "pin"]);
  for (const need of manifest.needs) assert.match(need.why, /[一-鿿]/);
  const known = new Set(wordsOf("service:cards").map((word) => word.word));
  for (const word of cards.words) assert.ok(known.has(word), `service:cards has ${word}`);
  assert.deepEqual(manifest.surfaces, [{ id: "home", title: "运行中的卡片", resource: "ui://cards/home" }]);

  const { TOOLS } = await load("../cards/src/tools.mjs");
  const caps = TOOLS.map((tool: Parameters<typeof appToolContract>[1]) => appToolContract("cards", tool));
  assert.deepEqual(caps.map((cap: { word: string; effect: string; risk: string }) => [cap.word, cap.effect, cap.risk]), [
    ["cards.list", "read", "none"], ["cards.sleep", "write", "none"], ["cards.wake", "write", "none"], ["cards.close", "write", "none"], ["cards.pin", "write", "none"]]);
});

test("the tools call service:cards with the card id; the list names each card's app; a refusal is Ash's sentence for the owner", async () => {
  const { callTool } = await load("../cards/src/tools.mjs");
  const fake = fakeAsh();
  const listed = await callTool(fake.ash, "cards.list", {});
  assert.deepEqual(listed.structuredContent.cards.map((card: { app_name?: string }) => card.app_name), ["快递", undefined], "a card without an app has no app name");
  assert.deepEqual(listed.structuredContent.limits, LIMITS);
  assert.deepEqual((await callTool(fake.ash, "cards.sleep", { id: "c1" })).structuredContent, { life: "dormant" });
  assert.deepEqual((await callTool(fake.ash, "cards.wake", { id: "c1" })).structuredContent, { life: "active" });
  assert.deepEqual((await callTool(fake.ash, "cards.close", { id: "c1" })).structuredContent, { closed: true });
  assert.deepEqual((await callTool(fake.ash, "cards.pin", { id: "c1", pinned: true })).structuredContent, { pinned: true });
  assert.deepEqual(fake.calls, ["service:cards/list {}", "service:apps/apps.list {}", "service:cards/sleep {\"id\":\"c1\"}", "service:cards/wake {\"id\":\"c1\"}",
    "service:cards/close {\"id\":\"c1\"}", "service:cards/pin {\"id\":\"c1\",\"pinned\":true}"]);

  const noId = await callTool(fake.ash, "cards.sleep", {});
  assert.equal(noId.isError, true);
  assert.equal(fake.calls.length, 6, "nothing is sent without a card");
  const refused = await callTool(fakeAsh({ word: "close", ownerText: "安装时没有批准这一项，用不了" }).ash, "cards.close", { id: "c1" });
  assert.deepEqual([refused.isError, refused.content[0].text], [true, "安装时没有批准这一项，用不了"]);
  // Without the app list the cards are still listed, only without names.
  const names = await callTool(fakeAsh({ word: "apps.list", ownerText: "x" }).ash, "cards.list", {});
  assert.equal(names.structuredContent.cards.length, 2);
  assert.equal(names.structuredContent.cards[0].app_name, undefined);
});

test("the page is what tools/gen-cards-ui.mjs makes: self-contained, Chinese, with the four states and the buttons", async () => {
  const { pages } = await load("../../../tools/gen-cards-ui.mjs");
  const page = readFileSync(join(here, "../cards/ui/home.html"), "utf8");
  assert.equal(pages()["home.html"], page, "home.html is stale: node tools/gen-cards-ui.mjs");
  assert.doesNotMatch(page, /(src|href)\s*=\s*["']?https?:/i, "no network resources");
  assert.match(page, /--surface:/, "the app tokens are inlined");
  for (const word of ["运行中的卡片", "运行中", "闲置", "休眠", "已收起", "唤醒", "收起", "固定", "取消固定", "已固定", "ui/initialize", "tools/call"]) assert.ok(page.includes(word), word);
  const { readResource, UI_MIME } = await load("../cards/src/tools.mjs");
  const read = readResource("ui://cards/home", { home: page }).contents[0];
  assert.equal(read.mimeType, UI_MIME);
  assert.deepEqual(read._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  assert.throws(() => readResource("ui://cards/other", { home: page }));
});

/** A fake Ash endpoint: capability_call answers like the hub. */
async function fakeAshEndpoint(token: string) {
  const seen: string[] = [];
  const http: HttpServer = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
    let raw = ""; for await (const chunk of request) raw += chunk;
    const server = new Server({ name: "ash", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    server.setRequestHandler(CallToolRequestSchema, async (call) => {
      const args = (call.params.arguments ?? {}) as { member: string; word: string; body?: Record<string, unknown> };
      seen.push(`${args.member}/${args.word}`);
      const result = { ok: true, result: answer(args.member, args.word, args.body ?? {}) };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(request, response, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`, seen, close: () => new Promise<void>((resolve) => { http.close(() => resolve()); http.closeAllConnections(); }) };
}

test("the bundled server the core installs runs over stdio: its tools reach service:cards through Ash, and it serves its page", async () => {
  const files = await bundleApp(join(here, "../cards"));
  assert.deepEqual(Object.keys(files).sort(), ["app.json", "icon.svg", "server.mjs"]);
  const dir = mkdtempSync(join(tmpdir(), "ash-cards-app-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const endpoint = await fakeAshEndpoint("t0ken");
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(dir, "server.mjs")], cwd: dir, stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", ASH_APP_ID: "cards", ASH_APP_DIR: dir, ASH_MCP_URL: endpoint.url, ASH_MCP_TOKEN: "t0ken" } }));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["cards.list", "cards.sleep", "cards.wake", "cards.close", "cards.pin"]);
    const listed = await client.callTool({ name: "cards.list", arguments: {} });
    assert.equal((listed.structuredContent as { cards: { app_name?: string }[] }).cards[0]!.app_name, "快递");
    const pinned = await client.callTool({ name: "cards.pin", arguments: { id: "c1", pinned: true } });
    assert.deepEqual(pinned.structuredContent, { pinned: true });
    assert.deepEqual(endpoint.seen.sort(), ["service:apps/apps.list", "service:cards/list", "service:cards/pin"]);
    const home = await client.readResource({ uri: "ui://cards/home" });
    assert.match(String((home.contents[0] as { text: string }).text), /运行中的卡片/);
  } finally { await client.close(); await endpoint.close(); }
});
