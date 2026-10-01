import assert from "node:assert/strict";
import test from "node:test";
import { fold, initialView } from "../js/project.js";
import { approvalSections, renderApprovalsSheet } from "../js/sheet-approvals.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.className = ""; this.value = ""; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
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
  assert.match(nodes.map((node) => node.textContent).join(" "), /完整审批历史尚未连接/);
  assert.match(nodes.map((node) => node.textContent).join(" "), /不能据此判断没有规则/);
});

test("missing or body-spoofed source fails closed and empty state never claims rules are empty", () => {
  const ordinary = { ...gateAsk("ordinary", 1, "agent:main"), body: { ...gateAsk("ordinary", 1).body, from: "service:gate" } };
  let view = fold(initialView(), ordinary);
  view = fold(view, gateAsk("gate", 2));
  assert.deepEqual(approvalSections(view, 9000).pending, [], "at the exact expiry no action is displayed");
  const { nodes } = draw({ asks: [{ id: "legacy", seq: 3, state: "pending", title: "Legacy", expires_at: 9000, options: [{ id: "deny", label: "No" }] }] });
  assert.equal(nodes.some((node) => node.tag === "article"), false);
  assert.match(nodes.map((node) => node.textContent).join(" "), /缺少可验证来源/);
  assert.match(nodes.map((node) => node.textContent).join(" "), /尚未连接/);
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
