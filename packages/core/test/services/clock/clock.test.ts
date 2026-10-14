import assert from "node:assert/strict";
import test from "node:test";
import { WordError, type Caller, type HandleContext, type Message, type Outgoing, type Reply } from "../../../../sdk/src/message";
import { compileSchema } from "../../../../sdk/src/word";
import { Ledger } from "../../../src/kernel/ledger";
import { createClockService, CLOCK_ID } from "../../../src/services/clock";
import { reconcileTimers } from "../../../src/services/semantic/shared";
import { call as callApps, world as appsWorld } from "../../edges/apps/helpers";
import { openLedger } from "../../kernel/ledger/helpers";
import { agent, app, failure, fake, flush, owner, service, success, word, world } from "../../kernel/router/world";

const T0 = 1_800_000_000_000;
const ctx: HandleContext = { signal: new AbortController().signal, caller: { member: "agent:main", via: "agent", local: false }, raw: null };
const msg = (word: string, body: unknown, kind: "request" | "event" = "request", from = "agent:main"): Message =>
  ({ seq: 0, id: "m_1", ts: 0, from, to: CLOCK_ID, kind, word, body });

function setup(ledger = openLedger().ledger) {
  const clock = { t: T0 };
  const all: { msg: Outgoing; caller: Caller }[] = [];
  const router = { send: async (m: Outgoing, caller: Caller): Promise<Reply> => { all.push({ msg: m, caller }); return { ok: true }; } };
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const service = createClockService({ ledger, router, now: () => clock.t, log: () => {},
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; } });
  const call = async (word: string, body: unknown) => {
    const result = await service.handle(msg(word, body), ctx);
    return (result as { data: any }).data;
  };
  const rejects = async (word: string, body: unknown) => {
    try { await service.handle(msg(word, body), ctx); } catch (e) { assert.ok(e instanceof WordError); return (e as WordError).code; }
    assert.fail("expected a WordError");
  };
  return { service, ledger, clock, timers, call, rejects, router,
    /** what went to targets other than the host */
    get sent() { return all.filter((c) => c.msg.to !== "service:host"); },
    /** the host alarm calls, as the time or null for a clear */
    get alarms() { return all.filter((c) => c.msg.to === "service:host").map((c) => (c.msg.word === "wake.clear" ? null : (c.msg.body as { at: number }).at)); } };
}
const set = (extra: Record<string, unknown>) => ({ to: "agent:main", word: "wake", body: { reason: "x" }, label: "x", ...extra });

test("the words are the sdk contracts and set/list/cancel work", async () => {
  const s = setup();
  assert.deepEqual(s.service.words().map((w) => w.word).sort(), ["cancel", "cancel.owner", "list", "set", "wake.fired"]);
  const setContract = s.service.words().find((w) => w.word === "set")!;
  assert.ok(compileSchema(setContract.input_schema)(set({ at: T0 + 1000 })));

  const a = await s.call("set", set({ at: T0 + 60_000, label: "a" }));
  const b = await s.call("set", set({ every: 3600, label: "b", to: "service:agents", word: "session.reload", body: {} }));
  assert.equal(a.next, T0 + 60_000);
  assert.equal(b.next, T0 + 3_600_000);
  const list = await s.call("list", {});
  assert.deepEqual(list.timers.map((t: any) => [t.label, t.every, t.to]), [["a", null, "agent:main"], ["b", 3600, "service:agents"]]);
  assert.equal(list.timers[0].created_by, "agent:main");

  assert.deepEqual(await s.call("cancel", { id: a.id }), { cancelled: true });
  assert.deepEqual(await s.call("cancel", { id: a.id }), { cancelled: false });   // (no `inflight` for a timer that is only waiting or gone)
  assert.equal((await s.call("list", {})).timers.length, 1);
});

test("set refuses a bad time", async () => {
  const s = setup();
  assert.equal(await s.rejects("set", set({})), "bad_request");
  assert.equal(await s.rejects("set", set({ at: T0 - 1 })), "bad_request");
});

test("a due timer sends its stored word as whoever set it (not as service:clock), once, and is gone", async () => {
  const s = setup();
  await s.call("set", set({ at: T0 + 5000, to: "agent:main", word: "wake", body: { reason: "water" } }));
  s.service.check();
  assert.equal(s.sent.length, 0);
  s.clock.t = T0 + 5000;
  s.service.check();
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0]!.msg, { to: "agent:main", kind: "request", word: "wake", body: { reason: "water" } });
  assert.deepEqual(s.sent[0]!.caller, { member: "agent:main", via: "agent", local: false });
  s.service.check();
  assert.equal(s.sent.length, 1);
  assert.equal((await s.call("list", {})).timers.length, 0);
});

test("the in-process timeout fires the check when its time comes", async () => {
  const s = setup();
  await s.call("set", set({ at: T0 + 7000 }));
  const live = s.timers.filter((t) => t.live);
  assert.equal(live.length, 1);
  assert.equal(live[0]!.ms, 7000);
  s.clock.t = T0 + 7000;
  live[0]!.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.sent.length, 1);
});

