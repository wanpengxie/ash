import assert from "node:assert/strict";
import test from "node:test";
import type { Message } from "../../../../sdk/src/message";
import { createWidgetsService, STATE_WORD } from "../../../src/services/widgets";
import { validateCard } from "../../../src/services/widgets/card";
import { openLedger } from "../../kernel/ledger/helpers";
import { agent, call, code, ctxOf, fakeRouter, msg, owner } from "../support";

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(40)]).toString("base64");
const text = (t: string) => ({ components: [{ id: "root", component: "Text", text: t }] });
const button = { components: [{ id: "root", component: "Column", children: ["b", "sw"] },
  { id: "b", component: "Button", child: "bl", action: { event: { name: "done", context: { feedback: "good  job" } } } }, { id: "bl", component: "Text", text: "ok" },
  { id: "sw", component: "Switch", label: "on", value: { path: "/on" } }], data: { on: false } };
const put = (id: string, a2ui: unknown = text("hi"), extra: object = {}) => ({ id, title: "T", size: "2x2", a2ui, ...extra });

/** `phone`: how the fake hand answers a widget.state: nothing, or a rendered report for every card it was handed. */
function setup(phone: "silent" | "draws" | "fails" = "draws") {
  const { ledger } = openLedger();
  let svc: ReturnType<typeof createWidgetsService>;
  const router = fakeRouter((m) => {
    if (m.word === STATE_WORD && phone !== "silent") {
      const state = m.body as { cards: { id: string; updated_at: number }[]; previews?: Record<string, number> };
      setTimeout(() => {
        const rendered = state.cards.map((c) => ({ card: c.id, updated_at: c.updated_at, ...(phone === "fails" ? { problem: "image failed" } : {}),
          ...(state.previews?.[c.id] !== undefined ? { preview: { png: PNG, width: 100, height: 60, theme: "dark" }, preview_ask: state.previews[c.id] } : {}) }));
        void svc.handle(msg("service:widgets", "widget.rendered", { rendered }, "person:owner", "event"), ctxOf(owner));
      }, 1);
    }
    return { ok: true };
  });
  svc = createWidgetsService({ ledger, router, now: () => 5_000_000, drawWaitMs: 200, previewWaitMs: 200, log: () => {} });
  const sentWords = () => router.sent.map((x) => x.msg.word);
  return { ledger, router, svc, sentWords };
}
const event = (svc: ReturnType<typeof createWidgetsService>, word: string, body: unknown, from = "device:phone") =>
  svc.handle(msg("service:widgets", word, body, from, "event"), ctxOf({ member: from, via: "hand", local: true }));
const settle = () => new Promise((r) => setTimeout(r, 5));

test("put, list, get, remove: a card is stored in a table and the owner's channels are told on every change", async () => {
  const s = setup("silent");
  const r = await call(s.svc, agent(), "widget.card.put", put("water"));
  assert.equal(r.card.id, "water");
  assert.equal(r.card.owner, "agent:main");
  assert.equal(r.phone, "unknown");
  const list = await call(s.svc, owner, "widget.list");
  // list is the same whole state as the last widget.state, so a channel that just connected can fetch it
  assert.deepEqual(structuredClone(list), s.router.sent.filter((x) => x.msg.word === STATE_WORD).at(-1)!.msg.body);
  assert.deepEqual(list.cards.map((c: any) => [c.id, c.expired, c.problem]), [["water", false, null]]);
  const got = await call(s.svc, agent(), "widget.card.get", { id: "water" });
  assert.deepEqual(got.a2ui, text("hi"));
  assert.equal(await code(call(s.svc, agent(), "widget.card.get", { id: "nope" })), "not_found");

  // persisted in the ledger database: a second service on the same ledger sees it
  const again = createWidgetsService({ ledger: s.ledger, router: s.router, log: () => {} });
  assert.equal((await call(again, owner, "widget.list")).cards.length, 1);

  assert.deepEqual(await call(s.svc, agent(), "widget.card.remove", { id: "water" }), { removed: true });
  assert.deepEqual(await call(s.svc, agent(), "widget.card.remove", { id: "water" }), { removed: false });
  const states = s.router.sent.filter((x) => x.msg.word === STATE_WORD);
  assert.ok(states.length >= 2);
  assert.ok(states.every((x) => x.msg.to === "person:owner" && x.msg.kind === "event" && x.caller.member === "service:widgets"));
  assert.equal((states[0]!.msg.body as any).cards[0].a2ui.root, "root");
});

