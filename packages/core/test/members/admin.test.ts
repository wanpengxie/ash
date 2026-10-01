import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SCREEN_REGISTRATION_TTL_MS } from "../../../sdk/src/api";
import { wordContract } from "../../../sdk/src/words";
import { AdminMember } from "../../src/members/admin";
import { createAgentMember } from "../../src/members/agent";
import { ScreenRegistry } from "../../src/server";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "token:synthetic-owner",
  local: true, remote: false, ownerProxy: true };
const screen: TrustedRouteContext = { ...owner, transport: "web_ui", screenId: "screen:synthetic", screenLabel: "Synthetic" };
const reflex: TrustedRouteContext = { member: "service:reflex", transport: "service", transportPrincipal: "service:reflex",
  local: true, remote: false, ownerProxy: false };
const denied = (code: string) => (value: unknown) => Boolean(value && typeof value === "object" && "code" in value && value.code === code);

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "ash-admin-"));
  const file = join(dir, "world.db");
  const ledger = await Ledger.open(file);
  let ownerAuthorized = true, changes = 0, cancellations = 0;
  const router = new WorldRouter(ledger, async (_message, caller) => caller.member === "person:owner" ? ownerAuthorized : true);
  const members = new WorldMembers(router);
  members.register({ id: "agent:main", kind: "agent", name: "Synthetic", words: () => [wordContract("agent:main", "say")!, wordContract("agent:main", "cancel_turn")!],
    handle: (message) => message.word === "say" ? { ok: true, result: { accepted: true } }
      : (cancellations++, { ok: true, result: { cancelled: false } }) });
  const admin = new AdminMember({ ledger, router, dbFile: file, onPauseChanged: () => { changes++; },
    currentScreenBinding: (id, principal) => id === screen.screenId && principal === screen.transportPrincipal });
  members.register(admin);
  await router.recover();
  return { dir, file, ledger, router, admin, get changes() { return changes; }, get cancellations() { return cancellations; },
    revokeOwner() { ownerAuthorized = false; }, restoreOwner() { ownerAuthorized = true; },
    async close(keep = false) { admin.close(); ledger.close(); if (!keep) rmSync(dir, { recursive: true, force: true }); } };
}

test("admin pause is durable and a reflex owner message is consumed atomically once", async () => {
  const f = await fixture();
  try {
    const original = await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "synthetic pause" }, wait: true });
    const pause = { to: "service:admin", kind: "request" as const, word: "pause", body: { by: original.id }, wait: true };
    const attempts = await Promise.allSettled([
      f.router.send(reflex, { ...pause, client_id: "reflex:one" }),
      f.router.send(reflex, { ...pause, client_id: "reflex:two" }),
    ]);
    const accepted = attempts.filter((item) => item.status === "fulfilled");
    const rejected = attempts.filter((item) => item.status === "rejected");
    assert.equal(accepted.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(f.ledger.list({ limit: 1000 }).filter((item) => item.to === "service:admin" && item.word === "pause").length, 1);
    assert.equal(f.admin.journal.isPaused(), true);
    assert.equal(f.changes, 1);
    assert.equal(f.cancellations, 1);
    const first = (accepted[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof f.router.send>>>).value;
    assert.deepEqual(first.reply?.body, { ok: true, result: { paused: true } });
    const retryId = attempts[0].status === "fulfilled" ? "reflex:one" : "reflex:two";
    const retry = await f.router.send(reflex, { ...pause, client_id: retryId });
    assert.deepEqual({ id: retry.id, seq: retry.seq }, { id: first.id, seq: first.seq });
    assert.equal(f.changes, 1, "ACK retry must not execute pause twice");
    const db = new DatabaseSync(f.file);
    try { assert.equal((db.prepare("SELECT COUNT(*) AS n FROM admin_pause_claims").get() as { n: number }).n, 1); }
    finally { db.close(); }
    const resumed = await f.router.send(screen, { to: "service:admin", kind: "request", word: "resume", body: { confirmed: true }, wait: true });
    assert.deepEqual(resumed.reply?.body, { ok: true, result: { paused: false } });
    await assert.rejects(f.router.send(reflex, { ...pause, client_id: "reflex:three" }), denied("bad_request"));
    assert.equal(f.admin.journal.isPaused(), false);
    assert.equal(f.changes, 2);
  } finally { await f.close(); }
});

