import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { CLOSE_CODES, LIMITS, type CapabilitySpec, type Frame } from "../../sdk/src/link";
import { eventually } from "../../core/test/fixtures/wait";
import { FakeClock } from "./fixtures/clock";
import { TOKEN, deferred, nodeHand, startKernel } from "./fixtures/harness";
import { HandClient, MemoryEventQueue, type Connector } from "../src/hand";
import { nodeConnector } from "../src/client";
import { LinkError, type LinkSession } from "../src/server";

const cap = (name: string, over: Partial<CapabilitySpec> = {}): CapabilitySpec => ({ name, description: name, input_schema: { type: "object" }, effect: "read", risk: "none", ...over });
const caller = { member: "agent:main", label: "main" };
const deadlineIn = (ms = 60_000) => Date.now() + ms;

test("handshake: challenge, hello, welcome; the token header reaches the callback", async () => {
  let seenHeader: string | undefined;
  const kernel = await startKernel({
    authenticate: (hello, ctx) => {
      seenHeader = ctx.headers.authorization;
      return { ok: true, hand_id: "hand-1", channels: { device: { accepted: true }, human: { accepted: false, reason: "not offered here" } } };
    },
  });
  const hand = nodeHand(kernel, "laptop");
  try {
    hand.start();
    const welcome = await hand.ready();
    assert.equal(seenHeader, `Bearer ${TOKEN}`);
    assert.equal(welcome.hand_id, "hand-1");
    assert.equal(welcome.heartbeat_ms, LIMITS.heartbeatMs);
    assert.deepEqual(welcome.channels, { device: { accepted: true }, human: { accepted: false, reason: "not offered here" } });
    assert.equal(kernel.sessions[0]!.hello.hand.name, "laptop");
  } finally { hand.stop(); await kernel.stop(); }
});

test("a rejected identity is closed with the code the callback chose (4001) and the hand keeps trying", async () => {
  const kernel = await startKernel();
  const clock = new FakeClock();
  const closes: { code: number; willReconnect: boolean }[] = [];
  const hand = nodeHand(kernel, "laptop", { headers: () => ({ authorization: "Bearer wrong" }), clock }, { closed: (info) => closes.push(info) });
  try {
    hand.start();
    await eventually(() => closes.length === 1, "first close");
    assert.deepEqual(closes[0], { code: 4001, reason: "bad token", willReconnect: true });
    assert.equal(hand.state, "waiting");
  } finally { hand.stop(); await kernel.stop(); }
});

test("a revoked hand (4003) is not retried", async () => {
  const kernel = await startKernel({ authenticate: () => ({ ok: false, code: CLOSE_CODES.revoked, reason: "revoked" }) });
  const hand = nodeHand(kernel, "laptop");
  try {
    hand.start();
    await assert.rejects(hand.ready());
    assert.equal(hand.state, "stopped");
    assert.equal(hand.stoppedBy, 4003);
  } finally { await kernel.stop(); }
});

test("a hello with another protocol name is closed with 4008", async () => {
  const kernel = await startKernel();
  try {
    for (const hello of [
      { t: "hello", protocol: "ash-link/9", hand: { kind: "phone", name: "p", version: "1", platform: "x" }, channels: { device: {} } },
      { t: "hello", protocol: "ash-link/9", somethingNew: true },
    ]) {
      const ws = new WebSocket(kernel.url, { headers: { authorization: `Bearer ${TOKEN}` } });
      const closed = new Promise<number>((resolve) => ws.on("close", resolve));
      ws.on("message", () => ws.send(JSON.stringify(hello)));
      assert.equal(await closed, 4008);
    }
  } finally { await kernel.stop(); }
});

test("a kernel that speaks another protocol makes the hand stop with 4008", async () => {
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (ws) => ws.send(JSON.stringify({ t: "challenge", nonce: "n", kernel: { id: "k", version: "9", protocol: "ash-link/9" } })));
  await new Promise((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  const hand = nodeHand({ url: `ws://127.0.0.1:${port}/link` }, "laptop");
  try {
    hand.start();
    await assert.rejects(hand.ready());
    assert.equal(hand.stoppedBy, 4008);
  } finally { wss.close(); }
});

test("a malformed frame after the handshake is closed with 4400 after an error frame", async () => {
  const kernel = await startKernel();
  const hand = nodeHand(kernel, "laptop");
  try {
    hand.start();
    await hand.ready();
    const ws = new WebSocket(kernel.url, { headers: { authorization: `Bearer ${TOKEN}` } });
    const seen: Frame[] = [];
    const closed = new Promise<number>((resolve) => ws.on("close", resolve));
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      seen.push(frame);
      if (frame.t === "challenge") ws.send(JSON.stringify({ t: "hello", protocol: "ash-link/2", hand: { kind: "computer", name: "raw", version: "1", platform: "x" }, channels: { device: {} } }));
      if (frame.t === "welcome") ws.send(JSON.stringify({ t: "event", ch: "device", word: "no id" }));
    });
    assert.equal(await closed, 4400);
    assert.ok(seen.some((f) => f.t === "error" && f.code === "bad_request"));
  } finally { hand.stop(); await kernel.stop(); }
});

