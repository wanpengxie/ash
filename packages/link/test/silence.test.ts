import assert from "node:assert/strict";
import test from "node:test";
import { CLOSE_CODES, LIMITS, type Frame } from "../../sdk/src/link";
import { eventually } from "../../core/test/fixtures/wait";
import { FakeClock } from "./fixtures/clock";
import { memoryConnector, memoryPair, type MemorySocket } from "./fixtures/memory";
import { HandClient, reconnectDelay } from "../src/hand";
import { createLinkServer, type LinkServer } from "../src/server";

function kernelOn(clock: FakeClock, closes: { code: number }[] = []): LinkServer {
  return createLinkServer({
    kernel: { id: "k", version: "0" },
    clock,
    authenticate: (hello, ctx) => ({ ok: true, hand_id: String(ctx.meta ?? hello.hand.name), channels: { device: { accepted: true } } }),
    onSession: () => ({ closed: (code) => closes.push({ code }) }),
  });
}

/** A hand written by hand: it answers the challenge and then does whatever the test says. */
function rawHand(socket: MemorySocket) {
  const frames: Frame[] = [];
  socket.on("message", (data: string) => {
    const frame = JSON.parse(data) as Frame;
    frames.push(frame);
    if (frame.t === "challenge") socket.send(JSON.stringify({ t: "hello", protocol: "ash-link/2", hand: { kind: "computer", name: "raw", version: "1", platform: "x" }, channels: { device: {} } }));
  });
  return frames;
}

test("90 seconds without a frame close the connection; the kernel pings every 30", async () => {
  const clock = new FakeClock();
  const closes: { code: number }[] = [];
  const kernel = kernelOn(clock, closes);
  const { server, hand } = memoryPair();
  const frames = rawHand(hand);
  kernel.accept(server);
  await eventually(() => frames.some((f) => f.t === "welcome"), "welcome");

  clock.advance(LIMITS.heartbeatMs);
  await eventually(() => frames.filter((f) => f.t === "ping").length === 1, "first ping");
  clock.advance(LIMITS.heartbeatMs);
  await eventually(() => frames.filter((f) => f.t === "ping").length === 2, "second ping");
  assert.equal(closes.length, 0);

  clock.advance(LIMITS.silenceMs - 2 * LIMITS.heartbeatMs);
  await eventually(() => closes.length === 1, "kernel closed the silent hand");
  assert.equal(closes[0]!.code, CLOSE_CODES.normal);
  assert.equal(server.closedWith?.code, CLOSE_CODES.normal);
  assert.equal(kernel.sessions().length, 0);
});

