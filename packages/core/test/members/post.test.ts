import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HostPresentationV2 } from "../../../sdk/src/host";
import { PostMember, isQuiet, quietEnd } from "../../src/members/post-delivery";
import { ScreenRegistry } from "../../src/server";
import { OwnerMember } from "../../src/members/owner";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const agent: TrustedRouteContext = { member: "agent:main", transport: "agent", transportPrincipal: "agent:main", local: true, remote: false, ownerProxy: false };
const service: TrustedRouteContext = { member: "service:work", transport: "service", transportPrincipal: "service:work", local: true, remote: false, ownerProxy: false };
const screen: TrustedRouteContext = { member: "person:owner", transport: "web_ui", transportPrincipal: "token:synthetic", local: true, remote: false,
  ownerProxy: true, screenId: "screen:test", screenLabel: "Synthetic" };
const local = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour - 8, minute);

async function fixture(at = local(1, 12), autoStart = true) {
  const dir = mkdtempSync(join(tmpdir(), "ash-post-"));
  const ledger = await Ledger.open(join(dir, "world.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  members.register(new OwnerMember("Owner", ledger));
  let time = at, foreground = false, ack = true;
  const presentations: HostPresentationV2[] = [], hides: string[] = [];
  const post = new PostMember({ ledger, router, screens: { markVisible: () => { foreground = true; },
    list: () => [{ id: "screen:test", name: "Synthetic", online: foreground }], visible: () => foreground },
    delivery: { quiet: "21:30-09:00", dedupe_minutes: 60 }, timeZone: "Asia/Singapore", now: () => time,
    host: { async present(item) { presentations.push(item); if (!ack) throw new Error("ACK lost"); },
      async hidePresentation(id) { hides.push(id); } } });
  members.register(post);
  post.prepareRecovery();
  await router.recover();
  if (autoStart) await post.start();
  const wait = async (id: string) => {
    for (let i = 0; i < 40; i++) {
      await post.tick();
      const record = post.journal.record(id);
      if (record) return record;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("delivery did not settle");
  };
  return { dir, ledger, router, post, presentations, hides, wait,
    setTime(value: number) { time = value; }, setForeground(value: boolean) { foreground = value; }, setAck(value: boolean) { ack = value; },
    async close() { await post.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("quiet local interval crosses midnight at exact boundary minutes", () => {
  const quiet = "21:30-09:00", zone = "Asia/Singapore";
  for (const [at, expected] of [[local(1, 21, 29), false], [local(1, 21, 30), true], [local(2, 0), true],
    [local(2, 8, 59), true], [local(2, 9), false]] as const) assert.equal(isQuiet(at, quiet, zone), expected);
  assert.equal(quietEnd(local(1, 22), quiet, zone), local(2, 9));
  assert.equal(quietEnd(local(2, 8, 59), quiet, zone), local(2, 9));
});

test("the same authenticated screen registry expires foreground presence after sixty seconds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-post-presence-"));
  const ledger = await Ledger.open(join(dir, "world.db"));
  let now = 1000;
  const registry = new ScreenRegistry(new WorldRouter(ledger, async () => true), () => now);
  try {
    const registration = registry.register(screen, "Synthetic");
    registry.connect(registration.token);
    registry.markVisible(registration.screen);
    now += 60_000;
    assert.equal(registry.visible(registration.screen), true);
    now += 1;
    assert.equal(registry.visible(registration.screen), false);
  } finally { ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("first installation never republishes preexisting owner history as fresh notifications", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-post-baseline-"));
  const ledger = await Ledger.open(join(dir, "world.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  members.register(new OwnerMember("Owner", ledger));
  const historical = await router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text: "old synthetic", kind: "due" }, wait: true });
  let presented = 0;
  const post = new PostMember({ ledger, router, screens: { markVisible: () => {}, list: () => [], visible: () => false },
    delivery: { quiet: "21:30-09:00", dedupe_minutes: 60 },
    host: { async present() { presented++; }, async hidePresentation() {} } });
  members.register(post);
  try {
    post.prepareRecovery();
    await router.recover();
    await post.start();
    await post.tick();
    assert.equal(post.journal.record(historical.id), null);
    assert.equal(presented, 0);
    const fresh = await router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text: "new synthetic", kind: "due" }, wait: true });
    for (let i = 0; i < 40 && post.journal.record(fresh.id)?.state !== "done"; i++) {
      await post.tick(); await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(post.journal.record(fresh.id)?.state, "done");
    assert.equal(presented, 1);
  } finally { await post.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("real owner messages route foreground in-app, background due notification, and quiet offer held", async () => {
  const f = await fixture();
  try {
    f.setForeground(true);
    const reply = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text: "synthetic", kind: "reply" }, wait: true });
    assert.equal((await f.wait(reply.id)).channel, "inapp");
    assert.equal(f.presentations.length, 0);
    f.setForeground(false);
    const due = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text: "synthetic due", kind: "due" }, wait: true });
    assert.equal((await f.wait(due.id)).channel, "notification");
    assert.equal(f.presentations.length, 1);
    f.setTime(local(1, 22));
    const offer = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text: "synthetic offer", kind: "offer" }, wait: true });
    assert.equal((await f.wait(offer.id)).channel, "held");
    assert.equal(f.post.journal.heldCount(), 1);
    const snapshots = f.ledger.list({ limit: 1000 }).filter((item) => item.word === "post.changed");
    assert.equal(snapshots.at(-1)?.body.held, 1);
    assert.equal(f.presentations.length, 1);
    f.setTime(local(2, 9));
    await f.post.tick();
    assert.equal(f.post.journal.heldCount(), 0);
    assert.equal(f.ledger.list({ limit: 1000 }).filter((item) => item.word === "post.changed").at(-1)?.body.held, 0);
    assert.equal(f.post.journal.record(offer.id)?.channel, "notification");
    assert.equal(f.presentations.length, 2, "quiet offer is released after the boundary, not before");
  } finally { await f.close(); }
});

