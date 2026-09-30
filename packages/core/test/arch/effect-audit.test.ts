import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../../../sdk/src/api";
import { auditEffectLedger, type ObservedEffect } from "./effect-audit";

function message(seq: number, id: string, kind: Message["kind"], from: string, to: string | null, word: string, body: Record<string, unknown>, reply_to?: string): Message {
  return { seq, id, kind, from, to, word, body, ts: seq, ...(reply_to ? { reply_to } : {}) };
}

function sample(): { messages: Message[]; effects: ObservedEffect[] } {
  const deviceBody = { title: "visit", start: 1 };
  const notificationBody = { message_id: "m-owner", kind: "due" };
  const writeBody = { path: "MEMORY.md", content: "note", expected_hash: "h0" };
  const gateBody = { request_id: "m-device", rule_id: "rule-1" };
  return {
    messages: [
      message(1, "m-device", "request", "agent:main", "device:phone", "calendar.create", deviceBody),
      message(2, "r-device", "response", "device:phone", "agent:main", "calendar.create", { ok: true, result: { id: "event-1" } }, "m-device"),
      message(3, "m-post", "request", "service:work", "service:post", "deliver", notificationBody),
      message(4, "r-post", "response", "service:post", "service:work", "deliver", { ok: true, result: { channel: "notification" } }, "m-post"),
      message(5, "m-self", "request", "service:work", "service:self", "write", writeBody),
      message(6, "e-self", "event", "service:self", null, "self.changed", { path: "MEMORY.md", by: "service:work" }),
      message(7, "r-self", "response", "service:self", "service:work", "write", { ok: true, result: { hash: "h1" } }, "m-self"),
      message(8, "e-gate", "event", "service:gate", null, "gate.passed", gateBody),
    ],
    effects: [
      { id: "external-device-1", kind: "device_call", ledger_id: "m-device", to: "device:phone", word: "calendar.create", body: deviceBody, result: { ok: true, result: { id: "event-1" } } },
      { id: "external-notification-1", kind: "notification", ledger_id: "m-post", to: "service:post", word: "deliver", body: notificationBody, result: { ok: true, result: { channel: "notification" } } },
      { id: "external-write-1", kind: "intrinsic_write", ledger_id: "m-self", to: "service:self", word: "write", body: writeBody, result: { ok: true, result: { hash: "h1" } } },
      { id: "external-gate-1", kind: "gate_release", ledger_id: "e-gate", to: null, word: "gate.passed", body: gateBody },
    ],
  };
}

test("AR6 detector accepts four independently witnessed effects with exact ledger records", () => {
  const { messages, effects } = sample();
  assert.deepEqual(auditEffectLedger(messages, effects), []);
});

test("AR6 detector refuses empty or incomplete observations", () => {
  const { messages, effects } = sample();
  assert.match(auditEffectLedger(messages, []).join(" "), /no externally observed effects/);
  assert.match(auditEffectLedger(messages, effects.slice(0, 3)).join(" "), /no observed gate_release/);
});

test("AR6 detector catches missing cause, wrong arguments, and duplicate effect attribution", () => {
  const { messages, effects } = sample();
  assert.match(auditEffectLedger(messages.filter(m => m.id !== "m-device"), effects).join(" "), /has no ledger cause/);
  assert.match(auditEffectLedger(messages, effects.map(e => e.id === "external-device-1" ? { ...e, body: { title: "other" } } : e)).join(" "), /does not match ledger/);
  assert.match(auditEffectLedger(messages, effects.map(e => e.id === "external-device-1" ? { ...e, to: "device:other" } : e)).join(" "), /does not match ledger/);
  assert.match(auditEffectLedger(messages, [...effects, { ...effects[0], id: "external-device-2" }]).join(" "), /multiple effects claim ledger id/);
});

test("AR6 detector catches duplicate terminal response and missing write event", () => {
  const { messages, effects } = sample();
  const duplicate = [...messages, message(9, "r-device-again", "response", "device:phone", "agent:main", "calendar.create", { ok: true }, "m-device")];
  assert.match(auditEffectLedger(duplicate, effects).join(" "), /no unique later response/);
  assert.match(auditEffectLedger(messages, effects.map(e => e.id === "external-device-1" ? { ...e, result: { ok: true, result: { id: "wrong" } } } : e)).join(" "), /result differs from ledger response/);
  assert.match(auditEffectLedger(messages.filter(m => m.id !== "e-self"), effects).join(" "), /no self.changed event/);
});

test("AR6 detector catches fake notification result, forged gate event, and ledger reordering", () => {
  const { messages, effects } = sample();
  const wrongChannel = messages.map(m => m.id === "r-post" ? { ...m, body: { ok: true, result: { channel: "held" } } } : m);
  assert.match(auditEffectLedger(wrongChannel, effects).join(" "), /was not recorded as notification delivery/);
  const forgedGate = messages.map(m => m.id === "e-gate" ? { ...m, from: "agent:main" } : m);
  assert.match(auditEffectLedger(forgedGate, effects).join(" "), /lacks gate.passed event/);
  const reversed = [...messages].reverse();
  assert.match(auditEffectLedger(reversed, effects).join(" "), /sequence is not strictly increasing/);
});
