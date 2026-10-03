import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
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

const owner: TrustedRouteContext = { transport: "api", transportPrincipal: "owner-login", member: "person:owner", local: true, remote: false, ownerProxy: true };

async function world(options: { fastPathMs?: number; maxWaitMs?: number } = {}) {
  const ledger = await Ledger.open(join(mkdtempSync(join(tmpdir(), "ash-mcp-")), "ash.db"));
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
    ],
    handle: async (message) => {
      if (message.word === "battery.get") return { ok: true, result: { level: 80 } };
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true, result: { done: message.body.n } };
    } });
  const confirms: { title: string; detail: string }[] = [];
  const server = new AgentMcpServer({ router, members, ledger, fastPathMs: options.fastPathMs, maxWaitMs: options.maxWaitMs,
    status: () => ({ paused: false }),
    confirm: async (input) => { confirms.push({ title: input.title, detail: input.detail }); return input.title.includes("yes") ? "approved" : "rejected"; } });
  const url = await server.start();
  const binding = server.bind("agent:main", "main", () => null);
  return { ledger, router, members, server, url, binding, confirms, release: () => release?.() };
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
    assert.deepEqual(phone.capabilities.map((c) => [c.word, c.effect]), [["battery.get", "read"], ["slow.run", "read"]]);
    assert.ok(!listed.result.members.some((m) => m.id === "agent:main"), "she does not list herself");

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
    assert.deepEqual(confirmed, { ok: true, result: { decision: "approved" } });
    const refused = await w.server.call(w.binding, "human_confirm", { title: "delete it", detail: "rm" }, turn.signal);
    assert.deepEqual(refused, { ok: true, result: { decision: "rejected" } });
    assert.deepEqual(w.confirms.map((c) => c.title), ["say yes", "delete it"]);

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
    assert.equal(unknown.error.code, "payload_invalid");
  } finally { turn.abort(); await w.server.close(); w.ledger.close(); }
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
