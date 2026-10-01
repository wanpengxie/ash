import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { wordContract } from "../../../sdk/src/words";
import { GateMember } from "../../src/members/gate";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { RouterError, WorldRouter, type TrustedRouteContext } from "../../src/world/router";

const agent: TrustedRouteContext = { transport: "agent", member: "agent:main", transportPrincipal: "agent:main",
  local: true, remote: false, ownerProxy: false };
const screen: TrustedRouteContext = { transport: "web_ui", member: "person:owner", transportPrincipal: "owner-principal",
  local: true, remote: false, ownerProxy: true, screenId: "screen:approved", screenLabel: "Test screen" };

async function setup(authorize: () => boolean | Promise<boolean> = () => true) {
  const file = join(mkdtempSync(join(tmpdir(), "ash-gate-router-")), "ash.db");
  const ledger = await Ledger.open(file);
  const router = new WorldRouter(ledger, async () => authorize());
  router.register({ member: "person:owner", spec: wordContract("person:owner", "ask")!, handle: () => {} });
  let effects = 0;
  router.register({ member: "device:fake", spec: { word: "run", kind: "request", risk: "outward", description: "Synthetic effect",
    input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false },
    result_schema: { type: "object", properties: { done: { type: "boolean" } }, required: ["done"], additionalProperties: false } },
    handle: () => { effects++; return { ok: true, result: { done: true } }; } });
  router.enableDurableGate();
  return { ledger, router, effects: () => effects };
}

async function accepted(router: WorldRouter, ledger: Ledger) {
  const sent = await router.send(screen, { to: "device:fake", kind: "request", word: "run", body: { n: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  const gate = ledger.gateCase(sent.id);
  assert.ok(gate);
  const ask = ledger.byId(gate.askId);
  assert.equal(ask?.word, "ask");
  return { sent, gate, ask: ask! };
}

test("internal DSH ask uses the accepted durable deadline across clock ticks", async (t) => {
  const { ledger, router } = await setup();
  let tick = Date.now();
  t.mock.method(Date, "now", () => ++tick);
  try {
    const work = router.requestInternalApproval({ sessionId: "session-550e8400-e29b-41d4-a716-446655440000",
      turn: "t_gateclock", callId: "call_gateclock", toolName: "ash_describe", contractFingerprint: "a".repeat(64),
      signal: new AbortController().signal, stillValid: () => true });
    await new Promise((resolve) => setImmediate(resolve));
    const parent = ledger.list().find((message) => message.word === "internal.approval" && message.kind === "request")!;
    const tracked = ledger.trackedRequests().find((item) => item.message.id === parent.id)!;
    const gate = ledger.gateCase(parent.id);
    assert.ok(gate, "a later clock tick must not reject the ask");
    assert.equal(gate.expiresAt, tracked.deadlineAt);
    await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: gate.askId,
      body: { ok: true, result: { choice: "once" } } });
    assert.equal(await work, "allowed-once");
    assert.equal(ledger.responseTo(parent.id)?.body.ok, true);
  } finally { router.cancel(ledger.trackedRequests().map((item) => item.message.id)); ledger.close(); }
});

test("risky requests persist one total deadline: default 600s, explicit 90s and 900s", async (t) => {
  const { ledger, router } = await setup();
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (const [word, timeout_ms] of [["short", 90_000], ["long", 900_000]] as const)
    router.register({ member: "device:fake", spec: { word, kind: "request", risk: "outward", timeout_ms,
      description: "Synthetic timed effect", input_schema: { type: "object", additionalProperties: false } }, handle: () => assert.fail("unapproved effect") });
  try {
    for (const [word, total, ask] of [["run", 600_000, 600_000], ["short", 90_000, 90_000], ["long", 900_000, 600_000]] as const) {
      const sent = await router.send(screen, { to: "device:fake", kind: "request", word, body: word === "run" ? { n: 1 } : {} });
      await new Promise((resolve) => setImmediate(resolve));
      const tracked = ledger.trackedRequests().find((item) => item.message.id === sent.id)!;
      assert.equal(tracked.deadlineAt, now + total);
      assert.equal(ledger.gateCase(sent.id)?.expiresAt, now + ask);
    }
  } finally { router.cancel(ledger.trackedRequests().map((item) => item.message.id)); ledger.close(); }
});

test("durable gate waits for owner choice then runs one synthetic effect", async () => {
  const { ledger, router, effects } = await setup();
  try {
    const { sent, ask } = await accepted(router, ledger);
    assert.equal(effects(), 0);
    const answer = await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: ask.id,
      body: { ok: true, result: { choice: "once" } }, client_id: "answer-one" });
    assert.equal(ledger.byId(answer.id)?.origin?.screen, "screen:approved");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(effects(), 1);
    assert.equal(ledger.responseTo(sent.id)?.body.ok, true);
    assert.equal(ledger.list().filter((item) => item.word === "gate.passed").length, 1);
    const retry = await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: ask.id,
      body: { ok: true, result: { choice: "once" } }, client_id: "answer-one" });
    assert.equal(retry.id, answer.id);
    assert.equal(effects(), 1);
  } finally { router.cancel(ledger.trackedRequests().map((item) => item.message.id)); ledger.close(); }
});

