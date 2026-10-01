import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { createAgentMember, type AgentTurnInput, type AgentTurnRunner } from "../../src/members/agent";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { RouterError, WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const caller = (member: string): TrustedRouteContext => ({ transport: member.startsWith("service:") ? "service" : "api",
  transportPrincipal: member, member, local: true, remote: false, ownerProxy: false });
const owner = caller("person:owner");
const reflex = caller("service:reflex");
const admin = caller("service:admin");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

async function fixture(runner: AgentTurnRunner) {
  const dir = mkdtempSync(join(tmpdir(), "agent-cancel-"));
  const ledger = await Ledger.open(join(dir, "ledger.db"));
  const router = new WorldRouter(ledger, async () => true);
  const member = createAgentMember({ ledger, router, stateDir: join(dir, "member"), runner });
  new WorldMembers(router).register(member);
  router.register({ member: "person:owner", spec: wordContract("person:owner", "say")!, handle: () => ({ ok: true, result: { accepted: true } }) });
  member.prepareRecovery();
  const rows = () => ledger.list({ after: 0, limit: 1000 });
  const waitFor = async (check: () => boolean) => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) { if (check()) return; await sleep(10); }
    throw new Error("expected state was not reached");
  };
  return { dir, ledger, router, member, rows, waitFor, async close() { await member.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("cancel settles an uncooperative device in under one second, but waits for old runner quiescence before next batch", async () => {
  const deviceEntered = deferred();
  const deviceRelease = deferred();
  const runnerRelease = deferred();
  const batches: AgentTurnInput[] = [];
  let deviceResult: unknown;
  let deviceCalls = 0;
  let f!: Awaited<ReturnType<typeof fixture>>;
  f = await fixture({ async runTurn(input) {
    batches.push(input);
    if (batches.length === 1) {
      const response = await f.router.send({ ...caller("agent:main"), transport: "agent", turn: input.turn },
        { to: "device:probe", kind: "request", word: "hold", body: {}, wait: true });
      deviceResult = response.reply?.body;
      await runnerRelease.promise; // DSH-like session still busy after the tool await was cancelled
    }
    return { reason: "completed" };
  } });
  f.router.register({ member: "device:probe", spec: { word: "hold", kind: "request", description: "Wait in a test device", input_schema: { type: "object", additionalProperties: false },
    result_schema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"], additionalProperties: false }, risk: "none", label: "Waiting" },
    handle: async () => { deviceCalls++; deviceEntered.resolve(); await deviceRelease.promise; return { ok: true, result: { done: true } }; } });
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "first" }, wait: true });
    await deviceEntered.promise;
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "stop now" }, wait: true });
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "and this" }, wait: true });
    const started = performance.now();
    const response = await f.router.send(reflex, { to: "agent:main", kind: "request", word: "cancel_turn", body: { reason: "owner asked to stop" }, wait: true });
    await f.waitFor(() => f.rows().some((message) => message.word === "turn.end" && message.body.reason === "cancelled"));
    assert.ok(performance.now() - started < 1_000, "cancelled terminal exceeded one second");
    assert.deepEqual(response.reply?.body.result, { cancelled: true });
    assert.deepEqual(deviceResult, { ok: false, error: { code: "cancelled", message: "request cancelled; external effect may be unknown" } });
    assert.equal(f.member.waitingForQuiescence, true);
    assert.equal(f.member.counts().pending, 2);
    assert.equal(batches.length, 1, "new turn started in the busy session");
    deviceRelease.resolve(); // late provider success must not replace the cancelled response
    await sleep(30);
    assert.equal(f.rows().filter((message) => message.kind === "response" && message.word === "hold").length, 1);
    assert.equal(batches.length, 1);
    runnerRelease.resolve();
    await f.waitFor(() => batches.length === 2);
    assert.deepEqual(batches[1].messages.map((message) => message.body.text), ["stop now", "and this"]);
    assert.equal(batches[1].stopFacts.length, 1);
    assert.match(batches[1].rendered, /prior-turn stop fact/);
    assert.match(batches[1].rendered, /device:probe\/hold/);
    assert.equal(deviceCalls, 1);
    assert.equal(f.rows().filter((message) => message.word === "turn.end" && message.body.reason === "cancelled").length, 1);
  } finally { deviceRelease.resolve(); runnerRelease.resolve(); await f.close(); }
});

