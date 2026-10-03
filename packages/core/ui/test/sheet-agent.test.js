import assert from "node:assert/strict";
import test from "node:test";
import { AgentSheet, cancelClockForScreen, safeActivityView } from "../js/sheet-agent.js";
import { approvalSections } from "../js/sheet-approvals.js";

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

function fixture({ localManagement = true, request, getView = () => ({ turns: {} }), getLedgerMessage = () => null, onAskAbout = () => {}, idFactory = () => "cancel-client-one" } = {}) {
  globalThis.document = { createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element("fragment") };
  const root = new Element("aside");
  root.named = { "#agentTabs": new Element("nav"), "#agentPanel": new Element("div"), "#agentClose": new Element("button") };
  const net = { token: "token-a", screen: "screen:a", currentScope: "scope-a", generation: 1,
    localManagement, request: request ?? (async (_path, options) => {
      const wire = JSON.parse(options.body);
      return { ok: true, json: async () => ({ id: "id", reply: { kind: "response", reply_to: "id", from: "service:self",
        to: "person:owner", word: wire.word, body: { ok: false, error: { code: "not_found" } } } }) };
    }) };
  const sheet = new AgentSheet(root, net, { confirmDiscard: () => false, getView, getLedgerMessage, onAskAbout, idFactory });
  return { root, net, sheet };
}

test("five tabs show safe activity, and failed clock never claims empty", async () => {
  const f = fixture();
  try {
    f.sheet.open();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.root.named["#agentTabs"].children.length, 5);
    assert.deepEqual(f.root.named["#agentTabs"].children.map((button) => button.textContent), ["身份", "记忆", "活动", "计划", "审批"]);
    assert.equal(f.sheet.activeTab, "identity", "the page opens on who she is");
    await f.sheet.show("activity");
    assert.match(f.sheet.panels.get("activity").textContent, /还没有活动记录/);
    assert.doesNotMatch(f.sheet.panels.get("activity").textContent, /service:|bash|web_search/);
    await f.sheet.show("upcoming");
    assert.match(f.sheet.panels.get("upcoming").textContent, /暂时读不到计划（不代表没有）/);
    assert.doesNotMatch(f.sheet.panels.get("upcoming").textContent, /暂无计划/);
    assert.ok(findAll(f.sheet.panels.get("upcoming"), (item) => item.tag === "button" && item.textContent === "重试").length, "failure offers a plain retry");
    await f.sheet.show("approvals");
    assert.match(f.sheet.panels.get("approvals").textContent, /正在读取/, "history and rules load by themselves");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(f.sheet.panels.get("approvals").textContent, /现在没有要你决定的事/);
    assert.match(f.sheet.panels.get("approvals").textContent, /暂时读不到这些规则（不代表没有）/);
  } finally { f.sheet.reset(); delete globalThis.document; }
});

test("activity question passes a turn-linked prefill to the composer callback", async () => {
  let asked = null;
  const f = fixture({ getView: () => ({ turns: { t_one: { title: "查天气", started: 1000, steps: [] } } }), onAskAbout: (value) => { asked = value; } });
  try {
    f.sheet.open();
    await new Promise((resolve) => setImmediate(resolve));
    await f.sheet.show("activity");
    const section = f.sheet.panels.get("activity");
    const turn = findAll(section, (child) => child.dataset.turn === "t_one")[0];
    assert.match(section.textContent, /今天|\d+月\d+日/, "turns are grouped under a day");
    const button = findAll(turn, (child) => child.tag === "button")[0];
    assert.equal(button.textContent, "问问她这件事");
    button.listeners.click();
    assert.deepEqual(asked, { turn: "t_one", text: "关于查天气，" });
  } finally { f.sheet.reset(); delete globalThis.document; }
});

