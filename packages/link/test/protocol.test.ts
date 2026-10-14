import assert from "node:assert/strict";
import test from "node:test";
import { CLOSE_CODES, LIMITS, type Frame, type StreamFrame } from "../../sdk/src/link";
import { eventually } from "../../core/test/fixtures/wait";
import { FakeClock } from "./fixtures/clock";
import { TOKEN, startKernel } from "./fixtures/harness";
import { decodeFrame, encodeFrame } from "../src/codec";
import { createNodeClient } from "../src/client";
import { StreamReceiver, base64ToBytes, sendStream, type ReceivedStream } from "../src/stream";
import { createLinkServer } from "../src/server";
import { memoryPair } from "./fixtures/memory";

test("a stream of 3 MB goes out as an open, 12 data chunks of at most 256 KiB, and an end", () => {
  const data = new Uint8Array(3 * 1024 * 1024 + 5).fill(7);
  const frames: StreamFrame[] = [];
  sendStream((f) => frames.push(f), "device", data, { ref: "c_1", mime: "image/png" });
  assert.equal(frames[0]!.op, "open");
  assert.equal(frames.at(-1)!.op, "end");
  const chunks = frames.filter((f): f is Extract<StreamFrame, { op: "data" }> => f.op === "data");
  assert.equal(chunks.length, 13);
  assert.deepEqual(chunks.map((c) => c.seq), [...chunks.keys()]);
  for (const chunk of chunks) assert.ok(base64ToBytes(chunk.b64).length <= LIMITS.streamChunkBytes);
  for (const frame of frames) assert.ok(encodeFrame(frame).length < LIMITS.frameBytes);
});

function receiver(over: { accepts?: boolean; maxBytes?: number } = {}) {
  const sent: StreamFrame[] = [];
  const done: ReceivedStream[] = [];
  const broken: string[] = [];
  const r = new StreamReceiver({ send: (f) => sent.push(f), onStream: (s) => done.push(s), onBroken: (_sid, code) => broken.push(code), accepts: () => over.accepts ?? true, maxBytes: over.maxBytes });
  return { r, sent, done, broken };
}

test("a stream with a gap, too much data, a short end or a closed channel is dropped and the sender is told", () => {
  const data = (seq: number, text = "aGk=") => ({ t: "stream", sid: "s", op: "data", seq, b64: text }) as const;
  const open = { t: "stream", sid: "s", op: "open", ch: "device", size: 4 } as const;

  let t = receiver();
  t.r.handle(open); t.r.handle(data(1));
  assert.deepEqual(t.broken, ["bad_request"]);
  assert.equal(t.sent[0]!.op, "error");
  t.r.handle({ t: "stream", sid: "s", op: "end" });
  assert.equal(t.done.length, 0);

  t = receiver();
  t.r.handle(open); t.r.handle(data(0, "aGVsbG8="));
  assert.deepEqual(t.broken, ["too_large"]);

  t = receiver();
  t.r.handle(open); t.r.handle(data(0)); t.r.handle({ t: "stream", sid: "s", op: "end" });
  assert.deepEqual(t.broken, ["bad_request"]);

  t = receiver({ accepts: false });
  t.r.handle(open);
  assert.deepEqual(t.broken, ["forbidden"]);

  t = receiver({ maxBytes: 3 });
  t.r.handle(open);
  assert.deepEqual(t.broken, ["too_large"]);

  t = receiver();
  t.r.handle(open); t.r.handle(data(0)); t.r.handle({ t: "stream", sid: "s", op: "error", code: "failed", message: "gave up" });
  assert.deepEqual(t.broken, ["failed"]);
});

test("an empty stream arrives as an empty buffer", () => {
  const t = receiver();
  sendStream((f) => t.r.handle(f), "human", new Uint8Array(0));
  assert.equal(t.done.length, 1);
  assert.equal(t.done[0]!.data.length, 0);
});

test("encoding refuses what is not a valid frame or is over 4 MiB; decoding names the problem", () => {
  assert.throws(() => encodeFrame({ t: "ping", at: "now" } as unknown as Frame), /invalid ping frame/);
  assert.throws(() => encodeFrame({ t: "progress", id: "c", text: "x".repeat(LIMITS.frameBytes) }), /stream/);
  assert.equal(decodeFrame("not json").ok, false);
  assert.equal(decodeFrame(Buffer.from('{"t":"ping","at":1}'), true).ok, false);
  assert.equal(decodeFrame(Buffer.from('{"t":"ping","at":1}'), false).ok, true);
  assert.equal(decodeFrame(new Uint8Array([0xff, 0xfe])).ok, false);
  const bad = decodeFrame('{"t":"result","id":"c1","ok":true}');
  assert.ok(!bad.ok && bad.t === "result" && bad.id === "c1");
});

test("a hand that sends a frame only the kernel sends is closed with 4400", async () => {
  const kernel = createLinkServer({
    kernel: { id: "k", version: "0" },
    authenticate: () => ({ ok: true, hand_id: "h", channels: { device: { accepted: true } } }),
    onSession: () => ({}),
  });
  const { server, hand } = memoryPair();
  const frames: Frame[] = [];
  hand.on("message", (data: string) => {
    const frame = JSON.parse(data) as Frame;
    frames.push(frame);
    if (frame.t === "challenge") hand.send(JSON.stringify({ t: "hello", protocol: "ash-link/2", hand: { kind: "computer", name: "h", version: "1", platform: "x" }, channels: { device: {} } }));
    if (frame.t === "welcome") hand.send(JSON.stringify({ t: "call", ch: "device", id: "c", capability: "a.b", args: {}, caller: { member: "m", label: "l" }, deadline: 1 }));
  });
  kernel.accept(server);
  await eventually(() => server.closedWith, "closed");
  assert.equal(server.closedWith!.code, CLOSE_CODES.badFrame);
  assert.ok(frames.some((f) => f.t === "error"));
});

test("a frame before the hello is a protocol error", async () => {
  const kernel = createLinkServer({ kernel: { id: "k", version: "0" }, authenticate: () => ({ ok: false, code: 4001 }), onSession: () => ({}) });
  const { server, hand } = memoryPair();
  kernel.accept(server);
  hand.send(JSON.stringify({ t: "ping", at: 1 }));
  hand.send(JSON.stringify({ t: "event.ack", id: "x" }));
  await eventually(() => server.closedWith, "closed");
  assert.equal(server.closedWith!.code, CLOSE_CODES.badFrame);
});

test("createNodeClient connects to a kernel over a real socket", async () => {
  const kernel = await startKernel();
  const clock = new FakeClock();
  const hand = createNodeClient({
    url: kernel.url, headers: () => ({ authorization: `Bearer ${TOKEN}` }), clock,
    hand: { kind: "computer", name: "node-hand", version: "1", platform: "linux" }, channels: { device: {} },
  });
  try {
    hand.start();
    assert.equal((await hand.ready()).hand_id, "node-hand");
  } finally { hand.stop(); await kernel.stop(); }
});
