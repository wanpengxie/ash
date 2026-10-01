import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Ledger } from "../../src/world/ledger";
import { WorldRouter } from "../../src/world/router";

const gate = (expiresAt: number) => ({ subject: "principal:exact", risk: "outward" as const,
  contractFingerprint: "a".repeat(64), expiresAt,
  askBody: { title: "Confirm action", detail: "Synthetic device", options: [
    { id: "once", label: "Only now" }, { id: "deny", label: "Deny" }],
    source: { word: "run", to: "device:fake", body_preview: "Synthetic action" } } });

async function fixture(deadlineMs = 60_000) {
  const file = join(mkdtempSync(join(tmpdir(), "ash-gate-ledger-")), "ash.db");
  const ledger = await Ledger.open(file);
  const accepted = ledger.append({ from: "agent:main", to: "device:fake", kind: "request", word: "run", body: { n: 1 }, turn: "t_gate" },
    undefined, { deadlineAt: Date.now() + deadlineMs, context: { member: "agent:main", local: true, remote: false,
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
    assert.equal(history?.subject, "agent:main");
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
  const { file, ledger, accepted } = await fixture();
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
