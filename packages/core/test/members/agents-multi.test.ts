import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { AgentMcpServer, type AgentBinding } from "../../src/agent-mcp/server";
import { resolveAgents, wordAllowed, KEEPER_AGENT } from "../../src/agents";
import { createAgentMember, type AgentTurnInput, type AgentTurnRunner } from "../../src/members/agent";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { RouterError, WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const owner: TrustedRouteContext = { transport: "api", transportPrincipal: "owner", member: "person:owner", local: true, remote: false, ownerProxy: true };
const schedule: TrustedRouteContext = { transport: "service", transportPrincipal: "service:work", member: "service:work", local: true, remote: false, ownerProxy: false };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A runner that answers each turn with a scripted reply, and can act through its MCP binding mid-turn. */
function scripted(reply: (input: AgentTurnInput) => string | null, act?: (input: AgentTurnInput) => Promise<void>, bindingRef?: { current: AgentBinding | null }): AgentTurnRunner & { turns: AgentTurnInput[] } {
  const turns: AgentTurnInput[] = [];
  return { turns, async runTurn(input, emit, signal) {
    turns.push(input);
    bindingRef?.current?.begin(input.turn, signal);
    try {
      await act?.(input);
      const text = reply(input);
      if (text) await emit({ id: `r${turns.length}`, text });
      return { reason: "completed" };
    } finally { bindingRef?.current?.end(input.turn); }
  } };
}

async function world(mainRunner: AgentTurnRunner, keeperRunner: AgentTurnRunner) {
  const dir = mkdtempSync(join(tmpdir(), "agents-multi-"));
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  router.register({ member: "person:owner", spec: wordContract("person:owner", "say")!, handle: () => ({ ok: true, result: { accepted: true } }) });
  let tools: AgentMcpServer | null = null;
  const claimAnswer = (message: Parameters<AgentMcpServer["claimAnswer"]>[0], turn: string) => tools?.claimAnswer(message, turn) ?? false;
  const main = createAgentMember({ ledger, router, stateDir: join(dir, "main"), runner: mainRunner, claimAnswer });
  const keeper = createAgentMember({ id: "agent:keeper", ledger, router, stateDir: join(dir, "keeper"), runner: keeperRunner, name: "整理者", claimAnswer });
  members.register(main);
  members.register(keeper);
  tools = new AgentMcpServer({ router, members, ledger, status: () => ({}), confirm: async () => "rejected", maxWaitMs: 3_000,
    agents: () => [{ id: "agent:main", name: "Ash", summary: "main" }, { id: "agent:keeper", name: "整理者", summary: "keeper" }] });
  await tools.start();
  main.prepareRecovery(); keeper.prepareRecovery();
  await main.start(); await keeper.start();
  const says = () => ledger.list({ after: 0, limit: 1000 }).filter((m) => m.kind === "request" && m.word === "say");
  const waitFor = async (check: () => boolean, ms = 4_000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return; await sleep(10); } throw new Error("state not reached"); };
  return { ledger, router, members, main, keeper, tools, says, waitFor, async close() { await main.close(); await keeper.close(); await tools!.close(); ledger.close(); } };
}

test("declarations: the keeper is on by default in the container and limited to its own words", () => {
  const agents = resolveAgents([{ id: "agent:main" }], true);
  assert.deepEqual(agents.map((agent) => agent.id), ["agent:main", "agent:keeper"]);
  assert.deepEqual(resolveAgents([{ id: "agent:keeper", enabled: false }], true).map((agent) => agent.id), ["agent:main"]);
  assert.deepEqual(resolveAgents(undefined, false).map((agent) => agent.id), ["agent:main"]);
  assert.ok(wordAllowed(KEEPER_AGENT, "service:self", "apply_plan"));
  assert.ok(!wordAllowed(KEEPER_AGENT, "device:phone", "clipboard.set"));
  assert.ok(!KEEPER_AGENT.tools!.includes("human_say"));
  assert.throws(() => resolveAgents([{ id: "agent:Bad" }], true), /invalid agent id/);
});

