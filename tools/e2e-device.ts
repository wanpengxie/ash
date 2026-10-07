// Local-only integration: real core OwnerLink, gateway, device process, and workspace.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startOwner } from "../packages/core/src/main";
import { startDevice } from "../packages/device/src/main";
import { CodexSession } from "../packages/device/src/agents/codex";
import { fileURLToPath } from "node:url";
import { AgentMcpServer } from "../packages/core/src/agent-mcp/server";

const base = process.env.GATEWAY_URL ?? "http://127.0.0.1:18988";
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname)) throw new Error("Local gateway only");
const secret = process.env.BOOTSTRAP_SECRET;
if (!secret) throw new Error("Set a local test bootstrap secret");
const dir = await mkdtemp(join(tmpdir(), "ash-device-e2e-")), stateDir = join(dir, "owner");
await mkdir(stateDir); await writeFile(join(stateDir, "bootstrap-secret"), secret, { mode: 0o600 });
const owner = await startOwner({ listen: "127.0.0.1:0", stateDir, gateway: { url: base }, agents: [{ id: "agent:main", runtime: "echo" }] });
const mcp = new AgentMcpServer({ router: owner.world, ledger: owner.ledger, members: owner.members, fastPathMs: 500, status: () => ({}) });
const controller = new AbortController(), binding = mcp.bind("agent:main", "e2e", () => null);
binding.begin("t_device_e2e", controller.signal);
let device: Awaited<ReturnType<typeof startDevice>> | undefined;
const screenController = new AbortController();
const until = async <T>(check: () => Promise<T | undefined>): Promise<T> => {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await check(); if (value !== undefined) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error("Local device integration timed out");
};
try {
  const link = owner.link!;
  // Ash starts pairing; the code itself is read only by the local owner's screen route, never from her result.
  const started = await mcp.call(binding, "device_pair_start", { kind: "laptop" }, controller.signal) as any;
  assert.equal(started.result?.issued, true, JSON.stringify(started));
  assert.equal(JSON.stringify(started).includes("ticket\":\""), false, "the agent's result carries no pairing code");
  const ownerToken = Object.entries(owner.tokens.api).find(([, member]) => member === "person:owner")![0];
  const view = await (await fetch(`${owner.url}/api/devices/pairing`, { headers: { authorization: `Bearer ${ownerToken}` } })).json() as any;
  assert.equal(view.code?.state, "active");
  assert.equal(owner.ledger.list({ limit: 10000 }).some(m => JSON.stringify(m.body).includes(view.code.ticket)), false, "the code never enters the ledger");
  const pairing = startDevice({ gateway: base, name: "Test workstation", stateDir: join(dir, "device"), workdir: join(dir, "work") }, view.code.ticket, {
    detect: async () => [{kind:"codex",installed:true,logged_in:true,models:[]}],
    agentFactory: (_kind, options) => CodexSession.open(options, {command:process.execPath,args:[fileURLToPath(new URL("../packages/device/test/fixtures/agent-cli.mjs", import.meta.url)),"codex", options.system?.includes("agent:remote") ? "auto" : "manual"]}),
  });
  const pending = await until(async () => [...link.pending.values()].find(p => p.name === "Test workstation"));
  await until(async () => owner.ledger.list({ limit: 10000 }).find(m => m.from === "service:devices" && m.to === "person:owner" && String(m.body.text).startsWith("Test workstation 想连上")));
  const receipt = await mcp.call(binding, "device_pair_approve", { request_id: pending.request_id, kind: "laptop", local_agents: true }, controller.signal) as any;
  assert.ok(receipt.pending_id, JSON.stringify(receipt));
  const token = Object.entries(owner.tokens.api).find(([, member]) => member === "person:owner")![0];
  const stream = await fetch(`${owner.url}/api/stream?follow=true`, { headers: { authorization: `Bearer ${token}` }, signal: screenController.signal });
  const reader = stream.body!.getReader(); let registration = "", screenToken = "";
  while (!screenToken) {
    registration += new TextDecoder().decode((await reader.read()).value);
    for (const block of registration.split("\n\n")) if (block.includes("event: screen.registered")) {
      const data = block.split("\n").find(line => line.startsWith("data:")); if (data) screenToken = JSON.parse(data.slice(5)).token;
    }
  }
  const send = async (message: Record<string, unknown>) => {
    const response = await fetch(`${owner.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "Ash-Screen": screenToken, "content-type": "application/json" }, body: JSON.stringify(message) });
    assert.equal(response.status, 200); return await response.json() as any;
  };
  const ask = owner.ledger.humanPending(receipt.pending_id)!;
  await send({ to: "service:gate", kind: "response", word: "ask", reply_to: ask.ask_id, body: { ok: true, result: { choice: "once" } } });
  await owner.world.refreshHumanPending();
  assert.ok(link.pending.has(pending.request_id), "owner approval does not auto-pair");
  const execution = await mcp.call(binding, "human_pending_redeem", { pending_id: receipt.pending_id }, controller.signal) as any;
  if (execution.status === "accepted") await mcp.call(binding, "await_result", { request_id: execution.request_id }, controller.signal);
  else assert.equal(execution.ok, true, JSON.stringify(execution));
  device = await pairing;
  const id = `device:${pending.client_id}`;
  await until(async () => { await link.refreshDevices(); return owner.members.describe("owner").members.find(m => m.id === id && m.online); });
  console.log("ok: real device pairs and advertises workspace through OwnerLink");
  const manage = async (word: string, body: Record<string, unknown>) => {
    const result = (await send({ to: "service:devices", kind: "request", word, body, wait: true })).reply.body;
    assert.equal(result.ok, true, JSON.stringify(result)); return result.result;
  };
  await manage("rename", { device: id, name: "Renamed workstation" });
  assert.equal(owner.members.describe("owner", id).members[0].name, "Renamed workstation");
  assert.equal((await manage("describe", { device: id })).agents[0].kind, "codex");
  await manage("access_set", { device: id, web_ui: true });
  await until(async () => { await link.refreshDevices(); return owner.members.describe("owner", id).members[0]?.online ? true : undefined; });
  await manage("access_set", { device: id, web_ui: false });
  await until(async () => { await link.refreshDevices(); return owner.members.describe("owner", id).members[0]?.online ? true : undefined; });
  console.log("ok: MCP → owner approval → explicit redemption pairs; rename and web access grants round-trip");
  const call = async (word: string, body: Record<string, unknown>) => {
    const response = await fetch(`${owner.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ to: id, kind: "request", word: `workspace.${word}`, body, wait: true }) });
    assert.equal(response.status, 200);
    const result = (await response.json() as any).reply.body;
    assert.equal(result.ok, true, JSON.stringify(result)); return result.result.data;
  };
  await call("write", { path: "hello.md", content: "# Hello\n完整结果\n" });
  assert.match((await call("read", { path: "hello.md" })).text, /完整结果/);
  await call("edit", { path: "hello.md", edits: [{ oldText: "Hello", newText: "Device" }] });
  assert.match((await call("read", { path: "hello.md" })).text, /Device/);
  console.log("ok: real core → gateway → workspace write/read/edit");
  const job = await call("bash", { command: "printf start; sleep 0.3; printf end", yield_ms: 20 });
  assert.equal(job.running, true);
  const result = await call("poll", { process: job.process, yield_ms: 2000 });
  assert.equal(job.output + result.output, "startend"); assert.equal(result.running, false);
  console.log("ok: command yields process, polling recovers new output");
  const events: any[] = [], calls: any[] = [];
  const peer = link.openAgentChannel(id, {event: event => events.push(event),outbound: async call => {calls.push(call);return {agents:[]};}});
  await until(async()=>peer.connected ? true : undefined);
  const session = await peer.op("open",{kind:"codex"});
  await peer.op("send",{turn:"e2e-turn",text:"hello"},session);
  await until(async()=>calls.length ? true : undefined);
  assert.equal(calls[0].turn,"e2e-turn");assert.equal(calls[0].session,session.session);
  await peer.op("steer",{turn:"e2e-turn",text:"finish"},session);
  await until(async()=>events.find(e=>e.event?.type==="turn_ended"));
  assert.ok(events.at(-1).event.reply.length>4096);
  const delivered = await peer.op("result",{turn:"e2e-turn"},session);
  assert.equal(delivered.event.outcome,"ok");
  await peer.op("send",{turn:"e2e-stop",text:"wait"},session);
  await peer.op("interrupt",{turn:"e2e-stop"},session);
  await until(async()=>events.find(e=>e.event?.turn==="e2e-stop"&&e.event?.type==="turn_ended"));
  assert.equal(events.at(-1).event.outcome,"interrupted");
  await peer.op("close",{},session);
  console.log("ok: real duplex gateway runs fake CLI turn, outbound tool, full result, interrupt and close");
  link.closeAgentChannel(id);
  const runtimes = await mcp.call(binding, "agent_runtimes", {}, controller.signal) as any;
  assert.ok(runtimes.result.runtimes.some((r: any) => r.device === id && r.kind === "codex"));
  const created = await mcp.call(binding, "agent_create", { id: "agent:remote", name: "Remote test", summary: "Integration helper", brief: "Answer test requests", runtime: { device: id, kind: "codex" } }, controller.signal) as any;
  assert.equal(created.ok, true, JSON.stringify(created));
  let answer = await mcp.call(binding, "agent_ask", { agent: "agent:remote", text: "Return the test answer", wait: true }, controller.signal) as any;
  while (answer.status === "accepted") answer = await mcp.call(binding, "await_result", { request_id: answer.request_id }, controller.signal) as any;
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.ok(answer.result.answer.length > 4096);
  assert.ok(owner.ledger.list({ limit: 1000 }).some(m => m.from === "agent:remote" && m.word === "list" && m.to === "service:agents"), "remote outbound runs under the registered agent, not main");
  console.log("ok: DSH MCP discovers runtime, creates remote Agent, delegates, executes its attributed callback and receives full answer");
  await manage("access_set", { device: id, local_agents: false });
  const denied = await mcp.call(binding, "agent_ask", { agent: "agent:remote", text: "must not run", wait: true }, controller.signal) as any;
  assert.equal(denied.ok, false);
  assert.throws(() => link.openAgentChannel(id, { event: () => {}, outbound: async () => ({}) }), /not authorized/);
  await manage("revoke", { device: id });
  assert.ok(!owner.members.describe("owner").members.some(m => m.id === id));
  await Promise.race([device.run, new Promise((_, reject) => setTimeout(() => reject(new Error("Revoked device kept reconnecting")), 3000))]);
  console.log("ok: revoke removes member and stops device reconnect loop");
} finally { screenController.abort(); await device?.close(); await mcp.close(); await owner.close(); }
