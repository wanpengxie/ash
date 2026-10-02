import assert from "node:assert/strict";
import test from "node:test";
import { API_VERSION, API_VERSION_V2, AUTH_SCOPE_EVENT, MESSAGE_SUMMARY_EVENT, POST_DELIVERY_SNAPSHOT_EVENT, SCREEN_REGISTRATION_EVENT, SCREEN_REGISTRATION_TTL_MS, SCREEN_TOKEN_HEADER, STREAM_ERROR_EVENT, STREAM_PAGE_END_EVENT, STREAM_RAW_PAGE_BYTES, STREAM_SUMMARY_CONTROL_RESERVE_BYTES, STREAM_SUMMARY_ITEM_BYTES, STREAM_SUMMARY_PAGE_BYTES, SummaryPageBudgetV2, isAuthScopeControlV2, isMessageSummaryV2, isScreenRegistration, isStreamErrorV2, isStreamPageEndV2, type ClockFiredBodyV2, type JsonSchema, type Message, type MessageSummaryV2, type PostDeliveryBodyV2, type PostDeliverySnapshotV2, type ScreenUiOpenAnswerV2, type SendRequestV2, type StreamQueryV2 } from "../src/api";
import { DEFAULT_WORLD_CONFIG_V2, resolveWorldConfigV2, WORLD_CONFIG_SCHEMA_V2 } from "../src/config";
import { HOST_ROUTES_V2 } from "../src/host";
import { RUNTIME_CONTRACT_V2 } from "../src/runtime-contract";
import { matchesSchema } from "../src/schema";
import { workerResultErrors } from "../src/worker-validation";
import { CARD_SCHEMA, cardErrors, deviceWordSpec, optionReplyErrors, postDeliverySnapshotErrors, WORD_CONTRACTS, wordContract } from "../src/words";