test("a repeating timer that missed many rounds fires once and goes on from the next slot", async () => {
  const s = setup();
  await s.call("set", set({ every: 60, label: "tick" }));       // next = T0 + 60 s
  s.clock.t = T0 + 60_000 * 10 + 5000;                          // ten rounds later
  s.service.check();
  assert.equal(s.sent.length, 1);
  const [t] = (await s.call("list", {})).timers;
  assert.equal(t.next, T0 + 60_000 * 11);
  s.clock.t = T0 + 60_000 * 11;
  s.service.check();
  assert.equal(s.sent.length, 2);
});

test("at with every fires first at `at`, then repeats", async () => {
  const s = setup();
  const r = await s.call("set", set({ at: T0 + 10_000, every: 120 }));
  assert.equal(r.next, T0 + 10_000);
  s.clock.t = T0 + 10_000;
  s.service.check();
  assert.equal((await s.call("list", {})).timers[0].next, T0 + 130_000);
});

test("timers survive a restart on the same database", async () => {
  const first = openLedger();
  const s1 = setup(first.ledger);
  const { id } = await s1.call("set", set({ at: T0 + 30_000, label: "keep" }));
  s1.service.stop();
  first.ledger.close();
  const reopened = Ledger.open(first.path);
  try {
    const s2 = setup(reopened);
    assert.deepEqual((await s2.call("list", {})).timers.map((t: any) => t.id), [id]);
    s2.clock.t = T0 + 31_000;                                   // the hub was down when it fell due
    s2.service.start();
    assert.equal(s2.sent.length, 1);
    assert.equal(s2.sent[0]!.msg.word, "wake");
  } finally { reopened.close(); }
});

test("the host alarm (service:host) follows the earliest timer and is cleared when none is left", async () => {
  const s = setup();
  const last = () => s.alarms.at(-1);
  await s.call("set", set({ at: T0 + 100_000, label: "late" }));
  assert.equal(last(), T0 + 100_000);
  await s.call("set", set({ at: T0 + 200_000, label: "later" }));
  assert.equal(last(), T0 + 100_000);                             // not the earliest: still the earliest
  const early = await s.call("set", set({ at: T0 + 50_000, label: "early" }));
  assert.equal(last(), T0 + 50_000);
  await s.call("cancel", { id: early.id });
  assert.equal(last(), T0 + 100_000);
  s.clock.t = T0 + 100_000;
  s.service.check();                                              // "late" fired
  assert.equal(last(), T0 + 200_000);
  s.clock.t = T0 + 200_000;
  s.service.check();
  assert.equal(last(), null);                                     // nothing left: cleared
});

test("wake.fired makes the clock look for due timers", async () => {
  const s = setup();
  await s.call("set", set({ at: T0 + 1000 }));
  s.timers.forEach((t) => (t.live = false));                      // the in-process timeout never ran: the phone was asleep
  s.clock.t = T0 + 2000;
  const result = await s.service.handle(msg("wake.fired", { at: T0 + 1000 }, "event", "service:host"), ctx);
  assert.equal(result, undefined);
  assert.equal(s.sent.length, 1);
});

test("a failing host call is only logged; the in-process timeout still runs", async () => {
  const { ledger } = openLedger();
  const logs: string[] = [];
  const timers: { live: boolean }[] = [];
  const svc = createClockService({ ledger, now: () => T0, log: (m) => logs.push(m), setTimer: () => { const t = { live: true }; timers.push(t); return () => { t.live = false; }; },
    router: { send: async (m) => { if (m.to === "service:host") throw new Error("host down"); return { ok: true }; } } });
  await svc.handle(msg("set", set({ at: T0 + 1000 })), ctx);
  await new Promise((r) => setImmediate(r));
  assert.equal(logs.length, 1);
  assert.equal(timers.filter((t) => t.live).length, 1);
  svc.stop();
});

test("a target that never answers does not hold up the other timers", async () => {
  const { ledger } = openLedger();
  const sent: string[] = [];
  const svc = createClockService({ ledger, now: () => T0, log: () => {}, setTimer: () => () => {},
    router: { send: (m) => { sent.push(m.to!); return m.to === "app:slow" ? new Promise<Reply>(() => {}) : Promise.resolve({ ok: true }); } } });
  await svc.handle(msg("set", set({ at: T0, to: "app:slow", word: "ping", body: {}, label: "slow" })), ctx);
  await svc.handle(msg("set", set({ at: T0, to: "device:phone", word: "ping", body: {}, label: "fast" })), ctx);
  svc.check();                                                    // returns at once although app:slow never answers
  assert.ok(sent.includes("device:phone"));
  await svc.handle(msg("wake.fired", { at: T0 }, "event", "service:host"), ctx);   // and so does a host wake
  assert.equal((await svc.handle(msg("list", {}), ctx) as { data: any }).data.timers.length, 0);
  svc.stop();
});

