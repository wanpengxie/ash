import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMcpServer } from "../../src/agent-mcp/server";
import { DevicesMember } from "../../src/members/devices";
import { OwnerMember } from "../../src/members/owner";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";
import { Ledger } from "../../src/world/ledger";
import type { OwnerLink } from "../../src/gateway/link";
import { EdgeRouter, type EdgeCaller } from "../../src/server";

const owner: TrustedRouteContext = { member: "person:owner", transport: "web_ui", transportPrincipal: "owner", screenId: "screen:test", screenLabel: "Test", local: true, remote: false, ownerProxy: true };
const agent: TrustedRouteContext = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false, turn: "t_devices" };
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ash-devices-")), file = join(dir, "devices.json");
  const ledger = await Ledger.open(join(dir, "ledger.db")), router = new WorldRouter(ledger, async () => true), members = new WorldMembers(router);
  router.enableDurableGate(); members.register(new OwnerMember("Owner", ledger));
  const pending = new Map([["pair-1", { request_id: "pair-1", client_id: "pc", name: "Computer", fingerprint: "fingerprint" }]]);
  let paired: any[] = []; const changes: any[] = [], executions: string[] = [];
  const link = { pending, connected: true, lastError: "", state: () => ({ connected: true, devices: paired, pending: [...pending.values()] }),
    ticket: async () => ({ ticket: "test-ticket", gateway: "https://test.invalid", expires_in: 300 }),
    approve: async (id: string, permissions: string[]) => { changes.push({ approve: id, permissions }); paired = [{ id: "device:pc", name: "Computer", online: true, permissions }]; pending.delete(id); },
    reject: async (id: string) => { pending.delete(id); }, refreshDevices: async () => {},
    setWebUi: async (id: string, allow: boolean) => { changes.push({ web: id, allow }); },
    revoke: async () => { paired = []; }, closeAgentChannel: (id: string) => { changes.push({ close: id }); } };
  const service = new DevicesMember(file, () => link as unknown as OwnerLink, router); members.register(service); service.start();
  for (const id of ["device:pc", "device:phone"]) router.registerDeviceBatch(id, [
    { name: "workspace.read", label: "Read file", description: "Read file", risk: "none", effect: "read", input_schema: { type: "object" } },
    { name: "workspace.write", label: "Write file", description: "Write file", risk: "structure", effect: "write", input_schema: { type: "object" } },
    { name: "workspace.bash", label: "Run command", description: "Run command", risk: "structure", effect: "execute", input_schema: { type: "object" } },
  ], (m) => { executions.push(`${m.to}/${m.word}`); return { ok: true, result: {} }; });
  router.setReviewer(async () => ({ decision: "allow", reason: "explicit request", title: "Run", detail: "Run" }));
  const server = new AgentMcpServer({ router, members, ledger, fastPathMs: 100, status: () => ({}) });
  const controller = new AbortController(), binding = server.bind("agent:main", "main", () => null); binding.begin("t_devices", controller.signal);
  const call = (name: string, args: Record<string, unknown> = {}) => server.call(binding, name, args, controller.signal) as Promise<any>;
  const direct = async (word: string, body = {}, ctx = owner) => (await router.send(ctx, { to: "service:devices", kind: "request", word, body, wait: true })).reply!.body as any;
  const answer = async (id: string, choice = "once") => {
    const item = ledger.humanPending(id)!;
    await router.send(owner, { to: "service:gate", kind: "response", word: "ask", reply_to: item.ask_id, body: { ok: true, result: { choice } } });
    await router.refreshHumanPending();
  };
  return { router, ledger, members, service, file, call, direct, answer, changes, executions,
    close: async () => { router.dispose(); await server.close(); ledger.close(); } };
}

