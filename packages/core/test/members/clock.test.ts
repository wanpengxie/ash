import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { ClockMember } from "../../src/members/clock";
import { OwnerMember } from "../../src/members/owner";
import { Store } from "../../src/store";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "token:synthetic", local: true, remote: false, ownerProxy: true };
const agent: TrustedRouteContext = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false };
const scheduled = (to = "agent:main", word = "say", body: Record<string, unknown> = { text: "synthetic reminder" }) =>
  ({ to, word, body, label: "synthetic", at: 2000 });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ash-clock-"));
  const file = join(dir, "world.db");
  const ledger = await Ledger.open(file);
  let authorized = true;
  let paused = false;
  let pauseReader = () => paused;
  let time = 1000;
  const alarms: (number | null)[] = [];
  const world = new WorldRouter(ledger, async () => authorized);
  const members = new WorldMembers(world);
  members.register(new OwnerMember("Owner", ledger));
  members.register({ id: "agent:main", kind: "agent", name: "Main", words: () => [wordContract("agent:main", "say")!, wordContract("agent:main", "wake")!],
    handle: () => ({ ok: true, result: { accepted: true } }) });
  const clock = new ClockMember({ ledger, router: world, dbFile: file, isPaused: () => pauseReader(),
    alarm: async (at) => { alarms.push(at); }, now: () => time });
  members.register(clock);
  return { dir, file, ledger, world, clock, alarms, setTime: (value: number) => { time = value; },
    setPaused: (value: boolean) => { paused = value; }, setPauseReader: (reader: () => boolean) => { pauseReader = reader; },
    setAuthorized: (value: boolean) => { authorized = value; },
    async close(keep = false) { await clock.close(); ledger.close(); if (!keep) rmSync(dir, { recursive: true, force: true }); } };
}

test("clock set, due dispatch, durable occurrence event and repeat tick stay singular", async () => {
  const f = await fixture();
  try {
    const accepted = await f.world.send(agent, { to: "service:clock", kind: "request", word: "set", body: scheduled(), wait: true });
    assert.equal(accepted.reply?.body.ok, true);
    const timer = f.clock.journal.list()[0];
    assert.equal(timer.next, 2000);
    assert.deepEqual(f.alarms, [2000]);
    f.setTime(2000);
    await f.clock.tick();
    await f.clock.tick();
    const requests = f.ledger.list({ limit: 1000 }).filter((item) => item.from === "service:clock" && item.to === "agent:main" && item.word === "say");
    const events = f.ledger.list({ limit: 1000 }).filter((item) => item.from === "service:clock" && item.word === "clock.fired");
    assert.equal(requests.length, 1);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].body, { timer_id: timer.id, scheduled_at: 2000, outcome: "dispatched", request_id: requests[0].id });
    assert.equal(f.clock.journal.list().length, 0);
    assert.equal(f.alarms.at(-1), null);
  } finally { await f.close(); }
});

test("repeating clock advances to one future slot after downtime without replay storms", async () => {
  const f = await fixture();
  try {
    await f.world.send(agent, { to: "service:clock", kind: "request", word: "set", body: { ...scheduled("agent:main", "wake", { reason: "synthetic", context: {} }), every: 60 }, wait: true });
    f.setTime(182_000);
    await f.clock.tick();
    assert.equal(f.clock.journal.list()[0].next, 242_000);
    assert.equal(f.ledger.list({ limit: 1000 }).filter((item) => item.from === "service:clock" && item.word === "wake").length, 1);
    await f.clock.tick();
    assert.equal(f.ledger.list({ limit: 1000 }).filter((item) => item.word === "clock.fired").length, 1);
    f.setTime(242_000);
    await f.clock.tick();
    assert.equal(f.clock.journal.list()[0].next, 302_000);
    assert.equal(f.ledger.list({ limit: 1000 }).filter((item) => item.word === "clock.fired").length, 2);
  } finally { await f.close(); }
});

test("clock rejects privilege laundering and invalid time before a timer exists", async () => {
  const f = await fixture();
  try {
    const mcp = await f.world.send({ ...agent, transportPrincipal: "mcp:agent:main" },
      { to: "service:clock", kind: "request", word: "set", body: scheduled(), wait: true });
    assert.deepEqual(mcp.reply?.body, { ok: false, error: { code: "forbidden", message: "current delegate authorization unavailable" } });
    for (const body of [scheduled("service:admin", "pause", {}), scheduled("service:self", "write", {}),
      scheduled("person:owner", "say", { text: "no due", kind: "offer" })]) {
      const result = await f.world.send(agent, { to: "service:clock", kind: "request", word: "set", body, wait: true });
      assert.equal(result.reply?.body.ok, false);
    }
    const past = await f.world.send(owner, { to: "service:clock", kind: "request", word: "set", body: { ...scheduled(), at: 999 }, wait: true });
    assert.deepEqual(past.reply?.body, { ok: false, error: { code: "bad_request", message: "invalid scheduled time" } });
    await assert.rejects(f.world.send(owner, { to: "service:clock", kind: "request", word: "set", body: { ...scheduled(), every: 59 } }), /body does not match word schema/);
    f.setAuthorized(false);
    const revoked = await f.world.send(owner, { to: "service:clock", kind: "request", word: "set", body: scheduled(), wait: true });
    assert.equal(revoked.reply?.body.ok, false);
    assert.equal(f.clock.journal.list().length, 0);
  } finally { await f.close(); }
});