test("validate and put refuse what the phone cannot draw, with the reason", async () => {
  const s = setup("silent");
  const bad = { components: [{ id: "root", component: "Video" }] };
  const v = await call(s.svc, agent(), "widget.card.validate", { a2ui: bad });
  assert.equal(v.valid, false);
  assert.match(v.problem, /cannot play video/);
  const ok = await call(s.svc, agent(), "widget.card.validate", { a2ui: button });
  assert.deepEqual([ok.valid, ok.components, ok.actions], [true, 4, ["done"]]);
  assert.equal(await code(call(s.svc, agent(), "widget.card.put", put("x", bad))), "bad_request");
  assert.equal(await code(call(s.svc, agent(), "widget.card.put", put("x", text("a"), { title: "" }))), "bad_request");
  assert.equal((await call(s.svc, owner, "widget.list")).cards.length, 0);
});

test("the creator, the owner or any agent may replace or remove a card; an app only its own", async () => {
  const s = setup("silent");
  const anApp = { member: "app:notes", via: "app" as const, local: false };
  await call(s.svc, agent("a"), "widget.card.put", put("c"));
  assert.equal(await code(call(s.svc, anApp, "widget.card.put", put("c"))), "forbidden");
  assert.equal(await code(call(s.svc, anApp, "widget.card.remove", { id: "c" })), "forbidden");
  const byOther = await call(s.svc, agent("b"), "widget.card.put", put("c", text("v1b")));
  assert.equal(byOther.card.owner, "agent:a", "another agent replaces it; the creator stays");
  await call(s.svc, agent("a"), "widget.card.put", put("c", text("v2")));
  const byOwner = await call(s.svc, owner, "widget.card.put", put("c", text("v3")));
  assert.equal(byOwner.card.owner, "agent:a", "the creator stays");
  assert.deepEqual(await call(s.svc, owner, "widget.card.remove", { id: "c" }), { removed: true });
  await call(s.svc, agent("a"), "widget.card.put", put("d"));
  assert.deepEqual(await call(s.svc, agent("b"), "widget.card.remove", { id: "d" }), { removed: true }, "another agent removes it");
});

test("put reports whether the hand drew the card, with the preview picture; a failure comes back with its problem", async () => {
  const s = setup("draws");
  const r = await s.svc.handle(msg("service:widgets", "widget.card.put", put("p")), ctxOf(agent())) as any;
  assert.equal(r.data.phone, "drawn");
  assert.equal(r.data.preview.type, "image");
  assert.equal(r.data.preview.size, "2x2");
  assert.deepEqual(r.content.at(-1), { type: "image", mime: "image/png", b64: PNG });

  const f = setup("fails");
  const fr = await call(f.svc, agent(), "widget.card.put", put("p"));
  assert.deepEqual([fr.phone, fr.problem], ["problem", "image failed"]);
  assert.equal((await call(f.svc, owner, "widget.list")).cards[0].problem, "image failed");
  await settle();
  const problem = f.router.sent.find((x) => x.msg.word === "widget.problem")!;
  assert.deepEqual(problem.msg.body, { card: "p", owner: "agent:main", title: "T", problem: "image failed" });
  const told = f.router.sent.find((x) => x.msg.word === "tell")!;
  assert.equal(told.msg.to, "agent:main");
  assert.match((told.msg.body as any).text, /widget\.problem/);
});