test("a send that fails is logged and does not stop the other timers", async () => {
  const { ledger } = openLedger();
  const sent: string[] = [];
  const logs: string[] = [];
  const svc = createClockService({ ledger, now: () => T0, log: (m) => logs.push(m),
    router: { send: async (m) => { sent.push(m.to!); if (m.to === "app:x") throw new Error("boom"); return { ok: false, error: { code: "offline", message: "gone" } }; } } });
  await svc.handle(msg("set", set({ at: T0, to: "app:x", word: "ping", body: {}, label: "one" })), ctx);
  await svc.handle(msg("set", set({ at: T0, to: "device:phone", word: "ping", body: {}, label: "two" })), ctx);
  svc.check();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.filter((t) => t !== "service:host" && t !== "service:agents").sort(), ["app:x", "device:phone"]);
  assert.equal(logs.filter((l) => l.startsWith("timer")).length, 2);
  svc.stop();
});

// ---- the real router and gate: a timer is the call of the one who set it ----

function hub(options: Parameters<typeof world>[0] = {}) {
  const w = world(options);
  const logs: string[] = [];
  const clock = createClockService({ ledger: w.ledger, router: w.router, now: () => w.clock.now, log: (m) => logs.push(m), setTimer: () => () => {} });
  w.registry.add(clock);
  const body = fake("body:main", [word("body:main", "execute", { effect: "execute", risk: "structure" })]);
  const quiet = fake("service:quiet", [word("service:quiet", "tick", { effect: "write", risk: "none" })]);
  const kernelOnly = fake("service:inner", [word("service:inner", "due", { effect: "write", risk: "none", callers: ["kernel"] })]);
  w.registry.add(body); w.registry.add(quiet); w.registry.add(kernelOnly);
  const setTimerAs = (caller: Caller, to: string, wd: string, label = "t", body: unknown = { command: "id" }) =>
    w.router.send({ to: CLOCK_ID, kind: "request", word: "set", body: { at: w.clock.now + 1000, to, word: wd, body, label } }, caller);
  const fire = async () => { w.clock.now += 2000; clock.check(); await flush(); };
  return { ...w, body, quiet, kernelOnly, setTimerAs, fire, logs };
}

test("a timer an agent set for body:main/execute meets the gate when it is due: the owner is asked, nothing runs", async () => {
  const h = hub();
  success(await h.setTimerAs(agent(), "body:main", "execute"));
  await h.fire();
  assert.equal(h.body.calls.length, 0, "the command did not run");
  assert.equal(h.owner.cards.length, 1, "the owner got the card");
  const card = h.owner.cards[0]!.msg;
  assert.match(JSON.stringify(card.body), /body:main/);
  assert.ok(h.ledger.unfinished().some((r) => r.state === "waiting_owner"), "the request is parked for the owner");
  assert.ok(h.ledger.page({ limit: 50 }).some((m) => m.from === "agent:main" && m.to === "body:main" && m.word === "execute"), "the request is recorded as the agent's");
  assert.ok(!h.ledger.page({ limit: 50 }).some((m) => m.from === CLOCK_ID && m.to === "body:main"));
});

test("a timer an agent set for a word that is for the kernel alone is refused by the callers check when it is due", async () => {
  const h = hub();
  success(await h.setTimerAs(agent(), "service:inner", "due"));
  await h.fire();
  assert.equal(h.kernelOnly.calls.length, 0);
  assert.equal(h.logs.filter((l) => /answered forbidden/.test(l)).length, 1);
});

test("a timer a service set is still sent as that service", async () => {
  const h = hub();
  success(await h.setTimerAs(service("semantic"), "service:inner", "due", "semantic:daily:1"));
  success(await h.setTimerAs(service("semantic"), "body:main", "execute", "semantic:cmd"));
  await h.fire();
  assert.equal(h.kernelOnly.calls.length, 1);
  assert.deepEqual(h.kernelOnly.calls[0]!.ctx.caller, { member: "service:semantic", via: "service", local: true });
  assert.equal(h.body.calls.length, 1, "a service is the hub's own code: no card");
  assert.equal(h.body.calls[0]!.ctx.caller.member, "service:semantic");
  assert.equal(h.owner.cards.length, 0);
});

test("a timer the owner set is sent as the owner", async () => {
  const h = hub();
  success(await h.setTimerAs(owner, "body:main", "execute"));
  await h.fire();
  assert.equal(h.owner.cards.length, 0, "the owner is not asked about their own command");
  assert.equal(h.body.calls.length, 1);
  assert.deepEqual(h.body.calls[0]!.ctx.caller, { member: "person:owner", via: "human", local: true });
});