test("any frame from the hand keeps the connection alive", async () => {
  const clock = new FakeClock();
  const closes: { code: number }[] = [];
  const kernel = kernelOn(clock, closes);
  const { server, hand } = memoryPair();
  const frames = rawHand(hand);
  kernel.accept(server);
  await eventually(() => frames.some((f) => f.t === "welcome"), "welcome");
  for (let i = 0; i < 5; i++) {
    clock.advance(LIMITS.silenceMs - 1);
    hand.send(JSON.stringify({ t: "pong", at: clock.now() }));
    await eventually(() => hand.sent.length === 2 + i, "pong sent");
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(closes.length, 0);
  assert.equal(kernel.sessions().length, 1);
});

test("a connection that never says hello is closed with 4001", async () => {
  const clock = new FakeClock();
  const kernel = kernelOn(clock);
  const { server, hand } = memoryPair();
  const frames: Frame[] = [];
  hand.on("message", (data: string) => frames.push(JSON.parse(data) as Frame));
  kernel.accept(server);
  await eventually(() => frames.some((f) => f.t === "challenge"), "challenge");
  clock.advance(10_000);
  await eventually(() => server.closedWith, "closed");
  assert.equal(server.closedWith!.code, CLOSE_CODES.unauthenticated);
});

test("an already open socket can be accepted, and the caller's meta reaches authenticate", async () => {
  const clock = new FakeClock();
  const kernel = kernelOn(clock);
  const { server, hand } = memoryPair();
  const frames = rawHand(hand);
  kernel.accept(server, { meta: "device-from-gateway" });
  const welcome = await eventually(() => frames.find((f) => f.t === "welcome"), "welcome");
  assert.equal(welcome.t === "welcome" && welcome.hand_id, "device-from-gateway");
});

test("kernel.closeSession(id, 4009) closes that session with the code", async () => {
  const clock = new FakeClock();
  const kernel = kernelOn(clock);
  const { server, hand } = memoryPair();
  const frames = rawHand(hand);
  kernel.accept(server);
  const welcome = await eventually(() => frames.find((f) => f.t === "welcome"), "welcome");
  assert.equal(kernel.closeSession(welcome.t === "welcome" ? welcome.session : "", CLOSE_CODES.superseded, "replaced"), true);
  await eventually(() => hand.closedWith, "hand told");
  assert.equal(hand.closedWith!.code, 4009);
  assert.equal(kernel.closeSession("nope", 1000), false);
});

test("reconnect delays are 1, 2, 4, 8, 16, 30 s, then 30 s, each within ±20%", () => {
  const base = [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000];
  base.forEach((ms, attempt) => {
    assert.equal(reconnectDelay(attempt, () => 0.5), ms);
    assert.equal(reconnectDelay(attempt, () => 0), Math.round(ms * 0.8));
    assert.equal(reconnectDelay(attempt, () => 1), Math.round(ms * 1.2));
  });
});

test("a hand that loses its connection waits 1, 2, 4 s ... on repeated failures, and starts over after a welcome", async () => {
  const clock = new FakeClock();
  const kernel = kernelOn(clock);
  let refuse = true;
  let attempts = 0;
  const open = memoryConnector(kernel);
  const hand = new HandClient({
    url: "memory", hand: { kind: "computer", name: "m", version: "1", platform: "x" }, channels: { device: {} }, clock, random: () => 0.5,
    connector: (url, headers, events) => {
      attempts++;
      if (!refuse) return open(url, headers, events);
      queueMicrotask(() => events.close(1006, "refused"));
      return { send() {}, close() {} };
    },
  });
  hand.start();
  let expected = 1;
  for (const wait of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    await eventually(() => hand.state === "waiting" && attempts === expected, "waiting");
    clock.advance(wait - 1);
    assert.equal(attempts, expected);
    clock.advance(1);
    expected++;
  }
  await eventually(() => hand.state === "waiting" && attempts === expected, "waiting");
  refuse = false;
  clock.advance(30_000);
  await hand.ready();
  // After the welcome the next drop is retried after 1 s again.
  kernel.sessions()[0]!.close(CLOSE_CODES.internal, "restart");
  await eventually(() => hand.state === "waiting", "waiting again");
  const before = attempts;
  clock.advance(1000);
  await eventually(() => attempts === before + 1, "retried after 1 s");
  await hand.ready();
  hand.stop();
});

test("a hand that hears nothing for 90 seconds drops the connection and reconnects", async () => {
  const clock = new FakeClock();
  const kernel = kernelOn(clock);
  let sockets: MemorySocket[] = [];
  const hand = new HandClient({
    url: "memory", hand: { kind: "computer", name: "m", version: "1", platform: "x" }, channels: { device: {} }, clock, random: () => 0.5,
    connector: memoryConnector(kernel, (s) => sockets.push(s)),
  });
  hand.start();
  await hand.ready();
  // The kernel's pings would keep it alive; silence the network instead.
  sockets[0]!.drop = () => true;
  clock.advance(LIMITS.silenceMs);
  await eventually(() => hand.state === "waiting", "hand dropped the silent connection");
  sockets[0]!.drop = null;
  clock.advance(1000);
  await hand.ready();
  assert.equal(sockets.length, 2);
  hand.stop();
});