test("fresh agent has no implicit device ACL, even though a gate could ask the owner", async () => {
  const { ledger, router, effects } = await setup();
  try {
    const before = ledger.lastSeq();
    await assert.rejects(router.send(agent, { to: "device:fake", kind: "request", word: "run", body: { n: 1 } }),
      (error) => error instanceof RouterError && error.code === "forbidden");
    assert.equal(ledger.lastSeq(), before);
    assert.equal(effects(), 0);
  } finally { ledger.close(); }
});

test("recovery fails closed on a tracked owner ask without its original gate case", async () => {
  const { ledger, router } = await setup();
  try {
    const ask = ledger.append({ from: "service:gate", to: "person:owner", kind: "request", word: "ask",
      body: { title: "Orphaned question", detail: "No parent case", expires_at: Date.now() + 30_000,
        options: [{ id: "once", label: "Allow once" }, { id: "deny", label: "Deny" }],
        source: { word: "run", to: "device:fake", body_preview: "Synthetic action" } } }, undefined,
    { deadlineAt: Date.now() + 30_000, context: { member: "service:gate", local: true, remote: false,
      ownerProxy: false, transportPrincipal: "service:gate" } }).message;
    await router.recover();
    assert.equal(ledger.responseTo(ask.id)?.body.ok, false);
    assert.equal(ledger.trackedRequests().some((item) => item.message.id === ask.id), false);
    assert.equal(ledger.list().filter((item) => item.word === "gate.asked").length, 0);
  } finally { ledger.close(); }
});

test("cancellation withdraws the ask; a late approval cannot execute", async () => {
  const { ledger, router, effects } = await setup();
  try {
    const { sent, ask } = await accepted(router, ledger);
    assert.equal(router.cancel([sent.id]).length, 1);
    assert.equal(ledger.responseTo(ask.id)?.body.ok, false);
    await assert.rejects(router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: ask.id,
      body: { ok: true, result: { choice: "once" } } }), (error) => error instanceof RouterError && error.code === "bad_request");
    assert.equal(effects(), 0);
    assert.equal(ledger.responseTo(sent.id)?.body.ok, false);
  } finally { ledger.close(); }
});

test("permission revoked while owner is answering cannot execute the approved effect", async () => {
  let authorized = true;
  const { ledger, router, effects } = await setup(() => authorized);
  try {
    const { sent, ask } = await accepted(router, ledger);
    authorized = false;
    await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: ask.id,
      body: { ok: true, result: { choice: "once" } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(effects(), 0);
    assert.equal((ledger.responseTo(sent.id)?.body.error as { code?: string } | undefined)?.code, "forbidden");
    assert.equal(ledger.list().filter((item) => item.word === "gate.passed").length, 1); // answer fact, not effect success
  } finally { ledger.close(); }
});

test("owner can inspect gate history; local revoke never recursively asks, remote revoke is zero-ledger denied", async () => {
  const { ledger, router } = await setup();
  try {
    const members = new WorldMembers(router);
    members.register(new GateMember(ledger, router, members));
    const { ask } = await accepted(router, ledger);
    await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: ask.id,
      body: { ok: true, result: { choice: "deny" } } });
    const listed = await router.send(screen, { to: "service:gate", kind: "request", word: "history", body: {}, wait: true });
    assert.equal((listed.reply?.body.result as { items: { decision: string }[] }).items[0]?.decision, "deny");
    const prior = ledger.lastSeq();
    const remote = { ...screen, local: false, remote: true, screenId: "screen:remote" };
    await assert.rejects(router.send(agent, { to: "service:gate", kind: "request", word: "history", body: {} }),
      (error) => error instanceof RouterError && error.code === "forbidden");
    await assert.rejects(router.send(remote, { to: "service:gate", kind: "request", word: "rules.revoke", body: { id: "missing" } }),
      (error) => error instanceof RouterError && error.code === "forbidden");
    assert.equal(ledger.lastSeq(), prior);
    const revoked = await router.send(screen, { to: "service:gate", kind: "request", word: "rules.revoke", body: { id: "missing" }, wait: true });
    assert.deepEqual(revoked.reply?.body, { ok: true, result: { revoked: false } });
    assert.equal(ledger.list().filter((item) => item.word === "ask").length, 2); // one request + one response, no recursive ask
  } finally { ledger.close(); }
});