test("dedupe result is dropped, bad source kind is rejected, and visible refresh emits a count snapshot", async () => {
  const f = await fixture(local(1, 12), false);
  try {
    const first = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text: "a", kind: "due" }, wait: true });
    const second = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text: "b", kind: "due" }, wait: true });
    const send = (messageId: string, kind = "due") => f.router.send(service, { to: "service:post", kind: "request", word: "deliver",
      body: { message_id: messageId, kind, dedupe_key: "same-synthetic-thing" }, wait: true });
    assert.deepEqual((await send(first.id)).reply?.body, { ok: true, result: { channel: "notification" } });
    assert.deepEqual((await send(second.id)).reply?.body, { ok: true, result: { channel: "dropped" } });
    assert.equal(f.post.journal.record(second.id)?.state, "dropped");
    assert.equal(f.presentations.length, 1);
    f.setTime(local(1, 13));
    const third = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text: "c", kind: "due" }, wait: true });
    assert.deepEqual((await send(third.id)).reply?.body, { ok: true, result: { channel: "notification" } });
    assert.equal(f.presentations.length, 2, "dedupe window is half-open at exactly one hour");
    const bad = await f.router.send(service, { to: "service:post", kind: "request", word: "deliver",
      body: { message_id: first.id, kind: "approval" }, wait: true });
    assert.equal(bad.reply?.body.ok, false);
    const prior = f.ledger.list({ limit: 1000 }).filter((item) => item.word === "post.changed").length;
    await f.router.send(screen, { to: "service:post", kind: "event", word: "visible", body: {} });
    assert.equal(f.ledger.list({ limit: 1000 }).filter((item) => item.word === "post.changed").length, prior + 1);
  } finally { await f.close(); }
});

test("held row and changed-count event roll back together when an internal transaction fails", async () => {
  const f = await fixture();
  try {
    const before = f.ledger.lastSeq();
    assert.throws(() => f.ledger.postWrite((db, snapshot) => {
      db.prepare("INSERT INTO post_deliveries(message_id,kind,channel,state,created_at) VALUES(?,?,?,?,?)")
        .run("synthetic-failed-transition", "offer", "held", "held", local(1, 22));
      snapshot(1);
      throw new Error("synthetic transaction crash");
    }), /synthetic transaction crash/);
    assert.equal(f.post.journal.heldCount(), 0);
    assert.equal(f.ledger.lastSeq(), before);
  } finally { await f.close(); }
});

test("lost host acknowledgement is recorded unknown and never claimed as notification success", async () => {
  const f = await fixture();
  try {
    f.setAck(false);
    const source = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text: "synthetic due", kind: "due" }, wait: true });
    for (let i = 0; i < 40 && f.post.journal.record(source.id)?.state !== "unknown"; i++) {
      await f.post.tick(); await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(f.post.journal.record(source.id)?.state, "unknown");
    assert.equal(f.presentations.length, 1);
    await f.post.tick();
    assert.equal(f.presentations.length, 1);
  } finally { await f.close(); }
});

test("approval forwards exact options and reply target; missing deny fails closed", async () => {
  const f = await fixture();
  try {
    const ask = (options: { id: "once" | "always" | "deny"; label: string }[]) => f.router.send(service,
      { to: "person:owner", kind: "request", word: "ask", body: { title: "Synthetic approval", detail: "Only this test action",
        options, expires_at: Date.now() + 10_000, source: { word: "write", to: "service:self", body_preview: "synthetic" } } });
    const valid = await ask([{ id: "once", label: "Once" }, { id: "deny", label: "No" }]);
    for (let i = 0; i < 40 && f.presentations.length === 0; i++) { await f.post.tick(); await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.equal(f.presentations.length, 1);
    assert.deepEqual(f.presentations[0], { id: valid.id, kind: "approval", title: "Synthetic approval", text: "Only this test action",
      reply_to: valid.id, reply_target: "service:work", expires_at: (f.ledger.byId(valid.id)!).body.expires_at,
      options: [{ id: "once", label: "Once" }, { id: "deny", label: "No" }] });
    const invalid = await ask([{ id: "once", label: "Once" }]);
    for (let i = 0; i < 40 && f.post.journal.record(invalid.id)?.state !== "failed"; i++) { await f.post.tick(); await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.equal(f.post.journal.record(invalid.id)?.error, "presentation_contract_rejected");
    assert.equal(f.presentations.length, 1);
    f.router.cancel([valid.id, invalid.id]);
    for (let i = 0; i < 40 && f.hides.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(f.hides, [valid.id]);
  } finally { await f.close(); }
});