test("a second connection of the same hand replaces the first with 4009; the first does not reconnect", async () => {
  const kernel = await startKernel();
  const first = nodeHand(kernel, "laptop");
  const second = nodeHand(kernel, "laptop");
  try {
    first.start();
    await first.ready();
    second.start();
    await second.ready();
    await eventually(() => first.stoppedBy === 4009, "first hand told 4009");
    assert.equal(first.state, "stopped");
    assert.equal(second.state, "ready");
    assert.equal(kernel.link.sessions().length, 1);
  } finally { first.stop(); second.stop(); await kernel.stop(); }
});

test("a newer connection with a device or agent channel replaces the older one that has one (4009)", async () => {
  const kernel = await startKernel();
  const device = nodeHand(kernel, "laptop", { channels: { device: {} } });
  const agent = nodeHand(kernel, "laptop", { channels: { agent: { runtimes: [] } } });
  const humanOnly = nodeHand(kernel, "laptop", { channels: { human: {} } });
  try {
    device.start();
    await device.ready();
    humanOnly.start();
    await humanOnly.ready();
    assert.equal(device.state, "ready"); // a human-only connection replaces nothing
    agent.start();
    await agent.ready();
    await eventually(() => device.stoppedBy === 4009, "device connection told 4009");
    assert.equal(humanOnly.state, "ready");
    assert.equal(agent.state, "ready");
  } finally { device.stop(); agent.stop(); humanOnly.stop(); await kernel.stop(); }
});

test("two connections of the same hand that only carry human live side by side", async () => {
  const kernel = await startKernel();
  const tabs = [nodeHand(kernel, "browser", { channels: { human: {} } }), nodeHand(kernel, "browser", { channels: { human: {} } })];
  try {
    for (const tab of tabs) { tab.start(); await tab.ready(); }
    assert.equal(kernel.link.sessions().length, 2);
    assert.ok(tabs.every((tab) => tab.state === "ready"));
  } finally { for (const tab of tabs) tab.stop(); await kernel.stop(); }
});

test("queued events are not sent again after a welcome that refused the device channel", async () => {
  const kernel = await startKernel({
    authenticate: () => ({ ok: true, hand_id: "h", channels: { device: { accepted: false, reason: "no expose_capability" } } }),
  });
  const queue = new MemoryEventQueue();
  await queue.add({ id: "e_old", word: "sense.battery", body: {}, at: 1 });
  const outgoing: string[] = [];
  const spying: Connector = (url, headers, events) => {
    const socket = nodeConnector(url, headers, events);
    return { send: (data) => { outgoing.push(data); socket.send(data); }, close: (code, reason) => socket.close(code, reason) };
  };
  const hand = nodeHand(kernel, "laptop", { eventQueue: queue, connector: spying });
  try {
    hand.start();
    await hand.ready();
    for (let i = 0; i < 5; i++) await Promise.resolve(); // the resend, if there were one, starts right after the welcome
    assert.equal(outgoing.some((data) => data.includes('"t":"event"')), false);
    assert.equal(queue.pending().length, 1);
  } finally { hand.stop(); await kernel.stop(); }
});

test("only /link is taken; other upgrade paths are left to other listeners", async () => {
  const kernel = await startKernel();
  const other = deferred<string>();
  kernel.http.on("upgrade", (req, socket) => { if (req.url === "/other") { other.resolve(req.url); socket.destroy(); } });
  try {
    const ws = new WebSocket(kernel.url.replace("/link", "/other"));
    ws.on("error", () => {});
    assert.equal(await other.promise, "/other");
  } finally { await kernel.stop(); }
});

