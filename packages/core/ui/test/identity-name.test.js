import assert from "node:assert/strict";
import test from "node:test";
import { IdentityName, nameFromIdentity } from "../js/identity-name.js";

const reply = (content, id = "read-a") => ({ ok: true, json: async () => ({ id, reply: {
  kind: "response", reply_to: id, from: "service:self", to: "person:owner", word: "read",
  body: { ok: true, result: { path: "IDENTITY.md", content, hash: "a".repeat(64) } },
} }) });
const net = (request) => ({ token: "token-a", screen: "screen:a", currentScope: "scope-a", generation: 1,
  localManagement: false, request });

test("identity name parser keeps only one short visible field", () => {
  assert.equal(nameFromIdentity("# 我的名片\n- 名字：ash（初次见面时可以换成你喜欢的名字）\n- 签名表情：🌿\n"), "ash");
  assert.equal(nameFromIdentity("- 名字：小舟\n"), "小舟");
  assert.equal(nameFromIdentity("- Name: River\n"), "River");
  assert.equal(nameFromIdentity("- 名字：小舟（副本）\n"), "小舟（副本）");
  assert.equal(nameFromIdentity("- Name: Ash (Beta)\n"), "Ash (Beta)");
  assert.equal(nameFromIdentity("- 名字：\n"), null);
  assert.equal(nameFromIdentity("- 名字：一\n- Name: Two\n"), null);
  assert.equal(nameFromIdentity(`- 名字：${"x".repeat(33)}`), null);
  assert.equal(nameFromIdentity(`- 名字：小舟\n${".".repeat(65_537)}`), null);
  assert.equal(nameFromIdentity("- 名字：<script>"), null);
  assert.equal(nameFromIdentity("plain prose"), null);
});

test("registered screen reads canonical identity and refreshes only on trusted change", async () => {
  let content = "- 名字：小舟\n";
  const calls = [];
  const screen = net(async (path, options) => {
    calls.push({ path, wire: JSON.parse(options.body), token: options.headers["Ash-Screen"] });
    return reply(content);
  });
  const visible = [];
  const name = new IdentityName(screen, (value) => visible.push(value));
  await name.refresh();
  assert.equal(visible.at(-1), "小舟");
  assert.equal(calls[0].path, "/api/send");
  assert.deepEqual(calls[0].wire, { to: "service:self", kind: "request", word: "read", body: { path: "IDENTITY.md" }, wait: true });
  assert.equal(calls[0].token, "token-a");
  name.changed({ kind: "event", from: "agent:main", word: "self.changed", body: { path: "IDENTITY.md" } });
  name.changed({ kind: "event", from: "service:self", word: "self.changed", body: { path: "USER.md" } });
  name.changed({ kind: "event", from: "service:self", word: "self.changed", body_summary: { path: "IDENTITY.md" } }, true);
  assert.equal(calls.length, 1);
  content = "- Name: River\n";
  name.changed({ kind: "event", from: "service:self", word: "self.changed", summary: true,
    body_summary: { path: "IDENTITY.md", summary: "forged name" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(visible.at(-1), "River");
});

test("same-screen change keeps the previous verified name until read-back, then fails closed", async () => {
  let release;
  const screen = net(async () => release ? new Promise((resolve) => { release = resolve; }) : reply("- 名字：小舟\n"));
  const visible = [];
  const name = new IdentityName(screen, (value) => visible.push(value));
  await name.refresh();
  assert.equal(visible.at(-1), "小舟");
  release = () => {};
  name.changed({ kind: "event", from: "service:self", word: "self.changed", body_summary: { path: "IDENTITY.md" } });
  assert.equal(visible.at(-1), "小舟");
  release(reply("- 名字：小舟（副本）\n", "read-new"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(visible.at(-1), "小舟（副本）");
  name.changed({ kind: "event", from: "service:self", word: "self.changed", body_summary: { path: "IDENTITY.md" } });
  assert.equal(visible.at(-1), "小舟（副本）");
  release({ ok: false, status: 503 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(visible.at(-1), "Ash");
});

test("newer canonical read wins over an older same-screen response", async () => {
  let releaseOld;
  let calls = 0;
  const screen = net(async () => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { releaseOld = resolve; });
    return reply("- 名字：新名字\n", "read-new");
  });
  const visible = [];
  const name = new IdentityName(screen, (value) => visible.push(value));
  const old = name.refresh();
  await name.refresh();
  assert.equal(visible.at(-1), "新名字");
  releaseOld(reply("- 名字：旧名字\n", "read-old"));
  await old;
  assert.equal(visible.at(-1), "新名字");
});

test("missing, malformed, changed scope and delayed reply never preserve old name", async () => {
  let release;
  const screen = net(async () => new Promise((resolve) => { release = resolve; }));
  const visible = [];
  const name = new IdentityName(screen, (value) => visible.push(value));
  const pending = name.refresh();
  screen.currentScope = "scope-b";
  name.reset();
  release(reply("- 名字：旧账户\n"));
  await pending;
  assert.equal(visible.at(-1), "Ash");
  screen.request = async () => reply("- 名字：\n");
  await name.refresh();
  assert.equal(visible.at(-1), "Ash");
  screen.request = async () => ({ ok: true, json: async () => ({ id: "read-a", reply: { kind: "response", reply_to: "wrong", from: "service:self", to: "person:owner", word: "read", body: { ok: true, result: { content: "- 名字：假名" } } } }) });
  await name.refresh();
  assert.equal(visible.at(-1), "Ash");
});