test("device MCP pairing freezes grants until owner approves AND main redeems; narrowing is immediate", async () => {
  const w = await fixture(); try {
    const receipt = await w.call("device_pair_approve", { request_id: "pair-1", kind: "laptop", access: "full", local_agents: true });
    assert.ok(receipt.pending_id, JSON.stringify(receipt)); assert.equal(w.changes.length, 0);
    await w.answer(receipt.pending_id); assert.equal(w.changes.length, 0, "approval must not auto-pair");
    const redeemed = await w.call("human_pending_redeem", { pending_id: receipt.pending_id }); assert.equal(redeemed.ok, true, JSON.stringify(redeemed));
    assert.equal(w.service.policy("device:pc"), "full"); assert.equal(w.service.localAgentsAllowed("device:pc"), true);
    assert.deepEqual(w.changes[0].permissions, ["expose_capability"]);
    assert.equal((await w.call("device_access_set", { device: "device:pc", access: "approval", local_agents: false })).ok, true);
    assert.equal(w.service.policy("device:pc"), "approval"); assert.equal(w.service.localAgentsAllowed("device:pc"), false);
    const widening = await w.call("device_access_set", { device: "device:pc", access: "approval", local_agents: true });
    assert.ok(widening.pending_id, "a mixed change with any wider grant must ask"); await w.answer(widening.pending_id, "deny");
    assert.equal(w.service.localAgentsAllowed("device:pc"), false);
    assert.equal(JSON.parse(readFileSync(w.file, "utf8")).devices["device:pc"].access, "approval");
  } finally { await w.close(); }
});

test("browser pairing is limited, helper and remote calls are rejected before asking", async () => {
  const w = await fixture(); try {
    assert.equal((await w.direct("pair_approve", { request_id: "pair-1", kind: "browser", local_agents: true })).ok, false);
    assert.equal((await w.direct("pair_approve", { request_id: "pair-1", kind: "browser" })).ok, true);
    assert.deepEqual(w.changes[0].permissions, ["chat", "web_ui"]); assert.equal(w.service.policy("device:pc"), null);
    await assert.rejects(w.direct("list", {}, { ...agent, member: "agent:helper", transportPrincipal: "agent:helper" }), /local owner or main/);
    await assert.rejects(w.direct("list", {}, { ...owner, local: false, remote: true }), /local owner or main/);
    assert.equal(w.ledger.list({ limit: 1000 }).filter(m => m.word === "gate.asked").length, 0);
  } finally { await w.close(); }
});

test("computer approval reviews commands, asks writes; full bypasses always with audit but never changes phone policy", async () => {
  const w = await fixture(); try {
    await w.direct("pair_approve", { request_id: "pair-1", kind: "laptop" });
    const invoke = async (to: string, word: string) => { const sent = await w.router.send(agent, { to, kind: "request", word, body: {} }); await tick(); return sent.id; };
    await invoke("device:pc", "workspace.bash"); assert.equal(w.executions.length, 1);
    const write = await invoke("device:pc", "workspace.write"); assert.equal(w.ledger.gateCase(write)?.decision, "waiting");
    await w.direct("access_set", { device: "device:pc", access: "full" }); w.router.setApprovalMode(() => "always");
    const full = await invoke("device:pc", "workspace.bash"); assert.equal(w.executions.length, 2);
    assert.equal(w.ledger.list({ limit: 1000 }).find(m => m.word === "gate.passed" && m.body.request_id === full)?.body.by, "device_full");
    const phone = await invoke("device:phone", "workspace.bash"); assert.equal(w.ledger.gateCase(phone)?.decision, "waiting");
    assert.equal(w.service.policy("device:phone"), null);
    await w.direct("revoke", { device: "device:pc" }); assert.equal(w.service.policy("device:pc"), null);
  } finally { await w.close(); }
});