test("activity strips raw route words; a paired live clock list offers cancellation", async () => {
  const view = { turns: { t_one: { title: "查天气", started: 1000, steps: [
    { label: "service:self · write", requestId: "raw" }, { label: "calendar.search", ts: 1000 },
    { label: "正在查找", ts: 1001 }, { label: "在看网页 · nba.com", ts: 1002 },
  ] }, r_one: { title: "memory", background: true, started: 2000, steps: [
    { label: "extract", state: "done", ts: 2000 }, { label: "service:self", ts: 2001 },
  ] } } };
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
    assert.match(activity, /查天气.*正在查找.*在看网页 · nba\.com/s);
    assert.match(activity, /整理记忆.*提取记忆/s);
    assert.doesNotMatch(activity, /service:self|secret flow|write/);
    await f.sheet.show("upcoming");
    assert.match(f.sheet.panels.get("upcoming").textContent, /带伞/);
    assert.match(f.sheet.panels.get("upcoming").textContent, /删除/);
    assert.match(f.sheet.panels.get("upcoming").textContent, /只一次/);
    assert.doesNotMatch(f.sheet.panels.get("upcoming").textContent, /service:/);
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
    assert.match(f.sheet.panels.get("upcoming").textContent, /暂时读不到计划/);
    assert.doesNotMatch(f.sheet.panels.get("upcoming").textContent, /暂无计划/);
    invalid = "timer";
    await f.sheet.show("upcoming");
    assert.match(f.sheet.panels.get("upcoming").textContent, /暂时读不到计划/);
    assert.doesNotMatch(f.sheet.panels.get("upcoming").textContent, /暂无计划/);
  } finally { f.sheet.reset(); delete globalThis.document; }
});

test("clock labels and blocked reasons cannot expose raw route names", async () => {
  let label = "带伞";
  let blocked = "service:clock list failed";
  const f = fixture({ request: async (_path, options) => {
    const wire = JSON.parse(options.body);
    if (wire.to === "service:self") return { ok: true, json: async () => ({ id: "self", reply: { kind: "response", reply_to: "self", from: "service:self", to: "person:owner", word: wire.word, body: { ok: false, error: { code: "not_found" } } } }) };
    return { ok: true, json: async () => ({ id: "clock", reply: { kind: "response", reply_to: "clock",
      from: "service:clock", to: "person:owner", word: "list", body: { ok: true, result: { timers: [{ id: "tmr_a", next: 1000, label, blocked }] } } } }) };
  } });
  try {
    f.sheet.open();
    await new Promise((resolve) => setImmediate(resolve));
    await f.sheet.show("upcoming");
    assert.match(f.sheet.panels.get("upcoming").textContent, /暂时读不到计划/);
    assert.doesNotMatch(f.sheet.panels.get("upcoming").textContent, /service:clock/);
    blocked = null;
    label = "calendar.search";
    await f.sheet.show("upcoming");
    assert.match(f.sheet.panels.get("upcoming").textContent, /暂时读不到计划/);
    assert.doesNotMatch(f.sheet.panels.get("upcoming").textContent, /calendar.search/);
  } finally { f.sheet.reset(); delete globalThis.document; }
});

test("cancel keeps the timer until a paired acknowledgement and authoritative list", async () => {
  const timer = { id: "timer-a", next: 100000, every: null, label: "带伞", blocked: null };
  let releaseCancel;
  let active = [timer];
  const calls = [];
  const f = fixture({ request: async (_path, options) => {
    const wire = JSON.parse(options.body);
    if (wire.to === "service:self") return { ok: true, json: async () => ({ id: "self", reply: { kind: "response", reply_to: "self", from: "service:self", to: "person:owner", word: wire.word, body: { ok: false, error: { code: "not_found" } } } }) };
    calls.push(wire);
    if (wire.word === "cancel") return new Promise((resolve) => { releaseCancel = () => resolve(clockResponse("cancel", { cancelled: true })); });
    return clockResponse("list", { timers: active });
  } });
  try {
    f.sheet.open();
    await f.sheet.show("upcoming");
    const section = f.sheet.panels.get("upcoming");
    const button = findAll(section, (child) => child.tag === "button")[0];
    await button.listeners.click();
    assert.equal(calls.filter((wire) => wire.word === "cancel").length, 0, "the first tap only explains what will be lost");
    assert.equal(button.textContent, "确认删除");
    assert.match(section.textContent, /删除后，.*「带伞」就取消了/);
    const pending = button.listeners.click();
    await button.listeners.click();
    assert.equal(calls.filter((wire) => wire.word === "cancel").length, 1, "double click cannot duplicate an effect");
    assert.match(section.textContent, /带伞/, "no optimistic removal before an acknowledgement");
    active = [];
    releaseCancel();
    await pending;
    assert.match(section.textContent, /暂无计划/);
    assert.deepEqual(calls.map((wire) => wire.word), ["list", "cancel", "list"]);
    assert.deepEqual(calls[1], { to: "service:clock", kind: "request", word: "cancel",
      body: { id: "timer-a" }, wait: true, client_id: "cancel-client-one" });
  } finally { f.sheet.reset(); delete globalThis.document; }
});

