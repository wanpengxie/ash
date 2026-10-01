import assert from "node:assert/strict";
import test from "node:test";
import { AgentSheet, safeActivityView } from "../js/sheet-agent.js";

class Element {
  constructor(tag) {
    this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.hidden = false;
    const classes = new Set();
    this.classList = { add: (value) => classes.add(value), remove: (value) => classes.delete(value), contains: (value) => classes.has(value) };
  }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  setAttribute(name, value) { this[name] = value; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value ?? "") + this.children.map((child) => child.textContent).join(""); }
  querySelector(selector) { return this.named?.[selector]; }
}

function fixture({ localManagement = true, request, getView = () => ({ turns: {} }) } = {}) {
  globalThis.document = { createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element("fragment") };
  const root = new Element("aside");
  root.named = { "#agentTabs": new Element("nav"), "#agentPanel": new Element("div"), "#agentClose": new Element("button") };
  const net = { token: "token-a", screen: "screen:a", currentScope: "scope-a", generation: 1,
    localManagement, request: request ?? (async (_path, options) => {
      const wire = JSON.parse(options.body);
      return { ok: true, json: async () => ({ id: "id", reply: { kind: "response", reply_to: "id", from: "service:self",
        to: "person:owner", word: wire.word, body: { ok: false, error: { code: "not_found" } } } }) };
    }) };
  const sheet = new AgentSheet(root, net, { confirmDiscard: () => false, getView });
  return { root, net, sheet };
}

test("five tabs show safe activity, and failed clock never claims empty", async () => {
  const f = fixture();
  try {
    f.sheet.open();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.root.named["#agentTabs"].children.length, 5);
    await f.sheet.show("activity");
    assert.match(f.sheet.panels.get("activity").textContent, /后台活动服务尚未接入/);
    assert.doesNotMatch(f.sheet.panels.get("activity").textContent, /service:|bash|web_search/);
    await f.sheet.show("upcoming");
    assert.match(f.sheet.panels.get("upcoming").textContent, /不能据此判断待办为空/);
    await f.sheet.show("approvals");
    assert.match(f.sheet.panels.get("approvals").textContent, /不能确认操作/);
    assert.equal(f.sheet.panels.get("approvals").children.length, 1, "no fake approval button");
  } finally { f.sheet.reset(); delete globalThis.document; }
});

test("activity strips raw route words; a paired live clock list is read-only", async () => {
  const view = { turns: { t_one: { title: "查天气", started: 1000, steps: [
    { label: "service:self · write", requestId: "raw" }, { label: "calendar.search", ts: 1000 },
    { label: "正在查找", ts: 1001 },
  ] }, r_one: { title: "secret flow", background: true, started: 2000, steps: [] } } };
  assert.equal(JSON.stringify(safeActivityView(view)).includes("service:self"), false);
  const f = fixture({ getView: () => view, request: async (_path, options) => {
    const wire = JSON.parse(options.body);
    if (wire.to === "service:self") return { ok: true, json: async () => ({ id: "self", reply: { kind: "response", reply_to: "self", from: "service:self", to: "person:owner", word: wire.word, body: { ok: false, error: { code: "not_found" } } } }) };
    assert.equal(options.headers["Ash-Screen"], f.net.token);
    return { ok: true, json: async () => ({ id: "clock", reply: { kind: "response", reply_to: "clock", from: "service:clock", to: "person:owner", word: "list", body: { ok: true, result: { timers: [{ id: "tmr_a", next: 100000, every: null, label: "带伞", blocked: null }] } } } }) };
  } });
  try {
    f.sheet.open();
    await new Promise((resolve) => setImmediate(resolve));
    await f.sheet.show("activity");
    const activity = f.sheet.panels.get("activity").textContent;
    assert.match(activity, /查天气.*正在查找/s);
    assert.match(activity, /后台活动服务尚未接入/);
    assert.doesNotMatch(activity, /service:self|secret flow|write/);
    await f.sheet.show("upcoming");
    assert.match(f.sheet.panels.get("upcoming").textContent, /带伞/);
    assert.doesNotMatch(f.sheet.panels.get("upcoming").textContent, /删除计划|service:/);
  } finally { f.sheet.reset(); delete globalThis.document; }
});

test("late clock answer after scope change or malformed pairing is not displayed", async () => {
  let resolveClock;
  const f = fixture({ request: async (_path, options) => {
    const wire = JSON.parse(options.body);
    if (wire.to === "service:self") return { ok: true, json: async () => ({ id: "self", reply: { kind: "response", reply_to: "self", from: "service:self", to: "person:owner", word: wire.word, body: { ok: false, error: { code: "not_found" } } } }) };
    return new Promise((resolve) => { resolveClock = resolve; });
  } });
  try {
    f.sheet.open();
    const pending = f.sheet.show("upcoming");
    f.net.currentScope = "scope-b";
    f.sheet.registration();
    resolveClock({ ok: true, json: async () => ({ id: "clock", reply: { kind: "response", reply_to: "clock", from: "service:clock", to: "person:owner", word: "list", body: { ok: true, result: { timers: [{ id: "x", next: 1, label: "PRIVATE" }] } } } }) });
    await pending;
    assert.doesNotMatch(f.root.textContent, /PRIVATE/);
    assert.equal(f.root.classList.contains("open"), false);
  } finally { f.sheet.reset(); delete globalThis.document; }
});

test("clock reply mismatch and malformed timer cannot produce a false empty list", async () => {
  let invalid = "pair";
  const f = fixture({ request: async (_path, options) => {
    const wire = JSON.parse(options.body);
    if (wire.to === "service:self") return { ok: true, json: async () => ({ id: "self", reply: { kind: "response", reply_to: "self", from: "service:self", to: "person:owner", word: wire.word, body: { ok: false, error: { code: "not_found" } } } }) };
    return { ok: true, json: async () => ({ id: "clock", reply: { kind: "response", reply_to: invalid === "pair" ? "other" : "clock",
      from: "service:clock", to: "person:owner", word: "list", body: { ok: true, result: { timers: invalid === "pair" ? [] : [{ id: "bad", next: "tomorrow" }] } } } }) };
  } });
  try {
    f.sheet.open();
    await new Promise((resolve) => setImmediate(resolve));
    await f.sheet.show("upcoming");
    assert.match(f.sheet.panels.get("upcoming").textContent, /暂不可用/);
    assert.doesNotMatch(f.sheet.panels.get("upcoming").textContent, /暂无计划/);
    invalid = "timer";
    await f.sheet.show("upcoming");
    assert.match(f.sheet.panels.get("upcoming").textContent, /暂不可用/);
    assert.doesNotMatch(f.sheet.panels.get("upcoming").textContent, /暂无计划/);
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
