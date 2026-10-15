import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Message } from "../../../../../sdk/src/message";
import { Cards } from "../../../../src/edges/link-server/human/cards";
import { CardRuntime } from "../../../../src/edges/link-server/human/runtime";

function setup(settings: Record<string, unknown> = {}) {
  let now = 1_000_000;
  const db = new DatabaseSync(":memory:");
  const cards = new Cards(db, () => now);
  const subscribers: ((m: Message) => void)[] = [];
  const sent: { to: string; word: string; body: unknown }[] = [];
  const pushed: Record<string, unknown>[] = [];
  const runtime = new CardRuntime({
    db, cards, settings: () => settings, now: () => now, log: () => {}, manual: true, viewing: () => true, push: (card) => pushed.push(card),
    router: {
      subscribe: (_f, cb) => { subscribers.push(cb); return () => {}; },
      send: async (m) => { sent.push({ to: m.to!, word: m.word, body: m.body }); return { ok: true, result: { data: {} } }; },
    },
  });
  const event = (from: string, word: string, body: unknown) => { for (const cb of subscribers) cb({ seq: 1, id: "e", ts: now, from, to: "service:senses", kind: "event", word, body } as Message); };
  const show = (id: string, a2ui: Record<string, unknown>, app?: string) => {
    const row = cards.put({ id, message: `m_${id}`, owner: "agent:main", a2ui });
    runtime.register(row, app ? { app, temporary: true } : {});
  };
  return { runtime, cards, sent, pushed, event, show, advance: (ms: number) => { now += ms; } };
}

const live = {
  data: { hr: [] },
  sources: { "/hr": { event: "device:*/sense.health", pick: "/items/0/value", keep: 3 } },
  components: [{ id: "root", component: "Chart", style: { height: 60 }, series: [{ type: "line", values: { path: "/hr" }, color: "accent" }] }],
};

test("an event source feeds a live card of an app (picked, kept as a list, throttled); a card without an app gets nothing", () => {
  const w = setup();
  w.show("live", live, "hr");
  w.show("plain", live);
  w.runtime.tick();
  w.event("device:abc", "sense.health", { items: [{ value: 71 }] });
  w.event("device:abc", "sense.health", { items: [{ value: 99 }] }); // within 2 s: dropped
  for (const v of [72, 73, 74]) { w.advance(2_500); w.event("device:abc", "sense.health", { items: [{ value: v }] }); }
  assert.deepEqual(w.cards.get("live")!.data.hr, [72, 73, 74], "the last three, throttled");
  assert.deepEqual(w.cards.get("plain")!.data.hr, [], "no app, no live data");
  assert.ok(w.pushed.some((c) => c.id === "live" && c.fed_at), "each change pushed, with when it came");
});

test("off screen a card goes idle then dormant, its sources stop; over the limit the least recently used sleeps first", () => {
  const w = setup({ "cards.max_active": 1 });
  w.show("a", live, "hr");
  w.advance(1_000);
  w.show("b", live, "hr");
  assert.equal(w.runtime.run("a")!.life, "dormant", "only one may be active: the older one sleeps");
  assert.equal(w.runtime.run("b")!.life, "active");
  w.advance(3 * 60_000);
  w.runtime.seen([]);
  assert.equal(w.runtime.run("b")!.life, "idle");
  w.event("device:abc", "sense.health", { items: [{ value: 80 }] });
  assert.deepEqual(w.cards.get("b")!.data.hr, [], "an idle card takes no events");
  w.runtime.seen(["a"]);
  assert.equal(w.runtime.run("a")!.life, "active", "seen again, woken");
  assert.ok(w.sent.some((s) => s.word === "apps.wake"), "and its app woken");
  assert.ok(w.runtime.closeCard("a"));
  assert.equal(w.runtime.run("a")!.life, "closed");
});

test("every card stops by itself: closed after a day untouched unless the owner pinned it; ttl only makes it sooner", () => {
  const w = setup();
  w.show("quiet", live, "hr");
  w.show("kept", live, "hr");
  w.show("short", { components: [{ id: "root", component: "Text", text: "hi" }] });
  w.runtime.register(w.cards.get("short")!, { ttl_min: 5 * 24 * 60 });
  assert.equal(w.runtime.run("short")!.expires_at, 1_000_000 + 24 * 3_600_000, "a ttl past the default day is cut to it");
  w.runtime.member.handle({ word: "pin", body: { id: "kept", pinned: true } } as Message, {} as never);
  w.advance(25 * 3_600_000);
  w.runtime.seen([]);
  assert.equal(w.runtime.run("quiet")!.life, "closed");
  assert.equal(w.runtime.run("short")!.life, "closed");
  assert.equal(w.runtime.run("kept")!.life, "active", "pinned: still running off screen");
});
