import assert from "node:assert/strict";
import { copyFileSync, linkSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { Ledger } from "../../src/world/ledger";
import { WorldRouter } from "../../src/world/router";
import { WorldMembers } from "../../src/world/member";
import { EdgeRouter, startEdgeServer, type EdgeCaller, type EdgeRequest, type EdgeResponse } from "../../src/server";
import { wordContract } from "../../../sdk/src/words";
import { HostDeviceLink } from "../../src/host-v2";
import { DeviceMember } from "../../src/members/device";
import { OwnerMember } from "../../src/members/owner";
import { OwnerLink } from "../../src/gateway/link";

const owner: EdgeCaller = { member: "person:owner", transportPrincipal: "owner-credential", local: true, remote: false, ownerProxy: true, transport: "api" };
const remote: EdgeCaller = { member: "person:owner", transportPrincipal: "paired-browser", pairedDeviceId: "paired-browser", local: false, remote: true, ownerProxy: true, transport: "web_ui" };
const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): EdgeRequest => ({ method, url: new URL(path, "http://ash"), headers, body: body === undefined ? null : Buffer.from(JSON.stringify(body)) });
const parsed = (res: EdgeResponse): Record<string, any> => JSON.parse("body" in res ? String(res.body) : "{}");
const send = (to: string, word: string, body: Record<string, unknown>, wait = false) => ({ to, kind: "request" as const, word, body, wait });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ash-edge-"));
  const workspace = join(dir, "home"); mkdirSync(workspace);
  const ledger = await Ledger.open(join(dir, "ledger.db"));
  const world = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(world);
  members.register({ id: "agent:main", kind: "agent", name: "Main", words: () => [wordContract("agent:main", "say")!, wordContract("agent:main", "typing")!], handle: () => ({ ok: true, result: { accepted: true } }) });
  members.register({ id: "service:admin", kind: "service", name: "Admin", words: () => [wordContract("service:admin", "settings.get")!], handle: () => ({ ok: true, result: {} }) });
  const edge = new EdgeRouter(ledger, world, members, { api: { "owner-token": "person:owner" }, mcp: { "agent:main": "agent-token" } }, { workspaces: { home: workspace }, authScopeKey: Buffer.alloc(32, 1) });
  return { dir, workspace, ledger, world, members, edge };
}

test("edge authenticates before send, allows bounded wait, and exposes only declared v2 routes", async () => {
  const { ledger, edge } = await fixture();
  try {
    assert.equal((await edge.handle(request("POST", "/api/send", send("agent:main", "say", { text: "hello" })), null)).status, 401);
    const good = await edge.handle(request("POST", "/api/send", send("agent:main", "say", { text: "hello" }, true)), owner);
    assert.equal(good.status, 200);
    assert.equal(parsed(good).reply?.body?.result?.accepted, true);
    assert.equal(ledger.list().filter((item) => item.kind === "response").length, 1);
    assert.equal((await edge.handle(request("GET", "/api/agents"), owner)).status, 404);
    assert.equal((await edge.handle(request("POST", "/api/call", {}), owner)).status, 404);
    const admin = await edge.handle(request("POST", "/api/send", send("service:admin", "settings.get", {})), remote);
    assert.equal(admin.status, 403);
    assert.equal(ledger.list().length, 2);
  } finally { ledger.close(); }
});

test("owner UI restricts form submissions to its own origin", async () => {
  const { ledger, edge } = await fixture();
  try {
    const page = await edge.handle(request("GET", "/"), owner);
    assert.equal(page.status, 200);
    assert.match(page.headers?.["content-security-policy"] ?? "", /(?:^|;)\s*form-action 'self'(?:;|$)/);
  } finally { ledger.close(); }
});