test("a timer an app set is sent as the app: only what it was granted, and no word that needs approval", async () => {
  const h = hub({ appGranted: (id, to, wd) => id === "app:todo" && ((to === "service:quiet" && wd === "tick") || (to === "body:main" && wd === "execute") || (to === "service:clock")) });
  success(await h.setTimerAs(app(), "service:quiet", "tick", "ok"));
  success(await h.setTimerAs(app(), "body:main", "execute", "bad"));
  await h.fire();
  assert.equal(h.quiet.calls.length, 1);
  assert.equal(h.quiet.calls[0]!.ctx.caller.member, "app:todo");
  assert.equal(h.body.calls.length, 0, "an app cannot get a command through the clock");
  assert.equal(h.owner.cards.length, 0);
  assert.equal(h.logs.filter((l) => /answered (denied|forbidden)/.test(l)).length, 1);
});

test("cancel: one's own timer; the owner and any agent cancel any timer; a service or an app may not cancel someone else's", async () => {
  const h = hub();
  const mine = success(await h.setTimerAs(agent("main"), "service:quiet", "tick", "mine")).id;
  const other = success(await h.setTimerAs(agent("main"), "service:quiet", "tick", "other")).id;
  const third = success(await h.setTimerAs(agent("main"), "service:quiet", "tick", "third")).id;
  const cancel = (id: string, caller: Caller) => h.router.send({ to: CLOCK_ID, kind: "request", word: "cancel", body: { id } }, caller);
  assert.equal(failure(await cancel(mine, service("semantic"))).code, "forbidden");
  assert.equal(failure(await cancel(mine, app())).code, "forbidden");
  assert.deepEqual(success(await cancel(mine, agent("main"))), { cancelled: true });
  assert.deepEqual(success(await cancel(other, owner)), { cancelled: true });
  assert.deepEqual(success(await cancel(third, agent("helper"))), { cancelled: true }, "another agent cancels it as the owner would");
  assert.deepEqual(success(await cancel(other, agent("helper"))), { cancelled: false }, "gone: nothing to cancel");
});

test("list: an app sees only its own timers; the owner, an agent and a service see all", async () => {
  const h = hub({ appGranted: (id, to) => id === "app:todo" && to === CLOCK_ID });
  await h.setTimerAs(agent("main"), "service:quiet", "tick", "a-main");
  await h.setTimerAs(agent("helper"), "service:quiet", "tick", "a-helper");
  await h.setTimerAs(service("semantic"), "service:quiet", "tick", "s");
  await h.setTimerAs(owner, "service:quiet", "tick", "o");
  const labels = async (caller: Caller) =>
    success(await h.router.send({ to: CLOCK_ID, kind: "request", word: "list", body: {} }, caller)).timers.map((t: any) => t.label).sort();
  assert.deepEqual(await labels(agent("main")), ["a-helper", "a-main", "o", "s"]);
  assert.deepEqual(await labels(agent("helper")), ["a-helper", "a-main", "o", "s"]);
  assert.deepEqual(await labels(app()), []);
  assert.deepEqual(await labels(owner), ["a-helper", "a-main", "o", "s"]);
  assert.deepEqual(await labels(service("other")), ["a-helper", "a-main", "o", "s"]);
});

test("the owner's reminder to the owner is delivered; the owner still cannot reach a kernel-only word through a timer", async () => {
  const h = hub();
  success(await h.setTimerAs(owner, "person:owner", "say", "me", { text: "water" }));
  success(await h.setTimerAs(owner, "service:inner", "due", "inner"));
  await h.fire();
  assert.equal(h.owner.said.length, 1, "the reminder reached the owner");
  assert.equal(h.kernelOnly.calls.length, 0, "the owner's timer is still the owner's: a kernel-only word stays out of reach");
  assert.equal(h.logs.filter((l) => /service:inner\/due answered forbidden/.test(l)).length, 1);
});

test("reconcileTimers only counts the timers its own member set: an agent cannot hold a label of the pulse", async () => {
  const h = hub();
  await h.setTimerAs(agent("main"), "service:quiet", "tick", "pulse:wake:1");       // an agent names its timer like the pulse's
  await h.setTimerAs(service("pulse"), "service:quiet", "tick", "pulse:wake:2");
  const want = new Map([["pulse:wake:1", { at: h.clock.now + 5000, body: {} }]]);
  assert.equal(await reconcileTimers(h.router, "service:pulse", "pulse:", "service:quiet", "tick", want), null);
  const all = success(await h.router.send({ to: CLOCK_ID, kind: "request", word: "list", body: {} }, owner)).timers as any[];
  assert.equal(all.filter((t) => t.label === "pulse:wake:1" && t.created_by === "agent:main").length, 1, "the agent's own timer is left alone");
  assert.equal(all.filter((t) => t.label === "pulse:wake:1" && t.created_by === "service:pulse").length, 1, "the pulse laid down its own");
  assert.equal(all.filter((t) => t.label === "pulse:wake:2").length, 0, "its stale one was taken away");
});

// ---- a member that is gone: its timers are taken back ----