test("reviewed isolated message recipient alone may create and reuse a 30-day exact rule", async () => {
  const { ledger, router } = await setup();
  let effects = 0;
  const schema = { type: "object" as const, properties: { recipient_id: { type: "string" as const, format: "uuid" },
    text: { type: "string" as const, minLength: 1 } }, required: ["recipient_id", "text"], additionalProperties: false };
  router.registerDevice("device:isolated", { name: "message.send", description: "Synthetic message", label: "Synthetic message",
    risk: "outward", input_schema: schema }, () => { effects++; return { ok: true, result: {} }; });
  router.enableDurableGate({ reviewedIsolatedFakeMessageSend: true });
  const send = (recipient_id: string, text: string, ctx = screen) => router.send(ctx, { to: "device:isolated", kind: "request",
    word: "message.send", body: { recipient_id, text } });
  const recipient = "550e8400-e29b-41d4-a716-446655440000";
  try {
    const first = await send(recipient.toUpperCase(), "hello");
    await new Promise((resolve) => setImmediate(resolve));
    const firstCase = ledger.gateCase(first.id)!;
    assert.deepEqual((ledger.byId(firstCase.askId)?.body.options as { id: string }[]).map((item) => item.id), ["once", "always", "deny"]);
    await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: firstCase.askId,
      body: { ok: true, result: { choice: "always" } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(effects, 1);
    const rules = ledger.gateRulesPage().rules;
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.object_pattern, recipient);
    assert.equal(rules[0]?.subject, "person:owner");
    const second = await send(recipient, "different text");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(effects, 2);
    assert.equal(ledger.gateCase(second.id), null);
    assert.equal(ledger.list().filter((item) => item.word === "gate.passed" && item.body.by === "rule").length, 1);
    const other = await send("550e8400-e29b-41d4-a716-446655440001", "hello");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(ledger.gateCase(other.id));
    assert.equal(effects, 2);
    router.cancel([other.id]);
    const otherPrincipal = await send(recipient, "hello", { ...screen, transportPrincipal: "different-owner", screenId: "screen:other" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(ledger.gateCase(otherPrincipal.id));
    assert.equal(effects, 2);
    router.cancel([otherPrincipal.id]);
    router.replaceDeviceBatch("device:isolated", [{ name: "message.send", description: "Changed synthetic manifest",
      label: "Synthetic message", risk: "outward", input_schema: schema }], () => { effects++; return { ok: true, result: {} }; });
    const changed = await send(recipient, "hello");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(ledger.gateCase(changed.id));
    assert.equal(effects, 2);
    router.cancel([changed.id]);
    assert.equal(ledger.revokeGateRule(rules[0]!.id), true);
    assert.equal(ledger.revokeGateRule(rules[0]!.id), false);
  } finally { router.cancel(ledger.trackedRequests().map((item) => item.message.id)); ledger.close(); }
});

test("matching real-looking device word never inherits the isolated fake always extractor", async () => {
  const { ledger, router } = await setup();
  const schema = { type: "object" as const, properties: { recipient_id: { type: "string" as const, format: "uuid" },
    text: { type: "string" as const, minLength: 1 } }, required: ["recipient_id", "text"], additionalProperties: false };
  let effects = 0;
  router.registerDevice("device:phone", { name: "message.send", description: "Synthetic phone-like word", label: "Message",
    risk: "outward", input_schema: schema }, () => { effects++; return { ok: true, result: {} }; });
  router.enableDurableGate({ reviewedIsolatedFakeMessageSend: true });
  try {
    const sent = await router.send(screen, { to: "device:phone", kind: "request", word: "message.send",
      body: { recipient_id: "550e8400-e29b-41d4-a716-446655440000", text: "hello" } });
    await new Promise((resolve) => setImmediate(resolve));
    const askId = ledger.gateCase(sent.id)!.askId;
    assert.deepEqual((ledger.byId(askId)?.body.options as { id: string }[]).map((item) => item.id), ["once", "deny"]);
    await assert.rejects(router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: askId,
      body: { ok: true, result: { choice: "always" } } }), (error) => error instanceof RouterError && error.code === "bad_request");
    assert.equal(effects, 0);
    assert.equal(ledger.gateRulesPage().rules.length, 0);
    router.cancel([sent.id]);
  } finally { ledger.close(); }
});