test("preview asks the hand again; get carries the last picture", async () => {
  const s = setup("draws");
  await call(s.svc, agent(), "widget.card.put", put("p"));
  const p = await call(s.svc, agent(), "widget.card.preview", { id: "p" });
  assert.equal(p.fresh, true);
  assert.equal(p.preview.width, 100);
  assert.equal((await call(s.svc, agent(), "widget.card.get", { id: "p" })).preview.mimeType, "image/png");
  const silent = setup("silent");
  await call(silent.svc, agent(), "widget.card.put", put("p"));
  const none = await call(silent.svc, agent(), "widget.card.preview", { id: "p" });
  assert.equal(none.fresh, false);
  assert.match(none.preview_problem, /did not finish/);
});

test("placed and bind events from the hands decide what widget.list shows", async () => {
  const s = setup("silent");
  await call(s.svc, agent(), "widget.card.put", put("a"));
  await event(s.svc, "widget.placed", { widgets: [{ id: "7", type: "card" }, { id: "8", type: "ash" }] });
  await event(s.svc, "widget.bind", { widget: "7", card: "a" });
  assert.deepEqual((await call(s.svc, owner, "widget.list")).widgets, [{ id: "7", type: "card", card: "a" }, { id: "8", type: "ash", card: null }]);
  assert.deepEqual((await call(s.svc, agent(), "widget.card.put", put("a", text("v2")))).bound_widgets, ["7"]);
  // the hand reports again without widget 7: its binding goes with it
  await event(s.svc, "widget.placed", { widgets: [{ id: "8", type: "ash" }] });
  assert.deepEqual((await call(s.svc, owner, "widget.list")).widgets, [{ id: "8", type: "ash", card: null }]);
  // a bind to an unknown card is ignored
  await event(s.svc, "widget.bind", { widget: "8", card: "ghost" });
  assert.equal(s.router.sent.filter((x) => x.msg.word === STATE_WORD).length > 0, true);
});

test("tap: the creator hears it; a toggle is written into the card; feedback is kept and wakes nobody", async () => {
  const s = setup("silent");
  await call(s.svc, agent(), "widget.card.put", put("c", button));
  const before = (await call(s.svc, owner, "widget.list")).cards[0].updated_at;

  assert.deepEqual(await call(s.svc, owner, "widget.tap", { card: "c", component: "sw", checked: true }), { accepted: true });
  const got = await call(s.svc, agent(), "widget.card.get", { id: "c" });
  assert.equal(got.a2ui.data.on, true);
  assert.ok(got.card.updated_at > before);
  const action = s.router.sent.filter((x) => x.msg.word === "widget.action");
  assert.deepEqual(action[0]!.msg, { to: null, kind: "event", word: "widget.action", body: { card: "c", action: "change", owner: "agent:main", title: "T", component: "sw", checked: true } });
  assert.equal(s.router.sent.filter((x) => x.msg.word === "tell").length, 0, "a toggle has no event of its own");

  // the button carries feedback in its context: kept, nobody woken
  await call(s.svc, owner, "widget.tap", { card: "c", component: "b" });
  assert.deepEqual((await call(s.svc, agent(), "widget.card.get", { id: "c" })).feedback.map((f: any) => [f.feedback, f.action, f.component]), [["good job", "done", "b"]]);
  assert.equal(s.router.sent.filter((x) => x.msg.word === "tell").length, 0);

  assert.equal(await code(call(s.svc, owner, "widget.tap", { card: "gone" })), "not_found");
  assert.equal(await code(call(s.svc, owner, "widget.tap", { card: "c", component: "sw" })), "bad_request");
  assert.equal(await code(call(s.svc, owner, "widget.tap", { card: "c", component: "bl" })), "bad_request");
});

