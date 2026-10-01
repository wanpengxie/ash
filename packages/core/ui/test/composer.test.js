import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { composerContext } from "../js/composer.js";

class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.hidden = true; }
  append(child) { this.children.push(child); }
  replaceChildren() { this.children = []; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  set textContent(value) { this.value = value; }
  get textContent() { return (this.value || "") + this.children.map((item) => item.textContent).join(""); }
}

test("activity ask prefills an ordinary draft and a removable local context chip", () => {
  globalThis.document = { createElement: (tag) => new Node(tag) };
  try {
    const root = new Node("root");
    const input = { value: "", focus() { this.focused = true; } };
    const context = composerContext(root, input);
    context.askAbout({ turn: "t_one", text: "请问她这件事" });
    assert.equal(input.value, "请问她这件事");
    assert.equal(input.focused, true);
    assert.equal(root.hidden, false);
    assert.equal(root.children[0].dataset.turn, "t_one");
    assert.equal(root.textContent, "关于这件事移除");
    root.children[0].children[0].listeners.click();
    assert.equal(root.hidden, true);
    assert.equal(root.children.length, 0);
    assert.equal(input.value, "请问她这件事", "removing the hint must not discard the draft");
  } finally { delete globalThis.document; }
});

test("conversation has no stop, interrupt, edit, or withdraw control toolbar", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<main id="log"><\/main>/);
  assert.match(html, /<textarea id="t"/);
  assert.match(html, /<button id="send">发送<\/button>/);
  assert.doesNotMatch(html, /id="(?:stop|interrupt|steer|edit|withdraw)"/);
});
