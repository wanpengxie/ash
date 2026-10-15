import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Caller, Message } from "../../../../../sdk/src/message";
import { Cards } from "../../../../src/edges/link-server/human/cards";
import { CardRuntime } from "../../../../src/edges/link-server/human/runtime";

function setup(settings: Record<string, unknown> = {}, o: { hears?: boolean; origin?: string; inUse?: () => boolean; removeFails?: () => boolean } = {}) {
  let now = 1_000_000;
  const db = new DatabaseSync(":memory:");
  const cards = new Cards(db, () => now);
  const subscribers: ((m: Message) => void)[] = [];
  const sent: { to: string; word: string; body: unknown; caller: Caller }[] = [];
  const pushed: Record<string, unknown>[] = [];
  const runtime = new CardRuntime({
    db, cards, settings: () => settings, now: () => now, log: () => {}, manual: true, viewing: () => true, push: (card) => pushed.push(card),
    hears: () => o.hears !== false,
    ...(o.inUse ? { inUse: async () => o.inUse!() } : {}),
    router: {
      subscribe: (_f, cb) => { subscribers.push(cb); return () => {}; },
      send: async (m, caller) => {
        sent.push({ to: m.to!, word: m.word, body: m.body, caller });
        const b = m.body as Record<string, string>;
        // The directory: a word named *.list reads, any other writes. apps.describe: the app's origin.
        if (m.to === "service:directory") return { ok: true, result: { data: { member: b.member, words: [{ word: b.word, effect: b.word.endsWith(".list") ? "read" : "write" }] } } };
        if (m.word === "apps.describe") return { ok: true, result: { data: { id: b.id, origin: o.origin ?? "agent" } } };
        if (m.word === "apps.remove" && o.removeFails?.()) return { ok: false, error: { code: "failed", message: "busy" } };
        return { ok: true, result: { data: {} } };
      },
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

const OWNER_PRESS: Caller = { member: "person:owner", via: "human", local: true };
const AGENT_PRESS: Caller = { member: "agent:main", via: "agent", local: true };
const buttons = {
  components: [
    { id: "root", component: "Column", children: ["add", "page"] },
    { id: "add", component: "Button", child: "add.t", action: { call: { member: "app:hr", word: "hr.add", body: { n: 1 } } } },
    { id: "add.t", component: "Text", text: "加" },
    { id: "page", component: "Html", html: "<p>hi</p>" },
  ],
};

test("a button: the owner's press is the card's app (with the card: the gate may ask him); an agent's press is its own call", async () => {
  const w = setup();
  w.show("b", buttons, "hr");
  await w.runtime.member.handle({ word: "act", body: { card: "b", component: "add" } } as Message, { caller: OWNER_PRESS } as never);
  const byOwner = w.sent.find((x) => x.word === "hr.add")!;
  assert.deepEqual(byOwner.caller, { member: "app:hr", via: "app", local: true, card: "b" });
  w.sent.length = 0;
  await w.runtime.member.handle({ word: "act", body: { card: "b", component: "add" } } as Message, { caller: AGENT_PRESS } as never);
  const byAgent = w.sent.find((x) => x.word === "hr.add")!;
  assert.deepEqual(byAgent.caller, AGENT_PRESS, "the agent does not borrow the app's grants or the owner's presence");
});

test("a mini app calls its own app's words only", async () => {
  const w = setup();
  w.show("b", buttons, "hr");
  const other = await w.runtime.member.handle({ word: "act", body: { card: "b", component: "page", request: { call: { member: "service:vault", word: "list", body: {} } } } } as Message, { caller: OWNER_PRESS } as never);
  assert.equal(((other as { data: { state: string } }).data).state, "failed");
  assert.ok(!w.sent.some((x) => x.to === "service:vault"), "nothing sent");
  const own = await w.runtime.member.handle({ word: "act", body: { card: "b", component: "page", request: { call: { member: "app:hr", word: "hr.list", body: {} } } } } as Message, { caller: OWNER_PRESS } as never);
  assert.equal(((own as { data: { state: string } }).data).state, "ok");
});

test("sources only read, and hear only what the app was approved to hear", async () => {
  const w = setup({}, { hears: false });
  w.show("ev", live, "hr");
  w.runtime.tick();
  w.event("device:abc", "sense.health", { items: [{ value: 71 }] });
  assert.deepEqual(w.cards.get("ev")!.data.hr, [], "the app may not hear sense.health: no data");
  const polled = (word: string) => ({ data: { v: 0 }, sources: { "/v": { member: "app:hr", word, every_s: 60 } }, components: [{ id: "root", component: "Text", text: { path: "/v" } }] });
  w.show("write", polled("hr.add"), "hr");
  w.show("read", polled("hr.list"), "hr");
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(w.sent.some((x) => x.word === "hr.list" && x.caller.member === "app:hr"), "a read runs as the app");
  assert.ok(!w.sent.some((x) => x.word === "hr.add"), "a word that writes never runs as a source");
  w.runtime.close();
});

test("only an agent's new app may be a card's temporary app; a pinned card does not sleep behind the owner's back", async () => {
  assert.equal(await setup({}, { origin: "agent" }).runtime.mayBeTemporary("tally"), true);
  assert.equal(await setup({}, { origin: "other" }).runtime.mayBeTemporary("notes"), false, "the owner's own app is never removed with a card");
  const w = setup();
  w.show("kept", live, "hr");
  w.cards.put({ id: "lasting", message: "m_l", owner: "agent:main", a2ui: live });
  w.runtime.register(w.cards.get("lasting")!, { app: "hr" });
  assert.equal(await w.runtime.mayBeTemporary("hr"), false, "an app a lasting card uses is not temporary");
  await w.runtime.member.handle({ word: "pin", body: { id: "kept", pinned: true } } as Message, { caller: OWNER_PRESS } as never);
  await assert.rejects(w.runtime.member.handle({ word: "sleep", body: { id: "kept" } } as Message, { caller: AGENT_PRESS } as never), /pinned/);
  assert.equal(w.runtime.run("kept")!.pinned, true);
});

test("a temporary app is removed only when no page or widget uses it; a failed removal waits for the next sweep", async () => {
  let used = true, fails = true;
  const w = setup({}, { inUse: () => used, removeFails: () => fails });
  w.show("t", live, "hr");
  w.runtime.closeCard("t");
  const removes = () => w.sent.filter((x) => x.word === "apps.remove").length;
  await w.runtime.recycle();
  assert.equal(removes(), 0, "a page or a widget still shows it: kept");
  used = false;
  await w.runtime.recycle();
  assert.equal(removes(), 1, "free: tried");
  fails = false;
  await w.runtime.recycle();
  assert.equal(removes(), 2, "failed: tried again on the next sweep, and removed");
  await w.runtime.recycle();
  assert.equal(removes(), 2, "a removed app is not removed twice");
});

test("built-in task cards edit only their own task and keep the real caller", async () => {
  const w = setup();
  const owner: Caller = { member: "person:owner", via: "human", local: true };
  const make = (card: string, creator: string, target: string, id: string) => {
    const row = w.cards.put({ id: card, message: `m_${card}`, owner: creator, a2ui: { components: [
      { id: "root", component: "Column", children: ["done"] },
      { id: "done", component: "Button", child: "label", action: { call: { member: target, word: "done", body: { id } } } },
      { id: "label", component: "Text", text: "完成" },
    ] } }); w.runtime.register(row, {});
  };
  make("task.t_one.remind.1", "service:tasks", "service:tasks", "t_one");
  assert.equal((await w.runtime.act({ card: "task.t_one.remind.1", component: "done" }, owner)).data && w.sent.at(-1)?.caller.via, "human");
  assert.equal(w.sent.at(-1)?.caller.member, "person:owner");
  for (const [card, creator, target, id] of [
    ["task.t_two.remind.1", "agent:main", "service:tasks", "t_two"],
    ["task.t_three.remind.1", "service:tasks", "service:other", "t_three"],
    ["task.t_four.remind.1", "service:tasks", "service:tasks", "t_another"],
  ]) {
    make(card, creator, target, id);
    const before = w.sent.length;
    const outcome = await w.runtime.act({ card, component: "done" }, owner);
    assert.equal((outcome.data as { state: string }).state, "failed");
    assert.equal(w.sent.length, before);
  }
});
