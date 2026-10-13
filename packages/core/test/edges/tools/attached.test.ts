/**
 * The tool surface for an app attached through a computer (the Codex App): no turn of its own, never woken, the same
 * rules as an agent's call, and only the tools it needs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ATTACHED_TOOLS } from "../../../src/edges/tools";
import { deferred, fakeRouter, MAIN, OPEN_POLICY, startRig, PHONE } from "./helpers";

const CODEX = "agent:codex-studio";
const signal = () => new AbortController().signal;
const dataOf = (r: { structuredContent?: unknown }) => r.structuredContent as any;

async function rig(router = fakeRouter()) {
  const r = await startRig({ router, attached: { has: (id) => id === CODEX } });
  r.policies.set(CODEX, OPEN_POLICY);
  return r;
}

test("an attached caller is shown the meta tools, the receipts and Ash's agents, and the note about answers", async () => {
  const r = await rig();
  const tools = r.edge.attachedTools(CODEX);
  assert.deepEqual(tools.map((t) => t.name).sort(), [...ATTACHED_TOOLS].sort());
  const call = tools.find((t) => t.name === "capability_call")!;
  assert.match(call.description, /pending\.get/, "it is told how the owner's answer reaches it");
  assert.deepEqual(r.edge.attachedTools(MAIN), [], "an agent of Ash is not an attached caller");
  assert.deepEqual(r.edge.attachedTools("agent:nobody"), []);
});

test("a call needs no turn of the agents module: it runs through the router as the attached agent, in the turn the app's session names", async () => {
  const r = await rig();
  r.turns.delete(CODEX);
  const out = await r.edge.callAttached(CODEX, "codex-s1", "capability_call", { member: "service:clock", word: "list", body: {} }, signal());
  assert.notEqual(out.isError, true);
  const sent = r.router.sent.at(-1)!;
  assert.deepEqual([sent.msg.to, sent.msg.word], ["service:clock", "list"]);
  assert.equal(sent.caller.member, CODEX);
  assert.equal(sent.caller.via, "agent");
  assert.equal(sent.caller.turn, "codex-s1");
});

test("capability_list and describe answer from the same catalog as for an agent; agent_ask and agent_tell reach service:agents", async () => {
  const r = await rig(fakeRouter((msg) => ({ ok: true, result: { data: msg.word === "ask" ? { answer: "好" } : { sent: true } } })));
  const listed = await r.edge.callAttached(CODEX, "codex-s1", "capability_list", {}, signal());
  assert.ok(dataOf(listed).members.some((m: any) => m.id === "service:agents"));
  const described = await r.edge.callAttached(CODEX, "codex-s1", "capability_describe", { member: "service:clock", word: "set" }, signal());
  assert.equal(dataOf(described).capabilities[0].word, "set");
  const ask = await r.edge.callAttached(CODEX, "codex-s1", "agent_ask", { agent: "agent:main", text: "?" }, signal());
  assert.equal(dataOf(ask).answer, "好");
  const tell = await r.edge.callAttached(CODEX, "codex-s1", "agent_tell", { agent: "agent:main", text: "fyi" }, signal());
  assert.equal(dataOf(tell).sent, true);
  assert.deepEqual(r.router.sent.map((s) => `${s.msg.to}/${s.msg.word}`), ["service:agents/ask", "service:agents/tell"]);
  assert.ok(r.router.sent.every((s) => s.caller.member === CODEX && s.caller.turn === "codex-s1"));
});

test("only the attached tools, and only for an attached caller", async () => {
  const r = await rig();
  const other = await r.edge.callAttached(CODEX, "codex-s1", "human_say", { text: "hi" }, signal());
  assert.equal(other.isError, true);
  assert.match(JSON.stringify(other.content), /no tool human_say/);
  const agent = await r.edge.callAttached(MAIN, "t", "capability_list", {}, signal());
  assert.equal(agent.isError, true);
  assert.match(JSON.stringify(agent.content), /not an attached caller/);
  assert.equal(r.router.sent.length, 0);
});

test("the agent's policy holds: a declaration that limits its words limits what the catalog shows and what the call may reach", async () => {
  const r = await rig();
  r.policies.set(CODEX, { words: ["service:clock/list"] });
  const listed = await r.edge.callAttached(CODEX, "codex-s1", "capability_list", {}, signal());
  assert.deepEqual(dataOf(listed).members.map((m: any) => m.id).sort(), ["service:clock", "service:gate"], "the clock word, and the gate's pending words that every agent has");
});

test("a call that takes long gives a receipt; await_result waits for it for the attached caller (no turn to end), and no wake is ever sent", async () => {
  const slow = deferred<void>();
  const router = fakeRouter(async (msg) => { if (msg.word === "list") await slow.promise; return { ok: true, result: { data: { done: msg.word } } }; });
  const r = await rig(router);
  const first = await r.edge.callAttached(CODEX, "codex-s1", "capability_call", { member: "service:clock", word: "list", body: {}, wait: false }, signal());
  const id = dataOf(first).request_id;
  assert.equal(dataOf(first).status, "accepted");
  const waiting = r.edge.callAttached(CODEX, "codex-s1", "await_result", { request_id: id, timeout_ms: 300 }, signal());
  setTimeout(() => slow.resolve(), 40);
  const got = await waiting;
  assert.equal(dataOf(got).done, "list", "await_result held on until the call was done");
  const pending = await r.edge.callAttached(CODEX, "codex-s1", "list_pending", {}, signal());
  assert.deepEqual(dataOf(pending).pending, []);

  // A result nobody fetched is not told to anyone: there is no one to wake.
  const lost = await r.edge.callAttached(CODEX, "codex-s1", "capability_call", { member: "service:clock", word: "set", body: {}, wait: false }, signal());
  assert.ok(dataOf(lost).request_id || dataOf(lost).done);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(router.sent.some((s) => s.msg.word === "wake"), false);
});

test("the phone is reachable like any other member", async () => {
  const r = await rig();
  const out = await r.edge.callAttached(CODEX, "codex-s1", "capability_call", { member: PHONE, word: "location.get", body: {} }, signal());
  assert.equal(r.router.sent.at(-1)!.msg.to, PHONE);
  assert.ok(out);
});