function example(schema: JsonSchema): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.oneOf) return example(schema.oneOf[0]);
  if (schema.anyOf) return example(schema.anyOf[0]);
  switch (schema.type) {
    case "null": return null;
    case "string": return schema.pattern?.includes("[0-9a-f]{64}") ? "a".repeat(64)
      : schema.pattern?.startsWith("^agent:") ? "agent:main"
      : schema.pattern?.startsWith("^device:") ? "device:phone/calendar.create"
      : schema.pattern?.startsWith("^(\\*|device:") ? "*"
      : schema.pattern?.includes("memory/") ? "memory/2020-01-01.md"
      : schema.pattern?.startsWith("^r_") ? "r_value" : "value";
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

test("gate access words are strict owner-only exact grants, separate from approval rules", () => {
  const list = wordContract("service:gate", "access.list")!;
  const grant = wordContract("service:gate", "access.grant")!;
  const revoke = wordContract("service:gate", "access.revoke")!;
  assert.equal(list.audience, "owner");
  assert.equal(grant.risk, "structure");
  assert.equal(revoke.risk, "structure");
  const input = { member: "agent:main", scope: "device:phone/calendar.create" };
  assert.ok(matchesSchema(grant.input_schema!, input));
  for (const bad of [
    { ...input, scope: "*" }, { ...input, scope: "device:phone/*" },
    { ...input, scope: "device:phone/calendar.create", expires_at: Date.now() + 1 },
    { ...input, member: "person:owner" }, { ...input, member: "agent:main/other" },
    { ...input, scope: "device:phone/calendar.create/other" },
  ]) assert.ok(!matchesSchema(grant.input_schema!, bad), JSON.stringify(bad));
  assert.ok(matchesSchema(grant.result_schema!, { id: "acl-1", ...input, expires_at: 1 }));
  assert.ok(!matchesSchema(grant.result_schema!, { id: "acl-1", ...input, expires_at: 1, token: "secret" }));
  assert.ok(matchesSchema(list.result_schema!, { items: [
    { id: "old", member: "agent:main", scope: "*", source: "legacy", created_at: 1, expires_at: 2, revoked_at: 3 },
    { id: "new", ...input, source: "current", created_at: 1, expires_at: 2 },
  ] }));
  assert.ok(!matchesSchema(list.result_schema!, { items: [{ id: "bad", ...input, source: "approval", created_at: 1, expires_at: 2 }] }));
  assert.ok(!matchesSchema(list.input_schema!, { limit: 101 }));
  assert.ok(!matchesSchema(revoke.input_schema!, { id: "old", member: "agent:main" }));
  assert.ok(!matchesSchema(revoke.result_schema!, { revoked: true, token: "secret" }));
});

test("clock.fired is a closed, clock-only outbound occurrence record", () => {
  const contract = wordContract("service:clock", "clock.fired")!;
  assert.equal(contract.kind, "event");
  assert.equal(contract.direction, "out");
  assert.equal(contract.result_schema, undefined);
  assert.equal(wordContract("service:other", "clock.fired"), undefined);
  const schema = contract.input_schema!;
  const valid: ClockFiredBodyV2 = { timer_id: "tmr_1", scheduled_at: 1_727_740_800_000, outcome: "dispatched", request_id: "m_1" };
  assert.ok(matchesSchema(schema, valid));
  assert.ok(matchesSchema(schema, { timer_id: valid.timer_id, scheduled_at: valid.scheduled_at, outcome: "skipped", reason: "paused" }));
  for (const invalid of [
    { ...valid, timer_id: "" }, { ...valid, scheduled_at: -1 }, { ...valid, scheduled_at: 1.5 },
    { ...valid, scheduled_at: Number.MAX_SAFE_INTEGER + 1 }, { ...valid, scheduled_at: Infinity },
    { ...valid, outcome: "completed" }, { ...valid, request_id: "" }, { ...valid, extra: true },
    { scheduled_at: valid.scheduled_at, outcome: "failed" }, null,
  ]) assert.ok(!matchesSchema(schema, invalid), `invalid clock event accepted: ${JSON.stringify(invalid)}`);
});

test("post deliver distinguishes dedupe suppression from a real presentation", () => {
  const contract = wordContract("service:post", "deliver")!;
  const result = contract.result_schema!;
  for (const channel of ["inapp", "notification", "held", "dropped"])
    assert.ok(matchesSchema(result, { channel }));
  for (const invalid of [{ channel: "silent" }, { channel: "dropped", delivered: true }, {}, null])
    assert.ok(!matchesSchema(result, invalid));
});

test("proactive say fixes a bounded opaque dedupe key at acceptance, without adding it to replies", () => {
  const say = wordContract("person:owner", "say")!.input_schema!;
  const deliver = wordContract("service:post", "deliver")!.input_schema!;
  const base = { text: "synthetic offer", kind: "offer" };
  for (const kind of ["offer", "heads_up"])
    assert.ok(matchesSchema(say, { ...base, kind, dedupe_key: "job:2026-10-01_1" }));
  for (const kind of ["reply", "due"]) {
    assert.ok(matchesSchema(say, { ...base, kind }));
    assert.ok(!matchesSchema(say, { ...base, kind, dedupe_key: "job:1" }));
  }
  assert.ok(matchesSchema(say, base));
  assert.ok(matchesSchema(deliver, { message_id: "m_1", kind: "offer", dedupe_key: "job:1" }));
  for (const key of ["", ".leading", "-leading", "white space", "slash/key", "é", "a".repeat(129)]) {
    assert.ok(!matchesSchema(say, { ...base, dedupe_key: key }), `invalid say key ${key}`);
    assert.ok(!matchesSchema(deliver, { message_id: "m_1", kind: "offer", dedupe_key: key }), `invalid deliver key ${key}`);
  }
  assert.ok(matchesSchema(say, { ...base, dedupe_key: "a".repeat(128) }));
});

test("pause and resume require exact management bodies and truthful paused results", () => {
  const pause = wordContract("service:admin", "pause")!;
  const resume = wordContract("service:admin", "resume")!;
  assert.equal(pause.kind, "request");
  assert.equal(resume.kind, "request");
  assert.equal(pause.audience, "owner");
  assert.equal(resume.audience, "owner");
  for (const body of [{}, { by: "m_owner_1" }]) assert.ok(matchesSchema(pause.input_schema!, body));
  for (const body of [{ by: "" }, { by: 4 }, { by: "m_1", extra: true }, { confirmed: true }, null])
    assert.ok(!matchesSchema(pause.input_schema!, body), `invalid pause input ${JSON.stringify(body)}`);
  assert.ok(matchesSchema(resume.input_schema!, { confirmed: true }));
  for (const body of [{}, { confirmed: false }, { confirmed: "true" }, { confirmed: true, by: "m_1" }, null])
    assert.ok(!matchesSchema(resume.input_schema!, body), `invalid resume input ${JSON.stringify(body)}`);
  assert.ok(matchesSchema(pause.result_schema!, { paused: true }));
  assert.ok(matchesSchema(resume.result_schema!, { paused: false }));
  for (const result of [{ paused: false }, {}, { paused: true, accepted: true }]) assert.ok(!matchesSchema(pause.result_schema!, result));
  for (const result of [{ paused: true }, {}, { paused: false, accepted: true }]) assert.ok(!matchesSchema(resume.result_schema!, result));
});

test("plugin operation accepts only installed bundle and plugin switches", () => {
  const schema = wordContract("service:admin", "plugins.op")!.input_schema!;
  for (const body of [{ op: "enable", name: "sample" }, { op: "disable", name: "sample" },
    { op: "plugin", id: "include:sample", enabled: true }]) assert.ok(matchesSchema(schema, body));
  for (const body of [{ op: "install", spec: "package" }, { op: "remove", name: "sample" },
    { op: "plugin", id: "sample", enabled: "true" }, { op: "enable", name: "sample", spec: "secret" }])
    assert.ok(!matchesSchema(schema, body));
});

test("post.delivery is a closed service-only visibility event, not an external notification", () => {
  const contract = wordContract("service:post", "post.delivery")!;
  assert.equal(contract.kind, "event");
  assert.equal(contract.direction, "out");
  assert.equal(wordContract("agent:main", "post.delivery"), undefined);
  const body: PostDeliveryBodyV2 = { message_id: "m_offer", state: "released" };
  for (const state of ["held", "released", "dropped"])
    assert.ok(matchesSchema(contract.input_schema!, { ...body, state }));
  for (const invalid of [{ ...body, state: "notification" }, { ...body, message_id: "" }, { ...body, host_sent: true }, null])
    assert.ok(!matchesSchema(contract.input_schema!, invalid));
});

test("bounded post snapshot has unique IDs and real-event versions below its watermark", () => {
  assert.equal(POST_DELIVERY_SNAPSHOT_EVENT, "post.delivery.snapshot");
  const valid: PostDeliverySnapshotV2 = { at_seq: 25, items: [{ message_id: "m_old", state: "released", version_seq: 24 }] };
  assert.deepEqual(postDeliverySnapshotErrors(valid), []);
  assert.deepEqual(postDeliverySnapshotErrors({ at_seq: 0, items: [] }), []);
  for (const invalid of [
    { ...valid, at_seq: -1 }, { ...valid, at_seq: 1.5 }, { ...valid, at_seq: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, items: [{ ...valid.items[0], version_seq: 26 }] },
    { ...valid, items: [{ ...valid.items[0], version_seq: 0 }] },
    { ...valid, items: [valid.items[0], { message_id: "m_old", state: "held", version_seq: 20 }] },
    { ...valid, items: Array.from({ length: 1001 }, (_, i) => ({ message_id: `m_${i}`, state: "held", version_seq: 1 })) },
    { ...valid, items: [{ ...valid.items[0], state: "notification" }] },
    { ...valid, items: [{ ...valid.items[0], seq: 24 }] },
    { ...valid, id: 25 }, null,
  ]) assert.notDeepEqual(postDeliverySnapshotErrors(invalid), [], `invalid snapshot accepted: ${JSON.stringify(invalid)}`);
});

test("L025 summary is explicitly not an original Message or send envelope", () => {
  assert.equal(MESSAGE_SUMMARY_EVENT, "message.summary");
  const summary: MessageSummaryV2 = { seq: 7, id: "m_7", ts: 123, from: "person:owner", to: "agent:main", kind: "request", word: "say", summary: true,
    body_summary: { text: "", attachments: [{ name: "photo.png", mime_type: "image/png" }] },
    inline_attachments: [{ index: 0, name: "photo.png", mime_type: "image/png", size: 5 }] };
  assert.ok(isMessageSummaryV2(summary));
  assert.equal(Object.hasOwn(summary, "body"), false);
  const original: Message = { seq: 7, id: "m_7", ts: 123, from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "", attachments: [{ name: "photo.png", mime_type: "image/png", data: "aGVsbG8=" }] } };
  assert.ok(!isMessageSummaryV2(original));
  for (const invalid of [
    { ...summary, body: original.body }, { ...summary, summary: false }, { ...summary, seq: 1.5 },
    { ...summary, inline_attachments: [{ ...summary.inline_attachments![0], data: "aGVsbG8=" }] },
    { ...summary, inline_attachments: [summary.inline_attachments![0], summary.inline_attachments![0]] },
    { ...summary, body_summary: original.body }, { ...summary, body_summary: { text: "", attachments: [{ data: "aGVsbG8=" }] } },
  ]) assert.ok(!isMessageSummaryV2(invalid));
  const query: StreamQueryV2 = { summary: true, after: 1, limit: 200, follow: false };
  assert.equal(query.summary, true);
});