test("owner inbox accepts attachment-only say but rejects empty text without an attachment", async () => {
  const { ledger, edge } = await fixture();
  try {
    const attachment = { name: "note.txt", mime_type: "text/plain", data: Buffer.from("fixture").toString("base64") };
    const accepted = await edge.handle(request("POST", "/api/send", send("agent:main", "say", { text: "", attachments: [attachment] })), owner);
    assert.equal(accepted.status, 200);
    assert.deepEqual(ledger.byId(parsed(accepted).id)?.body, { text: "", attachments: [attachment] });
    for (const body of [{ text: "" }, { text: "", attachments: [] }])
      assert.equal((await edge.handle(request("POST", "/api/send", send("agent:main", "say", body)), owner)).status, 400);
    assert.equal(ledger.list().filter((entry) => entry.word === "say" && entry.kind === "request").length, 1);
  } finally { ledger.close(); }
});

test("L025 summary pages strip large inline bytes in SQLite and raw overflow is HTTP 413 before headers", async () => {
  const { ledger, edge } = await fixture();
  try {
    const data = Buffer.alloc(19 * 1024 * 1024, 7).toString("base64");
    const first = ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "", attachments: [{ name: "a.bin", mime_type: "application/octet-stream", data }] } }).message;
    const second = ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "", attachments: [{ name: "b.bin", mime_type: "application/octet-stream", data }] } }).message;
    const summary = await edge.handle(request("GET", `/api/stream?summary=true&follow=false&before=${second.seq + 1}&limit=2`), owner);
    assert.equal(summary.status, 200, JSON.stringify(parsed(summary)));
    let output = "";
    if ("stream" in summary) summary.stream((chunk) => { output += chunk; }, () => {}, () => {});
    const frames = output.trim().split("\n\n");
    assert.match(frames[0], /^event: auth\.scope\n/);
    assert.equal(frames.filter((entry) => entry.includes("event: message.summary")).length, 2);
    assert.equal(output.includes(data.slice(0, 100)), false);
    const rows = frames.filter((entry) => entry.includes("event: message.summary")).map((entry) => JSON.parse(entry.split("\ndata: ")[1]));
    assert.deepEqual(rows.map((row) => row.inline_attachments[0].size), [19 * 1024 * 1024, 19 * 1024 * 1024]);
    assert.ok(rows.every((row) => row.summary === true && !Object.hasOwn(row, "body") && !Object.hasOwn(row.body_summary.attachments[0], "data")));
    assert.ok(output.length < 2000);
    assert.equal((await edge.handle(request("GET", `/api/stream?follow=false&before=${second.seq + 1}&limit=2`), owner)).status, 413);
    assert.equal((await edge.handle(request("GET", `/api/stream?follow=false&before=${first.seq + 1}&limit=1`), owner)).status, 200);
  } finally { ledger.close(); }
});

test("L025 summary byte budget returns a continuous descending selection with an exact next cursor", async () => {
  const { ledger, edge } = await fixture();
  try {
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "漢".repeat(150_000) } }).message.seq);
    const response = await edge.handle(request("GET", "/api/stream?summary=true&follow=false&limit=12"), owner);
    assert.equal(response.status, 200);
    let output = "";
    if ("stream" in response) response.stream((chunk) => { output += chunk; }, () => {}, () => {});
    assert.ok(Buffer.byteLength(output) <= 4 * 1024 * 1024);
    const frames = output.trim().split("\n\n");
    const rows = frames.filter((entry) => entry.includes("event: message.summary")).map((entry) => Number(/^id: (\d+)/.exec(entry)?.[1]));
    const end = JSON.parse(frames.find((entry) => entry.startsWith("event: stream.page_end"))!.split("\ndata: ")[1]);
    assert.ok(rows.length > 0 && rows.length < ids.length);
    assert.deepEqual(rows, ids.slice(-rows.length));
    assert.deepEqual(end, { has_more: true, first_seq: rows[0], last_seq: rows.at(-1) });
    const older = ledger.summaryPage({ before: end.first_seq, limit: 12 });
    assert.deepEqual(older.page.map((row) => row.seq), ids.slice(0, -rows.length));
    assert.equal(older.end.has_more, false);
  } finally { ledger.close(); }
});

