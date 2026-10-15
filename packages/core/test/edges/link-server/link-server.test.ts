import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { eventually } from "../../fixtures/wait";
import { HandClient } from "../../../../link/src/hand";
import { memoryPair } from "../../../../link/test/fixtures/memory";
import { cap, connect, connected, connectViaRelay, newIdentity, startHub } from "./harness";
import { DEVICE_ASSETS } from "../../../../sdk/src/device-assets.generated";
import type { DeviceRelease } from "../../../../link/src/secure";

const get = (port: number, path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  request({ host: "127.0.0.1", port, path }, (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
  }).on("error", reject).end();
});

test("start: one port on 127.0.0.1, a random token held in memory, and the host is told both", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  assert.deepEqual(hub.handoffs, [{ port: hub.port, token: hub.token }]);
  assert.ok(hub.token.length >= 32);
  const other = await startHub(); t.after(() => other.stop());
  assert.notEqual(other.token, hub.token);
  assert.equal((await get(hub.port, "/nothing")).status, 404);
});

test("mount: a path and what is under it, the fallback for the rest, and /link is not for sale", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  hub.server.mount("/mcp", (_req, res) => res.end("mcp"));
  hub.server.mount("/", (req, res) => res.end(`web ${req.url}`));
  assert.equal((await get(hub.port, "/mcp")).body, "mcp");
  assert.equal((await get(hub.port, "/mcp/agent-x")).body, "mcp");
  assert.equal((await get(hub.port, "/mcpx")).body, "web /mcpx");
  assert.equal((await get(hub.port, "/index.html")).body, "web /index.html");
  assert.throws(() => hub.server.mount("/link", () => {}));
  assert.throws(() => hub.server.mount("/mcp", () => {}));
});

test("identity: a wrong or missing token and a wrong signature are 4001; nothing is registered for them", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const stranger = await newIdentity();
  const attempts = [
    await connect(hub, { token: "wrong" }),
    await connect(hub, { token: null }),
    await connect(hub, { signWith: stranger }),
  ];
  for (const attempt of attempts) {
    await eventually(() => attempt.closes.length > 0, "the refusal");
    assert.equal(attempt.closes[0]!.code, 4001);
    assert.equal(attempt.closes[0]!.willReconnect, true);
  }
  assert.equal(hub.hands.list().length, 0);
});

test("a hand seen for the first time on the local link is registered: paired_by local, tier ask, hand_id from its key", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const hand = await connected(hub, { kind: "computer", name: "书房电脑" });
  const record = hub.hands.get(hand.identity.handId)!;
  assert.deepEqual([record.name, record.kind, record.paired_by, record.tier, record.public_key, record.revoked_at], ["书房电脑", "computer", "local", "ask", hand.identity.publicKey, null]);
  assert.equal(hand.client.welcome!.hand_id, hand.identity.handId);
});

test("one executor per hand: a second device connection replaces the first with 4009, and the first does not come back", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const identity = await newIdentity();
  const first = await connected(hub, { identity, capabilities: [cap("location.get")] });
  const second = await connected(hub, { identity, capabilities: [cap("clipboard.read")] });
  await eventually(() => first.client.stoppedBy === 4009, "the first told 4009");
  assert.equal(first.client.state, "stopped");
  assert.equal(second.client.state, "ready");
  // the old connection closing did not take the new one's member with it
  assert.deepEqual(hub.registry.members.get(first.member)!.words().map((w) => w.word), ["clipboard.read"]);
  assert.equal(hub.hands.online(identity.handId), true);
});

