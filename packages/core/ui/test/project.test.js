import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fold, foldPostSnapshot, initialView } from "../js/project.js";

const cases = JSON.parse(readFileSync(new URL("./fixtures/segments.json", import.meta.url), "utf8"));
const message = (entry, i) => ({ seq: i + 1, id: `m${i + 1}`, ts: (i + 1) * 1000, to: null, ...entry });
const replay = (entries) => entries.reduce((state, entry, i) => fold(state, message(entry, i)), initialView());
const at = (value, path) => path.split(".").reduce((part, key) => part?.[key], value);

test(`${cases.length} recorded segments agree with their projection snapshots`, async (t) => {
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
  const ack = message({ from: "agent:main", to: "person:owner", kind: "response", word: "say", reply_to: "answer", body: { ok: true, result: { accepted: true } } }, 4);
  const state = fold(fold(fold(initialView(), option), ack), card);
  assert.equal(state.conversation.find((bubble) => bubble.id === "card").locked, true);
  assert.deepEqual(state.conversation.map((bubble) => bubble.id), ["card", "answer"]);
  const askAnswer = message({ from: "person:owner", to: "agent:main", kind: "response", word: "ask", reply_to: "ask", body: { ok: true, result: { choice: "once" } } }, 6);
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

test("gate and background messages to the owner project, with ask replies to their original asker", () => {
  const state = replay([
    { id: "gate-ask", from: "service:gate", to: "person:owner", kind: "request", word: "ask", body: { title: "Allow?", options: [{ id: "deny", label: "No" }], expires_at: 9999 } },
    { from: "person:owner", to: "service:gate", kind: "response", word: "ask", reply_to: "gate-ask", body: { ok: true, result: { choice: "deny" } } },
    { from: "service:work", to: "person:owner", kind: "request", word: "say", body: { text: "Reminder" } },
    { from: "service:work", to: "person:owner", kind: "request", word: "show", body: { card: { type: "link", url: "https://example.invalid", title: "Source" } } },
  ]);
  assert.equal(state.asks[0].state, "answered");
  assert.equal(state.asks[0].choice, "deny");
  assert.equal(state.conversation[1].from, "service:work");
  assert.equal(state.conversation[2].card.type, "link");
  const forged = fold(replay([{ id: "ask", from: "service:work", to: "person:owner", kind: "request", word: "ask", body: { title: "Approve", options: [{ id: "once", label: "Once" }], expires_at: 9999 } }]), { seq: 2, id: "forged", ts: 2, from: "device:phone", to: "service:work", kind: "response", word: "ask", reply_to: "ask", body: { ok: true, result: { choice: "once" } } });
  assert.equal(forged.asks[0].state, "pending");
});

test("ask settles only with the first valid response addressed to its original asker", () => {
  const ask = { id: "a", from: "service:gate", to: "person:owner", kind: "request", word: "ask", body: { title: "Allow?", options: [{ id: "once", label: "Once" }, { id: "deny", label: "No" }], expires_at: 9999 } };
  const answer = (id, to, choice, ok = true) => ({ id, from: "person:owner", to, kind: "response", word: "ask", reply_to: "a", body: ok ? { ok: true, result: { choice } } : { ok: false, error: { code: "bad_request", message: "rejected" } } });
  const state = replay([ask, answer("wrong-target", "service:work", "once"), answer("wrong-choice", "service:gate", "always"), answer("error", "service:gate", "once", false), answer("valid", "service:gate", "deny"), answer("duplicate", "service:gate", "once")]);
  assert.equal(state.asks[0].state, "answered");
  assert.equal(state.asks[0].choice, "deny");
  assert.equal(replay([ask, answer("wrong-target", "service:work", "once")]).asks[0].state, "pending");
  assert.equal(replay([ask, answer("wrong-choice", "service:gate", "always")]).asks[0].state, "pending");
});

test("option card locks only after a valid accepted answer; first accepted option wins", () => {
  const card = { id: "card", from: "agent:main", to: "person:owner", kind: "request", word: "show", body: { card: { type: "options", options: [{ id: "yes", text: "Yes" }, { id: "no", text: "No" }] } } };
  const choose = (id, option_id, text) => ({ id, from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text, in_reply_to: "card", option_id } });
  const result = (id, reply_to, accepted) => ({ id, from: "agent:main", to: "person:owner", kind: "response", word: "say", reply_to, body: accepted ? { ok: true, result: { accepted: true } } : { ok: false, error: { code: "bad_request", message: "invalid option" } } });
  const selected = (events) => replay(events).conversation.find((bubble) => bubble.id === "card");
  assert.equal(selected([card, choose("bad", "other", "Other"), result("bad-ack", "bad", true)]).locked, false);
  assert.equal(selected([card, choose("wrong-text", "yes", "No"), result("text-ack", "wrong-text", true)]).locked, false);
  assert.equal(selected([card, choose("rejected", "yes", "Yes"), result("reject-ack", "rejected", false)]).locked, false);
  assert.equal(selected([card, choose("pending", "yes", "Yes")]).locked, false);
  const valid = selected([card, choose("bad", "other", "Other"), result("bad-ack", "bad", true), choose("first", "yes", "Yes"), result("first-ack", "first", true), choose("second", "no", "No"), result("second-ack", "second", true)]);
  assert.equal(valid.locked, true);
  assert.equal(valid.selected_option_id, "yes");
  const customCard = { ...card, body: { card: { ...card.body.card, allow_custom: true } } };
  assert.equal(selected([customCard, choose("custom", "__custom", "Maybe"), result("custom-ack", "custom", true)]).selected_option_id, "__custom");
  assert.equal(selected([card, choose("custom", "__custom", "Maybe"), result("custom-ack", "custom", true)]).locked, false);
});

test("only allowlisted attachment references survive; inline bytes and unknown fields do not", () => {
  const state = replay([{ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "File", attachments: [
    { workspace: "home", path: "inbox/photo.png", name: "photo.png", mime_type: "image/png", size: 12, data: "SENSITIVE_BASE64", internal: "secret" },
    { workspace: "home", path: "../escape", name: "bad", mime_type: "text/plain", size: 1 },
    { name: "inline.txt", mime_type: "text/plain", data: "INLINE_ONLY" },
  ] } }]);
  assert.deepEqual(state.conversation[0].attachments, [{ workspace: "home", path: "inbox/photo.png", name: "photo.png", mime_type: "image/png", size: 12 }]);
  assert.equal(JSON.stringify(state).includes("SENSITIVE_BASE64"), false);
  assert.equal(JSON.stringify(state).includes("INLINE_ONLY"), false);
});