test("L025 late oversized live summary emits an unnumbered error without claiming delivery", async () => {
  const { ledger, world, edge } = await fixture();
  try {
    const live = await edge.handle(request("GET", "/api/stream?summary=true&after=0&follow=true"), owner);
    assert.equal(live.status, 200);
    let output = "", ended = false, close = () => {};
    if ("stream" in live) live.stream((chunk) => { output += chunk; }, (fn) => { close = fn; }, () => { ended = true; });
    await world.send({ member: "person:owner", transport: "api", transportPrincipal: "owner-credential", local: true, remote: false, ownerProxy: true },
      { to: "agent:main", kind: "request", word: "say", body: { text: "x".repeat(1_100_000) } });
    assert.equal(ended, true);
    assert.match(output, /event: stream\.error\ndata: \{"code":"too_large"\}/);
    assert.doesNotMatch(output, /(?:^|\n)id: [1-9]/);
    close();
  } finally { ledger.close(); }
});

test("wait cap returns the accepted id without inventing a late reply", async () => {
  const { ledger, world, members } = await fixture();
  try {
    members.register({ id: "service:slow", kind: "service", name: "Slow", words: () => [{ word: "run", kind: "request", description: "Wait for a synthetic slow result.", input_schema: { type: "object", additionalProperties: false }, timeout_ms: 5_000 }], handle: () => new Promise(() => {}) });
    const edge = new EdgeRouter(ledger, world, members, { api: {}, mcp: {} }, { waitMs: 20, authScopeKey: Buffer.alloc(32, 1) });
    const response = await edge.handle(request("POST", "/api/send", send("service:slow", "run", {}, true)), owner);
    assert.equal(response.status, 200);
    assert.equal(typeof parsed(response).id, "string");
    assert.equal(parsed(response).reply, undefined);
    assert.equal(ledger.responseTo(parsed(response).id), null);
    world.cancel([parsed(response).id]);
    assert.equal((ledger.responseTo(parsed(response).id)?.body.error as { code: string }).code, "cancelled");
  } finally { ledger.close(); }
});

test("screen registrations bind owner proxy sends to one principal and stamp origin", async () => {
  const { ledger, edge } = await fixture();
  let close = () => {};
  try {
    const stream = await edge.handle(request("GET", "/api/stream?follow=true&label=Tab%20A"), remote);
    assert.equal(stream.status, 200);
    let text = "";
    if ("stream" in stream) stream.stream((chunk) => { text += chunk; }, (cleanup) => { close = cleanup; }, () => {});
    const registration = JSON.parse(text.split("\ndata: ")[1].split("\n\n")[0]) as { screen: string; token: string; label: string };
    assert.equal(registration.label, "Tab A");
    assert.equal((await edge.handle(request("POST", "/api/send", send("agent:main", "say", { text: "hello" })), remote)).status, 403);
    assert.equal((await edge.handle(request("POST", "/api/send", send("agent:main", "say", { text: "hello" }), { "ash-screen": registration.token }), { ...remote, transportPrincipal: "other-browser" })).status, 403);
    assert.equal((await edge.handle(request("POST", "/api/send", send("agent:main", "say", { text: "hello" }), { "x-ash-screen": registration.token }), remote)).status, 403);
    const sent = await edge.handle(request("POST", "/api/send", send("agent:main", "say", { text: "hello" }), { "ash-screen": registration.token }), remote);
    assert.equal(sent.status, 200);
    const recorded = ledger.byId(parsed(sent).id)!;
    assert.equal(recorded.from, "person:owner");
    assert.deepEqual(recorded.origin, { screen: registration.screen, label: "Tab A" });
    assert.equal((await edge.handle(request("POST", "/api/send", { to: "agent:main", kind: "event", word: "typing", body: {} }), owner)).status, 403);
  } finally { close(); ledger.close(); }
});

