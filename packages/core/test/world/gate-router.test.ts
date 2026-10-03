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
  const sent = await router.send(agent, { to: "device:fake", kind: "request", word: "run", body: { n: 1 } });
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
      const sent = await router.send(agent, { to: "device:fake", kind: "request", word, body: word === "run" ? { n: 1 } : {} });
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

test("an agent needs no device access grant: its risky call gets the ordinary card, other senders are still refused", async () => {
  const { ledger, router, effects } = await setup();
  try {
    assert.equal(ledger.gateAccessPage().items.length, 0);
    const other = { ...agent, member: "agent:other", transportPrincipal: "agent:other" };
    const sent = await router.send(other, { to: "device:fake", kind: "request", word: "run", body: { n: 1 } });
    await new Promise((resolve) => setImmediate(resolve));
    const gate = ledger.gateCase(sent.id)!;
    const card = ledger.byId(gate.askId)!;
    assert.equal(card.body.title, "需要你确认");
    assert.deepEqual((card.body.options as { id: string }[]).map((option) => option.id), ["once", "always", "deny"]);
    await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: gate.askId,
      body: { ok: true, result: { choice: "once" } } });
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(effects(), 1);
    assert.equal(ledger.responseTo(sent.id)?.body.ok, true);
    // Nothing was granted on the way: the access list stays empty.
    assert.equal(ledger.gateAccessPage().items.length, 0);
    const before = ledger.lastSeq();
    const worker = { ...agent, member: "worker:memory", transportPrincipal: "worker:memory" };
    await assert.rejects(router.send(worker, { to: "device:fake", kind: "request", word: "run", body: { n: 1 } }),
      (error) => error instanceof RouterError && error.code === "forbidden");
    assert.equal(ledger.lastSeq(), before);
  } finally { router.cancel(ledger.trackedRequests().map((item) => item.message.id)); ledger.close(); }
});

