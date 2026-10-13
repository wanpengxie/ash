/**
 * T24b: what the two acceptance rounds of T24 and T17h found. A key the owner has just saved is in the runtime before the next
 * turn opens; a corrected key is written over the wrong one; the end of a turn is told before its failure notice; a lane that
 * cannot be ended does not keep a process from being stopped; a hub that is closing starts nothing from the turns it cuts; only
 * the agent's own process going away is named as such.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { failureCause } from "../../../src/edges/agents/failure";
import { KEY_SYNC_TIMEOUT_MS, RETRY_STEPS_MS } from "../../../src/edges/agents/manager";
import { caller, fixture, settle, waitFor, type FakeDriver } from "./helpers";

const M = "agent:main";
const KEY = "DEEPSEEK_API_KEY";
const vault = caller("service:vault", "service");
const sends = (d: FakeDriver, key: string) => d.of("send").filter((c) => c[2] === key);
const ended = (f: ReturnType<typeof fixture>) => f.router.events("turn.ended").map((e) => e.msg.body as { turn: string; lane: string; outcome: string });

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

test("a key being saved is written before the turn that comes at the same time opens: the owner's words and a wake both wait for it", async () => {
  const f = fixture({ secrets: { [KEY]: "sk-fake-old" } });
  await f.start();
  const d = f.driver();
  const slow = gate();
  d.credentialsGate = slow.promise;
  f.secrets[KEY] = "sk-fake-new";

  const saved = f.service("vault.changed", { ref: KEY, action: "saved" }, vault); // not awaited: the runtime is slow to take the key
  const wake = f.call(M, "wake", { reason: "first meeting" }, { member: "service:semantic", via: "service", local: true });
  const said = f.call(M, "say", { text: "你好" });
  await settle();
  assert.equal(d.of("credentialsSet").length, 2, "the new key is being written");
  assert.equal(d.of("send").length, 0, "no turn opens while the key is on its way");

  slow.open();
  await Promise.all([saved, wake, said]);
  await waitFor(() => d.of("send").length === 2, "both lanes");
  assert.equal(d.credentials.get(KEY), "sk-fake-new");
  const lastSet = d.calls.map((c) => c[0]).lastIndexOf("credentialsSet");
  const firstSend = d.calls.findIndex((c) => c[0] === "send");
  assert.ok(lastSet < firstSend, "the key went in before the first turn");
});

test("a wrong key the owner corrects is written over the old one; a runtime that holds none gets it too", async () => {
  const f = fixture({ secrets: { [KEY]: "sk-fake-wrong" } });
  await f.start();
  const d = f.driver();
  assert.equal(d.credentials.get(KEY), "sk-fake-wrong");
  f.secrets[KEY] = "sk-fake-right";
  await f.service("vault.changed", { ref: KEY, action: "saved" }, vault);
  assert.equal(d.credentials.get(KEY), "sk-fake-right");
  d.credentials.clear();
  await f.service("vault.changed", { ref: KEY, action: "saved" }, vault);
  assert.equal(d.credentials.get(KEY), "sk-fake-right");
});

test("a failed turn tells turn.ended first and the failure notice after it", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.call(M, "say", { text: "做点事" });
  await waitFor(() => sends(d, "front").length === 1);
  const turn = d.running.get(`${M}/front`)!.turn;
  d.finish(M, "front", "error");
  await waitFor(() => f.router.to("person:owner", "show").length === 1);
  const at = (pred: (s: (typeof f.router.sent)[number]) => boolean) => f.router.sent.findIndex(pred);
  const endedAt = at((s) => s.msg.to === null && s.msg.word === "turn.ended" && (s.msg.body as any).turn === turn);
  const noticeAt = at((s) => s.msg.to === "person:owner" && s.msg.word === "say");
  const cardAt = at((s) => s.msg.to === "person:owner" && s.msg.word === "show");
  assert.ok(endedAt >= 0 && noticeAt > endedAt && cardAt > endedAt, `turn.ended ${endedAt}, notice ${noticeAt}, card ${cardAt}`);
});

test("a lane whose turn cannot be ended does not keep the others, or the stop of the process, from happening", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.call(M, "say", { text: "前台" });
  await f.call(M, "wake", { reason: "pulse" }, { member: "service:pulse", via: "service", local: true });
  await waitFor(() => sends(d, "front").length === 1 && sends(d, "back").length === 1);
  const front = d.running.get(`${M}/front`)!.turn;
  const back = d.running.get(`${M}/back`)!.turn;

  const inbox = f.agents.manager.inbox;
  const byTurn = inbox.byTurn.bind(inbox);
  inbox.byTurn = (turn: string) => { if (turn === front) throw new Error("ledger is unwell"); return byTurn(turn); };

  await f.agents.manager.stopAgent(M, "by hand");
  await settle();

  assert.equal(d.of("stop").length, 1, "the process was stopped");
  assert.deepEqual(ended(f).filter((e) => e.turn === back).map((e) => e.outcome), ["interrupted"], "the other lane was ended");
  assert.ok(f.logs.some((l) => /ending the turn of agent:main\/front/.test(String(l[0])) && /ledger is unwell/.test(String(l[0]))));
  assert.notEqual(f.agents.manager.stateOf(M), "working");
  // the agent starts again with the lanes free
  inbox.byTurn = byTurn;
  await f.service("start", { agent: M });
  await settle();
  await f.call(M, "say", { text: "再来" });
  await waitFor(() => sends(d, "front").length === 2);
});

test("a hub that is closing: the turns it cuts start no other lane", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  await f.service("declare", { id: "agent:r", name: "r", summary: "reflective", brief: "reflect",
    lanes: { front: { from: ["person:owner"] }, reflect: { on: ["front:turn.ended"], speak: false } } });
  await settle();
  await f.call("agent:r", "say", { text: "忙着" });
  await waitFor(() => d.of("send").some((c) => c[1] === "agent:r"));

  await f.agents.stopAll();
  await settle();

  assert.ok(ended(f).some((e) => e.lane === "front" && e.outcome === "interrupted"), "the turn was ended");
  assert.equal(f.agents.manager.inbox.pending("agent:r", "reflect").length, 0, "nothing was filed for the reflect lane");
});

test("only the agent's own process going away is named as that: a tool's 'process exited' is not", () => {
  const away = "负责思考的进程中途退出了";
  assert.equal(failureCause("the agent process ended (process exited (SIGKILL))"), away);
  assert.equal(failureCause("process exited (SIGKILL)"), away); // the driver's word for it, at the start of the text
  assert.equal(failureCause("stdin failed: EPIPE"), away);
  assert.equal(failureCause("process failed: spawn ENOENT"), away);
  assert.notEqual(failureCause("tool bash failed: the build process exited with code 2"), away);
  assert.equal(failureCause("the build process exited with code 2"), "出了点意外的错误");
  assert.equal(failureCause("the helper's stdin failed to open"), "出了点意外的错误");
});

test("a runtime that never takes the key holds back only its own agent, and only until the key timeout", async () => {
  const f = fixture({ secrets: { [KEY]: "sk-old" } });
  await f.start();
  const d = f.driver();
  await f.service("declare", { id: "agent:r", name: "r", summary: "s", brief: "b", lanes: { front: { from: ["person:owner"] } } });
  await settle();
  const orig = d.credentialsSet.bind(d);
  d.credentialsSet = async (agent: string, ref: string, value: string) => {
    if (agent === "agent:r") { d.calls.push(["credentialsSet", agent, ref]); return new Promise<void>(() => {}); }
    return orig(agent, ref, value);
  };
  f.secrets[KEY] = "sk-new";
  const saved = f.service("vault.changed", { ref: KEY, action: "saved" }, vault);
  await settle();
  await f.call(M, "say", { text: "hi" });
  await f.call("agent:r", "say", { text: "hello" });
  await waitFor(() => sends(d, "front").some((c) => c[1] === M), "main is not held back by r");
  await settle();
  assert.ok(!d.of("send").some((c) => c[1] === "agent:r"), "r waits for its key");

  assert.ok(f.fire(KEY_SYNC_TIMEOUT_MS), "the key timeout is armed");
  await saved;
  // r's turn tries the write itself once more (the runtime has not taken the key), and is let go after that one's timeout
  await waitFor(() => f.waiting(KEY_SYNC_TIMEOUT_MS).length === 1, "the turn's own write");
  assert.ok(!d.of("send").some((c) => c[1] === "agent:r"));
  assert.ok(f.fire(KEY_SYNC_TIMEOUT_MS));
  await waitFor(() => d.of("send").some((c) => c[1] === "agent:r"), "r goes on once the timeout let go");
  assert.ok(f.logs.some((l) => /agent:r did not take the key/.test(String(l[0]))));
});

test("the owner pauses while a turn waits for the key: it does not open, and opens when the pause ends", async () => {
  const f = fixture({ secrets: { [KEY]: "sk-old" } });
  await f.start();
  const d = f.driver();
  const slow = gate();
  d.credentialsGate = slow.promise;
  let paused = false;
  f.router.on("service:admin/status", () => ({ ok: true, result: { data: { paused } } }));
  f.secrets[KEY] = "sk-new";
  const saved = f.service("vault.changed", { ref: KEY, action: "saved" }, vault);
  await settle();
  await f.call(M, "say", { text: "hi" });
  await settle();
  paused = true;
  await f.service("settings.changed", { keys: ["paused"] }, caller("service:admin", "service"));
  slow.open();
  await saved;
  await settle();
  assert.equal(d.of("send").length, 0, "paused: no turn opens");

  paused = false;
  await f.service("settings.changed", { keys: ["paused"] }, caller("service:admin", "service"));
  await waitFor(() => d.of("send").length === 1, "the turn after the pause");
});

test("a key saved while the agent is still starting is written over the one the runtime already has", async () => {
  const f = fixture({ secrets: { [KEY]: "sk-wrong" } });
  f.agents.manager.driver("dsh");
  const d = f.drivers[0]!;
  d.credentials.set(KEY, "sk-wrong"); // the runtime kept it from before
  const start = gate();
  d.startGate = start.promise;
  void f.agents.startAll();
  await waitFor(() => d.of("start").length === 1);
  f.secrets[KEY] = "sk-right";
  await f.agents.manager.onVaultChanged(KEY, "saved"); // nothing is running yet to hand it to
  start.open();
  await waitFor(() => f.agents.manager.stateOf(M) === "idle");
  await f.call(M, "say", { text: "hi" });
  await waitFor(() => d.of("send").length === 1);
  assert.equal(d.credentials.get(KEY), "sk-right");
  assert.ok(d.calls.map((c) => c[0]).lastIndexOf("credentialsSet") < d.calls.findIndex((c) => c[0] === "send"), "the key went in before the turn");
});

test("a key saved while the agent waits for its next start try is in the runtime before its first turn on the new process", async () => {
  const f = fixture({ secrets: { [KEY]: "sk-wrong" } });
  f.agents.manager.driver("dsh");
  const d = f.drivers[0]!;
  d.credentials.set(KEY, "sk-wrong");
  d.startFailures = 1;
  void f.agents.startAll();
  await waitFor(() => f.agents.manager.stateOf(M) === "starting" && f.waiting(RETRY_STEPS_MS[0]).length === 1, "waiting for the next try");
  f.secrets[KEY] = "sk-right";
  await f.agents.manager.onVaultChanged(KEY, "saved"); // nothing runs: nothing to hand it to
  assert.ok(f.fire(RETRY_STEPS_MS[0]!));
  await waitFor(() => f.agents.manager.stateOf(M) === "idle");
  await f.call(M, "say", { text: "hi" });
  await waitFor(() => d.of("send").length === 1);
  assert.equal(d.credentials.get(KEY), "sk-right");
  assert.ok(d.calls.map((c) => c[0]).lastIndexOf("credentialsSet") < d.calls.findIndex((c) => c[0] === "send"), "the key went in before the first turn");
});

test("a key saved in the gap between the start's key sync and the agent being up is written before its first turn", async () => {
  const f = fixture({ secrets: { [KEY]: "sk-old" } });
  f.agents.manager.driver("dsh");
  const d = f.drivers[0]!;
  d.credentials.set(KEY, "sk-old");
  const has = d.credentialsHas.bind(d);
  let once = true;
  d.credentialsHas = async (agent: string, ref: string) => {
    const had = await has(agent, ref);
    if (once) { once = false; f.secrets[KEY] = "sk-newer"; void f.agents.manager.onVaultChanged(KEY, "saved"); } // the agent is not up yet
    return had;
  };
  await f.start();
  await waitFor(() => f.agents.manager.stateOf(M) === "idle");
  await f.call(M, "say", { text: "hi" });
  await waitFor(() => d.of("send").length === 1);
  assert.equal(d.credentials.get(KEY), "sk-newer");
  assert.ok(d.calls.map((c) => c[0]).lastIndexOf("credentialsSet") < d.calls.findIndex((c) => c[0] === "send"));
});

test("an old write that lands after its timeout puts the old key back; the next turn writes the latest over it", async () => {
  const f = fixture({ secrets: { [KEY]: "sk-v1" } });
  await f.start();
  const d = f.driver();
  const late = gate();
  let first = true;
  d.credentialsSet = async (agent: string, ref: string, value: string) => {
    d.calls.push(["credentialsSet", agent, ref]);
    if (first) { first = false; await late.promise; }
    d.credentials.set(ref, value);
  };
  f.secrets[KEY] = "sk-v2";
  const one = f.service("vault.changed", { ref: KEY, action: "saved" }, vault); // hangs on the runtime
  await settle();
  assert.ok(f.fire(KEY_SYNC_TIMEOUT_MS));
  await one;
  f.secrets[KEY] = "sk-v3";
  await f.service("vault.changed", { ref: KEY, action: "saved" }, vault);
  assert.equal(d.credentials.get(KEY), "sk-v3");
  late.open(); // the first write lands now, with the key it began with
  await settle();
  assert.equal(d.credentials.get(KEY), "sk-v2");

  await f.call(M, "say", { text: "hi" });
  await waitFor(() => d.of("send").length === 1);
  assert.equal(d.credentials.get(KEY), "sk-v3", "corrected before the turn");
  assert.ok(d.calls.map((c) => c[0]).lastIndexOf("credentialsSet") < d.calls.findIndex((c) => c[0] === "send"));
});

test("a lane that cannot be ended tells those who asked in its turn: result_unknown, not a wait for the router's timeout", async () => {
  const f = fixture();
  await f.start();
  const d = f.driver();
  const asked = (f.call(M, "ask", { text: "q" }, caller("agent:other")) as Promise<any>).then((v) => ({ v }), (e) => ({ e }));
  await waitFor(() => sends(d, "back").length === 1);
  const inbox = f.agents.manager.inbox;
  const byTurn = inbox.byTurn.bind(inbox);
  let failures = 1;
  inbox.byTurn = (turn: string) => { if (failures-- > 0) throw new Error("ledger is unwell"); return byTurn(turn); }; // the first look fails, the one after it does not
  d.die(M);
  const r: any = await asked;
  assert.equal(r.e?.code, "result_unknown");
  assert.match(r.e.message, /went away in the middle/, "told by the cut itself, not later by the restart");
  assert.ok(f.logs.some((l) => /ending the turn of agent:main\/back/.test(String(l[0]))));
});

test("an old write that lands late, after a newer one: the next turn writes the latest over it, whatever the timeout said", async () => {
  const f = fixture({ secrets: { [KEY]: "sk-v1" } });
  await f.start();
  const d = f.driver();
  const late = gate();
  let first = true;
  d.credentialsSet = async (agent: string, ref: string, value: string) => {
    d.calls.push(["credentialsSet", agent, ref]);
    if (first) { first = false; await late.promise; }
    d.credentials.set(ref, value);
  };
  f.secrets[KEY] = "sk-v2";
  const one = f.service("vault.changed", { ref: KEY, action: "saved" }, vault); // hangs on the runtime
  await settle();
  f.secrets[KEY] = "sk-v3";
  const two = f.service("vault.changed", { ref: KEY, action: "saved" }, vault); // queued behind the first, saved before it times out
  await settle();
  assert.ok(f.fire(KEY_SYNC_TIMEOUT_MS));
  await Promise.all([one, two]);
  assert.equal(d.credentials.get(KEY), "sk-v3");
  late.open();
  await settle();
  assert.equal(d.credentials.get(KEY), "sk-v2", "the old write landed last");

  const atSend: (string | undefined)[] = [];
  const send = d.send.bind(d);
  d.send = async (a: string, k: string, b: Parameters<typeof send>[2]) => { atSend.push(d.credentials.get(KEY)); return send(a, k, b); };
  await f.call(M, "say", { text: "hi" });
  await waitFor(() => d.of("send").length === 1);
  assert.deepEqual(atSend, ["sk-v3"], "the turn does not meet the old key");
});

test("a runtime that fails the key write: every turn tries again before it opens, and the first turn after it recovers has the key", async () => {
  const f = fixture({ secrets: { [KEY]: "sk-v1" } });
  await f.start();
  const d = f.driver();
  d.instantTurns = true;
  let failing = true;
  d.credentialsSet = async (agent: string, ref: string, value: string) => {
    d.calls.push(["credentialsSet", agent, ref]);
    if (failing) throw Object.assign(new Error("no"), { code: "failed" });
    d.credentials.set(ref, value);
  };
  f.secrets[KEY] = "sk-v2";
  await f.service("vault.changed", { ref: KEY, action: "saved" }, vault); // fails
  const atSend: (string | undefined)[] = [];
  const send = d.send.bind(d);
  d.send = async (a: string, k: string, b: Parameters<typeof send>[2]) => { atSend.push(d.credentials.get(KEY)); return send(a, k, b); };
  for (let i = 1; i <= 3; i++) {
    const sets = d.of("credentialsSet").length;
    if (i === 3) failing = false; // the runtime recovers before the third turn
    await f.call(M, "say", { text: `t${i}` });
    await waitFor(() => d.of("send").length === i, `turn ${i}`);
    await settle();
    assert.ok(d.of("credentialsSet").length > sets, `turn ${i} tried the write again`);
  }
  assert.deepEqual(atSend, ["sk-v1", "sk-v1", "sk-v2"]);
  // the keys are in sync now: the turn after it writes nothing more
  const synced = d.of("credentialsSet").length;
  await f.call(M, "say", { text: "t4" });
  await waitFor(() => d.of("send").length === 4, "turn 4");
  await settle();
  assert.equal(d.of("credentialsSet").length, synced, "a turn after the sync writes no key");
  assert.deepEqual(atSend, ["sk-v1", "sk-v1", "sk-v2", "sk-v2"]);
});
