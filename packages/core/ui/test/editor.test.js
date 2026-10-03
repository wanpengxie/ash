import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ManagedMarkdownEditor, createSelfScreenSender } from "../js/editor.js";
import { IdentitySheet } from "../js/sheet-identity.js";
import { MemorySheet } from "../js/sheet-memory.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, handler) { this.listeners[name] = handler; }
  set textContent(value) { this.value = value; this.children = []; }
  get textContent() { return (this.value ?? "") + this.children.map((child) => child.textContent).join(""); }
}
const digest = (text) => createHash("sha256").update(text).digest("hex");
const ok = (result) => ({ reply: { body: { ok: true, result } } });
const fail = (code, message) => ({ reply: { body: { ok: false, error: { code, message } } } });
async function dom(run) {
  globalThis.document = { createElement: (tag) => new Element(tag), createDocumentFragment: () => new Element("fragment") };
  try { return await run(new Element("root")); }
  finally { delete globalThis.document; }
}

test("managed editor keeps a dirty draft on stale write and never uses file PUT", () => dom(async (root) => {
  let content = "before\n";
  const calls = [];
  const send = async (request) => {
    calls.push(request);
    if (request.word === "read") return ok({ content, hash: digest(content) });
    if (request.word === "write") {
      if (request.body.expected_hash !== digest(content)) return fail("bad_request", "stale");
      content = request.body.content;
      return ok({ hash: digest(content) });
    }
    throw new Error("unexpected word");
  };
  const editor = new ManagedMarkdownEditor(root, { path: "SOUL.md", send, idFactory: () => "save-1" });
  await editor.load();
  editor.setDraft("owner draft\n");
  content = "background update\n";
  await assert.rejects(editor.save(), /刚在别处改过，未覆盖/);
  assert.equal(content, "background update\n");
  assert.equal(editor.draft, "owner draft\n");
  assert.equal(editor.conflict, true);
  assert.deepEqual(calls.map((item) => item.word), ["read", "write"]);
  assert.equal(calls[1].body.expected_hash, digest("before\n"));
  await assert.rejects(editor.save(), /请先重新读取/);
  await editor.load({ discardDraft: true });
  assert.equal(editor.draft, "background update\n");
}));

test("USER write verifies the server's canonical versioned content, then keeps it as the new baseline", () => dom(async (root) => {
  let content = null;
  const send = async (request) => {
    if (request.word === "read") return content === null ? fail("not_found", "missing") : ok({ content, hash: digest(content), version: 1 });
    assert.equal(request.word, "write");
    assert.equal(request.body.expected_hash, null);
    content = `---\nversion: 1\nupdated: 2026-10-01T00:00:00.000Z\n---\n${request.body.content}`;
    return ok({ hash: digest(content), version: 1 });
  };
  const editor = new ManagedMarkdownEditor(root, { path: "USER.md", send });
  await editor.load();
  editor.setDraft("Synthetic owner fact\n");
  await editor.save();
  assert.equal(editor.conflict, false);
  assert.equal(editor.unverified, false);
  assert.equal(editor.content, content);
  assert.equal(editor.draft, content);
  assert.equal(editor.version, 1);
  assert.equal(editor.status, "已保存。");
}));

test("uncertain write ACK reuses the same client id and exact payload", () => dom(async (root) => {
  let content = "old";
  const calls = [];
  let loseAck = true;
  const send = async (request) => {
    calls.push(request);
    if (request.word === "read") return ok({ content, hash: digest(content) });
    if (request.word === "write") {
      if (loseAck) { loseAck = false; content = request.body.content; throw new Error("lost ACK"); }
      return ok({ hash: digest(content) });
    }
    throw new Error("unexpected");
  };
  const editor = new ManagedMarkdownEditor(root, { path: "IDENTITY.md", send, idFactory: () => "stable-id" });
  await editor.load();
  editor.setDraft("new");
  await assert.rejects(editor.save(), /lost ACK/);
  await assert.rejects(editor.load({ discardDraft: true }), /还没确认/);
  await editor.save();
  assert.deepEqual(calls.filter((item) => item.word === "write"), [calls[1], calls[1]]);
  assert.equal(calls[1].client_id, "stable-id");
  assert.equal(editor.unverified, false);
}));