test("call -> progress -> result, and a failing hand's error comes back as a result", async () => {
  const kernel = await startKernel();
  const hand = nodeHand(kernel, "laptop", {}, {
    call: async (call, ctx) => {
      if (call.capability === "workspace.read") { ctx.progress("reading"); return { ok: true, content: [{ type: "text", text: `read ${String(call.args.path)}` }], data: { n: 1 } }; }
      throw new Error("boom");
    },
  });
  try {
    hand.start();
    await hand.ready();
    const session = kernel.sessions[0]!;
    const progress: string[] = [];
    const done = await session.call({ capability: "workspace.read", args: { path: "a.txt" }, caller, deadline: deadlineIn(), onProgress: (text) => progress.push(text) });
    assert.deepEqual(done, { t: "result", id: done.id, ok: true, content: [{ type: "text", text: "read a.txt" }], data: { n: 1 } });
    assert.deepEqual(progress, ["reading"]);
    const failed = await session.call({ capability: "workspace.write", args: {}, caller, deadline: deadlineIn() });
    assert.equal(failed.ok, false);
    assert.equal(failed.ok === false && failed.error.code, "failed");
  } finally { hand.stop(); await kernel.stop(); }
});

test("cancel reaches the hand's handler and the hand still answers", async () => {
  const kernel = await startKernel();
  const started = deferred();
  const hand = nodeHand(kernel, "laptop", {}, {
    call: (_call, ctx) => new Promise((resolve) => {
      started.resolve();
      ctx.signal.addEventListener("abort", () => resolve({ ok: false, error: { code: "cancelled", message: "stopped" } }));
    }),
  });
  try {
    hand.start();
    await hand.ready();
    const abort = new AbortController();
    const pending = kernel.sessions[0]!.call({ capability: "screen.tap", args: {}, caller, deadline: deadlineIn(), signal: abort.signal });
    await started.promise;
    abort.abort();
    const result = await pending;
    assert.equal(result.ok === false && result.error.code, "cancelled");
  } finally { hand.stop(); await kernel.stop(); }
});

test("a call past its deadline rejects with a deadline error and cancels the hand; a dropped connection rejects with closed", async () => {
  const clock = new FakeClock();
  const kernel = await startKernel({ clock });
  const cancelled = deferred<string>();
  const hand = nodeHand(kernel, "laptop", {}, {
    call: (_call, ctx) => new Promise(() => { ctx.signal.addEventListener("abort", () => cancelled.resolve("aborted")); }),
  });
  try {
    hand.start();
    await hand.ready();
    const session = kernel.sessions[0]!;
    const late = session.call({ capability: "screen.tap", args: {}, caller, deadline: clock.now() + 5_000 });
    clock.advance(5_000);
    await assert.rejects(late, (error) => error instanceof LinkError && error.kind === "deadline");
    assert.equal(await cancelled.promise, "aborted");

    const dropped = session.call({ capability: "screen.tap", args: {}, caller, deadline: clock.now() + 60_000 });
    session.close(CLOSE_CODES.normal, "bye");
    await assert.rejects(dropped, (error) => error instanceof LinkError && error.kind === "closed");
  } finally { hand.stop(); await kernel.stop(); }
});

test("the 17th call in flight is answered unavailable by the hand", async () => {
  const kernel = await startKernel();
  const release = deferred();
  const hand = nodeHand(kernel, "laptop", {}, { call: async () => { await release.promise; return { ok: true, content: [] }; } });
  try {
    hand.start();
    await hand.ready();
    const session = kernel.sessions[0]!;
    const calls = Array.from({ length: LIMITS.inflightCalls + 1 }, () => session.call({ capability: "x.y", args: {}, caller, deadline: deadlineIn() }));
    const over = await Promise.race(calls.map(async (c, i) => ({ i, r: await c })));
    assert.equal(over.i, LIMITS.inflightCalls);
    assert.equal(over.r.ok === false && over.r.error.code, "unavailable");
    release.resolve();
    const rest = await Promise.all(calls.slice(0, LIMITS.inflightCalls));
    assert.ok(rest.every((r) => r.ok));
  } finally { hand.stop(); await kernel.stop(); }
});

test("assess -> assessed; no answer within 10 seconds gives null", async () => {
  const clock = new FakeClock();
  const kernel = await startKernel({ clock });
  let answer = true;
  const asked = deferred();
  const hand = nodeHand(kernel, "laptop", {}, {
    assess: async (capability) => {
      if (!answer) { asked.resolve(); return new Promise(() => {}); }
      return { risk: "outward", why: `${capability} leaves the work directory` };
    },
  });
  try {
    hand.start();
    await hand.ready();
    const session = kernel.sessions[0]!;
    assert.deepEqual(await session.assess("workspace.write", { path: "/etc/x" }), { risk: "outward", why: "workspace.write leaves the work directory" });
    answer = false;
    const silent = session.assess("workspace.write", {});
    await asked.promise;
    clock.advance(LIMITS.assessMs);
    assert.equal(await silent, null);
  } finally { hand.stop(); await kernel.stop(); }
});