test("L025 scope and end controls are not ledger cursor frames", () => {
  assert.equal(AUTH_SCOPE_EVENT, "auth.scope");
  assert.equal(STREAM_PAGE_END_EVENT, "stream.page_end");
  assert.equal(STREAM_ERROR_EVENT, "stream.error");
  const scope = { auth_scope: `v1_${"z".repeat(43)}` };
  assert.ok(isAuthScopeControlV2(scope));
  for (const invalid of [{}, { ...scope, auth_scope: "token" }, { ...scope, id: 10 }, null]) assert.ok(!isAuthScopeControlV2(invalid));
  assert.ok(isStreamPageEndV2({ has_more: false, first_seq: null, last_seq: null }));
  assert.ok(isStreamPageEndV2({ has_more: true, first_seq: 2, last_seq: 5 }));
  for (const invalid of [
    { has_more: false, first_seq: null, last_seq: 1 }, { has_more: true, first_seq: null, last_seq: null }, { has_more: true, first_seq: 5, last_seq: 2 },
    { has_more: true, first_seq: 0, last_seq: 1 }, { has_more: "false", first_seq: null, last_seq: null },
    { has_more: false, first_seq: null, last_seq: null, id: 9 },
  ]) assert.ok(!isStreamPageEndV2(invalid));
  assert.ok(isStreamErrorV2({ code: "too_large" }));
  assert.ok(isStreamErrorV2({ code: "failed" }));
  for (const invalid of [{ code: "ok" }, { code: "failed", message: "private details" }, { code: "too_large", id: 3 }, null]) assert.ok(!isStreamErrorV2(invalid));
});