test("router passes a frozen detached trusted caller snapshot to a word handler", async () => {
  const f = await fixture();
  try {
    let seen: unknown;
    f.world.register({ member: "service:probe", spec: { word: "check", kind: "request", description: "Inspect a synthetic caller.",
      input_schema: { type: "object", additionalProperties: false }, result_schema: { type: "object", properties: { accepted: { type: "boolean" } }, required: ["accepted"], additionalProperties: false } },
      handle: (_message, context) => { seen = context.caller; return { ok: true, result: { accepted: true } }; } });
    await f.world.send(owner, { to: "service:probe", kind: "request", word: "check", body: {}, wait: true });
    assert.equal(Object.isFrozen(seen), true);
    assert.notEqual(seen, owner);
    assert.equal((seen as { transportPrincipal?: string }).transportPrincipal, owner.transportPrincipal);
    assert.throws(() => { (seen as { member: string }).member = "agent:main"; }, TypeError);
  } finally { await f.close(); }
});

test("paused and revoked occurrences only record a terminal outcome, never deliver later", async () => {
  const f = await fixture();
  try {
    await f.world.send(owner, { to: "service:clock", kind: "request", word: "set", body: scheduled("person:owner", "say", { text: "due", kind: "due" }), wait: true });
    f.setPaused(true);
    f.setTime(2000);
    await f.clock.tick();
    f.setPaused(false);
    await f.clock.tick();
    assert.equal(f.ledger.list({ limit: 1000 }).filter((item) => item.from === "service:clock" && item.word === "say").length, 0);
    assert.deepEqual(f.ledger.list({ limit: 1000 }).find((item) => item.word === "clock.fired")?.body.outcome, "skipped");
    f.setTime(2100);
    await f.world.send(agent, { to: "service:clock", kind: "request", word: "set", body: { ...scheduled(), at: 2200 }, wait: true });
    f.setAuthorized(false);
    f.setTime(2200);
    await f.clock.tick();
    assert.equal(f.ledger.list({ limit: 1000 }).filter((item) => item.from === "service:clock" && item.word === "say").length, 0);
    assert.equal(f.ledger.list({ limit: 1000 }).filter((item) => item.word === "clock.fired" && item.body.outcome === "failed").length, 1);
  } finally { await f.close(); }
});

test("durable pause key accepts only JSON boolean; malformed state fails closed until repaired", async () => {
  const f = await fixture();
  const db = new DatabaseSync(f.file);
  try {
    await f.world.send(agent, { to: "service:clock", kind: "request", word: "set", body: scheduled(), wait: true });
    db.prepare("INSERT INTO kv(key,value) VALUES(?,?)").run("v2:admin:paused", '"yes"');
    f.setPauseReader(() => f.clock.journal.isPaused());
    f.setTime(2000);
    await assert.rejects(f.clock.tick(), /JSON boolean/);
    assert.equal(f.clock.journal.pendingFires().length, 1);
    assert.equal(f.ledger.list({ limit: 1000 }).filter((item) => item.from === "service:clock" && item.word === "say").length, 0);
    assert.equal(f.ledger.list({ limit: 1000 }).filter((item) => item.word === "clock.fired").length, 0);
    db.prepare("UPDATE kv SET value=? WHERE key=?").run("true", "v2:admin:paused");
    await f.clock.tick();
    assert.equal(f.ledger.list({ limit: 1000 }).filter((item) => item.from === "service:clock" && item.word === "say").length, 0);
    assert.deepEqual(f.ledger.list({ limit: 1000 }).find((item) => item.word === "clock.fired")?.body.outcome, "skipped");
    db.prepare("UPDATE kv SET value=? WHERE key=?").run("false", "v2:admin:paused");
    assert.equal(f.clock.journal.isPaused(), false);
    await f.clock.tick();
    assert.equal(f.ledger.list({ limit: 1000 }).filter((item) => item.word === "clock.fired").length, 1);
  } finally { db.close(); await f.close(); }
});

