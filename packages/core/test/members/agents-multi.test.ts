import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { AgentMcpServer, TOOL_NAMES, type AgentBinding } from "../../src/agent-mcp/server";
import { AgentSystem, type AgentRuntime } from "../../src/agent-system/system";
import { DeviceAgentRuntimes } from "../../src/agent-system/device-runtime";
import { KEEPER_AGENT, MAIN_AGENT, resolveAgents, wordAllowed, type AgentDeclaration } from "../../src/agents";
import { createAgentMember, type AgentTurnInput, type AgentTurnRunner } from "../../src/members/agent";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { RouterError, WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const owner: TrustedRouteContext = { transport: "api", transportPrincipal: "owner", member: "person:owner", local: true, remote: false, ownerProxy: true };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Script = (input: AgentTurnInput, binding: AgentBinding) => Promise<string | null> | string | null;

test("stopping a work thread cancels its exact running turn and releases the delegator", async () => {
  let childStarted = false;
  const w = await world({
    "agent:main": async (_input, binding) => {
      await w.tools.call(binding, "agent_ask", { agent: "agent:keeper", text: "wait" }, binding.active!.signal);
      return "子任务已返回";
    },
    "agent:keeper": async (_input, binding) => {
      childStarted = true;
      await new Promise<void>(resolve => binding.active!.signal.addEventListener("abort", () => resolve(), { once: true }));
      return null;
    },
  });
  try {
    await w.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "交给整理者" } });
    await w.waitFor(() => childStarted);
    const thread = w.ledger.agentThreads()[0];
    const reply = await w.router.send(owner, { to: "service:agents", kind: "request", word: "thread.stop", body: { thread: thread.id }, wait: true });
    assert.equal(reply.reply?.body.ok, true);
    await w.waitFor(() => w.ledger.turnMessages(thread.turn!).some(m => m.word === "turn.end"));
    assert.equal(w.ledger.agentThread(thread.id)?.state, "cancelled");
    w.system.member("agent:keeper")!.cancelWork("t_not_this_task", "stale");
    assert.equal(w.ledger.agentThread(thread.id)?.state, "cancelled");
    await w.waitFor(() => w.says().some(m => m.from === "agent:main" && m.to === "person:owner"));
  } finally { await w.close(); }
});

test("three-level delegation and creation limits are enforced without broadening authority", async () => {
  const w = await world({});
  try {
    const parent = new AbortController(); w.bindings.get("agent:main")!.begin("t_depth3", parent.signal);
    for (let n = 1; n <= 3; n++) w.ledger.saveAgentThread({ id: `w_depth${n}`, request: `m_depth${n}`, from: `agent:level${n}`, to: "agent:main", turn: `t_depth${n}`,
      ...(n > 1 ? { parent_turn: `t_depth${n - 1}` } : {}), state: "running", at: Date.now() });
    // Route-level check also applies to callers bypassing the convenience MCP wrapper.
    const blocked = await w.router.send({ ...owner, member: "agent:main", transport: "agent", transportPrincipal: "agent:main", ownerProxy: false, turn: "t_depth3" },
      { to: "service:agents", kind: "request", word: "ask", body: { agent: "agent:keeper", text: "fourth level" }, wait: true });
    assert.equal(blocked.reply?.body.ok, false); assert.match(JSON.stringify(blocked.reply?.body), /three levels/);
    w.ledger.saveAgentThread({ id: "w_lend", request: "m_lend", from: "agent:keeper", to: "agent:main", turn: "t_lend", state: "running", at: Date.now() });
    const create = await w.router.send({ ...owner, member: "agent:main", transport: "agent", transportPrincipal: "agent:main", ownerProxy: false, turn: "t_lend" },
      { to: "service:agents", kind: "request", word: "declare", body: { id: "agent:escape", name: "escape", summary: "test", brief: "test", tools: ["agent_remove"], words: [] }, wait: true });
    assert.equal(create.reply?.body.ok, false); assert.equal(w.system.declaration("agent:escape"), undefined);
  } finally { await w.close(); }
});

