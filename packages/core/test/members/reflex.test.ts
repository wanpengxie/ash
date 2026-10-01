import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import test from "node:test";
import { createAgentMember } from "../../src/members/agent";
import { ReflexMember } from "../../src/members/reflex";
import { judgeStopKeyword } from "../../src/members/reflex-keywords";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "owner:synthetic",
  local: true, remote: false, ownerProxy: true };
const service: TrustedRouteContext = { member: "service:reflex", transport: "service", transportPrincipal: "service:reflex",
  local: true, remote: false, ownerProxy: false };
const wait = async (predicate: () => boolean): Promise<void> => {
  const end = Date.now() + 3000;
  while (Date.now() < end) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("expected ledger state not reached");
};

test("No-Key stop grammar matches only complete short commands", () => {
  for (const text of ["停", "别发了", "算了", "stop", "STOP!", "wait", "不要发了"]) {
    assert.deepEqual(judgeStopKeyword(text), { intent: "stop", confidence: 1 }, text);
  }
  for (const text of ["别忘了明天带伞", "我停在楼下了", "stop the timer", "暂停一下会议", "停在楼下", "stopword", "别发了吗"]) {
    assert.notEqual(judgeStopKeyword(text).intent, "stop", text);
  }
  assert.deepEqual(judgeStopKeyword("hello"), { intent: "unrelated", confidence: 0 });
});

test("busy short stop cancels within one second; ambiguous and idle words only receive ordinary intake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-reflex-"));
  const ledger = await Ledger.open(join(dir, "world.db"));
  const router = new WorldRouter(ledger, async () => true);
  let entered!: () => void, runs = 0;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  const agent = createAgentMember({ ledger, router, stateDir: join(dir, "agent"), runner: { async runTurn(_input, _emit, signal) {
    runs++;
    if (runs === 1) {
      entered();
      await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
      return { reason: "error" as const, error: "synthetic abort" };
    }
    return { reason: "completed" as const };
  } } });
  const reflex = new ReflexMember(router, () => agent.inbox.activeTurn()?.id ?? null);
  const members = new WorldMembers(router);
  members.register(agent); members.register(reflex);
  const rows = () => ledger.list({ limit: 1000 });
  try {
    agent.prepareRecovery(); await router.recover(); await agent.start();
    await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "start a controlled task" }, wait: true });
    await firstEntered;
    for (const phrase of ["别忘了明天带伞", "我停在楼下了", "stop the timer"]) {
      const sent = await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: phrase }, wait: true });
      await wait(() => rows().some((row) => row.word === "reflex.judged" && row.body.message_id === sent.id));
      assert.equal(rows().filter((row) => row.word === "cancel_turn" && row.kind === "request").length, 0);
      assert.equal(agent.inbox.activeTurn() !== null, true);
    }
    const start = performance.now();
    const stop = await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "停" }, wait: true });
    await wait(() => rows().some((row) => row.word === "reflex.judged" && row.body.message_id === stop.id));
    assert.ok(performance.now() - start < 1000, "keyword stop waited beyond one second");
    const decision = rows().find((row) => row.word === "reflex.judged" && row.body.message_id === stop.id)!;
    assert.deepEqual(decision.body, { message_id: stop.id, stage: "keyword", intent: "stop", confidence: 1, acted: true });
    const cancel = rows().find((row) => row.word === "cancel_turn" && row.kind === "request")!;
    assert.equal(cancel.body.by, stop.id);
    assert.deepEqual(ledger.responseTo(cancel.id)?.body, { ok: true, result: { cancelled: true } });
    await wait(() => rows().some((row) => row.word === "turn.end" && row.body.reason === "cancelled"));
    await wait(() => runs === 2);
    await wait(() => rows().filter((row) => row.word === "turn.end").length === 2);
    const before = rows().filter((row) => row.word === "cancel_turn" && row.kind === "request").length;
    const idle = await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "停" }, wait: true });
    await reflex.settled();
    assert.equal(rows().filter((row) => row.word === "cancel_turn" && row.kind === "request").length, before);
    await wait(() => rows().some((row) => row.word === "read" && Array.isArray(row.body.ids) && row.body.ids.includes(idle.id)));
  } finally { await reflex.close(); await agent.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("a stale reflex turn fence cannot cancel a newer active turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-reflex-fence-"));
  const ledger = await Ledger.open(join(dir, "world.db"));
  const router = new WorldRouter(ledger, async () => true);
  let entered!: () => void, release!: () => void;
  const active = new Promise<void>((resolve) => { entered = resolve; });
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const agent = createAgentMember({ ledger, router, stateDir: join(dir, "agent"), runner: { async runTurn() {
    entered(); await hold; return { reason: "completed" as const };
  } } });
  const members = new WorldMembers(router); members.register(agent);
  try {
    agent.prepareRecovery(); await router.recover(); await agent.start();
    await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "work" }, wait: true });
    await active;
    const current = agent.inbox.activeTurn()!.id;
    const reply = await router.send({ ...service, turn: "t_stale" }, { to: "agent:main", kind: "request", word: "cancel_turn",
      body: { reason: "stale decision" }, wait: true });
    assert.deepEqual(reply.reply?.body, { ok: true, result: { cancelled: false } });
    assert.equal(agent.inbox.activeTurn()?.id, current);
  } finally { release(); await agent.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