test("lost cancel acknowledgement retries only on a new click with the same client id", async () => {
  const timer = { id: "timer-a", next: 100000, every: null, label: "带伞", blocked: null };
  let active = [timer];
  let cancels = 0;
  const ids = [];
  const f = fixture({ request: async (_path, options) => {
    const wire = JSON.parse(options.body);
    if (wire.to === "service:self") return { ok: true, json: async () => ({ id: "self", reply: { kind: "response", reply_to: "self", from: "service:self", to: "person:owner", word: wire.word, body: { ok: false, error: { code: "not_found" } } } }) };
    if (wire.word === "list") return clockResponse("list", { timers: active });
    ids.push(wire.client_id);
    cancels++;
    if (cancels === 1) { active = []; throw new Error("synthetic lost acknowledgement"); }
    return clockResponse("cancel", { cancelled: true });
  } });
  try {
    f.sheet.open();
    await f.sheet.show("upcoming");
    const section = f.sheet.panels.get("upcoming");
    const button = findAll(section, (child) => child.tag === "button")[0];
    await button.listeners.click();
    await button.listeners.click();
    assert.match(section.textContent, /带伞.*还没确认结果/s);
    assert.equal(cancels, 1, "no automatic retry of an ambiguous effect");
    await button.listeners.click();
    assert.deepEqual(ids, ["cancel-client-one", "cancel-client-one"]);
    assert.match(section.textContent, /暂无计划/);
  } finally { f.sheet.reset(); delete globalThis.document; }
});

test("cancelled false, rejected HTTP, forged pairing and stale scope never remove a timer", async () => {
  const net = { token: "token-a", screen: "screen:a", currentScope: "scope-a", generation: 1 };
  const accepted = (word, result, overrides = {}) => ({ ok: true, json: async () => ({ id: "request-a", reply: {
    kind: "response", reply_to: "request-a", from: "service:clock", to: "person:owner", word,
    body: { ok: true, result }, ...overrides } }) });
  net.request = async () => accepted("cancel", { cancelled: false });
  await assert.rejects(cancelClockForScreen(net, () => true, "timer-a", "client-a"), /没能删除/);
  net.request = async () => ({ ok: false, status: 403 });
  await assert.rejects(cancelClockForScreen(net, () => true, "timer-a", "client-a"), /不能修改计划/);
  net.request = async () => accepted("cancel", { cancelled: true }, { reply_to: "other" });
  await assert.rejects(cancelClockForScreen(net, () => true, "timer-a", "client-a"), /还没确认结果/);
  let release;
  net.request = async () => new Promise((resolve) => { release = resolve; });
  const pending = cancelClockForScreen(net, () => true, "timer-a", "client-a");
  net.currentScope = "scope-b";
  release(accepted("cancel", { cancelled: true }));
  await assert.rejects(pending, /连接已经换过/);
});

test("late cancel acknowledgement after sheet scope loss cannot revive rows or reuse intent", async () => {
  const timer = { id: "timer-a", next: 100000, every: null, label: "旧账户计划", blocked: null };
  let releaseCancel;
  let listCount = 0;
  const f = fixture({ request: async (_path, options) => {
    const wire = JSON.parse(options.body);
    if (wire.to === "service:self") return { ok: true, json: async () => ({ id: "self", reply: { kind: "response", reply_to: "self", from: "service:self", to: "person:owner", word: wire.word, body: { ok: false, error: { code: "not_found" } } } }) };
    if (wire.word === "list") { listCount++; return clockResponse("list", { timers: [timer] }); }
    return new Promise((resolve) => { releaseCancel = () => resolve(clockResponse("cancel", { cancelled: true })); });
  } });
  try {
    f.sheet.open();
    await f.sheet.show("upcoming");
    const button = findAll(f.sheet.panels.get("upcoming"), (child) => child.tag === "button")[0];
    await button.listeners.click();
    const pending = button.listeners.click();
    f.net.currentScope = "scope-b";
    f.sheet.registration();
    releaseCancel();
    await pending;
    assert.equal(f.root.named["#agentPanel"].textContent, "");
    assert.equal(f.sheet.cancelIntents.size, 0);
    assert.equal(listCount, 1, "old response cannot start a new-scope list");
  } finally { f.sheet.reset(); delete globalThis.document; }
});

function clockResponse(word, result) {
  return { ok: true, json: async () => ({ id: `clock-${word}`, reply: {
    kind: "response", reply_to: `clock-${word}`, from: "service:clock", to: "person:owner", word,
    body: { ok: true, result },
  } }) };
}

