import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { ClockMember } from "../../src/members/clock";
import { PulseMember } from "../../src/members/pulse";
import { createSelfMember } from "../../src/members/self";
import { WidgetsMember } from "../../src/members/widgets";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "token:synthetic", local: true, remote: false, ownerProxy: true };
const remoteOwner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "token:remote", local: false, remote: true, ownerProxy: true };
const phone: TrustedRouteContext = { member: "device:phone", transport: "phone", transportPrincipal: "phone:synthetic", local: true, remote: false, ownerProxy: true };
const agent = (id: string): TrustedRouteContext => ({ member: id, transport: "agent", transportPrincipal: id, local: true, remote: false, ownerProxy: false });

/** Monday 12 October 2026, 07:30 local time; every time below is built from local parts so the tests do not depend on the time zone. */
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, 12 + day, hour, minute, 0, 0).getTime();
const T0 = at(0, 7, 30);

async function fixture(options: { budget?: number; paused?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ash-pulse-"));
  const home = join(dir, "home"); mkdirSync(home);
  const file = join(dir, "world.db");
  const ledger = await Ledger.open(file);
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  let time = T0;
  const wakes: { reason: string; context: Record<string, unknown> }[] = [];
  const says: string[] = [];
  members.register({ id: "agent:main", kind: "agent", name: "Ash", online: true,
    words: () => [wordContract("agent:main", "wake")!, wordContract("agent:main", "say")!],
    handle(message) {
      if (message.word === "wake") wakes.push(message.body as { reason: string; context: Record<string, unknown> });
      if (message.word === "say") says.push(String(message.body.text));
      return { ok: true, result: { accepted: true } };
    } });
  const self = createSelfMember({ home, stateDir: join(dir, "self"), ledger, router }); members.register(self);
  const clock = new ClockMember({ ledger, router, dbFile: file, isPaused: () => false, now: () => time, scanMs: 60_000 }); members.register(clock);
  const widgets = new WidgetsMember({ router, file: join(dir, "widgets.json"), now: () => time }); members.register(widgets);
  const pulse = new PulseMember({ router, file: join(dir, "pulse.json"), now: () => time, tickMs: 0, ...(options.budget ? { budget: options.budget } : {}),
    ...(options.paused ? { isPaused: options.paused } : {}), templates: { pulse: "# PULSE template\n", heartbeat: "# HEARTBEAT template\n- pulse item\n" } });
  pulse.attach(widgets); members.register(pulse);
  const call = async (ctx: TrustedRouteContext, to: string, word: string, body: Record<string, unknown> = {}) =>
    router.send(ctx, { to, kind: "request", word, body, wait: true }).then((sent) => sent.reply!.body as any,
      (error: any) => ({ ok: false, error: { code: error.code ?? "failed", message: String(error.message) } }));
  const place = async (list: { id: string; type: "ash" | "card" }[] = [{ id: "7", type: "card" }]) => {
    const reply = await call(phone, "service:widgets", "widget.placed", { widgets: list });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    await pulse.settled();
    await new Promise((resolve) => setTimeout(resolve, 30));
  };
  /** Move the fake time and let the clock fire what is due. */
  const advance = async (to: number) => { time = to; await clock.tick(); await new Promise((resolve) => setTimeout(resolve, 20)); await pulse.settled(); };
  const timers = () => clock.journal.list().filter((item) => item.createdBy === "service:pulse");
  const sense = (word: string, body: Record<string, unknown>) => router.send(phone, { to: null, kind: "event", word, body });
  const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 30)); await pulse.settled(); };
  return { dir, home, ledger, router, members, pulse, clock, widgets, wakes, says, call, place, advance, timers, sense, settle, setTime: (v: number) => { time = v; },
    pulseCall: (word: string, body: Record<string, unknown> = {}, ctx = agent("agent:main")) => call(ctx, "service:pulse", word, body),
    async close() { pulse.close(); widgets.close(); await clock.close(); await self.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("with no Ash card widget placed pulse answers, but has no timers, wakes or review", async () => {
  const f = await fixture();
  try {
    f.pulse.start();
    await f.pulse.settled();
    const got = await f.pulseCall("pulse.get");
    assert.equal(got.ok, true, JSON.stringify(got));
    assert.equal(got.result.active, false);
    assert.equal(got.result.reason, "no widget");
    assert.deepEqual(got.result.next_wakes, []);
    assert.equal(f.timers().length, 0);
    const fired = await f.pulseCall("pulse.fire");
    assert.deepEqual(fired.result, { fired: false, reason: "no widget" });
    // The settings can still be written; they simply do nothing yet.
    const set = await f.pulseCall("pulse.set", { schedule: [{ time: "09:00" }], reason: "plan ahead" });
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.equal(f.timers().length, 0);
    await f.advance(at(0, 22));
    await f.advance(at(1, 22));
    assert.equal(f.wakes.length, 0);
    // The "ash" widget is not an Ash card widget.
    await f.place([{ id: "8", type: "ash" }]);
    assert.equal((await f.pulseCall("pulse.get")).result.active, false);
    assert.equal(f.wakes.length, 0);
  } finally { await f.close(); }
});

test("placing the widget starts pulse: files are seeded, the next 48 hours become clock timers, and the agent is woken once to decide the first card", async () => {
  const f = await fixture();
  try {
    await f.place();
    assert.equal(readFileSync(join(f.home, "PULSE.md"), "utf8"), "# PULSE template\n");
    assert.match(readFileSync(join(f.home, "HEARTBEAT.md"), "utf8"), /pulse item/);
    // The default schedule is a wake every two hours, 08:00 to 22:00; plus the daily review check at 21:00.
    const labels = f.timers().map((timer) => timer.payload!.label);
    assert.equal(labels.filter((label) => label.startsWith("pulse:wake:")).length, 16);
    assert.equal(labels.filter((label) => label.startsWith("pulse:floor:")).length, 2);
    assert.ok(f.timers().every((timer) => timer.payload!.to === "service:pulse" && timer.payload!.word === "pulse.due"));
    assert.equal(f.wakes.length, 1);
    assert.deepEqual(f.wakes[0], { reason: "pulse", context: { why: "schedule", scheduled_for: T0, today_count: 1, budget_left: 13 } });
    // Pulse timers are neither the agent's nor the owner's reminders.
    const mine = await f.call(agent("agent:main"), "service:clock", "list");
    const theirs = await f.call(owner, "service:clock", "list");
    assert.deepEqual(mine.result.timers, []);
    assert.deepEqual(theirs.result.timers, []);
    // An agent cannot set a timer that wakes pulse.
    const forged = await f.call(agent("agent:main"), "service:clock", "set", { at: T0 + 60_000, to: "service:pulse", word: "pulse.due", body: { kind: "wake", at: T0 + 60_000 }, label: "pulse:wake:x" });
    assert.equal(forged.ok, false);
    // Placing it again changes nothing.
    await f.place();
    assert.equal(f.wakes.length, 1);
    assert.equal(f.timers().length, 18);
    assert.equal(readFileSync(join(f.home, "PULSE.md"), "utf8"), "# PULSE template\n");
  } finally { await f.close(); }
});

test("a timer firing wakes the agent with only why, when, today's count and what is left", async () => {
  const f = await fixture();
  try {
    await f.place();
    f.wakes.splice(0);
    await f.advance(at(0, 8));
    assert.equal(f.wakes.length, 1);
    assert.deepEqual(f.wakes[0], { reason: "pulse", context: { why: "schedule", scheduled_for: at(0, 8), today_count: 2, budget_left: 12 } });
    await f.advance(at(0, 10));
    assert.deepEqual(f.wakes[1].context, { why: "schedule", scheduled_for: at(0, 10), today_count: 3, budget_left: 11 });
    // Every wake carries these keys and nothing else: no data materials.
    for (const wake of f.wakes) {
      assert.deepEqual(Object.keys(wake), ["reason", "context"]);
      assert.deepEqual(Object.keys(wake.context).sort(), ["budget_left", "scheduled_for", "today_count", "why"]);
    }
    // The horizon is renewed as time passes.
    const latest = Math.max(...f.timers().map((timer) => timer.next));
    assert.ok(latest > at(0, 10) + 40 * 3_600_000);
    // A day later the count starts again (the wakes that went stale in between were skipped, not sent late).
    f.wakes.splice(0);
    await f.advance(at(1, 9));
    const morning = f.wakes.filter((wake) => wake.context.why === "schedule");
    assert.deepEqual(morning.map((wake) => wake.context.scheduled_for), [at(1, 8)]);
    assert.ok(f.wakes.every((wake) => Number(wake.context.today_count) <= 2));
    const skipped = (await f.pulseCall("pulse.history", { limit: 100 })).result.entries.filter((entry: any) => entry.reason === "stale");
    assert.ok(skipped.length >= 5);
  } finally { await f.close(); }
});

test("pulse.set expands a schedule with days and one-off moments, reconciles the timers, and logs every change with its reason", async () => {
  const f = await fixture();
  try {
    await f.place();
    const moment = at(0, 15, 5);
    const set = await f.pulseCall("pulse.set", { schedule: [{ time: "09:15", days: "weekdays" }, { time: "10:00", days: [6, 0] }, { time: { at: moment } }], reason: "mornings on workdays, a one-off at 15:05" });
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.deepEqual(set.result.changed, ["schedule"]);
    // Monday 07:30 to Wednesday 07:30: the 09:15 on Monday and Tuesday, no weekend 10:00, and the one-off.
    const wakeAts = f.timers().filter((timer) => timer.payload!.label.startsWith("pulse:wake:")).map((timer) => timer.next).sort((a, b) => a - b);
    assert.deepEqual(wakeAts, [at(0, 9, 15), moment, at(1, 9, 15)]);
    // Saturday 17th and Sunday 18th carry the 10:00; the following Monday its 09:15.
    assert.deepEqual(f.pulse.expand(at(4, 12), at(7, 12)), [at(5, 10), at(6, 10), at(7, 9, 15)]);
    // The one-off fires, and is gone from the schedule afterwards.
    await f.advance(moment);
    assert.equal(f.wakes.at(-1)!.context.scheduled_for, moment);
    const got = await f.pulseCall("pulse.get");
    assert.equal(got.result.schedule.some((slot: any) => typeof slot.time === "object"), false);
    // Events and review time; each change is a history entry with the reason.
    await f.pulseCall("pulse.set", { events: [{ event: "geofence_enter", min_gap_min: 30 }, { event: "app_event" }], review_time: "22:30", reason: "watch arrivals and apps" });
    const again = await f.pulseCall("pulse.get");
    assert.deepEqual(again.result.events, [{ event: "geofence_enter", min_gap_min: 30 }, { event: "app_event", min_gap_min: 60 }]);
    assert.equal(again.result.review_time, "22:30");
    const changes = (await f.pulseCall("pulse.history", { limit: 100 })).result.entries.filter((entry: any) => entry.kind === "change");
    assert.deepEqual(changes.map((entry: any) => entry.reason), ["watch arrivals and apps", "mornings on workdays, a one-off at 15:05"]);
    assert.ok(f.timers().some((timer) => timer.payload!.label === `pulse:floor:${at(0, 22, 30)}`));
  } finally { await f.close(); }
});

test("pulse.set refuses unknown fields, a missing reason, bad times, unknown events and nothing to change", async () => {
  const f = await fixture();
  try {
    await f.place();
    const refused = async (body: Record<string, unknown>) => {
      const reply = await f.pulseCall("pulse.set", body);
      assert.equal(reply.ok, false, JSON.stringify(body));
    };
    await refused({ schedule: [{ time: "09:00" }] });
    await refused({ reason: "x", budget: 100 });
    await refused({ reason: "x", schedule: [{ time: "25:00" }] });
    await refused({ reason: "x", schedule: [{ time: "09:00", color: "red" }] });
    await refused({ reason: "x", schedule: [{ time: { at: T0 - 1000 } }] });
    await refused({ reason: "x", events: [{ event: "battery_low" }] });
    await refused({ reason: "x", events: [{ event: "geofence_enter" }, { event: "geofence_enter" }] });
    await refused({ reason: "x", review_time: "late" });
    await refused({ reason: "   ", review_time: "22:00" });
    await refused({ reason: "x" });
    // Straight to the member as well, where the router's schema check is not in front.
    const direct = await f.pulse.handle({ id: "m", seq: 1, ts: T0, from: "agent:main", to: "service:pulse", kind: "request", word: "pulse.set", body: { reason: "x", extra: 1 } },
      { signal: new AbortController().signal, recovered: false });
    assert.equal((direct as any).ok, false);
    assert.equal(f.timers().length, 18, "nothing changed");
  } finally { await f.close(); }
});

test("guidance is written through service:self, with versions and a reason in the history", async () => {
  const f = await fixture();
  try {
    await f.place();
    assert.equal((await f.pulseCall("pulse.get")).result.guidance.version, 1);
    const set = await f.pulseCall("pulse.set", { guidance: "# PULSE v2\n少说一点。\n", reason: "he said I talk too much" });
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.equal(set.result.guidance_version, 2);
    assert.equal(readFileSync(join(f.home, "PULSE.md"), "utf8"), "# PULSE v2\n少说一点。\n");
    const versions = await f.call(agent("agent:main"), "service:self", "history", { path: "PULSE.md" });
    assert.equal(versions.result.versions.length, 1);
    const got = await f.pulseCall("pulse.get");
    assert.equal(got.result.guidance.version, 2);
    assert.equal(got.result.guidance.changed_reason, "he said I talk too much");
    // The previous text is restorable with service:self's own rollback.
    const current = await f.call(agent("agent:main"), "service:self", "read", { path: "PULSE.md" });
    const back = await f.call(agent("agent:main"), "service:self", "rollback", { path: "PULSE.md", to_ts: versions.result.versions[0].ts, expected_hash: current.result.hash });
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.equal(readFileSync(join(f.home, "PULSE.md"), "utf8"), "# PULSE template\n");
    // Another agent cannot edit the guidance through pulse, and pulse cannot write other managed files.
    assert.equal((await f.pulseCall("pulse.set", { guidance: "x", reason: "x" }, agent("agent:helper"))).error.code, "forbidden");
    const service: TrustedRouteContext = { member: "service:pulse", transport: "service", transportPrincipal: "service:pulse", local: true, remote: false, ownerProxy: false };
    await assert.rejects(f.router.send(service, { to: "service:self", kind: "request", word: "write", body: { path: "SOUL.md", content: "x", why: "x", expected_hash: null } }), /managed writes require local authority/);
  } finally { await f.close(); }
});

test("the daily budget is enforced: the wake past it is skipped and recorded; pulse.fire does not use it", async () => {
  const f = await fixture({ budget: 3 });
  try {
    await f.place();
    await f.advance(at(0, 8));
    await f.advance(at(0, 10));
    assert.equal(f.wakes.length, 3);
    assert.equal(f.wakes[2].context.budget_left, 0);
    await f.advance(at(0, 12));
    assert.equal(f.wakes.length, 3);
    const history = (await f.pulseCall("pulse.history", { limit: 100 })).result.entries;
    const skip = history.find((entry: any) => entry.kind === "skip");
    assert.equal(skip.reason, "budget");
    assert.equal(skip.why, "schedule");
    // A manual try is allowed and uncounted.
    const fired = await f.pulseCall("pulse.fire");
    assert.deepEqual(fired.result, { fired: true });
    assert.equal(f.wakes.length, 4);
    assert.equal(f.wakes[3].context.today_count, 3);
    assert.deepEqual((await f.pulseCall("pulse.get")).result.budget, { per_day: 3, today_count: 3, left: 0 });
  } finally { await f.close(); }
});

test("only the local owner switches pulse; off stops the timers and wakes but keeps the guidance and history, on brings them back", async () => {
  const f = await fixture();
  try {
    await f.place();
    f.wakes.splice(0);
    const byAgent = await f.pulseCall("pulse.switch", { enabled: false });
    assert.equal(byAgent.ok, false);
    assert.equal(byAgent.error.code, "forbidden");
    const remote = await f.call(remoteOwner, "service:pulse", "pulse.switch", { enabled: false });
    assert.equal(remote.error.code, "forbidden");
    assert.match(remote.error.message, /local owner authority/);
    assert.equal((await f.pulseCall("pulse.get")).result.enabled, true);
    const off = await f.call(owner, "service:pulse", "pulse.switch", { enabled: false });
    assert.deepEqual(off.result, { enabled: false });
    await f.pulse.settled();
    assert.equal(f.timers().length, 0);
    const got = await f.pulseCall("pulse.get");
    assert.equal(got.result.active, false);
    assert.equal(got.result.reason, "switched off");
    assert.deepEqual((await f.pulseCall("pulse.fire")).result, { fired: false, reason: "switched off" });
    await f.advance(at(0, 12));
    assert.equal(f.wakes.length, 0);
    assert.ok(existsSync(join(f.home, "PULSE.md")));
    const on = await f.call(owner, "service:pulse", "pulse.switch", { enabled: true });
    assert.equal(on.ok, true);
    await f.pulse.settled();
    assert.equal(f.timers().length > 0, true);
    const kinds = (await f.pulseCall("pulse.history", { limit: 100 })).result.entries.filter((entry: any) => entry.kind === "switch").map((entry: any) => entry.enabled);
    assert.deepEqual(kinds, [true, false]);
  } finally { await f.close(); }
});

test("removing every widget cancels the timers and the wakes; the guidance and the history stay; placing one again resumes", async () => {
  const f = await fixture();
  try {
    await f.place();
    await f.pulseCall("pulse.note", { did: "put a card", why: "first" });
    f.wakes.splice(0);
    await f.place([]);
    assert.equal(f.timers().length, 0);
    const got = await f.pulseCall("pulse.get");
    assert.equal(got.result.active, false);
    assert.equal(got.result.reason, "no widget");
    assert.ok(got.result.history.some((entry: any) => entry.kind === "note"));
    assert.ok(existsSync(join(f.home, "PULSE.md")));
    await f.advance(at(0, 12));
    assert.equal(f.wakes.length, 0);
    f.setTime(at(1, 9));
    await f.place();
    assert.equal(f.wakes.length, 1);
    assert.equal(f.wakes[0].context.scheduled_for, at(1, 9));
    assert.ok(f.timers().length > 0);
  } finally { await f.close(); }
});

test("watched events wake the agent with why event; the min gap and the one-wake-an-hour coalescing hold; unwatched events are ignored", async () => {
  const f = await fixture();
  try {
    await f.place();
    await f.pulseCall("pulse.set", { events: [{ event: "geofence_enter", min_gap_min: 90 }, { event: "calendar_soon", min_gap_min: 10 }, { event: "source_stalled" }], reason: "test" });
    f.wakes.splice(0);
    f.setTime(at(0, 9, 5));
    await f.sense("sense.geofence", { name: "company", transition: "enter", ts: at(0, 9, 5) });
    await f.settle();
    assert.equal(f.wakes.length, 1);
    assert.equal(f.wakes[0].context.why, "event");
    assert.match(String(f.wakes[0].context.event), /company/);
    assert.deepEqual(Object.keys(f.wakes[0].context).sort(), ["budget_left", "event", "scheduled_for", "today_count", "why"]);
    // Not watched: a leave is ignored. Another event in the same hour is coalesced.
    f.setTime(at(0, 9, 20));
    await f.sense("sense.geofence", { name: "company", transition: "exit", ts: at(0, 9, 20) });
    await f.sense("sense.calendar", { kind: "upcoming", event: { id: "e1", title: "review", start: at(0, 10), end: at(0, 11) } });
    await f.settle();
    assert.equal(f.wakes.length, 1);
    let skips = (await f.pulseCall("pulse.history", { limit: 100 })).result.entries.filter((entry: any) => entry.kind === "skip");
    assert.deepEqual(skips.map((entry: any) => entry.reason), ["coalesced"]);
    // A later hour: the same kind within its min gap is held back, another kind goes through.
    f.setTime(at(0, 10, 30));
    await f.sense("sense.geofence", { name: "gym", transition: "enter", ts: at(0, 10, 30) });
    await f.settle();
    assert.equal(f.wakes.length, 1);
    await f.sense("sense.source", { source: "watch", state: "stale", ts: at(0, 10, 30), stale_hours: 30, summary: "no data" });
    await f.settle();
    assert.equal(f.wakes.length, 2);
    assert.match(String(f.wakes[1].context.event), /watch/);
    skips = (await f.pulseCall("pulse.history", { limit: 100 })).result.entries.filter((entry: any) => entry.kind === "skip");
    assert.ok(skips.some((entry: any) => entry.reason === "min_gap"));
    // Without a widget no event wakes anyone.
    await f.place([]);
    f.setTime(at(0, 13));
    await f.sense("sense.source", { source: "watch", state: "stale", ts: at(0, 13), stale_hours: 30, summary: "no data" });
    await f.settle();
    assert.equal(f.wakes.length, 2);
  } finally { await f.close(); }
});

test("an app's declared event can be watched; the app's own bookkeeping events are not events", async () => {
  const f = await fixture();
  try {
    await f.place();
    await f.pulseCall("pulse.set", { events: [{ event: "approval_waiting" }, { event: "app_event" }], reason: "test" });
    f.wakes.splice(0);
    f.router.recordAppEvent("app:todo", "todo.overdue", { count: 2 }, "agent:main");
    await f.settle();
    assert.equal(f.wakes.length, 1);
    assert.match(String(f.wakes[0].context.event), /app:todo/);
    f.setTime(at(0, 12));
    f.router.recordAppEvent("app:todo", "app.activity", { app: "todo" }, "agent:main");
    await f.settle();
    assert.equal(f.wakes.length, 1);
  } finally { await f.close(); }
});

test("the review floor wakes the agent when a day passed without a review note, and stays quiet when one was recorded", async () => {
  const f = await fixture();
  try {
    await f.place();
    f.wakes.splice(0);
    // The first evening: pulse has only just started, so no review is owed yet.
    await f.advance(at(0, 21));
    assert.equal(f.wakes.filter((wake) => wake.context.why === "review").length, 0);
    // The next evening nothing was recorded: pulse asks for one itself.
    await f.advance(at(1, 21));
    const reviews = f.wakes.filter((wake) => wake.context.why === "review");
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].context.scheduled_for, at(1, 21));
    // The agent reviews in time: the floor stays out of the way.
    f.setTime(at(2, 16));
    await f.pulseCall("pulse.note", { kind: "review", did: "replanned tomorrow", why: "daily summary", data_used: ["activity.history", "widget.card.get"] });
    await f.advance(at(2, 21));
    assert.equal(f.wakes.filter((wake) => wake.context.why === "review").length, 1);
  } finally { await f.close(); }
});

