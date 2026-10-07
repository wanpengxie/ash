import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentMcpServer, TOOL_ERROR_CODES, TOOL_NAMES, type ToolResult } from "../../src/agent-mcp/server";
import { OwnerMember } from "../../src/members/owner";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const SCREEN = Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), Buffer.alloc(3000, 7)]);
const owner: TrustedRouteContext = { transport: "api", transportPrincipal: "owner-login", member: "person:owner", local: true, remote: false, ownerProxy: true };

async function world(options: { fastPathMs?: number; maxWaitMs?: number; artifacts?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ash-mcp-"));
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  members.register(new OwnerMember("Owner", ledger));
  let release: (() => void) | null = null;
  members.registerDevice({ id: "device:phone", kind: "device", name: "Phone", online: true,
    capabilities: () => [
      { name: "battery.get", label: "Battery", description: "Read the battery level. Read-only.", risk: "none",
        input_schema: { type: "object", properties: {}, additionalProperties: false }, result_schema: { type: "object", properties: { level: { type: "integer" } }, required: ["level"] } },
      { name: "slow.run", label: "Slow", description: "Takes a while.", risk: "none",
        input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } },
      { name: "large.get", label: "Large", description: "Returns a large page. Read-only.", risk: "none",
        input_schema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "screen.see", label: "See", description: "Look at the screen. Read-only.", risk: "none",
        input_schema: { type: "object", properties: {}, additionalProperties: false } },
    ],
    handle: async (message) => {
      if (message.word === "battery.get") return { ok: true, result: { level: 80 } };
      if (message.word === "large.get") return { ok: true, result: { page: "x".repeat(90_000) } };
      if (message.word === "screen.see") return { ok: true, result: { content: [{ type: "text", text: "Screen 1080x2400 px" },
        // A JPEG declared as PNG, wrapped base64 as some encoders write it, ten more than are shown, and one that is no image at all.
        { type: "image", data: SCREEN.toString("base64").replace(/(.{40})/g, "$1\n"), mimeType: "image/png" },
        ...Array.from({ length: 9 }, () => ({ type: "image", data: SCREEN.toString("base64"), mimeType: "image/jpeg" })),
        { type: "image", data: Buffer.from("not an image").toString("base64"), mimeType: "image/png" }] } };
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true, result: { done: message.body.n } };
    } });
  const server = new AgentMcpServer({ router, members, ledger, fastPathMs: options.fastPathMs, maxWaitMs: options.maxWaitMs,
    ...(options.artifacts ? { resultArtifacts: { hostDir: options.artifacts, toAgentPath: (path: string) => path } } : {}),
    status: () => ({ paused: false }) });
  const url = await server.start();
  const binding = server.bind("agent:main", "main", () => null);
  return { dir, ledger, router, members, server, url, binding, release: () => release?.() };
}