test("a told agent answers the agent that wrote; that answer reaches the teller without starting a reply chain", async () => {
  const mainRunner = scripted((input) => input.messages.some((m) => m.from === "person:owner") ? "好的" : "收到，我不再回");
  const keeperRunner = scripted(() => "我记下了");
  const w = await world(mainRunner, keeperRunner);
  try {
    // Only agents and ash's schedule may speak to a declared agent; the owner talks with the main one.
    await assert.rejects(w.router.send(owner, { to: "agent:keeper", kind: "request", word: "say", body: { text: "hi" } }),
      (error) => error instanceof RouterError && error.code === "forbidden");
    const mainContext: TrustedRouteContext = { transport: "agent", transportPrincipal: "agent:main", member: "agent:main", local: true, remote: false, ownerProxy: false };
    const told = await w.router.send(mainContext, { to: "agent:keeper", kind: "request", word: "say", body: { text: "主人改名叫小王了" } });
    await w.waitFor(() => w.says().some((m) => m.from === "agent:keeper" && m.to === "agent:main"));
    const reply = w.says().find((m) => m.from === "agent:keeper" && m.to === "agent:main")!;
    assert.deepEqual(reply.body, { text: "我记下了", in_reply_to: told.id });
    // The reply starts a turn for main, but main's words in it go to nobody: no ping-pong.
    await w.waitFor(() => mainRunner.turns.length === 1);
    await sleep(100);
    assert.equal(w.says().filter((m) => m.from === "agent:main" && m.id !== told.id).length, 0);
    assert.equal(keeperRunner.turns.length, 1);
  } finally { await w.close(); }
});

test("a scheduled wake is a silent turn: nothing the agent writes goes anywhere", async () => {
  const keeperRunner = scripted(() => "整理完了");
  const w = await world(scripted(() => "x"), keeperRunner);
  try {
    await w.router.send(schedule, { to: "agent:keeper", kind: "request", word: "say", body: { text: "[定时唤醒]" } });
    await w.waitFor(() => keeperRunner.turns.length === 1);
    await sleep(100);
    assert.equal(w.says().filter((m) => m.from === "agent:keeper").length, 0);
  } finally { await w.close(); }
});

test("agent_ask returns the other agent's answer inside the asking turn, and the answer does not start a new turn", async () => {
  const mainBinding: { current: AgentBinding | null } = { current: null };
  let asked: unknown;
  const mainRunner = scripted((input) => input.messages.some((m) => m.from === "person:owner") ? `小王的生日是${JSON.stringify(asked)}` : null,
    async (input) => {
      if (!input.messages.some((m) => m.from === "person:owner")) return;
      asked = await w.tools.call(mainBinding.current!, "agent_ask", { agent: "agent:keeper", text: "主人生日记的是哪天？" }, new AbortController().signal);
    }, mainBinding);
  const keeperRunner = scripted(() => "MEMORY.md 里记的是 3 月 4 日");
  let w!: Awaited<ReturnType<typeof world>>;
  w = await world(mainRunner, keeperRunner);
  mainBinding.current = w.tools.bind("agent:main", "main", () => null);
  try {
    await w.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "我生日哪天来着" } });
    await w.waitFor(() => w.says().some((m) => m.from === "agent:main" && m.to === "person:owner"));
    assert.deepEqual(asked, { ok: true, result: { agent: "agent:keeper", answer: "MEMORY.md 里记的是 3 月 4 日" } });
    await sleep(150);
    assert.equal(mainRunner.turns.length, 1, "the answer was kept by the asking turn");
    const answer = w.says().find((m) => m.from === "agent:keeper")!;
    const read = w.ledger.list({ after: 0, limit: 1000 }).find((m) => m.from === "agent:main" && m.word === "read" && (m.body.ids as string[]).includes(answer.id));
    assert.equal(read?.body.turn, mainRunner.turns[0]!.turn);
    // A keeper's binding cannot use tools outside its declaration.
    const keeperBinding = w.tools.bind("agent:keeper", "keeper", () => null, { tools: KEEPER_AGENT.tools, words: (m, word) => wordAllowed(KEEPER_AGENT, m, word) });
    const turn = new AbortController();
    keeperBinding.begin("t_keeper1", turn.signal);
    const said = await w.tools.call(keeperBinding, "human_say", { text: "hi" }, turn.signal) as { ok: boolean; error?: { code: string } };
    assert.equal(said.error?.code, "forbidden");
    const call = await w.tools.call(keeperBinding, "capability_call", { member: "person:owner", word: "say", body: { text: "hi" } }, turn.signal) as { error?: { code: string } };
    assert.equal(call.error?.code, "forbidden");
    const list = await w.tools.call(keeperBinding, "agent_list", {}, turn.signal) as { result: { you: string; agents: { id: string }[] } };
    assert.equal(list.result.you, "agent:keeper");
    turn.abort();
  } finally { await w.close(); }
});
