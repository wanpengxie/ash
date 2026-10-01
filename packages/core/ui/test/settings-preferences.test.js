import assert from "node:assert/strict";
import test from "node:test";
import { ProactivePreferences } from "../js/settings-preferences.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = new Map(); this.value = ""; this.disabled = false; }
  append(...items) { this.children.push(...items); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  setAttribute(name, value) { this[name] = value; }
  click() { this.listeners.get("click")?.(); }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

function fixture(handler) {
  globalThis.document = { createElement: (tag) => new Element(tag) };
  const calls = [];
  const net = { token: "token-a", screen: "screen:a", currentScope: "scope-a", localManagement: true,
    async request(route, options) {
      assert.equal(route, "/api/send");
      const wire = JSON.parse(options.body);
      calls.push({ wire, options });
      return handler(wire, options);
    } };
  const editor = new ProactivePreferences(new Element("section"), net, () => true);
  const response = (wire, body) => ({ ok: true, async json() { return { id: "accepted", reply: {
    kind: "response", reply_to: "accepted", from: "service:self", to: "person:owner", word: wire.word, body } }; } });
  return { net, editor, calls, response };
}

test("missing PROACTIVE creates only after paired write and matching readback", async () => {
  let content = null;
  const f = fixture((wire) => {
    if (wire.word === "read") return f.response(wire, content === null
      ? { ok: false, error: { code: "not_found" } } : { ok: true, result: { content, hash: hashB } });
    assert.equal(wire.body.expected_hash, null);
    content = wire.body.content;
    return f.response(wire, { ok: true, result: { hash: hashB } });
  });
  try {
    await f.editor.save();
    assert.equal(f.calls.length, 0, "unread file cannot be overwritten");
    await f.editor.load();
    assert.match(f.editor.status.textContent, /不存在/);
    f.editor.editor.value = "Only important updates.\n";
    await f.editor.save();
    assert.equal(f.editor.status.textContent, "已保存并重新核对。");
    assert.equal(f.calls.filter(({ wire }) => wire.word === "write").length, 1);
    assert.equal(f.calls.at(-1).wire.word, "read");
  } finally { f.editor.dispose(); delete globalThis.document; }
});

test("stale hash never appears saved and does not silently overwrite draft", async () => {
  const f = fixture((wire) => f.response(wire, wire.word === "read"
    ? { ok: true, result: { content: "prior", hash: hashA } }
    : { ok: false, error: { code: "bad_request", message: "stale" } }));
  try {
    await f.editor.load();
    f.editor.editor.value = "new draft";
    await f.editor.save();
    assert.equal(f.calls[1].wire.body.expected_hash, hashA);
    assert.equal(f.editor.editor.value, "new draft");
    assert.match(f.editor.status.textContent, /未覆盖/);
    assert.equal(f.editor.pending, null);
  } finally { f.editor.dispose(); delete globalThis.document; }
});

test("unknown ACK retries exactly the same client_id/content and keeps editor locked", async () => {
  let writes = 0;
  const f = fixture((wire) => {
    if (wire.word === "read") return f.response(wire, { ok: true, result: { content: "prior", hash: hashA } });
    writes++;
    if (writes === 1) throw new Error("synthetic disconnect");
    return f.response(wire, { ok: true, result: { hash: hashB } });
  });
  try {
    await f.editor.load();
    f.editor.editor.value = "new draft";
    await f.editor.save();
    assert.match(f.editor.status.textContent, /未确认/);
    assert.equal(f.editor.editor.disabled, true);
    assert.equal(f.editor.loadButton.disabled, true);
    await f.editor.save();
    const writesSent = f.calls.filter(({ wire }) => wire.word === "write").map(({ wire }) => wire);
    assert.equal(writesSent.length, 2);
    assert.equal(writesSent[0].client_id, writesSent[1].client_id);
    assert.deepEqual(writesSent[0].body, writesSent[1].body);
    assert.notEqual(f.editor.status.textContent, "已保存并重新核对。", "mismatched readback is not success");
  } finally { f.editor.dispose(); delete globalThis.document; }
});

test("remote registration, scope change, and late responses fail closed", async () => {
  let release;
  const f = fixture((wire) => new Promise((resolve) => { release = (body) => resolve(f.response(wire, body)); }));
  try {
    const loading = f.editor.load();
    await tick();
    f.net.currentScope = "scope-b";
    release({ ok: true, result: { content: "private", hash: hashA } });
    await loading;
    assert.equal(f.editor.editor.value, "");
    await f.editor.load();
    assert.equal(f.calls.length, 1);
    f.net.currentScope = "scope-a";
    f.net.localManagement = false;
    await f.editor.save();
    assert.equal(f.calls.length, 1);
  } finally { f.editor.dispose(); delete globalThis.document; }
});

test("unpaired response, HTTP denial, and late write after screen rotation never show saved", async () => {
  let mode = "unpaired";
  let release;
  const f = fixture((wire) => {
    if (wire.word === "read") return f.response(wire, { ok: true, result: { content: "prior", hash: hashA } });
    if (mode === "unpaired") return { ok: true, async json() { return { id: "accepted", reply: {
      kind: "response", reply_to: "different", from: "service:self", to: "person:owner", word: "write",
      body: { ok: true, result: { hash: hashB } } } }; } };
    if (mode === "denied") return { ok: false, status: 403 };
    return new Promise((resolve) => { release = () => resolve(f.response(wire, { ok: true, result: { hash: hashB } })); });
  });
  try {
    await f.editor.load();
    f.editor.editor.value = "draft";
    await f.editor.save();
    assert.match(f.editor.status.textContent, /未确认/);
    mode = "denied";
    await f.editor.save();
    assert.match(f.editor.status.textContent, /未确认/);
    mode = "late";
    const writing = f.editor.save();
    await tick();
    f.net.screen = "screen:b";
    release();
    await writing;
    assert.notEqual(f.editor.status.textContent, "已保存并重新核对。");
    assert.equal(f.editor.current(), false);
  } finally { f.editor.dispose(); delete globalThis.document; }
});
