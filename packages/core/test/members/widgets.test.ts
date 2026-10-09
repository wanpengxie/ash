import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateA2ui, WidgetsMember, type WidgetState } from "../../src/members/widgets";
import { Ledger } from "../../src/world/ledger";
import { WorldMembers } from "../../src/world/member";
import { WorldRouter, type TrustedRouteContext } from "../../src/world/router";
import { eventually } from "../fixtures/wait";

const owner: TrustedRouteContext = { member: "person:owner", transport: "api", transportPrincipal: "owner:synthetic", local: true, remote: false, ownerProxy: true };
const phone: TrustedRouteContext = { member: "device:phone", transport: "phone", transportPrincipal: "phone:synthetic", local: true, remote: false, ownerProxy: true };
const agent = (id: string): TrustedRouteContext => ({ member: id, transport: "agent", transportPrincipal: id, local: true, remote: false, ownerProxy: false });

const weather = {
  components: [
    { id: "root", component: "Column", children: ["head", "temp", "bar", "line", "buttons"] },
    { id: "head", component: "Row", children: ["icon", "city", "badge"], justify: "spaceBetween" },
    { id: "icon", component: "Image", url: "icon:sun" },
    { id: "city", component: "Text", text: { path: "/city" }, variant: "caption" },
    { id: "badge", component: "Badge", text: "晴" },
    { id: "temp", component: "Text", text: { path: "/temp" }, variant: "h1" },
    { id: "bar", component: "ProgressBar", value: { path: "/rain" }, label: "降雨" },
    { id: "line", component: "Divider" },
    { id: "buttons", component: "Row", children: ["refresh"] },
    { id: "refresh", component: "Button", child: "refresh_label", action: { event: { name: "refresh" } } },
    { id: "refresh_label", component: "Text", text: "刷新" },
  ],
  data: { city: "上海", temp: 23, rain: 40 },
};

