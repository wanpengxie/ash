/**
 * The computer program against a kernel (the link server and hand registry, the bodies service, and a stand-in for the
 * agents module): the handshake, the manifest, a body that exists only while bound, and the agent channel.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STANDARD_NAMESPACES } from "../../sdk/src/namespaces";
import { checkCapabilitySpec } from "../../sdk/src/link";
import { startDevice, type DeviceDeps, type RunningDevice } from "../src/main";
import { loadIdentity } from "../src/link";
import { DEVICE_VERSION } from "../src/install";
import { Desktop, snapshot, turn } from "./fake-codex-desktop";
import { context, errorCode, eventually, fakeCodex, openTunnel, request, startKernel, withPath, type Kernel } from "./kernel";

const fixture = fileURLToPath(new URL("./fixtures/agent-cli.mjs", import.meta.url));
const BODY = [...STANDARD_NAMESPACES.workspace!, ...STANDARD_NAMESPACES.body!].map((a) => a.name);
const codexOnly: DeviceDeps["detect"] = async () => [{ kind: "codex", installed: true, logged_in: true, models: [{ id: "test-model", efforts: ["low", "high"] }] }, { kind: "claude", installed: false, logged_in: null, models: [] }, { kind: "workbuddy", installed: false, logged_in: null, models: [] }];
const nothing: DeviceDeps["detect"] = async () => [];

interface Setup { kernel: Kernel; device: RunningDevice; id: string; dir: string; workdir: string; stateDir: string; tunnel: ReturnType<typeof openTunnel> }
async function setup(t: { after(fn: () => unknown): void }, o: { installRoot?: string; detect?: DeviceDeps["detect"]; permissions?: Parameters<Kernel["pair"]>[1]; connect?: boolean; deps?: DeviceDeps } = {}): Promise<Setup> {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-device-"));
  const stateDir = join(dir, "state"), workdir = join(dir, "work");
  const kernel = await startKernel();
  const identity = await loadIdentity(stateDir);
  kernel.pair({ id: identity.id, publicKey: identity.publicKey, stateDir }, o.permissions);
  const device = await startDevice({ gateway: "", name: "Test Mac", stateDir, workdir, installRoot: o.installRoot }, undefined, { relay: false, detect: o.detect ?? nothing, ego: null, kimiPorts: [0], codexApp: false, ...o.deps });
  t.after(async () => { await device.close(); await kernel.stop(); });
  const tunnel = o.connect === false ? { cut() {} } : openTunnel(kernel, device, identity.id);
  return { kernel, device, id: identity.id, dir, workdir, stateDir, tunnel };
}

test("the first connection after pairing: the hub proves the secret, the computer pins its owner key and forgets the secret", async (t) => {
  const s = await setup(t, { connect: false });
  const file = join(s.stateDir, "paired.json");
  // What setup writes: the owner key the relay named (not trusted yet) and the secret from the install command.
  const told = (await loadIdentity(join(s.dir, "someone-else"))).publicKey;
  await writeFile(file, JSON.stringify({ owner_key: told, permissions: ["expose_capability"], secret: "one-time-secret" }));
  s.kernel.relay.security.pairSecret = "one-time-secret";
  openTunnel(s.kernel, s.device, s.id);
  await s.device.client.ready();
  const pinned = JSON.parse(await readFile(file, "utf8"));
  assert.equal(pinned.owner_key, s.kernel.relay.ownerKey, "the key the secret proved, not the one the relay named");
  assert.equal(pinned.secret, undefined);
  assert.deepEqual(pinned.permissions, ["expose_capability"]);
  assert.equal(s.device.lastRefusal, null);
});

test("a hub that cannot prove the pairing secret is not let in, and the computer says why", async (t) => {
  const s = await setup(t, { connect: false });
  const file = join(s.stateDir, "paired.json");
  await writeFile(file, JSON.stringify({ owner_key: s.kernel.relay.ownerKey, secret: "the-real-secret" }));
  s.kernel.relay.security.pairSecret = "not-the-secret";
  openTunnel(s.kernel, s.device, s.id);
  await eventually(() => s.device.lastRefusal, "the refusal");
  assert.deepEqual(s.device.lastRefusal, { message: "the hub could not prove the pairing secret: the relay may have swapped the owner's key", pairing: true });
  assert.equal(JSON.parse(await readFile(file, "utf8")).secret, "the-real-secret", "nothing pinned");
  assert.equal(s.kernel.hands.online(s.id), false);
});

test("the handshake: this computer signs in as a computer, with the device channel and, when a runtime is installed, the agent channel", async (t) => {
  const s = await setup(t, { detect: codexOnly });
  const welcome = await s.device.client.ready();
  assert.equal(welcome.hand_id, s.id);
  assert.deepEqual(welcome.channels, { device: { accepted: true }, agent: { accepted: true } });
  await eventually(() => s.kernel.registry.members.has(`device:${s.id}`), "the hand registering");
  const record = s.kernel.hands.get(s.id)!;
  assert.deepEqual([record.kind, record.name, record.version, record.paired_by], ["computer", "Test Mac", DEVICE_VERSION, "gateway"]);
  assert.match(record.platform ?? "", /^[a-z0-9]+-[a-z0-9]+$/);
  assert.equal(s.kernel.hands.online(s.id), true);
  // the runtimes it offers, as SPEC-08 §1.3 has them
  const hello = s.kernel.hands.get(s.id);
  assert.ok(hello);
});

test("without an installed runtime the agent channel is not even asked for", async (t) => {
  const s = await setup(t, { detect: nothing });
  const welcome = await s.device.client.ready();
  assert.equal(welcome.channels.agent, undefined);
  assert.deepEqual(welcome.channels.device, { accepted: true });
});

test("the manifest declares workspace.* and body.info always, in the standard form; the hub registers them only for a bound computer", async (t) => {
  const s = await setup(t);
  await s.device.client.ready();
  await eventually(() => s.kernel.registry.members.has(`device:${s.id}`), "the hand registering");
  // every capability is accepted by the hub's own check
  assert.deepEqual(s.kernel.hands.capabilities(s.id).filter((name) => BODY.includes(name)).sort(), [...BODY].sort());
  for (const stored of s.kernel.db.prepare("SELECT spec FROM hand_capabilities WHERE hand = ?").all(s.id) as { spec: string }[]) assert.equal(checkCapabilitySpec(JSON.parse(stored.spec)), null);

  // not bound: the hand only
  const hand = s.kernel.registry.members.get(`device:${s.id}`)!;
  assert.deepEqual(hand.words().map((w) => w.word).filter((w) => BODY.includes(w)), []);
  assert.equal(s.kernel.registry.members.has(`body:${s.id}`), false);
  assert.equal(await errorCode(s.kernel.call(`body:${s.id}`, "workspace.ls")), "offline");

  // bound: body:<id> with the ten words, the hand unchanged
  await s.kernel.body("bind", { hand: s.id });
  const body = s.kernel.registry.members.get(`body:${s.id}`)!;
  assert.deepEqual(body.words().map((w) => w.word).sort(), [...BODY].sort());
  assert.deepEqual(body.words().find((w) => w.word === "workspace.write")!.per_call_risk, true);
  assert.deepEqual(body.words().find((w) => w.word === "workspace.bash")!.effect, "execute");
  assert.deepEqual(s.kernel.registry.members.get(`device:${s.id}`)!.words().map((w) => w.word).filter((w) => BODY.includes(w)), []);
  const info = await s.kernel.call(`body:${s.id}`, "body.info");
  assert.equal((info.data as any).ownership, "borrowed");
  assert.equal((info.data as any).workdir, s.workdir);
  assert.equal((await s.kernel.body("describe", { body: `body:${s.id}` })).info.ownership, "borrowed");

  // unbound: the body goes offline at once, the connection and the hand stay
  assert.deepEqual(await s.kernel.body("unbind", { body: `body:${s.id}` }), { unbound: true });
  assert.equal(s.kernel.registry.members.has(`body:${s.id}`), false);
  assert.equal(s.kernel.registry.members.has(`device:${s.id}`), true);
  assert.equal(s.kernel.hands.online(s.id), true);
  assert.equal(await errorCode(s.kernel.call(`body:${s.id}`, "workspace.ls")), "offline");
});

test("workspace.write is assessed per call: harmless inside the work directory, a lasting change anywhere else; the calls really run", async (t) => {
  const s = await setup(t);
  await s.device.client.ready();
  await eventually(() => s.kernel.registry.members.has(`device:${s.id}`), "the hand registering");
  await s.kernel.body("bind", { hand: s.id });
  const body = `body:${s.id}`;
  const outside = join(s.dir, "elsewhere", "note.txt");
  await mkdir(join(s.dir, "elsewhere"));

  const assess = (path: string) => s.kernel.hands.assess(request(body, "workspace.write", { path, content: "x" }));
  assert.equal(await assess("inside.txt"), "none");
  assert.equal(await assess(join(s.workdir, "deep", "inside.txt")), "none");
  assert.equal(await assess(outside), "structure");
  assert.equal(await assess("../elsewhere/x.txt"), "structure");
  assert.equal(await s.kernel.hands.assess(request(body, "workspace.edit", { path: "inside.txt", edits: [{ oldText: "a", newText: "b" }] })), "none");
  // only a word that asks per call is asked
  assert.equal(await s.kernel.hands.assess(request(body, "workspace.bash", { command: "true" })), null);

  await s.kernel.call(body, "workspace.write", { path: "inside.txt", content: "hello" });
  assert.equal(await readFile(join(s.workdir, "inside.txt"), "utf8"), "hello");
  const read = await s.kernel.call(body, "workspace.read", { path: "inside.txt" });
  assert.equal((read.data as any).text, "hello");
  const ran = await s.kernel.call(body, "workspace.bash", { command: "echo $((6*7))" });
  assert.match((ran.data as any).output, /42/);
  assert.equal(await errorCode(s.kernel.call(body, "workspace.read", { path: "missing.txt" })), "not_found");
  assert.equal(await errorCode(s.kernel.call(body, "workspace.read", { path: "" })), "bad_request");
  // `~` still means the home folder
  assert.equal(await errorCode(s.kernel.call(body, "workspace.ls", { path: "~/definitely-not-here-ash" })), "not_found");

  // a picture is a stream the hub receives whole; the result refers to it
  await writeFile(join(s.workdir, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  const pic = await s.kernel.call(body, "workspace.read", { path: "pic.png" });
  const resource = (pic.content ?? []).find((c) => c.type === "resource") as any;
  assert.ok(resource.stream.startsWith("st_"));
  assert.deepEqual([resource.mime, resource.size], ["image/png", 7]);
});

test("the program's own update is offered only by a copy the service installer put there", async (t) => {
  const plain = await setup(t);
  await plain.device.client.ready();
  await eventually(() => plain.kernel.registry.members.has(`device:${plain.id}`), "the hand registering");
  assert.equal(plain.kernel.registry.members.get(`device:${plain.id}`)!.words().some((w) => w.word === "x.ash.update"), false);
});

test("the update waits for a command left running in the background", async (t) => {
  const s = await setup(t, { installRoot: "/nonexistent-ash-root", deps: { restart: () => {} } });
  await s.device.client.ready();
  await eventually(() => s.kernel.registry.members.has(`device:${s.id}`), "the hand registering");
  await s.kernel.body("bind", { hand: s.id });
  const updater = context({ caller: { member: "service:devices", via: "service", local: true } });
  const update = () => s.kernel.registry.members.get(`device:${s.id}`)!.handle(request(`device:${s.id}`, "x.ash.update", { version: "0.2.1", sha256: "a".repeat(64) }, "service:devices"), updater);
  const run = await s.kernel.call(`body:${s.id}`, "workspace.bash", { command: "sleep 30", yield_ms: 0 });
  assert.equal(await errorCode(update()), "conflict");
  await s.kernel.call(`body:${s.id}`, "workspace.signal", { process: (run.data as any).process, signal: "TERM" });
  await s.kernel.call(`body:${s.id}`, "workspace.poll", { process: (run.data as any).process, yield_ms: 5000 });
  assert.notEqual(await errorCode(update()), "conflict", "once the command has ended the update goes on to install");
});

test("a computer allowed only to run local agents gets the agent channel and no device channel", async (t) => {
  const s = await setup(t, { detect: codexOnly, permissions: { lend: false, local_agents: true } });
  const welcome = await s.device.client.ready();
  assert.equal((welcome.channels.device as any).accepted, false);
  assert.equal((welcome.channels.agent as any).accepted, true);
  const listed = await s.kernel.remote.ok("agent.list");
  assert.deepEqual(listed.agents, []);
  assert.equal(s.kernel.registry.members.has(`device:${s.id}`), false);
});

test("a computer not allowed to run local agents is refused the agent channel; its hand works", async (t) => {
  const s = await setup(t, { detect: codexOnly, permissions: { lend: true, local_agents: false } });
  const welcome = await s.device.client.ready();
  assert.deepEqual([(welcome.channels.device as any).accepted, (welcome.channels.agent as any).accepted], [true, false]);
  await eventually(() => s.kernel.registry.members.has(`device:${s.id}`), "the hand registering");
});

test("agent channel: a Codex session is started, driven, steered, interrupted, compacted, replaced and resumed", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-codex-"));
  const original = process.env.PATH;
  process.env.PATH = withPath(await fakeCodex(dir, fixture));
  t.after(() => { process.env.PATH = original; });
  const log = join(dir, "codex.log");
  const s = await setup(t, { detect: codexOnly });
  await s.device.client.ready();
  const { remote } = s.kernel;
  const agent = "agent:main";
  const msg = (id: string, text: string, lane = "front") => ({ id, from: "person:owner", word: "say", text, lane, at: Date.UTC(2026, 9, 10) });
  const spec = (sessions: Record<string, string> = {}) => ({
    runtime: { kind: "codex", model: "test-model" },
    native: { on: s.id, cwd: join(dir, "cwd"), env: { FIXTURE_LOG: log } },
    tools: { mcp_url: "http://127.0.0.1:1/mcp", tokens: { front: "unused" }, allowed: ["agent_list"] },
    modules: { static: [{ id: "identity", version: "v1", content: "You are Ash." }] },
    lanes: ["front", "back"], sessions,
  });
  const logged = async () => (await readFile(log, "utf8").catch(() => "")).split("\n");

  // start: both lanes, their handles reported, status in order
  const started = await remote.ok("agent.start", { agent, spec: spec() });
  assert.deepEqual(Object.keys(started.sessions).sort(), ["back", "front"]);
  assert.match(started.sessions.front, /^ash-codex-v1:[0-9a-f]{16}:thread-\d+$/);
  assert.deepEqual(remote.named("agent.status").map((e) => e.state), ["starting", "running"]);
  assert.deepEqual(remote.named("handle.updated").map((e) => [e.key, e.handle]).sort(), Object.entries(started.sessions).sort());

  // send: the turn starts, the runtime asks an Ash tool and gets the hub's answer, a second send is a conflict
  await remote.ok("send", { agent, key: "front", messages: [msg("m1", "hello")] });
  const turn = (await remote.waitFor("turn.started", (e) => e.key === "front")).turn;
  assert.deepEqual(remote.named("turn.started")[0]!.ids, ["m1"]);
  await eventually(() => remote.tools.length === 1, "the tool call reaching the hub");
  assert.deepEqual([remote.tools[0]!.outbound, remote.tools[0]!.agent, remote.tools[0]!.key, remote.tools[0]!.turn, remote.tools[0]!.args], ["agent_list", agent, "front", turn, {}]);
  assert.equal((await remote.call("send", { agent, key: "front", messages: [msg("m2", "no")] })).error.code, "conflict");
  assert.ok((await logged()).some((l) => l.startsWith("turn/start [ash] ") === false && l.includes("hello")), "the runtime was told the words");

  // the other lane runs at the same time
  await remote.ok("send", { agent, key: "back", messages: [msg("b1", "background", "back")] });
  await remote.waitFor("turn.started", (e) => e.key === "back");

  // steer: taken while running, refused when idle; the turn ends with the reply as speech
  assert.deepEqual(await remote.ok("steer", { agent, key: "front", text: "finish" }), { accepted: true });
  const ended = await remote.waitFor("turn.ended", (e) => e.key === "front");
  assert.deepEqual([ended.turn, ended.outcome], [turn, "completed"]);
  assert.ok(remote.named("output", (e) => e.key === "front")[0]!.text.includes("完整结果🙂"));
  assert.deepEqual(await remote.ok("steer", { agent, key: "front", text: "late" }), { accepted: false });

  // interrupt
  await remote.ok("send", { agent, key: "front", messages: [msg("m3", "again")] });
  await eventually(() => remote.named("turn.started", (e) => e.key === "front").length === 2, "the second turn");
  await remote.ok("interrupt", { agent, key: "front" });
  await eventually(() => remote.named("turn.ended", (e) => e.key === "front").length === 2, "the interrupted turn's end");
  assert.equal(remote.named("turn.ended", (e) => e.key === "front")[1]!.outcome, "interrupted");

  // inject goes in front of the next turn
  await remote.ok("inject", { agent, key: "front", text: "REMEMBER-THE-MILK", modules: [] });
  await remote.ok("send", { agent, key: "front", messages: [msg("m4", "third")] });
  await eventually(async () => (await logged()).some((l) => l.includes("REMEMBER-THE-MILK")), "the injected text reaching the runtime");
  await remote.ok("interrupt", { agent, key: "front" });
  await eventually(() => remote.named("turn.ended", (e) => e.key === "front").length === 3, "the third turn's end");

  // session control
  const handle = (await remote.ok("session.get", { agent, key: "front" })).handle;
  assert.equal(handle, started.sessions.front);
  assert.equal((await remote.ok("session.compact", { agent, key: "front" })).compacted, true);
  assert.ok((await logged()).includes("thread/compact/start"));
  assert.deepEqual(await remote.ok("configure", { agent, key: "front", config: { effort: "high" } }), { model: "test-model", effort: "high" });
  assert.deepEqual(await remote.ok("config.get", { agent }), { model: "test-model", effort: "high" });
  const fresh = (await remote.ok("session.new", { agent, key: "front" })).handle;
  assert.notEqual(fresh, handle);
  assert.equal((await remote.ok("session.get", { agent, key: "front" })).handle, fresh);
  await remote.ok("session.set", { agent, key: "front", handle });
  assert.equal((await remote.ok("session.get", { agent, key: "front" })).handle, handle);
  assert.equal((await remote.call("plugins", { agent, action: "list" })).error.code, "unavailable");
  assert.equal((await remote.call("session.get", { agent: "agent:nobody", key: "front" })).error.code, "not_found");
  assert.equal((await remote.call("send", { agent, key: "front", messages: [] })).error.code, "bad_request");

  // stop, then start again from the saved handles: the runtime resumes the sessions
  await remote.ok("agent.stop", { agent, reason: "test" });
  assert.equal(remote.named("agent.status").at(-1)!.state, "exited");
  assert.equal((await remote.call("send", { agent, key: "front", messages: [msg("m5", "x")] })).error.code, "not_found");
  const before = (await logged()).filter((l) => l === "thread/resume").length;
  const again = await remote.ok("agent.start", { agent, spec: spec({ front: handle }) });
  assert.equal(again.sessions.front, handle, "the same session");
  assert.equal((await logged()).filter((l) => l === "thread/resume").length, before + 1);
  assert.equal(again.attached, false);

  // an agent that is running is attached, not started over
  const attached = await remote.ok("agent.start", { agent, spec: spec() });
  assert.equal(attached.attached, true);
  assert.deepEqual(attached.sessions.front, handle);
  assert.equal((await remote.ok("agent.list")).agents.length, 1);
  // an unknown runtime here
  assert.equal((await remote.call("agent.start", { agent: "agent:x", spec: { ...spec(), runtime: { kind: "workbuddy" } } })).error.code, "unavailable");
});

test("the agent keeps running while the connection is down; what it did is sent when the channel returns, and the hub's start attaches", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-codex-"));
  const original = process.env.PATH;
  process.env.PATH = withPath(await fakeCodex(dir, fixture));
  t.after(() => { process.env.PATH = original; });
  const s = await setup(t, { detect: codexOnly });
  await s.device.client.ready();
  const { remote } = s.kernel;
  const agent = "agent:main";
  const spec = { runtime: { kind: "codex" }, native: { on: s.id, cwd: join(dir, "cwd") }, tools: { mcp_url: "x", tokens: { front: "x" }, allowed: [] }, modules: { static: [] }, lanes: ["front"], sessions: {} };
  await remote.ok("agent.start", { agent, spec });
  await remote.ok("send", { agent, key: "front", messages: [{ id: "m1", from: "person:owner", word: "say", text: "work", lane: "front", at: 1 }] });
  await remote.waitFor("turn.started");

  // the tunnel is cut; the turn finishes while nobody listens
  const seen = remote.events.length;
  s.tunnel.cut();
  await eventually(() => remote.session === null, "the hub's side of the channel closing");
  await eventually(() => s.device.client.state === "waiting", "the program noticing");
  // (the runtime ends its own turn: steer it through the program, as the channel would)
  await s.device.agents.handle({ t: "agent", id: "x1", op: "steer", agent, key: "front", text: "finish" } as never);
  assert.equal(remote.events.length, seen, "nothing reaches a hub that is not there");

  // the relay opens a new tunnel: the program signs in again and the owed events arrive, in order
  const second = openTunnel(s.kernel, s.device, s.id);
  void second;
  await s.device.client.ready();
  await remote.waitFor("turn.ended", () => true, "the turn that ended meanwhile");
  assert.ok(remote.events.slice(seen).some((e) => e.event === "output" && e.text.includes("完整结果🙂")));
  const order = remote.events.slice(seen).map((e) => e.event);
  assert.ok(order.indexOf("output") < order.indexOf("turn.ended"));

  // the hub starts the agent again: it is attached; running turns would be announced again
  const attached = await remote.ok("agent.start", { agent, spec });
  assert.equal(attached.attached, true);
});

test("when the hub does not return in time the agents are stopped", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-codex-"));
  const original = process.env.PATH;
  process.env.PATH = withPath(await fakeCodex(dir, fixture));
  t.after(() => { process.env.PATH = original; });
  const s = await setup(t, { detect: codexOnly, deps: { graceMs: 50 } });
  await s.device.client.ready();
  await s.kernel.remote.ok("agent.start", { agent: "agent:main", spec: { runtime: { kind: "codex" }, native: { on: s.id, cwd: join(dir, "cwd") }, tools: { mcp_url: "x", tokens: { front: "x" }, allowed: [] }, modules: { static: [] }, lanes: ["front"], sessions: {} } });
  assert.equal(s.device.agents.list().length, 1);
  s.tunnel.cut();
  await eventually(() => s.device.agents.list().length === 0, "the agents being stopped");
});

test("a newer tunnel replaces the one in use; the program signs in again on it", async (t) => {
  const s = await setup(t);
  const first = await s.device.client.ready();
  await eventually(() => s.kernel.registry.members.has("device:" + s.id), "the hand registering");
  openTunnel(s.kernel, s.device, s.id);
  await eventually(() => s.device.client.state === "ready" && s.device.client.welcome?.session !== first.session, "the new session");
  assert.equal(s.kernel.hands.online(s.id), true);
  await eventually(() => s.kernel.registry.members.has("device:" + s.id), "the hand registered again");
});

test("a revoked computer is refused with 4003 and stops for good", async (t) => {
  const s = await setup(t, { connect: false });
  s.kernel.hands.revoke(s.id);
  openTunnel(s.kernel, s.device, s.id);
  await s.device.run;
  assert.equal(s.device.client.stoppedBy, 4003);
});

test("the computer's key signs the hub's challenge: the hand id is the hash of the key the hub sees", async (t) => {
  const s = await setup(t);
  await s.device.client.ready();
  assert.equal(s.device.handId, s.id);
  const hand = s.kernel.hands.get(s.id)!;
  assert.equal(hand.public_key.length > 0, true);
});

test("the Codex app: while it runs the hub is offered x.codex.* and its two events; a call reaches it and a finished turn is reported as the hand's event", async (t) => {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "ash-cxdev-"));
  const desktop = new Desktop(join(dir, "ipc.sock"));
  await desktop.listen();
  await desktop.owner();
  t.after(() => desktop.stop().catch(() => {}));
  desktop.state.set("t1", { revision: 1, raw: snapshot({ threadRuntimeStatus: { type: "active" }, turns: [turn("u1", "inProgress", [{ type: "agentMessage", text: "on it" }])] }) });
  const s = await setup(t, { deps: { codexApp: { socketPath: desktop.path, ownerWaitMs: 300, reconnectMs: 30, listThreads: async () => [{ id: "t1", title: "Fix the build", updated_at: 5 }] } } });
  await s.device.client.ready();
  await eventually(() => s.kernel.registry.members.has(`device:${s.id}`) && s.kernel.hands.capabilities(s.id).includes("x.codex.send"), "the Codex capabilities declared");
  const names = s.kernel.hands.capabilities(s.id).filter((n) => n.startsWith("x.codex."));
  assert.deepEqual(names.sort(), ["x.codex.approvals", "x.codex.approve", "x.codex.new", "x.codex.open", "x.codex.send", "x.codex.session", "x.codex.sessions", "x.codex.stop"]);

  const listed = await s.kernel.call(`device:${s.id}`, "x.codex.sessions");
  assert.deepEqual((listed.data as any).sessions.map((x: any) => [x.id, x.state, x.open]), [["t1", "running", true]]);

  desktop.change("t1", desktop.state.get("t1")!.raw, [
    { op: "replace", path: ["threadRuntimeStatus", "type"], value: "idle" },
    { op: "replace", path: ["turns", 0, "status"], value: "completed" },
  ]);
  await eventually(() => s.kernel.router.sent.some((m) => m.msg.word === "codex.turn_ended"), "the turn_ended event reaching the hub");
  const sent = s.kernel.router.sent.find((m) => m.msg.word === "codex.turn_ended")!;
  assert.deepEqual([sent.msg.to, sent.msg.kind, (sent.msg.body as any).thread, (sent.msg.body as any).title], ["service:devices", "event", "t1", "Fix the build"]);

  await desktop.stop();
  await eventually(() => !s.kernel.hands.capabilities(s.id).some((n) => n.startsWith("x.codex.")), "the capabilities withdrawn when the app quits");
});