test("manifest: bad capabilities are rejected one by one, the handler's verdict is added, and the manifest is sent again after a reconnect", async () => {
  const clock = new FakeClock();
  const received: number[] = [];
  const kernel = await startKernel({}, () => ({
    manifest: (frame, check) => { received.push(frame.rev); return { rejected: check.capabilities.filter((c) => c.name === "x.private").map((c) => ({ name: c.name, reason: "not allowed" })) }; },
  }));
  const hand = nodeHand(kernel, "laptop", { clock });
  try {
    hand.start();
    await hand.ready();
    const ack = await hand.setManifest([cap("screen.tap"), cap("x.private"), { name: "nonsense" } as unknown as CapabilitySpec]);
    assert.equal(ack.accepted, true);
    assert.deepEqual(ack.rejected.map((r) => r.name).sort(), ["nonsense", "x.private"]);
    kernel.sessions[0]!.close(CLOSE_CODES.internal, "restart");
    await eventually(() => hand.state === "waiting", "waiting to reconnect");
    clock.advance(30_000);
    await eventually(() => received.length === 2, "manifest sent again");
    assert.deepEqual(received, [1, 1]);
  } finally { hand.stop(); await kernel.stop(); }
});

test("events: acked ones leave the queue; unacked ones are sent again with the same id after a reconnect", async () => {
  const clock = new FakeClock();
  const handled: string[] = [];
  const kernel = await startKernel({}, () => ({ event: (frame) => { handled.push(frame.id); } }));
  const queue = new MemoryEventQueue();
  // The first connection loses every ack on the way to the hand.
  let connection = 0;
  const lossy: Connector = (url, headers, events) => {
    const mine = ++connection;
    return nodeConnector(url, headers, { ...events, message: (data, isBinary) => { if (mine === 1 && String(data).includes('"event.ack"')) return; events.message(data, isBinary); } });
  };
  const hand = nodeHand(kernel, "laptop", { clock, eventQueue: queue, connector: lossy });
  try {
    hand.start();
    await hand.ready();
    const id = await hand.emit("sense.battery", { level: 80 });
    await eventually(() => handled.length === 1, "kernel handled the event");
    assert.deepEqual(queue.pending().map((e) => e.id), [id]);
    kernel.sessions[0]!.close(CLOSE_CODES.internal, "restart");
    await eventually(() => hand.state === "waiting", "waiting to reconnect");
    clock.advance(30_000);
    await eventually(() => queue.pending().length === 0, "resent event acked");
    assert.deepEqual(handled, [id, id]); // the same id both times: de-duplicating is the caller's job
    assert.equal(hand.state, "ready");
  } finally { hand.stop(); await kernel.stop(); }
});

test("an event whose handler failed is not acked, and is handled when it comes again", async () => {
  const clock = new FakeClock();
  let attempts = 0;
  const kernel = await startKernel({ log: () => {} }, () => ({ event: () => { if (++attempts === 1) throw new Error("ledger busy"); } }));
  const queue = new MemoryEventQueue();
  const hand = nodeHand(kernel, "laptop", { clock, eventQueue: queue });
  try {
    hand.start();
    await hand.ready();
    await hand.emit("sense.battery", { level: 1 });
    await eventually(() => attempts === 1, "first attempt");
    assert.equal(queue.pending().length, 1);
    kernel.sessions[0]!.close(CLOSE_CODES.internal, "restart");
    await eventually(() => hand.state === "waiting", "waiting to reconnect");
    clock.advance(30_000);
    await eventually(() => queue.pending().length === 0, "second attempt acked");
    assert.equal(attempts, 2);
  } finally { hand.stop(); await kernel.stop(); }
});

