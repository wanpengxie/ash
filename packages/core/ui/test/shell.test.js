import assert from "node:assert/strict";
import test from "node:test";
import { ScreenNet, parseSse, readSse } from "../js/net.js";
import { Timeline, render } from "../js/app.js";

const storage = () => {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
};
const SCOPE = `v1_${"b".repeat(43)}`;
const registration = (screen = "screen:a", scope = SCOPE) => ({ screen, token: "a".repeat(32), label: "Tab", auth_scope: scope });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
class MemoryPending {
  constructor() { this.items = new Map(); }
  async list(endpoint, scope) { return [...this.items.values()].filter((item) => item.endpoint === endpoint && item.scope === scope); }
  async enqueue(endpoint, scope, wire) {
    const item = { endpoint, scope, wire, client_id: wire.client_id, text: wire.body.text, attachments: [], status: "unsent", id: null, seq: null, leaseOwner: null, leaseUntil: 0 };
    this.items.set(wire.client_id, item); return item;
  }
  async claim(endpoint, scope, owner) {
    const item = [...this.items.values()].find((value) => value.endpoint === endpoint && value.scope === scope && value.wire && !value.id && value.status !== "rejected" && !value.leaseOwner);
    if (!item) return null;
    item.leaseOwner = owner; item.status = "sending"; return { ...item };
  }
  async renew() {}
  async release(item, owner, status) { const saved = this.items.get(item.client_id); if (saved?.leaseOwner === owner) { saved.leaseOwner = null; saved.status = status; } }
  async accept(item, owner, id, seq) { const saved = this.items.get(item.client_id); if (saved?.leaseOwner === owner) { saved.id = id; saved.seq = seq; saved.status = "accepted"; saved.wire = null; saved.leaseOwner = null; } }
  async removeAccepted(_endpoint, _scope, id) { for (const [key, value] of this.items) if (value.id === id) this.items.delete(key); }
}
const netWith = (options = {}) => new ScreenNet({ storage: storage(), pendingStore: new MemoryPending(), ...options });
const message = (seq) => ({ seq, id: `m${seq}`, ts: seq, kind: "request", from: "person:owner", to: "agent:main", word: "say", body: { text: `text ${seq}` } });
const summaryOf = (row) => { const { body, ...rest } = row; return { ...rest, summary: true, body_summary: body }; };

test("old, remote, and malformed registrations never enable management", async () => {
  const calls = [];
  const net = netWith({ fetchImpl: async (...args) => { calls.push(args); return new Response("{}", { status: 403 }); } });
  net.frame({ type: "screen.registered", data: JSON.stringify(registration()) }, net.generation);
  assert.equal(net.token, "a".repeat(32), "an old frame still permits normal chat");
  assert.equal(net.localManagement, false);
  assert.equal((await net.sendAdmin("resume")).reason, "unregistered");
  net.frame({ type: "screen.registered", data: JSON.stringify({ ...registration(), local_management: false }) }, net.generation);
  assert.equal(net.localManagement, false);
  net.frame({ type: "screen.registered", data: JSON.stringify({ ...registration(), local_management: "true" }) }, net.generation);
  assert.equal(net.localManagement, false);
  assert.equal(calls.length, 0);
});

test("resume uses the current Ash-Screen, wait and stable retry id; only a paired paused:false reply succeeds", async () => {
  const calls = [];
  let mode = "missing";
  const net = netWith({ fetchImpl: async (_url, init) => {
    calls.push(init);
    if (mode === "forbidden") return new Response("{}", { status: 403 });
    const sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ id: "request-one", reply: mode === "missing" ? undefined :
      { kind: "response", reply_to: "request-one", from: "service:admin", to: "person:owner", word: sent.word,
        body: { ok: true, result: { paused: mode === "wrong" } } } }), { status: 200 });
  } });
  net.frame({ type: "screen.registered", data: JSON.stringify({ ...registration(), local_management: true }) }, net.generation);
  assert.equal(net.localManagement, true);
  assert.equal((await net.sendAdmin("resume")).ok, false);
  mode = "forbidden";
  assert.equal((await net.sendAdmin("resume")).ok, false);
  mode = "wrong";
  assert.equal((await net.sendAdmin("resume")).ok, false);
  mode = "valid";
  assert.deepEqual(await net.sendAdmin("resume"), { ok: true, paused: false });
  const wires = calls.map((call) => JSON.parse(call.body));
  assert.ok(wires.every((wire) => wire.to === "service:admin" && wire.kind === "request" && wire.word === "resume" && wire.wait === true && wire.body.confirmed === true));
  assert.equal(wires[0].client_id, wires[1].client_id, "unknown acknowledgement permits an explicit same-screen retry");
  assert.equal(wires[2].client_id, wires[3].client_id);
  assert.notEqual(wires[1].client_id, wires[2].client_id, "a definitive 403 retires the intent");
  assert.ok(calls.every((call) => call.headers["Ash-Screen"] === registration().token));
  net.stop();
  assert.equal((await net.sendAdmin("resume")).ok, false);
});

