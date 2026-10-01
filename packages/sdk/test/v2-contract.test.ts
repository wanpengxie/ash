import assert from "node:assert/strict";
import test from "node:test";
import { API_VERSION, API_VERSION_V2, SCREEN_REGISTRATION_EVENT, SCREEN_REGISTRATION_TTL_MS, SCREEN_TOKEN_HEADER, type JsonSchema, type ScreenUiOpenAnswerV2, type SendRequestV2 } from "../src/api";
import { DEFAULT_WORLD_CONFIG_V2, resolveWorldConfigV2, WORLD_CONFIG_SCHEMA_V2 } from "../src/config";
import { HOST_ROUTES_V2 } from "../src/host";
import { RUNTIME_CONTRACT_V2 } from "../src/runtime-contract";
import { matchesSchema } from "../src/schema";
import { workerResultErrors } from "../src/worker-validation";
import { CARD_SCHEMA, cardErrors, deviceWordSpec, optionReplyErrors, WORD_CONTRACTS, wordContract } from "../src/words";

function example(schema: JsonSchema): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.oneOf) return example(schema.oneOf[0]);
  if (schema.anyOf) return example(schema.anyOf[0]);
  switch (schema.type) {
    case "null": return null;
    case "string": return schema.pattern?.includes("[0-9a-f]{64}") ? "a".repeat(64) : schema.pattern?.includes("memory/") ? "memory/2020-01-01.md" : "value";
    case "number": case "integer": return schema.minimum ?? 1;
    case "boolean": return true;
    case "array": return Array.from({ length: schema.minItems ?? 0 }, () => example(schema.items ?? {}));
    case "object": return Object.fromEntries((schema.required ?? []).map((name) => [name, example(schema.properties?.[name] ?? {})]));
    default: return {};
  }
}

test("response send contract carries a stable client id for acknowledgement-loss retries", () => {
  const first: SendRequestV2 = { to: "agent:main", kind: "response", word: "ask", reply_to: "m_request", body: { ok: true, result: { choice: "once" } }, client_id: "approval-1" };
  const retry: SendRequestV2 = { ...first, body: { ok: true, result: { choice: "once" } } };
  assert.deepEqual(retry, first);
});

test("target-screen ui.open acknowledgement uses the existing paired response and exact boolean result", () => {
  const word = wordContract("screen:tab-1", "ui.open")!;
  assert.ok(matchesSchema(word.input_schema!, { target: "memory", mode: "perform" }));
  assert.ok(matchesSchema(word.input_schema!, { target: "turn", id: "t_1", mode: "suggest" }));
  for (const input of [{ target: "memory", mode: "broadcast" }, { target: "memory", mode: "perform", screen: "screen:other" }])
    assert.ok(!matchesSchema(word.input_schema!, input));
  assert.ok(matchesSchema(word.result_schema!, { opened: true }));
  assert.ok(matchesSchema(word.result_schema!, { opened: false }));
  for (const result of [{}, { opened: "true" }, { opened: true, screen: "screen:other" }]) assert.ok(!matchesSchema(word.result_schema!, result));
  const answer: ScreenUiOpenAnswerV2 = { to: "agent:main", kind: "response", word: "ui.open", reply_to: "m_open", body: { ok: true, result: { opened: false } }, client_id: "screen-ack-1" };
  assert.equal(answer.body.result.opened, false);
  assert.equal(SCREEN_TOKEN_HEADER, "Ash-Screen");
});

test("v2 is additive to the existing client protocol", () => {
  assert.equal(API_VERSION, "ash-api/1");
  assert.equal(API_VERSION_V2, "ash-api/2");
  assert.equal(SCREEN_REGISTRATION_EVENT, "screen.registered");
  assert.equal(SCREEN_TOKEN_HEADER, "Ash-Screen");
  assert.equal(SCREEN_REGISTRATION_TTL_MS, 86_400_000);
  assert.deepEqual(Object.keys(HOST_ROUTES_V2).sort(), ["alarm", "call", "hide", "key", "manifest", "present", "restart", "sign"]);
  assert.equal(RUNTIME_CONTRACT_V2.publicMember, "agent:main");
  assert.notEqual(RUNTIME_CONTRACT_V2.sessions.main, RUNTIME_CONTRACT_V2.publicMember);
  assert.deepEqual(RUNTIME_CONTRACT_V2.tools, ["ash_describe", "ash_send", "ash_say", "ash_react", "ash_show"]);
  assert.deepEqual(RUNTIME_CONTRACT_V2.workerInvocation.tools, []);
  assert.equal(RUNTIME_CONTRACT_V2.cancellation.discardLateResults, true);
});

