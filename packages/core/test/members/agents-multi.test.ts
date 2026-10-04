import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { AgentMcpServer, TOOL_NAMES, type AgentBinding } from "../../src/agent-mcp/server";
import { AgentSystem, type AgentRuntime } from "../../src/agent-system/system";
import { KEEPER_AGENT, MAIN_AGENT, resolveAgents, wordAllowed, type AgentDeclaration } from "../../src/agents";
import { createAgentMember, type AgentTurnInput, type AgentTurnRunner } from "../../src/members/agent";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { RouterError, WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const owner: TrustedRouteContext = { transport: "api", transportPrincipal: "owner", member: "person:owner", local: true, remote: false, ownerProxy: true };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type Script = (input: AgentTurnInput, binding: AgentBinding) => Promise<string | null> | string | null;

/** A world with the main agent, the Agent system and a fake runtime whose agents follow a script and act through MCP. */
async function world(scripts: Record<string, Script>) {
  const dir = mkdtempSync(join(tmpdir(), "agents-multi-"));
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  // Creating, changing and removing agents are structural: they pass the gate (here, one that allows).
  router.setGate(async () => ({ allow: true, by: "rule" }));
  router.register({ member: "person:owner", spec: wordContract("person:owner", "say")!, handle: () => ({ ok: true, result: { accepted: true } }) });
  const tools = new AgentMcpServer({ router, members, ledger, status: () => ({}), confirm: async () => "rejected", maxWaitMs: 3_000, fastPathMs: 3_000 });
  await tools.start();
  const turns: Record<string, AgentTurnInput[]> = {};
  const bindings = new Map<string, AgentBinding>();
  const policy = (item: AgentDeclaration) => ({ ...(item.tools ? { tools: item.tools } : {}), ...(item.words ? { words: (m: string, w: string) => wordAllowed(item, m, w) } : {}) });
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
    dispose: (id) => { const binding = bindings.get(id); if (binding) tools.unbind(binding); bindings.delete(id); },
    apply: (item) => { const binding = bindings.get(item.id); if (binding) binding.policy = policy(item); },
  };
  const main = createAgentMember({ ledger, router, stateDir: join(dir, "main"), runner: runnerFor("agent:main") });
  bindings.set("agent:main", tools.bind("agent:main", "main", () => null, policy(MAIN_AGENT)));
  members.register(main);
  const system = new AgentSystem({ router, members, stateDir: dir, defaults: resolveAgents(undefined, true), main, runtime, toolNames: TOOL_NAMES, isPaused: () => false });
  members.register(system);
  system.prepare();
  main.prepareRecovery();
  await main.start();
  await system.start();
  const says = () => ledger.list({ after: 0, limit: 1000 }).filter((m) => m.kind === "request" && m.word === "say");
  const waitFor = async (check: () => boolean, ms = 4_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return; await sleep(10); } throw new Error("state not reached"); };
  const call = (id: string, name: string, args: Record<string, unknown>) => tools.call(bindings.get(id)!, name, args, new AbortController().signal);
  return { dir, ledger, router, members, main, system, tools, turns, bindings, reopened, says, waitFor, call,
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
    // Agents never write to each other directly, and the owner talks only with the main agent.
    await assert.rejects(w.router.send(mainCtx, { to: "agent:keeper", kind: "request", word: "say", body: { text: "hi" } }), (error) => error instanceof RouterError && error.code === "forbidden");
    await assert.rejects(w.router.send(owner, { to: "agent:keeper", kind: "request", word: "say", body: { text: "hi" } }), (error) => error instanceof RouterError && error.code === "forbidden");
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
    assert.deepEqual((await w.call("agent:main", "agent_remove", { agent: "agent:helper" }) as { result: unknown }).result, { removed: true });
    assert.ok(!w.members.describe("agent").members.some((m) => m.id === "agent:helper"));
    mainTurn.abort(); keeperTurn.abort();
  } finally { await w.close(); }
});
