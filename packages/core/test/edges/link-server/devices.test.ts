import assert from "node:assert/strict";
import test from "node:test";
import { WordError, type HandleContext, type Message } from "../../../../sdk/src/message";
import { Devices, type PairKind, type PairingGateway, type RelayPermission } from "../../../src/edges/link-server/hands/devices";
import { eventually } from "../../fixtures/wait";
import { cap, connected, connectViaRelay, newIdentity, startHub, type Hub } from "./harness";
import { DEVICE_ASSETS } from "../../../../sdk/src/device-assets.generated";

const owner: HandleContext = { signal: new AbortController().signal, caller: { member: "person:owner", via: "human", local: true }, raw: undefined };
const agent: HandleContext = { ...owner, caller: { member: "agent:main", via: "agent", local: false } };
let n = 0;
const msg = (word: string, body: unknown = {}, from = "person:owner"): Message =>
  ({ seq: ++n, id: `m${n}`, ts: 0, from, to: "service:devices", kind: word === "config.changed" || word.startsWith("codex.") ? "event" : "request", word, body });

const COMMAND = "curl -fsSL https://example.invalid/install.sh | sh -s -- https://relay.example TICKET-123 SECRET-456";
class FakeGateway implements PairingGateway {
  calls: string[] = [];
  async issue(kind: PairKind) { this.calls.push(`issue ${kind}`); return { ticket: "TICKET-123", expires_in: 600, secret: "SECRET-456", command: COMMAND }; }
  async approve(id: string, permissions: RelayPermission[], pairing: { hand: string; secret: string }) { this.calls.push(`approve ${id} ${permissions.join("+")} ${pairing.secret}`); }
  async reject(id: string) { this.calls.push(`reject ${id}`); }
  async revoke(id: string) { this.calls.push(`revoke ${id}`); }
  async setExpose(id: string, allow: boolean) { this.calls.push(`expose ${id} ${allow}`); }
}

async function setup(t: test.TestContext, gateway: PairingGateway | null = new FakeGateway()) {
  const hub = await startHub(); t.after(() => hub.stop());
  let clock = 1_000_000;
  const devices = new Devices({ hands: hub.hands, router: hub.router, bodies: hub.bodies, gateway: gateway ?? undefined, now: () => clock });
  const call = async (word: string, body: unknown = {}, ctx = owner) => {
    const result = await devices.handle(msg(word, body), ctx);
    return (result as { data: any } | void)?.data;
  };
  const refused = async (word: string, body: unknown = {}, ctx = owner) => {
    try { await devices.handle(msg(word, body), ctx); } catch (error) { assert.ok(error instanceof WordError); return error.code; }
    return "none";
  };
  return { hub, devices, call, refused, gateway: gateway as FakeGateway, advance: (ms: number) => { clock += ms; } };
}
const dev = (hand: { identity: { handId: string } }) => `device:${hand.identity.handId}`;

test("the words are the contract's, every one", async (t) => {
  const { devices } = await setup(t);
  const words = devices.words().map((w) => w.word);
  for (const word of ["list", "describe", "pair_start", "pair_status", "pair_pending", "pair_approve", "pair_reject", "revoke", "restore", "rename", "access_set", "update"]) assert.ok(words.includes(word), word);
  assert.ok(words.includes("pair_code"));
});

test("list and describe show every hand the same way, with what the owner allowed and whether it is online", async (t) => {
  const { hub, call } = await setup(t);
  const phone = await connected(hub, { kind: "phone", name: "Find X8", capabilities: [cap("location.get")] });
  const computer = await connected(hub, { kind: "computer", name: "Mac" });
  hub.bodies.bound.add(computer.identity.handId);
  computer.client.stop();
  await eventually(() => !hub.hands.online(computer.identity.handId), "the computer leaving");

  const { devices } = await call("list");
  const byName = Object.fromEntries(devices.map((d: any) => [d.name, d]));
  assert.deepEqual([byName["Find X8"].device, byName["Find X8"].online, byName["Find X8"].via, byName["Find X8"].tier, byName["Find X8"].body], [dev(phone), true, "local", "ask", false]);
  assert.deepEqual([byName["Mac"].online, byName["Mac"].body], [false, true]);

  const detail = await call("describe", { device: dev(phone) });
  assert.deepEqual([detail.capabilities, detail.version, detail.platform], [["location.get"], "0.0.1", "test"]);
  assert.equal(await (async () => { try { await call("describe", { device: `device:${"x".repeat(22)}` }); } catch (e) { return (e as WordError).code; } })(), "not_found");
});