test("rollback requires explicit confirmation, sends L030 baseline hash, and retains stale state", () => dom(async (root) => {
  let content = "current";
  let confirmation = false;
  const calls = [];
  const send = async (request) => {
    calls.push(request);
    if (request.word === "read") return ok({ content, hash: digest(content), version: 2 });
    if (request.word === "history") return ok({ versions: [{ ts: 100, hash: digest("old") }] });
    if (request.word === "rollback") {
      if (request.body.expected_hash !== digest(content)) return fail("bad_request", "stale");
      content = "old";
      return ok({});
    }
    throw new Error("unexpected");
  };
  const editor = new ManagedMarkdownEditor(root, { path: "USER.md", send,
    confirmRollback: () => confirmation, idFactory: () => "rollback-1" });
  await editor.load();
  await editor.history();
  assert.deepEqual(await editor.rollback(100), { cancelled: true });
  assert.equal(calls.some((item) => item.word === "rollback"), false);
  confirmation = true;
  content = "background";
  await assert.rejects(editor.rollback(100), /刚在别处改过，未覆盖/);
  assert.equal(content, "background");
  assert.equal(calls.at(-1).body.expected_hash, digest("current"));
  assert.equal(editor.conflict, true);
  await editor.load({ discardDraft: true });
  await editor.rollback(100);
  assert.equal(content, "old");
  assert.equal(editor.content, "old");
}));

test("identity and memory sheets use only allowlisted managed paths and block dirty tab switches", () => dom(async (root) => {
  const calls = [];
  const send = async (request) => { calls.push(request); return ok({ content: "safe", hash: digest("safe"), version: 1 }); };
  const identity = new IdentitySheet(root, { send });
  await identity.open();
  assert.equal(identity.active, "SOUL.md");
  identity.editor.setDraft("dirty");
  await assert.rejects(identity.open("IDENTITY.md"), /先保存或取消/);
  await assert.rejects(identity.open("../secret"), /unknown/);
  assert.equal(calls.length, 1);
  const memory = new MemorySheet(root, { send });
  await memory.open();
  assert.equal(memory.active, "USER.md");
  await memory.open("MEMORY.md");
  assert.equal(calls.at(-1).body.path, "MEMORY.md");
}));

test("screen sender requires live registration and rejects scope switch before trusting a reply", async () => {
  const requests = [];
  const paired = (word = "read", from = "service:self") => ({ id: "request-id", reply: {
    kind: "response", reply_to: "request-id", from, to: "person:owner", word, body: { ok: true, result: {} } } });
  const net = { token: null, screen: null, currentScope: null, request: async (_path, options) => {
    requests.push(options);
    return { ok: true, json: async () => paired() };
  } };
  const send = createSelfScreenSender(net);
  const wire = { to: "service:self", kind: "request", word: "read", body: { path: "SOUL.md" }, wait: true };
  await assert.rejects(send(wire), /还没连上/);
  assert.equal(requests.length, 0);
  net.token = "screen-token"; net.screen = "screen:a"; net.currentScope = "scope-a";
  await assert.rejects(send({ ...wire, to: "device:unrelated" }), /unsupported/);
  await send(wire);
  assert.equal(requests[0].headers["Ash-Screen"], "screen-token");
  await assert.rejects(send({ ...wire, word: "write" }), /才能修改/);
  net.request = async () => { net.currentScope = "scope-b"; return { ok: true, json: async () => paired() }; };
  await assert.rejects(send(wire), /连接已经换过/);
  net.currentScope = "scope-a";
  net.request = async () => ({ ok: true, json: async () => { net.screen = "screen:b"; return paired(); } });
  await assert.rejects(send(wire), /连接已经换过/, "JSON parse after a registration change is not trusted");
  net.screen = "screen:a";
  net.request = async () => ({ ok: true, json: async () => paired("read", "agent:main") });
  await assert.rejects(send(wire), /没有收到确认/, "a response from the wrong member is not a file result");
});