test("finite stream cursor rules and real HTTP Last-Event-ID replay exactly once", async () => {
  const { ledger, edge } = await fixture();
  const server = await startEdgeServer(edge, "127.0.0.1", 0);
  try {
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const auth = { authorization: "Bearer owner-token" };
    for (const malformed of ["null", "[]"]) {
      const rejected = await fetch(`${base}/api/send`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: malformed });
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json() as { error: string }).error, "bad_request");
    }
    const sent = await fetch(`${base}/api/send`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(send("agent:main", "say", { text: "one" })) });
    assert.equal(sent.status, 200);
    const all = ledger.list();
    const replay = await fetch(`${base}/api/stream?after=${all[0].seq}&follow=false`, { headers: { ...auth, "Last-Event-ID": String(all[0].seq) } });
    assert.equal(replay.status, 200);
    const frames = (await replay.text()).split("\n\n").filter((block) => block.startsWith("id: "));
    assert.deepEqual(frames.map((frame) => Number(frame.match(/^id: (\d+)/)?.[1])), all.slice(1).map((item) => item.seq));
    assert.equal((await fetch(`${base}/api/stream?after=0&before=3&follow=false`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${base}/api/stream?after=0&follow=false`, { headers: { ...auth, "Last-Event-ID": "1" } })).status, 400);
    assert.equal((await fetch(`${base}/api/stream?before=999&follow=true`, { headers: auth })).status, 400);
  } finally {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
    ledger.close();
  }
});

test("live stream replays through its high-water mark and then emits each new message once", async () => {
  const { ledger, world, edge } = await fixture();
  let close = () => {};
  try {
    const first = await world.send({ transport: "api", transportPrincipal: "owner-credential", member: "person:owner", local: true, remote: false, ownerProxy: true }, send("agent:main", "say", { text: "before" }));
    const result = await edge.handle(request("GET", "/api/stream?after=0&follow=true&label=Live"), owner);
    assert.equal(result.status, 200);
    assert.equal("stream" in result, true);
    let output = "";
    if ("stream" in result) result.stream((chunk) => { output += chunk; }, (cleanup) => { close = cleanup; }, () => {});
    const second = await world.send({ transport: "api", transportPrincipal: "owner-credential", member: "person:owner", local: true, remote: false, ownerProxy: true }, send("agent:main", "say", { text: "after" }));
    const ids = output.split("\n\n").filter((block) => block.startsWith("id: ")).map((block) => Number(block.match(/^id: (\d+)/)?.[1]));
    assert.equal(output.includes("event: screen.registered"), true);
    assert.equal(ids.filter((seq) => seq === first.seq).length, 1);
    assert.equal(ids.filter((seq) => seq === second.seq).length, 1);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  } finally { close(); ledger.close(); }
});

test("workspace bytes preserve local-only writes and reject managed, symlink and alias paths", async () => {
  const { dir, workspace, ledger, world, members, edge } = await fixture();
  try {
    const outside = join(dir, "outside"); mkdirSync(outside);
    symlinkSync(outside, join(workspace, "alias"));
    writeFileSync(join(workspace, "MEMORY.md"), "protected");
    linkSync(join(workspace, "MEMORY.md"), join(workspace, "hardlink.txt"));
    copyFileSync(join(workspace, "MEMORY.md"), join(workspace, "ordinary-copy.txt"));
    const memory = join(workspace, "memory"); mkdirSync(memory);
    writeFileSync(join(memory, "2026-10-01.md"), "managed date");
    const versions = join(workspace, ".ash", "versions"); mkdirSync(versions, { recursive: true });
    writeFileSync(join(versions, "snap"), "protected version");
    const put = (path: string, caller: EdgeCaller) => edge.handle({ ...request("PUT", `/api/workspaces/home/files?path=${encodeURIComponent(path)}`), body: Buffer.from("safe") }, caller);
    assert.equal((await put("notes.txt", remote)).status, 403);
    assert.equal((await put("SOUL.md", owner)).status, 403);
    assert.equal((await put("memory//2026-10-01.md", owner)).status, 400);
    assert.equal((await put("alias/exfiltrate.txt", owner)).status, 403);
    assert.equal((await put("hardlink.txt", owner)).status, 403);
    assert.equal(readFileSync(join(workspace, "MEMORY.md"), "utf8"), "protected");
    assert.equal((await put("ordinary-copy.txt", owner)).status, 200);
    assert.equal(readFileSync(join(workspace, "ordinary-copy.txt"), "utf8"), "safe");
    assert.equal(readFileSync(join(workspace, "MEMORY.md"), "utf8"), "protected");
    const aliased = new EdgeRouter(ledger, world, members, { api: {}, mcp: {} }, { workspaces: { home: workspace, diary: memory, ancestor: dir, versions }, authScopeKey: Buffer.alloc(32, 1) });
    assert.equal((await aliased.handle({ ...request("PUT", "/api/workspaces/diary/files?path=2026-10-01.md"), body: Buffer.from("unsafe") }, owner)).status, 403);
    for (const [alias, path] of [["ancestor", "home/MEMORY.md"], ["ancestor", "home/memory/2026-10-01.md"], ["versions", "snap"]])
      assert.equal((await aliased.handle({ ...request("PUT", `/api/workspaces/${alias}/files?path=${path}`), body: Buffer.from("unsafe") }, owner)).status, 403);
    assert.equal(readFileSync(join(memory, "2026-10-01.md"), "utf8"), "managed date");
    assert.equal(readFileSync(join(workspace, "MEMORY.md"), "utf8"), "protected");
    assert.equal(readFileSync(join(versions, "snap"), "utf8"), "protected version");
    const listed = parsed(await edge.handle(request("GET", "/api/workspaces/home/files?path="), owner));
    assert.equal(JSON.stringify(listed).includes("alias"), false);
    assert.equal((await put("notes.txt", owner)).status, 200);
    assert.equal(readFileSync(join(workspace, "notes.txt"), "utf8"), "safe");
    const get = await edge.handle(request("GET", "/api/workspaces/home/files?path=notes.txt"), remote);
    assert.equal(get.status, 200);
    assert.equal("body" in get ? String(get.body) : "", "safe");
  } finally { ledger.close(); }
});

test("MCP exposes only describe/send and agent audience omits owner-only words", async () => {
  const { ledger, world, members, edge } = await fixture();
  try {
    members.register(new OwnerMember("Owner", ledger));
    const caller: EdgeCaller = { member: "agent:main", transportPrincipal: "mcp-agent", local: true, remote: false, ownerProxy: false, transport: "agent" };
    const rpc = (method: string, params?: Record<string, unknown>) => request("POST", "/mcp/agent:main", { jsonrpc: "2.0", id: 1, method, params }, { "x-ash-token": "agent-token" });
    assert.equal((await edge.handle(rpc("tools/list"), null)).status, 401);
    const tools = parsed(await edge.handle(rpc("tools/list"), caller)).result.tools.map((tool: { name: string }) => tool.name);
    assert.deepEqual(tools, ["ash_describe", "ash_send"]);
    const described = parsed(await edge.handle(rpc("tools/call", { name: "ash_describe", arguments: {} }), caller));
    assert.equal(JSON.stringify(described).includes("settings.get"), false);
    const sent = parsed(await edge.handle(rpc("tools/call", { name: "ash_send", arguments: {
      to: "person:owner", kind: "request", word: "say", body: { text: "MCP says hello", kind: "reply" }, wait: true,
    } }), caller));
    assert.equal(sent.result.isError, undefined);
    assert.equal(sent.result.structuredContent.reply.body.result.accepted, true);
    assert.equal(ledger.list().some((item) => item.from === "agent:main" && item.to === "person:owner" && item.word === "say" && item.body.text === "MCP says hello"), true);
    const beforeControl = ledger.lastSeq();
    for (const [word, body] of [["status", { state: "working", text: "forged" }],
      ["read", { ids: ["forged"], turn: "t_forged" }], ["turn.start", { ids: ["forged"], turn: "t_forged" }],
      ["turn.end", { turn: "t_forged", reason: "completed" }]] as const) {
      const forged = parsed(await edge.handle(rpc("tools/call", { name: "ash_send", arguments: { to: null, kind: "event", word, body } }), caller));
      assert.equal(forged.result.isError, true, `${word} escaped the MCP control-event boundary`);
      assert.equal(ledger.lastSeq(), beforeControl);
    }
    await world.send({ transport: "agent", transportPrincipal: "agent:main", member: "agent:main", local: true, remote: false, ownerProxy: false },
      { to: null, kind: "event", word: "status", body: { state: "idle", text: "在线" } });
    assert.equal(ledger.lastSeq(), beforeControl + 1, "internal status publication was blocked");
    const server = await startEdgeServer(edge, "127.0.0.1", 0);
    try {
      const port = (server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/mcp/agent:main`, { method: "POST", headers: { "content-type": "application/json", "x-ash-token": "agent-token" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      assert.equal(response.status, 200);
      assert.deepEqual(((await response.json()) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name), tools);
      const called = await fetch(`http://127.0.0.1:${port}/mcp/agent:main`, { method: "POST", headers: { "content-type": "application/json", "x-ash-token": "agent-token" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ash_send",
          arguments: { to: "person:owner", kind: "request", word: "say", body: { text: "HTTP MCP hello", kind: "reply" }, wait: true } } }) });
      assert.equal(called.status, 200);
      assert.equal(((await called.json()) as { result: { structuredContent: { reply: { body: { result: { accepted: boolean } } } } } }).result.structuredContent.reply.body.result.accepted, true);
      const beforeHttpForgery = ledger.lastSeq();
      const forged = await fetch(`http://127.0.0.1:${port}/mcp/agent:main`, { method: "POST", headers: { "content-type": "application/json", "x-ash-token": "agent-token" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ash_send",
          arguments: { to: null, kind: "event", word: "status", body: { state: "working", text: "forged" } } } }) });
      assert.equal(forged.status, 200);
      assert.equal(((await forged.json()) as { result: { isError: boolean } }).result.isError, true);
      assert.equal(ledger.lastSeq(), beforeHttpForgery);
    } finally { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }
  } finally { ledger.close(); }
});

