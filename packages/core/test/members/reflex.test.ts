import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentMember } from "../../src/members/agent";
import { startOwner } from "../../src/main";
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
  assert.deepEqual(judgeStopKeyword("暂停"), { intent: "pause", confidence: 1 });
  assert.deepEqual(judgeStopKeyword("hello"), { intent: "unrelated", confidence: 0 });
});

test("an authenticated local owner saying 暂停 uses the existing durable admin pause", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-reflex-pause-"));
  const running = await startOwner({ stateDir: join(dir, "state"), listen: "127.0.0.1:0",
    agents: [{ id: "agent:main", runtime: "echo" }] });
  try {
    const auth = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const response = await fetch(`${running.url}/api/send`, { method: "POST", headers: {
      authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: "暂停" },
        client_id: "owner-pause", wait: true }) });
    assert.equal(response.status, 200);
    const accepted = await response.json() as { id: string };
    await wait(() => running.ledger.list({ limit: 1000 }).some((row) =>
      row.word === "reflex.judged" && row.body.message_id === accepted.id));
    const rows = running.ledger.list({ limit: 1000 });
    assert.equal(rows.filter((row) => row.word === "pause" && row.to === "service:admin").length, 1);
    assert.deepEqual(rows.find((row) => row.word === "reflex.judged" && row.body.message_id === accepted.id)?.body,
      { message_id: accepted.id, stage: "keyword", intent: "pause", confidence: 1, acted: true });
    const pause = rows.find((row) => row.word === "pause" && row.to === "service:admin")!;
    assert.deepEqual(running.ledger.responseTo(pause.id)?.body, { ok: true, result: { paused: true } });
    const retry = await fetch(`${running.url}/api/send`, { method: "POST", headers: {
      authorization: `Bearer ${auth}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "agent:main", kind: "request", word: "say", body: { text: "暂停" },
        client_id: "owner-pause", wait: true }) });
    assert.equal((await retry.json() as { id: string }).id, accepted.id);
    assert.equal(running.ledger.list({ limit: 1000 }).filter((row) => row.word === "pause" && row.to === "service:admin").length, 1);
  } finally { await running.close(); rmSync(dir, { recursive: true, force: true }); }
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
    const stop = await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "停" }, wait: true });
    await wait(() => rows().some((row) => row.word === "reflex.judged" && row.body.message_id === stop.id));
    const decision = rows().find((row) => row.word === "reflex.judged" && row.body.message_id === stop.id)!;
    assert.deepEqual(decision.body, { message_id: stop.id, stage: "keyword", intent: "stop", confidence: 1, acted: true });
    const cancel = rows().find((row) => row.word === "cancel_turn" && row.kind === "request")!;
    assert.ok(cancel.ts - ledger.byId(stop.id)!.ts < 1000, "keyword stop was accepted over one second after the owner message");
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

test("a confident JEV judgement stops an ambiguous command; JEV failure falls back without stopping", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-reflex-jev-"));
  const ledger = await Ledger.open(join(dir, "world.db"));
  const router = new WorldRouter(ledger, async () => true);
  let entered!: () => void;
  const active = new Promise<void>((resolve) => { entered = resolve; });
  const agent = createAgentMember({ ledger, router, stateDir: join(dir, "agent"), runner: { async runTurn(_input, _emit, signal) {
    entered();
    await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    return { reason: "error" as const, error: "synthetic stop" };
  } } });
  let fail = true;
  const reflex = new ReflexMember(router, () => agent.inbox.activeTurn()?.id ?? null, {
    context: (message, turn) => ({ current_task: turn, latest_user_message: String(message.body.text), recent_messages: [] }),
    jev: { async judge(state) {
      assert.match(state.current_task, /^t_/);
      if (fail) throw new Error("synthetic outage");
      return { intent: "stop", confidence: 0.95 };
    } },
  });
  const members = new WorldMembers(router); members.register(agent); members.register(reflex);
  try {
    agent.prepareRecovery(); await router.recover(); await agent.start();
    await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "start" }, wait: true });
    await active;
    const unclear = await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "stop the timer" }, wait: true });
    await wait(() => ledger.list({ limit: 1000 }).some((row) => row.word === "reflex.judged" && row.body.message_id === unclear.id));
    assert.deepEqual(ledger.list({ limit: 1000 }).find((row) => row.word === "reflex.judged" && row.body.message_id === unclear.id)?.body,
      { message_id: unclear.id, stage: "keyword", intent: "unclear", confidence: 0, acted: false });
    assert.equal(ledger.list({ limit: 1000 }).filter((row) => row.word === "cancel_turn").length, 0);
    fail = false;
    const stop = await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "stop that search" }, wait: true });
    await wait(() => ledger.list({ limit: 1000 }).some((row) => row.word === "reflex.judged" && row.body.message_id === stop.id));
    assert.deepEqual(ledger.list({ limit: 1000 }).find((row) => row.word === "reflex.judged" && row.body.message_id === stop.id)?.body,
      { message_id: stop.id, stage: "jev", intent: "stop", confidence: 0.95, acted: true });
    assert.equal(ledger.list({ limit: 1000 }).filter((row) => row.word === "cancel_turn" && row.kind === "request").length, 1);
  } finally { await reflex.close(); await agent.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("while busy, a keyword-free stop such as 够了 reaches JEV and the default bar is 0.6", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-reflex-busy-"));
  const ledger = await Ledger.open(join(dir, "world.db"));
  const router = new WorldRouter(ledger, async () => true);
  let entered!: () => void;
  const active = new Promise<void>((resolve) => { entered = resolve; });
  const agent = createAgentMember({ ledger, router, stateDir: join(dir, "agent"), runner: { async runTurn(_input, _emit, signal) {
    entered();
    await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
    return { reason: "error" as const, error: "synthetic stop" };
  } } });
  const asked: string[] = [];
  const confidence: Record<string, number> = { "够了": 0.65, "差不多了": 0.55 };
  const reflex = new ReflexMember(router, () => agent.inbox.activeTurn()?.id ?? null, {
    context: (message, turn) => ({ current_task: turn, latest_user_message: String(message.body.text), recent_messages: [] }),
    jev: { async judge(state) { asked.push(state.latest_user_message); return { intent: "stop", confidence: confidence[state.latest_user_message] ?? 0.9 }; } },
  });
  const members = new WorldMembers(router); members.register(agent); members.register(reflex);
  const judged = async (text: string) => {
    const sent = await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text }, wait: true });
    await wait(() => ledger.list({ limit: 1000 }).some((row) => row.word === "reflex.judged" && row.body.message_id === sent.id));
    return ledger.list({ limit: 1000 }).find((row) => row.word === "reflex.judged" && row.body.message_id === sent.id)!.body;
  };
  try {
    agent.prepareRecovery(); await router.recover(); await agent.start();
    await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "write a long plan" }, wait: true });
    await active;
    assert.deepEqual({ ...(await judged("差不多了")), message_id: undefined }, { message_id: undefined, stage: "jev", intent: "unrelated", confidence: 0.55, acted: false });
    assert.deepEqual({ ...(await judged("够了")), message_id: undefined }, { message_id: undefined, stage: "jev", intent: "stop", confidence: 0.65, acted: true });
    assert.deepEqual(asked, ["差不多了", "够了"]);
  } finally { await reflex.close(); await agent.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
