import assert from "node:assert/strict";
import test from "node:test";
import type { GateHistoryItemV2, GateRuleItemV2 } from "../src/api";
import { matchesSchema } from "../src/schema";
import { deviceWordSpec, wordContract, wordEffect, WORD_CONTRACTS } from "../src/words";

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
  // A capability-wide rule ("*") may cover a word whose effect, not its legacy risk, put it behind the gate.
  assert.ok(matchesSchema(spec.result_schema!, { rules: [{ ...rule, object_pattern: "*", risk: "none" }] }));
  for (const result of [
    { rules: [{ ...rule, contract_fingerprint: "not-a-hash" }] },
    { rules: [{ ...rule, risk: "low" }] },
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
  assert.ok(matchesSchema(spec.result_schema!, { items: [{ ...current, decision: "review", reason: "她判断这是可撤回的操作" }, { ...current, decision: "carry" }] }));
  assert.ok(!matchesSchema(spec.result_schema!, { items: [{ ...current, decision: "review", reason: 3 }] }));
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
  // A word whose effect is not read is gated even when its legacy risk says none.
  assert.ok(matchesSchema(asked.input_schema!, { ...base, risk: "none" }));
  for (const invalid of [{ ...base, risk: "low" }, { ...base, expires_at: Infinity }, { ...base, arguments: { text: "private" } },
    { ...base, token: "private" }, { request_id: "m_request" }, null]) assert.ok(!matchesSchema(asked.input_schema!, invalid));
  for (const body of [{ request_id: "m_request", by: "rule", rule_id: rule.id },
    { request_id: "m_request", by: "answer", ask_id: "m_ask" },
    { request_id: "m_request", by: "review", reason: "打开网页是可撤回的操作" },
    { request_id: "m_request", by: "carry", reason: "你几分钟前刚允许过同样的操作" }]) assert.ok(matchesSchema(passed.input_schema!, body));
  for (const invalid of [{ request_id: "m_request", by: "owner" }, { request_id: "m_request", by: "rule", body: {} },
    { request_id: "m_request", by: "answer", credential: "private" }, { request_id: "m_request", by: "review", reason: "" },
    { request_id: "m_request", by: "review", reason: "x".repeat(501) }, { request_id: "m_request", by: "review", verdict: { decision: "allow" } },
    null]) assert.ok(!matchesSchema(passed.input_schema!, invalid));
  for (const by of ["answer", "timeout"]) assert.ok(matchesSchema(denied.input_schema!, { request_id: "m_request", by, ask_id: "m_ask" }));
  for (const invalid of [{ request_id: "m_request", by: "cancelled" }, { request_id: "m_request", by: "timeout", detail: "private" },
    { request_id: "", by: "answer" }, null]) assert.ok(!matchesSchema(denied.input_schema!, invalid));
  assert.equal(wordContract("service:gate", "rules.revoke")?.risk, "structure", "local-owner no-recursion is a runtime authorization rule, not a risk downgrade");
});

test("every word has an effect: declared, or derived from risk without ever relaxing it", () => {
  assert.equal(wordEffect({ risk: "none" }), "read");
  assert.equal(wordEffect({}), "read");
  assert.equal(wordEffect({ risk: "outward" }), "act");
  assert.equal(wordEffect({ risk: "structure" }), "write");
  assert.equal(wordEffect({ risk: "outward", effect: "send" }), "send");
  assert.equal(wordEffect({ risk: "none", effect: "act" }), "act", "a declared effect may gate a word its risk did not");
  assert.equal(wordEffect({ risk: "structure", effect: "read" }), "write", "a read claim never undoes a risk");
  assert.equal(wordEffect({ risk: "outward", effect: "bogus" as never }), "act");
  const base = { name: "shell.run", description: "Run a command", label: "执行命令", risk: "structure" as const,
    input_schema: { type: "object" as const, properties: { command: { type: "string" as const } }, required: ["command"] } };
  assert.equal(deviceWordSpec({ ...base, effect: "execute" }).effect, "execute");
  assert.equal(deviceWordSpec(base).effect, undefined);
  assert.equal(wordEffect(deviceWordSpec(base)), "write");
  assert.throws(() => deviceWordSpec({ ...base, effect: "delete" as never }), /effect/);
  for (const [member, word, effect] of [["service:self", "rollback", "write"], ["service:gate", "rules.revoke", "structure"],
    ["service:admin", "plugins.op", "structure"], ["service:admin", "gateway.op", "structure"], ["agent:main", "say", "read"]] as const)
    assert.equal(wordEffect(wordContract(member, word)!), effect, `${member}/${word}`);
  for (const spec of WORD_CONTRACTS) if (spec.risk && spec.risk !== "none") assert.notEqual(wordEffect(spec), "read", `${spec.member}/${spec.word}`);
});