test("only reflex and admin can cancel; idle noop retry cannot cancel a later turn", async () => {
  const gate = deferred();
  const entered = deferred();
  let calls = 0;
  const f = await fixture({ async runTurn() { calls++; entered.resolve(); await gate.promise; return { reason: "completed" }; } });
  try {
    await f.member.start();
    await assert.rejects(f.router.send(owner, { to: "agent:main", kind: "request", word: "cancel_turn", body: { reason: "forged" } }),
      (error: unknown) => error instanceof RouterError && error.code === "forbidden");
    await assert.rejects(f.router.send(caller("service:work"), { to: "agent:main", kind: "request", word: "cancel_turn", body: { reason: "forged service" } }),
      (error: unknown) => error instanceof RouterError && error.code === "forbidden");
    const idle = await f.router.send(admin, { to: "agent:main", kind: "request", word: "cancel_turn", body: { reason: "idle" }, wait: true });
    assert.deepEqual(idle.reply?.body.result, { cancelled: false });
    const old = f.ledger.byId(idle.id)!;
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "new turn" }, wait: true });
    await entered.promise;
    const retry = f.member.handle(old, { signal: new AbortController().signal, recovered: true });
    assert.equal(retry.ok, true);
    if (retry.ok) assert.deepEqual(retry.result, { cancelled: false });
    assert.equal(f.member.waitingForQuiescence, false);
    assert.equal(f.member.counts().active, 1);
    assert.equal(calls, 1);
    const current = await f.router.send(admin, { to: "agent:main", kind: "request", word: "cancel_turn", body: { reason: "actual stop" }, wait: true });
    assert.deepEqual(current.reply?.body.result, { cancelled: true });
  } finally { gate.resolve(); await f.close(); }
});

test("cancellation after claim but before runner dispatch leaves the next message and stop fact intact", async () => {
  const entered = deferred();
  const release = deferred();
  const batches: AgentTurnInput[] = [];
  const f = await fixture({ async runTurn(input) { batches.push(input); return { reason: "completed" }; } });
  const original = f.router.send.bind(f.router);
  f.router.send = (async (...args: Parameters<WorldRouter["send"]>) => {
    if (args[1].word === "turn.start") { entered.resolve(); await release.promise; }
    return original(...args);
  }) as WorldRouter["send"];
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "first" }, wait: true });
    await entered.promise;
    const stopped = await f.router.send(reflex, { to: "agent:main", kind: "request", word: "cancel_turn", body: { reason: "stop before model" }, wait: true });
    assert.deepEqual(stopped.reply?.body.result, { cancelled: true });
    assert.equal(batches.length, 0);
    release.resolve();
    await f.waitFor(() => f.rows().some((message) => message.word === "turn.end" && message.body.reason === "cancelled"));
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "after stop" }, wait: true });
    await f.waitFor(() => batches.length === 1);
    assert.deepEqual(batches[0].messages.map((message) => message.body.text), ["after stop"]);
    assert.equal(batches[0].stopFacts.length, 1);
    assert.match(batches[0].rendered, /stop before model/);
  } finally { release.resolve(); await f.close(); }
});

test("cancel fences an outbound reply delayed before router acceptance", async () => {
  const entered = deferred();
  const release = deferred();
  const f = await fixture({ async runTurn(_input, emit) { await emit({ id: "held", text: "should not publish" }); return { reason: "completed" }; } });
  const original = f.router.send.bind(f.router);
  f.router.send = (async (...args: Parameters<WorldRouter["send"]>) => {
    if (args[0].member === "agent:main" && args[1].to === "person:owner" && args[1].word === "say") { entered.resolve(); await release.promise; }
    return original(...args);
  }) as WorldRouter["send"];
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "go" }, wait: true });
    await entered.promise;
    const stopped = await f.router.send(admin, { to: "agent:main", kind: "request", word: "cancel_turn", body: { reason: "stop delayed reply" }, wait: true });
    assert.deepEqual(stopped.reply?.body.result, { cancelled: true });
    release.resolve();
    await f.waitFor(() => f.rows().some((message) => message.word === "turn.end" && message.body.reason === "cancelled"));
    assert.equal(f.rows().filter((message) => message.kind === "request" && message.from === "agent:main" && message.to === "person:owner" && message.word === "say").length, 0);
  } finally { release.resolve(); await f.close(); }
});

