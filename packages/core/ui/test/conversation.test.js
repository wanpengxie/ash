import assert from "node:assert/strict";
import test from "node:test";
import { appendConversation, workspaceFileUrl } from "../js/conversation.js";
import { fold, initialView } from "../js/project.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; }
  append(child) { this.children.push(child); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value || "") + this.children.map((child) => child.textContent).join(""); }
}

function draw(entries, options) {
  globalThis.document = { createElement: (tag) => new Node(tag), createTextNode: (value) => { const node = new Node("#text"); node.textContent = value; return node; } };
  try { const fragment = new Node("fragment"); appendConversation(fragment, entries, options); return fragment; }
  finally { delete globalThis.document; }
}

test("gate approval originals are folded and shown in a closed plain-text disclosure, including decided cards", () => {
  const original = "x".repeat(65000) + "\nTAIL <script>not HTML</script>\t  spaces";
  const message = { id: "ask-original", seq: 1, ts: 1, from: "service:gate", to: "person:owner", kind: "request", word: "ask",
    body: { title: "确认", detail: "摘要", expires_at: Date.now() + 60_000, options: [{ id: "once", label: "允许这一次" }],
      source: { word: "shell.run", to: "device:phone", body_preview: "摘要", body_full: original } } };
  const view = fold(initialView(), message);
  assert.equal(view.asks[0].original, original);
  for (const state of ["pending", "answered", "expired", "closed"]) {
    const rendered = draw([{ ...view.conversation[0], ask: { ...view.asks[0], state } }]);
    const disclosure = rendered.children[0].children.find((node) => node.tag === "details");
    assert.ok(disclosure);
    assert.notEqual(disclosure.open, true);
    assert.equal(disclosure.children[0].tag, "summary");
    assert.equal(disclosure.children[0].textContent, "查看原文");
    assert.equal(disclosure.children[1].tag, "pre");
    assert.equal(disclosure.children[1].textContent, original);
    assert.equal(disclosure.children[1].children.length, 0, "markup is text, never executable HTML");
  }
  const ordinary = fold(initialView(), { ...message, from: "agent:main" });
  assert.equal(ordinary.asks[0].original, undefined, "only a gate-authored snapshot is accepted");
  const legacy = fold(initialView(), { ...message, body: { ...message.body, source: { body_preview: "summary only" } } });
  assert.equal(legacy.asks[0].original, undefined, "old summaries are not relabeled as original text");
});

test("conversation shows receipt stages, grouped agent burst, and reactions on the correct bubble", () => {
  const fragment = draw([
    { id: "m1", seq: 1, type: "say", side: "owner", text: "first", delivery: "sent", reactions: [] },
    { id: "m2", seq: 2, type: "say", side: "owner", text: "second", delivery: "delivered", reactions: [] },
    { id: "m3", seq: 3, type: "say", side: "owner", text: "third", delivery: "read", reactions: [{ id: "r1", emoji: "👍" }] },
    { id: "m4", seq: 4, type: "say", side: "agent", text: "one", group: "t_1", reactions: [] },
    { id: "m5", seq: 5, type: "say", side: "agent", text: "two", group: "t_1", reactions: [] },
    { id: "m6", seq: 6, type: "say", side: "agent", text: "other", group: "t_2", reactions: [] },
  ]);
  const bubbles = fragment.children.filter((node) => node.className?.startsWith("msg "));
  const statuses = fragment.children.filter((node) => node.className === "delivery r").map((node) => node.textContent);
  assert.deepEqual(statuses, ["发送中", "已送达", "已读"]);
  assert.deepEqual(bubbles.map((node) => node.dataset.seq), ["1", "2", "3", "4", "5", "6"]);
  assert.equal(bubbles[2].textContent, "third👍");
  assert.equal(bubbles[1].textContent, "second");
  assert.match(bubbles[3].className, /group-first/);
  assert.match(bubbles[4].className, /group-last/);
  assert.match(bubbles[5].className, /group-single/);
  assert.equal(fragment.children.some((node) => node.tag === "button"), false);
});

test("three first-meeting replies are visible as three conversation bubbles", () => {
  let view = initialView();
  for (let i = 1; i <= 3; i++) view = fold(view, { id: `first-${i}`, seq: i, ts: i,
    from: "agent:main", to: "person:owner", kind: "request", word: "say",
    body: { text: `FIRST_MEETING_${i}`, kind: "reply" } });
  const rendered = draw(view.conversation);
  assert.deepEqual(rendered.children.filter((item) => item.className?.startsWith("msg "))
    .map((item) => item.textContent), ["FIRST_MEETING_1", "FIRST_MEETING_2", "FIRST_MEETING_3"]);
});