test("management retry identity is confined to one scope, screen, and registration", async () => {
  const sent = [];
  const net = netWith({ fetchImpl: async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "accepted" }), { status: 200 });
  } });
  const register = (screen, scope, token) => net.frame({ type: "screen.registered", data: JSON.stringify({
    ...registration(screen, scope), token, local_management: true,
  }) }, net.generation);
  register("screen:one", SCOPE, "a".repeat(32));
  await net.sendAdmin("resume");
  await net.sendAdmin("resume");
  assert.equal(sent[0].client_id, sent[1].client_id);
  register("screen:two", SCOPE, "b".repeat(32));
  await net.sendAdmin("resume");
  assert.notEqual(sent[1].client_id, sent[2].client_id);
  register("screen:two", SCOPE, "c".repeat(32));
  await net.sendAdmin("resume");
  assert.notEqual(sent[2].client_id, sent[3].client_id);
  register("screen:three", `v1_${"c".repeat(43)}`, "d".repeat(32));
  assert.equal(net.localManagement, false, "scope replacement must re-register before management");
  register("screen:three", `v1_${"c".repeat(43)}`, "d".repeat(32));
  await net.sendAdmin("resume");
  assert.notEqual(sent[3].client_id, sent[4].client_id);
  net.stop();
  assert.equal(net.adminIntent, null);
  register("screen:four", `v1_${"c".repeat(43)}`, "e".repeat(32));
  await net.sendAdmin("resume");
  assert.notEqual(sent[4].client_id, sent[5].client_id);
});

test("SSE parser handles control and bounded ledger frames", async () => {
  assert.deepEqual(parseSse("event: screen.registered\ndata: {\"token\":\"a\"}"), { type: "screen.registered", id: "", data: '{"token":"a"}' });
  const bytes = new TextEncoder().encode(`: keepalive\n\nevent: screen.registered\ndata: {"token":"a"}\n\nid: 3\ndata: ${JSON.stringify(message(3))}\n\n`);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 37)); controller.enqueue(bytes.slice(37)); controller.close(); } });
  const frames = [];
  await readSse(new Response(stream), (frame) => frames.push(frame));
  assert.deepEqual(frames.map((frame) => frame.type), ["message", "screen.registered", "message"]);
  assert.equal(frames[2].id, "3");
});

test("SSE reader preserves CRLF and multibyte UTF-8 across single-byte chunks", async () => {
  const bytes = new TextEncoder().encode('id: 1\r\ndata: {"seq":1,"text":"你好"}\r\n\r\n');
  const stream = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const frames = [];
  await readSse(new Response(stream), (frame) => frames.push(frame));
  assert.equal(frames.length, 1);
  assert.equal(JSON.parse(frames[0].data).text, "你好");
});

