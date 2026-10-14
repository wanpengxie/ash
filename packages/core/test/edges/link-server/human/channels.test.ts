import assert from "node:assert/strict";
import test from "node:test";
import { eventually } from "../../../fixtures/wait";
import { AGENT, Channel, GATE, quiet, startHumanHub } from "./helpers";

const WIDGETS = { member: "service:widgets", via: "service" as const, local: true };

const open = (body: Record<string, unknown>) => ({ to: "person:owner", kind: "request" as const, word: "open", body });

test("open goes to the channel named, and only there; without one it goes to the channel being looked at", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub, { label: "手机" });
  const web = await Channel.open(hub, { label: "网页", kind: "browser" });

  const named = await hub.mini.send(open({ target: "settings", client: web.clientId }), AGENT);
  assert.deepEqual(named, { ok: true, result: { data: { opened: true } } });
  assert.deepEqual((await web.present((f) => f.surface === "chat" && f.op === "open", "the page on the named channel")).body, { target: "settings" });
  await quiet();
  assert.equal(phone.presents.length, 0, "the other channel was not touched");

  web.presence({ visible: false }); phone.presence({ visible: true });
  await eventually(() => hub.human.clients().find((c) => c.client === phone.clientId)?.visible, "the phone visible");
  await hub.mini.send(open({ target: "turn", id: "t_1", mode: "suggest" }), AGENT);
  const frame = await phone.present((f) => f.surface === "chat" && f.op === "open", "the page where the owner is");
  assert.deepEqual(frame.body, { target: "turn", id: "t_1", mode: "suggest" });
  assert.equal(web.presented("chat", "open").length, 1);

  const gone = await hub.mini.send(open({ target: "settings", client: "client:nobody" }), AGENT);
  assert.ok(!gone.ok && gone.error.code === "offline");
});

test("open reports what the channel says: declined is opened: false, a channel that cannot is an error", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const declines = await Channel.open(hub, { present: () => ({ ok: true, data: { opened: false } }) });
  assert.deepEqual(await hub.mini.send(open({ target: "settings", client: declines.clientId }), AGENT), { ok: true, result: { data: { opened: false } } });
  const cannot = await Channel.open(hub, { present: () => ({ ok: false, error: { code: "unavailable", message: "no such page" } }) });
  const reply = await hub.mini.send(open({ target: "settings", client: cannot.clientId }), AGENT);
  assert.ok(!reply.ok && reply.error.code === "unavailable");
});

test("typing goes to the agent being typed to, once per typing, and to nobody else", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub);

  phone.presence({ typing: true, agent: "agent:main" });
  await eventually(() => hub.mini.sent.length === 1, "the typing event");
  phone.presence({ typing: false, agent: "agent:main" });
  phone.presence({ typing: true });
  phone.presence({ typing: true, agent: "service:vault" });
  phone.presence({ visible: true });
  await quiet();

  assert.equal(hub.mini.sent.length, 1);
  assert.deepEqual(hub.mini.sent[0]!.msg, { to: "agent:main", kind: "event", word: "typing", body: {} });
  assert.equal(hub.mini.sent[0]!.caller.via, "service");
});

test("the owner's words are stamped person:owner with the channel they came from; a remote channel is not local", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub, { label: "手机 · 对话" });
  const remote = await Channel.openRemote(hub, { label: "网页 · 远程" });

  await phone.send({ to: "agent:main", kind: "request", word: "say", body: { text: "近的" } });
  await remote.send({ to: "agent:main", kind: "request", word: "say", body: { text: "远的" } });

  const [near, far] = hub.mini.sent;
  assert.deepEqual(near!.caller, { member: "person:owner", via: "human", local: true, client: phone.clientId,
    origin: { channel: "app", client: phone.clientId, hand: `device:${phone.hand.identity.handId}`, label: "手机 · 对话" } });
  assert.equal(far!.caller.local, false);
  assert.equal(far!.caller.client, remote.clientId);
  assert.equal(far!.caller.origin!.channel, "web");
});

test("no word is local-only: the owner's word from a remote channel passes as from the local one", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub);
  const remote = await Channel.openRemote(hub);
  const set = { to: "service:vault", kind: "request" as const, word: "set", body: { ref: "X", value: "v" } };

  const far = await remote.send(set);
  const near = await phone.send(set);

  assert.ok(far.ok);
  assert.ok(near.ok);
});