test("legacy text remains inert and only bounded workspace references get download links", () => {
  assert.equal(workspaceFileUrl({ workspace: "home", path: "inbox/a b.png" }), "/api/workspaces/home/files?path=inbox%2Fa%20b.png");
  for (const ref of [
    { workspace: "home", path: "../secret" }, { workspace: "home", path: "/secret" },
    { workspace: "home", path: "a\\b" }, { workspace: "home", path: "a//b" },
    { workspace: "home?x", path: "a" }, { workspace: "home", path: "a/./b" },
  ]) assert.equal(workspaceFileUrl(ref), null);
  const fragment = draw([{ id: "old", seq: 7, type: "say", side: "inbound", from: "agent:old", text: "<script>", legacy: { workspace: "old", member: "agent:old" }, attachments: [{ workspace: "home", path: "inbox/a b.png", name: "picture.png" }, { workspace: "home", path: "../nope", name: "bad" }] }]);
  const bubble = fragment.children.find((node) => node.className?.startsWith("msg "));
  assert.equal(bubble.dataset.readonly, "true");
  assert.match(bubble.textContent, /<script>/);
  assert.equal(bubble.children[0].children.length, 1);
  assert.equal(bubble.children[0].children[0].href, "/api/workspaces/home/files?path=inbox%2Fa%20b.png");
});

test("option card sends one selected action, locks locally, and shows authoritative cross-screen lock", async () => {
  const selected = [];
  const entry = { id: "card-1", type: "card", card: { type: "options", prompt: "Choose", options: [{ id: "yes", text: "Yes" }] }, locked: false };
  let card = draw([entry], { onSelect: async (item, option) => selected.push([item.id, option.id, option.text]) });
  const button = card.children[0].children.find((node) => node.tag === "button");
  await button.listeners.click();
  await button.listeners.click();
  assert.deepEqual(selected, [["card-1", "yes", "Yes"]]);
  card = draw([{ ...entry, locked: true }], { onSelect: async () => selected.push("unexpected") });
  assert.equal(card.children[0].children.find((node) => node.tag === "button").disabled, true);
});

test("custom option uses the reserved id only when the card allows it", async () => {
  const selected = [];
  const entry = { id: "card-2", type: "card", card: { type: "options", options: [{ id: "yes", text: "Yes" }], allow_custom: true }, locked: false };
  const card = draw([entry], { onSelect: async (_item, option) => selected.push(option) });
  const input = card.children[0].children.find((node) => node.tag === "input");
  input.value = "  Another answer  ";
  const send = card.children[0].children.filter((node) => node.tag === "button").at(-1);
  await send.listeners.click();
  assert.deepEqual(selected, [{ id: "__custom", text: "Another answer" }]);
  assert.equal(draw([{ ...entry, card: { ...entry.card, allow_custom: false } }]).children[0].children.some((node) => node.tag === "input"), false);
});

test("file, image, and link cards open safe references and approval buttons expire", async () => {
  const files = draw([{ type: "card", card: { type: "file", workspace: "home", path: "a.pdf", name: "a.pdf" } },
    { type: "card", card: { type: "image", workspace: "home", path: "a.png", alt: "a" } },
    { type: "card", card: { type: "link", url: "https://example.com/a", title: "Example" } }]);
  assert.equal(files.children[0].children[0].href, "/api/workspaces/home/files?path=a.pdf");
  assert.equal(files.children[1].children[0].src, "/api/workspaces/home/files?path=a.png");
  assert.equal(files.children[2].children[0].href, "https://example.com/a");
  const ask = { id: "ask-1", seq: 1, from: "service:gate", title: "Confirm", detail: "Do it?", state: "pending",
    expires_at: Date.now() + 60_000, options: ["once", "always", "deny"].map((id) => ({ id, label: id })) };
  const choices = [];
  let rendered = draw([{ type: "ask", ask }], { onAnswerAsk: async (_ask, choice) => choices.push(choice) });
  // Title, detail and the choices each sit on their own line.
  assert.deepEqual(rendered.children[0].children.map((node) => node.className), ["ask-title", "ask-detail", "ask-expiry", "ask-actions"]);
  const buttons = rendered.children[0].children.find((node) => node.className === "ask-actions").children.filter((node) => node.tag === "button");
  assert.equal(buttons.length, 3);
  await buttons[1].listeners.click();
  assert.deepEqual(choices, ["always"]);
  rendered = draw([{ type: "ask", ask: { ...ask, expires_at: Date.now() - 1 } }], { onAnswerAsk: async () => choices.push("unexpected") });
  assert.equal(rendered.children[0].children.filter((node) => node.tag === "button").length, 0);
  assert.match(rendered.textContent, /已过期/);
  // Answered elsewhere (a notification, another screen): the card states the outcome and offers no buttons.
  for (const [choice, outcome] of [["deny", /已拒绝/], ["once", /已允许这一次/], ["always", /已选择：always/]]) {
    rendered = draw([{ type: "ask", ask: { ...ask, state: "answered", choice } }], { onAnswerAsk: async () => choices.push("unexpected") });
    assert.equal(rendered.children[0].children.filter((node) => node.tag === "button").length, 0, choice);
    assert.match(rendered.textContent, outcome);
  }
});

test("permission card delegates one owner tap to the native settings action", () => {
  const opened = [];
  const rendered = draw([{ type: "card", card: { type: "permission", permission: "calendar", why: "Read calendar" } }],
    { onPermission: (permission) => opened.push(permission) });
  const button = rendered.children[0].children.find((node) => node.tag === "button");
  button.listeners.click();
  assert.deepEqual(opened, ["calendar"]);
});