test("connections that carry only the human channel do not replace each other, and do not disturb the device connection", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const attached: string[] = [];
  hub.server.onChannel("human", (session, ctx) => { attached.push(`${ctx.handId}:${ctx.local}`); return {}; });
  const identity = await newIdentity();
  const device = await connected(hub, { identity, capabilities: [cap("location.get")] });
  const tab1 = await connect(hub, { identity, channels: { human: {} } });
  const tab2 = await connect(hub, { identity, channels: { human: {} } });
  await tab1.client.ready();
  await tab2.client.ready();
  assert.notEqual(tab1.client.welcome!.channels.human, tab2.client.welcome!.channels.human, "two clients");
  assert.equal(device.client.state, "ready");
  assert.equal(tab1.client.state, "ready");
  assert.deepEqual(attached, [`${identity.handId}:true`, `${identity.handId}:true`]);
});

test("local channels: device and human are open (human with local=true); agent is not for the local link", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const hand = await connect(hub, { kind: "computer", channels: { device: {}, human: {}, agent: {} } });
  const welcome = await hand.client.ready();
  assert.deepEqual(welcome.channels.device, { accepted: true });
  assert.deepEqual(welcome.channels.human && "local" in welcome.channels.human && welcome.channels.human.local, true);
  assert.equal((welcome.channels.agent as { accepted: boolean }).accepted, false);
});

test("a channel's module gets its frames and the facts of the connection", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const got: unknown[] = [];
  hub.server.onChannel("human", (session, ctx) => ({ human: (frame) => got.push([frame.t, ctx.local, session.channels.human]) }));
  const web = await connect(hub, { channels: { human: {} } });
  await web.client.ready();
  web.client.send({ to: "agent:main", kind: "request", word: "say", body: { text: "hi" } }).catch(() => {});
  const client = (web.client.welcome!.channels.human as { client: string }).client;
  await eventually(() => got.length === 1, "the send frame");
  assert.deepEqual(got[0], ["send", true, { client, local: true }]);
  assert.throws(() => hub.server.onChannel("human", () => {}));
});

test("through the relay a hand gets exactly the channels the owner allowed it (SPEC-03 §2.2.1)", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const identity = await newIdentity();
  const id = identity.handId;
  const all = { device: {}, human: {}, agent: {} };
  const reply = async (permissions: { lend: boolean; local_agents: boolean }, kind: "computer" | "phone" = "computer") => {
    hub.hands.register({ id, name: "远程电脑", kind, public_key: identity.publicKey, paired_by: "gateway", ...permissions });
    const hand = connectViaRelay(hub, id, identity, { kind, channels: all });
    const welcome = await hand.client.ready();
    hand.client.stop();
    const c = welcome.channels;
    return { device: (c.device as { accepted: boolean }).accepted, human: Boolean(c.human && "client" in c.human && c.human.local === false), agent: (c.agent as { accepted: boolean }).accepted };
  };
  assert.deepEqual(await reply({ lend: true, local_agents: false }), { device: true, human: false, agent: false });
  assert.deepEqual(await reply({ lend: true, local_agents: true }), { device: true, human: false, agent: true }, "the human channel is not served through the relay");
  assert.deepEqual(await reply({ lend: false, local_agents: true }), { device: false, human: false, agent: true });
  assert.deepEqual(await reply({ lend: false, local_agents: true }, "phone"), { device: false, human: false, agent: false }, "only a computer runs local agents");
});

