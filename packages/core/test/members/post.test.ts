import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { HostPresentationV2 } from "../../../sdk/src/host";
import { PostMember, isQuiet, quietEnd } from "../../src/members/post-delivery";
import { EdgeRouter, ScreenRegistry, type EdgeCaller } from "../../src/server";
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
  return { dir, ledger, router, members, post, presentations, hides, wait,
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
    const heldState = f.ledger.list({ limit: 1000 }).find((item) => item.word === "post.delivery" && item.body.message_id === offer.id);
    assert.equal(heldState?.body.state, "held");
    const snapshots = f.ledger.list({ limit: 1000 }).filter((item) => item.word === "post.changed");
    assert.equal(snapshots.at(-1)?.body.held, 1);
    assert.equal(f.presentations.length, 1);
    f.setTime(local(2, 9));
    await f.post.tick();
    assert.equal(f.post.journal.heldCount(), 0);
    assert.equal(f.ledger.list({ limit: 1000 }).filter((item) => item.word === "post.changed").at(-1)?.body.held, 0);
    assert.equal(f.post.journal.record(offer.id)?.channel, "inapp");
    assert.equal(f.presentations.length, 1, "quiet offer never upgrades to a host notification");
    const releasedState = f.ledger.list({ limit: 1000 }).filter((item) => item.word === "post.delivery" && item.body.message_id === offer.id).at(-1);
    assert.equal(releasedState?.body.state, "released");
    assert.ok(releasedState!.seq > heldState!.seq);
  } finally { await f.close(); }
});

test("old-page offer gets the latest released state without scanning later ledger pages", async () => {
  const f = await fixture(local(1, 22));
  try {
    const offer = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text: "synthetic offer", kind: "offer" }, wait: true });
    assert.equal((await f.wait(offer.id)).state, "held");
    for (let n = 0; n < 210; n++) f.ledger.append({ from: "agent:main", to: "person:owner", kind: "event", word: "status", body: { state: "idle" } });
    f.setTime(local(2, 9)); await f.post.tick();
    const edge = new EdgeRouter(f.ledger, f.router, f.members, { api: {}, mcp: {} });
    edge.attachPostJournal(f.post.journal);
    const owner: EdgeCaller = { member: "person:owner", transportPrincipal: "synthetic-owner", local: true, remote: false, ownerProxy: true, transport: "api" };
    const page = await edge.handle({ method: "GET", url: new URL(`/api/stream?before=${offer.seq + 1}&limit=1&follow=false`, "http://ash"), headers: {}, body: null }, owner);
    assert.equal(page.status, 200);
    let output = "";
    if ("stream" in page) page.stream((chunk) => { output += chunk; }, () => {}, () => {});
    const [snapshotFrame, messageFrame] = output.trim().split("\n\n");
    assert.match(snapshotFrame, /^event: post\.delivery\.snapshot\n/);
    assert.doesNotMatch(snapshotFrame, /(?:^|\n)id:/);
    const snapshot = JSON.parse(snapshotFrame.split("\ndata: ")[1]);
    const release = f.ledger.list({ after: offer.seq, limit: 1000 }).filter((item) => item.word === "post.delivery" && item.body.message_id === offer.id).at(-1)!;
    assert.deepEqual(snapshot.items, [{ message_id: offer.id, state: "released", version_seq: release.seq }]);
    assert.ok(snapshot.at_seq >= release.seq);
    assert.match(messageFrame, new RegExp(`^id: ${offer.seq}\\n`));
  } finally { await f.close(); }
});

