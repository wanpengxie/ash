import assert from "node:assert/strict";
import test from "node:test";
import { appendConversation, workspaceFileUrl } from "../js/conversation.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; }
  append(child) { this.children.push(child); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value || "") + this.children.map((child) => child.textContent).join(""); }
}

function draw(entries, options) {
  globalThis.document = { createElement: (tag) => new Node(tag) };
  try { const fragment = new Node("fragment"); appendConversation(fragment, entries, options); return fragment; }
  finally { delete globalThis.document; }
}

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
  const buttons = rendered.children[0].children.filter((node) => node.tag === "button");
  assert.equal(buttons.length, 3);
  await buttons[1].listeners.click();
  assert.deepEqual(choices, ["always"]);
  rendered = draw([{ type: "ask", ask: { ...ask, expires_at: Date.now() - 1 } }], { onAnswerAsk: async () => choices.push("unexpected") });
  assert.ok(rendered.children[0].children.filter((node) => node.tag === "button").every((node) => node.disabled));
  assert.match(rendered.textContent, /已过期/);
});
