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

async function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "ash-gate-router-")), "ash.db");
  const ledger = await Ledger.open(file);
  const router = new WorldRouter(ledger, async () => true);
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
  const gate = ledger.gateCase(sent.id);
  assert.ok(gate);
  const ask = ledger.byId(gate.askId);
  assert.equal(ask?.word, "ask");
  return { sent, gate, ask: ask! };
}

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

test("owner can inspect gate history; local revoke never recursively asks, remote revoke is zero-ledger denied", async () => {
  const { ledger, router } = await setup();
  try {
    new WorldMembers(router).register(new GateMember(ledger, router));
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