test("SSE frame limit counts UTF-8 bytes rather than string characters", async () => {
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("你".repeat(5))); controller.close(); } });
  await assert.rejects(() => readSse(new Response(stream), () => {}, undefined, 14), /stream frame too large/);
  const complete = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${"你".repeat(5)}\n\n`)); controller.close(); } });
  await assert.rejects(() => readSse(new Response(complete), () => {}, undefined, 14), /stream frame too large/);
});

test("registration precedes queued send and same client_id survives retry", async () => {
  const calls = [];
  let fail = true;
  const net = netWith({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (fail) { fail = false; throw new Error("offline"); }
    return new Response(JSON.stringify({ id: "m1", seq: 1 }), { status: 200 });
  } });
  net.frame({ type: "screen.registered", data: JSON.stringify(registration()) }, net.generation);
  net.token = null;
  await net.enqueueSay("queued");
  assert.equal(calls.length, 0);
  net.frame({ type: "screen.registered", data: JSON.stringify(registration()) }, net.generation);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(net.queue.length, 1);
  await net.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers["Ash-Screen"], "a".repeat(32));
  assert.equal(JSON.parse(calls[0].init.body).client_id, JSON.parse(calls[1].init.body).client_id);
  assert.equal(net.queue.length, 0);
});

test("an option click keeps card identity in the same persisted say across offline retry", async () => {
  const sent = [];
  let fail = true;
  const net = netWith({ fetchImpl: async (_url, init) => {
    sent.push(JSON.parse(init.body));
    if (fail) { fail = false; throw new Error("offline"); }
    return new Response(JSON.stringify({ id: "answer", seq: 2 }), { status: 200 });
  } });
  net.frame({ type: "screen.registered", data: JSON.stringify(registration()) }, net.generation);
  net.token = null;
  const id = await net.enqueueSay("Yes", [], { in_reply_to: "card", option_id: "yes" });
  assert.equal(net.outbox[0].in_reply_to, "card");
  net.frame({ type: "screen.registered", data: JSON.stringify(registration()) }, net.generation);
  await tick();
  await net.flush();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((wire) => [wire.client_id, wire.body]), [
    [id, { text: "Yes", in_reply_to: "card", option_id: "yes" }],
    [id, { text: "Yes", in_reply_to: "card", option_id: "yes" }],
  ]);
});

test("local outbox stays unsent offline, keeps one client id across retry, then yields to its ledger id", async () => {
  const saved = storage();
  const sent = [];
  let fail = true;
  const pendingStore = new MemoryPending();
  const net = netWith({ storage: saved, pendingStore, fetchImpl: async (_url, init) => {
    sent.push(JSON.parse(init.body));
    if (fail) { fail = false; throw new Error("offline"); }
    return new Response(JSON.stringify({ id: "m_accepted", seq: 17 }), { status: 200 });
  } });
  net.frame({ type: "screen.registered", data: JSON.stringify(registration()) }, net.generation);
  net.token = null;
  const clientId = await net.enqueueSay("hello while offline");
  assert.deepEqual(net.outbox.map((item) => item.status), ["unsent"]);
  net.frame({ type: "screen.registered", data: JSON.stringify(registration()) }, net.generation);
  await tick();
  assert.deepEqual(net.outbox.map((item) => item.status), ["unsent"]);
  await net.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].client_id, clientId);
  assert.equal(sent[1].client_id, clientId);
  assert.equal(net.queue.length, 0);
  assert.deepEqual(net.outbox.map((item) => [item.status, item.id]), [["accepted", "m_accepted"]]);
  net.frame({ type: "message.summary", id: "17", data: JSON.stringify(summaryOf({ ...message(17), id: "m_accepted" })) }, net.generation);
  assert.deepEqual(net.outbox, []);
  await tick();
  assert.deepEqual((await pendingStore.list("http://local.test", SCOPE)), []);
});

test("missing acknowledgement cannot drop a pending message", async () => {
  const net = netWith({ fetchImpl: async () => new Response("{}", { status: 200 }) });
  net.frame({ type: "screen.registered", data: JSON.stringify(registration()) }, net.generation);
  net.token = null;
  const id = await net.enqueueSay("must retry");
  net.frame({ type: "screen.registered", data: JSON.stringify(registration()) }, net.generation);
  await tick();
  assert.equal(net.queue[0].client_id, id);
  assert.equal(net.outbox[0].status, "unsent");
});

test("live cursor advances only from matching id/seq and is sent as Last-Event-ID", async () => {
  const net = netWith({ fetchImpl: async () => new Response(null) });
  net.frame({ type: "screen.registered", data: JSON.stringify(registration()) }, net.generation);
  net.frame({ type: "message.summary", id: "7", data: JSON.stringify(summaryOf(message(6))) }, net.generation);
  assert.equal(net.cursor, null);
  net.frame({ type: "message.summary", id: "7", data: JSON.stringify(summaryOf(message(7))) }, net.generation);
  assert.equal(net.cursor, 7);
  net.stop();
});

test("a no-id stream error fails closed without advancing the cursor", () => {
  const net = netWith();
  net.frame({ type: "screen.registered", data: JSON.stringify(registration()) }, net.generation);
  assert.throws(() => net.frame({ type: "stream.error", id: "", data: JSON.stringify({ code: "too_large" }) }, net.generation), /stream too_large/);
  assert.equal(net.cursor, null);
  assert.throws(() => net.frame({ type: "stream.error", id: "", data: JSON.stringify({ code: "failed", detail: "secret" }) }, net.generation), /invalid stream error frame/);
});

test("unregistered presence service HTTP 404 is not a successful heartbeat", async () => {
  const net = netWith({ fetchImpl: async () => new Response('{"error":"not_found"}', { status: 404 }) });
  net.frame({ type: "screen.registered", data: JSON.stringify(registration()) }, net.generation);
  assert.deepEqual(await net.sendEvent("service:post", "visible"), { ok: false, reason: "HTTP 404" });
});

test("UI transport rejects routes outside the documented stream/send pair", () => {
  const calls = [];
  const net = netWith({ fetchImpl: async (url) => { calls.push(url); return new Response("{}"); } });
  assert.throws(() => net.request("/api/settings"), /unapproved/);
  assert.throws(() => net.request("https://elsewhere.example/api/stream"), /unapproved/);
  assert.throws(() => net.request("/api/send", { method: "GET" }), /unapproved/);
  assert.equal(calls.length, 0);
});

test("ui.open reply is restricted to the registered target and uses stable response identity", async () => {
  const calls = [];
  const net = netWith({ fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); } });
  net.frame({ type: "screen.registered", data: JSON.stringify(registration("screen:one")) }, net.generation);
  const request = { id: "m_123", kind: "request", word: "ui.open", from: "agent:main", to: "screen:other" };
  assert.equal(await net.respondOpen(request, true), false);
  assert.equal(calls.length, 0);
  request.to = "screen:one";
  assert.equal(await net.respondOpen(request, false), true);
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual({ to: sent.to, kind: sent.kind, word: sent.word, reply_to: sent.reply_to, body: sent.body, client_id: sent.client_id },
    { to: "agent:main", kind: "response", word: "ui.open", reply_to: "m_123", body: { ok: true, result: { opened: false } }, client_id: "ui-open:m_123" });
  assert.equal(calls[0].init.headers["Ash-Screen"], "a".repeat(32));
});

test("older pagination sorts/deduplicates and drops a late prior-session page", async () => {
  let resolveOld;
  const net = { page: () => new Promise((resolve) => { resolveOld = resolve; }) };
  const timeline = new Timeline(net);
  timeline.add(message(201));
  timeline.add(message(202));
  const pending = timeline.older();
  timeline.reset();
  timeline.add(message(300));
  resolveOld({ messages: [message(198), message(199), message(199), message(200)], snapshots: [] });
  assert.equal(await pending, 0);
  assert.deepEqual([...timeline.records.keys()], [300]);
  net.page = async () => ({ messages: [message(297), message(296), message(297), message(298), message(299)], snapshots: [] });
  assert.equal(await timeline.older(), 5);
  assert.deepEqual(timeline.view.conversation.map((item) => item.seq), [296, 297, 298, 299, 300]);
});

test("finite history applies delivery snapshot and say in one render, including an older page", async () => {
  const offer = { seq: 2, id: "m_offer", ts: 2, kind: "request", from: "agent:main", to: "person:owner", word: "say", body: { text: "Only after release", kind: "offer" } };
  const held = { at_seq: 5, items: [{ message_id: offer.id, state: "held", version_seq: 5 }] };
  const released = { at_seq: 9, items: [{ message_id: offer.id, state: "released", version_seq: 9 }] };
  const renders = [];
  const timeline = new Timeline(null, (view) => renders.push(view.conversation.map((bubble) => bubble.text)));
  const sse = (snapshot, rows) => `event: auth.scope\ndata: ${JSON.stringify({ auth_scope: SCOPE })}\n\nevent: post.delivery.snapshot\ndata: ${JSON.stringify(snapshot)}\n\n${rows.map((row) => `id: ${row.seq}\nevent: message.summary\ndata: ${JSON.stringify(summaryOf(row))}\n\n`).join("")}event: stream.page_end\ndata: ${JSON.stringify({ has_more: false, first_seq: rows[0]?.seq ?? null, last_seq: rows.at(-1)?.seq ?? null })}\n\n`;
  const net = netWith({ fetchImpl: async () => new Response(sse(held, [offer, message(3)])), onHistory: (rows, snapshots) => timeline.addMany(rows, snapshots) });
  await net.catchUp(net.generation, new AbortController().signal);
  assert.deepEqual(renders.at(-1), ["text 3"]);
  assert.equal(renders.some((texts) => texts.includes("Only after release")), false);
  timeline.net = { page: async () => ({ messages: [message(1)], snapshots: [released] }) };
  await timeline.older();
  assert.deepEqual(renders.at(-1), ["text 1", "Only after release", "text 3"]);
});

test("credential scope switch discards an old high-cursor page and refetches the new low-seq history", async () => {
  const scopeB = `v1_${"c".repeat(43)}`;
  const old = { ...message(100), body: { text: "old account" } };
  const fresh = { ...message(2), body: { text: "new account" } };
  const timeline = new Timeline(null);
  timeline.add(summaryOf(old));
  const urls = [];
  const sse = (scope, rows) => `event: auth.scope\ndata: ${JSON.stringify({ auth_scope: scope })}\n\n${rows.map((row) => `id: ${row.seq}\nevent: message.summary\ndata: ${JSON.stringify(summaryOf(row))}\n\n`).join("")}event: stream.page_end\ndata: ${JSON.stringify({ has_more: false, first_seq: rows[0]?.seq ?? null, last_seq: rows.at(-1)?.seq ?? null })}\n\n`;
  const net = netWith({ fetchImpl: async (url) => {
    urls.push(url);
    return new Response(url.includes("after=100") ? sse(scopeB, []) : sse(scopeB, [fresh]));
  }, onReset: () => timeline.reset(), onHistory: (rows, snapshots) => timeline.addMany(rows, snapshots) });
  net.currentScope = SCOPE;
  net.cursor = 100;
  net.bootstrapped = true;
  await net.catchUp(net.generation, new AbortController().signal);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /after=100/);
  assert.match(urls[1], /limit=200/);
  assert.equal(net.currentScope, scopeB);
  assert.equal(net.cursor, 2);
  assert.deepEqual(timeline.view.conversation.map((bubble) => bubble.text), ["new account"]);
});

test("legacy sources and two screen labels remain visible as inert text", () => {
  class Node {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0; }
    append(child) { this.children.push(child); }
    replaceChildren(child) { this.children = child.children; }
    set textContent(value) { this.value = value; }
    get textContent() { return this.value ?? this.children.map((child) => child.textContent).join(""); }
  }
  const elements = { "#log": new Node("main"), "#state": new Node("span"), "#face img": new Node("img") };
  globalThis.document = { createElement: (tag) => new Node(tag), createDocumentFragment: () => new Node("fragment"), querySelector: (selector) => elements[selector] };
  try {
    render({ presence: { text: "", avatar: "default" }, conversation: [
      { type: "say", side: "inbound", seq: 1, text: "<unsafe>", from: "agent:old", legacy: { workspace: "old-work", member: "agent:old" } },
      { type: "say", side: "owner", seq: 2, text: "phone", origin: { label: "Phone browser" } },
      { type: "say", side: "owner", seq: 3, text: "desk", origin: { label: "Computer browser" } },
    ] });
    const labels = elements["#log"].children.filter((child) => child.tag === "small").map((child) => child.textContent);
    assert.deepEqual(labels, ["历史记录 · old-work · agent:old · 只读", "来自 Phone browser", "来自 Computer browser"]);
    assert.equal(elements["#log"].children[1].textContent, "<unsafe>");
    assert.equal(elements["#log"].children[1].dataset.readonly, "true");
    assert.equal(elements["#log"].children.some((child) => child.tag === "button"), false);
  } finally { delete globalThis.document; }
});