test("trusted paired remote owner acts directly but cannot administer local device access", async () => {
  const { ledger, router, effects } = await setup();
  const pairedRemote: TrustedRouteContext = { transport: "web_ui", member: "person:owner", transportPrincipal: "paired:synthetic",
    pairedDeviceId: "paired:synthetic", local: false, remote: true, ownerProxy: true,
    screenId: "screen:remote-synthetic", screenLabel: "Synthetic remote" };
  try {
    const members = new WorldMembers(router);
    members.register(new GateMember(ledger, router, members));
    const before = ledger.lastSeq();
    await assert.rejects(router.send(pairedRemote, { to: "service:gate", kind: "request", word: "access.grant",
      body: { member: "agent:main", scope: "device:fake/run" } }), (error) => error instanceof RouterError && error.code === "forbidden");
    assert.equal(ledger.lastSeq(), before);
    const sent = await router.send(pairedRemote, { to: "device:fake", kind: "request", word: "run", body: { n: 1 } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ledger.gateCase(sent.id), null);
    assert.equal(effects(), 1);
  } finally { router.cancel(ledger.trackedRequests().map((item) => item.message.id)); ledger.close(); }
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
  router.enableDurableGate();
  const send = (recipient_id: string, text: string, ctx = agent) => router.send(ctx, { to: "device:isolated", kind: "request",
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
    assert.equal(rules[0]?.subject, "agent:main");
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
    const otherPrincipal = await send(recipient, "hello", { ...agent, transportPrincipal: "different-agent" });
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

test("a real device recipient can use the same exact action-and-object rule", async () => {
  const { ledger, router } = await setup();
  const schema = { type: "object" as const, properties: { recipient_id: { type: "string" as const, format: "uuid" },
    text: { type: "string" as const, minLength: 1 } }, required: ["recipient_id", "text"], additionalProperties: false };
  let effects = 0;
  router.registerDevice("device:phone", { name: "message.send", description: "Synthetic phone-like word", label: "Message",
    risk: "outward", input_schema: schema }, () => { effects++; return { ok: true, result: {} }; });
  router.enableDurableGate();
  try {
    const sent = await router.send(agent, { to: "device:phone", kind: "request", word: "message.send",
      body: { recipient_id: "550e8400-e29b-41d4-a716-446655440000", text: "hello" } });
    await new Promise((resolve) => setImmediate(resolve));
    const askId = ledger.gateCase(sent.id)!.askId;
    assert.deepEqual((ledger.byId(askId)?.body.options as { id: string }[]).map((item) => item.id), ["once", "always", "deny"]);
    assert.equal(effects, 0);
    await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: askId,
      body: { ok: true, result: { choice: "always" } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(effects, 1);
    const repeated = await router.send(agent, { to: "device:phone", kind: "request", word: "message.send",
      body: { recipient_id: "550e8400-e29b-41d4-a716-446655440000", text: "different text" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ledger.gateCase(repeated.id), null);
    assert.equal(effects, 2);
    assert.equal(ledger.list().filter((item) => item.word === "gate.passed" && item.body.by === "rule").length, 1);
  } finally { ledger.close(); }
});

test("without a target, 'always' covers the capability for this agent; it asks again after expiry or revocation", async (t) => {
  const { ledger, router } = await setup();
  let effects = 0;
  router.registerDevice("device:phone", { name: "file.delete", description: "Delete a file", label: "Delete file",
    risk: "outward", effect: "write", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  () => { effects++; return { ok: true, result: {} }; });
  const send = (path: string, ctx = agent) => router.send(ctx, { to: "device:phone", kind: "request", word: "file.delete", body: { path } });
  try {
    const first = await send("/tmp/first");
    await new Promise((resolve) => setImmediate(resolve));
    const askId = ledger.gateCase(first.id)!.askId;
    const options = ledger.byId(askId)?.body.options as { id: string; label: string }[];
    assert.deepEqual(options.map((item) => item.id), ["once", "always", "deny"]);
    assert.equal(options[1]!.label, "30 天内都允许「Delete file」");
    assert.match(String(ledger.byId(askId)?.body.detail), /\/tmp\/first/);
    await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: askId,
      body: { ok: true, result: { choice: "always" } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(effects, 1);
    const rule = ledger.gateRulesPage().rules[0]!;
    assert.equal(rule.object_pattern, "*");
    const different = await send("/tmp/other");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ledger.gateCase(different.id), null, "the capability rule covers another file too");
    assert.equal(effects, 2);
    const otherAgent = await send("/tmp/first", { ...agent, member: "agent:other", transportPrincipal: "agent:other" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(ledger.gateCase(otherAgent.id), "a rule belongs to one agent");
    router.cancel([otherAgent.id]);
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 31 * 24 * 60 * 60_000);
    const expired = await send("/tmp/first");
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(ledger.gateCase(expired.id));
    assert.equal(effects, 2);
    router.cancel([expired.id]);
    assert.equal(ledger.revokeGateRule(rule.id), true);
  } finally { router.cancel(ledger.trackedRequests().map((item) => item.message.id)); ledger.close(); }
});

test("a shell approval shows the command and every other argument, marks a cut, and never offers always", async () => {
  const { ledger, router } = await setup();
  router.registerDevice("device:phone", { name: "shell.run", description: "Run a shell command", label: "在手机上执行命令",
    risk: "structure", effect: "execute", input_schema: { type: "object", properties: { command: { type: "string" }, stdin: { type: "string" }, cwd: { type: "string" } },
      required: ["command"], additionalProperties: false } }, () => ({ ok: true, result: {} }));
  const detailOf = async (body: Record<string, unknown>) => {
    const sent = await router.send(agent, { to: "device:phone", kind: "request", word: "shell.run", body });
    await new Promise((resolve) => setImmediate(resolve));
    const askId = ledger.gateCase(sent.id)!.askId;
    assert.deepEqual((ledger.byId(askId)?.body.options as { id: string }[]).map((item) => item.id), ["once", "deny"]);
    const detail = String(ledger.byId(askId)?.body.detail);
    await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: askId, body: { ok: true, result: { choice: "deny" } } });
    return detail;
  };
  assert.equal(await detailOf({ command: "printf ok" }), "在手机上执行命令：printf ok");
  const hidden = await detailOf({ command: "sh", stdin: "rm -rf /sdcard/DCIM", cwd: "/sdcard" });
  assert.match(hidden, /rm -rf \/sdcard\/DCIM/);
  assert.match(hidden, /"cwd":"\/sdcard"/);
  assert.match(await detailOf({ command: `${" ".repeat(600)}rm x` }), /…（共 604 字/);
});

test("a browser approval reads as one line, and 'always' covers that site and no other", async () => {
  const { ledger, router } = await setup();
  let effects = 0;
  const schema = { type: "object", properties: { ref: { type: "integer" }, site: { type: "string" }, label: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } },
    required: ["ref", "site", "label"], additionalProperties: false };
  for (const name of ["browser.click", "browser.type"])
    router.registerDevice("device:phone", { name, description: name, label: name === "browser.click" ? "在网页上点击" : "在网页上输入", risk: "outward", input_schema: schema },
      () => { effects++; return { ok: true, result: {} }; });
  const send = (word: string, body: Record<string, unknown>) => router.send(agent, { to: "device:phone", kind: "request", word, body });
  try {
    const first = await send("browser.click", { ref: 3, site: "www.Example.com", label: "登录" });
    await new Promise((resolve) => setImmediate(resolve));
    const askId = ledger.gateCase(first.id)!.askId;
    assert.equal(ledger.byId(askId)?.body.detail, "在 www.Example.com 点击「登录」");
    assert.deepEqual((ledger.byId(askId)?.body.options as { id: string }[]).map((item) => item.id), ["once", "always", "deny"]);
    assert.equal((ledger.byId(askId)?.body.options as { id: string; label: string }[])[1].label, "30 天内允许在这个网站上这样操作");
    await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: askId, body: { ok: true, result: { choice: "always" } } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(effects, 1);
    // Another control on the same site (different ref and label) passes by the rule.
    const same = await send("browser.click", { ref: 9, site: "example.com", label: "下一页" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(!ledger.gateCase(same.id), "the rule passed it without a new question");
    assert.equal(effects, 2, "same site, other control");
    // A different site asks again.
    const other = await send("browser.click", { ref: 1, site: "evil.example.org", label: "登录" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ledger.gateCase(other.id)?.decision, "waiting");
    assert.equal(effects, 2);
    // A button that publishes or deletes is not covered by "this site": it asks again even on the allowed site.
    const publish = await send("browser.click", { ref: 5, site: "example.com", label: "Post" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ledger.gateCase(publish.id)?.decision, "waiting");
    assert.equal(effects, 2);
    const remove = await send("browser.click", { ref: 6, site: "example.com", label: "删除这条" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ledger.gateCase(remove.id)?.decision, "waiting");
    for (const pending of [publish, remove]) await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: ledger.gateCase(pending.id)!.askId, body: { ok: true, result: { choice: "deny" } } });
    // Typing is its own word: the click rule does not cover it, and its card shows what would be typed.
    const typed = await send("browser.type", { ref: 2, site: "example.com", label: "搜索", text: "天气\n预报", submit: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ledger.byId(ledger.gateCase(typed.id)!.askId)?.body.detail, "在 example.com 的「搜索」里输入：天气 预报，然后提交");
    assert.equal(effects, 2);
    for (const pending of [other, typed]) await router.send(screen, { to: "service:gate", kind: "response", word: "ask", reply_to: ledger.gateCase(pending.id)!.askId, body: { ok: true, result: { choice: "deny" } } });
  } finally { ledger.close(); }
});