test("a 3 MB stream arrives whole in both directions", async () => {
  const data = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 31 + (i >> 8)) & 0xff);
  const atKernel = deferred<{ ref?: string; mime?: string; data: Uint8Array }>();
  const atHand = deferred<{ ref?: string; mime?: string; data: Uint8Array }>();
  const kernel = await startKernel({}, () => ({ stream: (s) => atKernel.resolve(s) }));
  const hand = nodeHand(kernel, "laptop", {}, { stream: (s) => atHand.resolve(s) });
  try {
    hand.start();
    await hand.ready();
    hand.sendStream("device", data, { ref: "c_1", mime: "image/png" });
    kernel.sessions[0]!.sendStream("device", data, { ref: "c_2", mime: "image/png" });
    const [up, down] = await Promise.all([atKernel.promise, atHand.promise]);
    assert.equal(up.ref, "c_1");
    assert.equal(up.mime, "image/png");
    assert.ok(Buffer.from(up.data).equals(data));
    assert.equal(down.ref, "c_2");
    assert.ok(Buffer.from(down.data).equals(data));
  } finally { hand.stop(); await kernel.stop(); }
});

test("human channel: send, sync, presence, present", async () => {
  const seen: Frame[] = [];
  const kernel = await startKernel({}, (session) => ({
    human: (frame) => {
      seen.push(frame);
      if (frame.t === "send") session.send({ t: "send.result", id: frame.id, ok: true, message: { id: "m1", seq: 7 } });
      if (frame.t === "sync") {
        session.send({ t: "sync.page", sid: frame.sid, messages: [{ id: "m1", seq: 7 }], end: true });
        session.send({ t: "sync.msg", sid: frame.sid, message: { id: "m2", seq: 8 } });
      }
    },
  }));
  const hand = nodeHand(kernel, "web", { channels: { human: { surfaces: ["chat"] } } }, {
    present: async (frame) => ({ ok: true, data: { showing: frame.surface === "island" } }),
  });
  try {
    hand.start();
    const welcome = await hand.ready();
    assert.deepEqual(welcome.channels.human, { client: "client:web", local: true });
    const sent = await hand.send({ to: "agent:main", kind: "request", word: "say", body: { text: "hi" } });
    assert.deepEqual(sent.ok && sent.message, { id: "m1", seq: 7 });
    const pages = deferred<unknown>();
    const pushed = deferred<unknown>();
    hand.openSync({ follow: true }, { page: (f) => pages.resolve(f.messages), message: (f) => pushed.resolve(f.message) });
    assert.deepEqual(await pages.promise, [{ id: "m1", seq: 7 }]);
    assert.deepEqual(await pushed.promise, { id: "m2", seq: 8 });
    hand.presence({ visible: true });
    await eventually(() => seen.some((f) => f.t === "presence"), "presence");
    const session = kernel.sessions[0]!;
    session.send({ t: "present", ch: "human", id: "p1", surface: "island", op: "query", body: {} });
    await eventually(() => seen.find((f) => f.t === "present.result"), "present.result");
    assert.deepEqual(seen.find((f) => f.t === "present.result"), { t: "present.result", id: "p1", ok: true, data: { showing: true } });
  } finally { hand.stop(); await kernel.stop(); }
});

test("a channel the hand was not given answers forbidden", async () => {
  const kernel = await startKernel({
    authenticate: () => ({ ok: true, hand_id: "h", channels: { device: { accepted: false, reason: "no expose_capability" }, human: { accepted: true, client: "client:x", local: false } } }),
  });
  try {
    const ws = new WebSocket(kernel.url);
    const errors: string[] = [];
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      if (frame.t === "challenge") ws.send(JSON.stringify({ t: "hello", protocol: "ash-link/2", hand: { kind: "browser", name: "b", version: "1", platform: "web" }, channels: { device: {}, human: {} } }));
      if (frame.t === "welcome") ws.send(JSON.stringify({ t: "manifest", ch: "device", rev: 1, capabilities: [], events: [] }));
      if (frame.t === "error") errors.push(frame.code);
    });
    await eventually(() => errors.length === 1, "forbidden error");
    assert.deepEqual(errors, ["forbidden"]);
    ws.close();
  } finally { await kernel.stop(); }
});

test("client: reaching a kernel that is not there backs off 1 s, and connects once the kernel is there", async () => {
  const clock = new FakeClock();
  let url = "ws://127.0.0.1:1/link"; // nothing listens here
  const closes: number[] = [];
  const hand = nodeHand({ url }, "laptop", { clock, random: () => 0.5, url: () => url }, { closed: (i) => closes.push(i.code) });
  const kernel = await startKernel();
  try {
    hand.start();
    await eventually(() => hand.state === "waiting" && closes.length === 1, "first failure");
    url = kernel.url;
    clock.advance(999);
    assert.equal(hand.state, "waiting");
    clock.advance(1);
    await hand.ready();
  } finally { hand.stop(); await kernel.stop(); }
});