test("L025 summary budget counts UTF-8 bytes and emits a continuous page prefix", () => {
  assert.equal(STREAM_SUMMARY_PAGE_BYTES, 4 * 1024 * 1024);
  assert.equal(STREAM_SUMMARY_ITEM_BYTES, 1024 * 1024);
  assert.equal(STREAM_RAW_PAGE_BYTES, 32 * 1024 * 1024);
  assert.ok(STREAM_SUMMARY_CONTROL_RESERVE_BYTES >= 128 * 1024);
  const budget = new SummaryPageBudgetV2();
  assert.deepEqual(budget.end(false), { has_more: false, first_seq: null, last_seq: null });
  assert.equal(budget.tryInclude(10, 900_000), true);
  assert.equal(budget.tryInclude(9, 900_000), true);
  assert.equal(budget.tryInclude(8, 900_000), true);
  assert.equal(budget.tryInclude(7, 900_000), true);
  assert.equal(budget.tryInclude(6, 900_000), false);
  assert.equal(budget.tryInclude(5, 1), false, "a smaller row after the excluded row cannot create a hole");
  assert.throws(() => budget.end(false), RangeError);
  assert.deepEqual(budget.end(true), { has_more: true, first_seq: 7, last_seq: 10 });
  assert.throws(() => budget.tryInclude(6, STREAM_SUMMARY_ITEM_BYTES + 1), RangeError);
  assert.throws(() => budget.tryInclude(0, 1), TypeError);
  assert.throws(() => budget.tryInclude(6, -1), TypeError);
  const empty = new SummaryPageBudgetV2();
  assert.throws(() => empty.end(true), RangeError);
  const multibyte = new SummaryPageBudgetV2();
  const encoded = new TextEncoder().encode("event: message.summary\\ndata: 你好\\n\\n");
  assert.equal(multibyte.tryInclude(1, encoded.byteLength), true);
  assert.deepEqual(multibyte.end(false), { has_more: false, first_seq: 1, last_seq: 1 });
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

test("screen registration requires a server-minted credential scope, not just a tab token", () => {
  const frame = { screen: "screen:tab_1", token: "a".repeat(32), label: "Computer browser", auth_scope: `v1_${"b".repeat(43)}` };
  assert.ok(isScreenRegistration(frame));
  assert.ok(isScreenRegistration({ ...frame, local_management: true }));
  assert.ok(isScreenRegistration({ ...frame, local_management: false }));
  assert.notEqual((frame as typeof frame & { local_management?: boolean }).local_management, true, "older registration never grants a management display hint");
  for (const bad of [
    { ...frame, auth_scope: undefined },
    { ...frame, auth_scope: "token:secret" },
    { ...frame, auth_scope: "v1_short" },
    { ...frame, screen: "person:owner" },
    { ...frame, token: "tiny" },
    { ...frame, label: "" },
    { ...frame, local_management: "true" },
    { ...frame, local_management: 1 },
    { ...frame, local_management: null },
  ]) assert.ok(!isScreenRegistration(bad));
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