test("owner can directly address a helper; only that helper replies and unsolicited speech stays forbidden", async () => {
  const w = await world({ "agent:keeper": () => "直接给你的回复", "agent:main": () => "should not wake" });
  try {
    await w.router.send(owner, { to: "agent:keeper", kind: "request", word: "say", body: { text: "@整理者 看看记录" } });
    await w.waitFor(() => w.says().some(m => m.from === "agent:keeper" && m.to === "person:owner"));
    assert.equal(w.turns["agent:main"], undefined);
    await assert.rejects(w.router.send({ member: "agent:keeper", transport: "agent", transportPrincipal: "agent:keeper", local: true, remote: false, ownerProxy: false, turn: "t_unprompted" },
      { to: "person:owner", kind: "request", word: "say", body: { text: "unprompted" } }), /directly addressed/);
  } finally { await w.close(); }
});

test("delegation carries durable thread identity, owner evidence and current permission intersection", async () => {
  let facts: unknown, permitted: unknown;
  const w = await world({
    "agent:main": async (_input, binding) => { await w.tools.call(binding, "agent_ask", { agent: "agent:keeper", text: "请整理" }, new AbortController().signal); return "已完成"; },
    "agent:keeper": input => {
      facts = w.ledger.turnFacts(input.turn, "agent:keeper", Number.MAX_SAFE_INTEGER).ownerSaid;
      permitted = w.system.toolAllowed("agent:keeper", input.turn, "system_status");
      return "完成";
    },
  });
  try {
    await w.router.send(owner, { to: "service:agents", kind: "request", word: "update", body: { agent: "agent:keeper", tools: ["agent_ask", "system_status"] }, wait: true });
    await w.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "这是主人的原话" } });
    await w.waitFor(() => w.says().some(m => m.from === "agent:main" && m.to === "person:owner"));
    assert.deepEqual(facts, ["这是主人的原话"]); assert.equal(permitted, true);
    const thread = w.ledger.agentThreads()[0];
    assert.equal(thread.state, "completed"); assert.equal(thread.from, "agent:main");
    assert.equal(w.ledger.byId(thread.delivery!)?.thread, thread.id);
    assert.ok(w.ledger.turnMessages(thread.turn!).every(m => m.thread === thread.id));
    // A restricted delegator cannot lend a capability that it does not hold itself.
    w.ledger.saveAgentThread({ ...thread, id: "w_limited", turn: "t_limited", from: "agent:keeper", to: "agent:main", parent_turn: undefined });
    assert.equal(w.system.toolAllowed("agent:main", "t_limited", "agent_remove"), false);
    assert.equal(w.system.wordAllowed("agent:main", "t_limited", "device:phone", "screen.tap"), false);
  } finally { await w.close(); }
});

/** A world with the main agent, the Agent system and a fake runtime whose agents follow a script and act through MCP. */
async function world(scripts: Record<string, Script>) {
  const dir = mkdtempSync(join(tmpdir(), "agents-multi-"));
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  router.register({ member: "person:owner", spec: wordContract("person:owner", "say")!, handle: () => ({ ok: true, result: { accepted: true } }) });
  const tools = new AgentMcpServer({ router, members, ledger, status: () => ({}), maxWaitMs: 3_000, fastPathMs: 3_000 });
  await tools.start();
  const turns: Record<string, AgentTurnInput[]> = {};
  const bindings = new Map<string, AgentBinding>();
  let system: AgentSystem;
  const policy = (item: AgentDeclaration) => ({ ...(item.tools ? { tools: item.tools } : {}),
    tool: (name: string, turn?: string) => system?.toolAllowed(item.id, turn, name) ?? true,
    words: (m: string, w: string) => system?.wordAllowed(item.id, bindings.get(item.id)?.active?.turn, m, w) ?? wordAllowed(item, m, w) });
  const runnerFor = (id: string): AgentTurnRunner => ({ async runTurn(input, emit, signal) {
    (turns[id] ??= []).push(input);
    const binding = bindings.get(id)!;
    binding.begin(input.turn, signal);
    try {
      const text = await (scripts[id] ?? (() => null))(input, binding);
      if (text) await emit({ id: `r${turns[id]!.length}`, text });
      return { reason: "completed" };
    } finally { binding.end(input.turn); }
  } });
  const reopened: string[] = [];
  const runtime: AgentRuntime = {
    create: (declaration) => {
      const item = declaration();
      bindings.set(item.id, tools.bind(item.id, item.id.slice(6), () => null, policy(item)));
      return createAgentMember({ id: item.id, ledger, router, stateDir: join(dir, "agents", item.id.slice(6)), runner: runnerFor(item.id), name: item.name });
    },
    reopen: async (id) => { reopened.push(id); },
    dispose: async (id) => { const binding = bindings.get(id); if (binding) tools.retire(binding); bindings.delete(id); },
    apply: (item) => { const binding = bindings.get(item.id); if (binding) binding.policy = policy(item); },
  };
  const main = createAgentMember({ ledger, router, stateDir: join(dir, "main"), runner: runnerFor("agent:main") });
  bindings.set("agent:main", tools.bind("agent:main", "main", () => null, policy(MAIN_AGENT)));
  members.register(main);
  system = new AgentSystem({ router, members, stateDir: dir, defaults: resolveAgents(undefined, true), main, runtime, toolNames: TOOL_NAMES, isPaused: () => false });
  members.register(system);
  system.prepare();
  main.prepareRecovery();
  await main.start();
  await system.start();
  const says = () => ledger.list({ after: 0, limit: 1000 }).filter((m) => m.kind === "request" && m.word === "say");
  const waitFor = async (check: () => boolean, ms = 4_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return; await sleep(10); } throw new Error("state not reached"); };
  const call = (id: string, name: string, args: Record<string, unknown>) => tools.call(bindings.get(id)!, name, args, new AbortController().signal);
  return { dir, ledger, router, members, main, system, tools, turns, bindings, reopened, says, waitFor, call, runtime,
    async close() { await main.close(); await system.close(); await tools.close(); ledger.close(); } };
}