test("cancel.owner takes back all of one member's timers and no one else's; it is for the hub alone", async () => {
  const h = hub();
  await h.setTimerAs(agent("helper"), "service:quiet", "tick", "h1");
  await h.setTimerAs(agent("helper"), "service:quiet", "tick", "h2");
  await h.setTimerAs(agent("main"), "service:quiet", "tick", "m");
  await h.setTimerAs(owner, "service:quiet", "tick", "o");
  const cancelOwner = (member: string, caller: Caller) => h.router.send({ to: CLOCK_ID, kind: "request", word: "cancel.owner", body: { member } }, caller);
  const labels = async () => success(await h.router.send({ to: CLOCK_ID, kind: "request", word: "list", body: {} }, owner)).timers.map((t: any) => t.label).sort();

  for (const caller of [agent("main"), agent("helper"), app(), owner]) assert.equal(failure(await cancelOwner("agent:helper", caller)).code, "forbidden");
  assert.deepEqual(await labels(), ["h1", "h2", "m", "o"]);

  assert.deepEqual(success(await cancelOwner("agent:helper", service("agents"))), { cancelled: 2 });
  assert.deepEqual(await labels(), ["m", "o"]);
  assert.deepEqual(success(await cancelOwner("agent:helper", service("agents"))), { cancelled: 0 });
});

test("cancel.owner re-arms: with no timer left the in-process timeout is dropped and the host alarm cleared", async () => {
  const s = setup();
  await s.call("set", set({ every: 3600, label: "x" }));
  assert.equal(s.timers.filter((t) => t.live).length, 1);
  await s.service.handle({ ...msg("cancel.owner", { member: "agent:main" }), from: "service:agents" }, { ...ctx, caller: { member: "service:agents", via: "service", local: true } });
  assert.equal(s.timers.filter((t) => t.live).length, 0);
  assert.equal(s.alarms.at(-1), null);
});

/** A clock whose router says the agent is refused and `service:agents/describe` answers as given. */
function gone(declared: (agent: string) => Reply, code: "forbidden" | "offline" = "forbidden") {
  const { ledger } = openLedger();
  const sent: Outgoing[] = [];
  const logs: string[] = [];
  const svc = createClockService({ ledger, now: () => T0, log: (m) => logs.push(m),
    router: { send: async (m): Promise<Reply> => {
      sent.push(m);
      if (m.to === "service:agents" && m.word === "describe") return declared((m.body as { agent: string }).agent);
      if (m.to === "service:apps" && m.word === "apps.describe") return declared(`app:${(m.body as { id: string }).id}`);
      if (m.to === "service:host") return { ok: true };
      return { ok: false, error: { code, message: "not a declared agent" } };
    } } });
  const setAs = (member: string, via: Caller["via"], label: string, every: number | undefined = 3600) =>
    svc.handle(msg("set", set({ every, at: T0, to: "service:quiet", word: "tick", body: {}, label })), { ...ctx, caller: { member, via, local: false } });
  const labels = () => (svc as any).rows().map((r: any) => r.label).sort();
  const fireAll = async () => { svc.check(); await flush(); };
  return { svc, sent, logs, setAs, labels, fireAll };
}
const notFound = (): Reply => ({ ok: false, error: { code: "not_found", message: "no such agent" } });
const found = (): Reply => ({ ok: true, result: { data: {} } });

test("a repeating timer whose agent is no longer declared is taken back with its siblings, with a log; others stay", async () => {
  const h = gone((a) => (a === "agent:alive" ? found() : notFound()));
  await h.setAs("agent:dead", "agent", "d1");
  await h.setAs("agent:dead", "agent", "d2");
  await h.setAs("agent:alive", "agent", "a");
  await h.setAs("service:semantic", "service", "s");
  await h.fireAll();
  assert.deepEqual(h.labels(), ["a", "s"].sort());
  assert.ok(h.logs.some((l) => /agent:dead is no longer a declared agent/.test(l)));
  const probes = h.sent.filter((m) => m.to === "service:agents" && m.word === "describe");
  assert.deepEqual(probes.map((m) => (m.body as any).agent).sort(), ["agent:alive", "agent:dead"], "timers that fell due together ask once for the same agent");
  h.svc.stop();
});

test("a timer of an agent that is only offline (still declared) stays and goes on", async () => {
  const h = gone(() => found(), "offline");
  await h.setAs("agent:resting", "agent", "r");
  await h.fireAll();
  assert.deepEqual(h.labels(), ["r"], "the repeating timer is kept");
  assert.equal(h.logs.filter((l) => /took back/.test(l)).length, 0);
  h.svc.stop();
});

test("when the check itself fails, nothing is taken back", async () => {
  const h = gone(() => { throw new Error("agents module down"); });
  await h.setAs("agent:resting", "agent", "r");
  await h.fireAll();
  assert.deepEqual(h.labels(), ["r"]);
  assert.ok(h.logs.some((l) => /could not check whether agent:resting still exists/.test(l)));
  h.svc.stop();
});