test("live registration replays a release committed after its first status snapshot", async () => {
  const f = await fixture(local(1, 22));
  try {
    const offer = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text: "synthetic live offer", kind: "offer" }, wait: true });
    assert.equal((await f.wait(offer.id)).state, "held");
    const edge = new EdgeRouter(f.ledger, f.router, f.members, { api: {}, mcp: {} });
    edge.attachPostJournal(f.post.journal);
    const original = f.post.journal.pageSnapshot.bind(f.post.journal);
    let releaseSeq = 0;
    f.post.journal.pageSnapshot = (query) => {
      const result = original(query);
      if (!releaseSeq) releaseSeq = f.post.journal.release(offer.id)!.visibility.seq;
      return result;
    };
    const owner: EdgeCaller = { member: "person:owner", transportPrincipal: "synthetic-owner", local: true, remote: false, ownerProxy: true, transport: "api" };
    const live = await edge.handle({ method: "GET", url: new URL(`/api/stream?after=${offer.seq - 1}&follow=true`, "http://ash"), headers: {}, body: null }, owner);
    assert.equal(live.status, 200);
    let output = "", close = () => {};
    if ("stream" in live) live.stream((chunk) => { output += chunk; }, (cleanup) => { close = cleanup; }, () => {});
    close();
    assert.ok(releaseSeq > offer.seq);
    const snapshot = output.split("\n\n").find((frame) => frame.startsWith("event: post.delivery.snapshot"))!;
    assert.deepEqual(JSON.parse(snapshot.split("\ndata: ")[1]).items, [{ message_id: offer.id, state: "held",
      version_seq: f.ledger.list({ after: offer.seq, limit: 100 }).find((item) => item.word === "post.delivery" && item.body.state === "held")!.seq }]);
    assert.match(output, new RegExp(`(?:^|\\n)id: ${releaseSeq}\\n`), "the post-snapshot release must be replayed by its ledger seq");
    assert.ok(output.indexOf(snapshot) < output.indexOf(`id: ${offer.seq}\n`));
  } finally { await f.close(); }
});

test("malformed status rows are omitted from bounded snapshots instead of exposing an offer", async () => {
  const f = await fixture(local(1, 22));
  try {
    const offer = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text: "synthetic hidden offer", kind: "offer" }, wait: true });
    assert.equal((await f.wait(offer.id)).state, "held");
    const status = f.ledger.list({ after: offer.seq, limit: 100 }).find((item) => item.word === "post.delivery")!;
    f.ledger.postWrite((db) => { db.prepare("UPDATE messages SET body='null' WHERE seq=?").run(status.seq); });
    const { snapshot } = f.post.journal.pageSnapshot({ before: offer.seq + 1, limit: 1 });
    assert.deepEqual(snapshot.items, []);
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

test("a deduped proactive offer keeps its audit row but receives a dropped visibility state", async () => {
  const f = await fixture(local(1, 12), false);
  try {
    const first = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text: "synthetic first", kind: "offer", dedupe_key: "synthetic-thing" }, wait: true });
    const second = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say", body: { text: "synthetic duplicate", kind: "offer", dedupe_key: "synthetic-thing" }, wait: true });
    const deliver = (id: string) => f.router.send(service, { to: "service:post", kind: "request", word: "deliver",
      body: { message_id: id, kind: "offer", dedupe_key: "synthetic-thing" }, wait: true });
    assert.deepEqual((await deliver(first.id)).reply?.body, { ok: true, result: { channel: "inapp" } });
    assert.deepEqual((await deliver(second.id)).reply?.body, { ok: true, result: { channel: "dropped" } });
    assert.equal(f.ledger.byId(second.id)?.body.text, "synthetic duplicate");
    assert.deepEqual(f.post.journal.pageSnapshot({ before: second.seq + 1, limit: 1 }).snapshot.items,
      [{ message_id: second.id, state: "dropped", version_seq: f.ledger.list({ after: second.seq, limit: 100 })
        .find((item) => item.word === "post.delivery" && item.body.message_id === second.id)!.seq }]);
  } finally { await f.close(); }
});

