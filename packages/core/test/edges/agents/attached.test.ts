/** The caller that stands for the Codex App on a computer (edges/agents/attached.ts). */
import assert from "node:assert/strict";
import test from "node:test";
import { AttachedCallers, attachedTurn } from "../../../src/edges/agents/attached";
import { isAgentId } from "../../../../sdk/src/ids";

test("one caller per computer, named for it, made on first use, with the default declaration", () => {
  const callers = new AttachedCallers();
  const a = callers.declare("hand-aaaa1111", "MacBook Pro");
  assert.equal(a.id, "agent:codex-macbook-pro");
  assert.equal(a.name, "MacBook Pro 上的 Codex App");
  assert.ok(isAgentId(a.id));
  assert.equal(callers.declare("hand-aaaa1111", "MacBook Pro"), a, "the second call finds it");
  assert.deepEqual(callers.policyOf(a.id), {}, "no tools and no words: what a declaration without limits gives");
  assert.equal(callers.policyOf("agent:main"), null, "an agent of Ash is not attached");
  assert.equal(callers.has(a.id), true);
});

test("two computers with one name are told apart; a name with no letters still gives a valid id; long names are cut", () => {
  const callers = new AttachedCallers();
  const one = callers.declare("hand-aaaa1111", "书房");
  const two = callers.declare("hand-bbbb2222", "书房");
  assert.notEqual(one.id, two.id);
  const same = callers.declare("hand-cccc3333", "Studio");
  const other = callers.declare("hand-dddd4444", "Studio");
  assert.notEqual(same.id, other.id);
  for (const caller of [one, two, same, other, callers.declare("hand-eeee5555", "A very long computer name that goes on and on and on")]) assert.ok(isAgentId(caller.id), caller.id);
});

test("when the computer's connection ends the caller goes, and is made again on the next call", () => {
  const callers = new AttachedCallers();
  const first = callers.declare("hand-1", "Studio");
  callers.drop("hand-1");
  assert.equal(callers.has(first.id), false);
  assert.equal(callers.policyOf(first.id), null);
  assert.equal(callers.declare("hand-1", "Studio").id, first.id);
});

test("the turn the ledger records names the app's session, cleaned, or is one fixed id", () => {
  assert.equal(attachedTurn("019f-aa_bb"), "codex-019f-aa_bb");
  assert.equal(attachedTurn("a b/../c"), "codex-ab..c");
  assert.equal(attachedTurn(undefined), "codex-session");
  assert.equal(attachedTurn(42), "codex-session");
  assert.equal(attachedTurn("x".repeat(200)).length, "codex-".length + 64);
});
