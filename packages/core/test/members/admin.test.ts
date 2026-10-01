import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { SCREEN_REGISTRATION_TTL_MS, type ResponseBody } from "../../../sdk/src/api";
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
    f.admin.prepareRecovery();
    await f.router.recover();
    assert.deepEqual(f.ledger.responseTo(stranded.id)?.body, { ok: false,
      error: { code: "forbidden", message: "resume needs a newly verified local screen confirmation" } });
    assert.equal(f.admin.journal.isPaused(), true);
  } finally { await f.close(); }
});

test("recovery reports a committed pause superseded by a later committed resume", async () => {
  const f = await fixture();
  try {
    const context = { member: "person:owner", local: true, remote: false, ownerProxy: true,
      transportPrincipal: owner.transportPrincipal, screenId: screen.screenId };
    const first = f.ledger.append({ from: "person:owner", to: "service:admin", kind: "request", word: "pause", body: {} }, undefined,
      { deadlineAt: Date.now() + 30_000, context }).message;
    assert.equal(f.admin.journal.apply(first, true).applied, true);
    const second = f.ledger.append({ from: "person:owner", to: "service:admin", kind: "request", word: "resume",
      body: { confirmed: true }, origin: { screen: screen.screenId!, label: "Synthetic" } }, undefined,
      { deadlineAt: Date.now() + 30_000, context }).message;
    assert.equal(f.admin.journal.apply(second, false).applied, true);
    assert.equal(f.admin.currentCommittedPause(), null, "a superseded pause cannot cancel a newer active turn on restart");
    f.admin.prepareRecovery();
    assert.deepEqual(f.ledger.responseTo(first.id)?.body, { ok: false,
      error: { code: "failed", message: "admin command committed but superseded by a newer state" } });
    assert.deepEqual(f.ledger.responseTo(second.id)?.body, { ok: true, result: { paused: false } });
    assert.equal(f.admin.journal.isPaused(), false);
    await f.router.recover();
    assert.equal(f.admin.journal.isPaused(), false);
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
    transport: "web_ui", local: true, remote: false, ownerProxy: true }, "scope:synthetic");
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

test("a delayed pause cannot report paused after a newer registered screen resumes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-admin-screen-order-"));
  const file = join(dir, "world.db");
  const ledger = await Ledger.open(file);
  const router = new WorldRouter(ledger, async () => true);
  const screens = new ScreenRegistry(router);
  let entered!: () => void, release!: () => void;
  const atCancel = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const members = new WorldMembers(router);
  members.register({ id: "agent:main", kind: "agent", name: "Synthetic", words: () => [wordContract("agent:main", "cancel_turn")!],
    handle: async () => { entered(); await blocked; return { ok: true, result: { cancelled: false } }; } });
  const admin = new AdminMember({ ledger, router, dbFile: file, onPauseChanged: () => {},
    currentScreenBinding: (id, principal) => screens.currentBinding(id, principal) });
  members.register(admin);
  const first = screens.register({ member: screen.member, transport: screen.transport, transportPrincipal: screen.transportPrincipal,
    local: true, remote: false, ownerProxy: true }, "scope:synthetic");
  const second = screens.register({ member: screen.member, transport: screen.transport, transportPrincipal: screen.transportPrincipal,
    local: true, remote: false, ownerProxy: true }, "scope:synthetic");
  try {
    await router.recover();
    const pause = router.send({ ...screen, screenId: first.screen }, { to: "service:admin", kind: "request", word: "pause", body: {}, wait: true });
    await atCancel;
    assert.equal(admin.journal.isPaused(), true);
    const resume = await router.send({ ...screen, screenId: second.screen }, { to: "service:admin", kind: "request", word: "resume", body: { confirmed: true }, wait: true });
    assert.deepEqual(resume.reply?.body, { ok: true, result: { paused: false } });
    release();
    const late = await pause;
    assert.equal(late.reply?.body.ok, false, "old pause must not report current paused:true");
    const lateBody = late.reply?.body as ResponseBody | undefined;
    assert.match(String(lateBody?.ok === false ? lateBody.error.message : ""), /supersed|newer/i);
    assert.equal(admin.journal.isPaused(), false);
  } finally { release(); admin.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("reflex pause rechecks the original owner source after acceptance and before effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-admin-reflex-revoke-"));
  const file = join(dir, "world.db");
  const ledger = await Ledger.open(file);
  let ownerAuthorized = true, entered!: () => void, release!: () => void, blockedOnce = false;
  const atHandler = new Promise<void>((resolve) => { entered = resolve; });
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const router = new WorldRouter(ledger, async (message, caller) => {
    if (caller.member === "person:owner") return ownerAuthorized;
    if (caller.member === "service:reflex" && message.to === "service:admin" && !blockedOnce) {
      blockedOnce = true; entered(); await blocked;
    }
    return true;
  });
  const members = new WorldMembers(router);
  members.register({ id: "agent:main", kind: "agent", name: "Synthetic", words: () => [wordContract("agent:main", "say")!, wordContract("agent:main", "cancel_turn")!],
    handle: () => ({ ok: true, result: { cancelled: false } }) });
  const admin = new AdminMember({ ledger, router, dbFile: file, onPauseChanged: () => {}, currentScreenBinding: () => false });
  members.register(admin);
  try {
    await router.recover();
    const source = await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "synthetic" }, wait: true });
    const attempt = router.send(reflex, { to: "service:admin", kind: "request", word: "pause", body: { by: source.id }, wait: true });
    await atHandler;
    ownerAuthorized = false;
    release();
    const result = await attempt;
    assert.equal(result.reply?.body.ok, false);
    assert.equal(admin.journal.isPaused(), false);
    const db = new DatabaseSync(file);
    try { assert.equal((db.prepare("SELECT COUNT(*) AS n FROM admin_pause_commands").get() as { n: number }).n, 0); }
    finally { db.close(); }
  } finally { release(); admin.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
});

