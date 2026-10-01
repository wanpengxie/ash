import assert from "node:assert/strict";
import test from "node:test";
import { AgentSheet } from "../js/sheet-agent.js";

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.hidden = false;
    const classes = new Set();
    this.classList = { add: (value) => classes.add(value), remove: (value) => classes.delete(value), contains: (value) => classes.has(value) };
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute(name, value) { this[name] = value; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value ?? "") + this.children.map((child) => child.textContent).join(""); }
  querySelector(selector) { return this.named?.[selector]; }
}

function fixture({ localManagement = true, request } = {}) {
  globalThis.document = { createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element("fragment") };
  const root = new Element("aside");
  root.named = { "#agentTabs": new Element("nav"), "#agentPanel": new Element("div"), "#agentClose": new Element("button") };
  const net = { token: "token-a", screen: "screen:a", currentScope: "scope-a", generation: 1,
    localManagement, request: request ?? (async (_path, options) => {
      const wire = JSON.parse(options.body);
      return { ok: true, json: async () => ({ id: "id", reply: { kind: "response", reply_to: "id", from: "service:self",
        to: "person:owner", word: wire.word, body: { ok: false, error: { code: "not_found" } } } }) };
    }) };
  const sheet = new AgentSheet(root, net, { confirmDiscard: () => false });
  return { root, net, sheet };
}

test("five tabs never expose raw activity words or pretend unfinished services are empty", async () => {
  const f = fixture();
  try {
    f.sheet.open();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.root.named["#agentTabs"].children.length, 5);
    await f.sheet.show("activity");
    assert.match(f.sheet.panels.get("activity").textContent, /尚未接入/);
    assert.doesNotMatch(f.sheet.panels.get("activity").textContent, /service:|bash|web_search/);
    await f.sheet.show("upcoming");
    assert.match(f.sheet.panels.get("upcoming").textContent, /不能代表真实待办为空/);
    await f.sheet.show("approvals");
    assert.match(f.sheet.panels.get("approvals").textContent, /不能确认操作/);
    assert.equal(f.sheet.panels.get("approvals").children.length, 1, "no fake approval button");
  } finally { f.sheet.reset(); delete globalThis.document; }
});

test("remote identity is read-only; scope loss discards draft and delayed read", async () => {
  let release;
  const f = fixture({ localManagement: false, request: async (_path, options) => new Promise((resolve) => {
    const wire = JSON.parse(options.body);
    release = () => resolve({ ok: true, json: async () => ({ id: "id", reply: { kind: "response", reply_to: "id",
      from: "service:self", to: "person:owner", word: wire.word, body: { ok: true, result: { content: "old private text", hash: "a".repeat(64) } } } }) });
  }) });
  try {
    f.sheet.open();
    assert.equal(f.sheet.identity.options.canEdit, false);
    f.net.currentScope = "scope-b";
    f.sheet.registration();
    assert.equal(f.root.classList.contains("open"), false);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.root.named["#agentPanel"].textContent, "");
    assert.equal(f.sheet.identity, null);
  } finally { f.sheet.reset(); delete globalThis.document; }
});

test("dirty or uncertain editor blocks voluntary close, but disconnect clears it", async () => {
  const f = fixture();
  try {
    f.sheet.open();
    await new Promise((resolve) => setImmediate(resolve));
    f.sheet.identity.editor.setDraft("draft");
    assert.equal(f.sheet.close(), false);
    assert.equal(f.root.classList.contains("open"), true);
    f.sheet.network("offline");
    assert.equal(f.root.classList.contains("open"), false);
    assert.equal(f.sheet.identity, null);
    assert.equal(f.root.named["#agentPanel"].textContent, "");
  } finally { f.sheet.reset(); delete globalThis.document; }
});