async function fixture(push?: (state: WidgetState) => Promise<{ widgets?: unknown } | void>) {
  const dir = mkdtempSync(join(tmpdir(), "ash-widgets-"));
  const ledger = await Ledger.open(join(dir, "world.db"));
  const router = new WorldRouter(ledger, async () => true);
  const file = join(dir, "widgets.json");
  const member = new WidgetsMember({ router, file, ...(push ? { push } : {}), now: () => 1_000_000 });
  new WorldMembers(router).register(member);
  const call = async (ctx: TrustedRouteContext, word: string, body: Record<string, unknown>) =>
    (await router.send(ctx, { to: "service:widgets", kind: "request", word, body, wait: true })).reply!.body as any;
  return { dir, file, ledger, router, member, call, close: () => { member.close(); ledger.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("the A2UI subset resolves data bindings into literal components", () => {
  const render = validateA2ui(weather);
  assert.equal(render.root, "root");
  const byId = new Map(render.components.map((c) => [c.id, c]));
  assert.equal(byId.get("temp")!.text, "23");
  assert.equal(byId.get("city")!.text, "上海");
  assert.equal(byId.get("bar")!.value, 40);
  assert.deepEqual(byId.get("refresh")!.action, { event: { name: "refresh" } });
  assert.equal(byId.get("refresh_label")!.text, "刷新");
});

test("only what Android cannot draw is refused, with the component and the reason", () => {
  const reject = (a2ui: unknown, pattern: RegExp) => assert.throws(() => validateA2ui(a2ui), pattern);
  reject({ components: [{ id: "root", component: "WebView" }] }, /WebView "root" cannot be drawn: Android home-screen widgets cannot run web pages/);
  reject({ components: [{ id: "root", component: "Column", children: ["root"] }] }, /contains itself/);
  reject({ components: [{ id: "root", component: "Text", text: "a" }, { id: "x", component: "Text", text: "b" }] }, /not reachable/);
  reject({ components: [{ id: "root", component: "Button", child: "l", action: { name: "x" } }, { id: "l", component: "Text", text: "x" }] }, /action must be one of/);
  // The first format's limits were Ash's own and are gone: styling, web images, long badges, more buttons, deeper trees.
  const button = (n: number) => [{ id: `b${n}`, component: "Button", child: `l${n}`, action: { event: { name: `a${n}` } } }, { id: `l${n}`, component: "Text", text: "go" }];
  validateA2ui({ components: [{ id: "root", component: "Row", children: ["b1", "b2", "b3"] }, ...button(1), ...button(2), ...button(3)] });
  validateA2ui({ components: [{ id: "root", component: "Text", text: "x", style: { color: "red" } }] });
  validateA2ui({ components: [{ id: "root", component: "Image", url: "https://example.com/a.png" }] });
  validateA2ui({ components: [{ id: "root", component: "Badge", text: "123456789" }] });
  validateA2ui({ components: [{ id: "root", component: "Column", children: ["a"] }, { id: "a", component: "Row", children: ["b"] },
    { id: "b", component: "Column", children: ["c"] }, { id: "c", component: "Row", children: [] }] });
});

test("put, list, bind and remove; a card belongs to its creator", async () => {
  const pushes: WidgetState[] = [];
  const f = await fixture(async (state) => { pushes.push(state); return { widgets: [{ id: "7", type: "card" }, { id: "8", type: "ash" }] }; });
  try {
    f.member.start();
    const put = await f.call(agent("agent:main"), "widget.card.put", { id: "weather", title: "今天天气", size: "4x2", a2ui: weather, ttl_min: 60 });
    assert.equal(put.ok, true, JSON.stringify(put));
    assert.equal(put.result.card.owner, "agent:main");
    assert.equal(put.result.card.expires_at, 1_000_000 + 3_600_000);
    assert.deepEqual(put.result.card.actions, ["refresh"]);
    assert.equal(put.result.phone, "unknown");
    const bad = await f.call(agent("agent:main"), "widget.card.put", { id: "x", title: "x", size: "2x2", a2ui: { components: [{ id: "root", component: "Video" }] } });
    assert.equal(bad.ok, false);
    assert.match(bad.error.message, /Video "root" cannot be drawn/);
    await f.member.settled();
    const bound = await f.call(agent("agent:main"), "widget.bind", { widget: "7", card: "weather" });
    assert.equal(bound.ok, true, JSON.stringify(bound));
    const notCard = await f.call(agent("agent:main"), "widget.bind", { widget: "8", card: "weather" });
    assert.equal(notCard.ok, false);
    const list = await f.call(agent("agent:main"), "widget.list", {});
    assert.deepEqual(list.result.widgets, [{ id: "7", type: "card", card: "weather" }, { id: "8", type: "ash", card: null }]);
    // Another agent cannot change or remove it; the owner can, and the card keeps its creator.
    const other = await f.call(agent("agent:helper"), "widget.card.put", { id: "weather", title: "改", size: "2x2", a2ui: weather });
    assert.equal(other.ok, false);
    assert.equal(other.error.code, "forbidden");
    assert.equal((await f.call(agent("agent:helper"), "widget.card.remove", { id: "weather" })).error.code, "forbidden");
    const byOwner = await f.call(owner, "widget.card.put", { id: "weather", title: "天气", size: "2x2", a2ui: weather });
    assert.equal(byOwner.result.card.owner, "agent:main");
    assert.deepEqual(byOwner.result.bound_widgets, ["7"]);
    await f.member.settled();
    const last = pushes.at(-1)!;
    assert.equal(last.cards[0].title, "天气");
    assert.deepEqual(last.bindings, { "7": "weather" });
    assert.ok(pushes.length >= 3 && pushes.every((state, i) => i === 0 || state.revision > pushes[i - 1].revision));
    assert.deepEqual((await f.call(agent("agent:main"), "widget.card.remove", { id: "weather" })).result, { removed: true });
    await f.member.settled();
    assert.deepEqual(pushes.at(-1)!.bindings, {});
    assert.equal(pushes.at(-1)!.cards.length, 0);
  } finally { f.close(); }
});

test("cards and bindings survive a restart", async () => {
  const f = await fixture();
  try {
    await f.call(agent("agent:main"), "widget.card.put", { id: "steps", title: "步数", size: "2x2", a2ui: { components: [{ id: "root", component: "Text", text: "8,000", variant: "h1" }] } });
    await f.call(owner, "widget.bind", { widget: "42", card: "steps" });
    assert.match(readFileSync(f.file, "utf8"), /"steps"/);
    const again = new WidgetsMember({ router: new WorldRouter(f.ledger, async () => true), file: f.file });
    const state = again.snapshot();
    assert.equal(state.cards[0].id, "steps");
    assert.equal(state.cards[0].a2ui.components[0].text, "8,000");
    assert.deepEqual(state.bindings, { "42": "steps" });
  } finally { f.close(); }
});

test("a button tap from the phone becomes widget.action for the card's creator, who hears it", async () => {
  const f = await fixture();
  const heard: string[] = [];
  new WorldMembers(f.router).register({ id: "agent:main", kind: "agent", name: "Main", online: true,
    words: () => [{ word: "say", kind: "request", description: "say", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: true }, risk: "none", label: "Reading", audience: "all" }],
    handle: (message: any) => { heard.push(String(message.body.text)); return { ok: true, result: { accepted: true } }; } } as any);
  try {
    await f.call(agent("agent:main"), "widget.card.put", { id: "weather", title: "今天天气", size: "4x2", a2ui: weather });
    const tap = await f.call(phone, "widget.tap", { card: "weather", component: "refresh" });
    assert.equal(tap.ok, true, JSON.stringify(tap));
    const event = f.ledger.list({ limit: 100 }).find((m) => m.word === "widget.action")!;
    assert.equal(event.from, "service:widgets");
    assert.deepEqual(event.body, { card: "weather", action: "refresh", owner: "agent:main", title: "今天天气", component: "refresh" });
    // A phone from before the full format names only the event.
    assert.equal((await f.call(phone, "widget.tap", { card: "weather", action: "refresh" })).ok, true);
    const tapRequest = f.ledger.list({ limit: 100 }).find((m) => m.word === "widget.tap")!;
    assert.equal(tapRequest.from, "person:owner");
    await eventually(() => heard.length > 0, "the tap was not heard");
    assert.match(heard[0], /refresh/);
    // Agents cannot fake a tap, and a button the card does not have is refused.
    assert.equal((await f.call(agent("agent:main"), "widget.tap", { card: "weather", action: "refresh" })).error.code, "forbidden");
    assert.equal((await f.call(phone, "widget.tap", { card: "weather", action: "delete_all" })).ok, false);
    assert.equal((await f.call(phone, "widget.tap", { card: "weather", component: "temp" })).ok, false);
  } finally { f.close(); }
});

test("the phone reports placed widgets; bindings of removed widgets go", async () => {
  const f = await fixture();
  try {
    await f.call(owner, "widget.card.put", { id: "a", title: "A", size: "2x2", a2ui: { components: [{ id: "root", component: "Text", text: "a" }] } });
    assert.equal((await f.call(phone, "widget.bind", { widget: "3", card: "a" })).ok, true);
    assert.equal((await f.call(phone, "widget.placed", { widgets: [{ id: "4", type: "ash" }] })).ok, true);
    const list = await f.call(owner, "widget.list", {});
    assert.deepEqual(list.result.widgets, [{ id: "4", type: "ash", card: null }]);
    assert.equal((await f.call(agent("agent:main"), "widget.placed", { widgets: [] })).error.code, "forbidden");
  } finally { f.close(); }
});

const todo = {
  components: [
    { id: "root", component: "List", children: { componentId: "row", path: "/todo" } },
    { id: "row", component: "CheckBox", label: { path: "title" }, value: { path: "done" }, action: { event: { name: "toggle" } } },
  ],
  data: { todo: [{ id: "milk", title: "买牛奶", done: false }, { id: "mail", title: "回邮件", done: false }] },
};

test("a toggle on the phone is written into the card's data and told to its creator with the item", async () => {
  const pushes: WidgetState[] = [];
  const f = await fixture(async (state) => { pushes.push(state); });
  const heard: string[] = [];
  new WorldMembers(f.router).register({ id: "agent:main", kind: "agent", name: "Main", online: true,
    words: () => [{ word: "say", kind: "request", description: "say", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: true }, risk: "none", label: "Reading", audience: "all" }],
    handle: (message: any) => { heard.push(String(message.body.text)); return { ok: true, result: { accepted: true } }; } } as any);
  try {
    await f.call(agent("agent:main"), "widget.card.put", { id: "todo", title: "待办", size: "4x4", a2ui: todo });
    const tap = await f.call(phone, "widget.tap", { card: "todo", component: "row@1", checked: true });
    assert.equal(tap.ok, true, JSON.stringify(tap));
    await f.member.settled();
    const drawn = pushes.at(-1)!.cards[0].a2ui.components.find((c) => c.id === "row@1")!;
    assert.equal(drawn.checked, true);
    const event = f.ledger.list({ limit: 100 }).find((m) => m.word === "widget.action")!;
    assert.deepEqual(event.body, { card: "todo", action: "toggle", owner: "agent:main", title: "待办", component: "row", item: "mail", checked: true });
    await eventually(() => heard.length > 0, "the tap was not heard");
    assert.match(heard[0], /item mail; now checked/);
    // A restart keeps the owner's choice.
    const again = new WidgetsMember({ router: new WorldRouter(f.ledger, async () => true), file: f.file });
    assert.equal(again.snapshot().cards[0].a2ui.components.find((c) => c.id === "row@1")!.checked, true);
    assert.equal((await f.call(phone, "widget.tap", { card: "todo", component: "row@0" })).ok, false);
  } finally { f.close(); }
});

test("widget.card.validate checks without saving; put reports whether the phone drew the card", async () => {
  let answer: (state: WidgetState) => unknown = () => ({});
  const f = await fixture(async (state) => answer(state) as any);
  const heard: string[] = [];
  new WorldMembers(f.router).register({ id: "agent:main", kind: "agent", name: "Main", online: true,
    words: () => [{ word: "say", kind: "request", description: "say", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: true }, risk: "none", label: "Reading", audience: "all" }],
    handle: (message: any) => { heard.push(String(message.body.text)); return { ok: true, result: { accepted: true } }; } } as any);
  try {
    const good = await f.call(agent("agent:main"), "widget.card.validate", { a2ui: weather });
    assert.deepEqual(good.result, { valid: true, components: 11, levels: 4, actions: ["refresh"] });
    const badCard = await f.call(agent("agent:main"), "widget.card.validate", { a2ui: { components: [{ id: "root", component: "Slider", max: 1, value: 0 }] } });
    assert.equal(badCard.result.valid, false);
    assert.match(badCard.result.problem, /Slider "root" cannot be drawn/);
    assert.equal((await f.call(agent("agent:main"), "widget.list", {})).result.cards.length, 0);

    answer = (state) => ({ widgets: [], rendered: state.cards.map((c) => ({ card: c.id, updated_at: c.updated_at })) });
    const drawn = await f.call(agent("agent:main"), "widget.card.put", { id: "w", title: "天气", size: "4x2", a2ui: weather });
    assert.equal(drawn.result.phone, "drawn");
    answer = (state) => ({ rendered: state.cards.map((c) => ({ card: c.id, updated_at: c.updated_at, problem: "这张卡片画出来是空白的" })) });
    const blank = await f.call(agent("agent:main"), "widget.card.put", { id: "w", title: "天气", size: "4x2", a2ui: weather });
    assert.equal(blank.result.phone, "problem");
    assert.equal(blank.result.problem, "这张卡片画出来是空白的");
    assert.equal((await f.call(agent("agent:main"), "widget.list", {})).result.cards[0].problem, "这张卡片画出来是空白的");
    const event = f.ledger.list({ limit: 100 }).find((m) => m.word === "widget.problem")!;
    assert.deepEqual(event.body, { card: "w", owner: "agent:main", title: "天气", problem: "这张卡片画出来是空白的" });
    await eventually(() => heard.length > 0, "the tap was not heard");
    assert.match(heard[0], /could not fully draw/);
    // A later problem (an image that failed to load) comes with widget.placed; an older version's report is ignored.
    const card = (await f.call(agent("agent:main"), "widget.list", {})).result.cards[0];
    assert.equal((await f.call(phone, "widget.placed", { rendered: [{ card: "w", updated_at: card.updated_at - 1, problem: "old" }] })).ok, true);
    assert.equal((await f.call(agent("agent:main"), "widget.list", {})).result.cards[0].problem, "这张卡片画出来是空白的");
    assert.equal((await f.call(phone, "widget.placed", { rendered: [{ card: "w", updated_at: card.updated_at }] })).ok, true);
    assert.equal((await f.call(agent("agent:main"), "widget.list", {})).result.cards[0].problem, null);
  } finally { f.close(); }
});