test("an app's timer that is refused: the app is gone (not found, or its folder is left but it is not granted): all its timers are taken back", async () => {
  const noMore = gone((a) => (a === "app:kept" ? { ok: true, result: { data: { id: "kept", granted: false } } } : a === "app:here" ? { ok: true, result: { data: { id: "here", granted: true } } } : notFound()));
  await noMore.setAs("app:todo", "app", "t1");
  await noMore.setAs("app:todo", "app", "t2");
  await noMore.setAs("app:kept", "app", "k");
  await noMore.setAs("app:here", "app", "h");
  await noMore.setAs("agent:alive", "agent", "a");   // the agents module is not asked about apps, and vice versa: this one is not found, so it goes too
  await noMore.fireAll();
  assert.deepEqual(noMore.labels(), ["h"]);
  assert.ok(noMore.logs.some((l) => /app:todo is no longer an installed app/.test(l)));
  assert.ok(noMore.logs.some((l) => /app:kept is no longer an installed app/.test(l)));
  assert.equal(noMore.sent.filter((m) => m.to === "service:apps").length, 3, "one question per app");
  noMore.svc.stop();
});

test("a disabled app is still granted: its refused timer stays", async () => {
  const h = gone(() => ({ ok: true, result: { data: { id: "todo", enabled: false, granted: true } } }));
  await h.setAs("app:todo", "app", "t");
  await h.fireAll();
  assert.deepEqual(h.labels(), ["t"]);
  assert.equal(h.logs.filter((l) => /took back/.test(l)).length, 0);
  h.svc.stop();
});

test("a service's refused timer is not probed", async () => {
  const h = gone(() => notFound());
  await h.setAs("service:semantic", "service", "s");
  await h.fireAll();
  assert.equal(h.sent.filter((m) => m.to === "service:agents" || m.to === "service:apps").length, 0);
  assert.deepEqual(h.labels(), ["s"]);
  h.svc.stop();
});

// ---- the hub starts the clock before the apps: an overdue timer is sent while the apps are not loaded yet ----