test("each surface goes only to the channels that declared it", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub, { surfaces: ["chat", "notification"], present: (f) => (f.surface === "island" ? { ok: true, data: { showing: false } } : { ok: true }) });
  const island = await Channel.open(hub, { surfaces: ["chat", "island", "status"], kind: "browser", present: (f) => (f.surface === "island" ? { ok: true, data: { showing: false } } : { ok: true }) });
  const cards = await Channel.open(hub, { surfaces: ["chat", "widget"], kind: "browser", present: (f) => (f.surface === "widget" ? { ok: true, data: { widgets: [], rendered: [] } } : { ok: true }) });
  const chatOnly = await Channel.open(hub, { surfaces: ["chat"], kind: "browser" });
  await eventually(() => island.presented("status").length === 1, "the first status frame on connect");
  const all = [phone, island, cards, chatOnly];

  await hub.mini.send({ to: "person:owner", kind: "request", word: "say", body: { text: "该出门了", kind: "due" } }, AGENT);
  await phone.present((f) => f.surface === "notification" && f.op === "show", "the notification");
  hub.mini.announce("turn.started", { turn: "t1", lane: "front", ids: [] });
  await eventually(() => island.presented("status").length === 2, "a status frame");
  await hub.mini.send({ to: "person:owner", kind: "event", word: "widget.state", body: { revision: 1, cards: [], bindings: [] } }, WIDGETS);
  await cards.present((f) => f.surface === "widget" && f.op === "state", "the widget state");
  await quiet();

  const surfaces = (c: Channel) => [...new Set(c.presents.map((f) => f.surface))].sort();
  assert.deepEqual(all.map(surfaces), [["notification"], ["island", "status"], ["widget"], []]);
});

test("a card's present.result becomes widget.rendered for service:widgets; a preview is asked of the first channel that can draw", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const rendered = [{ card: "todo", updated_at: 5, preview: { png: "AAAA", width: 10, height: 10, theme: "dark" } }, { card: "bad", updated_at: 6, problem: "too deep" }];
  const placed = [{ id: "12", type: "card" }];
  const cards = await Channel.open(hub, { surfaces: ["chat", "widget"], present: (f) => f.op === "state" ? { ok: true, data: { widgets: placed, rendered, previews: [] } } : { ok: true, data: { type: "image", data: "AAAA" } } });
  void cards;

  await hub.mini.send({ to: "person:owner", kind: "event", word: "widget.state", body: { revision: 2, cards: [], bindings: [] } }, WIDGETS);

  const rendering = () => hub.mini.sent.find((s) => s.msg.word === "widget.rendered");
  await eventually(rendering, "the event");
  assert.deepEqual(rendering()!.msg, { to: "service:widgets", kind: "event", word: "widget.rendered", body: { widgets: placed, rendered } });
  assert.equal(rendering()!.caller.via, "service");

  const KERNEL = { member: "service:widgets", via: "service" as const, local: true };
  const preview = await hub.mini.send({ to: "person:owner", kind: "request", word: "widget.preview", body: { card: "todo" } }, KERNEL);
  assert.deepEqual(preview, { ok: true, result: { data: { type: "image", data: "AAAA" }, content: [{ type: "image", data: "AAAA" }] } });
  assert.deepEqual(cards.presented("widget", "preview")[0]!.body, { card: "todo", size: "2x2" });

  const empty = await startHumanHub(); t.after(() => empty.stop());
  const offline = await empty.mini.send({ to: "person:owner", kind: "request", word: "widget.preview", body: { card: "todo", size: "4x2" } }, KERNEL);
  assert.ok(!offline.ok && offline.error.code === "offline");
});

test("react to a message that does not exist fails; the channel table remembers the channels", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub, { surfaces: ["chat", "notification"], label: "手机 · 对话" });

  const bad = await hub.mini.send({ to: "person:owner", kind: "request", word: "react", body: { message_id: "m_nope", emoji: "👍" } }, AGENT);
  assert.ok(!bad.ok && bad.error.code === "not_found");

  const rows = hub.ledger.db().prepare("SELECT sid,channel,hand,label,local,surfaces FROM human_clients").all() as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => [r.sid, r.channel, r.label, r.local, r.surfaces]), [[phone.clientId, "app", "手机 · 对话", 1, '["chat","notification"]']]);
  assert.deepEqual(hub.human.clients().map((c) => [c.client, c.visible, c.surfaces]), [[phone.clientId, false, ["chat", "notification"]]]);
  void GATE;
});