test("the review floor ignores the daily budget", async () => {
  const f = await fixture({ budget: 1 });
  try {
    await f.place();
    f.wakes.splice(0);
    await f.advance(at(1, 21));
    assert.equal(f.wakes.filter((wake) => wake.context.why === "review").length, 1);
  } finally { await f.close(); }
});

test("a paused ash wakes nobody", async () => {
  let paused = false;
  const f = await fixture({ paused: () => paused });
  try {
    await f.place();
    f.wakes.splice(0);
    paused = true;
    assert.deepEqual((await f.pulseCall("pulse.fire")).result, { fired: false, reason: "paused" });
    assert.equal(f.wakes.length, 0);
  } finally { await f.close(); }
});

test("notes keep what the agent did, gaps are collected, and history pages newest first", async () => {
  const f = await fixture();
  try {
    await f.place();
    for (let i = 1; i <= 8; i++) await f.pulseCall("pulse.note", { did: `did ${i}`, why: `because ${i}`, data_used: ["health.summary"] });
    await f.pulseCall("pulse.note", { kind: "gap", did: "wanted the bus timetable", why: "to say when to leave" });
    assert.equal((await f.pulseCall("pulse.note", { kind: "wish", did: "x" })).ok, false);
    const got = await f.pulseCall("pulse.get");
    assert.equal(got.result.gaps.length, 1);
    assert.equal(got.result.gaps[0].did, "wanted the bus timetable");
    assert.equal(got.result.history.length, 10);
    assert.ok(got.result.history[0].id > got.result.history[1].id);
    const first = (await f.pulseCall("pulse.history", { limit: 3 })).result;
    assert.equal(first.entries.length, 3);
    assert.equal(first.entries[0].kind, "note");
    const second = (await f.pulseCall("pulse.history", { limit: 3, before: first.next_before })).result;
    assert.ok(second.entries.every((entry: any) => entry.id < first.next_before));
    assert.equal(first.entries.at(-1).id - 1, second.entries[0].id);
  } finally { await f.close(); }
});