test("rename and access_set change the record; the list shows it", async (t) => {
  const { hub, call, refused } = await setup(t);
  const phone = await connected(hub, { capabilities: [cap("location.get")] });
  assert.deepEqual(await call("rename", { device: dev(phone), name: " 客厅的手机 " }), { device: dev(phone), name: "客厅的手机" });
  assert.equal(hub.registry.members.get(dev(phone))!.name, "客厅的手机", "the member carries the new name");
  const info = await call("access_set", { device: dev(phone), tier: "full" });
  assert.deepEqual([info.name, info.tier, info.lend], ["客厅的手机", "full", true]);
  assert.equal(hub.hands.tier(dev(phone)), "full");
  assert.equal(hub.hands.tier("body:main"), "ask");
  assert.equal(hub.hands.tier("service:gate"), "ask");
  assert.equal(await refused("rename", { device: `device:${"y".repeat(22)}`, name: "x" }), "not_found");
});

test("access_set can bind or unbind the computer as a body, through service:bodies as this service", async (t) => {
  const { hub, call } = await setup(t);
  const computer = await connected(hub, { kind: "computer" });
  await call("access_set", { device: dev(computer), body: true });
  await call("access_set", { device: dev(computer), body: false });
  hub.bodies.bound.add(computer.identity.handId);
  await call("access_set", { device: dev(computer), body: false });
  await call("access_set", { device: dev(computer), body: true }); // already bound: nothing to do
  const sent = hub.router.sent.map((s) => [s.msg.to, s.msg.word, s.msg.body, s.caller.member]);
  assert.deepEqual(sent, [
    ["service:bodies", "bind", { hand: computer.identity.handId }, "service:devices"],
    ["service:bodies", "unbind", { body: `body:${computer.identity.handId}` }, "service:devices"],
  ]);
});

test("revoke closes the hand (4003), keeps its record, and asks the relay to forget it; restore lets it back", async (t) => {
  const { hub, call, refused, gateway } = await setup(t);
  const phone = await connected(hub);
  const identity = await newIdentity();
  hub.hands.register({ id: identity.handId, name: "远程电脑", kind: "computer", public_key: identity.publicKey, paired_by: "gateway", lend: true });
  const remote = connectViaRelay(hub, identity.handId, identity);
  await remote.client.ready();

  assert.deepEqual(await call("revoke", { device: dev(phone) }), { revoked: true });
  assert.deepEqual(await call("revoke", { device: dev(remote) }), { revoked: true });
  await eventually(() => phone.client.stoppedBy === 4003 && remote.client.stoppedBy === 4003, "both told 4003");
  assert.deepEqual(gateway.calls, [`revoke ${identity.handId}`], "only a hand that came through the relay is the relay's to forget");
  assert.equal(await refused("rename", { device: dev(phone), name: "x" }), "conflict");
  assert.equal(await refused("access_set", { device: dev(phone), tier: "full" }), "conflict");
  const listed = (await call("list")).devices.find((d: any) => d.device === dev(phone));
  assert.ok(listed.revoked_at);

  assert.deepEqual(await call("restore", { device: dev(phone) }), { restored: true });
  assert.deepEqual(await call("restore", { device: dev(phone) }), { restored: false });
  const back = await connected(hub, { identity: phone.identity });
  assert.equal(back.client.state, "ready");
});

test("taking a permission away from a hand that came through the relay ends its connection; the relay hears it", async (t) => {
  const { hub, call, refused, gateway } = await setup(t);
  const identity = await newIdentity();
  hub.hands.register({ id: identity.handId, name: "远程电脑", kind: "computer", public_key: identity.publicKey, paired_by: "gateway", lend: true });
  const remote = connectViaRelay(hub, identity.handId, identity);
  await remote.client.ready();

  await call("access_set", { device: dev(remote), lend: false });
  await eventually(() => remote.closes.length > 0, "the connection ending");
  assert.equal(remote.closes[0]!.code, 1000);
  assert.deepEqual(gateway.calls, [`expose ${identity.handId} false`]);

  // The phone's own web page is a local hand of kind browser: it cannot be given a computer's rights.
  hub.hands.register({ id: "b".repeat(22), name: "网页", kind: "browser", public_key: "", paired_by: "local" });
  assert.equal(await refused("access_set", { device: `device:${"b".repeat(22)}`, local_agents: true }), "forbidden");
  assert.equal(await refused("access_set", { device: `device:${"b".repeat(22)}`, tier: "full" }), "forbidden");
});