test("the tool set is fixed, the connection is the identity, and a browser page cannot reach it", async () => {
  const w = await world();
  try {
    const client = new Client({ name: "agent", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(w.url), { requestInit: { headers: { authorization: `Bearer ${w.binding.token}` } } }));
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, [...TOOL_NAMES].sort());
    for (const name of ["system_status", "human_say", "human_confirm", "agent_list", "capability_list", "capability_describe", "capability_call", "await_result", "list_pending", "cancel"])
      assert.ok(tools.includes(name), name);
    for (const tool of (await client.listTools()).tools) {
      const properties = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
      assert.ok(!properties.some((name) => /^(from|sender|member_id|caller)$/.test(name)), `${tool.name} takes no identity parameter`);
    }
    // Outside a turn every action is refused.
    const outside = await client.callTool({ name: "human_say", arguments: { text: "hi" } });
    assert.equal(outside.isError, true);
    assert.equal((JSON.parse((outside.content as { text: string }[])[0]!.text) as ToolResult & { ok: false }).error.code, "forbidden");
    await client.close();

    const anonymous = await fetch(w.url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(anonymous.status, 401);
    const page = await fetch(w.url, { method: "POST", headers: { authorization: `Bearer ${w.binding.token}`, origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(page.status, 403);
  } finally { await w.server.close(); w.ledger.close(); }
});

test("human and meta tools act as the agent within its turn", async () => {
  const w = await world();
  const turn = new AbortController();
  try {
    w.binding.begin("t_test1", turn.signal);
    const said = await w.server.call(w.binding, "human_say", { text: "hello owner" }, turn.signal) as ToolResult;
    assert.equal(said.ok, true);
    const message = w.ledger.list().find((m) => m.to === "person:owner" && m.word === "say")!;
    assert.deepEqual([message.from, message.turn, message.body.text], ["agent:main", "t_test1", "hello owner"]);

    const listed = await w.server.call(w.binding, "capability_list", {}, turn.signal) as ToolResult & { ok: true; result: { members: { id: string; capabilities: { word: string; effect: string }[] }[] } };
    const phone = listed.result.members.find((m) => m.id === "device:phone")!;
    assert.deepEqual(phone.capabilities.map((c) => [c.word, c.effect]), [["battery.get", "read"], ["slow.run", "read"], ["large.get", "read"], ["screen.see", "read"]]);
    assert.ok(!listed.result.members.some((m) => m.id === "agent:main"), "she does not list herself");
    const onlyPhone = await w.server.call(w.binding, "capability_list", { member: "device:phone" }, turn.signal) as ToolResult & { ok: true; result: { members: { id: string }[]; other_members: string[]; note: string } };
    assert.deepEqual(onlyPhone.result.members.map((m) => m.id), ["device:phone"]);
    assert.deepEqual(onlyPhone.result.other_members, listed.result.members.map((m) => m.id).filter((id) => id !== "device:phone"), "one member's list names the others");
    assert.match(onlyPhone.result.note, /without member/);
    const noSuch = await w.server.call(w.binding, "capability_list", { member: "device:nothing" }, turn.signal) as ToolResult & { ok: false };
    assert.match(noSuch.error.message, /without member/);

    const described = await w.server.call(w.binding, "capability_describe", { member: "device:phone", word: "battery.get" }, turn.signal) as ToolResult & { ok: true; result: { capabilities: { input_schema: object; effect: string }[] } };
    assert.equal(described.result.capabilities[0]!.effect, "read");
    assert.ok(described.result.capabilities[0]!.input_schema);

    const battery = await w.server.call(w.binding, "capability_call", { member: "device:phone", word: "battery.get", body: {} }, turn.signal);
    assert.deepEqual(battery, { ok: true, result: { level: 80 } });

    const bad = await w.server.call(w.binding, "capability_call", { member: "device:phone", word: "slow.run", body: { n: "x" } }, turn.signal) as ToolResult & { ok: false };
    assert.equal(bad.error.code, "payload_invalid");
    assert.ok((bad.error.detail as { input_schema?: object }).input_schema, "the correct input format comes back");

    const missing = await w.server.call(w.binding, "capability_call", { member: "device:nothing", word: "x", body: {} }, turn.signal) as ToolResult & { ok: false };
    assert.equal(missing.error.code, "payload_invalid");

    const confirmed = await w.server.call(w.binding, "human_confirm", { title: "say yes", detail: "post the draft" }, turn.signal);
    assert.equal((confirmed as Record<string, unknown>).status, "waiting_owner");
    const refused = await w.server.call(w.binding, "human_confirm", { title: "delete it", detail: "rm" }, turn.signal);
    assert.equal((refused as Record<string, unknown>).status, "waiting_owner");

    const history = await w.server.call(w.binding, "history_query", { text: "hello" }, turn.signal) as ToolResult & { ok: true; result: { messages: { text: string }[] } };
    assert.deepEqual(history.result.messages.map((m) => m.text), ["hello owner"]);
  } finally { turn.abort(); await w.server.close(); w.ledger.close(); }
});

test("a slow call returns a receipt, then await_result collects it", async () => {
  const w = await world({ fastPathMs: 100, maxWaitMs: 2_000 });
  const turn = new AbortController();
  try {
    w.binding.begin("t_test2", turn.signal);
    const receipt = await w.server.call(w.binding, "capability_call", { member: "device:phone", word: "slow.run", body: { n: 3 } }, turn.signal) as { status: string; request_id: string };
    assert.equal(receipt.status, "accepted");
    const pending = await w.server.call(w.binding, "list_pending", {}, turn.signal) as ToolResult & { ok: true; result: { pending: { request_id: string }[] } };
    assert.deepEqual(pending.result.pending.map((p) => p.request_id), [receipt.request_id]);
    const still = await w.server.call(w.binding, "await_result", { request_id: receipt.request_id, timeout_ms: 50 }, turn.signal) as { status: string };
    assert.equal(still.status, "accepted");
    setTimeout(() => w.release(), 50);
    const done = await w.server.call(w.binding, "await_result", { request_id: receipt.request_id }, turn.signal);
    assert.deepEqual(done, { ok: true, result: { done: 3 } });
    const unknown = await w.server.call(w.binding, "await_result", { request_id: "m_nope" }, turn.signal) as ToolResult & { ok: false };
    assert.equal(unknown.error.code, "result_unknown");
  } finally { turn.abort(); await w.server.close(); w.ledger.close(); }
});

test("receipts and their owner survive an MCP server restart", async () => {
  const w = await world({ fastPathMs: 20, maxWaitMs: 2_000 });
  const turn = new AbortController();
  w.binding.begin("t_restart", turn.signal);
  const receipt = await w.server.call(w.binding, "capability_call", { member: "device:phone", word: "slow.run", body: { n: 7 }, wait: false }, turn.signal) as { request_id: string };
  await w.server.close();
  const restarted = new AgentMcpServer({ router: w.router, members: w.members, ledger: w.ledger, fastPathMs: 20, maxWaitMs: 2_000,
    status: () => ({}) });
  const rebound = restarted.bind("agent:main", "main", () => null);
  try {
    const pending = await restarted.call(rebound, "list_pending", {}, turn.signal) as ToolResult & { ok: true; result: { pending: { request_id: string }[] } };
    assert.deepEqual(pending.result.pending.map((item) => item.request_id), [receipt.request_id]);
    setTimeout(() => w.release(), 20);
    assert.deepEqual(await restarted.call(rebound, "await_result", { request_id: receipt.request_id }, turn.signal), { ok: true, result: { done: 7 } });
    const stranger = restarted.bind("agent:other", "other", () => null);
    const hidden = await restarted.call(stranger, "await_result", { request_id: receipt.request_id }, turn.signal) as ToolResult & { ok: false };
    assert.equal(hidden.error.code, "result_unknown");
  } finally { turn.abort(); await restarted.close(); w.ledger.close(); }
});

test("a crash between request acceptance and receipt indexing recovers from authenticated ledger provenance", async () => {
  const w = await world({ maxWaitMs: 2_000 });
  const signal = new AbortController();
  const accepted = await w.router.send({ transport: "agent", transportPrincipal: "agent:main", member: "agent:main", local: true, remote: false, ownerProxy: false, turn: "t_gap" },
    { to: "device:phone", kind: "request", word: "slow.run", body: { n: 9 } }, signal.signal);
  try {
    const pending = await w.server.call(w.binding, "list_pending", {}, signal.signal) as ToolResult & { ok: true; result: { pending: { request_id: string }[] } };
    assert.ok(pending.result.pending.some((item) => item.request_id === accepted.id));
    setTimeout(() => w.release(), 20);
    assert.deepEqual(await w.server.call(w.binding, "await_result", { request_id: accepted.id }, signal.signal), { ok: true, result: { done: 9 } });
    w.ledger.forgetAgentJobs("agent:main");
    const afterDeletion = await w.server.call(w.server.bind("agent:main", "fresh", () => null), "await_result", { request_id: accepted.id }, signal.signal) as ToolResult & { ok: false };
    assert.equal(afterDeletion.error.code, "result_unknown");
  } finally { signal.abort(); await w.server.close(); w.ledger.close(); }
});

test("an oversized MCP result stays valid JSON and points to the complete workspace file", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-results-"));
  const w = await world({ artifacts: root });
  const turn = new AbortController();
  w.binding.begin("t_large", turn.signal);
  const client = new Client({ name: "agent", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(w.url), { requestInit: { headers: { authorization: `Bearer ${w.binding.token}` } } }));
    const response = await client.callTool({ name: "capability_call", arguments: { member: "device:phone", word: "large.get", body: {} } });
    const parsed = JSON.parse((response.content as { text: string }[])[0]!.text) as { result: { truncated: boolean; artifact: { path: string; bytes: number; sha256: string } } };
    assert.equal(parsed.result.truncated, true);
    assert.equal(existsSync(parsed.result.artifact.path), true);
    const full = readFileSync(parsed.result.artifact.path, "utf8");
    assert.equal(JSON.parse(full).result.page.length, 90_000);
    assert.equal(parsed.result.artifact.bytes, Buffer.byteLength(full));
  } finally { turn.abort(); await client.close(); await w.server.close(); w.ledger.close(); }
});

test("images in a capability result reach the agent as MCP image content, not as base64 text", async () => {
  const w = await world();
  const turn = new AbortController();
  w.binding.begin("t_see", turn.signal);
  const client = new Client({ name: "agent", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(w.url), { requestInit: { headers: { authorization: `Bearer ${w.binding.token}` } } }));
    const response = await client.callTool({ name: "capability_call", arguments: { member: "device:phone", word: "screen.see", body: {} } });
    const content = response.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    assert.equal(content[0]!.type, "text");
    assert.equal(content.length, 9, "one text block and at most eight images");
    for (const image of content.slice(1)) assert.deepEqual(image, { type: "image", data: SCREEN.toString("base64"), mimeType: "image/jpeg" });
    const text = content[0]!.text!;
    assert.ok(text.length < 4000, "the base64 stays out of the text");
    assert.doesNotMatch(text, new RegExp(SCREEN.toString("base64").slice(0, 32).replace(/[+/]/g, "\\$&")));
    const parts = (JSON.parse(text) as { result: { content: Record<string, unknown>[] } }).result.content;
    assert.deepEqual(parts[0], { type: "text", text: "Screen 1080x2400 px" });
    assert.deepEqual(parts[1], { type: "image", mimeType: "image/jpeg", bytes: SCREEN.length, shown: "image 1 after this text, as an image you can see" });
    assert.match(String(parts[9]!.omitted), /first 8 images/);
    assert.match(String(parts[11]!.omitted), /not a PNG, JPEG, WebP or GIF/);
    assert.equal(response.isError, undefined);
  } finally { turn.abort(); await client.close(); await w.server.close(); w.ledger.close(); }
});

test("every error code the tool server can emit is in the closed set", () => {
  const source = readFileSync(new URL("../../src/agent-mcp/server.ts", import.meta.url), "utf8");
  const used = new Set([...source.matchAll(/failure\("([a-z_]+)"/g)].map((match) => match[1]!));
  for (const match of source.matchAll(/return failure\("([a-z_]+)"/g)) used.add(match[1]!);
  assert.ok(used.size >= 5);
  for (const code of used) assert.ok((TOOL_ERROR_CODES as readonly string[]).includes(code), code);
  // Router codes all map into the set.
  for (const code of ["payload_invalid", "forbidden", "denied", "unreachable", "timeout", "result_unknown", "capability_error"]) assert.ok(source.includes(`"${code}"`));
});

test("the owner's own words are not reachable as an agent tool identity", async () => {
  const w = await world();
  try {
    await w.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "x" } }).catch(() => undefined);
    const other = w.server.bind("agent:main", "mind", () => null);
    assert.notEqual(other.token, w.binding.token);
  } finally { await w.server.close(); w.ledger.close(); }
});
