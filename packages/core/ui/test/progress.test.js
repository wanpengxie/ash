import assert from "node:assert/strict";
import test from "node:test";
import { renderProgress } from "../js/progress.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.hidden = false; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value || "") + this.children.map((child) => child.textContent).join(""); }
}

test("progress shows two safe recent steps and elapsed time, then a folded summary", () => {
  globalThis.document = { createElement: (tag) => new Node(tag) };
  try {
    const root = new Node("root");
    let opened = "";
    const turn = { title: "查询", started: 1000, steps: [
      { label: "正在理解", ts: 1200 },
      { label: "service:self · write", requestId: "tool", ts: 2000 },
      { label: "正在查看", ts: 2500 },
      { label: "正在整理", ts: 3000 },
    ] };
    renderProgress(root, { turns: { t_one: turn } }, { now: 5000, onOpen: (id) => { opened = id; } });
    assert.equal(root.hidden, false);
    assert.match(root.textContent, /正在查看 · 正在整理 · 4 秒/);
    assert.doesNotMatch(root.textContent, /service:self|write|正在理解/);
    root.children[0].listeners.click();
    assert.equal(opened, "t_one");
    turn.ended = 6000;
    renderProgress(root, { turns: { t_one: turn } }, { now: 7000 });
    assert.match(root.textContent, /做了 3 步 · 5 秒 · 查看活动/);
    renderProgress(root, { turns: { t_one: turn } }, { now: 70_000 });
    assert.equal(root.hidden, true);
  } finally { delete globalThis.document; }
});