test("turn settlement is restricted to the named agent's own requests", async () => {
  const f = await fixture({ async runTurn() { return { reason: "completed" }; } });
  f.router.register({ member: "device:probe", spec: { word: "hold", kind: "request", description: "Wait in a test device", input_schema: { type: "object", additionalProperties: false },
    risk: "none", label: "Waiting" }, handle: () => new Promise(() => {}) });
  try {
    const other: TrustedRouteContext = { transport: "agent", transportPrincipal: "agent:other", member: "agent:other", local: true, remote: false, ownerProxy: false, turn: "t_shared" };
    const request = await f.router.send(other, { to: "device:probe", kind: "request", word: "hold", body: {} });
    assert.deepEqual(f.router.cancelTurn("agent:main", "t_shared"), []);
    assert.equal(f.ledger.responseTo(request.id), null);
    assert.equal(f.router.cancel([request.id]).length, 1);
  } finally { await f.close(); }
});

test("an errored turn keeps its stop fact until a durably completed turn consumes it", async () => {
  const entered = deferred();
  const release = deferred();
  const batches: AgentTurnInput[] = [];
  const f = await fixture({ async runTurn(input) {
    batches.push(input);
    if (batches.length === 1) { entered.resolve(); await release.promise; }
    return batches.length === 2 ? { reason: "error", error: "model failed" } : { reason: "completed" };
  } });
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "first" }, wait: true });
    await entered.promise;
    await f.router.send(reflex, { to: "agent:main", kind: "request", word: "cancel_turn", body: { reason: "first stop" }, wait: true });
    release.resolve();
    await f.waitFor(() => !f.member.waitingForQuiescence);
    for (const text of ["error turn", "completed turn", "later turn"]) {
      await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text }, wait: true });
      const expected = text === "error turn" ? 2 : text === "completed turn" ? 3 : 4;
      await f.waitFor(() => f.rows().filter((message) => message.word === "turn.end").length === expected);
    }
    assert.equal(batches[1].stopFacts.length, 1);
    assert.equal(batches[2].stopFacts.length, 1, "error turn consumed the fact");
    assert.deepEqual(batches[3].stopFacts, [], "completed turn failed to consume the fact");
    assert.deepEqual(f.rows().filter((message) => message.word === "turn.end").map((message) => message.body.reason), ["cancelled", "error", "completed", "completed"]);
  } finally { release.resolve(); await f.close(); }
});

test("a second cancellation retains both stop facts for the next completed turn", async () => {
  const firstEntered = deferred(); const secondEntered = deferred();
  const firstRelease = deferred(); const secondRelease = deferred();
  const batches: AgentTurnInput[] = [];
  const f = await fixture({ async runTurn(input) {
    batches.push(input);
    if (batches.length === 1) { firstEntered.resolve(); await firstRelease.promise; }
    if (batches.length === 2) { secondEntered.resolve(); await secondRelease.promise; }
    return { reason: "completed" };
  } });
  try {
    await f.member.start();
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "one" }, wait: true });
    await firstEntered.promise;
    await f.router.send(reflex, { to: "agent:main", kind: "request", word: "cancel_turn", body: { reason: "first stop" }, wait: true });
    firstRelease.resolve();
    await f.waitFor(() => !f.member.waitingForQuiescence);
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "two" }, wait: true });
    await secondEntered.promise;
    assert.equal(batches[1].stopFacts.length, 1);
    await f.router.send(admin, { to: "agent:main", kind: "request", word: "cancel_turn", body: { reason: "second stop" }, wait: true });
    secondRelease.resolve();
    await f.waitFor(() => !f.member.waitingForQuiescence);
    await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "three" }, wait: true });
    await f.waitFor(() => batches.length === 3);
    assert.equal(batches[2].stopFacts.length, 2);
    assert.match(batches[2].rendered, /first stop/);
    assert.match(batches[2].rendered, /second stop/);
  } finally { firstRelease.resolve(); secondRelease.resolve(); await f.close(); }
});