test("pair_code is refused without a relay and once the code can no longer be used", async (t) => {
  const { devices, call, refused, advance } = await setup(t);
  const started = await call("pair_start", { kind: "computer", name: "a" });
  advance(601_000);
  assert.equal(await refused("pair_code", { pair_id: started.pair_id }), "conflict");
  const bare = await setup(t, null);
  devices.pairs.forEach((p, id) => bare.devices.pairs.set(id, p));
  assert.equal(await bare.refused("pair_code", { pair_id: started.pair_id }), "unavailable");
});

test("widening a permission also ends the connection of a hand from the relay, so it is judged again at once", async (t) => {
  const { hub, call } = await setup(t);
  const identity = await newIdentity();
  hub.hands.register({ id: identity.handId, name: "远程电脑", kind: "computer", public_key: identity.publicKey, paired_by: "gateway", lend: true });
  const remote = connectViaRelay(hub, identity.handId, identity, { channels: { device: {}, agent: {} } });
  const welcome = await remote.client.ready();
  assert.deepEqual(welcome.channels.agent, { accepted: false, reason: "the owner has not allowed this computer to run local agents" });

  await call("access_set", { device: dev(remote), local_agents: true });
  await eventually(() => (remote.client.welcome?.channels.agent as { accepted?: boolean } | undefined)?.accepted === true, "the hand back with agent open");
  assert.equal(remote.closes[0]!.code, 1000);
});

test("update has the computer's x.ash.update run, asked by this service", async (t) => {
  const { hub, call, refused } = await setup(t);
  const computer = await connected(hub, { kind: "computer" });
  const body = { device: dev(computer), version: "0.2.0", sha256: "a".repeat(64) };
  assert.deepEqual(await call("update", body), { started: true, version: "0.2.0", sha256: "a".repeat(64) });
  assert.deepEqual(hub.router.sent.map((s) => [s.msg.to, s.msg.word, s.msg.body, s.caller.member]), [[dev(computer), "x.ash.update", { version: "0.2.0", sha256: "a".repeat(64) }, "service:devices"]]);
  hub.router.answers.set(`${dev(computer)}/x.ash.update`, () => ({ ok: false, error: { code: "offline", message: "gone" } }));
  assert.equal(await refused("update", body), "offline");
});

test("pairing: whoever starts it gets the install command; requested, approved, then connected when the computer arrives", async (t) => {
  const { hub, devices, call, refused, gateway } = await setup(t);

  const started = await call("pair_start", { kind: "computer", name: "书房电脑" }, agent);
  assert.deepEqual(Object.keys(started).sort(), ["command", "expires_at", "pair_id"]);
  assert.equal(started.command, COMMAND, "an agent that starts a pairing can give the owner the command");
  const pair = devices.pairs.get(started.pair_id)!;
  assert.equal(pair.initiator, "agent:main");
  assert.equal(pair.ticket, "TICKET-123");
  assert.ok(!/TICKET|SECRET/.test(JSON.stringify(await call("pair_status", { pair_id: started.pair_id }))));
  assert.equal((await call("pair_status", { pair_id: started.pair_id })).state, "waiting");
  assert.deepEqual((await call("pair_pending")).pairs, []);
  assert.equal(await refused("pair_approve", { pair_id: started.pair_id }), "conflict", "nobody has asked yet");

  // the command again, while it waits (owner or agent); what lets the device in is the approval below
  assert.deepEqual(await call("pair_code", { pair_id: started.pair_id }), { command: COMMAND, expires_at: pair.expires_at });

  const identity = await newIdentity();
  const asked = devices.pairingRequested({ request_id: "req1", hand_id: identity.handId, name: "新电脑", kind: "computer", public_key: identity.publicKey, fingerprint: "ab:cd", ticket: "TICKET-123" });
  assert.equal(asked?.pair_id, started.pair_id);
  assert.deepEqual((await call("pair_pending")).pairs.map((p: any) => p.state), ["requested"]);

  const order: string[] = [];
  const approveOnRelay = gateway.approve.bind(gateway);
  gateway.approve = async (id, permissions, pairing) => { order.push(`known=${hub.hands.get(identity.handId) !== null}`); return approveOnRelay(id, permissions, pairing); };
  const approved = await call("pair_approve", { pair_id: started.pair_id, name: "书房电脑", lend: true, local_agents: true, tier: "full" });
  assert.deepEqual(order, ["known=true"], "the hand is on record before the relay lets it in");
  assert.deepEqual([approved.state, approved.device], ["approved", dev({ identity })]);
  assert.deepEqual(gateway.calls, ["issue computer", "approve req1 expose_capability SECRET-456"], "the secret goes to the hub's side of the relay link, to be proved later");
  const record = hub.hands.get(identity.handId)!;
  assert.deepEqual([record.name, record.kind, record.paired_by, record.tier, record.lend, record.local_agents], ["书房电脑", "computer", "gateway", "full", true, true]);

  const remote = connectViaRelay(hub, identity.handId, identity);
  await remote.client.ready();
  assert.equal((await call("pair_status", { pair_id: started.pair_id })).state, "connected");
  await eventually(() => hub.router.sent.length >= 6, "the news of each change");
  const news = hub.router.sent.map((s) => [s.msg.to, s.msg.word, (s.msg.body as { state?: string }).state ?? (s.msg.body as { text?: string }).text]);
  assert.deepEqual(news.filter((n) => n[1] === "pair.changed").map((n) => n[2]), ["requested", "approved", "connected"]);
  assert.ok(hub.router.sent.every((s) => s.caller.member === "service:devices"));
  const told = news.filter((n) => n[1] === "tell");
  assert.deepEqual(told.map((n) => n[0]), Array(3).fill("agent:main"));
  assert.match(String(told.at(-1)![2]), new RegExp(`${started.pair_id}.*done`));
});

