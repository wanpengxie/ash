import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fold, initialView } from "../js/project.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/segments.json", import.meta.url), "utf8"));
const message = (entry, i) => ({ seq: i + 1, id: `m${i + 1}`, ts: (i + 1) * 1000, to: null, ...entry });
const replay = (entries) => entries.reduce((state, entry, i) => fold(state, message(entry, i)), initialView());
const at = (value, path) => path.split(".").reduce((part, key) => part?.[key], value);

test("26 recorded segments agree with their projection snapshots", async (t) => {
  assert.ok(cases.length >= 20);
  for (const fixture of cases) await t.test(fixture.name, () => {
    const state = replay(fixture.events);
    for (const [path, expected] of Object.entries(fixture.expect)) assert.deepEqual(at(state, path), expected, `${fixture.name}: ${path}`);
  });
});

test("fold is pure and idempotent across duplicate delivery and history replay", () => {
  assert.deepEqual(Object.keys(initialView()).sort(), ["asks", "conversation", "held", "presence", "self", "timers", "turns"]);
  const owner = message({ id: "q", from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "hi" } }, 0);
  const first = fold(initialView(), owner);
  const again = fold(first, owner);
  assert.equal(again, first);
  assert.equal(initialView().conversation.length, 0);
  assert.equal(first.conversation.length, 1);
  const read = message({ from: "agent:main", kind: "event", word: "read", body: { ids: ["q"], turn: "t_x" } }, 2);
  const olderReceived = message({ from: "agent:main", kind: "event", word: "received", body: { ids: ["q"] } }, 1);
  const outOfOrder = fold(fold(first, read), olderReceived);
  assert.equal(outOfOrder.conversation[0].delivery, "read");
  assert.deepEqual(outOfOrder._records.map((r) => r.seq), [1, 2, 3]);
  assert.equal(first.conversation[0].delivery, "sent");
});

test("history pagination can insert older card and ask after their answers", () => {
  const option = message({ id: "answer", from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "Yes", in_reply_to: "card", option_id: "yes" } }, 2);
  const card = message({ id: "card", from: "agent:main", to: "person:owner", kind: "request", word: "show", body: { card: { type: "options", options: [{ id: "yes", text: "Yes" }] } } }, 1);
  const state = fold(fold(initialView(), option), card);
  assert.equal(state.conversation.find((bubble) => bubble.id === "card").locked, true);
  assert.deepEqual(state.conversation.map((bubble) => bubble.id), ["card", "answer"]);
  const askAnswer = message({ from: "person:owner", to: "agent:main", kind: "response", word: "ask", reply_to: "ask", body: { ok: true, result: { choice: "once" } } }, 4);
  const ask = message({ id: "ask", from: "agent:main", to: "person:owner", kind: "request", word: "ask", body: { title: "May I?", options: [{ id: "once", label: "Once" }], expires_at: 9000 } }, 3);
  const result = fold(fold(state, askAnswer), ask);
  assert.equal(result.asks[0].state, "answered");
});

test("only trusted owner-directed delivery snapshots set held, newest seq wins", () => {
  const changed = (seq, held, from = "service:post", to = "person:owner") => ({ seq, id: `h${seq}`, ts: seq, from, to, kind: "event", word: "post.changed", body: { held } });
  let state = fold(initialView(), changed(4, 4));
  state = fold(state, changed(2, 2));
  assert.equal(state.held, 4);
  state = fold(state, changed(5, 0));
  assert.equal(state.held, 0);
  for (const invalid of [changed(6, -1), changed(7, 8, "device:phone"), changed(8, 9, "service:post", "agent:main"), { ...changed(9, 3), body: { held: 1.5 } }]) state = fold(state, invalid);
  assert.equal(state.held, 0);
  assert.equal(fold(state, changed(5, 100)), state);
  const deliveryResponse = { seq: 10, id: "delivery", ts: 10, from: "service:post", to: "agent:main", kind: "response", word: "deliver", body: { ok: true, result: { channel: "held" } } };
  assert.equal(fold(state, deliveryResponse).held, 0);
});

test("control frames, unknown words, and raw tool data never enter the view", () => {
  let state = initialView();
  state = fold(state, { event: "screen.registered", data: { screen: "screen:one", token: "secret", label: "Phone" } });
  assert.deepEqual(state, initialView());
  state = fold(state, message({ from: "device:phone", to: "agent:main", kind: "response", word: "shell.run", body: { ok: true, result: { args: "secret command" } } }, 0));
  assert.equal(JSON.stringify(state).includes("secret"), false);
  state = fold(state, message({ from: "agent:main", kind: "event", word: "turn.start", body: { turn: "__proto__", ids: [] } }, 1));
  assert.deepEqual(state.turns, {});
});

test("clock set/cancel responses do not synthesize a timer without list snapshot", () => {
  const state = replay([
    { from: "service:clock", kind: "response", word: "set", body: { ok: true, result: { id: "t1", next: 20 } } },
    { from: "service:clock", kind: "response", word: "cancel", body: { ok: true, result: { cancelled: true } } },
  ]);
  assert.deepEqual(state.timers, []);
});