test("a channel that connects with the widget surface is given the current state from service:widgets/widget.list", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const state = { revision: 7, cards: [], widgets: [{ id: "3", type: "ash", card: null }], bindings: [], previews: [] };
  hub.widgetState.value = state;

  const cards = await Channel.open(hub, { surfaces: ["chat", "widget"], present: () => ({ ok: true, data: { widgets: [], rendered: [{ card: "x", updated_at: 1 }] } }) });
  const chatOnly = await Channel.open(hub, { surfaces: ["chat"] });

  const frame = await cards.present((f) => f.surface === "widget" && f.op === "state", "the current state");
  assert.deepEqual(frame.body, state);
  await eventually(() => hub.mini.sent.some((s) => s.msg.word === "widget.rendered"), "what it drew goes on");
  assert.equal(chatOnly.presents.length, 0);
});

test("channels(): the open channels, with what the agents' environment needs (not the owner's attention); a closed channel is gone", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  assert.deepEqual(hub.human.channels(), []);
  const phone = await Channel.open(hub, { label: "手机 · 对话" });
  const web = await Channel.openRemote(hub, { label: "网页 Mac Chrome" });
  phone.presence({ visible: true });
  await eventually(() => hub.human.clients().find((c) => c.client === phone.clientId)?.visible, "the phone visible");

  const channels = hub.human.channels();
  assert.deepEqual(channels.find((c) => c.client === phone.clientId), { client: phone.clientId, kind: "app", label: "手机 · 对话", local: true });
  assert.deepEqual(channels.find((c) => c.client === web.clientId), { client: web.clientId, kind: "web", label: "网页 Mac Chrome", local: false });

  web.client.stop();
  await eventually(() => hub.human.channels().length === 1, "the web channel gone");
});

test("a stream goes to the channel that asked, whole, and to nobody else; a caller with no channel cannot be sent one", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub, { label: "手机" });
  const web = await Channel.open(hub, { label: "网页", kind: "browser" });
  const bytes = new Uint8Array(300_000).map((_, i) => i % 251);   // more than one chunk

  const sid = hub.human.openStream(phone.clientId, bytes, "image/png");
  const got = await eventually(() => phone.streams.find((s) => s.sid === sid), "the stream on the phone");
  assert.equal(got.mime, "image/png");
  assert.deepEqual(got.data, bytes);
  await quiet();
  assert.equal(web.streams.length, 0, "the other channel got nothing");

  assert.throws(() => hub.human.openStream(undefined, bytes, "image/png"), { code: "unavailable" });
  assert.throws(() => hub.human.openStream("client:nobody", bytes, "image/png"), { code: "unavailable" });
});

const HOST = { member: "service:host", via: "service" as const, local: true };

test("the virtual screen being made or closed reaches the channels that show status, as a vscreen present; watching a live view is told by presence", async (t) => {
  const hub = await startHumanHub(); t.after(() => hub.stop());
  const phone = await Channel.open(hub, { surfaces: ["chat", "status"] });
  const chatOnly = await Channel.open(hub, { surfaces: ["chat"], kind: "browser" });
  await eventually(() => phone.presented("status").length === 1, "the first status frame on connect");
  await hub.mini.send({ to: "person:owner", kind: "event", word: "vscreen.state", body: { open: true } }, HOST);
  await eventually(() => phone.presented("status", "vscreen").length === 1, "the vscreen present");
  await hub.mini.send({ to: "person:owner", kind: "event", word: "vscreen.state", body: { open: false } }, HOST);
  await eventually(() => phone.presented("status", "vscreen").length === 2, "the second vscreen present");
  assert.deepEqual(phone.presented("status", "vscreen").map((f) => f.body), [{ open: true }, { open: false }]);
  assert.equal(chatOnly.presents.length, 0);

  assert.equal(hub.human.viewing(), false);
  phone.presence({ watching: true });
  await eventually(() => hub.human.viewing(), "watching");
  phone.presence({ watching: false });
  await eventually(() => !hub.human.viewing(), "not watching");
  phone.presence({ visible: true });
  await quiet();
  assert.equal(hub.human.viewing(), false, "being in front is not watching a live view");
});
