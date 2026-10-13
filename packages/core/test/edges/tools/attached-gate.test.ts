/**
 * The Codex App through the real router and gate: it is judged as an agent with the default
 * declaration, so a read runs, a word that asks the owner still goes to the gate, and nothing is done for it by its identity.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createToolsEdge } from "../../../src/edges/tools";
import { AttachedCallers } from "../../../src/edges/agents/attached";
import { DEVICE, fake, flush, word, world } from "../../kernel/router/world";

const signal = () => new AbortController().signal;
const dataOf = (r: { structuredContent?: unknown }) => r.structuredContent as any;

async function setup() {
  const w = world();
  const callers = new AttachedCallers();
  const codex = callers.declare("hand-1", "Studio");
  const phone = fake(DEVICE, [word(DEVICE, "location.get"), word(DEVICE, "apps.open", { effect: "act", risk: "outward" })]);
  w.registry.add(phone);
  const edge = createToolsEdge({
    router: w.router, registry: w.registry, ledger: w.ledger, now: () => w.clock.now,
    agentPolicy: (id) => callers.policyOf(id), attached: callers,
    currentTurn: () => null, turnActive: () => false, fastPathMs: 60, maxWaitMs: 300, settleMs: 40,
  });
  const call = (name: string, args: Record<string, unknown>) => edge.callAttached(codex.id, "codex-s1", name, args, signal());
  return { w, codex, phone, edge, call };
}

test("a read runs at once; the call is the attached agent's own in the ledger", async () => {
  const { w, codex, phone, call } = await setup();
  const out = await call("capability_call", { member: DEVICE, word: "location.get", body: {} });
  assert.notEqual(out.isError, true);
  assert.equal(phone.calls.length, 1);
  assert.equal(phone.calls[0]!.ctx.caller.member, codex.id);
  const row = w.ledger.db().prepare("SELECT \"from\" AS who, turn FROM messages WHERE \"to\" = ? AND word = 'location.get'").get(DEVICE) as { who: string; turn: string } | undefined;
  assert.deepEqual(row && { ...row }, { who: codex.id, turn: "codex-s1" }, "the ledger names the computer's Codex and its session");
});

test("a word that asks the owner goes to the gate: a receipt with a pending id, a card, nothing run; once approved it is redeemed once", async () => {
  const { w, phone, call } = await setup();
  const first = await call("capability_call", { member: DEVICE, word: "apps.open", body: {}, purpose: "打开笔记" });
  assert.equal(dataOf(first).status, "waiting_owner");
  const pendingId = dataOf(first).pending_id;
  assert.ok(pendingId);
  await flush();
  assert.equal(phone.calls.length, 0, "nothing runs before the owner answers");
  assert.equal(w.owner.cards.length, 1, "the owner is asked");

  const before = await call("capability_call", { member: "service:gate", word: "pending.get", body: { id: pendingId } });
  assert.equal(dataOf(before).state, "waiting");
  w.owner.answer("once");
  await flush();
  const answered = await call("capability_call", { member: "service:gate", word: "pending.get", body: { id: pendingId } });
  assert.equal(dataOf(answered).answer.choice, "once", "the answer is there to read: it does not come as a message to an app");
  const redeemed = await call("capability_call", { member: "service:gate", word: "pending.redeem", body: { id: pendingId } });
  assert.notEqual(redeemed.isError, true, JSON.stringify(redeemed.content));
  assert.equal(phone.calls.length, 1);
  const again = await call("capability_call", { member: "service:gate", word: "pending.redeem", body: { id: pendingId } });
  assert.equal(again.isError, true, "a redeem is good once");
  assert.equal(phone.calls.length, 1);
});

test("the owner says no: redeeming does nothing", async () => {
  const { w, phone, call } = await setup();
  const first = await call("capability_call", { member: DEVICE, word: "apps.open", body: {} });
  const pendingId = dataOf(first).pending_id;
  await flush();
  w.owner.answer("deny");
  await flush();
  const redeemed = await call("capability_call", { member: "service:gate", word: "pending.redeem", body: { id: pendingId } });
  assert.equal(redeemed.isError, true);
  assert.equal(phone.calls.length, 0);
});

test("pending requests are the attached caller's own: another one cannot read or redeem them", async () => {
  const { w, call } = await setup();
  const first = await call("capability_call", { member: DEVICE, word: "apps.open", body: {} });
  const pendingId = dataOf(first).pending_id;
  const callers = new AttachedCallers();
  const other = callers.declare("hand-2", "Laptop");
  const edge2 = createToolsEdge({ router: w.router, registry: w.registry, ledger: w.ledger, now: () => w.clock.now, agentPolicy: (id) => callers.policyOf(id), attached: callers, currentTurn: () => null, turnActive: () => false, fastPathMs: 60, maxWaitMs: 300, settleMs: 40 });
  const stolen = await edge2.callAttached(other.id, "codex-s2", "capability_call", { member: "service:gate", word: "pending.get", body: { id: pendingId } }, signal());
  assert.equal(stolen.isError, true);
});
