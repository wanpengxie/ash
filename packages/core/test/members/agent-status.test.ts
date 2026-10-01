import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { AgentStatus } from "../../src/members/agent-status";
import { createAgentMember } from "../../src/members/agent";
import { Ledger } from "../../src/world/ledger";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const agent: TrustedRouteContext = { transport: "agent", transportPrincipal: "agent:main", member: "agent:main",
  local: true, remote: false, ownerProxy: false };
const screen: TrustedRouteContext = { transport: "web_ui", transportPrincipal: "screen:synthetic", member: "person:owner",
  local: true, remote: false, ownerProxy: true, screenId: "screen:tab", screenLabel: "Tab" };

test("status follows committed turn, tool, ask, typing and idle facts without a model status tool", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-status-"));
  const ledger = await Ledger.open(join(root, "ledger.db"));
  const router = new WorldRouter(ledger, () => true);
  const member = createAgentMember({ ledger, router, stateDir: join(root, "agent"), runner: {
    async runTurn() { return { reason: "completed" }; },
  } });
  assert.equal(member.words().some((word) => word.word === "status"), false);
  assert.equal(member.words().some((word) => word.word === "typing"), true);
  member.status.close(); member.inbox.close();
  router.register({ member: "agent:main", spec: wordContract("agent:main", "typing")!, handle: () => ({ ok: true }) });
  router.register({ member: "person:owner", spec: wordContract("person:owner", "ask")!, handle: () => undefined });
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  router.registerDevice("device:probe", { name: "calendar", description: "Synthetic calendar lookup", input_schema: { type: "object", additionalProperties: false },
    result_schema: { type: "object" }, risk: "none", label: "在看日程" }, async () => { await held; return { ok: true, result: {} }; });
  let now = 10_000;
  let paused = false;
  const status = new AgentStatus(router, () => now, () => paused);
  const states = () => ledger.list({ limit: 1000 }).filter((message) => message.from === "agent:main" && message.word === "status")
    .map((message) => `${message.body.state}:${message.body.text}`);
  try {
    await status.start();
    assert.deepEqual(states(), ["resting:休息中", "idle:在线"]);
    await router.send(agent, { to: null, kind: "event", word: "read", body: { ids: ["m_a"], turn: "t_a" } });
    await router.send(agent, { to: null, kind: "event", word: "turn.start", body: { ids: ["m_a"], turn: "t_a" } });
    await status.settled();
    assert.equal(states().at(-1), "listening:在听");
    now += 1_500; status.refresh(); await status.settled();
    assert.equal(states().at(-1), "thinking:在想");
    const tool = await router.send({ ...agent, turn: "t_a" }, { to: "device:probe", kind: "request", word: "calendar", body: {} });
    await status.settled();
    assert.equal(states().at(-1), "working:在看日程");
    router.cancel([tool.id]); await status.settled();
    assert.equal(states().at(-1), "thinking:在想");
    const ask = await router.send({ ...agent, turn: "t_a" }, { to: "person:owner", kind: "request", word: "ask",
      body: { title: "Choose", detail: "", options: [{ id: "once", label: "Once" }], expires_at: Date.now() + 60_000,
        source: { word: "calendar", to: "device:probe", body_preview: "" } } });
    await status.settled();
    assert.equal(states().at(-1), "waiting_you:等你一句话");
    await router.send(screen, { to: "agent:main", kind: "response", word: "ask", reply_to: ask.id, body: { ok: true, result: { choice: "once" } } });
    await status.settled();
    assert.equal(states().at(-1), "thinking:在想");
    await router.send(agent, { to: null, kind: "event", word: "turn.end", body: { turn: "t_a", reason: "completed" } });
    await status.settled();
    assert.equal(states().at(-1), "done:");
    now += 4_000; status.refresh(); await status.settled();
    assert.equal(states().at(-1), "idle:在线");
    now += 30 * 60_000; status.refresh(); await status.settled();
    assert.equal(states().at(-1), "resting:休息中");
    await router.send(screen, { to: "agent:main", kind: "event", word: "typing", body: {} });
    await status.settled();
    assert.equal(states().at(-1), "listening:在听");
    now += 4_500; status.refresh(); await status.settled();
    assert.equal(states().at(-1), "idle:在线");
    paused = true; status.refresh(); await status.settled();
    assert.equal(states().at(-1), "resting:休息中");
    assert.equal(states().filter((entry) => entry.startsWith("working:")).length, 1);
  } finally {
    release(); status.close(); ledger.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("native DSH tool activity uses a human label and falls back for unknown tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-native-status-"));
  const ledger = await Ledger.open(join(root, "ledger.db"));
  const router = new WorldRouter(ledger, () => true);
  const status = new AgentStatus(router);
  try {
    await status.start();
    const read = router.recordDshToolCall("t_native", "call-read", "read", '{"file_path":"fixture.txt"}');
    await status.settled();
    assert.deepEqual(status.snapshot, { state: "working", text: "在看文件" });
    router.recordDshToolResult(read.id, true, "fixture");
    await status.settled();
    const unknown = router.recordDshToolCall("t_native", "call-other", "unlisted_tool", "{}");
    await status.settled();
    assert.deepEqual(status.snapshot, { state: "working", text: "在忙" });
    router.recordDshToolResult(unknown.id, false, "failed");
  } finally { status.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); }
});