function gateResponse(word, result) {
  return { ok: true, json: async () => ({ id: `gate-${word}`, reply: {
    kind: "response", reply_to: `gate-${word}`, from: "service:gate", to: "person:owner", word,
    body: { ok: true, result },
  } }) };
}

function findAll(element, predicate) {
  return [ ...(predicate(element) ? [element] : []), ...element.children.flatMap((child) => findAll(child, predicate)) ];
}

test("approval page loads gate history and rules, then removes a revoked rule after the authoritative reload", async () => {
  const rule = { id: "rule-a", to: "device:fixture", word: "send", expires_at: Date.now() + 60_000 };
  const history = { id: "history-a", source: "current", to: "device:fixture", word: "send", decision: "once", at: Date.now() };
  const calls = [];
  let revoked = false;
  const f = fixture({ request: async (_path, options) => {
    const wire = JSON.parse(options.body);
    if (wire.to === "service:self") return clockResponse("read", {});
    calls.push(wire);
    if (wire.word === "history") return gateResponse(wire.word, { items: [history] });
    if (wire.word === "rules.list") return gateResponse(wire.word, { rules: revoked ? [] : [rule] });
    if (wire.word === "rules.revoke") { revoked = true; return gateResponse(wire.word, { revoked: true }); }
    throw new Error(`unexpected ${wire.word}`);
  } });
  try {
    f.sheet.open();
    await f.sheet.show("approvals");
    await new Promise((resolve) => setImmediate(resolve));
    const panel = f.sheet.panels.get("approvals");
    assert.match(panel.textContent, /以后都允许.*撤销.*最近的决定.*仅这一次/s);
    assert.doesNotMatch(panel.textContent, /device:|service:/);
    const button = findAll(panel, (item) => item.tag === "button" && item.textContent === "撤销")[0];
    assert.ok(button);
    button.listeners.click();
    assert.deepEqual(calls.map((item) => item.word), ["history", "rules.list"], "the first tap only explains the consequence");
    assert.match(panel.textContent, /撤销后，Ash 下次做这件事前会先问你/);
    findAll(panel, (item) => item.tag === "button" && item.textContent === "确认撤销")[0].listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.map((item) => item.word), ["history", "rules.list", "rules.revoke", "history", "rules.list"]);
    assert.match(panel.textContent, /没有正在生效的规则/);
    assert.equal(findAll(panel, (item) => item.tag === "button" && /撤销/.test(item.textContent)).length, 0);
  } finally { f.sheet.reset(); delete globalThis.document; }
});

test("remote approval page can inspect rules but cannot offer a revoke button", async () => {
  const f = fixture({ localManagement: false, request: async (_path, options) => {
    const wire = JSON.parse(options.body);
    if (wire.to === "service:self") return clockResponse("read", {});
    return gateResponse(wire.word, wire.word === "history" ? { items: [] } : { rules: [
      { id: "rule-remote", to: "device:fixture", word: "send", expires_at: Date.now() + 60_000 },
    ] });
  } });
  try {
    f.sheet.open();
    await f.sheet.show("approvals");
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(f.sheet.panels.get("approvals").textContent, /以后都允许/);
    assert.doesNotMatch(f.sheet.panels.get("approvals").textContent, /撤销/);
  } finally { f.sheet.reset(); delete globalThis.document; }
});

const pendingGateAsk = () => ({ id: "gate-ask", seq: 7, from: "service:gate", state: "pending",
  options_valid: true, title: "发送一条测试消息？", detail: "仅合成内容", expires_at: Date.now() + 60_000,
  options: [{ id: "once", label: "仅这次" }, { id: "deny", label: "拒绝" }] });