test("a pairing code never reaches an agent or the ledger; only the local owner's screen reads it, until it is used", async () => {
  const w = await fixture(); try {
    const started = await w.call("device_pair_start", { kind: "laptop" });
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.result.issued, true); assert.equal(started.result.expires_in, 300); await tick();
    const ledger = () => JSON.stringify(w.ledger.list({ limit: 1000 }));
    assert.doesNotMatch(JSON.stringify(started) + ledger(), /test-ticket/, "neither the agent's result nor the ledger holds the code");
    // Started by Ash, so the owner is told where to find it.
    assert.ok(w.ledger.list({ limit: 1000 }).some(m => m.from === "service:devices" && m.to === "person:owner" && m.word === "say" && /配对码/.test(String(m.body.text))));
    const view = w.service.pairingView();
    assert.equal(view.code?.state, "active"); assert.equal(view.code?.ticket, "test-ticket");
    assert.equal(view.code?.install_command, "curl -fsSL https://github.com/wanpengxie/ash/releases/download/device-v0.1.1/install.sh | sh -s -- 'https://test.invalid' 'test-ticket'");
    const edge = new EdgeRouter(w.ledger, w.router, w.members, { api: { "owner-token": "person:owner" }, mcp: {} }, { authScopeKey: Buffer.alloc(32, 1), pairing: () => w.service.pairingView() });
    const read = async (caller: EdgeCaller) => { const res = await edge.handle({ method: "GET", url: new URL("/api/devices/pairing", "http://ash"), headers: {}, body: null }, caller);
      return { status: res.status, body: JSON.parse(String("body" in res ? res.body : "{}")) }; };
    const local: EdgeCaller = { member: "person:owner", transportPrincipal: "owner", local: true, remote: false, ownerProxy: true, transport: "api" };
    assert.equal((await read(local)).body.code.ticket, "test-ticket");
    assert.equal((await read({ ...local, local: false, remote: true, pairedDeviceId: "browser", transport: "web_ui" })).status, 403, "a paired browser cannot read it");
    assert.equal((await read({ ...local, member: "agent:main", transportPrincipal: "agent:main", ownerProxy: false, transport: "agent" })).status, 403, "an agent cannot read it");
    // A computer presents the code: it is spent, the owner hears about the request, and the page shows the change.
    w.service.pairingRequested({ request_id: "pair-1", name: "MacBookPro\u0007", fingerprint: "ab12" }); await tick();
    const used = w.service.pairingView();
    assert.equal(used.code?.state, "used"); assert.equal(used.code?.ticket, undefined); assert.equal(used.code?.install_command, undefined);
    assert.notEqual(used.revision, view.revision);
    const notice = w.ledger.list({ limit: 1000 }).filter(m => m.from === "service:devices" && m.to === "person:owner" && m.word === "say").at(-1)!;
    assert.match(String(notice.body.text), /^MacBookPro 想连上 Ash，指纹 ab12。/); assert.equal(notice.body.kind, "due");
    w.service.pairingRequested({ request_id: "pair-1", name: "MacBookPro", fingerprint: "ab12" }); await tick();
    assert.equal(w.ledger.list({ limit: 1000 }).filter(m => m.from === "service:devices" && m.word === "say" && /想连上/.test(String(m.body.text))).length, 1, "one notice per request");
    // The owner starting pairing from the devices page gets no notice: the code is already on their screen.
    const before = w.ledger.list({ limit: 1000 }).filter(m => m.from === "service:devices" && m.word === "say").length;
    assert.equal((await w.direct("pair_start", { kind: "browser" })).ok, true); await tick();
    assert.equal(w.ledger.list({ limit: 1000 }).filter(m => m.from === "service:devices" && m.word === "say").length, before);
    assert.equal(w.service.pairingView().code?.install_command, undefined, "a browser gets the code, not a computer installer");
  } finally { await w.close(); }
});