test("proactive delivery key is rejected before acceptance for untrusted callers", async () => {
  const f = await fixture(local(1, 12), false);
  try {
    const request = { to: "person:owner", kind: "request" as const, word: "say", body: { text: "synthetic", kind: "offer", dedupe_key: "job:1" } };
    const denied: TrustedRouteContext[] = [screen,
      { member: "person:owner", transport: "api", transportPrincipal: "token:synthetic", local: true, remote: false, ownerProxy: false },
      { member: "device:phone", transport: "device", transportPrincipal: "device:phone", local: true, remote: false, ownerProxy: false },
      { member: "service:post", transport: "service", transportPrincipal: "service:post", local: true, remote: false, ownerProxy: false },
      { ...agent, local: false, remote: true }];
    const before = f.ledger.lastSeq();
    for (const caller of denied) {
      await assert.rejects(f.router.send(caller, request), (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === "forbidden");
      assert.equal(f.ledger.lastSeq(), before, `${caller.member} must not accept a keyed message`);
    }
    for (const caller of [agent, service]) {
      const accepted = await f.router.send(caller, { ...request, body: { ...request.body, dedupe_key: `job:${caller.member.replace(":", "-")}` }, wait: true });
      assert.equal(accepted.reply?.body.ok, true);
    }
  } finally { await f.close(); }
});

test("automatic proactive delivery carries its accepted key across two messages and a client retry", async () => {
  const f = await fixture();
  try {
    const body = { text: "synthetic offer one", kind: "offer", dedupe_key: "job:stable-1" };
    const first = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say", body, client_id: "offer:one", wait: true });
    assert.equal((await f.wait(first.id)).channel, "inapp");
    const retry = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say", body, client_id: "offer:one", wait: true });
    assert.deepEqual({ id: retry.id, seq: retry.seq }, { id: first.id, seq: first.seq });
    const second = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say",
      body: { ...body, text: "synthetic offer two" }, client_id: "offer:two", wait: true });
    assert.equal((await f.wait(second.id)).channel, "dropped");
    assert.equal(f.ledger.byId(second.id)?.body.dedupe_key, body.dedupe_key);
    assert.equal(f.presentations.length, 0, "proactive offers never become host notifications");
    const rows = f.ledger.list({ limit: 1000 });
    assert.equal(rows.filter((item) => item.word === "say" && item.id === first.id).length, 1);
    assert.equal(rows.filter((item) => item.word === "deliver" && item.body.message_id === first.id).length, 1);
    assert.equal(rows.filter((item) => item.word === "deliver" && item.body.message_id === second.id).length, 1);
    assert.equal(rows.filter((item) => item.word === "post.delivery" && item.body.message_id === second.id && item.body.state === "dropped").length, 1);
  } finally { await f.close(); }
});

test("explicit proactive delivery cannot add, omit or replace a key after owner acceptance", async () => {
  const f = await fixture(local(1, 12), false);
  try {
    const keyed = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say",
      body: { text: "synthetic keyed", kind: "heads_up", dedupe_key: "job:original" }, wait: true });
    const unkeyed = await f.router.send(agent, { to: "person:owner", kind: "request", word: "say",
      body: { text: "synthetic unkeyed", kind: "heads_up" }, wait: true });
    for (const [id, key] of [[keyed.id, undefined], [keyed.id, "job:other"], [unkeyed.id, "job:injected"]] as const) {
      const result = await f.router.send(service, { to: "service:post", kind: "request", word: "deliver",
        body: { message_id: id, kind: "heads_up", ...(key ? { dedupe_key: key } : {}) }, wait: true });
      assert.equal(result.reply?.body.ok, false);
      assert.equal(f.post.journal.record(id), null);
    }
    const good = await f.router.send(service, { to: "service:post", kind: "request", word: "deliver",
      body: { message_id: keyed.id, kind: "heads_up", dedupe_key: "job:original" }, wait: true });
    assert.deepEqual(good.reply?.body, { ok: true, result: { channel: "inapp" } });
  } finally { await f.close(); }
});

test("recovery refuses a keyed owner message with an untrusted stored source before dispatch", async () => {
  const f = await fixture(local(1, 12), false);
  try {
    const stranded = f.ledger.append({ from: "person:owner", to: "person:owner", kind: "request", word: "say",
      body: { text: "synthetic stranded", kind: "offer", dedupe_key: "job:forged" } }, undefined,
    { deadlineAt: Date.now() + 30_000, context: { member: "person:owner", local: true, remote: false, ownerProxy: false,
      transportPrincipal: "token:synthetic" } }).message;
    await f.router.recover();
    assert.deepEqual(f.ledger.responseTo(stranded.id)?.body, { ok: false,
      error: { code: "forbidden", message: "proactive delivery key source is no longer authorized" } });
    assert.equal(f.post.journal.record(stranded.id), null);
  } finally { await f.close(); }
});

test("held row and changed-count event roll back together when an internal transaction fails", async () => {
  const f = await fixture();
  try {
    const before = f.ledger.lastSeq();
    assert.throws(() => f.ledger.postWrite((db, snapshot, delivery) => {
      db.prepare("INSERT INTO post_deliveries(message_id,kind,channel,state,created_at) VALUES(?,?,?,?,?)")
        .run("synthetic-failed-transition", "offer", "held", "held", local(1, 22));
      snapshot(1);
      delivery({ message_id: "synthetic-failed-transition", state: "held" });
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