test("pulse belongs to the main agent and the owner; only the clock reports its timers", async () => {
  const f = await fixture();
  try {
    await f.place();
    assert.equal((await f.pulseCall("pulse.get", {}, agent("agent:helper"))).error.code, "forbidden");
    assert.equal((await f.pulseCall("pulse.due", { kind: "wake", at: T0 }, agent("agent:main"))).error.code, "forbidden");
    assert.equal((await f.pulseCall("pulse.due", { kind: "wake", at: T0 }, owner)).error.code, "forbidden");
    assert.equal((await f.pulseCall("pulse.get", {}, owner)).ok, true);
  } finally { await f.close(); }
});

test("feedback buttons on the agent's card are kept in the pulse history and wake nobody; the agent reads them back", async () => {
  const f = await fixture();
  try {
    await f.place();
    f.wakes.splice(0);
    const a2ui = { components: [{ id: "root", component: "Column", children: ["t", "b", "o"] }, { id: "t", component: "Text", text: "早" },
      { id: "b", component: "Button", child: "bl", action: { event: { name: "nice", context: { feedback: "喜欢" } } } }, { id: "bl", component: "Text", text: "👍" },
      { id: "o", component: "Button", child: "ol", action: { event: { name: "open" } } }, { id: "ol", component: "Text", text: "打开" }] };
    assert.equal((await f.call(agent("agent:main"), "service:widgets", "widget.card.put", { id: "morning", title: "早", size: "4x2", a2ui })).ok, true);
    assert.equal((await f.call(phone, "service:widgets", "widget.tap", { card: "morning", component: "b" })).ok, true);
    await f.settle();
    assert.deepEqual(f.says, []);
    assert.equal(f.wakes.length, 0);
    const entries = (await f.pulseCall("pulse.history", { limit: 100 })).result.entries.filter((entry: any) => entry.kind === "feedback");
    assert.equal(entries.length, 1);
    assert.deepEqual([entries[0].card, entries[0].feedback, entries[0].action], ["morning", "喜欢", "nice"]);
    const got = await f.call(agent("agent:main"), "service:widgets", "widget.card.get", { id: "morning" });
    assert.equal(got.result.feedback[0].feedback, "喜欢");
    // An ordinary tap is not feedback.
    await f.call(phone, "service:widgets", "widget.tap", { card: "morning", component: "o" });
    await f.settle();
    assert.equal(f.says.length, 1);
    assert.equal((await f.pulseCall("pulse.history", { limit: 100 })).result.entries.filter((entry: any) => entry.kind === "feedback").length, 1);
  } finally { await f.close(); }
});

test("the agent sees the pulse words in capability_list/describe, but not the owner's switch or the clock's report", async () => {
  const f = await fixture();
  try {
    const agentView = f.members.describe("agent", "service:pulse").members[0]!.words.map((word) => word.word).sort();
    assert.deepEqual(agentView, ["pulse.fire", "pulse.get", "pulse.history", "pulse.note", "pulse.set"]);
    const ownerView = f.members.describe("owner", "service:pulse").members[0]!.words.map((word) => word.word);
    assert.ok(ownerView.includes("pulse.switch"));
    assert.ok(f.members.describe("agent").members.some((member) => member.id === "service:pulse"));
    assert.ok(f.members.describe("agent", "service:widgets").members[0]!.words.some((word) => word.word === "widget.card.get"));
  } finally { await f.close(); }
});