test("attachment-only owner say projects index and metadata, never inline bytes", () => {
  const state = replay([{ id: "m_inline", from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "", attachments: [
    { name: "one.txt", mime_type: "text/plain", data: "eA==" },
    { name: "bad.txt", mime_type: "text/plain", data: "not-base64!" },
    { name: "two.txt", mime_type: "text/plain", data: "eXk=" },
  ] } }]);
  assert.deepEqual(state.conversation[0].attachments, [
    { source: "inline", message_id: "m_inline", index: 0, name: "one.txt", mime_type: "text/plain", size: 1 },
    { source: "inline", message_id: "m_inline", index: 2, name: "two.txt", mime_type: "text/plain", size: 2 },
  ]);
  assert.equal(state.conversation[0].text, "");
  assert.equal(JSON.stringify(state).includes("eXk="), false);
});

test("valid migrated chat is read-only and cannot lock a current option card", () => {
  const state = replay([
    { id: "card", from: "agent:main", to: "person:owner", kind: "request", word: "show", body: { card: { type: "options", options: [{ id: "yes", text: "Yes" }] } } },
    { id: "old-answer", from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "Yes", in_reply_to: "card", option_id: "yes", legacy: { seq: 2, workspace: "old-home", member: "person:owner" } } },
    { from: "agent:main", to: "person:owner", kind: "response", word: "say", reply_to: "old-answer", body: { ok: true, result: { accepted: true } } },
  ]);
  assert.equal(state.conversation[0].locked, false);
  assert.equal(state.conversation[1].readOnly, true);
  assert.equal(state.conversation[1].legacy.member, "person:owner");
  assert.equal(state.presence.state, "unknown");
});