test("same accepted set request is idempotent and cancel cannot delete another agent's timer", async () => {
  const f = await fixture();
  try {
    const first = await f.world.send(owner, { to: "service:clock", kind: "request", word: "set", body: scheduled(), wait: true, client_id: "timer-one" });
    const retry = await f.world.send(owner, { to: "service:clock", kind: "request", word: "set", body: scheduled(), wait: true, client_id: "timer-one" });
    assert.equal(retry.id, first.id);
    assert.equal(f.clock.journal.list().length, 1);
    const id = f.clock.journal.list()[0].id;
    const denied = await f.world.send(agent, { to: "service:clock", kind: "request", word: "cancel", body: { id }, wait: true });
    assert.equal(denied.reply?.body.ok, false);
    assert.equal(f.clock.journal.list().length, 1);
    const cancelled = await f.world.send(owner, { to: "service:clock", kind: "request", word: "cancel", body: { id }, wait: true });
    assert.deepEqual(cancelled.reply?.body, { ok: true, result: { cancelled: true } });
    assert.equal(f.clock.journal.list().length, 0);
  } finally { await f.close(); }
});

test("verified v10 timer fires narrowly; missing provenance preserves the old row blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-clock-legacy-"));
  const file = join(dir, "world.db");
  const old = new Store(file);
  const proven = { id: "old-proven", owner: "agent:main", text: "old synthetic", fire_at: 2000, repeat_seconds: null, created_by: "person:owner" };
  const unknown = { ...proven, id: "old-unknown", text: "unknown synthetic" };
  old.putTimer(proven);
  old.putTimer(unknown);
  old.append("owner", "person:owner", "timer.set", { timer: proven });
  old.close();
  const ledger = await Ledger.open(file);
  const world = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(world);
  members.register(new OwnerMember("Owner", ledger));
  members.register({ id: "agent:main", kind: "agent", name: "Main", words: () => [wordContract("agent:main", "say")!],
    handle: () => ({ ok: true, result: { accepted: true } }) });
  const clock = new ClockMember({ ledger, router: world, dbFile: file, isPaused: () => false, now: () => 2000 });
  members.register(clock);
  try {
    await clock.tick();
    await clock.tick();
    assert.equal(ledger.list({ limit: 1000 }).filter((item) => item.from === "service:clock" && item.word === "say").length, 1);
    assert.equal(ledger.list({ limit: 1000 }).filter((item) => item.word === "clock.fired" && item.body.outcome === "dispatched").length, 1);
    assert.equal(ledger.list({ limit: 1000 }).filter((item) => item.word === "clock.fired" && item.body.reason === "unverified_legacy").length, 1);
    assert.deepEqual(clock.journal.list().map((item) => [item.id, item.blocked]), [["old-unknown", "unverified_legacy"]]);
  } finally { await clock.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const stage of ["claimed", "request-accepted", "event-accepted"] as const) test(`reopening after ${stage} resumes one clock occurrence without duplicate dispatch`, async () => {
  const f = await fixture();
  let firstClosed = false;
  try {
    await f.world.send(agent, { to: "service:clock", kind: "request", word: "set", body: scheduled(), wait: true });
    const fire = f.clock.journal.claimDue(2000)[0];
    const service: TrustedRouteContext = { member: "service:clock", transport: "service", transportPrincipal: "service:clock", local: true, remote: false, ownerProxy: false };
    if (stage !== "claimed") {
      const accepted = await f.world.send(service, { to: "agent:main", kind: "request", word: "say", body: { text: "synthetic reminder" },
        client_id: `clock-request:${fire.timerId}:${fire.scheduledAt}` });
      if (stage === "event-accepted") {
        f.clock.journal.finishFire(fire, "dispatched", null, accepted.id);
        await f.world.send(service, { to: null, kind: "event", word: "clock.fired",
          body: { timer_id: fire.timerId, scheduled_at: fire.scheduledAt, outcome: "dispatched", request_id: accepted.id },
          client_id: `clock-event:${fire.timerId}:${fire.scheduledAt}` });
      }
    }
    await f.close(true);
    firstClosed = true;
    const ledger = await Ledger.open(f.file);
    const world = new WorldRouter(ledger, async () => true);
    const members = new WorldMembers(world);
    members.register(new OwnerMember("Owner", ledger));
    members.register({ id: "agent:main", kind: "agent", name: "Main", words: () => [wordContract("agent:main", "say")!],
      handle: () => ({ ok: true, result: { accepted: true } }) });
    const clock = new ClockMember({ ledger, router: world, dbFile: f.file, isPaused: () => false, now: () => 2000 });
    members.register(clock);
    try {
      await world.recover();
      await clock.tick();
      await clock.tick();
      assert.equal(ledger.list({ limit: 1000 }).filter((item) => item.from === "service:clock" && item.word === "say").length, 1);
      assert.equal(ledger.list({ limit: 1000 }).filter((item) => item.from === "service:clock" && item.word === "clock.fired").length, 1);
      assert.equal(clock.journal.pendingFires().length, 0);
    } finally { await clock.close(); ledger.close(); }
  } finally { if (!firstClosed) await f.close(true); rmSync(f.dir, { recursive: true, force: true }); }
});
