import assert from "node:assert/strict";
import test from "node:test";
import { ScreenNet, parseSse, readSse } from "../js/net.js";
import { Timeline, render } from "../js/app.js";

const storage = () => {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
};
const message = (seq) => ({ seq, id: `m${seq}`, ts: seq, kind: "request", from: "person:owner", to: "agent:main", word: "say", body: { text: `text ${seq}` } });

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

test("registration precedes queued send and same client_id survives retry", async () => {
  const calls = [];
  let fail = true;
  const net = new ScreenNet({ storage: storage(), fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (fail) { fail = false; throw new Error("offline"); }
    return new Response(JSON.stringify({ id: "m1", seq: 1 }), { status: 200 });
  } });
  net.enqueueSay("queued");
  assert.equal(calls.length, 0);
  net.frame({ type: "screen.registered", data: JSON.stringify({ screen: "screen:a", token: "secret", label: "Tab" }) }, net.generation);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.equal(net.queue.length, 1);
  await net.flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers["Ash-Screen"], "secret");
  assert.equal(JSON.parse(calls[0].init.body).client_id, JSON.parse(calls[1].init.body).client_id);
  assert.equal(net.queue.length, 0);
});

test("local outbox stays unsent offline, keeps one client id across retry, then yields to its ledger id", async () => {
  const saved = storage();
  const sent = [];
  let fail = true;
  const net = new ScreenNet({ storage: saved, fetchImpl: async (_url, init) => {
    sent.push(JSON.parse(init.body));
    if (fail) { fail = false; throw new Error("offline"); }
    return new Response(JSON.stringify({ id: "m_accepted", seq: 17 }), { status: 200 });
  } });
  const clientId = net.enqueueSay("hello while offline");
  assert.deepEqual(net.outbox.map((item) => item.status), ["unsent"]);
  net.frame({ type: "screen.registered", data: JSON.stringify({ screen: "screen:a", token: "proof", label: "Tab" }) }, net.generation);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(net.outbox.map((item) => item.status), ["unsent"]);
  await net.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[0].client_id, clientId);
  assert.equal(sent[1].client_id, clientId);
  assert.equal(net.queue.length, 0);
  assert.deepEqual(net.outbox.map((item) => [item.status, item.id]), [["accepted", "m_accepted"]]);
  net.frame({ type: "message", id: "17", data: JSON.stringify({ ...message(17), id: "m_accepted" }) }, net.generation);
  assert.deepEqual(net.outbox, []);
  assert.deepEqual(new ScreenNet({ storage: saved, fetchImpl: async () => new Response("{}") }).outbox, []);
});

test("missing acknowledgement cannot drop a pending message", async () => {
  const net = new ScreenNet({ storage: storage(), fetchImpl: async () => new Response("{}", { status: 200 }) });
  const id = net.enqueueSay("must retry");
  net.frame({ type: "screen.registered", data: JSON.stringify({ screen: "screen:a", token: "proof", label: "Tab" }) }, net.generation);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(net.queue[0].client_id, id);
  assert.equal(net.outbox[0].status, "unsent");
});

test("live cursor advances only from matching id/seq and is sent as Last-Event-ID", async () => {
  const net = new ScreenNet({ storage: storage(), fetchImpl: async () => new Response(null) });
  net.frame({ type: "screen.registered", data: JSON.stringify({ screen: "screen:a", token: "a", label: "Tab" }) }, net.generation);
  net.frame({ type: "message", id: "7", data: JSON.stringify(message(6)) }, net.generation);
  assert.equal(net.cursor, null);
  net.frame({ type: "message", id: "7", data: JSON.stringify(message(7)) }, net.generation);
  assert.equal(net.cursor, 7);
  net.stop();
});

test("unregistered presence service HTTP 404 is not a successful heartbeat", async () => {
  const net = new ScreenNet({ storage: storage(), fetchImpl: async () => new Response('{"error":"not_found"}', { status: 404 }) });
  net.frame({ type: "screen.registered", data: JSON.stringify({ screen: "screen:a", token: "a", label: "Tab" }) }, net.generation);
  assert.deepEqual(await net.sendEvent("service:post", "visible"), { ok: false, reason: "HTTP 404" });
});

test("UI transport rejects routes outside the documented stream/send pair", () => {
  const calls = [];
  const net = new ScreenNet({ storage: storage(), fetchImpl: async (url) => { calls.push(url); return new Response("{}"); } });
  assert.throws(() => net.request("/api/settings"), /unapproved/);
  assert.throws(() => net.request("https://elsewhere.example/api/stream"), /unapproved/);
  assert.throws(() => net.request("/api/send", { method: "GET" }), /unapproved/);
  assert.equal(calls.length, 0);
});

test("ui.open reply is restricted to the registered target and uses stable response identity", async () => {
  const calls = [];
  const net = new ScreenNet({ storage: storage(), fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response("{}", { status: 200 }); } });
  net.frame({ type: "screen.registered", data: JSON.stringify({ screen: "screen:one", token: "proof", label: "One" }) }, net.generation);
  const request = { id: "m_123", kind: "request", word: "ui.open", from: "agent:main", to: "screen:other" };
  assert.equal(await net.respondOpen(request, true), false);
  assert.equal(calls.length, 0);
  request.to = "screen:one";
  assert.equal(await net.respondOpen(request, false), true);
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual({ to: sent.to, kind: sent.kind, word: sent.word, reply_to: sent.reply_to, body: sent.body, client_id: sent.client_id },
    { to: "agent:main", kind: "response", word: "ui.open", reply_to: "m_123", body: { ok: true, result: { opened: false } }, client_id: "ui-open:m_123" });
  assert.equal(calls[0].init.headers["Ash-Screen"], "proof");
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
  resolveOld([message(198), message(199), message(199), message(200)]);
  assert.equal(await pending, 0);
  assert.deepEqual([...timeline.records.keys()], [300]);
  net.page = async () => [message(297), message(296), message(297), message(298), message(299)];
  assert.equal(await timeline.older(), 5);
  assert.deepEqual(timeline.view.conversation.map((item) => item.seq), [296, 297, 298, 299, 300]);
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