test("remote approval double click is single-flight; unknown ACK retries only the same choice and client id", async () => {
  const ask = pendingGateAsk();
  const calls = [];
  let releaseFirst;
  let ledgerResponse = null;
  const f = fixture({ localManagement: false, getView: () => ({ asks: [ask] }),
    getLedgerMessage: () => ledgerResponse, idFactory: () => "stable-answer-id",
    request: async (_path, options) => {
      const wire = JSON.parse(options.body);
      if (wire.to === "service:self") return clockResponse("read", {});
      if (wire.kind === "request" && wire.to === "service:gate")
        return gateResponse(wire.word, wire.word === "history" ? { items: [] } : { rules: [] });
      calls.push(wire);
      if (calls.length === 1) return new Promise((_resolve, reject) => { releaseFirst = () => reject(new Error("synthetic lost ACK")); });
      ledgerResponse = { id: "answer-1", seq: 8, from: "person:owner", to: "service:gate", kind: "response",
        word: "ask", reply_to: ask.id, origin: { screen: f.net.screen },
        body_summary: { ok: true, result: { choice: "once" } } };
      return { ok: true, json: async () => ({ id: "answer-1", seq: 8 }) };
    } });
  try {
    f.sheet.open();
    await f.sheet.show("approvals");
    const shown = approvalSections(f.sheet.getView()).pending[0];
    const binding = f.sheet.session;
    const epoch = f.sheet.loadEpoch;
    const first = f.sheet.answerApproval(shown, "once", binding, epoch);
    await f.sheet.answerApproval(shown, "once", binding, epoch);
    assert.equal(calls.length, 1, "double click cannot duplicate a pending response");
    releaseFirst();
    await first;
    assert.equal(f.sheet.answerIntents.get(ask.id).status, "uncertain");
    assert.match(f.sheet.panels.get("approvals").textContent, /还没确认你的回答送到了.*仅这次/);
    await f.sheet.answerApproval(shown, "deny", binding, epoch);
    assert.equal(calls.length, 1, "unknown ACK cannot change the intended choice");
    await f.sheet.answerApproval(shown, "once", binding, epoch);
    assert.deepEqual(calls.map((call) => call.client_id), ["stable-answer-id", "stable-answer-id"]);
    assert.deepEqual(calls.map((call) => call.body.result.choice), ["once", "once"]);
    assert.equal(f.sheet.answerIntents.get(ask.id).status, "confirmed");
    assert.match(f.sheet.panels.get("approvals").textContent, /已收到你的回答/);
  } finally { f.sheet.reset(); delete globalThis.document; }
});

test("late remote approval ACK after auth-scope change cannot confirm or retain an intent", async () => {
  const ask = pendingGateAsk();
  let release;
  const f = fixture({ localManagement: false, getView: () => ({ asks: [ask] }),
    request: async (_path, options) => {
      const wire = JSON.parse(options.body);
      if (wire.to === "service:self") return clockResponse("read", {});
      return new Promise((resolve) => { release = () => resolve({ ok: true, json: async () => ({ id: "answer-1", seq: 8 }) }); });
    } });
  try {
    f.sheet.open();
    await f.sheet.show("approvals");
    const shown = approvalSections(f.sheet.getView()).pending[0];
    const pending = f.sheet.answerApproval(shown, "deny", f.sheet.session, f.sheet.loadEpoch);
    f.net.currentScope = "scope-b";
    f.sheet.registration();
    release();
    await pending;
    assert.equal(f.sheet.answerIntents.size, 0);
    assert.equal(f.root.classList.contains("open"), false);
    assert.doesNotMatch(f.root.textContent, /已收到你的回答/);
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

test("pending approvals put a count on the tab; the rename row asks her instead of opening a form", async () => {
  const ask = pendingGateAsk();
  let prefill = null;
  globalThis.document = { createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element("fragment") };
  const root = new Element("aside");
  root.named = { "#agentTabs": new Element("nav"), "#agentPanel": new Element("div"), "#agentClose": new Element("button") };
  const net = { token: "token-a", screen: "screen:a", currentScope: "scope-a", generation: 1, localManagement: true,
    request: async (_path, options) => {
      const wire = JSON.parse(options.body);
      return { ok: true, json: async () => ({ id: "id", reply: { kind: "response", reply_to: "id", from: "service:self",
        to: "person:owner", word: wire.word, body: { ok: true, result: { content: "# 我的名片\n- 名字：小舟\n", hash: "a".repeat(64) } } } }) };
    } };
  const sheet = new AgentSheet(root, net, { getView: () => ({ asks: [ask], turns: {} }), onPrefill: (text) => { prefill = text; } });
  try {
    sheet.setName("小舟");
    sheet.open();
    await new Promise((resolve) => setImmediate(resolve));
    const approvals = root.named["#agentTabs"].children.find((button) => button.dataset.tab === "approvals");
    assert.equal(approvals.dataset.badge, "1");
    const identity = sheet.panels.get("identity");
    assert.match(identity.textContent, /这些决定了小舟是谁/);
    assert.match(identity.textContent, /性格.*名片/s);
    assert.doesNotMatch(identity.textContent, /SOUL\.md|IDENTITY\.md|哈希|版本/);
    const rename = findAll(identity, (item) => item.tag === "button" && /想给小舟换个名字/.test(item.textContent))[0];
    rename.listeners.click();
    assert.equal(prefill, "我想给你换个名字，以后叫你");
  } finally { sheet.reset(); delete globalThis.document; }
});