for (const word of ["pause", "resume"] as const) for (const settlement of ["cancel", "timeout"] as const)
  test(`${word} has no effect after ${settlement} settles during the authorization await`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ash-admin-abort-"));
    const file = join(dir, "world.db");
    const ledger = await Ledger.open(file);
    let entered!: () => void, release!: () => void, block = false;
    const atHandler = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const router = new WorldRouter(ledger, async (message, caller) => {
      if (block && caller.member === "person:owner" && message.to === "service:admin" && message.word === word) {
        block = false; entered(); await blocked;
      }
      return true;
    });
    const screens = new ScreenRegistry(router);
    const members = new WorldMembers(router);
    members.register({ id: "agent:main", kind: "agent", name: "Synthetic", words: () => [wordContract("agent:main", "cancel_turn")!],
      handle: () => ({ ok: true, result: { cancelled: false } }) });
    const admin = new AdminMember({ ledger, router, dbFile: file, onPauseChanged: () => {},
      currentScreenBinding: (id, principal) => screens.currentBinding(id, principal) });
    members.register(admin);
    try {
      await router.recover();
      if (word === "resume") {
        const first = await router.send(owner, { to: "service:admin", kind: "request", word: "pause", body: {}, wait: true });
        assert.equal(first.reply?.body.ok, true);
      }
      const before = admin.journal.isPaused();
      const caller = word === "resume" ? { ...screen, screenId: screens.register(screen, "scope:synthetic").screen } : owner;
      block = true;
      const attempt = router.send(caller, { to: "service:admin", kind: "request", word,
        body: word === "resume" ? { confirmed: true } : {}, wait: true });
      await atHandler;
      const tracked = ledger.trackedRequests().find((item) => item.message.to === "service:admin" && item.message.word === word)!;
      if (settlement === "cancel") router.cancel([tracked.message.id]);
      else {
        const internal = router as unknown as { pending: Map<string, { deadlineAt: number; timer?: ReturnType<typeof setTimeout> }>; armTimeout: (pending: unknown) => void };
        const pending = internal.pending.get(tracked.message.id)!;
        if (pending.timer) clearTimeout(pending.timer);
        pending.deadlineAt = Date.now() + 10;
        internal.armTimeout(pending);
      }
      const result = await attempt;
      assert.equal(result.reply?.body.ok, false);
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(admin.journal.isPaused(), before, "settled request may not change durable pause state");
      const db = new DatabaseSync(file);
      try { assert.equal((db.prepare("SELECT COUNT(*) AS n FROM admin_pause_commands").get() as { n: number }).n, word === "resume" ? 1 : 0); }
      finally { db.close(); }
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
