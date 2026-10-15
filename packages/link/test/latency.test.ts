import assert from "node:assert/strict";
import test from "node:test";
import { FrameConn } from "../src/conn";
import { FakeClock } from "./fixtures/clock";
import { memoryPair } from "./fixtures/memory";
import { createLinkServer } from "../src/server";
import { eventually } from "../../core/test/fixtures/wait";
import { LIMITS, type Frame } from "../../sdk/src/link";

function connection() {
  const clock = new FakeClock(); let elapsed = 0; let wallShift = 0;
  const sent: Frame[] = [];
  const conn = new FrameConn({
    clock: { now: () => clock.now() + wallShift, setTimer: (f, ms) => clock.setTimer(f, ms), clearTimer: (h) => clock.clearTimer(h) },
    monotonicNow: () => elapsed, role: "kernel",
    socket: { send: (data) => { sent.push(JSON.parse(String(data))); }, close() {} }, onClosed() {}, onFrame() {},
  });
  return { conn, clock, sent, elapsed: (value: number) => { elapsed = value; }, wall: (value: number) => { wallShift = value; },
    pong: (at: number) => conn.receive(JSON.stringify({ t: "pong", at })),
    ping: () => sent.filter((f) => f.t === "ping").at(-1)! as Extract<Frame, { t: "ping" }>,
  };
}

test("RTT is an echoed heartbeat measured on a monotonic clock; unknown pongs and wall-clock jumps do not create samples", () => {
  const c = connection(); assert.equal(c.conn.latency(), null);
  c.pong(123); assert.equal(c.conn.latency(), null);
  c.conn.startHeartbeat(30); c.elapsed(100); c.clock.advance(30);
  const at = c.ping().at;
  c.wall(-500_000); c.elapsed(137); c.pong(at + 1); assert.equal(c.conn.latency(), null);
  c.pong(at); assert.deepEqual(c.conn.latency(), { rtt_ms: 37, age_ms: 0 });
  c.elapsed(164); assert.deepEqual(c.conn.latency(), { rtt_ms: 37, age_ms: 27 });
  c.pong(at); assert.deepEqual(c.conn.latency(), { rtt_ms: 37, age_ms: 27 }, "duplicate pong does not reset the age");
  c.clock.advance(30); assert.ok(c.ping().at > at, "heartbeat echo keys remain unique even if the wall clock went back");
  c.conn.close(1000);
});

test("a late pong cannot replace a newer pending sample, and disconnect clears samples and pending pings", () => {
  const c = connection(); c.conn.startHeartbeat(30); c.clock.advance(30); const first = c.ping().at;
  c.elapsed(40); c.clock.advance(30); const second = c.ping().at;
  c.elapsed(57); c.pong(first); assert.equal(c.conn.latency(), null);
  c.pong(second); assert.deepEqual(c.conn.latency(), { rtt_ms: 17, age_ms: 0 });
  c.conn.remoteClosed(1000, "closed"); assert.equal(c.conn.latency(), null);
  c.elapsed(100); c.pong(second); assert.equal(c.conn.latency(), null);
  const fresh = connection(); assert.equal(fresh.conn.latency(), null); fresh.conn.close(1000);
});

test("measurements belong to each connection and a pong from another echo key cannot create a sample", () => {
  const a = connection(), b = connection(); a.conn.send({ t: "ping", at: 10 }); b.conn.send({ t: "ping", at: 20 });
  a.elapsed(7); b.elapsed(43); a.pong(20); b.pong(10);
  assert.equal(a.conn.latency(), null); assert.equal(b.conn.latency(), null);
  a.pong(10); b.pong(20);
  assert.deepEqual(a.conn.latency(), { rtt_ms: 7, age_ms: 0 });
  assert.deepEqual(b.conn.latency(), { rtt_ms: 43, age_ms: 0 });
  a.conn.close(1000); b.conn.close(1000);
});

test("LinkSession exposes the existing heartbeat sample without sending an on-demand probe", async () => {
  const clock = new FakeClock(); let elapsed = 0;
  const link = createLinkServer({ kernel: { id: "test", version: "0" }, clock, monotonicNow: () => elapsed,
    authenticate: () => ({ ok: true, hand_id: "phone", channels: { device: { accepted: true } } }), onSession() {} });
  const sockets = memoryPair(); const frames: Frame[] = [];
  sockets.hand.on("message", (data: string) => {
    const frame = JSON.parse(data) as Frame; frames.push(frame);
    if (frame.t === "challenge") sockets.hand.send(JSON.stringify({ t: "hello", protocol: "ash-link/2",
      hand: { kind: "computer", name: "test", version: "0", platform: "test" }, channels: { device: {} } }));
  });
  link.accept(sockets.server); await eventually(() => link.sessions().length === 1, "session");
  const session = link.sessions()[0]!; assert.equal(session.latency?.(), null);
  elapsed = 100; clock.advance(LIMITS.heartbeatMs);
  await eventually(() => frames.some((f) => f.t === "ping"), "existing heartbeat");
  const ping = frames.find((f) => f.t === "ping") as Extract<Frame, { t: "ping" }>;
  elapsed = 124; sockets.hand.send(JSON.stringify({ t: "pong", at: ping.at }));
  await eventually(() => session.latency?.()?.rtt_ms === 24, "measured session sample");
  const count = frames.length; elapsed = 130; assert.deepEqual(session.latency?.(), { rtt_ms: 24, age_ms: 6 });
  assert.equal(frames.length, count, "reading latency sends nothing");
  link.close(); assert.equal(session.latency?.(), null);
});
