import assert from "node:assert/strict";
import test from "node:test";
import type { GateHistoryItemV2, GateRuleItemV2 } from "../src/api";
import { matchesSchema } from "../src/schema";
import { wordContract } from "../src/words";

const rule: GateRuleItemV2 = { id: "rule_1", subject: "agent:main", device_id: "device:isolated",
  capability_id: "message.send", to: "device:isolated", word: "message.send", object_pattern: "550e8400-e29b-41d4-a716-446655440000",
  risk: "outward", contract_fingerprint: "a".repeat(64), created_at: 1_727_740_800_000, expires_at: 1_730_332_800_000 };
const current: GateHistoryItemV2 = { id: "history_1", request_id: "m_request", ask_id: "m_ask", subject: "agent:main",
  to: "device:isolated", word: "message.send", risk: "outward", decision: "always", at: 1_727_740_800_000,
  rule_id: rule.id, source: "current" };
const legacy: GateHistoryItemV2 = { id: "legacy_1", subject: "agent:main", decision: "legacy_access_imported",
  at: 1_727_740_800_000, legacy_scope: "device:isolated/message.send", source: "legacy" };

test("gate rules list is bounded, owner-only, and exposes only explicit approval-rule fields", () => {
  const spec = wordContract("service:gate", "rules.list")!;
  assert.equal(spec.kind, "request");
  assert.equal(spec.audience, "owner");
  for (const input of [{}, { before: 1, limit: 100 }]) assert.ok(matchesSchema(spec.input_schema!, input));
  for (const input of [{ before: 0 }, { before: -1 }, { before: 1.5 }, { before: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 }, { limit: 101 }, { limit: 2.5 }, { offset: 4 }, null])
    assert.ok(!matchesSchema(spec.input_schema!, input), `invalid rules cursor accepted: ${JSON.stringify(input)}`);
  assert.ok(matchesSchema(spec.result_schema!, { rules: [rule], next_before: 8 }));
  assert.ok(matchesSchema(spec.result_schema!, { rules: [] }));
  for (const result of [
    { rules: [{ ...rule, contract_fingerprint: "not-a-hash" }] },
    { rules: [{ ...rule, risk: "none" }] },
    { rules: [{ ...rule, legacy_scope: "*" }] },
    { rules: [{ ...rule, bearer_token: "secret" }] },
    { rules: [{ ...rule, revoked_at: -1 }] },
    { rules: [rule], next_before: 0 },
    { rules: Array.from({ length: 101 }, () => rule) },
    { items: [rule] }, null,
  ]) assert.ok(!matchesSchema(spec.result_schema!, result), `invalid rules result accepted: ${JSON.stringify(result)}`);
});

test("gate history keeps actionable current cases separate from non-actionable legacy audit", () => {
  const spec = wordContract("service:gate", "history")!;
  assert.equal(spec.audience, "owner");
  for (const input of [{}, { before: 2, limit: 1000 }]) assert.ok(matchesSchema(spec.input_schema!, input));
  for (const input of [{ before: 0 }, { limit: 1001 }, { offset: 1 }, { before: "2" }, null])
    assert.ok(!matchesSchema(spec.input_schema!, input));
  assert.ok(matchesSchema(spec.result_schema!, { items: [current, legacy], next_before: 1 }));
  assert.ok(matchesSchema(spec.result_schema!, { items: [{ ...legacy, decision: "legacy_unresolved", legacy_scope: "*" }] }));
  for (const result of [
    { items: [{ ...current, source: "legacy" }] },
    { items: [{ ...current, legacy_scope: "*" }] },
    { items: [{ ...legacy, source: "current" }] },
    { items: [{ ...legacy, request_id: "m_legacy" }] },
    { items: [{ ...legacy, legacy_scope: "device:isolated/../secret" }] },
    { items: [{ ...legacy, detail: "old private confirmation" }] },
    { items: [{ ...current, decision: "legacy_approved" }] },
    { items: [current], next_before: 0 },
    { items: Array.from({ length: 1001 }, () => current) }, null,
  ]) assert.ok(!matchesSchema(spec.result_schema!, result), `invalid history accepted: ${JSON.stringify(result)}`);
});

test("gate events are service-only closed audit shapes without arguments or credentials", () => {
  const asked = wordContract("service:gate", "gate.asked")!;
  const passed = wordContract("service:gate", "gate.passed")!;
  const denied = wordContract("service:gate", "gate.denied")!;
  const base = { request_id: "m_request", ask_id: "m_ask", risk: "outward", to: "device:isolated",
    word: "message.send", expires_at: 1_727_740_800_000 };
  for (const spec of [asked, passed, denied]) {
    assert.equal(spec.kind, "event");
    assert.equal(spec.direction, "out");
    assert.equal(spec.result_schema, undefined);
  }
  assert.equal(wordContract("agent:main", "gate.asked"), undefined);
  assert.ok(matchesSchema(asked.input_schema!, base));
  // An access card for a capability's first use is gated even when the action itself carries no risk.
  assert.ok(matchesSchema(asked.input_schema!, { ...base, risk: "none" }));
  for (const invalid of [{ ...base, risk: "low" }, { ...base, expires_at: Infinity }, { ...base, arguments: { text: "private" } },
    { ...base, token: "private" }, { request_id: "m_request" }, null]) assert.ok(!matchesSchema(asked.input_schema!, invalid));
  for (const body of [{ request_id: "m_request", by: "rule", rule_id: rule.id },
    { request_id: "m_request", by: "answer", ask_id: "m_ask" }]) assert.ok(matchesSchema(passed.input_schema!, body));
  for (const invalid of [{ request_id: "m_request", by: "owner" }, { request_id: "m_request", by: "rule", body: {} },
    { request_id: "m_request", by: "answer", credential: "private" }, null]) assert.ok(!matchesSchema(passed.input_schema!, invalid));
  for (const by of ["answer", "timeout"]) assert.ok(matchesSchema(denied.input_schema!, { request_id: "m_request", by, ask_id: "m_ask" }));
  for (const invalid of [{ request_id: "m_request", by: "cancelled" }, { request_id: "m_request", by: "timeout", detail: "private" },
    { request_id: "", by: "answer" }, null]) assert.ok(!matchesSchema(denied.input_schema!, invalid));
  assert.equal(wordContract("service:gate", "rules.revoke")?.risk, "structure", "local-owner no-recursion is a runtime authorization rule, not a risk downgrade");
});