test("admin source and screen restrictions reject before ledger acceptance", async () => {
  const f = await fixture();
  try {
    const original = await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "synthetic" }, wait: true });
    const remote = { ...screen, local: false, remote: true, pairedDeviceId: "paired:synthetic" };
    const before = f.ledger.lastSeq();
    for (const caller of [remote, { ...owner, member: "device:phone", transport: "device" as const },
      { ...owner, member: "agent:main", transport: "agent" as const }]) {
      await assert.rejects(f.router.send(caller, { to: "service:admin", kind: "request", word: "pause", body: {} }), denied("forbidden"));
      assert.equal(f.ledger.lastSeq(), before);
    }
    for (const caller of [owner, remote, reflex]) {
      await assert.rejects(f.router.send(caller, { to: "service:admin", kind: "request", word: "resume", body: { confirmed: true } }), denied("forbidden"));
      assert.equal(f.ledger.lastSeq(), before);
    }
    await assert.rejects(f.router.send(reflex, { to: "service:admin", kind: "request", word: "pause", body: { by: "missing" } }), denied("forbidden"));
    f.revokeOwner();
    await assert.rejects(f.router.send(reflex, { to: "service:admin", kind: "request", word: "pause", body: { by: original.id } }), denied("forbidden"));
    assert.equal(f.ledger.lastSeq(), before);
    f.restoreOwner();
    const remoteOwner = await f.router.send(remote, { to: "agent:main", kind: "request", word: "say", body: { text: "remote" }, wait: true });
    const afterRemote = f.ledger.lastSeq();
    await assert.rejects(f.router.send(reflex, { to: "service:admin", kind: "request", word: "pause", body: { by: remoteOwner.id } }), denied("forbidden"));
    assert.equal(f.ledger.lastSeq(), afterRemote);
  } finally { await f.close(); }
});

test("reflex pause claim survives restart and a later resume", async () => {
  const f = await fixture();
  let closed = false;
  try {
    const original = await f.router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "synthetic durable by" }, wait: true });
    const body = { by: original.id };
    const first = await f.router.send(reflex, { to: "service:admin", kind: "request", word: "pause", body, client_id: "first-by", wait: true });
    assert.equal(first.reply?.body.ok, true);
    const resume = await f.router.send(screen, { to: "service:admin", kind: "request", word: "resume", body: { confirmed: true }, wait: true });
    assert.equal(resume.reply?.body.ok, true);
    await f.close(true); closed = true;
    const ledger = await Ledger.open(f.file);
    const router = new WorldRouter(ledger, async () => true);
    const members = new WorldMembers(router);
    members.register({ id: "agent:main", kind: "agent", name: "Synthetic", words: () => [wordContract("agent:main", "say")!, wordContract("agent:main", "cancel_turn")!],
      handle: (message) => message.word === "say" ? { ok: true, result: { accepted: true } } : { ok: true, result: { cancelled: false } } });
    const admin = new AdminMember({ ledger, router, dbFile: f.file, onPauseChanged: () => {}, currentScreenBinding: () => false });
    members.register(admin);
    try {
      await router.recover();
      const before = ledger.lastSeq();
      await assert.rejects(router.send(reflex, { to: "service:admin", kind: "request", word: "pause", body, client_id: "second-by" }), denied("bad_request"));
      assert.equal(ledger.lastSeq(), before);
      assert.equal(admin.journal.isPaused(), false);
      const retry = await router.send(reflex, { to: "service:admin", kind: "request", word: "pause", body, client_id: "first-by" });
      assert.deepEqual({ id: retry.id, seq: retry.seq }, { id: first.id, seq: first.seq });
      assert.equal(admin.journal.isPaused(), false, "ACK retry after resume must not reapply the old pause");
    } finally { admin.close(); ledger.close(); }
  } finally { if (!closed) await f.close(); else rmSync(f.dir, { recursive: true, force: true }); }
});

test("a stranded resume with an old screen ID cannot clear pause during recovery", async () => {
  const f = await fixture();
  try {
    const paused = await f.router.send(owner, { to: "service:admin", kind: "request", word: "pause", body: {}, wait: true });
    assert.equal(paused.reply?.body.ok, true);
    const stranded = f.ledger.append({ from: "person:owner", to: "service:admin", kind: "request", word: "resume",
      body: { confirmed: true }, origin: { screen: "screen:expired", label: "Expired" } }, undefined,
    { deadlineAt: Date.now() + 30_000, context: { member: "person:owner", local: true, remote: false, ownerProxy: true,
      transportPrincipal: owner.transportPrincipal, screenId: "screen:expired" } }).message;
    await f.router.recover();
    assert.deepEqual(f.ledger.responseTo(stranded.id)?.body, { ok: false,
      error: { code: "forbidden", message: "resume needs a newly verified local screen confirmation" } });
    assert.equal(f.admin.journal.isPaused(), true);
  } finally { await f.close(); }
});