test("pairing: a code nobody used expires; a request can be rejected; there is no browser pairing; no relay, no pairing", async (t) => {
  const { devices, call, refused, gateway, advance } = await setup(t);
  const one = await call("pair_start", { kind: "computer", name: "a" });
  advance(601_000);
  assert.equal((await call("pair_status", { pair_id: one.pair_id })).state, "expired");
  assert.equal(devices.pairingRequested({ request_id: "late", hand_id: "z".repeat(22), name: "x", kind: "computer", public_key: "", fingerprint: "f", ticket: "TICKET-123" }), null);

  const two = await call("pair_start", { kind: "server", name: "box" });
  const identity = await newIdentity();
  devices.pairingRequested({ request_id: "req2", hand_id: identity.handId, name: "服务器", kind: "computer", public_key: identity.publicKey, fingerprint: "f", ticket: "TICKET-123" });
  assert.deepEqual(await call("pair_reject", { pair_id: two.pair_id }), { pair_id: two.pair_id, state: "rejected", name: "box", kind: "server", expires_at: devices.pairs.get(two.pair_id)!.expires_at });
  assert.ok(gateway.calls.includes("reject req2"));
  assert.ok(devices.words().find((w) => w.word === "pair_start")!.input_schema.properties!.kind!.enum!.every((k: string) => k !== "browser"));

  const bare = await setup(t, null);
  assert.equal(await bare.refused("pair_start", { kind: "computer", name: "x" }), "unavailable");
});

test("pairing fails when the device that connects cannot prove the secret: the record is revoked and the starter told why", async (t) => {
  const { hub, devices, call, gateway } = await setup(t);
  const started = await call("pair_start", { kind: "computer", name: "书房电脑" }, agent);
  const identity = await newIdentity();
  devices.pairingRequested({ request_id: "req1", hand_id: identity.handId, name: "书房电脑", kind: "computer", public_key: identity.publicKey, fingerprint: "f", ticket: "TICKET-123" });
  await call("pair_approve", { pair_id: started.pair_id, lend: true }, agent);

  devices.pairingFailed(identity.handId, "the device could not prove the pairing secret: the relay may have swapped the device's key");
  const status = await call("pair_status", { pair_id: started.pair_id });
  assert.deepEqual([status.state, status.reason], ["failed", "the device could not prove the pairing secret: the relay may have swapped the device's key"]);
  assert.ok(hub.hands.get(identity.handId)!.revoked_at);
  await eventually(() => gateway.calls.includes(`revoke ${identity.handId}`), "the relay to revoke it too");
  await eventually(() => hub.router.sent.some((s) => s.msg.word === "tell" && /failed: .*swapped.*start a new pairing/.test(String((s.msg.body as { text: string }).text))), "the agent told");
  assert.ok(hub.router.sent.some((s) => s.msg.word === "pair.changed" && (s.msg.body as { state: string; reason?: string }).state === "failed" && /swapped/.test((s.msg.body as { reason?: string }).reason ?? "")));
});

