import assert from "node:assert/strict";
import test from "node:test";
import { startKernel } from "./kernel.js";
import { netFor, until } from "./support.js";

const ready = async (kernel, options) => {
  const handle = netFor(kernel, options);
  handle.net.start();
  await until(() => handle.net.status === "online" && handle.events.ready > 0, 2000, "online with history");
  return handle;
};
const say = (n, text = `text ${n}`) => ({ from: "person:owner", to: "agent:main", word: "say", body: { text } });

test("the page connects as a browser hand, opens a sync and shows an empty conversation as ready", async () => {
  const kernel = startKernel();
  const { net, events } = await ready(kernel);
  assert.equal(net.local, true);
  assert.match(net.client, /^client:/);
  assert.equal(kernel.sessions[0].hello.hand.kind, "browser");
  assert.deepEqual(Object.keys(kernel.sessions[0].hello.channels), ["human"]);
  assert.equal(kernel.sessions[0].hello.hand.public_key, undefined, "a browser proves nothing itself; the relay vouches for it");
  assert.equal(events.ready, 1);
  assert.deepEqual(kernel.synced[0], { t: "sync", ch: "human", sid: kernel.synced[0].sid, limit: 1, follow: true, summary: true });
  net.stop(); kernel.close();
});

test("history is the newest page, then live messages follow without repeats", async () => {
  const kernel = startKernel();
  for (let n = 1; n <= 3; n++) kernel.append(say(n));
  const { net, events } = await ready(kernel);
  assert.deepEqual(events.histories.flatMap(page => page.items).map((m) => m.seq), [1, 2, 3]);
  kernel.append(say(4));
  await until(() => events.messages.length === 1);
  assert.equal(events.messages[0].message.seq, 4);
  assert.equal(events.messages[0].message.type, "owner.say");
  net.stop(); kernel.close();
});

test("older history pages back from the first seq and says when the start is reached", async () => {
  const kernel = startKernel();
  for (let n = 1; n <= 250; n++) kernel.append(say(n));
  const { net, events } = await ready(kernel);
  assert.equal(events.histories.flatMap(page => page.items).length, 10);
  const first = Math.min(...events.histories.flatMap(page => page.items).map((m) => m.seq));
  assert.equal(first, 241);
  const page = await net.page(first);
  assert.equal(page.items.length, 10);
  assert.equal(page.has_more_before, true);
  assert.deepEqual(page.items.map((m) => m.seq).slice(0, 2), [231, 232]);
  const start = await net.window({ after: 0 });
  assert.equal(start.has_more_before, false);
  net.stop(); kernel.close();
});

test("a message the owner types is kept, sent as `say` with one client_id, and leaves the outbox when the ledger has it", async () => {
  const kernel = startKernel();
  const { net, events } = await ready(kernel);
  const clientId = await net.enqueueSay("hello");
  await until(() => kernel.requests.some((r) => r.word === "say"));
  assert.deepEqual(kernel.requests.find((r) => r.word === "say"), { to: "agent:main", kind: "request", word: "say", body: { text: "hello" }, client_id: clientId });
  await until(() => events.messages.some((entry) => entry.message.type === "owner.say"));
  await until(() => net.outbox.length === 0, 2000, "outbox drained");
  assert.equal(net.queue.length, 0);
  net.stop(); kernel.close();
});

test("sends go to the primary agent the hub names, and to another agent when picked", async () => {
  const kernel = startKernel();
  kernel.on("service:agents", "list", { agents: [{ id: "agent:ash", name: "Ash", summary: "", state: "idle", primary: true }, { id: "agent:other", name: "O", summary: "", state: "idle" }] });
  const { net } = await ready(kernel);
  await until(() => net.primary === "agent:ash");
  await net.enqueueSay("to primary");
  await net.enqueueSay("to other", [], null, "agent:other");
  await until(() => kernel.requests.filter((r) => r.word === "say").length === 2);
  assert.deepEqual(kernel.requests.filter((r) => r.word === "say").map((r) => r.to), ["agent:ash", "agent:other"]);
  net.stop(); kernel.close();
});

test("a lost connection keeps the queue and the retry id; reconnect reads a bounded current window", async () => {
  const kernel = startKernel();
  kernel.append(say(1));
  const { net, events } = await ready(kernel);
  kernel.drop();
  await until(() => events.states.includes("offline"));
  kernel.append(say(2, "while away"));
  const clientId = await net.enqueueSay("typed offline");
  await until(() => net.status === "online", 3000, "reconnect");
  await until(() => events.messages.some((entry) => entry.message.text === "while away") || events.histories.flatMap(page => page.items).some((m) => m.text === "while away"));
  const resumed = kernel.synced.at(-1);
  assert.equal(resumed.after, undefined);
  assert.equal(resumed.limit, 1);
  await until(() => kernel.requests.some((r) => r.client_id === clientId));
  assert.equal(kernel.requests.filter((r) => r.client_id === clientId).length, 1);
  await until(() => net.outbox.length === 0);
  net.stop(); kernel.close();
});