test("a computer's write asks the owner unless the device itself declares this exact call riskless", async () => {
  const w = await fixture(); try {
    await w.direct("pair_approve", { request_id: "pair-1", kind: "laptop" });
    const asked: string[] = [], contexts: (string | undefined)[] = [];
    let answer: () => Promise<"none" | null> = async () => "none";
    w.router.replaceDeviceBatch("device:pc", [
      { name: "workspace.write", label: "Write file", description: "Write file", risk: "structure", effect: "write", per_call_risk: true, input_schema: { type: "object" } },
      { name: "workspace.bash", label: "Run command", description: "Run command", risk: "structure", effect: "execute", input_schema: { type: "object" } },
    ], (m, context) => { w.executions.push(`${m.to}/${m.word}`); contexts.push(context.declaredRisk); return { ok: true, result: {} }; },
    { assess: async (m) => { asked.push(String(m.body.path)); return answer(); } });
    w.router.setReviewer(async () => ({ decision: "ask", reason: "not asked for" }));
    const settled = async (id: string) => { // Waits on the outcome itself (a card or an answer), never on a fixed time.
      while (!w.ledger.gateCase(id)?.decision && !w.ledger.responseTo(id)) await new Promise(r => setTimeout(r, 5)); return id; };
    const write = async (path: string) => settled((await w.router.send(agent, { to: "device:pc", kind: "request", word: "workspace.write", body: { path, content: "brief" } })).id);
    // Inside the work directory: the device says "none", so it runs with no card and the device is told why it ran.
    const inside = await write("brief.md");
    assert.deepEqual(w.executions, ["device:pc/workspace.write"]); assert.deepEqual(contexts, ["none"]);
    assert.equal(w.ledger.gateCase(inside), null); assert.equal(w.ledger.humanPending(inside), null);
    // Anything else — outside, a failed or silent device — keeps the declared risk: the owner is asked, as before.
    answer = async () => null;
    assert.equal(w.ledger.gateCase(await write("/etc/hosts"))?.decision, "waiting");
    answer = async () => { throw new Error("device offline"); };
    assert.equal(w.ledger.gateCase(await write("brief.md"))?.decision, "waiting");
    assert.equal(w.executions.length, 1);
    // Commands are untouched by it.
    answer = async () => "none";
    const command = await settled((await w.router.send(agent, { to: "device:pc", kind: "request", word: "workspace.bash", body: { command: "ls" } })).id);
    assert.equal(w.ledger.gateCase(command)?.decision, "waiting");
    assert.deepEqual(asked.slice(0, 3), ["brief.md", "/etc/hosts", "brief.md"]);
  } finally { await w.close(); }
});

test("only a capability the device marked per_call_risk is ever assessed", async () => {
  const { DeviceMember } = await import("../../src/members/device");
  const calls: string[] = [];
  const device = new DeviceMember("device:pc", "PC", [
    { name: "workspace.write", label: "w", description: "w", risk: "structure", effect: "write", per_call_risk: true, input_schema: { type: "object" } },
    { name: "workspace.bash", label: "b", description: "b", risk: "structure", effect: "execute", input_schema: { type: "object" } },
  ], () => ({ ok: true, result: {} }), true, undefined, async (m) => { calls.push(m.word); return "none"; });
  const message = (word: string) => ({ word, body: {} }) as never, signal = new AbortController().signal;
  assert.equal(await device.assess(message("workspace.write"), signal), "none");
  assert.equal(await device.assess(message("workspace.bash"), signal), null);
  device.setOnline(false); assert.equal(await device.assess(message("workspace.write"), signal), null);
  assert.deepEqual(calls, ["workspace.write"]);
  const { borrowedCapabilities } = await import("../../src/gateway/link");
  const caps = borrowedCapabilities([
    { name: "workspace.write", description: "w", input_schema: { type: "object" }, risk: "structure", effect: "write", per_call_risk: true },
    { name: "workspace.read", description: "r", input_schema: { type: "object" }, risk: "none", per_call_risk: true },
    { name: "x.y", description: "x", input_schema: { type: "object" }, risk: "structure", per_call_risk: "yes" },
  ], "Mac");
  assert.deepEqual(caps.map((cap) => cap.per_call_risk), [true, undefined, undefined]);
});
