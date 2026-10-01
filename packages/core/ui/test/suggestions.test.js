import assert from "node:assert/strict";
import test from "node:test";
import { presentUiOpen } from "../js/suggestions.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  remove() { this.removed = true; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value || "") + this.children.map((child) => child.textContent).join(""); }
}

test("suggested page is visible, opens only on click, and can be dismissed", async () => {
  globalThis.document = { createElement: (tag) => new Node(tag) };
  try {
    const root = new Node("root");
    const opened = []; const answered = [];
    const controls = { open: async (target) => { opened.push(target); return true; }, respond: async (_request, value) => { answered.push(value); } };
    const request = { body: { target: "activity", mode: "suggest" } };
    assert.equal(await presentUiOpen(root, request, controls), true);
    assert.match(root.textContent, /建议查看活动.*打开.*关闭/);
    assert.deepEqual(opened, []);
    assert.deepEqual(answered, [false]);
    await root.children[0].children[1].listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(opened, ["activity"]);
    assert.deepEqual(answered, [false]);
    assert.equal(root.children[0].removed, true);
    await presentUiOpen(root, request, controls);
    await root.children[0].children[2].listeners.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(opened, ["activity"]);
    assert.deepEqual(answered, [false, false]);
  } finally { delete globalThis.document; }
});

test("perform opens directly; unsupported target does not claim success", async () => {
  const opened = []; const answered = [];
  const controls = { open: async (target) => { opened.push(target); return target !== "settings"; }, respond: async (_request, value) => { answered.push(value); } };
  assert.equal(await presentUiOpen(null, { body: { target: "settings", mode: "perform" } }, controls), true);
  assert.deepEqual(answered, [false]);
  assert.equal(await presentUiOpen(null, { body: { target: "unlisted", mode: "perform" } }, controls), false);
  assert.deepEqual(opened, ["settings"]);
});
