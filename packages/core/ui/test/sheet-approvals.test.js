import assert from "node:assert/strict";
import test from "node:test";
import { fold, initialView } from "../js/project.js";
import { answerGateAsk, approvalSections, gatePageRequest, renderApprovalsSheet } from "../js/sheet-approvals.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.className = ""; this.value = ""; this.listeners = {}; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  set textContent(value) { this.value = String(value); this.children = []; }
  get textContent() { return this.value + this.children.map((child) => child.textContent).join(""); }
}

function draw(view, now = 5000) {
  globalThis.document = { createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment") };
  try { const root = new Node("root"); const sections = renderApprovalsSheet(root, view, { now }); return { root, sections, nodes: root.children[0].children }; }
  finally { delete globalThis.document; }
}

const gateAsk = (id, seq, from = "service:gate", expires_at = 9000) => ({ seq, id, ts: seq, from, to: "person:owner", kind: "request", word: "ask",
  body: { title: "Allow sending?", detail: "Send one synthetic note", expires_at,
    options: [{ id: "once", label: "Only once" }, { id: "deny", label: "No" }],
    source: { to: "device:fixture", word: "send", body_preview: "synthetic" } } });

test("gate page accepts only paired current-screen replies", async () => {
  const net = { token: "screen-token", screen: "screen:local", currentScope: "scope-a", generation: 1,
    request: async (_path, options) => {
      const wire = JSON.parse(options.body);
      assert.equal(options.headers["Ash-Screen"], "screen-token");
      assert.equal(wire.to, "service:gate");
      return { ok: true, json: async () => ({ id: "request-a", reply: { kind: "response", reply_to: "request-a",
        from: "service:gate", to: "person:owner", word: wire.word, body: { ok: true, result: { rules: [] } } } }) };
    } };
  assert.deepEqual(await gatePageRequest(net, () => true, "rules.list", {}), { rules: [] });
  net.request = async () => ({ ok: true, json: async () => ({ id: "request-a", reply: { kind: "response",
    reply_to: "different", from: "service:gate", to: "person:owner", word: "rules.list", body: { ok: true, result: { rules: [] } } } }) });
  await assert.rejects(gatePageRequest(net, () => true, "rules.list", {}), /未配对/);
  let release;
  net.request = async () => new Promise((resolve) => { release = resolve; });
  const pending = gatePageRequest(net, () => true, "history", {});
  net.currentScope = "scope-b";
  release({ ok: true, json: async () => ({ id: "request-a", reply: { kind: "response", reply_to: "request-a",
    from: "service:gate", to: "person:owner", word: "history", body: { ok: true, result: { items: [] } } } }) });
  await assert.rejects(pending, /屏幕身份已变化/);
});

test("only a live gate ask from trusted ledger origin appears; other asks and old answers do not", () => {
  let view = initialView();
  view = fold(view, gateAsk("gate-live", 1));
  view = fold(view, gateAsk("ordinary", 2, "agent:main"));
  view = fold(view, gateAsk("gate-expired", 3, "service:gate", 5000));
  view = fold(view, gateAsk("gate-answered", 4));
  view = fold(view, { seq: 5, id: "answer", ts: 5, from: "person:owner", to: "service:gate", kind: "response", word: "ask", reply_to: "gate-answered", body: { ok: true, result: { choice: "deny" } } });
  assert.equal(view.asks.find((ask) => ask.id === "gate-live").from, "service:gate");
  const { nodes, sections } = draw(view);
  assert.deepEqual(sections.pending.map((ask) => ask.id), ["gate-live"]);
  assert.deepEqual(nodes.filter((node) => node.tag === "article").map((node) => node.dataset.askId), ["gate-live"]);
  assert.equal(nodes.some((node) => node.tag === "button"), false);
  assert.match(nodes.map((node) => node.textContent).join(" "), /暂时读不到审批记录（不代表没有）/);
  assert.match(nodes.map((node) => node.textContent).join(" "), /暂时读不到这些规则（不代表没有）/);
});

test("missing or body-spoofed source fails closed and empty state never claims rules are empty", () => {
  const ordinary = { ...gateAsk("ordinary", 1, "agent:main"), body: { ...gateAsk("ordinary", 1).body, from: "service:gate" } };
  let view = fold(initialView(), ordinary);
  view = fold(view, gateAsk("gate", 2));
  assert.deepEqual(approvalSections(view, 9000).pending, [], "at the exact expiry no action is displayed");
  const { nodes } = draw({ asks: [{ id: "legacy", seq: 3, state: "pending", title: "Legacy", expires_at: 9000, options: [{ id: "deny", label: "No" }] }] });
  assert.equal(nodes.some((node) => node.tag === "article"), false);
  assert.match(nodes.map((node) => node.textContent).join(" "), /看不出来自哪里/);
  assert.match(nodes.map((node) => node.textContent).join(" "), /暂时读不到/);
});

test("malformed raw options cannot be laundered into a valid approval by projection", () => {
  const invalid = gateAsk("invalid-raw", 1);
  invalid.body.options = [{ id: "once", label: "Once" }, { id: 23, label: "Malformed" }];
  let view = fold(initialView(), invalid);
  view = fold(view, gateAsk("valid-control", 2));
  assert.deepEqual(view.asks.find((ask) => ask.id === "invalid-raw").options, [{ id: "once", label: "Once" }], "ordinary conversation still retains its safe option");
  assert.deepEqual(view.conversation.find((item) => item.id === "invalid-raw").ask.options, [{ id: "once", label: "Once" }]);
  assert.equal(view.asks.find((ask) => ask.id === "invalid-raw").options_valid, false);
  assert.equal(view.asks.find((ask) => ask.id === "valid-control").options_valid, true);
  const { sections, nodes } = draw(view);
  assert.deepEqual(sections.pending.map((ask) => ask.id), ["valid-control"]);
  assert.deepEqual(nodes.filter((node) => node.tag === "article").map((node) => node.dataset.askId), ["valid-control"]);
});

test("the read-only sheet limits text, rejects malformed option sets and never renders raw markup", () => {
  const view = { asks: [
    { id: "safe", seq: 2, from: "service:gate", state: "pending", options_valid: true, title: "<script>".repeat(100), detail: "synthetic", expires_at: 9000,
      options: [{ id: "once", label: "Once" }, { id: "deny", label: "Deny" }] },
    { id: "duplicate-option", seq: 3, from: "service:gate", state: "pending", options_valid: true, expires_at: 9000,
      options: [{ id: "once", label: "One" }, { id: "once", label: "Another" }] },
    { id: "invented", seq: 4, from: "service:gate", state: "pending", options_valid: true, expires_at: 9000, options: [{ id: "admin", label: "Admin" }] },
    { id: "mixed", seq: 5, from: "service:gate", state: "pending", options_valid: true, expires_at: 9000,
      options: [{ id: "once", label: "Once" }, { id: "admin", label: "Admin" }] },
    { id: "safe", seq: 6, from: "service:gate", state: "pending", options_valid: true, expires_at: 9000,
      options: [{ id: "always", label: "Always" }] },
  ] };
  const { sections, nodes } = draw(view);
  assert.deepEqual(sections.pending.map((ask) => ask.id), ["safe"]);
  assert.equal(sections.pending[0].title.length, 240);
  assert.equal(nodes.some((node) => node.tag === "script" || node.tag === "button"), false);
  assert.match(nodes.find((node) => node.tag === "article").textContent, /<script>/);
});

test("answer sends only an original gate option from the current screen and waits for its exact ledger response", async () => {
  const ask = approvalSections(fold(initialView(), gateAsk("gate-live", 7)), 5000).pending[0];
  const sent = [];
  const ledger = new Map();
  const net = { token: "token-r", screen: "screen:remote", currentScope: "scope-r", generation: 2,
    request: async (_path, options) => {
      sent.push({ ...options, wire: JSON.parse(options.body) });
      ledger.set("response-1", { id: "response-1", seq: 8, from: "person:owner", to: "service:gate",
        kind: "response", word: "ask", reply_to: ask.id, origin: { screen: net.screen, label: "Remote" },
        body_summary: { ok: true, result: { choice: "once" } } });
      return { ok: true, json: async () => ({ id: "response-1", seq: 8 }) };
    } };
  const result = await answerGateAsk(net, () => true, ask, "once", "stable-1", (id) => ledger.get(id), { now: () => 5000 });
  assert.deepEqual(result, { id: "response-1", seq: 8 });
  assert.equal(sent[0].headers["Ash-Screen"], "token-r");
  assert.deepEqual(sent[0].wire, { to: "service:gate", kind: "response", word: "ask", reply_to: "gate-live",
    body: { ok: true, result: { choice: "once" } }, client_id: "stable-1" });
  assert.equal(Object.hasOwn(sent[0].wire, "local_management"), false);
  await assert.rejects(answerGateAsk(net, () => true, ask, "always", "stable-2", () => null, { now: () => 5000 }), /选项不可用/);
  assert.equal(sent.length, 1, "unoffered choice has zero network calls");
});

test("expired, forged, stale or mismatched ledger answers cannot be marked confirmed", async () => {
  const ask = approvalSections(fold(initialView(), gateAsk("gate-live", 7)), 5000).pending[0];
  let calls = 0;
  const net = { token: "token-r", screen: "screen:remote", currentScope: "scope-r", generation: 2,
    request: async () => { calls++; return { ok: true, json: async () => ({ id: "response-1", seq: 8 }) }; } };
  await assert.rejects(answerGateAsk(net, () => true, ask, "once", "stable", () => null, { now: () => 9000 }), /已失效/);
  await assert.rejects(answerGateAsk(net, () => true, { ...ask, from: "agent:main" }, "once", "stable", () => null, { now: () => 5000 }), /已失效/);
  assert.equal(calls, 0);
  const fake = { id: "response-1", seq: 8, from: "person:owner", to: "service:gate", kind: "response",
    word: "ask", reply_to: ask.id, origin: { screen: "screen:other" }, body_summary: { ok: true, result: { choice: "once" } } };
  await assert.rejects(answerGateAsk(net, () => true, ask, "once", "stable", () => fake,
    { now: () => 5000, maxWaitMs: 0 }), /权威记录/);
  assert.equal(calls, 1);
  net.request = async () => { calls++; net.currentScope = "scope-other"; return { ok: true, json: async () => ({ id: "response-1", seq: 8 }) }; };
  await assert.rejects(answerGateAsk(net, () => true, ask, "once", "stable", () => fake,
    { now: () => 5000, maxWaitMs: 0 }), /屏幕身份/);
  assert.equal(calls, 2);
});

test("5xx, timeout and rate limiting are unknown ACKs, not definitive rejection", async () => {
  const ask = approvalSections(fold(initialView(), gateAsk("gate-live", 7)), 5000).pending[0];
  const net = { token: "token-r", screen: "screen:remote", currentScope: "scope-r", generation: 2,
    request: async () => ({ ok: false, status: 503 }) };
  for (const status of [503, 408, 429]) {
    net.request = async () => ({ ok: false, status });
    await assert.rejects(answerGateAsk(net, () => true, ask, "once", "stable", () => null, { now: () => 5000 }), /回执未知.*原样重试/);
  }
  net.request = async () => ({ ok: false, status: 403 });
  await assert.rejects(answerGateAsk(net, () => true, ask, "once", "stable", () => null, { now: () => 5000 }), /无权回答/);
});

test("history says when she judged an action herself and why; a capability-wide rule names no object", () => {
  globalThis.document = { createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment") };
  try {
    const root = new Node("root");
    renderApprovalsSheet(root, initialView(), { now: 5000, rules: [
      { id: "rule-star", to: "device:phone", word: "file.delete", object_pattern: "*", risk: "outward", expires_at: 90_000 },
    ], history: [
      { id: "h-review", source: "current", request_id: "m_1", to: "device:phone", word: "browser.click", risk: "outward",
        decision: "review", reason: "你让她打开推特，你来登录", at: 4000 },
      { id: "h-carry", source: "current", request_id: "m_2", to: "device:phone", word: "browser.click", risk: "outward",
        decision: "carry", reason: "你几分钟前刚允许过同样的操作", at: 4500 },
      { id: "h-once", source: "current", request_id: "m_3", to: "device:phone", word: "shell.run", risk: "structure", decision: "once", at: 4800 },
    ] });
    const text = root.textContent;
    assert.match(text, /在网页上点击由她判断后放行 · .*你让她打开推特，你来登录/);
    assert.match(text, /刚允许过，沿用 · .*你几分钟前刚允许过同样的操作/);
    assert.match(text, /执行命令仅这一次/);
    assert.doesNotMatch(text, /\*/);
  } finally { delete globalThis.document; }
});

test("a history record opens to its evidence: what was done, what the reviewer saw and said, the card, the answer, and whether it ran", () => {
  globalThis.document = { createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment") };
  try {
    const history = [{ id: "h1", request_id: "r1", source: "current", word: "clipboard.set", risk: "outward", label: "改剪贴板", decision: "review", reason: "你要的", at: 4000 },
      { id: "h2", request_id: "r2", source: "current", word: "rules.set", risk: "structure", decision: "deny", at: 4100 }];
    const opened = [];
    const evidence = new Map([["r1", { status: "ready", entry: { request_id: "r1", requester: "agent:main", word: "clipboard.set", label: "改剪贴板", effect: "act",
      content: "开会", facts: { owner_said: ["把开会复制一下"], context: ["read 日历"] }, review: { decision: "allow", reason: "主人明确要求", ms: 1200 },
      decision: "review", decided_by: "review", executed: { ok: true } } }], ["r2", { status: "missing" }]]);
    const root = new Node("root");
    renderApprovalsSheet(root, { asks: [] }, { now: 5000, history, rules: [], name: "小安", evidence, onEvidence: (id) => opened.push(id) });
    const all = root.children[0].textContent;
    for (const expected of ["小安", "改剪贴板（操作）", "开会", "「把开会复制一下」", "read 日历", "可以直接做，用了 1.2 秒：主人明确要求", "裁判看到的前几步", "裁判（模型判断）", "做成了", "收起", "修改审批规则", "没有留下依据"])
      assert.ok(all.includes(expected), expected);
    const find = (node, label) => node.tag === "button" && node.value === label ? node : node.children.map((child) => find(child, label)).find(Boolean);
    find(root.children[0], "收起").listeners.click();
    assert.deepEqual(opened, ["r1"]);
    const closed = new Node("root");
    renderApprovalsSheet(closed, { asks: [] }, { now: 5000, history, rules: [], evidence: new Map(), onEvidence: () => {} });
    assert.ok(closed.children[0].textContent.includes("查看依据"));
    assert.ok(!closed.children[0].textContent.includes("裁判结论"));
  } finally { delete globalThis.document; }
});