test("declarations: the keeper is built in, kept in ash's state, and limited to discovery, talk and its own words", async () => {
  assert.deepEqual(resolveAgents([{ id: "agent:main" }], true).map((agent) => agent.id), ["agent:main", "agent:keeper"]);
  assert.deepEqual(resolveAgents(undefined, false).map((agent) => agent.id), ["agent:main"]);
  assert.ok(MAIN_AGENT.manage && !KEEPER_AGENT.manage);
  assert.ok(wordAllowed(KEEPER_AGENT, "service:self", "apply_plan") && !wordAllowed(KEEPER_AGENT, "device:phone", "clipboard.set"));
  assert.ok(!KEEPER_AGENT.tools!.some((tool) => tool.startsWith("human_") || ["agent_create", "agent_stop", "agent_remove"].includes(tool)));
  const w = await world({});
  try {
    assert.deepEqual(JSON.parse(readFileSync(join(w.dir, "agents.json"), "utf8")).agents.map((agent: { id: string }) => agent.id), ["agent:main", "agent:keeper"]);
    w.bindings.get("agent:keeper")!.begin("t_list1", new AbortController().signal);
    const listed = await w.call("agent:keeper", "agent_list", {}) as { ok: true; result: { agents: { id: string; state: string }[] } };
    assert.deepEqual(listed.result.agents.map((agent) => [agent.id, agent.state]), [["agent:main", "idle"], ["agent:keeper", "idle"]]);
  } finally { await w.close(); }
});

test("agent_ask is carried by the Agent system: the asked agent's turn answers it, and nobody bounces it back", async () => {
  let asked: unknown;
  const w = await world({
    "agent:main": async (input, binding) => {
      if (!input.messages.some((m) => m.from === "person:owner")) return null;
      asked = await w.tools.call(binding, "agent_ask", { agent: "agent:keeper", text: "主人生日记的是哪天？" }, new AbortController().signal);
      return "好";
    },
    "agent:keeper": (input) => input.messages[0]!.body.from_agent === "agent:main" ? "MEMORY.md 里记的是 3 月 4 日" : null,
  });
  try {
    await w.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "我生日哪天来着" } });
    await w.waitFor(() => w.says().some((m) => m.from === "agent:main" && m.to === "person:owner"));
    assert.deepEqual(asked, { ok: true, result: { agent: "agent:keeper", answer: "MEMORY.md 里记的是 3 月 4 日" } });
    // The question and the answer are on the ledger as the Agent system's request and response.
    const ask = w.ledger.list({ after: 0, limit: 1000 }).find((m) => m.from === "agent:main" && m.to === "service:agents" && m.word === "ask")!;
    assert.equal((w.ledger.responseTo(ask.id)!.body as { ok: boolean }).ok, true);
    await sleep(100);
    assert.equal(w.turns["agent:main"]!.length, 1, "the answer came back as the tool result, not as a new turn");
  } finally { await w.close(); }
});