test("host manifest without declared risk and label fails closed before device registration", async () => {
  const { ledger, world, members } = await fixture();
  let upgraded = false;
  let capabilityName = "calendar.search";
  let effects = 0;
  const host = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer host-token") { res.writeHead(401).end(); return; }
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/manifest") {
      res.end(JSON.stringify({ name: "Controlled phone", capabilities: [{ name: capabilityName, description: "Search controlled calendar", input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] }, ...(upgraded ? { risk: "none", label: "Searching calendar" } : {}) }] }));
    } else if (req.method === "POST" && req.url === "/call") { effects++; res.end(JSON.stringify({ ok: true, content: [{ type: "text", text: "controlled result" }] })); }
    else res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
  try {
    await assert.rejects(HostDeviceLink.probe({ url, token: "host-token" }), /metadata/);
    assert.equal(members.describe("owner").members.some((item) => item.id === "device:phone"), false);
    upgraded = true;
    const link = await HostDeviceLink.probe({ url, token: "host-token" });
    try {
      members.registerDevice(link.device());
      const result = await world.send({ transport: "api", transportPrincipal: "owner", member: "person:owner", local: true, remote: false, ownerProxy: false }, { to: "device:phone", kind: "request", word: "calendar.search", body: { n: 1 }, wait: true });
      assert.equal(result.reply?.body.ok, true);
      assert.equal(effects, 1);
      upgraded = false;
      await link.refreshManifest(members);
      assert.equal(members.describe("owner", "device:phone").members[0].online, false);
      const offline = await world.send({ transport: "api", transportPrincipal: "owner", member: "person:owner", local: true, remote: false, ownerProxy: false }, { to: "device:phone", kind: "request", word: "calendar.search", body: { n: 1 }, wait: true });
      assert.equal((offline.reply?.body.error as { code: string }).code, "offline");
      assert.equal(effects, 1);
      upgraded = true;
      capabilityName = "calendar.updated";
      await link.refreshManifest(members);
      assert.equal(members.describe("owner", "device:phone").members[0].online, true);
      assert.deepEqual(members.describe("owner", "device:phone").members[0].words.map((word) => word.word), ["calendar.updated"]);
      await assert.rejects(world.send({ transport: "api", transportPrincipal: "owner", member: "person:owner", local: true, remote: false, ownerProxy: false }, { to: "device:phone", kind: "request", word: "calendar.search", body: { n: 1 } }), /not found/);
    } finally { link.close(); }
  } finally { await new Promise<void>((resolve) => { host.close(() => resolve()); host.closeAllConnections(); }); ledger.close(); }
});