test("through the relay: an unknown device, a key that is not the device's, and a revoked device are refused", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const identity = await newIdentity();
  const other = await newIdentity();
  const refusals: { hand?: string; code: number; reason: string }[] = [];
  hub.server.observe((event) => { if (event.type === "refused") refusals.push({ hand: event.hand, code: event.code, reason: event.reason }); });

  // Refused before TLS, so the device only sees the tunnel end (a code in the clear could be the relay's) and tries again later.
  const unknown = connectViaRelay(hub, identity.handId, identity);
  await eventually(() => unknown.closes.length > 0, "unknown refused");
  assert.deepEqual([unknown.closes[0]!.code, unknown.closes[0]!.willReconnect], [1006, true]);
  assert.deepEqual(refusals.at(-1), { hand: identity.handId, code: 4001, reason: "unknown device" });
  unknown.client.stop();

  hub.hands.register({ id: identity.handId, name: "r", kind: "computer", public_key: identity.publicKey, paired_by: "gateway", lend: true });
  const wrongKey = connectViaRelay(hub, identity.handId, other);
  await eventually(() => wrongKey.closes.length > 0, "wrong key refused");
  assert.equal(wrongKey.client.state === "ready", false);
  assert.deepEqual(refusals.at(-1), { hand: identity.handId, code: 4001, reason: "the device's key is not the one that was paired" });
  wrongKey.client.stop();

  hub.hands.revoke(identity.handId);
  const revoked = connectViaRelay(hub, identity.handId, identity);
  await eventually(() => revoked.closes.length > 0, "revoked refused");
  assert.equal(revoked.closes[0]!.code, 4003);
  assert.equal(revoked.client.stoppedBy, 4003);
});

test("the local link is in the clear on 127.0.0.1 with the token; a relay tunnel takes only TLS (docs/LINK-E2E.md §2)", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  // Local: plain ash-link/2 frames, the token and the signature.
  const local = await connected(hub, { kind: "phone", name: "本机" });
  assert.equal(hub.hands.via(local.identity.handId), "local");
  assert.ok(hub.url.startsWith("ws://127.0.0.1:"));

  // The same plain client on a relay tunnel is turned away before a frame of it is read.
  const identity = await newIdentity();
  hub.hands.register({ id: identity.handId, name: "r", kind: "computer", public_key: identity.publicKey, paired_by: "gateway", lend: true });
  const refusals: string[] = [];
  hub.server.observe((event) => { if (event.type === "refused") refusals.push(event.reason); });
  const plain = new HandClient({
    url: "relay://tunnel/link",
    connector: (_url, _headers, events) => {
      const pair = memoryPair();
      pair.hand.on("message", (data: string) => events.message(data, false));
      pair.hand.on("close", (code: number, reason: Buffer) => events.close(code, reason.toString()));
      hub.server.acceptGateway(pair.server, identity.handId, hub.relay.security);
      queueMicrotask(() => events.open());
      return pair.hand;
    },
    hand: { kind: "computer", name: "r", version: "0", platform: "test", public_key: identity.publicKey },
    channels: { device: {} }, sign: (nonce) => identity.sign(nonce),
  });
  t.after(() => plain.stop());
  plain.start();
  await eventually(() => refusals.length > 0, "the plain device refused");
  assert.equal(refusals[0], "the device spoke in the clear; a relay connection must be secured");
  assert.equal(hub.hands.online(identity.handId), false);
  assert.deepEqual(hub.server.connections().map((c) => c.via), ["local"]);
});

test("through the relay a computer older than the hub's minimum is closed with 4008 inside TLS, and told the release to install", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const identity = await newIdentity();
  hub.hands.register({ id: identity.handId, name: "旧电脑", kind: "computer", public_key: identity.publicKey, paired_by: "gateway", lend: true });
  const releases: DeviceRelease[] = [];
  const old = connectViaRelay(hub, identity.handId, identity, { version: "0.1.9", update: (release) => releases.push(release) });
  await eventually(() => old.client.state === "stopped", "closed for good");
  assert.equal(old.client.stoppedBy, 4008);
  assert.deepEqual(releases, [{ version: DEVICE_ASSETS.version, sha256: DEVICE_ASSETS.sha256 }]);
  // The current program is let in.
  const current = connectViaRelay(hub, identity.handId, identity);
  await current.client.ready();
});

test("the device channel reaches the hand registry, and its end marks the hand offline", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const hand = await connected(hub, { capabilities: [cap("location.get")] });
  assert.equal(hub.hands.online(hand.identity.handId), true);
  hand.client.stop();
  await eventually(() => !hub.hands.online(hand.identity.handId), "offline");
  assert.ok(hub.hands.get(hand.identity.handId)!.last_seen);
});