test("agent_tell: what comes back reaches the teller once, in a turn that says nothing", async () => {
  const w = await world({ "agent:keeper": () => "我记下了", "agent:main": () => "这句话不会发给任何人" });
  try {
    const mainCtx: TrustedRouteContext = { transport: "agent", transportPrincipal: "agent:main", member: "agent:main", local: true, remote: false, ownerProxy: false };
    // Agents never write to each other directly; the owner can explicitly address one.
    await assert.rejects(w.router.send(mainCtx, { to: "agent:keeper", kind: "request", word: "say", body: { text: "hi" } }), (error) => error instanceof RouterError && error.code === "forbidden");
    w.bindings.get("agent:main")!.begin("t_tell1", new AbortController().signal);
    const told = await w.call("agent:main", "agent_tell", { agent: "agent:keeper", text: "主人改名叫小王了" }) as { ok: true; result: { sent: boolean } };
    w.bindings.get("agent:main")!.end("t_tell1");
    assert.equal(told.result.sent, true);
    await w.waitFor(() => w.says().some((m) => m.from === "service:agents" && m.to === "agent:main"));
    const back = w.says().find((m) => m.from === "service:agents" && m.to === "agent:main")!;
    assert.equal(back.body.reply_from, "agent:keeper");
    assert.match(String(back.body.text), /我记下了/);
    await w.waitFor(() => (w.turns["agent:main"] ?? []).length === 1);
    await sleep(100);
    assert.equal(w.says().filter((m) => m.from === "agent:main").length, 0, "main's words about a reply go to nobody");
    assert.equal(w.ledger.list({ after: 0, limit: 1000 }).filter((m) => m.to === "service:agents" && m.word === "tell").length, 1);
  } finally { await w.close(); }
});

test("the main agent manages agents through its system tools; other agents cannot", async () => {
  const w = await world({ "agent:helper": (input) => `helper got: ${String(input.messages[0]!.body.text).slice(-6)}` });
  try {
    const mainTurn = new AbortController();
    w.bindings.get("agent:main")!.begin("t_manage1", mainTurn.signal);
    const created = await w.call("agent:main", "agent_create", { id: "agent:helper", name: "帮手", summary: "查资料", brief: "帮主 Agent 查资料。" }) as { ok: true; result: { id: string; state: string; tools: string[] } };
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.ok(!created.result.tools.includes("agent_create"), "a new agent gets discovery and talk, not management");
    assert.ok(existsSync(join(w.dir, "agents.json")) && readFileSync(join(w.dir, "agents.json"), "utf8").includes("agent:helper"));
    await w.waitFor(() => w.members.describe("agent").members.some((m) => m.id === "agent:helper" && m.online));
    const answer = await w.call("agent:main", "agent_ask", { agent: "agent:helper", text: "你好吗今天？" }) as { result: { answer: string } };
    assert.equal(answer.result.answer, "helper got: 你好吗今天？");
    // The keeper has no management tools at all.
    const keeperTurn = new AbortController();
    w.bindings.get("agent:keeper")!.begin("t_keeper1", keeperTurn.signal);
    const denied = await w.call("agent:keeper", "agent_stop", { agent: "agent:helper" }) as { error: { code: string } };
    assert.equal(denied.error.code, "forbidden");
    const bypass = await w.call("agent:keeper", "capability_call", { member: "service:agents", word: "stop", body: { agent: "agent:helper" } }) as { error: { code: string } };
    assert.equal(bypass.error.code, "forbidden");
    // Stop, start, restart and remove.
    const stopped = await w.call("agent:main", "agent_stop", { agent: "agent:helper" }) as { result: { state: string } };
    assert.equal(stopped.result.state, "stopped");
    const unreachable = await w.call("agent:main", "agent_ask", { agent: "agent:helper", text: "在吗" }) as { error: { code: string } };
    assert.equal(unreachable.error.code, "unreachable");
    assert.equal((await w.call("agent:main", "agent_start", { agent: "agent:helper" }) as { result: { state: string } }).result.state, "idle");
    await w.call("agent:main", "agent_restart", { agent: "agent:helper" });
    assert.deepEqual(w.reopened, ["agent:helper"]);
    const keeperRemoval = await w.call("agent:main", "agent_remove", { agent: "agent:keeper" }) as { error: { code: string } };
    assert.equal(keeperRemoval.error.code, "forbidden", "built-in agents are stopped, not removed");
    const oldToken = w.bindings.get("agent:helper")!.token;
    assert.deepEqual((await w.call("agent:main", "agent_remove", { agent: "agent:helper" }) as { result: unknown }).result, { removed: true });
    assert.ok(!w.members.describe("agent").members.some((m) => m.id === "agent:helper"));
    const recreated = await w.call("agent:main", "agent_create", { id: "agent:helper", name: "新帮手", summary: "重新开始", brief: "不要继承旧会话。" }) as { ok: boolean };
    assert.equal(recreated.ok, true);
    assert.notEqual(w.bindings.get("agent:helper")!.token, oldToken, "a reused display id receives a fresh credential");
    mainTurn.abort(); keeperTurn.abort();
  } finally { await w.close(); }
});