test("update without a release installs the hub's own, with the checksum for the computer's platform", async (t) => {
  const { hub, call, refused } = await setup(t);
  const mac = await connected(hub, { kind: "computer", platform: "darwin-arm64", version: DEVICE_ASSETS.version });
  const release = { version: DEVICE_ASSETS.version, sha256: DEVICE_ASSETS.sha256["darwin-arm64"] };
  assert.deepEqual(await call("update", { device: dev(mac) }), { started: true, ...release });
  assert.deepEqual(hub.router.sent.filter((s) => s.msg.word === "x.ash.update").map((s) => s.msg.body), [release]);
  // Another release needs its checksum; a platform the hub has no package for needs both.
  assert.equal(await refused("update", { device: dev(mac), version: "0.1.0" }), "bad_request");
  assert.deepEqual(await call("update", { device: dev(mac), version: "0.1.0", sha256: "c".repeat(64) }), { started: true, version: "0.1.0", sha256: "c".repeat(64) });
  const odd = await connected(hub, { kind: "computer", platform: "freebsd-x64" });
  assert.equal(await refused("update", { device: dev(odd) }), "unavailable");
});

test("a computer older than the hub's release is updated when its manifest comes in, once, and not when the setting is off", async (t) => {
  let on = true;
  const hub = await startHub(); t.after(() => hub.stop());
  new Devices({ hands: hub.hands, router: hub.router, bodies: hub.bodies, gateway: new FakeGateway(), autoUpdate: () => on });
  const updates = () => hub.router.sent.filter((s) => s.msg.word === "x.ash.update");
  const old = await connected(hub, { kind: "computer", platform: "linux-x64", version: "0.1.0", capabilities: [cap("x.ash.update")] });
  await eventually(() => updates().length === 1, "the automatic update");
  assert.deepEqual([updates()[0]!.msg.to, updates()[0]!.msg.body, updates()[0]!.caller.member], [dev(old), { version: DEVICE_ASSETS.version, sha256: DEVICE_ASSETS.sha256["linux-x64"] }, "service:devices"]);
  await old.client.setManifest([cap("x.ash.update"), cap("x.mac.more")]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(updates().length, 1, "once per hub run: a failing update is not retried in a loop");

  const current = await connected(hub, { kind: "computer", platform: "linux-x64", version: DEVICE_ASSETS.version, capabilities: [cap("x.ash.update")] });
  const phone = await connected(hub, { kind: "phone", platform: "linux-x64", version: "0.0.1", capabilities: [cap("x.ash.update")] });
  on = false;
  const off = await connected(hub, { kind: "computer", platform: "linux-x64", version: "0.1.0", capabilities: [cap("x.ash.update")] });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(updates().map((s) => s.msg.to), [dev(old)], "not the current one, not a phone, not with the setting off");
  void current; void phone; void off;
});

test("config.changed from a hand is kept for describe", async (t) => {
  const { hub, devices, call } = await setup(t);
  const phone = await connected(hub);
  await devices.handle({ ...msg("config.changed", { item: "accessibility", state: "missing" }), from: dev(phone) }, owner);
  assert.deepEqual((await call("describe", { device: dev(phone) })).config, { accessibility: "missing" });
});

test("a computer's Codex App needing the owner is a notification that opens the Codex page: no message in the conversation, nothing for Ash", async (t) => {
  const { hub, devices } = await setup(t);
  const computer = await connected(hub, { kind: "computer", name: "Mac" });
  const from = dev(computer);
  const event = (word: string, body: object, id: string) => devices.handle({ ...msg(word, body), id, from }, owner);
  await event("codex.turn_ended", { thread: "t1", title: "Fix the build", said: "all green" }, "e1");
  await event("codex.approval_pending", { thread: "t1", title: "Fix the build", request_id: "5", summary: "make deploy" }, "e2");
  const sent = hub.router.sent.filter((s) => s.caller.member === "service:devices");
  assert.deepEqual(sent.map((s) => [s.msg.to, s.msg.word]), [["person:owner", "notice"], ["person:owner", "notice"]], "no say, no tell to an agent");
  assert.deepEqual(sent.map((s) => (s.msg.body as any).text), ["「Fix the build」做完了一轮：all green", "「Fix the build」在等你批准：make deploy"]);
  assert.deepEqual(sent.map((s) => [(s.msg.body as any).title, (s.msg.body as any).open]), [["Codex · Mac", "codex"], ["Codex · Mac", "codex"]]);
  assert.notEqual((sent[0]!.msg.body as any).dedupe_key, (sent[1]!.msg.body as any).dedupe_key);
});