test("an accepted resume cannot clear pause after its screen expires before execution", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-admin-screen-race-"));
  const file = join(dir, "world.db");
  const ledger = await Ledger.open(file);
  let now = 1000, resumeChecks = 0, entered!: () => void, release!: () => void;
  const atHandlerCheck = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const router = new WorldRouter(ledger, async (message) => {
    if (message.word === "resume" && ++resumeChecks === 1) { entered(); await blocked; }
    return true;
  });
  const screens = new ScreenRegistry(router, () => now);
  const registration = screens.register({ member: "person:owner", transportPrincipal: owner.transportPrincipal,
    transport: "web_ui", local: true, remote: false, ownerProxy: true });
  const localScreen: TrustedRouteContext = { ...screen, screenId: registration.screen, screenLabel: registration.label };
  const members = new WorldMembers(router);
  members.register({ id: "agent:main", kind: "agent", name: "Synthetic", words: () => [wordContract("agent:main", "cancel_turn")!],
    handle: () => ({ ok: true, result: { cancelled: false } }) });
  const admin = new AdminMember({ ledger, router, dbFile: file, onPauseChanged: () => {},
    currentScreenBinding: (id, principal) => screens.currentBinding(id, principal) });
  members.register(admin);
  try {
    await router.recover();
    const pause = await router.send(owner, { to: "service:admin", kind: "request", word: "pause", body: {}, wait: true });
    assert.equal(pause.reply?.body.ok, true);
    const attempt = router.send(localScreen, { to: "service:admin", kind: "request", word: "resume", body: { confirmed: true }, wait: true });
    await atHandlerCheck;
    assert.equal(screens.currentBinding(registration.screen, owner.transportPrincipal), true);
    assert.equal(screens.currentBinding(registration.screen, "token:other"), false);
    now += SCREEN_REGISTRATION_TTL_MS;
    assert.equal(screens.currentBinding(registration.screen, owner.transportPrincipal), false);
    release();
    const resumed = await attempt;
    assert.equal(resumed.reply?.body.ok, false);
    assert.deepEqual(resumed.reply?.body, { ok: false, error: { code: "forbidden", message: "current local owner screen confirmation unavailable" } });
    assert.equal(admin.journal.isPaused(), true);
    assert.equal(ledger.list({ limit: 1000 }).filter((row) => row.to === "service:admin" && row.word === "resume").length, 1);
  } finally { release(); admin.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("durable pause cancels an active turn and blocks the next one until resume", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-admin-turn-"));
  const file = join(dir, "world.db");
  const ledger = await Ledger.open(file);
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  let admin!: AdminMember, runs = 0, entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
  const agent = createAgentMember({ ledger, router, stateDir: join(dir, "agent"), isPaused: () => admin.journal.isPaused(),
    runner: { async runTurn(_input, _emit, signal) {
      runs++;
      if (runs === 1) {
        entered();
        await new Promise<void>((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); });
        return { reason: "error" as const, error: "synthetic cancellation" };
      }
      return { reason: "completed" as const };
    } } });
  members.register(agent);
  admin = new AdminMember({ ledger, router, dbFile: file, onPauseChanged: () => agent.resamplePause(),
    currentScreenBinding: (id, principal) => id === screen.screenId && principal === screen.transportPrincipal });
  members.register(admin);
  try {
    agent.prepareRecovery();
    await router.recover();
    await agent.start();
    const first = await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "synthetic active" }, wait: true });
    await firstEntered;
    const paused = await router.send(owner, { to: "service:admin", kind: "request", word: "pause", body: {}, wait: true });
    assert.deepEqual(paused.reply?.body, { ok: true, result: { paused: true } });
    const second = await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "synthetic queued" }, wait: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(runs, 1);
    assert.equal(ledger.list({ limit: 1000 }).filter((item) => item.word === "turn.end" && item.body.reason === "cancelled").length, 1);
    const resumed = await router.send(screen, { to: "service:admin", kind: "request", word: "resume", body: { confirmed: true }, wait: true });
    assert.deepEqual(resumed.reply?.body, { ok: true, result: { paused: false } });
    const until = Date.now() + 5000;
    while (Date.now() < until && runs < 2) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runs, 2);
    assert.equal(agent.inbox.counts().pending, 0);
    assert.ok(ledger.byId(first.id)); assert.ok(ledger.byId(second.id));
  } finally { await agent.close(); admin.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});
