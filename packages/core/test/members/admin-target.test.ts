import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAgentMember } from "../../src/members/agent";
import { AdminMember } from "../../src/members/admin";
import { AdminJournal } from "../../src/world/admin-journal";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";
import { STUCK_MS } from "../fixtures/wait";

const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "token:isolated",
  local: true, remote: false, ownerProxy: true };
const screen: TrustedRouteContext = { ...owner, transport: "web_ui", screenId: "screen:isolated", screenLabel: "Isolated" };
const pause = { to: "service:admin", kind: "request" as const, word: "pause", body: {}, wait: true };
const resume = { to: "service:admin", kind: "request" as const, word: "resume", body: { confirmed: true }, wait: true };
function gate() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + STUCK_MS;
  while (Date.now() < deadline) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("isolated state did not arrive");
}

for (const barrier of ["before acceptance", "after acceptance"] as const)
  test(`an old pause cancellation cannot stop a resumed newer turn ${barrier}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ash-admin-target-"));
    const ledger = await Ledger.open(join(dir, "world.db"));
    const router = new WorldRouter(ledger, async () => true);
    const members = new WorldMembers(router);
    const firstGate = gate(), secondGate = gate(), cancelGate = gate();
    let admin!: AdminMember, runs = 0, seenCancel = false;
    const agent = createAgentMember({ ledger, router, stateDir: join(dir, "agent"), isPaused: () => admin.journal.isPaused(),
      currentAdminPauseTargets: (by, turn) => admin.currentPauseTargets(by, turn),
      runner: { async runTurn(_input, _emit, signal) {
        runs++;
        if (runs === 1) { await firstGate.promise; return { reason: "completed" }; }
        await Promise.race([secondGate.promise, new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]);
        return signal.aborted ? { reason: "error", error: "aborted" } : { reason: "completed" };
      } } });
    members.register({ id: agent.id, kind: agent.kind, name: "Isolated", words: () => agent.words(),
      handle: async (message, context) => {
        if (barrier === "after acceptance" && message.word === "cancel_turn" && message.from === "service:admin" && !seenCancel) {
          seenCancel = true; await cancelGate.promise;
        }
        return agent.handle(message, context);
      } });
    admin = new AdminMember({ ledger, router, dbFile: join(dir, "world.db"), onPauseChanged: () => agent.resamplePause(),
      currentAgentTurn: () => agent.inbox.activeTurn()?.id ?? null,
      currentScreenBinding: (id, principal) => id === screen.screenId && principal === screen.transportPrincipal });
    members.register(admin);
    if (barrier === "before acceptance") {
      const send = router.send.bind(router);
      router.send = (async (...args: Parameters<WorldRouter["send"]>) => {
        if (args[0].member === "service:admin" && args[1].word === "cancel_turn" && !seenCancel) {
          seenCancel = true; await cancelGate.promise;
        }
        return send(...args);
      }) as WorldRouter["send"];
    }
    try {
      agent.prepareRecovery(); await router.recover(); await agent.start();
      await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "first isolated turn" }, wait: true });
      await until(() => runs === 1);
      const firstTurn = agent.inbox.activeTurn()!.id;
      const oldPause = router.send(owner, { ...pause, client_id: "isolated:old-pause" });
      await until(() => seenCancel);
      assert.equal(admin.journal.isPaused(), true);
      assert.equal(admin.journal.currentCommand()?.targetTurn, firstTurn);
      assert.equal((await router.send(screen, resume)).reply?.body.ok, true);
      await router.send(owner, { to: "agent:main", kind: "request", word: "say", body: { text: "second isolated turn" }, wait: true });
      firstGate.release();
      await until(() => runs === 2);
      const secondTurn = agent.inbox.activeTurn()!.id;
      assert.notEqual(secondTurn, firstTurn);
      cancelGate.release();
      const prior = await oldPause;
      const retry = await router.send(owner, { ...pause, client_id: "isolated:old-pause" });
      assert.equal(retry.id, prior.id, "same client ID returns the original request");
      assert.equal(admin.journal.currentCommand()?.targetTurn, null, "resume keeps its own fact, not the old pause target");
      secondGate.release();
      await until(() => ledger.list({ limit: 1000 }).filter((row) => row.word === "turn.end").length === 2);
      const rows = ledger.list({ limit: 1000 });
      assert.deepEqual(rows.filter((row) => row.word === "turn.end").map((row) => row.body.reason), ["completed", "completed"]);
      assert.equal(agent.inbox.cancelIntents().length, 0);
      const cancels = rows.filter((row) => row.word === "cancel_turn" && row.kind === "request");
      assert.equal(cancels.length, 1);
      assert.equal(cancels[0].turn, firstTurn, "the trusted target survives ledger acceptance");
      assert.deepEqual(ledger.responseTo(cancels[0].id)?.body, { ok: true, result: { cancelled: false } });
    } finally {
      firstGate.release(); secondGate.release(); cancelGate.release();
      await agent.close(); admin.close(); ledger.close(); rmSync(dir, { recursive: true, force: true });
    }
  });

test("old admin journal gains no invented target and refuses to cancel an active turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-admin-old-journal-"));
  const file = join(dir, "world.db");
  const old = new DatabaseSync(file);
  try {
    old.exec("CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE admin_pause_commands(request_id TEXT PRIMARY KEY,seq INTEGER NOT NULL UNIQUE,paused INTEGER NOT NULL)");
    old.prepare("INSERT INTO kv(key,value) VALUES('v2:admin:paused','true')").run();
    old.prepare("INSERT INTO admin_pause_commands(request_id,seq,paused) VALUES('old_request',1,1)").run();
  } finally { old.close(); }
  const journal = new AdminJournal(file);
  const ledger = await Ledger.open(file);
  const router = new WorldRouter(ledger, async () => true);
  const agent = createAgentMember({ ledger, router, stateDir: join(dir, "agent"), runner: { async runTurn() { return { reason: "completed" }; } } });
  try {
    assert.deepEqual(journal.currentCommand(), { requestId: "old_request", seq: 1, paused: true, targetTurn: null });
    const say = ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "synthetic" } }).message;
    agent.inbox.accept(say);
    assert.ok(agent.inbox.claim([say.id]));
    assert.throws(() => agent.reconcileCommittedPause("old_request", journal.currentCommand()!.targetTurn), /does not match/);
    assert.equal(agent.inbox.cancelIntents().length, 0);
  } finally { await agent.close(); ledger.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); }
});