test("device manifest replacement is atomic and cancels an uncertain old call before new routes publish", async () => {
  const { ledger, world, members } = await fixture();
  const context = { transport: "api" as const, transportPrincipal: "owner", member: "person:owner", local: true, remote: false, ownerProxy: true };
  const cap = (name: string, input_schema: unknown) => ({ name, description: `Controlled ${name}`, input_schema, risk: "none" as const, label: `Using ${name}` });
  let release!: (value: { ok: true; result: Record<string, unknown> }) => void;
  try {
    members.registerDevice(new DeviceMember("device:synthetic", "Synthetic", [cap("old", { type: "object", properties: {}, additionalProperties: false })],
      () => new Promise((resolve) => { release = resolve; })));
    const old = await world.send(context, send("device:synthetic", "old", {}));
    assert.equal(typeof release, "function");
    assert.throws(() => members.replaceDevice(new DeviceMember("device:synthetic", "Invalid", [
      cap("new", { type: "object", properties: {}, additionalProperties: false }),
      cap("bad", { type: "object", properties: { n: { type: "unknown" } } }),
    ], () => ({ ok: true, result: {} }))), /schema|type|unknown/i);
    assert.equal(members.describe("owner", "device:synthetic").members[0].words[0].word, "old");
    assert.equal(ledger.responseTo(old.id), null);
    members.replaceDevice(new DeviceMember("device:synthetic", "Updated", [cap("new", { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false })],
      () => ({ ok: true, result: {} })));
    const cancelled = ledger.responseTo(old.id);
    assert.equal((cancelled?.body.error as { code: string }).code, "cancelled");
    release({ ok: true, result: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ledger.list().filter((message) => message.reply_to === old.id).length, 1);
    assert.equal(members.describe("owner", "device:synthetic").members[0].words[0].word, "new");
    await assert.rejects(world.send(context, send("device:synthetic", "old", {})), /not found/);
    await assert.rejects(world.send(context, send("device:synthetic", "new", { n: "bad" })), /schema/);
    const fresh = await world.send(context, { ...send("device:synthetic", "new", { n: 2 }), wait: true });
    assert.equal(fresh.reply?.body.ok, true);
    members.removeDevice("device:synthetic");
    assert.equal(members.describe("owner").members.some((entry) => entry.id === "device:synthetic"), false);
    await assert.rejects(world.send(context, send("device:synthetic", "new", { n: 2 })), /not found/);
  } finally { ledger.close(); }
});

test("observer revocation between durable request publication and dispatch never executes the old route", async () => {
  const { ledger, world, members } = await fixture();
  let effects = 0;
  try {
    members.registerDevice(new DeviceMember("device:volatile", "Volatile", [{ name: "run", description: "Synthetic effect", risk: "none", label: "Running", input_schema: { type: "object", properties: {}, additionalProperties: false } }],
      () => { effects++; return { ok: true, result: {} }; }));
    const stop = world.subscribe((message) => { if (message.kind === "request" && message.to === "device:volatile") members.removeDevice("device:volatile"); });
    const sent = await world.send({ transport: "api", transportPrincipal: "owner", member: "person:owner", local: true, remote: false, ownerProxy: false },
      { to: "device:volatile", kind: "request", word: "run", body: {}, wait: true });
    stop();
    assert.equal(effects, 0);
    assert.equal((sent.reply?.body.error as { code: string }).code, "cancelled");
    assert.equal(ledger.list().filter((message) => message.reply_to === sent.id).length, 1);
  } finally { ledger.close(); }
});

test("a delayed old host failure cannot offline a replacement or resurrect after close", async () => {
  const { ledger, members } = await fixture();
  let name = "old";
  let entered!: () => void;
  let release!: () => void;
  const enteredCall = new Promise<void>((resolve) => { entered = resolve; });
  const releaseCall = new Promise<void>((resolve) => { release = resolve; });
  const host = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/manifest") res.end(JSON.stringify({ name: "Controlled", capabilities: [{ name, description: "Synthetic", input_schema: { type: "object", additionalProperties: false }, risk: "none", label: "Synthetic" }] }));
    else if (req.url === "/call") { entered(); await releaseCall; res.writeHead(500).end("{}"); }
    else res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const link = await HostDeviceLink.probe({ url: `http://127.0.0.1:${(host.address() as { port: number }).port}`, token: "synthetic" });
  try {
    const old = link.device(); members.registerDevice(old);
    const call = Promise.resolve(old.handle({ id: "old", seq: 1, ts: Date.now(), from: "person:owner", to: "device:phone", kind: "request", word: "old", body: {} }, { signal: new AbortController().signal, recovered: false }));
    await enteredCall;
    name = "new";
    await link.refreshManifest(members);
    assert.deepEqual(members.describe("owner", "device:phone").members[0].words.map((word) => word.word), ["new"]);
    release(); await call;
    assert.equal(members.describe("owner", "device:phone").members[0].online, true);
    link.close();
    await link.refreshManifest(members);
    assert.equal(members.describe("owner", "device:phone").members[0].online, false);
  } finally { release(); link.close(); ledger.close(); await new Promise<void>((resolve) => { host.close(() => resolve()); host.closeAllConnections(); }); }
});

test("gateway refresh serializes dirty revocation and fences stale connection manifests", async () => {
  for (const reconnect of [false, true]) {
    const { ledger, world, members } = await fixture();
    const edge = new EdgeRouter(ledger, world, members, { api: {}, mcp: {} }, { authScopeKey: Buffer.alloc(32, 1) });
    const link = new OwnerLink("http://127.0.0.1:1", { id: "synthetic", publicKey: "synthetic", sign: async () => "synthetic" }, edge, () => {});
    const active = [{ id: "synthetic", name: "Synthetic", permissions: ["expose_capability"], revoked: false, online: true }];
    const revoked = [{ ...active[0], permissions: [], revoked: true, online: false }];
    let current = active;
    let entered!: () => void;
    let release!: () => void;
    const manifestEntered = new Promise<void>((resolve) => { entered = resolve; });
    const manifestRelease = new Promise<void>((resolve) => { release = resolve; });
    const injected = link as unknown as { conn: { request: () => Promise<{ devices: typeof active }> } | null; connected: boolean; onDisconnected: () => void; requestDevice: () => Promise<{ status: number; body: Buffer }> };
    injected.conn = { request: async () => ({ devices: current }) }; injected.connected = true;
    injected.requestDevice = async () => { entered(); await manifestRelease; return { status: 200, body: Buffer.from(JSON.stringify({ name: "Synthetic", capabilities: [{ name: "run", description: "Synthetic", input_schema: { type: "object" }, risk: "none", label: "Synthetic" }] })) }; };
    try {
      const first = link.refreshDevices(); await manifestEntered;
      if (reconnect) { injected.onDisconnected(); injected.conn = { request: async () => ({ devices: revoked }) }; injected.connected = true; }
      else current = revoked;
      const second = link.refreshDevices(); release();
      await Promise.all([first, second]);
      assert.equal(members.describe("owner").members.some((member) => member.id === "device:synthetic"), false, reconnect ? "reconnect" : "same connection");
    } finally { release(); ledger.close(); }
  }
});