test("only what reaches outside ash is judged: managing agents passes, a device action is asked about", async () => {
  const w = await world({});
  try {
    w.router.register({ member: "person:owner", spec: wordContract("person:owner", "ask")!, handle: () => undefined });
    w.router.enableDurableGate();
    w.router.setReviewer(async () => ({ decision: "ask", reason: "always ask in this test" }));
    w.router.register({ member: "device:phone", spec: { word: "clipboard.set", kind: "request", risk: "outward", label: "改剪贴板", timeout_ms: 5_000,
      description: "Synthetic device action", input_schema: { type: "object", additionalProperties: true } }, handle: () => ({ ok: true, result: {} }) });
    const turn = new AbortController();
    w.bindings.get("agent:main")!.begin("t_judge1", turn.signal);
    const created = await w.call("agent:main", "agent_create", { id: "agent:scout", name: "侦察员", summary: "看看", brief: "随便看看。" }) as { ok: boolean };
    assert.equal(created.ok, true);
    const declare = w.ledger.list({ after: 0, limit: 1000 }).find((m) => m.to === "service:agents" && m.word === "declare")!;
    assert.equal(w.ledger.gateCase(declare.id), null, "an internal system word never reaches the gate");
    const action = await w.call("agent:main", "capability_call", { member: "device:phone", word: "clipboard.set", body: { text: "x" } }) as { status: string; pending_id: string };
    assert.equal(action.status, "waiting_owner");
    assert.ok(w.ledger.gateCase(action.pending_id));
    w.router.withdrawHuman("agent:main", action.pending_id, "测试结束");
    await sleep(50);
    turn.abort();
  } finally { await w.close(); }
});

test("an agent on a computer that is offline or re-paired is still removed; its remote session is forgotten", async () => {
  const w = await world({});
  try {
    const created = await w.router.send(owner, { to: "service:agents", kind: "request", word: "declare",
      body: { id: "agent:remote", name: "远程", summary: "在电脑上干活", brief: "test" }, wait: true });
    assert.equal(created.reply?.body.ok, true, JSON.stringify(created.reply?.body));
    // The computer it ran on was re-paired under a new identity: closing its session there can only fail.
    w.runtime.dispose = async () => { throw new Error("local_agents is no longer authorized or computer is offline"); };
    const removed = await w.router.send(owner, { to: "service:agents", kind: "request", word: "remove", body: { agent: "agent:remote" }, wait: true });
    assert.deepEqual(removed.reply?.body, { ok: true, result: { removed: true } });
    assert.equal(w.system.declaration("agent:remote"), undefined);
    assert.ok(!w.members.describe("owner").members.some((m) => m.id === "agent:remote"));
    assert.ok(!readFileSync(join(w.dir, "agents.json"), "utf8").includes("agent:remote"));
  } finally { await w.close(); }

  const dir = mkdtempSync(join(tmpdir(), "device-runtime-"));
  mkdirSync(join(dir, "agents", "remote"), { recursive: true });
  const session = join(dir, "agents", "remote", "device-session.json");
  writeFileSync(session, JSON.stringify({ session: "s1", generation: "g1" }));
  const pool = new DeviceAgentRuntimes({ link: () => null, allowed: () => false, router: {} as WorldRouter, tools: {} as AgentMcpServer, stateDir: dir });
  pool.create(() => ({ id: "agent:remote", name: "远程", summary: "test", runtime: { device: "device:gone", kind: "codex" } } as AgentDeclaration), {} as AgentBinding);
  await pool.close("agent:remote", true);
  assert.equal(JSON.parse(readFileSync(session, "utf8")), null, "the session on an unreachable computer is forgotten here");
});
