import assert from "node:assert/strict";
import test from "node:test";
import { MemoryEventQueue, type QueuedEvent } from "../../../../link/src/hand";
import { eventually } from "../../fixtures/wait";
import { cap, connected, startHub } from "./harness";

/** Keeps acked events too, so a test can resend them (the way a hand does when an ack never arrived). */
class StubbornQueue extends MemoryEventQueue {
  readonly acked: string[] = [];
  override remove(id: string): void { this.acked.push(id); }
}
class RecordingQueue extends MemoryEventQueue {
  readonly removed: string[] = [];
  override remove(id: string): void { this.removed.push(id); super.remove(id); }
}

const sentWords = (hub: Awaited<ReturnType<typeof startHub>>) => hub.router.sent.map((s) => [s.msg.to, s.msg.word]);

test("a declared event goes to the fixed service of its namespace, as the hand, from a phone or a computer alike", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const events = ["sense.location", "widget.placed", "config.changed", "checkup.changed", "codex.turn_ended"];
  const phone = await connected(hub, { kind: "phone", events });
  const computer = await connected(hub, { kind: "computer", events });

  for (const hand of [phone, computer]) {
    await hand.client.emit("sense.location", { n: 1 });
    await hand.client.emit("widget.placed", { widgets: [] });
    await hand.client.emit("config.changed", { item: "location", state: "granted" });
    await hand.client.emit("checkup.changed", { todo: 0, groups: [] });
    await hand.client.emit("codex.turn_ended", { thread: "t1" });
  }
  await eventually(() => hub.router.sent.length === 10, "ten events routed");

  assert.deepEqual(sentWords(hub).slice(0, 5), [["service:senses", "sense.location"], ["service:widgets", "widget.placed"], ["service:devices", "config.changed"], ["service:admin", "checkup.changed"], ["service:devices", "codex.turn_ended"]]);
  for (const sent of hub.router.sent) assert.equal(sent.msg.kind, "event");
  assert.deepEqual(hub.router.sent[0]!.msg.body, { n: 1 });
  assert.deepEqual(hub.router.sent.slice(0, 5).map((s) => s.caller), Array(5).fill({ member: phone.member, via: "hand", local: true }));
  assert.deepEqual(hub.router.sent.slice(5).map((s) => s.caller.member), Array(5).fill(computer.member));
});

test("an event the manifest did not declare is refused with an error frame and never sent on", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const logs: string[] = [];
  const hand = await connected(hub, { events: ["sense.battery"], handlers: { log: (m) => logs.push(m) } });
  await hand.client.emit("sense.location", { lat: 1 });
  await hand.client.emit("x.test.thing", { a: 1 });
  await hand.client.emit("sense.battery", { level: 50 });
  await eventually(() => hub.router.sent.length === 1, "the declared event arriving");
  await eventually(() => logs.filter((l) => l.includes("forbidden")).length === 2, "both refusals reaching the hand");
  assert.deepEqual(sentWords(hub), [["service:senses", "sense.battery"]]);
});

test("a refused event is acked all the same: the hand's queue does not keep it", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const queue = new RecordingQueue();
  const hand = await connected(hub, { events: ["x.test.declared"], eventQueue: queue });
  const id = await hand.client.emit("sense.location", {});
  await eventually(() => queue.removed.includes(id), "the ack of the refused event");
  assert.equal(hub.router.sent.length, 0);
});

test("the same event id is handled once, also after the hand reconnects and sends it again", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const queue = new StubbornQueue();
  const hand = await connected(hub, { events: ["sense.battery"], eventQueue: queue });
  const first = await hand.client.emit("sense.battery", { level: 10 });
  await eventually(() => queue.acked.includes(first), "the first ack");

  hand.client.reconnectNow();
  await eventually(() => hand.client.state === "ready", "the hand back");
  const second = await hand.client.emit("sense.battery", { level: 20 });
  await eventually(() => queue.acked.includes(second) && queue.acked.filter((id) => id === first).length === 2, "the resend acked again");

  assert.deepEqual(hub.router.sent.map((s) => s.msg.body), [{ level: 10 }, { level: 20 }]);
});

test("when the service is not there the event is not acked, and the resend after a reconnect is delivered", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  let up = false;
  hub.router.answers.set("service:senses/sense.battery", () => (up ? { ok: true } : { ok: false, error: { code: "offline", message: "service:senses is not here" } }));
  const queue = new RecordingQueue();
  const hand = await connected(hub, { events: ["sense.battery"], eventQueue: queue });
  const id = await hand.client.emit("sense.battery", { level: 5 });
  await eventually(() => hub.router.sent.length === 1, "the first attempt");
  assert.deepEqual(queue.removed, [], "not acked");

  up = true;
  hand.client.reconnectNow();
  await eventually(() => queue.removed.includes(id), "the resend acked");
  assert.equal(hub.router.sent.length, 2);
});

test("an event whose namespace has no service is refused; a notification leaves nothing in the hand tables", async (t) => {
  const hub = await startHub(); t.after(() => hub.stop());
  const hand = await connected(hub, { capabilities: [cap("location.get")], events: ["x.test.thing", "sense.notification"] });
  await hand.client.emit("x.test.thing", {});
  await hand.client.emit("sense.notification", { app: "bank", title: "otp", text: "hunter2-secret" });
  await eventually(() => hub.router.sent.length === 1, "the notification routed");
  assert.deepEqual(sentWords(hub), [["service:senses", "sense.notification"]]);
  for (const table of ["hands", "hand_capabilities"]) {
    assert.ok(!JSON.stringify(hub.db.prepare(`SELECT * FROM ${table}`).all()).includes("hunter2"));
  }
});