test("status seeds recovered pending routes, prioritizes work, then waits for the owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-status-recover-"));
  const ledger = await Ledger.open(join(root, "ledger.db"));
  const router = new WorldRouter(ledger, () => true);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  router.registerDevice("device:probe", { name: "hold", description: "Held synthetic action", input_schema: { type: "object" },
    risk: "none", label: "在等设备" }, async () => { await held; return { ok: true, result: {} }; });
  router.register({ member: "person:owner", spec: wordContract("person:owner", "ask")!, handle: () => undefined });
  try {
    const ask = await router.send(agent, { to: "person:owner", kind: "request", word: "ask",
      body: { title: "Choose", detail: "", options: [{ id: "once", label: "Once" }], expires_at: Date.now() + 60_000,
        source: { word: "hold", to: "device:probe", body_preview: "" } } });
    const tool = await router.send(agent, { to: "device:probe", kind: "request", word: "hold", body: {} });
    // The controller attaches after both requests: this is the post-router-recovery shape.
    const status = new AgentStatus(router);
    try {
      await status.start();
      assert.deepEqual(ledger.list().filter((message) => message.word === "status").map((message) => message.body.state), ["resting", "working"]);
      router.cancel([tool.id]); await status.settled();
      assert.equal(status.snapshot?.state, "waiting_you");
      router.cancel([ask.id]); await status.settled();
      assert.equal(status.snapshot?.state, "idle");
    } finally { status.close(); }
  } finally { release(); ledger.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a failed status write is not treated as published and can be retried", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-status-retry-"));
  const ledger = await Ledger.open(join(root, "ledger.db"));
  const router = new WorldRouter(ledger, () => true);
  let now = 100;
  const status = new AgentStatus(router, () => now);
  try {
    await status.start();
    const original = router.send.bind(router);
    let rejectOnce = true;
    Object.defineProperty(router, "send", { configurable: true, value: async (...args: Parameters<WorldRouter["send"]>) => {
      if (rejectOnce && args[1].word === "status") { rejectOnce = false; throw new Error("injected status commit failure"); }
      return original(...args);
    } });
    await router.send(agent, { to: null, kind: "event", word: "read", body: { ids: ["m_a"], turn: "t_a" } });
    await assert.rejects(status.settled(), /injected status commit failure/);
    assert.equal(status.snapshot?.state, "idle", "uncommitted status leaked through snapshot");
    assert.deepEqual(ledger.list().filter((message) => message.word === "status").map((message) => message.body.state), ["resting", "idle"]);
    now += 100; status.refresh(); await status.settled();
    assert.equal(status.snapshot?.state, "listening");
    assert.deepEqual(ledger.list().filter((message) => message.word === "status").map((message) => message.body.state), ["resting", "idle", "listening"]);
  } finally { status.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); }
});