function findAll(element, predicate) {
  return [...(predicate(element) ? [element] : []), ...(element.children ?? []).flatMap((child) => findAll(child, predicate))];
}

test("the file reads as a card; editing sits behind 编辑 and the page never shows hashes or version jargon", () => dom(async (root) => {
  let content = "---\nversion: 2\nupdated: 2026-10-01T00:00:00.000Z\n---\n# 关于你\n- 喜欢清晨跑步\n";
  const send = async (request) => {
    if (request.word === "read") return ok({ content, hash: digest(content), version: Number(/version: (\d+)/.exec(content)[1]) });
    if (request.word === "history") return ok({ versions: [{ ts: 100, hash: digest("old") }] });
    if (request.word === "write") {
      content = `---\nversion: 3\nupdated: 2026-10-02T00:00:00.000Z\n---\n${request.body.content.replace(/^---\n[\s\S]*?\n---\n/, "")}`;
      return ok({ hash: digest(content), version: 3 });
    }
    throw new Error("unexpected");
  };
  const editor = new ManagedMarkdownEditor(root, { path: "USER.md", send });
  await editor.load();
  const by = (className) => findAll(root, (item) => String(item.className ?? "").split(" ").includes(className))[0];
  assert.equal(by("markdown-source").hidden, true, "the source is not shown until the owner asks to edit");
  assert.equal(by("editor-edit").hidden, false);
  assert.match(by("doc-body").textContent, /关于你.*喜欢清晨跑步/s);
  assert.doesNotMatch(by("doc-body").textContent, /version:|updated:/, "the USER header is not part of the reading view");
  assert.equal(by("markdown-source").value, "# 关于你\n- 喜欢清晨跑步\n", "the header stays out of the text box");
  assert.match(by("editor-version").textContent, /第 2 版/);
  await editor.history();
  assert.doesNotMatch(root.textContent, new RegExp(digest("old").slice(0, 12)), "snapshot rows never show hashes");
  assert.doesNotMatch(root.textContent, /哈希|核对版本|快照|HTTP/);
  await by("editor-edit").listeners.click();
  assert.equal(editor.editing, true);
  assert.equal(by("markdown-source").hidden, false);
  const source = by("markdown-source");
  source.value = "# 关于你\n- 喜欢傍晚散步\n";
  source.listeners.input();
  assert.match(editor.draft, /^---\nversion: 2\n/, "the server header is kept so the guarded write sees the same baseline");
  await editor.save();
  assert.equal(editor.editing, false, "a confirmed save returns to the reading view");
  assert.equal(by("editor-status").textContent, "已保存。");
  assert.match(by("doc-body").textContent, /傍晚散步/);
  assert.match(by("editor-version").textContent, /第 3 版/);
  await by("editor-edit").listeners.click();
  by("markdown-source").value = "scratch";
  by("markdown-source").listeners.input();
  by("editor-cancel").listeners.click();
  assert.equal(editor.editing, false);
  assert.equal(editor.draft, editor.content, "cancel discards the local draft only");
}));

test("a read-only screen shows the file without an edit button", () => dom(async (root) => {
  const send = async () => ok({ content: "沉着、好奇", hash: digest("沉着、好奇") });
  const editor = new ManagedMarkdownEditor(root, { path: "SOUL.md", send, canEdit: false });
  await editor.load();
  const by = (className) => findAll(root, (item) => String(item.className ?? "").split(" ").includes(className))[0];
  assert.equal(by("editor-edit").hidden, true);
  assert.equal(by("editor-save").disabled, true);
  assert.match(root.textContent, /沉着、好奇.*只能在她所在的那台手机上修改/s);
}));
