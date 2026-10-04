import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fold, initialView } from "../js/project.js";
import { renderActivitySheet } from "../js/sheet-activity.js";
import { safeActivityView } from "../js/sheet-agent.js";
import { normalizeClockList, renderUpcomingSheet, UpcomingSheet } from "../js/sheet-upcoming.js";
import { WorkMember } from "../../src/members/work.ts";
import { Ledger } from "../../src/world/ledger.ts";
import { WorldMembers } from "../../src/world/member.ts";
import { WorldRouter } from "../../src/world/router.ts";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; this.value = ""; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value || "") + this.children.map((child) => child.textContent).join(""); }
}
function findAll(element, predicate) {
  return [...(predicate(element) ? [element] : []), ...(element.children ?? []).flatMap((child) => findAll(child, predicate))];
}
const withDom = async (fn) => { globalThis.document = { createElement: (tag) => new Node(tag) }; try { await fn(); } finally { delete globalThis.document; } };
const message = (seq, fields) => ({ seq, ts: seq * 1000, id: `m${seq}`, kind: "event", to: null, body: {}, ...fields });
const replay = (messages) => messages.reduce((view, item) => fold(view, item), initialView());

test("committed service:work run reaches the visible background activity group", async () => withDom(async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-activity-work-"));
  const ledger = await Ledger.open(join(dir, "ash.db"));
  const router = new WorldRouter(ledger, async () => true);
  const members = new WorldMembers(router);
  const work = new WorkMember({ ledger, router, isPaused: () => false, flows: [{ name: "memory", triggers: ["manual"], async execute(ctx) {
    await ctx.step("extract", () => undefined);
    return "done";
  } }] });
  members.register(work);
  try {
    const owner = { member: "person:owner", transport: "api", transportPrincipal: "test-owner", local: true, remote: false, ownerProxy: true };
    const started = await router.send(owner, { to: "service:work", kind: "request", word: "run", body: { flow: "memory" }, wait: true });
    assert.equal(started.reply?.body.ok, true);
    for (let i = 0; i < 100 && ledger.workRuns("memory")[0]?.state !== "done"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(ledger.workRuns("memory")[0]?.state, "done");
    const root = new Node("root");
    renderActivitySheet(root, safeActivityView(replay(ledger.list({ limit: 1000 }))));
    assert.match(root.textContent, /后台任务.*整理记忆.*提取记忆/s);
    assert.doesNotMatch(root.textContent, /service:work|worker:|extract/);
  } finally { work.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); }
}));

test("native DSH request and response appear in activity without raw arguments or tool names", async () => withDom(async () => {
  const view = replay([
    message(1, { from: "agent:main", word: "turn.start", body: { turn: "t_native", ids: [] } }),
    message(2, { id: "native-call", kind: "request", from: "agent:main", to: "service:dsh-tool", word: "read", turn: "t_native",
      body: { arguments: "SECRET_FILE_PATH" } }),
    message(3, { kind: "response", from: "service:dsh-tool", to: "agent:main", word: "read", reply_to: "native-call",
      body: { ok: true, result: { preview: "SECRET_RESULT" } } }),
    message(4, { from: "agent:main", word: "turn.end", body: { turn: "t_native", reason: "completed" } }),
  ]);
  const safe = safeActivityView(view);
  assert.deepEqual(safe.turns.t_native.steps.map((step) => ({ label: step.label, state: step.state })), [{ label: "在看文件", state: "ok" }]);
  const root = new Node("root");
  renderActivitySheet(root, safe);
  assert.match(root.textContent, /在看文件/);
  assert.doesNotMatch(root.textContent, /service:dsh-tool|SECRET_|\bread\b/);
}));

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
  let opened = null;
  renderActivitySheet(root, view, { askAbout: (value) => { prefill = value; }, now: 9000, onToggleBackground: (open) => { opened = open; } });
  assert.equal(root.children.length, 4);
  assert.equal(root.children[0].textContent, "今天", "conversations are grouped by day");
  assert.match(root.children[0].className, /activity-group/);
  assert.match(root.children[1].textContent, /查一下天气 · 2 条/);
  assert.match(root.children[1].textContent, /device:phone · calendar.list/);
  assert.match(root.children[1].textContent, /完成了 · 用时 3 秒/, "the outcome is said in plain words");
  assert.match(root.children[2].textContent, /^后台任务 · 1 项/);
  assert.equal(root.children[3].hidden, true, "background work starts collapsed");
  assert.equal(root.children[3].children[0].dataset.turn, "r_one");
  root.children[2].listeners.click();
  assert.equal(opened, true);
  assert.equal(JSON.stringify(view).includes("SECRET_"), false);
  assert.equal(root.textContent.includes("SECRET_"), false);
  findAll(root.children[1], (child) => child.tag === "button")[0].listeners.click();
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
  const cancel = findAll(root, (child) => child.tag === "button")[0];
  await cancel.listeners.click();
  assert.equal(calls.length, 1, "the first tap only arms the delete");
  await cancel.listeners.click();
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
  await assert.rejects(sheet.cancel("t"), /没能删除/);
  assert.match(root.textContent, /later/);
  const cancel = findAll(root, (child) => child.tag === "button")[0];
  await cancel.listeners.click();
  await cancel.listeners.click();
  assert.match(root.textContent, /没能删除/);
  assert.match(root.textContent, /later/);
  const offline = new UpcomingSheet(root, async () => ({ reply: { body: { ok: false, error: { code: "offline" } } } }));
  await assert.rejects(offline.load(), /暂时读不到计划/);
  assert.match(root.textContent, /暂时读不到计划（不代表没有）/);
}));

test("clock blocked diagnostic is rendered as a fixed human message", async () => withDom(async () => {
  const timers = normalizeClockList({ body: { ok: true, result: { timers: [
    { id: "tmr_x", next: 1000, label: "带伞", blocked: "internal_adapter_timeout" },
  ] } } });
  const root = new Node("root");
  renderUpcomingSheet(root, timers);
  assert.match(root.textContent, /暂时没法执行：请稍后再看/);
  assert.doesNotMatch(root.textContent, /internal_adapter_timeout/);
}));