test("a tap with an event goes to the creator agent as a message; the tap word is the owner's", async () => {
  const s = setup("silent");
  const plainButton = { components: [{ id: "root", component: "Button", child: "t", action: { event: { name: "go" } } }, { id: "t", component: "Text", text: "go" }] };
  await call(s.svc, agent("helper"), "widget.card.put", put("g", plainButton));
  await call(s.svc, owner, "widget.tap", { card: "g", action: "go" });
  const told = s.router.sent.find((x) => x.msg.word === "tell")!;
  assert.equal(told.msg.to, "agent:helper");
  assert.match((told.msg.body as any).text, /tapped "go"/);
  assert.deepEqual(s.svc.words().find((w) => w.word === "widget.tap")!.callers, ["owner"]);
});

test("ttl marks a card expired; at most 50 cards", async () => {
  const s = setup("silent");
  await call(s.svc, agent(), "widget.card.put", put("short", text("a"), { ttl_min: 1 }));
  let now = 5_000_000;
  const svc = createWidgetsService({ ledger: s.ledger, router: s.router, now: () => now, drawWaitMs: 1, previewWaitMs: 1, log: () => {} });
  assert.equal((await call(svc, owner, "widget.list")).cards[0].expired, false);
  now += 120_000;
  assert.equal((await call(svc, owner, "widget.list")).cards[0].expired, true);
  for (let i = 0; i < 49; i++) await call(svc, agent(), "widget.card.put", put(`c${i}`, text("a")));
  assert.equal(await code(call(svc, agent(), "widget.card.put", put("last", text("a")))), "bad_request");
  await call(svc, agent(), "widget.card.put", put("c0", text("b")));
});

test("Chart: lines and bars with colours, highlight, limit; the phone draws it at the size the card gives; bad ones are told why", () => {
  const card = (chart: Record<string, unknown>) => ({ components: [{ id: "root", component: "Column", children: ["c"] }, { id: "c", component: "Chart", style: { width: "fill", height: 30 }, ...chart }] });
  const ok = validateCard(card({ gap: 1, series: [
    { type: "bars", values: [0, 4, 8, 44], color: "teal", max: 57.5, colors: { 3: "red" }, lastColor: "#FF0000", limit: 30, limitColor: "gray" },
    { type: "line", values: [2, -1, 3], color: { light: "#00FF00", dark: "#00AA00" }, fill: true, width: 2, highlight: { from: 1, to: 2, color: "orange" } },
  ] }));
  const chart = ok.components.find((c) => c.id === "c")!;
  assert.equal(chart.series!.length, 2);
  assert.deepEqual(chart.series![1]!.values, [2, 0, 3], "negative values are drawn as zero");
  assert.equal(chart.gap, 1);
  const refused = (chart: Record<string, unknown>, why: RegExp) => assert.throws(() => validateCard(card(chart)), why);
  refused({ series: [] }, /1 to 4 series/);
  refused({ series: [{ type: "pie", values: [1], color: "teal" }] }, /line.*bars/);
  refused({ series: [{ type: "line", values: [], color: "teal" }] }, /1 to 240/);
  refused({ series: [{ type: "line", values: [1, Infinity], color: "teal" }] }, /finite/);
  refused({ series: [{ type: "line", values: [1], color: "mauve" }] }, /colour/);
  refused({ series: [{ type: "bars", values: [1, 2], color: "teal", colors: { 5: "red" } }] }, /index/);
  refused({ series: [{ type: "line", values: [1, 2], color: "teal", highlight: { from: 3, to: 2, color: "red" } }] }, /highlight/);
  refused({ series: [{ type: "line", values: [1], color: "teal", width: 9 }] }, /width/);
  refused({ series: [{ type: "line", values: [1], color: "teal", glow: true }] }, /unknown field/);
  refused({ series: Array.from({ length: 3 }, () => ({ type: "line", values: Array.from({ length: 240 }, () => 1), color: "teal" })) }, /600/);
  assert.throws(() => validateCard({ components: [{ id: "root", component: "Chart", series: [{ type: "line", values: [1], color: "teal" }] }] }), /style.height/);
});