test("migration stamp must match source row and historical conversation route", () => {
  const row = { from: "timer:old", to: "agent:helper", kind: "request", word: "say", body: { text: "Wake", legacy: { seq: 1, workspace: "old", member: "timer:old" } } };
  assert.equal(replay([row]).conversation[0].side, "inbound");
  for (const bad of [
    { ...row, body: { ...row.body, legacy: { ...row.body.legacy, seq: 99 } } },
    { ...row, body: { ...row.body, legacy: { ...row.body.legacy, member: "person:owner" } } },
    { ...row, to: "device:phone" },
    { ...row, body: { text: "Wake" } },
  ]) assert.equal(replay([bad]).conversation.length, 0);
});

test("four migrated owner attachment bubbles keep only safe references", () => {
  const entries = Array.from({ length: 4 }, (_, i) => ({ from: "person:owner", to: "agent:helper", kind: "request", word: "say", body: { text: `File ${i}`, legacy: { seq: i + 1, workspace: "old", member: "person:owner" }, attachments: [{ workspace: "old", path: `inbox/${i}.png`, name: `${i}.png`, mime_type: "image/png", size: i + 1, data: "raw-should-not-project" }] } }));
  const state = replay(entries);
  assert.equal(state.conversation.length, 4);
  assert.equal(state.conversation.filter((bubble) => bubble.attachments.length === 1).length, 4);
  assert.equal(JSON.stringify(state).includes("raw-should-not-project"), false);
});

test("new offer is invisible before an authoritative release; stale history cannot roll it back", () => {
  const offer = { seq: 1, id: "m_offer", ts: 1, from: "agent:main", to: "person:owner", kind: "request", word: "say", body: { text: "Tomorrow only", kind: "offer" } };
  let state = fold(initialView(), offer);
  assert.equal(state.conversation.length, 0);
  state = foldPostSnapshot(state, { at_seq: 10, items: [{ message_id: offer.id, state: "released", version_seq: 8 }] });
  assert.deepEqual(state.conversation.map((item) => item.text), ["Tomorrow only"]);
  state = foldPostSnapshot(state, { at_seq: 7, items: [{ message_id: offer.id, state: "held", version_seq: 7 }] });
  assert.equal(state.conversation.length, 1);
  state = fold(state, { seq: 11, id: "m_drop", ts: 11, from: "service:post", to: "person:owner", kind: "event", word: "post.delivery", body: { message_id: offer.id, state: "dropped" } });
  assert.equal(state.conversation.length, 0);
  state = foldPostSnapshot(state, { at_seq: 12, items: [{ message_id: offer.id, state: "released", version_seq: 12 }] });
  assert.equal(state.conversation.length, 0);
});

test("release before say, late page, and migrated legacy text preserve the visibility boundary", () => {
  const release = { seq: 2, id: "m_release", ts: 2, from: "service:post", to: "person:owner", kind: "event", word: "post.delivery", body: { message_id: "m_late", state: "released" } };
  let state = fold(initialView(), release);
  assert.equal(state.conversation.length, 0);
  state = fold(state, { seq: 1, id: "m_late", ts: 1, from: "agent:main", to: "person:owner", kind: "request", word: "say", body: { text: "Now visible", kind: "heads_up" } });
  assert.deepEqual(state.conversation.map((item) => item.text), ["Now visible"]);
  const legacy = { seq: 3, id: "m_legacy", ts: 3, from: "agent:retired", to: "person:owner", kind: "request", word: "say", body: { text: "Old offer", kind: "offer", legacy: { seq: 3, workspace: "old", member: "agent:retired" } } };
  state = fold(state, legacy);
  assert.deepEqual(state.conversation.map((item) => item.text), ["Now visible", "Old offer"]);
  assert.equal(foldPostSnapshot(state, { at_seq: 3, items: [{ message_id: "m_late", state: "released", version_seq: 4 }] }), state);
});
