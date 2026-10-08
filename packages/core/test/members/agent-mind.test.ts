import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../../sdk/src/api";
import { AgentMind, type MindSnapshot, type MindTurnRunner, type WakeOutcome } from "../../src/members/agent-mind";

const snapshot: MindSnapshot = { soul: null, identity: null, user: null, memory: null, heartbeat: null };
const wake = (id: string, reason = "pulse"): Message => ({ id, seq: 1, ts: 1, from: "service:pulse", to: "agent:main", kind: "request", word: "wake", body: { reason, context: { why: "schedule" } } } as unknown as Message);
const never = new AbortController().signal;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function harness(run: MindTurnRunner["runWake"]) {
  const outcomes: Array<[string, WakeOutcome]> = [];
  const mind = new AgentMind({ runWake: run }, async () => snapshot, (message, outcome) => outcomes.push([message.id, outcome]));
  return { mind, outcomes };
}

test("a wake is answered once it is queued; the turn runs on its own and finishes later", async () => {
  let release!: () => void; let started = false;
  const { mind, outcomes } = harness(async () => { started = true; await new Promise<void>((resolve) => { release = resolve; }); });
  const answer = await mind.handleWake(wake("w1"), never);
  assert.deepEqual(answer, { ok: true, result: { accepted: true } });
  await tick();
  assert.equal(started, true); assert.deepEqual(outcomes, [], "the turn has not ended; the request did not wait for it");
  release(); await mind.idle();
  assert.deepEqual(outcomes, [["w1", { ok: true, cancelled: false }]]);
});

test("the request's own signal or deadline does not cancel the turn", async () => {
  const requestSignal = new AbortController();
  let sawAbort = false;
  const { mind, outcomes } = harness(async (_m, _s, signal) => { await tick(); await tick(); sawAbort = signal.aborted; });
  await mind.handleWake(wake("w1"), requestSignal.signal);
  requestSignal.abort(); // the request timing out or being cancelled
  await mind.idle();
  assert.equal(sawAbort, false);
  assert.deepEqual(outcomes, [["w1", { ok: true, cancelled: false }]]);
});

test("wakes run one after another", async () => {
  const order: string[] = [];
  const { mind } = harness(async (message) => { order.push(`start ${message.id}`); await tick(); order.push(`end ${message.id}`); });
  await mind.handleWake(wake("a"), never); await mind.handleWake(wake("b"), never);
  await mind.idle();
  assert.deepEqual(order, ["start a", "end a", "start b", "end b"]);
});

test("a failed turn is reported to the listener and does not stop the next one", async () => {
  let count = 0;
  const { mind, outcomes } = harness(async () => { if (++count === 1) throw new Error("model call failed"); });
  await mind.handleWake(wake("a"), never); await mind.handleWake(wake("b"), never);
  await mind.idle();
  assert.deepEqual(outcomes, [["a", { ok: false, cancelled: false, error: "model call failed" }], ["b", { ok: true, cancelled: false }]]);
});

test("cancelAll (the owner's pause) stops the running turn and drops the queued ones; later wakes are accepted again", async () => {
  let aborted = false;
  const { mind, outcomes } = harness(async (message, _s, signal) => {
    if (message.id !== "a") return;
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }));
    throw new Error("stopped");
  });
  await mind.handleWake(wake("a"), never); await mind.handleWake(wake("b"), never);
  await tick(); mind.cancelAll(); await tick();
  assert.equal(aborted, true);
  await mind.handleWake(wake("c"), never);
  await mind.idle();
  assert.deepEqual(outcomes.map(([id, outcome]) => [id, outcome.ok, outcome.cancelled]), [["a", false, true], ["b", false, true], ["c", true, false]]);
});

test("a closed mind refuses wakes", async () => {
  const { mind } = harness(async () => {});
  await mind.close();
  assert.deepEqual(await mind.handleWake(wake("a"), never), { ok: false, error: { code: "offline", message: "mind unavailable" } });
});