const APP_DOC = { doc: "# d", docPath: "/root/apps/APP-CONTRACT.md" };
/** An app installed in one run of the hub; the next run (same database) has a clock with an overdue timer of the app. */
async function restarted(options: { fixture?: false; launcher?: null } = {}) {
  const first = appsWorld({ contract: APP_DOC });
  await first.apps.start();
  assert.equal((await callApps(first, "service:apps", "apps.install", { id: "fixture" })).ok, true);
  await first.apps.stopAll(Date.now() + 3000);
  const second = appsWorld({ dbPath: first.dbPath, root: first.root, fixture: false, contract: APP_DOC, ...options });
  const logs: string[] = [];
  const now = Date.now();
  const clock = createClockService({ ledger: second.ledger, router: second.router, now: () => now, log: (m) => logs.push(m), setTimer: () => () => {} });
  second.registry.add(clock);
  const as = JSON.stringify({ member: "app:fixture", via: "app", local: false });
  const put = second.ledger.db().prepare("INSERT INTO timers (id,next_at,every_s,target,word,body,label,created_by,created_as,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
  put.run("tmr_a", now - 1000, 3600, "app:fixture", "tick", "{}", "overdue", "app:fixture", as, now - 100000);
  put.run("tmr_b", now + 3_600_000, 3600, "app:fixture", "tick", "{}", "later", "app:fixture", as, now - 100000);
  const left = () => (second.ledger.db().prepare("SELECT label FROM timers WHERE created_by='app:fixture' ORDER BY label").all() as { label: string }[]).map((r) => r.label);
  const fire = async () => { clock.check(); await flush(); await new Promise((r) => setTimeout(r, 50)); };
  return { second, clock, logs, left, fire };
}

test("restart: an overdue timer of an installed app fires before apps.start(); the app is not loaded, so nothing is taken back", async () => {
  const h = await restarted();
  const described = await callApps(h.second, "service:apps", "apps.describe", { id: "fixture" });
  assert.equal(described.ok, false);
  assert.equal(described.ok === false && described.error.code, "unavailable", "before the apps are loaded the apps module does not guess");

  await h.fire();
  assert.deepEqual(h.left(), ["later", "overdue"]);
  assert.equal(h.logs.filter((l) => /took back/.test(l)).length, 0);

  await h.second.apps.start();
  const after = await callApps(h.second, "service:apps", "apps.describe", { id: "fixture" });
  assert.equal(after.ok && (after.result?.data as { granted: boolean }).granted, true);
  h.clock.stop();
});

test("restart without an apps folder (no launcher): the install record still says the app is installed; its timers stay", async () => {
  const h = await restarted({ fixture: false, launcher: null });
  await h.second.apps.start();
  const described = await callApps(h.second, "service:apps", "apps.describe", { id: "fixture" });
  assert.equal(described.ok, true, "described from the install record although no folder was found");
  assert.equal((described.ok && described.result?.data as { granted: boolean }).granted, true);
  await h.fire();
  assert.deepEqual(h.left(), ["later", "overdue"]);
  assert.equal(h.logs.filter((l) => /took back/.test(l)).length, 0);
  h.clock.stop();
});

test("after the apps are loaded, an app whose record is gone loses its timers", async () => {
  const h = await restarted();
  await h.second.apps.start();
  await callApps(h.second, "service:apps", "apps.remove", { id: "fixture" });   // the apps module clears its timers itself, but the clock here has the router to it
  h.second.ledger.db().prepare("INSERT INTO timers (id,next_at,every_s,target,word,body,label,created_by,created_as,created_at) VALUES ('tmr_c',0,3600,'app:fixture','tick','{}','late','app:fixture',?,0)")
    .run(JSON.stringify({ member: "app:fixture", via: "app", local: false }));
  await h.fire();
  assert.deepEqual(h.left(), []);
  assert.ok(h.logs.some((l) => /app:fixture is no longer an installed app/.test(l)));
  h.clock.stop();
});

// ---- T21d: a one-time timer whose send is refused because someone is only away is put back and tried again ----

/** A clock with a movable time; `answer` decides what the timer's target (service:quiet) says, `describe` what the agents / apps module says. */
function away(describe: (member: string) => Reply = () => found()) {
  const { ledger } = openLedger();
  const clock = { t: T0 };
  const answers: Reply[] = [];
  const delivered: Outgoing[] = [];
  const logs: string[] = [];
  let calls = 0;
  const svc = createClockService({ ledger, now: () => clock.t, log: (m) => logs.push(m), setTimer: () => () => {},
    router: { send: async (m): Promise<Reply> => {
      if (m.to === "service:host") return { ok: true };
      if (m.to === "service:agents" && m.word === "describe") return describe((m.body as { agent: string }).agent);
      if (m.to === "service:apps" && m.word === "apps.describe") return describe(`app:${(m.body as { id: string }).id}`);
      calls++;
      const reply = answers.length ? answers.shift()! : { ok: true } as Reply;
      if (reply.ok) delivered.push(m);
      return reply;
    } } });
  const setAs = (member: string, via: Caller["via"], label: string, extra: Record<string, unknown> = {}) =>
    svc.handle(msg("set", set({ at: T0 + 1000, to: "service:quiet", word: "tick", body: {}, label, ...extra })), { ...ctx, caller: { member, via, local: false } });
  const labels = () => (svc as any).rows().map((r: any) => r.label).sort();
  const nextOf = (label: string) => (svc as any).rows().find((r: any) => r.label === label)?.next_at;
  /** Move the time to `to` ms after T0 and let the due timers go. */
  const at = async (to: number) => { clock.t = T0 + to; svc.check(); await flush(); await new Promise((r) => setImmediate(r)); };
  return { svc, answers, delivered, logs, setAs, labels, nextOf, at, get calls() { return calls; } };
}
const refused = (code: "offline" | "unavailable" | "not_found" | "forbidden"): Reply => ({ ok: false, error: { code, message: `answered ${code}` } });

test("a one-time timer whose target is offline or unavailable comes back 30 s later and is delivered when it is there", async () => {
  const h = away();
  await h.setAs("agent:main", "agent", "once");
  h.answers.push(refused("offline"), refused("unavailable"));
  await h.at(1000);
  assert.deepEqual(h.labels(), ["once"], "refused as offline: put back");
  assert.equal(h.nextOf("once"), T0 + 31_000);
  await h.at(20_000);
  assert.equal(h.calls, 1, "not tried before the 30 s are over");
  await h.at(31_000);
  assert.equal(h.calls, 2);
  assert.equal(h.nextOf("once"), T0 + 61_000, "unavailable: put back again");
  await h.at(61_000);
  assert.deepEqual(h.delivered.map((m) => m.word), ["tick"], "delivered once the target answers");
  assert.deepEqual(h.labels(), [], "and then gone for good");
  assert.equal(((h.svc as any).retries as Map<string, number>).size, 0);
  h.svc.stop();
});

test("not_found does not bring a one-time timer back, nor does a setter that turns out to be gone (the probe takes all its timers)", async () => {
  const h = away((member) => (member === "agent:dead" ? notFound() : found()));
  await h.setAs("agent:main", "agent", "nowhere");
  h.answers.push(refused("not_found"));
  await h.at(1000);
  assert.deepEqual(h.labels(), [], "the target has no such word: not retried");

  await h.setAs("agent:dead", "agent", "d-once", { at: T0 + 2000 });
  await h.setAs("agent:dead", "agent", "d-later", { at: T0 + 500_000 });
  h.answers.push(refused("offline"));
  await h.at(2000);
  assert.deepEqual(h.labels(), [], "put back, then taken back with the rest because agent:dead is not declared");
  assert.ok(h.logs.some((l) => /agent:dead is no longer a declared agent/.test(l)));
  h.svc.stop();
});

test("a repeating timer refused as offline just loses that round; a one-time timer gives up after 20 tries", async () => {
  const h = away();
  await h.setAs("agent:main", "agent", "rep", { every: 3600, at: T0 + 1000 });
  h.answers.push(refused("offline"));
  await h.at(1000);
  assert.equal(h.nextOf("rep"), T0 + 1000 + 3_600_000, "next slot, no extra retry row");
  assert.equal(h.labels().length, 1);

  await h.setAs("agent:main", "agent", "stubborn", { at: T0 + 2_000_000 });
  for (let i = 0; i < 25; i++) h.answers.push(refused("offline"));
  let t = 2_000_000;
  for (let i = 0; i < 21; i++) { await h.at(t); t += 30_000; }
  assert.ok(!h.labels().includes("stubborn"), "gone after RETRY_MAX tries");
  assert.ok(h.logs.some((l) => /given up/.test(l)));
  h.svc.stop();
});

test("an app's one-time timer refused as forbidden because the app is installed and enabled but not running yet is put back; a running, disabled or revoked app's is not", async () => {
  const state: Record<string, unknown> = { granted: true, enabled: true, running: false };
  const h = away(() => ({ ok: true, result: { data: state } }));
  await h.setAs("app:todo", "app", "wait");
  h.answers.push(refused("forbidden"));
  await h.at(1000);
  assert.deepEqual(h.labels(), ["wait"], "the app is starting: try again");
  await h.at(31_000);
  assert.deepEqual(h.delivered.map((m) => m.word), ["tick"], "delivered once the app runs and may send");
  assert.deepEqual(h.labels(), []);

  for (const [name, patch] of [["running", { running: true }], ["disabled", { enabled: false }]] as const) {
    Object.assign(state, { granted: true, enabled: true, running: false }, patch);
    await h.setAs("app:todo", "app", name, { at: T0 + 100_000 });
    h.answers.push(refused("forbidden"));
    await h.at(100_000);
    assert.deepEqual(h.labels(), [], `${name}: a real refusal is not retried`);
  }
  h.svc.stop();
});

test("an app's one-time timer that falls due before the apps are loaded (apps.describe says unavailable) is put back and delivered once they are", async () => {
  let loaded = false;
  const h = away(() => (loaded ? { ok: true, result: { data: { granted: true, enabled: true, running: true } } } : { ok: false, error: { code: "unavailable", message: "the apps are still loading" } }));
  await h.setAs("app:todo", "app", "early");
  await h.setAs("agent:main", "agent", "agent-early");
  h.answers.push(refused("forbidden"));   // the router: nothing runs, so the app is not granted
  await h.at(1000);
  assert.deepEqual(h.labels(), ["early"], "the app's timer is back; the agent's was delivered (the fake target answered ok)");
  loaded = true;
  await h.at(31_000);
  assert.deepEqual(h.delivered.map((m) => m.word), ["tick", "tick"], "delivered after the apps are up");
  assert.deepEqual(h.labels(), []);

  // an agent setter: unavailable from its module is not "away" (that module has no loading phase); a refusal stays a refusal
  const g = away(() => ({ ok: false, error: { code: "unavailable", message: "x" } }));
  await g.setAs("agent:main", "agent", "a");
  g.answers.push(refused("forbidden"));
  await g.at(1000);
  assert.deepEqual(g.labels(), []);
  h.svc.stop(); g.svc.stop();
});

test("a one-time timer cancelled while its send is in flight is not brought back when the send is refused as away", async () => {
  const { ledger } = openLedger();
  let release!: (reply: Reply) => void;
  const svc = createClockService({ ledger, now: () => T0 + 1000, log: () => {}, setTimer: () => () => {},
    router: { send: async (m): Promise<Reply> => (m.to === "service:host" || m.word === "describe" ? { ok: true, result: { data: {} } } : new Promise<Reply>((resolve) => { release = resolve; })) } });
  const as = (member: string): HandleContext => ({ ...ctx, caller: { member, via: "agent", local: false } });
  const { data } = await svc.handle(msg("set", set({ at: T0 + 1000, to: "service:quiet", word: "tick", body: {}, label: "x" })), { ...ctx, caller: { member: "agent:main", via: "agent", local: false } }) as { data: { id: string } };
  const rows = () => (svc as any).rows().length;
  svc.check();
  assert.equal(rows(), 0, "the row is gone while the send waits");
  const anApp: HandleContext = { ...ctx, caller: { member: "app:other", via: "app", local: false } };
  await assert.rejects(svc.handle(msg("cancel", { id: data.id }, "request", "app:other"), anApp), (e: any) => e.code === "forbidden", "an app that did not set it still may not cancel it");
  const cancelled = await svc.handle(msg("cancel", { id: data.id }), as("agent:main")) as { data: { cancelled: boolean; inflight?: boolean } };
  assert.equal(cancelled.data.cancelled, true, "found in flight");
  assert.equal(cancelled.data.inflight, true, "and says so: the send is out and is not taken back");
  release({ ok: false, error: { code: "offline", message: "away" } });
  await flush(); await new Promise((r) => setImmediate(r));
  assert.equal(rows(), 0, "not resurrected");
  assert.equal(((svc as any).sending as Map<string, unknown>).size, 0);
  svc.stop();
});