test("the owner answers a question with a response to the ask, and the first answer counts", async () => {
  const kernel = startKernel();
  const { net } = await ready(kernel);
  const ask = kernel.append({ from: "service:gate", to: "person:owner", word: "ask", body: { title: "send it?", human_kind: "confirmation", options: [{ id: "once", label: "允许这一次" }, { id: "deny", label: "不允许" }], expires_at: Date.now() + 1e6 } });
  const answered = await net.answerAsk({ id: ask.id, from: "service:gate" }, { choice: "once" }, "c1");
  assert.deepEqual(answered.error, undefined);
  assert.equal(answered.ok, true);
  const response = kernel.ledger.find((m) => m.kind === "response" && m.reply_to === ask.id);
  assert.deepEqual([response.from, response.to, response.word, response.body], ["person:owner", "service:gate", "ask", { ok: true, result: { data: { choice: "once" } } }]);
  const again = await net.answerAsk({ id: ask.id, from: "service:gate" }, { choice: "deny" }, "c2");
  assert.equal(again.ok, false);
  assert.equal(again.error.code, "conflict");
  net.stop(); kernel.close();
});

test("a confirmation without options is answered yes or no", async () => {
  const kernel = startKernel();
  const { net } = await ready(kernel);
  const ask = kernel.append({ from: "agent:main", to: "person:owner", word: "ask", body: { title: "ok?", human_kind: "confirmation" } });
  assert.equal((await net.answerAsk({ id: ask.id, from: "agent:main" }, { choice: "yes" }, "c1")).ok, true);
  net.stop(); kernel.close();
});

test("the kernel's chat open is handed to the page with its target, id and mode", async () => {
  const kernel = startKernel();
  const { net, events } = await ready(kernel);
  const first = await kernel.present("chat", "open", { target: "settings" });
  assert.deepEqual([first.ok, first.data], [true, { opened: true }]);
  const answer = await kernel.present("chat", "open", { target: "turn", id: "t1", mode: "suggest" });
  assert.equal(answer.ok, true);
  assert.deepEqual(events.presents, [{ target: "settings" }, { target: "turn", id: "t1", mode: "suggest" }]);
  const other = await kernel.present("notification", "hide", { id: "x" });
  assert.equal(other.ok, false);
  const preview = await kernel.present("chat", "card.preview", { card: { type: "a2ui", id: "c1" }, theme: "light" });
  assert.deepEqual([preview.ok, preview.error?.code], [false, "unavailable"], "only the phone draws a card into a picture");
  net.stop(); kernel.close();
});

test("a browser tab says it is in view, and typing to an agent; the app says neither", async () => {
  const kernel = startKernel();
  const { net } = await ready(kernel);
  net.setVisible(true);
  net.setVisible(true);
  net.setTyping(true, "agent:main");
  await until(() => kernel.presence.length === 2);
  assert.deepEqual(kernel.presence.map(({ t, ch, ...rest }) => rest), [{ visible: true }, { typing: true, agent: "agent:main" }]);
  net.stop(); kernel.close();
});

test("a device the owner has not allowed to chat is told why, and does not retry", async () => {
  const kernel = startKernel({ grant: { accepted: false, reason: "the owner has not allowed this device web access" } });
  const handle = netFor(kernel);
  handle.net.start();
  await until(() => handle.net.status === "closed");
  assert.deepEqual(handle.events.states.at(-1), ["closed", "the owner has not allowed this device web access"]);
  kernel.close();
});

test("an option click keeps the card's identity in the same persisted say across an offline retry", async () => {
  const kernel = startKernel();
  const { net, events } = await ready(kernel);
  kernel.drop();
  await until(() => events.states.includes("offline"));
  const id = await net.enqueueSay("Yes", [], { in_reply_to: "card", option_id: "yes" });
  assert.equal(net.outbox[0].in_reply_to, "card");
  await until(() => kernel.requests.some((r) => r.client_id === id), 3000);
  const sent = kernel.requests.filter((r) => r.client_id === id);
  assert.deepEqual(sent.map((r) => r.body), [{ text: "Yes", in_reply_to: "card", option_id: "yes" }]);
  net.stop(); kernel.close();
});

test("an answer without a message id cannot drop a pending message", async () => {
  const kernel = startKernel();
  kernel.on("agent:main", "say", () => ({ accepted: true }));
  const { net } = await ready(kernel);
  const original = net.port.send.bind(net.port);
  net.port.send = async (request) => (request.word === "say" ? { t: "send.result", id: "x", ok: true, message: {} } : original(request));
  const id = await net.enqueueSay("must retry");
  await until(() => net.outbox[0]?.status === "unsent");
  assert.equal(net.queue[0].client_id, id);
  net.stop(); kernel.close();
});

test("with no primary agent known the page sends nothing; the one the hub named last time is used until it names one again", async () => {
  const kernel = startKernel();
  kernel.on("service:agents", "list", { ok: false, error: { code: "unavailable", message: "not yet" } });
  const first = await ready(kernel);
  assert.equal(first.net.primary, null);
  await assert.rejects(first.net.enqueueSay("to whom?"), /不知道该对谁说话/);
  assert.equal(kernel.requests.some((r) => r.word === "say"), false);
  first.net.stop();
  const store = new Map([["ash.primary", "agent:ash"]]);
  globalThis.localStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  try {
    const second = await ready(kernel);
    assert.equal(second.net.primary, "agent:ash");
    await second.net.enqueueSay("to the one remembered");
    await until(() => kernel.requests.some((r) => r.word === "say"));
    assert.equal(kernel.requests.find((r) => r.word === "say").to, "agent:ash");
    kernel.on("service:agents", "list", { agents: [{ id: "agent:new", name: "N", summary: "", state: "idle", primary: true }] });
    second.net.stop();
    const third = await ready(kernel);
    await until(() => third.net.primary === "agent:new");
    assert.equal(store.get("ash.primary"), "agent:new");
    third.net.stop();
  } finally { delete globalThis.localStorage; kernel.close(); }
});
