import assert from "node:assert/strict";
import test from "node:test";
import { fold, initialView } from "../js/project.js";
import { renderActivitySheet } from "../js/sheet-activity.js";
import { normalizeClockList, UpcomingSheet } from "../js/sheet-upcoming.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; this.value = ""; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value || "") + this.children.map((child) => child.textContent).join(""); }
}
const withDom = async (fn) => { globalThis.document = { createElement: (tag) => new Node(tag) }; try { await fn(); } finally { delete globalThis.document; } };
const message = (seq, fields) => ({ seq, ts: seq * 1000, id: `m${seq}`, kind: "event", to: null, body: {}, ...fields });
const replay = (messages) => messages.reduce((view, item) => fold(view, item), initialView());

test("activity groups a real batch by turn, separates background, and omits tool bodies", async () => withDom(async () => {
  const view = replay([
    message(1, { id: "a", kind: "request", from: "person:owner", to: "agent:main", word: "say", body: { text: "查一下天气" } }),
    message(2, { id: "b", kind: "request", from: "person:owner", to: "agent:main", word: "say", body: { text: "还有日程" } }),
    message(3, { from: "agent:main", word: "turn.start", body: { turn: "t_one", ids: ["a", "b"] } }),
    message(4, { id: "tool", kind: "request", from: "agent:main", to: "device:phone", word: "calendar.list", turn: "t_one", body: { private: "SECRET_ARGUMENT" } }),
    message(5, { kind: "response", from: "device:phone", to: "agent:main", word: "calendar.list", reply_to: "tool", body: { ok: true, result: { private: "SECRET_RESULT" } } }),
    message(6, { from: "agent:main", word: "turn.end", body: { turn: "t_one", reason: "completed" } }),
    message(7, { from: "service:work", word: "run.start", body: { run: "r_one", flow: "整理", trigger: "scheduled" } }),
    message(8, { from: "service:work", word: "run.end", body: { run: "r_one", outcome: "done" } }),
  ]);
  const root = new Node("root");
  let prefill;
  renderActivitySheet(root, view, { askAbout: (value) => { prefill = value; } });
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0].dataset.turn, "r_one");
  assert.match(root.children[1].textContent, /查一下天气 · 2 条/);
  assert.match(root.children[1].textContent, /device:phone · calendar.list/);
  assert.equal(JSON.stringify(view).includes("SECRET_"), false);
  assert.equal(root.textContent.includes("SECRET_"), false);
  root.children[1].children.find((child) => child.tag === "button").listeners.click();
  assert.deepEqual(prefill, { turn: "t_one", text: "关于查一下天气 · 2 条，" });
}));

test("clock projection and upcoming sheet use production list shape; cancel refreshes authority", async () => withDom(async () => {
  const timer = { id: "timer1", next: 999999999999, every: null, to: "agent:main", word: "say", label: "带伞", blocked: null };
  const list = (timers) => ({ reply: { body: { ok: true, result: { timers } } } });
  const view = replay([message(1, { kind: "response", from: "service:clock", to: "person:owner", word: "list", body: list([timer]).reply.body })]);
  assert.deepEqual(view.timers, [timer]);
  assert.deepEqual(normalizeClockList(list([timer]).reply), [timer]);
  const root = new Node("root");
  const calls = [];
  let active = [timer];
  const sheet = new UpcomingSheet(root, async (request) => {
    calls.push(request);
    if (request.word === "list") return list(active);
    assert.deepEqual(request.body, { id: "timer1" });
    // Before the paired list arrives, the displayed timer is not optimistically removed.
    assert.match(root.textContent, /带伞/);
    active = [];
    return { reply: { body: { ok: true, result: { cancelled: true } } } };
  });
  await sheet.load();
  assert.match(root.textContent, /带伞/);
  await root.children[0].children.find((child) => child.tag === "button").listeners.click();
  assert.match(root.textContent, /暂无计划/);
  assert.deepEqual(calls.map((item) => item.word), ["list", "cancel", "list"]);
  assert.deepEqual(calls.map((item) => item.to), ["service:clock", "service:clock", "service:clock"]);
}));

test("failed cancel leaves timer visible; failed list gives error, not stale success", async () => withDom(async () => {
  const root = new Node("root");
  const sheet = new UpcomingSheet(root, async (request) => request.word === "list"
    ? { reply: { body: { ok: true, result: { timers: [{ id: "t", next: 999999999999, every: null, to: "agent:main", word: "say", label: "later", blocked: null }] } } } }
    : { reply: { body: { ok: false, error: { code: "forbidden" } } } });
  await sheet.load();
  await assert.rejects(sheet.cancel("t"), /未能删除/);
  assert.match(root.textContent, /later/);
  const offline = new UpcomingSheet(root, async () => ({ reply: { body: { ok: false, error: { code: "offline" } } } }));
  await assert.rejects(offline.load(), /暂不可用/);
  assert.match(root.textContent, /暂不可用/);
}));
