import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Ledger } from "../../src/world/ledger";

const gate = (expiresAt: number) => ({ subject: "principal:exact", risk: "outward" as const,
  contractFingerprint: "a".repeat(64), expiresAt,
  askBody: { title: "Confirm action", detail: "Synthetic device", options: [
    { id: "once", label: "Only now" }, { id: "deny", label: "Deny" }],
    source: { word: "run", to: "device:fake", body_preview: "Synthetic action" } } });

async function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), "ash-gate-ledger-")), "ash.db");
  const ledger = await Ledger.open(file);
  const accepted = ledger.append({ from: "agent:main", to: "device:fake", kind: "request", word: "run", body: { n: 1 } },
    undefined, { deadlineAt: Date.now() + 60_000, context: { member: "agent:main", local: true, remote: false,
      ownerProxy: false, transportPrincipal: "agent:main" } }).message;
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
    assert.equal(settled?.event.word, "gate.passed");
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
  } finally { reopened.close(); }
});

test("trusted deadline beats answer and atomically denies original request only once", async () => {
  const { ledger, accepted } = await fixture();
  try {
    const started = ledger.beginGate(accepted.id, gate(Date.now() + 20_000))!;
    const settled = ledger.settleGateAsk(started.ask.id, "deny", "deadline");
    assert.equal(settled?.event.body.by, "timeout");
    assert.equal(settled?.originalResponse?.body.ok, false);
    assert.equal(ledger.gateCase(accepted.id)?.decision, "timeout");
    assert.equal(ledger.settleGateAsk(started.ask.id, "once", "answer"), null);
    assert.equal(ledger.list().filter((item) => item.kind === "response" && item.reply_to === accepted.id).length, 1);
    assert.equal(ledger.trackedRequests().some((item) => item.message.id === accepted.id), false);
  } finally { ledger.close(); }
});
