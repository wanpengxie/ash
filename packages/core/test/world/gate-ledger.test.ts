import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Ledger } from "../../src/world/ledger";
import { wordContract } from "../../../sdk/src/words";
import { WorldRouter } from "../../src/world/router";

const gate = (expiresAt: number) => ({ subject: "principal:exact", risk: "outward" as const,
  contractFingerprint: "a".repeat(64), expiresAt,
  askBody: { title: "Confirm action", detail: "Synthetic device", options: [
    { id: "once", label: "Only now" }, { id: "deny", label: "Deny" }],
    source: { word: "run", to: "device:fake", body_preview: "Synthetic action" } } });

async function fixture(deadlineMs = 60_000, agentActor = false) {
  const file = join(mkdtempSync(join(tmpdir(), "ash-gate-ledger-")), "ash.db");
  if (agentActor) {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE events(seq INTEGER PRIMARY KEY,ts INTEGER,workspace TEXT,member TEXT,type TEXT,data TEXT);
      CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE grants(id TEXT PRIMARY KEY,member TEXT,scope TEXT,created_by TEXT,created_at INTEGER);`);
    old.prepare("INSERT INTO grants VALUES(?,?,?,?,?)").run("synthetic", "agent:main", "device:fake/run", "person:owner", 1);
    old.close();
  }
  const ledger = await Ledger.open(file);
  const actor = agentActor ? "agent:main" : "person:owner";
  const accepted = ledger.append({ from: actor, to: "device:fake", kind: "request", word: "run", body: { n: 1 }, turn: "t_gate" },
    undefined, { deadlineAt: Date.now() + deadlineMs, context: { member: actor, local: true, remote: false,
      ownerProxy: false, transportPrincipal: actor } }).message;
  return { file, ledger, accepted };
}

test("gate start commits one case, owner ask, phase and strict audit event together across reopen", async () => {
  const { file, ledger, accepted } = await fixture();
  const expiresAt = Date.now() + 30_000;
  try {
    const started = ledger.beginGate(accepted.id, gate(expiresAt));
    assert.ok(started);
    assert.equal(started.ask.from, "service:gate");
    assert.equal(started.ask.to, "person:owner");
    assert.equal(started.event.body.ask_id, started.ask.id);
    assert.equal(ledger.trackedRequests().find((item) => item.message.id === accepted.id)?.phase, "gate_waiting");
    assert.equal(ledger.beginGate(accepted.id, gate(expiresAt)), null);
    assert.deepEqual(ledger.list().map((item) => item.word), ["run", "ask", "gate.asked"]);
  } finally { ledger.close(); }
  const reopened = await Ledger.open(file);
  try {
    const found = reopened.gateCase(accepted.id);
    assert.equal(found?.decision, "waiting");
    assert.equal(reopened.byId(found!.askId)?.word, "ask");
    assert.equal(reopened.trackedRequests().filter((item) => item.message.id === accepted.id).length, 1);
  } finally { reopened.close(); }
});

test("an access grant, audit and response roll back together on an injected SQLite failure", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "ash-gate-access-atomic-")), "ash.db");
  const ledger = await Ledger.open(file);
  const blocker = new DatabaseSync(file);
  try {
    const request = ledger.append({ from: "person:owner", to: "service:gate", kind: "request", word: "access.grant",
      body: { member: "agent:main", scope: "device:fake/run" } }, undefined,
    { deadlineAt: Date.now() + 30_000, context: { member: "person:owner", local: true, remote: false,
      ownerProxy: true, transportPrincipal: "owner:test" } }).message;
    assert.equal(ledger.advanceRequest(request.id, "accepted", "dispatching"), true);
    blocker.exec(`CREATE TRIGGER test_access_audit_abort BEFORE INSERT ON gate_access_audit
      BEGIN SELECT RAISE(ABORT,'injected access audit failure'); END;`);
    assert.throws(() => ledger.gateAccessGrant(request.id, "agent:main", "device:fake/run"));
    assert.equal(ledger.gateAccessPage().items.length, 0);
    assert.equal(ledger.responseTo(request.id), null);
    blocker.exec("DROP TRIGGER test_access_audit_abort");
    const response = ledger.gateAccessGrant(request.id, "agent:main", "device:fake/run");
    assert.equal(response.body.ok, true);
    assert.equal(ledger.responseTo(request.id)?.id, response.id);
    assert.equal(ledger.gateAccessPage().items.length, 1);
    assert.throws(() => ledger.gateAccessGrant(request.id, "agent:main", "device:fake/run"));
    assert.equal(ledger.gateAccessPage().items.length, 1);
  } finally { blocker.close(); ledger.close(); }
  const reopened = await Ledger.open(file);
  try { assert.equal(reopened.gateAccessPage().items.length, 1); }
  finally { reopened.close(); }
});

for (const stage of ["accepted", "asked", "answered", "dispatching", "handoff"] as const) {
  test(`SIGKILL after internal DSH approval ${stage} never reopens the old call`, async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ash-internal-approval-kill-")), "ash.db");
    const source = `import { Ledger } from './packages/core/src/world/ledger.ts';
      const ledger=await Ledger.open(${JSON.stringify(file)});
      const parent=ledger.acceptInternalApproval({sessionId:'session-550e8400-e29b-41d4-a716-446655440000',turn:'t_synthetic',
        callId:'toolu_synthetic',toolName:'ash_describe',contractFingerprint:'a'.repeat(64),deadlineAt:Date.now()+120000});
      if (${JSON.stringify(stage)}!=='accepted') {
        const ask=ledger.beginGate(parent.id,{subject:'synthetic-root',risk:'structure',contractFingerprint:'a'.repeat(64),
          expiresAt:Date.now()+60000,askBody:{title:'Synthetic approval',detail:'Read-only fixture',
            options:[{id:'once',label:'Once'},{id:'deny',label:'Deny'}],
            source:{word:'internal.approval',to:'service:gate',body_preview:'Synthetic tool'}}});
        if (!ask) throw new Error('missing ask');
        if (${JSON.stringify(stage)}!=='asked') {
          ledger.settleGateAsk(ask.ask.id,'once','answer');
          if (${JSON.stringify(stage)}==='dispatching'||${JSON.stringify(stage)}==='handoff')
            ledger.dispatchAllowedGate(parent.id,'synthetic-root','a'.repeat(64));
          if (${JSON.stringify(stage)}==='handoff') ledger.settle(parent.id,'service:gate',{ok:true,result:{outcome:'allowed-once'}});
        }
      }
      process.kill(process.pid,'SIGKILL');`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source],
      { cwd: process.cwd(), timeout: 10_000, encoding: "utf8" });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const ledger = await Ledger.open(file);
    try {
      const parent = ledger.list().find((message) => message.word === "internal.approval" && message.kind === "request")!;
      assert.ok(parent);
      const prior = ledger.responseTo(parent.id);
      const published: string[] = [];
      const router = new WorldRouter(ledger, async () => true);
      router.enableDurableGate();
      router.subscribe((message) => published.push(message.id));
      await router.recover();
      const final = ledger.responseTo(parent.id)!;
      assert.equal(final.id, prior?.id ?? final.id);
      assert.equal(final.body.ok, stage === "handoff");
      if (stage !== "handoff") assert.ok(published.includes(final.id), "recovery did not publish the parent terminal");
      assert.equal(ledger.list().filter((message) => message.reply_to === parent.id && message.kind === "response").length, 1);
      const gate = ledger.gateCase(parent.id);
      if (gate) {
        const askResponse = ledger.responseTo(gate.askId);
        assert.ok(askResponse, "old owner ask remained actionable");
        if (stage === "asked") assert.ok(published.includes(askResponse.id), "recovery did not publish the withdrawn ask");
      }
      assert.equal(ledger.trackedRequests().some((request) => request.message.id === parent.id || request.message.id === gate?.askId), false);
      assert.throws(() => ledger.acceptInternalApproval({ sessionId: "session-550e8400-e29b-41d4-a716-446655440000", turn: "t_synthetic",
        callId: "toolu_synthetic", toolName: "ash_describe", contractFingerprint: "a".repeat(64), deadlineAt: Date.now() + 120_000 }));
    } finally { ledger.close(); }
  });
}

test("an answer before ask expiry remains valid for dispatch after ask expiry but before original deadline", async (t) => {
  const { ledger, accepted } = await fixture(900_000);
  try {
    const base = Date.now();
    let now = base;
    t.mock.method(Date, "now", () => now);
    const started = ledger.beginGate(accepted.id, gate(base + 600_000))!;
    now = base + 599_000;
    assert.equal(ledger.settleGateAsk(started.ask.id, "once", "answer")?.event?.word, "gate.passed");
    now = base + 601_000;
    assert.equal(ledger.dispatchAllowedGate(accepted.id, "principal:exact", "a".repeat(64)), true);
  } finally { ledger.close(); }
});

test("committed device ACL revoke between authorization and dispatch CAS blocks the effect", async () => {
  const { file, ledger, accepted } = await fixture(60_000, true);
  try {
    const started = ledger.beginGate(accepted.id, gate(Date.now() + 20_000))!;
    assert.ok(started);
    assert.equal(ledger.settleGateAsk(started.ask.id, "once", "answer")?.event?.word, "gate.passed");
    assert.equal(ledger.gateDeviceAccess("agent:main", "device:fake", "run"), true);
    const other = new DatabaseSync(file);
    try { other.prepare("UPDATE gate_access SET revoked_at=? WHERE member=? AND scope=?")
      .run(Date.now(), "agent:main", "device:fake/run"); }
    finally { other.close(); }
    assert.equal(ledger.dispatchAllowedGate(accepted.id, "principal:exact", "a".repeat(64)), false);
    assert.equal(ledger.trackedRequests().find((item) => item.message.id === accepted.id)?.phase, "gate_waiting");
  } finally { ledger.close(); }
});

test("a failed gate event insert rolls back case, ask and phase", async () => {
  const { file, ledger, accepted } = await fixture();
  const blocker = new DatabaseSync(file);
  try {
    blocker.exec(`CREATE TRIGGER test_gate_event_abort BEFORE INSERT ON messages
      WHEN NEW.word='gate.asked' BEGIN SELECT RAISE(ABORT,'injected gate event failure'); END;`);
    assert.throws(() => ledger.beginGate(accepted.id, gate(Date.now() + 20_000)));
    assert.equal(ledger.gateCase(accepted.id), null);
    assert.deepEqual(ledger.list().map((item) => item.word), ["run"]);
    assert.equal(ledger.trackedRequests().find((item) => item.message.id === accepted.id)?.phase, "accepted");
  } finally { blocker.close(); ledger.close(); }
});

test("gate rejects an invalid ask or expiry beyond the original accepted deadline without residue", async () => {
  const { ledger, accepted } = await fixture();
  try {
    const valid = gate(Date.now() + 20_000);
    assert.throws(() => ledger.beginGate(accepted.id, { ...valid, askBody: { ...valid.askBody, options: [{ id: "always", label: 3 }] } }));
    assert.throws(() => ledger.beginGate(accepted.id, { ...valid, askBody: { ...valid.askBody,
      source: { word: "different", to: "device:fake", body_preview: "Wrong action" } } }));
    assert.throws(() => ledger.beginGate(accepted.id, { ...valid, askBody: { ...valid.askBody,
      source: { word: "run", to: "device:other", body_preview: "Wrong device" } } }));
    assert.equal(ledger.beginGate(accepted.id, gate(Date.now() - 1)), null);
    assert.equal(ledger.beginGate(accepted.id, gate(Date.now() + 120_000)), null);
    assert.equal(ledger.gateCase(accepted.id), null);
    assert.deepEqual(ledger.list().map((item) => item.word), ["run"]);
    assert.equal(ledger.trackedRequests().find((item) => item.message.id === accepted.id)?.phase, "accepted");
  } finally { ledger.close(); }
});

test("an allowed answer commits once and keeps the original waiting for effect-time authorization", async () => {
  const { file, ledger, accepted } = await fixture();
  try {
    const started = ledger.beginGate(accepted.id, gate(Date.now() + 20_000))!;
    const settled = ledger.settleGateAsk(started.ask.id, "once", "answer", { screen: "screen:test", label: "Test screen" });
    assert.equal(settled?.askResponse.body.ok, true);
    assert.equal(settled?.event?.word, "gate.passed");
    assert.equal(settled?.originalResponse, null);
    assert.equal(ledger.gateCase(accepted.id)?.decision, "allowed");
    assert.equal(ledger.trackedRequests().find((item) => item.message.id === accepted.id)?.phase, "gate_waiting");
    assert.equal(ledger.settleGateAsk(started.ask.id, "deny", "answer"), null);
  } finally { ledger.close(); }
  const reopened = await Ledger.open(file);
  try {
    assert.equal(reopened.gateCase(accepted.id)?.decision, "allowed");
    assert.equal(reopened.list().filter((item) => item.word === "gate.passed").length, 1);
    assert.equal(reopened.responseTo(accepted.id), null);
    assert.equal(reopened.dispatchAllowedGate(accepted.id, "principal:wrong", "a".repeat(64)), false);
    assert.equal(reopened.dispatchAllowedGate(accepted.id, "principal:exact", "b".repeat(64)), false);
    assert.equal(reopened.trackedRequests().find((item) => item.message.id === accepted.id)?.phase, "gate_waiting");
    assert.equal(reopened.dispatchAllowedGate(accepted.id, "principal:exact", "a".repeat(64)), true);
    assert.equal(reopened.dispatchAllowedGate(accepted.id, "principal:exact", "a".repeat(64)), false);
    assert.equal(reopened.trackedRequests().find((item) => item.message.id === accepted.id)?.phase, "dispatching");
  } finally { reopened.close(); }
});

test("trusted deadline cannot fire early; at expiry it atomically denies original request only once", async (t) => {
  const { ledger, accepted } = await fixture();
  try {
    const expiry = Date.now() + 20_000;
    const started = ledger.beginGate(accepted.id, gate(expiry))!;
    assert.throws(() => ledger.settleGateAsk(started.ask.id, "deny", "deadline"));
    assert.equal(ledger.gateCase(accepted.id)?.decision, "waiting");
    t.mock.method(Date, "now", () => expiry);
    const settled = ledger.settleGateAsk(started.ask.id, "deny", "deadline");
    assert.equal(settled?.event?.body.by, "timeout");
    assert.equal(settled?.originalResponse?.body.ok, false);
    assert.equal(ledger.gateCase(accepted.id)?.decision, "timeout");
    assert.equal(ledger.settleGateAsk(started.ask.id, "once", "answer"), null);
    const history = ledger.gateHistoryPage().items[0];
    assert.equal(history?.subject, "person:owner");
    assert.equal(JSON.stringify(ledger.gateHistoryPage()).includes("principal:exact"), false);
    assert.equal(JSON.stringify(ledger.gateHistoryPage()).includes("a".repeat(64)), false);
    assert.equal(ledger.list().filter((item) => item.kind === "response" && item.reply_to === accepted.id).length, 1);
    assert.equal(ledger.trackedRequests().some((item) => item.message.id === accepted.id), false);
  } finally { ledger.close(); }
});

test("cancelling a waiting gate withdraws the ask and settles the original atomically", async () => {
  const { ledger, accepted } = await fixture();
  try {
    const started = ledger.beginGate(accepted.id, gate(Date.now() + 20_000))!;
    const settled = ledger.settleGateAsk(started.ask.id, "deny", "cancelled");
    assert.equal((settled?.askResponse.body.error as { code?: string } | undefined)?.code, "cancelled");
    assert.equal((settled?.originalResponse?.body.error as { code?: string } | undefined)?.code, "cancelled");
    assert.equal(settled?.event, null);
    assert.equal(ledger.gateCase(accepted.id)?.decision, "cancelled");
    assert.equal(ledger.settleGateAsk(started.ask.id, "once", "answer"), null);
    assert.equal(ledger.gateHistoryPage().items[0]?.decision, "cancelled");
  } finally { ledger.close(); }
});

test("pre-recovery turn cancellation withdraws a durable ask before any request replay", async () => {
  const { file, ledger, accepted } = await fixture(60_000, true);
  const askId = ledger.beginGate(accepted.id, gate(Date.now() + 20_000))!.ask.id;
  ledger.close();
  const reopened = await Ledger.open(file);
  try {
    const router = new WorldRouter(reopened, async () => true);
    router.enableDurableGate();
    const cancelled = router.cancelTurn("agent:main", "t_gate");
    assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0]?.reply_to, accepted.id);
    assert.equal(reopened.responseTo(askId)?.body.ok, false);
    assert.equal(reopened.gateCase(accepted.id)?.decision, "cancelled");
    assert.equal(router.cancelTurn("agent:main", "t_gate").length, 0);
  } finally { reopened.close(); }
});

test("recovery past an ask deadline settles both requests before displaying or dispatching", async (t) => {
  const { file, ledger, accepted } = await fixture();
  const base = Date.now();
  const askId = ledger.beginGate(accepted.id, gate(base + 20_000))!.ask.id;
  ledger.close();
  const reopened = await Ledger.open(file);
  try {
    t.mock.method(Date, "now", () => base + 21_000);
    const router = new WorldRouter(reopened, async () => true);
    router.register({ member: "device:fake", spec: { word: "run", kind: "request", risk: "outward", description: "Synthetic",
      input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } },
    handle: () => { assert.fail("expired gate dispatched device"); } });
    router.register({ member: "person:owner", spec: wordContract("person:owner", "ask")!, handle: () => { assert.fail("expired gate was displayed"); } });
    router.enableDurableGate();
    await router.recover();
    assert.equal(reopened.gateCase(accepted.id)?.decision, "timeout");
    assert.equal(reopened.responseTo(askId)?.body.ok, true);
    assert.equal(reopened.responseTo(accepted.id)?.body.error && (reopened.responseTo(accepted.id)!.body.error as { code: string }).code, "denied");
    assert.equal(reopened.trackedRequests().length, 0);
  } finally { reopened.close(); }
});

test("v10 owner-issued grants import once as expiring access only; confirms stay de-identified audit", async (t) => {
  const file = join(mkdtempSync(join(tmpdir(), "ash-gate-v10-")), "ash.db");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE events(seq INTEGER PRIMARY KEY,ts INTEGER,workspace TEXT,member TEXT,type TEXT,data TEXT);
    CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE grants(id TEXT PRIMARY KEY,member TEXT,scope TEXT,created_by TEXT,created_at INTEGER);
    CREATE TABLE confirms(id TEXT PRIMARY KEY,asker TEXT,title TEXT,detail TEXT,kind TEXT,state TEXT,created_at INTEGER,expires_at INTEGER,answered_by TEXT);`);
  old.prepare("INSERT INTO grants VALUES(?,?,?,?,?)").run("safe", "agent:main", "device:fake/message.send", "person:owner", 1);
  old.prepare("INSERT INTO grants VALUES(?,?,?,?,?)").run("not-owner", "agent:main", "*", "agent:main", 2);
  old.prepare("INSERT INTO grants VALUES(?,?,?,?,?)").run("bad-scope", "agent:main", "device:fake/../../secret", "person:owner", 3);
  old.prepare("INSERT INTO confirms VALUES(?,?,?,?,?,?,?,?,?)").run("old-confirm", "agent:main", "private title", "private detail", "call", "approved", 4, 5, "person:owner");
  old.close();
  const ledger = await Ledger.open(file);
  const first = Date.now();
  try {
    assert.equal(ledger.gateDeviceAccess("agent:main", "device:fake", "message.send", first), true);
    assert.equal(ledger.gateDeviceAccess("agent:main", "device:other", "message.send", first), false);
    assert.equal(ledger.gateDeviceAccess("agent:main", "device:fake", "message.send", first + 30 * 24 * 60 * 60_000 + 1), false);
    assert.deepEqual(ledger.gateRulesPage().rules, []); // an old ACL never becomes an always rule
    const history = ledger.gateHistoryPage().items;
    assert.equal(history.filter((item) => item.decision === "legacy_access_imported").length, 1);
    assert.equal(history.filter((item) => item.decision === "legacy_access_invalid").length, 2);
    assert.equal(history.filter((item) => item.decision === "legacy_approved").length, 1);
    assert.equal(JSON.stringify(history).includes("private title"), false);
    assert.equal(JSON.stringify(history).includes("private detail"), false);
    assert.equal(JSON.stringify(history).includes("../../secret"), false);
    t.mock.method(Date, "now", () => first + 30 * 24 * 60 * 60_000 + 1);
    assert.equal(ledger.gateHistoryPage().items.filter((item) => item.decision === "legacy_access_expired").length, 1);
    t.mock.restoreAll();
  } finally { ledger.close(); }
  const reopened = await Ledger.open(file);
  try {
    assert.equal(reopened.gateHistoryPage().items.length, 4);
    assert.equal(reopened.gateDeviceAccess("agent:main", "device:fake", "message.send", first + 30 * 24 * 60 * 60_000 + 1), false);
  } finally { reopened.close(); }
});