test("every declared word has a usable positive and negative schema example", () => {
  const seen = new Set<string>();
  for (const word of WORD_CONTRACTS) {
    const key = `${word.member}/${word.word}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
    assert.equal(wordContract(word.member, word.word), word);
    assert.ok(word.description && word.label && word.risk && word.audience, key);
    assert.notEqual(word.label, word.word, `${key}: label must be readable, not an internal word`);
    assert.ok(word.input_schema, key);
    const valid = example(word.input_schema!);
    assert.ok(matchesSchema(word.input_schema!, valid), `${key}: generated positive ${JSON.stringify(valid)}`);
    assert.ok(!matchesSchema(word.input_schema!, null), `${key}: null input must fail`);
    if (word.input_schema?.required?.length) {
      const missing = { ...(valid as Record<string, unknown>) };
      delete missing[word.input_schema.required[0]];
      assert.ok(!matchesSchema(word.input_schema, missing), `${key}: required field must fail`);
    }
    if (word.kind === "request") {
      assert.ok(word.result_schema, `${key}: missing result schema`);
      const result = example(word.result_schema!);
      assert.ok(matchesSchema(word.result_schema!, result), `${key}: generated result positive`);
      assert.ok(!matchesSchema(word.result_schema!, null), `${key}: null result must fail`);
    }
  }
  assert.ok(seen.size >= 50, `unexpectedly small catalog: ${seen.size}`);
  assert.equal(wordContract("screen:tab-1", "ui.open")?.member, "screen:*");
  assert.equal(wordContract("screen:", "ui.open"), undefined);
});

test("managed writes require a valid base hash, while dated append has no base hash", () => {
  const write = wordContract("service:self", "write")!.input_schema!;
  const base = { path: "USER.md", content: "x", why: "correction", expected_hash: "a".repeat(64) };
  assert.ok(matchesSchema(write, base));
  assert.ok(matchesSchema(write, { ...base, expected_hash: null }));
  assert.ok(!matchesSchema(write, { path: base.path, content: base.content, why: base.why }));
  assert.ok(!matchesSchema(write, { ...base, expected_hash: "A".repeat(64) }));
  assert.ok(!matchesSchema(write, { ...base, path: "../USER.md" }));
  const append = wordContract("service:self", "append")!.input_schema!;
  assert.ok(matchesSchema(append, { path: "memory/1999-12-31.md", text: "x" }));
  assert.ok(!matchesSchema(append, { path: "USER.md", text: "x" }));
  assert.ok(!matchesSchema(append, { path: "memory/1999-12-31.md", text: "x", expected_hash: null }));
});

test("delivery count event is an authoritative nonnegative integer snapshot", () => {
  const word = wordContract("service:post", "post.changed")!;
  assert.equal(word.kind, "event");
  assert.equal(word.direction, "out");
  assert.ok(matchesSchema(word.input_schema!, { held: 0 }));
  assert.ok(matchesSchema(word.input_schema!, { held: 7 }));
  for (const body of [{}, { held: -1 }, { held: 1.5 }, { held: "2" }, { held: 2, delta: 1 }]) assert.ok(!matchesSchema(word.input_schema!, body));
});

test("normal say inputs reject migration-only legacy provenance", () => {
  const oldMarker = { seq: 1, workspace: "home", member: "agent:helper" };
  const inbound = wordContract("agent:main", "say")!.input_schema!;
  const outbound = wordContract("person:owner", "say")!.input_schema!;
  assert.ok(!matchesSchema(inbound, { text: "hello", legacy: oldMarker }));
  assert.ok(!matchesSchema(outbound, { text: "hello", kind: "reply", legacy: oldMarker }));
});

test("agent say allows attachment-only input but never an empty message", () => {
  const inbound = wordContract("agent:main", "say")!.input_schema!;
  const outbound = wordContract("person:owner", "say")!.input_schema!;
  const file = { name: "notes.txt", mime_type: "text/plain", data: "eA==" };
  for (const body of [
    { text: "hello" },
    { text: "hello", attachments: [] },
    { text: "hello", attachments: [file], in_reply_to: "m1", option_id: "choice" },
    { text: "", attachments: [file] },
  ]) assert.ok(matchesSchema(inbound, body), JSON.stringify(body));
  for (const body of [
    {}, { text: "" }, { text: "", attachments: [] },
    { text: "", attachments: [{}] },
    { text: "", attachments: [{ ...file, data: "" }] },
    { text: 1, attachments: [file] },
    { attachments: [file] },
    { text: "", attachments: [file], legacy: { seq: 1 } },
  ]) assert.ok(!matchesSchema(inbound, body), JSON.stringify(body));
  assert.ok(!matchesSchema(outbound, { text: "", kind: "reply", attachments: [file] }));
});

test("card variants and dynamic device descriptions reject malformed contracts", () => {
  assert.ok(matchesSchema(CARD_SCHEMA, { type: "options", options: [{ id: "yes", text: "Yes" }] }));
  assert.ok(matchesSchema(CARD_SCHEMA, { type: "file", workspace: "w", path: "p", name: "n", mime_type: "text/plain", size: 0 }));
  assert.ok(matchesSchema(CARD_SCHEMA, { type: "image", workspace: "w", path: "p" }));
  assert.ok(matchesSchema(CARD_SCHEMA, { type: "link", url: "https://example.invalid", title: "Example" }));
  assert.ok(matchesSchema(CARD_SCHEMA, { type: "permission", permission: "calendar", why: "To find events" }));
  assert.ok(!matchesSchema(CARD_SCHEMA, { type: "options", options: [] }));
  assert.ok(!matchesSchema(CARD_SCHEMA, { type: "file", workspace: "w", path: "p", name: "n", mime_type: "x", size: -1 }));
  assert.deepEqual(cardErrors({ type: "options", options: [{ id: "yes", text: "Yes" }, { id: "yes", text: "Yes again" }] }), ["duplicate option id"]);
  assert.deepEqual(cardErrors({ type: "options", options: [{ id: "__custom", text: "Custom" }] }), ["reserved option id"]);
  assert.equal(optionReplyErrors({ text: "Yes", in_reply_to: "ask-1" }).length, 1);
  assert.deepEqual(optionReplyErrors({ text: "Yes", in_reply_to: "ask-1", option_id: "yes" }), []);
  assert.equal(deviceWordSpec({ name: "read", description: "Read", input_schema: { type: "object" }, risk: "none", label: "Reading" }).word, "read");
  assert.throws(() => deviceWordSpec({ name: "read", description: "", input_schema: { type: "object" }, risk: "none", label: "Reading" }));
  assert.throws(() => deviceWordSpec({ name: "read", description: "Read", input_schema: { type: "object" }, risk: "bogus" as "none", label: "Reading" }));
  assert.throws(() => deviceWordSpec({ name: "read", description: "Read", input_schema: null as unknown as JsonSchema, risk: "none", label: "Reading" }));
  assert.throws(() => deviceWordSpec({ name: "read", description: "Read", input_schema: { type: "array" }, risk: "none", label: "Reading" }));
});

test("config fills defaults, preserves legacy root keys, and rejects invalid nested values", () => {
  const input = { existing: { enabled: true }, delivery: { dedupe_minutes: 0 }, workers: { model: { provider: "p", model: "m" } } };
  const resolved = resolveWorldConfigV2(input);
  assert.deepEqual(resolved.existing, input.existing);
  assert.equal(resolved.delivery.quiet, DEFAULT_WORLD_CONFIG_V2.delivery.quiet);
  assert.equal(resolved.delivery.dedupe_minutes, 0);
  assert.deepEqual(resolved.workers.model, { provider: "p", model: "m" });
  assert.ok(matchesSchema(WORLD_CONFIG_SCHEMA_V2, resolved));
  assert.equal(resolveWorldConfigV2({ reflex: { jev: { key_credential: "vault/team-prod/key" } } }).reflex.jev.key_credential, "vault/team-prod/key");
  for (const bad of [
    { delivery: { quiet: "25:00-09:00" } },
    { delivery: { dedupe_minutes: -1 } },
    { reflex: { threshold: 1.1 } },
    { reflex: { jev: { key: "inline" } } },
    { reflex: { jev: [] } },
    { reflex: { jev: null } },
    { reflex: { jev: ["unexpected"] } },
    { workers: { model: { provider: "p" } } },
    { memory: { idle_minutes: 0 } },
    { heartbeat: { every_minutes: 0.5 } },
    { opener: { away_hours: 0 } },
  ]) assert.throws(() => resolveWorldConfigV2(bad), JSON.stringify(bad));
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const bad = JSON.parse(`{"delivery":{"${key}":{"polluted":true}}}`);
    assert.throws(() => resolveWorldConfigV2(bad), /unexpected/);
  }
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test("internal schema subset fails closed and compares unique objects independent of key order", () => {
  assert.throws(() => matchesSchema({ allOf: [] } as JsonSchema, {}), /unsupported schema keyword/);
  assert.throws(() => matchesSchema({ type: "funky" } as unknown as JsonSchema, {}), /unsupported schema type/);
  assert.throws(() => matchesSchema({ anyOf: [{ type: "string" }, { type: "string", format: "email" } as JsonSchema] }, "x"), /unsupported schema keyword format/);
  assert.throws(() => matchesSchema({ type: "object", properties: { x: { type: "string", format: "email" } as JsonSchema } }, {}), /unsupported schema keyword format/);
  assert.throws(() => matchesSchema({ minLength: 4 }, "x"), /requires string type/);
  assert.throws(() => matchesSchema({ type: "number", minLength: 4 }, 10), /requires string type/);
  assert.throws(() => matchesSchema({ type: "string", minLength: "bad" } as unknown as JsonSchema, "x"), /minLength must be a nonnegative integer/);
  assert.throws(() => matchesSchema({ type: "array", minItems: "bad" } as unknown as JsonSchema, []), /minItems must be a nonnegative integer/);
  assert.throws(() => matchesSchema({ type: "number", minimum: "bad" } as unknown as JsonSchema, 1), /minimum must be a finite number/);
  assert.throws(() => matchesSchema({ type: "string", pattern: "[" }, "x"), /invalid pattern/);
  assert.throws(() => matchesSchema({ type: "array", uniqueItems: "yes" } as unknown as JsonSchema, []), /uniqueItems must be boolean/);
  assert.throws(() => matchesSchema({ properties: { x: { type: "string" } } }, {}), /requires object type/);
  assert.throws(() => matchesSchema({ items: { type: "string" } }, []), /requires array type/);
  assert.throws(() => matchesSchema({ minimum: 1 }, 2), /requires number type/);
  assert.throws(() => matchesSchema({ type: "array", items: { anyOf: [{ type: "string" }, { format: "email" } as JsonSchema] } }, []), /unsupported schema keyword format/);
  assert.ok(matchesSchema({}, "x"));
  assert.ok(matchesSchema({ anyOf: [{ type: "string" }, { type: "number" }] }, "x"));
  assert.ok(!matchesSchema({ type: "array", uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }]));
});

test("worker hard rules reject unsupported evidence, missing quotes, and long suggestions", () => {
  const msg = { seq: 1, id: "m1", ts: 1, from: "person:owner", to: "agent:main", kind: "request" as const, word: "say", body: {} };
  const claim = { text: "x", type: "correction" as const, salience: "high" as const, evidence: ["m1"], quote: "exact", supersedes: "old" };
  const extract = { input: { chunk: [msg], summary: "", known: [] }, run: "r" };
  assert.deepEqual(workerResultErrors("extract", extract, { claims: [claim] }), []);
  assert.match(workerResultErrors("extract", extract, { claims: [{ ...claim, evidence: ["other"] }] })[0], /unknown evidence/);
  assert.match(workerResultErrors("extract", extract, { claims: [{ ...claim, quote: "" }] })[0], /quote required/);
  assert.match(workerResultErrors("extract", extract, { claims: [{ ...claim, supersedes: "" }] })[0], /supersedes required/);
  const reconcile = { input: { file: "MEMORY.md" as const, numbered: "1 x", claims: [claim] }, run: "r" };
  const edit = { op: "replace", start: 1, end: 1, guard: "x", reason: "correct", evidence: ["unknown"] };
  assert.match(workerResultErrors("reconcile", reconcile, { edits: [edit] })[0], /unknown evidence/);
  const proactive = { input: { prefs: "", recent: [], facts: [{ n: 1, text: "x" }], upcoming: [], delivered: [] }, run: "r" };
  const suggestion = { kind: "offer", title: "x", text: "一句。二句。三句。", urgency: "regular", facts: [2] };
  assert.deepEqual(workerResultErrors("proactive", proactive, { suggestion }).sort(), ["suggestion: more than two sentences", "suggestion: unknown fact 2"].sort());
  assert.deepEqual(workerResultErrors("proactive", proactive, { no_change: { checked: [], details: "nothing" } }), []);
});
