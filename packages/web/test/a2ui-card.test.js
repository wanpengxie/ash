import assert from "node:assert/strict";
import test from "node:test";
import { CARD_ICON_GLYPHS, DRAFT_DELAY_MS, buttonLabel, cardState, cssColor, fieldPath, formAnswerBody, formCancelBody, formatClock, formatSpan, frameMessage, masked,
  miniAppDocument, MINI_APP_CSP, parsePlan, readPointer, renderA2uiCard, resetCards, sayBody, secretsOf, stateLine, writePointer } from "../js/a2ui-card.js";
import { renderCard } from "../js/cards.js";
import { ICON_SHAPES } from "../js/ash-icons.js";
import { CARD_ICONS } from "../../sdk/src/card.ts";
import { tick, until } from "./support.js";

// ---- a small stand-in DOM: enough for the card builder (no layout) ----

class FakeNode {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parent = null; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.value = ""; this.className = "";
    const style = {}; Object.defineProperty(style, "setProperty", { value: (k, v) => { style[k] = v; } }); this.style = style;
  }
  get ownerDocument() { return globalThis.document; }
  get classList() {
    const node = this;
    const names = () => node.className.split(/\s+/).filter(Boolean);
    return { add: (...n) => { node.className = [...new Set([...names(), ...n])].join(" "); }, remove: (...n) => { node.className = names().filter((x) => !n.includes(x)).join(" "); },
      contains: (n) => names().includes(n), toggle: (n, on) => { if (on ?? !names().includes(n)) this.add?.(n); } };
  }
  append(...nodes) { for (const n of nodes) { n.parent?.children.splice(n.parent.children.indexOf(n), 1); n.parent = this; this.children.push(n); } }
  replaceChildren(...nodes) { for (const c of this.children) c.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, target: this, ...event }); }
  click() { if (!this.disabled) this.fire("click"); }
  focus() { globalThis.document.activeElement = this; }
  setSelectionRange(a, b) { this.caret = [a, b]; }
  contains(node) { for (let at = node; at; at = at.parent) if (at === this) return true; return false; }
  set textContent(v) { this.children = []; this.text = String(v ?? ""); }
  get textContent() { return (this.text ?? "") + this.children.map((c) => c.textContent).join(""); }
  all() { return [this, ...this.children.flatMap((c) => c.all())]; }
  find(test) { return this.all().find(test); }
  findAll(test) { return this.all().filter(test); }
  has(cls) { return this.className.split(/\s+/).includes(cls); }
}

function withDom(fn) {
  globalThis.document = { activeElement: null, createElement: (tag) => new FakeNode(tag), createElementNS: (_ns, tag) => new FakeNode(tag),
    createTextNode: (v) => { const n = new FakeNode("#text"); n.text = String(v); return n; } };
  let result;
  try { result = fn(); } finally { if (!(result instanceof Promise)) delete globalThis.document; }
  return result instanceof Promise ? result.finally(() => { delete globalThis.document; }) : result;
}
const byClass = (root, cls) => root.find((n) => n.has?.(cls));
const byId = (root, id) => root.find((n) => n.dataset?.a2Id === id);
const control = (root, id, tag = "input") => byId(root, id)?.find((n) => n.tag === tag || n.tag === "textarea");

// ---- pure parts ----

test("a JSON pointer writes into objects (made on the way) and existing array slots only, with ~0 and ~1 unescaped", () => {
  const data = { list: [1, 2] };
  assert.equal(writePointer(data, "/a/b", 1), true);
  assert.equal(writePointer(data, "/list/1", 9), true);
  assert.equal(writePointer(data, "/list/5", 9), false, "no new array slots");
  assert.equal(writePointer(data, "/x~1y~0z", "v"), true);
  assert.equal(writePointer(data, "/__proto__/polluted", true), false);
  assert.equal(writePointer(data, "/", 1), false);
  assert.equal(writePointer(data, "no-slash", 1), false);
  assert.deepEqual(data, { list: [1, 9], a: { b: 1 }, "x/y~z": "v" });
  assert.equal(readPointer(data, "/x~1y~0z"), "v");
  assert.equal(readPointer(data, "/list/1"), 9);
  assert.equal(readPointer(data, "/missing/deep"), undefined);
  assert.equal(({}).polluted, undefined);
  assert.equal(fieldPath("a/b~c"), "/a~1b~0c");
});

test("a password is masked to its last four characters only when it has eight or more", () => {
  assert.equal(masked("12345678"), "****5678");
  assert.equal(masked("secret-password-9xyz"), "****9xyz");
  assert.equal(masked("1234567"), "****");
  assert.equal(masked(""), "****");
  assert.equal(masked("密码是这个很长的东西啊"), "****的东西啊", "characters, not bytes");
});

test("a form's answer carries the values without the password fields and each password as its vault name and masked tail", () => {
  const form = { secret: { pw: "SITE_PW", "a/b": "OTHER" }, titles: { pw: "密码" } };
  const typed = new Map([["/pw", "hunter2hunter2"], ["/a~1b", "short"]]);
  const body = formAnswerBody(form, { name: "小明", pw: "never here", tags: ["x"] }, typed);
  assert.deepEqual(body, { ok: true, result: { data: { values: { name: "小明", tags: ["x"] }, secret: { pw: { ref: "SITE_PW", masked: "****ter2" }, "a/b": { ref: "OTHER", masked: "****" } } } } });
  assert.deepEqual(formCancelBody(), { ok: false, error: { code: "cancelled", message: "主人取消了" } });
});

test("a button's say is its label with which card, which action, its context and the values", () => {
  const data = { n: 1 };
  const body = sayBody("c1", "好的", { name: "ok", context: { k: "v" } }, data);
  assert.deepEqual(body, { text: "好的", card: { id: "c1", action: "ok", context: { k: "v" }, data: { n: 1 } } });
  data.n = 2;
  assert.equal(body.card.data.n, 1, "the values are a copy");
  assert.deepEqual(sayBody("c1", "", { name: "go", context: {} }, {}), { text: "go", card: { id: "c1", action: "go", data: {} } });
});

test("a plan is drawn only when its root is there; labels come from the first Text under a button", () => {
  assert.equal(parsePlan(null), null);
  assert.equal(parsePlan({ components: [{ id: "x", component: "Text" }] }), null, "no root");
  const plan = parsePlan({ root: "r", components: [{ id: "r", component: "Button", child: "row", action: { event: { name: "go" } } }, { id: "row", component: "Row", children: ["i", "t"] },
    { id: "i", component: "Icon", name: "check" }, { id: "t", component: "Text", text: "**发送** 吧" }], reactive: true });
  assert.equal(plan.reactive, true);
  assert.equal(buttonLabel(plan.byId, plan.byId.get("r")), "发送 吧");
  assert.equal(buttonLabel(plan.byId, { child: "none", action: { event: { name: "fallback" } } }), "fallback");
});

test("a closed card says how it ended in one line", () => {
  assert.equal(stateLine({ state: "open" }), "");
  assert.equal(stateLine({ state: "sent" }), "已提交");
  assert.equal(stateLine({ state: "cancelled" }), "已取消");
  assert.equal(stateLine({ state: "expired" }), "已过期");
  assert.equal(stateLine({ state: "closed" }), "已结束");
  assert.equal(stateLine({ state: "open" }, { sent: true }), "已提交", "sent from this screen before the hub says so");
  assert.equal(stateLine({ state: "open", form: { expires_at: 1000 } }, {}, 2000), "已过期");
});

test("colours, clocks and spans", () => {
  assert.equal(cssColor("accent"), "var(--you)");
  assert.equal(cssColor("#11223344"), "#11223344");
  assert.equal(cssColor({ light: "#000000FF", dark: "#FFFFFFFF" }), "#000000FF");
  assert.equal(cssColor("red;background:url(x)"), null);
  assert.equal(formatClock(new Date(Date.UTC(2026, 9, 15, 7, 5, 9)), "yyyy-MM-dd HH:mm:ss EEE", "UTC"), "2026-10-15 07:05:09 Thu");
  assert.equal(formatSpan(65_000), "1:05");
  assert.equal(formatSpan(3_725_000), "1:02:05");
  assert.equal(formatSpan(-5), "0:00");
});

test("the mini app's document puts the strict CSP, the theme and the bridge ahead of the agent's HTML", () => {
  const vars = { "--ash-bg": "#fff", "--ash-text": "#000", "--ash-accent": "#c00", scheme: "light" };
  const doc = miniAppDocument("<!DOCTYPE html><html><body><script>ash.send('go',{a:1})</script></body></html>", vars, "#123456FF");
  assert.ok(doc.startsWith("<!DOCTYPE html><meta charset=\"utf-8\">"), "the doctype stays first");
  assert.ok(doc.includes(`<meta http-equiv="Content-Security-Policy" content="${MINI_APP_CSP}">`));
  assert.equal(MINI_APP_CSP, "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:");
  assert.ok(doc.includes("--ash-accent:#123456FF"));
  assert.ok(doc.indexOf("window.ash=") < doc.indexOf("<html>"), "the bridge comes before the document");
  assert.ok(miniAppDocument("<p>hi</p>", vars).startsWith("<!doctype html>"));
  assert.ok(!miniAppDocument("x", { "--ash-bg": "red}</style><script>x()</script>" }).includes("</style><script>x()"), "a theme value cannot close the style");
});

// ---- drawing ----

const formItem = (patch = {}) => ({
  id: "msg-form", seq: 3, ts: 1, type: "card", side: "agent",
  card: { type: "a2ui", id: "msg-form", owner: "agent:main", text: "需要你填：登录", state: "open", updated_at: 100,
    form: { secret: { pw: "SITE_PW" }, titles: { name: "名字", pw: "密码" }, expires_at: Date.now() + 60_000 },
    plan: { root: "root", data: { name: "", sure: false, tags: [] }, binds: ["/name", "/sure", "/tags"], reactive: false, components: [
      { id: "root", component: "Column", children: ["title", "name", "pw", "sure", "tags", "actions"] },
      { id: "title", component: "Text", text: "登录", variant: "h4" },
      { id: "name", component: "TextField", label: "名字", variant: "shortText", text: "", bind: "/name" },
      { id: "pw", component: "TextField", label: "密码", variant: "obscured", text: "", bind: "/pw" },
      { id: "sure", component: "Switch", label: "记住我", checked: false, bind: "/sure" },
      { id: "tags", component: "ChoicePicker", label: "标签", multiple: true, chips: true, options: [{ label: "甲", value: "a", checked: false }, { label: "乙", value: "b", checked: false }], bind: "/tags" },
      { id: "actions", component: "Row", justify: "end", children: ["cancel", "submit"] },
      { id: "cancel", component: "Button", variant: "borderless", child: "cancel.label", action: { event: { name: "cancel" } } },
      { id: "cancel.label", component: "Text", text: "取消" },
      { id: "submit", component: "Button", variant: "primary", child: "submit.label", action: { event: { name: "submit" } } },
      { id: "submit.label", component: "Text", text: "提交" },
    ] }, ...patch },
});

function recorder(extra = {}) {
  const calls = [];
  const ctx = {
    calls,
    draft: async (card, data) => { calls.push(["draft", card, data]); return { card, plan: null }; },
    vaultSet: async (body) => { calls.push(["vault", body]); return { ref: body.ref, configured: true }; },
    answerForm: async (request) => { calls.push(["answer", request]); return { ok: true, message: { id: "r1", seq: 9 } }; },
    say: async (to, text, card) => { calls.push(["say", to, text, card]); return "client"; },
    refresh: (id) => { calls.push(["refresh", id]); },
    problem: (text) => { calls.push(["problem", text]); },
    ...extra,
  };
  return ctx;
}

test("every component of a plan is drawn in the card shell; an unknown one is skipped and a hidden one left out", () => withDom(() => {
  resetCards();
  const parent = new FakeNode("div");
  const item = { id: "m1", type: "card", side: "agent", card: { type: "a2ui", id: "c-all", owner: "agent:main", state: "open", updated_at: 1, text: "summary",
    plan: { root: "root", data: { v: 3, when: "2026-10-15" }, theme: { accent: "#336699FF" }, components: [
      { id: "root", component: "Column", children: ["t", "img", "ic", "row", "grid", "list", "card", "tabs", "div", "sp", "chk", "pick", "prog", "badge", "clock", "timer", "chart", "slider", "date", "long", "table", "html", "sk", "alien", "hidden"] },
      { id: "t", component: "Text", text: "# 标题\n**粗** *斜* `码` ~~删~~ [链接](https://example.com) [坏](javascript:alert(1))\n- 一\n- 二", variant: "body", style: { color: "accent", padding: [1, 2, 3, 4] } },
      { id: "img", component: "Image", url: "https://example.com/a.png", fit: "cover", variant: "header" },
      { id: "ic", component: "Icon", name: "check" },
      { id: "row", component: "Row", justify: "spaceBetween", children: ["a", "b"] }, { id: "a", component: "Text", text: "a", weight: 1 }, { id: "b", component: "Badge", text: "新" },
      { id: "grid", component: "Grid", columns: 3, children: ["g1"] }, { id: "g1", component: "Text", text: "g" },
      { id: "list", component: "List", direction: "horizontal", children: ["l1"] }, { id: "l1", component: "Text", text: "l" },
      { id: "card", component: "Card", child: "inner" }, { id: "inner", component: "Text", text: "inside" },
      { id: "tabs", component: "Tabs", selected: 1, tabs: [{ title: "一", child: "tab1" }, { title: "二", child: "tab2" }] },
      { id: "tab1", component: "Text", text: "first" }, { id: "tab2", component: "Text", text: "second" },
      { id: "div", component: "Divider", axis: "horizontal" }, { id: "sp", component: "Spacer", size: 8 },
      { id: "chk", component: "CheckBox", label: "勾", checked: true },
      { id: "pick", component: "ChoicePicker", options: [{ label: "x", value: "x", checked: true }, { label: "y", value: "y", checked: false }] },
      { id: "prog", component: "ProgressBar", value: 30, max: 60, label: "进度" },
      { id: "badge", component: "Badge", text: "B" },
      { id: "clock", component: "Clock", format: "HH:mm", timeZone: "UTC" },
      { id: "timer", component: "Timer", since: Date.now() - 61_000 },
      { id: "chart", component: "Chart", style: { height: 40 }, series: [{ type: "bars", values: [1, 2, 3], color: "accent" }, { type: "line", values: [3, 1, 2], color: "#FF0000FF", fill: true, limit: 2 }] },
      { id: "slider", component: "Slider", label: "量", min: 0, max: 10, value: 3, bind: "/v" },
      { id: "date", component: "DateTimeInput", label: "日", text: "2026-10-15", enableDate: true, enableTime: false, bind: "/when" },
      { id: "long", component: "TextField", label: "长", variant: "longText", text: "多行" },
      { id: "table", component: "Table", header: ["名", "值"], rows: [["a", "1"], ["b", "2"]] },
      { id: "html", component: "Html", html: "<p>mini</p>", height: 120 },
      { id: "sk", component: "Skeleton" },
      { id: "alien", component: "Hologram" },
      { id: "hidden", component: "Text", text: "secret", visible: false },
    ] } } };
  const root = renderA2uiCard(parent, item, recorder());
  assert.ok(root.has("a-card") && root.has("card") && root.has("a2ui"), "the chat card's shell");
  assert.equal(root.style["--you"], "#336699FF", "the card's accent");
  const text = byId(root, "t");
  assert.ok(text.find((n) => n.tag === "b" && n.textContent === "粗") && text.find((n) => n.tag === "i") && text.find((n) => n.tag === "code") && text.find((n) => n.tag === "s"));
  assert.equal(text.find((n) => n.tag === "a").href, "https://example.com/");
  assert.equal(text.findAll((n) => n.tag === "a").length, 1, "an unsafe link stays text");
  assert.equal(text.findAll((n) => n.tag === "li").length, 2);
  assert.ok(text.find((n) => n.has?.("a2-md-h1")));
  assert.equal(text.style.color, "var(--you)");
  assert.equal(text.style.padding, "1px 2px 3px 4px");
  assert.equal(byId(root, "img").src, "https://example.com/a.png");
  assert.equal(byId(root, "img").style.objectFit, "cover");
  assert.equal(byId(root, "row").style.justifyContent, "space-between");
  assert.equal(byId(root, "a").style.flex, "1 1 0");
  assert.equal(byId(root, "grid").style.gridTemplateColumns, "repeat(3, minmax(0, 1fr))");
  assert.ok(byId(root, "list").has("a2-hlist"));
  assert.ok(byId(root, "card").has("a2-card"));
  assert.ok(byId(root, "tab2") && !byId(root, "tab1"), "the selected tab only");
  byId(root, "tabs").findAll((n) => n.has?.("a2-tab"))[0].click();
  assert.ok(byId(root, "tab1") && !byId(root, "tab2"), "a tab switches on this screen");
  assert.equal(control(root, "chk").checked, true);
  assert.equal(control(root, "pick").checked, true);
  assert.equal(byClass(byId(root, "prog"), "a2-fill").style.width, "50%");
  assert.match(byId(root, "clock").textContent, /^\d{2}:\d{2}$/);
  assert.equal(byId(root, "timer").textContent, "1:01");
  const svg = byId(root, "chart").find((n) => n.tag === "svg");
  assert.equal(svg.findAll((n) => n.tag === "rect").length, 3);
  assert.ok(svg.find((n) => n.tag === "line"), "the limit line");
  assert.equal(control(root, "slider").value, "3");
  assert.equal(control(root, "date").type, "date");
  assert.equal(control(root, "date").value, "2026-10-15");
  assert.equal(control(root, "long", "textarea").value, "多行");
  assert.deepEqual(byId(root, "table").findAll((n) => n.tag === "td").map((n) => n.textContent), ["a", "1", "b", "2"]);
  const frame = byId(root, "html").find((n) => n.tag === "iframe");
  assert.equal(frame.attributes.sandbox, "allow-scripts");
  assert.equal(frame.style.height, "120px");
  assert.ok(frame.srcdoc.includes(MINI_APP_CSP) && frame.srcdoc.includes("<p>mini</p>"));
  assert.ok(byId(root, "html").find((n) => n.tag === "button" && n.textContent === "存成应用"));
  assert.ok(byId(root, "sk").has("sk"));
  assert.equal(byId(root, "alien"), undefined);
  assert.equal(byId(root, "hidden"), undefined);
  assert.equal(byClass(root, "a2-status"), undefined, "an open card has no end line");
}));

test("a container's gap is the space between its children; without one they sit edge to edge", () => withDom(() => {
  resetCards();
  const item = { id: "m", type: "card", card: { type: "a2ui", id: "gaps", owner: "agent:main", state: "open", updated_at: 1, plan: { root: "root", components: [
    { id: "root", component: "Column", gap: 12, children: ["row", "grid", "list", "plain"] },
    { id: "row", component: "Row", gap: 6, children: ["a"] }, { id: "a", component: "Text", text: "a" },
    { id: "grid", component: "Grid", columns: 2, gap: 4, children: [] }, { id: "list", component: "List", direction: "horizontal", gap: 8, children: [] },
    { id: "plain", component: "Row", children: [] }] } } };
  const root = renderA2uiCard(new FakeNode("div"), item, recorder());
  assert.deepEqual(["root", "row", "grid", "list", "plain"].map((id) => byId(root, id).style.gap), ["12px", "6px", "4px", "8px", undefined]);
}));

test("every card icon name is one of Ash's line icons or the neutral outline, drawn in the node's colour; an svgPath outline is stroked", () => withDom(() => {
  resetCards();
  assert.deepEqual(Object.keys(CARD_ICON_GLYPHS).sort(), [...CARD_ICONS].sort(), "one entry for every name the hub accepts");
  for (const [name, glyph] of Object.entries(CARD_ICON_GLYPHS)) assert.ok(glyph === null || ICON_SHAPES[glyph], `${name} -> ${glyph}`);
  const item = { id: "m", type: "card", card: { type: "a2ui", id: "icons", owner: "agent:main", state: "open", updated_at: 1, plan: { root: "root", components: [
    { id: "root", component: "Row", children: ["ok", "sun", "img", "line", "solid"] },
    { id: "ok", component: "Icon", name: "check", style: { color: "accent" } }, { id: "sun", component: "Icon", name: "sun" },
    { id: "img", component: "Image", url: "icon:mail" },
    { id: "line", component: "Icon", svgPath: "M4 12h16" }, { id: "solid", component: "Icon", svgPath: "M4 4h16v16H4Z" }] } } };
  const root = renderA2uiCard(new FakeNode("div"), item, recorder());
  const ok = byId(root, "ok");
  assert.equal(ok.style.color, "var(--you)", "tinted with the node's colour");
  assert.ok(ok.find((n) => n.tag === "path"), "a line icon, not a glyph");
  assert.equal(root.textContent.includes("✓"), false);
  const sun = byId(root, "sun").find((n) => n.tag === "svg");
  assert.match(sun.attributes.class, /a2-icon-none/);
  assert.ok(sun.find((n) => n.tag === "circle"), "no close match: a small circle");
  assert.ok(byId(root, "img").find((n) => n.tag === "path"), "icon: images are line icons too");
  assert.doesNotMatch(byId(root, "line").find((n) => n.tag === "svg").attributes.class, /i-solid/);
  assert.match(byId(root, "solid").find((n) => n.tag === "svg").attributes.class, /i-solid/);
}));

test("a chart series with min starts its axis there", () => withDom(() => {
  resetCards();
  const item = { id: "m", type: "card", card: { type: "a2ui", id: "weight", owner: "agent:main", state: "open", updated_at: 1, plan: { root: "root", components: [
    { id: "root", component: "Chart", style: { height: 30 }, series: [{ type: "bars", values: [40, 63], color: "accent", min: 58 }], gap: 0 }] } } };
  const svg = byId(renderA2uiCard(new FakeNode("div"), item, recorder()), "root").find((n) => n.tag === "svg");
  assert.deepEqual(svg.findAll((n) => n.tag === "rect").map((r) => r.attributes.height), ["2", "24"], "axis 58 .. 58 + 5 x 1.25; 40 sits on the bottom");
}));

const thumbs = (root) => byClass(root, "a2-feedback")?.findAll((n) => n.tag === "button") ?? [];

test("an agent's card, open or closed, has the quiet thumbs; a tap is the owner's say with the values; the chosen one stays chosen", async () => withDom(async () => {
  resetCards();
  const ctx = recorder();
  const plan = { root: "root", data: { n: 1 }, components: [{ id: "root", component: "Text", text: "hi" }] };
  const item = { id: "m1", type: "card", card: { type: "a2ui", id: "fb-1", owner: "agent:helper", state: "open", updated_at: 1, plan } };
  const root = renderA2uiCard(new FakeNode("div"), item, ctx);
  const [up, down] = thumbs(root);
  assert.deepEqual([up.textContent, down.textContent], ["👍", "👎"]);
  assert.deepEqual([up.attributes["aria-pressed"], down.attributes["aria-pressed"]], ["false", "false"]);
  up.click();
  await until(() => ctx.calls.some(([k]) => k === "say"));
  assert.deepEqual(ctx.calls.find(([k]) => k === "say").slice(1), ["agent:helper", "👍", { id: "fb-1", action: "feedback", context: { feedback: "up" }, data: { n: 1 } }]);
  assert.ok(thumbs(root)[0].has("on"), "chosen at once");
  thumbs(root)[0].click();
  await tick();
  assert.equal(ctx.calls.filter(([k]) => k === "say").length, 1, "the same one again does nothing");

  // The hub's record of the last one, on a closed card.
  const closed = renderA2uiCard(new FakeNode("div"), { id: "m2", type: "card", card: { type: "a2ui", id: "fb-2", owner: "agent:helper", state: "closed", updated_at: 1, feedback: "down", plan } }, ctx);
  assert.equal(byClass(closed, "a2-status").textContent, "已结束");
  const [, chosen] = thumbs(closed);
  assert.ok(chosen.has("on") && chosen.attributes["aria-pressed"] === "true");
  chosen.click();
  await tick();
  assert.equal(ctx.calls.filter(([k]) => k === "say").length, 1);
  thumbs(closed)[0].click();
  await until(() => ctx.calls.filter(([k]) => k === "say").length === 2);
  assert.deepEqual(ctx.calls.filter(([k]) => k === "say")[1].slice(2), ["👍", { id: "fb-2", action: "feedback", context: { feedback: "up" }, data: { n: 1 } }]);

  assert.equal(thumbs(renderA2uiCard(new FakeNode("div"), formItem({ id: "fb-form" }), ctx)).length, 0, "a form has no thumbs");
  const readOnly = thumbs(renderA2uiCard(new FakeNode("div"), { id: "m3", type: "card", card: { type: "a2ui", id: "fb-3", owner: "agent:helper", state: "open", updated_at: 1, plan } }));
  assert.ok(readOnly.length === 2 && readOnly.every((b) => b.disabled), "drawn (the same height) but not tappable without a page to send from");
}));

test("a failed thumb goes back to what was chosen before", async () => withDom(async () => {
  resetCards();
  const ctx = recorder({ say: async () => { throw new Error("offline"); } });
  const item = { id: "m", type: "card", card: { type: "a2ui", id: "fb-x", owner: "agent:helper", state: "open", updated_at: 1, plan: { root: "root", components: [{ id: "root", component: "Text", text: "hi" }] } } };
  const root = renderA2uiCard(new FakeNode("div"), item, ctx);
  thumbs(root)[1].click();
  await until(() => ctx.calls.some(([k]) => k === "problem"));
  assert.ok(thumbs(root).every((b) => !b.has("on")));
}));

test("a card with no plan, or one that cannot be drawn, shows its plain text", () => withDom(() => {
  resetCards();
  const parent = new FakeNode("div");
  const root = renderCard(parent, { id: "m", type: "card", card: { type: "a2ui", id: "c", text: "只有文字" } }, {});
  assert.ok(root.has("a2-plain"));
  assert.equal(root.textContent, "只有文字");
  const broken = renderA2uiCard(parent, { id: "m2", card: { type: "a2ui", id: "c2", text: "后备", plan: { root: "r", components: [{ id: "r", component: "Nope" }] } } });
  assert.equal(broken.textContent, "后备");
}));

test("typing writes the working copy (never a password), keeps it across drawing again, and sends the values after a pause", async () => withDom(async () => {
  resetCards();
  const ctx = recorder();
  const item = formItem();
  let root = renderA2uiCard(new FakeNode("div"), item, ctx);
  const name = control(root, "name");
  name.value = "小明"; name.fire("input");
  const pw = control(root, "pw");
  assert.equal(pw.type, "password");
  pw.value = "hunter2hunter2"; pw.fire("input");
  const sure = control(root, "sure");
  sure.checked = true; sure.fire("change");
  byId(root, "tags").findAll((n) => n.tag === "button")[1].click();
  assert.deepEqual(cardState("msg-form").data, { name: "小明", sure: true, tags: ["b"] });
  assert.equal(secretsOf("msg-form").get("/pw"), "hunter2hunter2");
  assert.ok(!JSON.stringify(cardState("msg-form").data).includes("hunter2"));
  root = renderA2uiCard(new FakeNode("div"), item, ctx);
  assert.equal(control(root, "name").value, "小明", "the row drawn again shows what was typed");
  assert.equal(control(root, "pw").value, "hunter2hunter2");
  assert.ok(byId(root, "tags").findAll((n) => n.tag === "button")[1].has("on"));
  assert.equal(ctx.calls.filter(([k]) => k === "draft").length, 0);
  await tick(DRAFT_DELAY_MS + 50);
  const drafts = ctx.calls.filter(([k]) => k === "draft");
  assert.equal(drafts.length, 1, "one draft after the owner stops");
  assert.deepEqual(drafts[0].slice(1), ["msg-form", { name: "小明", sure: true, tags: ["b"] }]);
}));

test("a newer version from the hub replaces the working copy unless the owner is editing the card", async () => withDom(async () => {
  resetCards();
  const ctx = recorder();
  const item = formItem();
  let root = renderA2uiCard(new FakeNode("div"), item, ctx);
  const name = control(root, "name");
  name.value = "typing"; name.fire("input");
  const newer = formItem({ updated_at: 200 });
  newer.card.plan = { ...newer.card.plan, data: { name: "agent", sure: false, tags: [] } };
  root = renderA2uiCard(new FakeNode("div"), newer, ctx);
  assert.equal(control(root, "name").value, "typing", "a change waiting to be sent is kept");
  await tick(DRAFT_DELAY_MS + 50);
  assert.deepEqual(ctx.calls.filter(([k]) => k === "refresh"), [["refresh", "msg-form"]], "read again once the hub has the owner's values");
  root = renderA2uiCard(new FakeNode("div"), newer, ctx);
  assert.equal(control(root, "name").value, "typing", "the version seen while typing is older than the owner's values");
  const latest = formItem({ updated_at: 300 });
  latest.card.plan = { ...latest.card.plan, data: { name: "typing", sure: false, tags: [] } };
  root = renderA2uiCard(new FakeNode("div"), latest, ctx);
  assert.equal(cardState("msg-form").seen, 300);
  const agentUpdate = formItem({ updated_at: 400 });
  agentUpdate.card.plan = { ...agentUpdate.card.plan, data: { name: "from agent", sure: false, tags: [] } };
  root = renderA2uiCard(new FakeNode("div"), agentUpdate, ctx);
  assert.equal(control(root, "name").value, "from agent", "not editing: the hub's version wins");
}));

test("a reactive card is drawn again from the draft's answer, keeping the focused input focused with its caret", async () => withDom(async () => {
  resetCards();
  const plan = (n) => ({ root: "root", data: { n }, binds: ["/n"], reactive: true, components: [
    { id: "root", component: "Column", children: ["s", "t"] },
    { id: "s", component: "TextField", label: "n", text: String(n), bind: "/n" },
    { id: "t", component: "Text", text: `n = ${n}` }] });
  const ctx = recorder({ draft: async (card, data) => ({ card, plan: plan(data.n) }) });
  const parent = new FakeNode("div");
  const root = renderA2uiCard(parent, { id: "m", type: "card", card: { type: "a2ui", id: "rc", owner: "agent:main", state: "open", updated_at: 1, plan: plan("1") } }, ctx);
  const input = control(root, "s");
  input.focus();
  input.selectionStart = input.selectionEnd = 2;
  input.value = "42"; input.fire("input");
  await tick(DRAFT_DELAY_MS + 50);
  assert.equal(byId(root, "t").textContent, "n = 42");
  const again = control(root, "s");
  assert.notEqual(again, input, "drawn again");
  assert.deepEqual(again.caret, [2, 2]);
  assert.equal(globalThis.document.activeElement, again);
  assert.equal(again.value, "42");
}));

test("「提交」 saves each password in the vault, then answers the form with the values and the masked passwords", async () => withDom(async () => {
  resetCards();
  const ctx = recorder();
  const item = formItem();
  const root = renderA2uiCard(new FakeNode("div"), item, ctx);
  const name = control(root, "name"); name.value = "小明"; name.fire("input");
  byId(root, "submit").click();
  await tick();
  assert.equal(byClass(root, "a2-error").textContent, "请先填写密码", "an empty password box stops the send");
  assert.equal(ctx.calls.filter(([k]) => k === "vault" || k === "answer").length, 0);
  const pw = control(root, "pw"); pw.value = "hunter2hunter2"; pw.fire("input");
  byId(root, "submit").click();
  await until(() => ctx.calls.some(([k]) => k === "answer"));
  assert.deepEqual(ctx.calls.find(([k]) => k === "vault")[1], { ref: "SITE_PW", value: "hunter2hunter2", label: "密码", kind: "password" });
  const answer = ctx.calls.find(([k]) => k === "answer")[1];
  assert.equal(answer.to, "agent:main");
  assert.equal(answer.reply_to, "msg-form");
  assert.equal(typeof answer.client_id, "string");
  assert.deepEqual(answer.body, { ok: true, result: { data: { values: { name: "小明", sure: false, tags: [] }, secret: { pw: { ref: "SITE_PW", masked: "****ter2" } } } } });
  assert.ok(!JSON.stringify(answer).includes("hunter2hunter2"), "the password itself is not in the answer");
  await until(() => byClass(root, "a2-status")?.textContent === "已提交");
  assert.equal(secretsOf("msg-form").size, 0, "the password is forgotten");
  assert.equal(byId(root, "submit").disabled, true, "a sent form is read-only");
  assert.equal(control(root, "name").disabled, true);
}));

test("「取消」 answers the form as cancelled; a failed save stops before the answer", async () => withDom(async () => {
  resetCards();
  const ctx = recorder();
  const root = renderA2uiCard(new FakeNode("div"), formItem(), ctx);
  byId(root, "cancel").click();
  await until(() => byClass(root, "a2-status")?.textContent === "已取消");
  assert.deepEqual(ctx.calls.find(([k]) => k === "answer")[1].body, formCancelBody());

  resetCards();
  const failing = recorder({ vaultSet: async () => { throw new Error("locked"); } });
  const card = renderA2uiCard(new FakeNode("div"), formItem(), failing);
  const pw = control(card, "pw"); pw.value = "x"; pw.fire("input");
  byId(card, "submit").click();
  await until(() => byClass(card, "a2-error"));
  assert.equal(failing.calls.filter(([k]) => k === "answer").length, 0);
  assert.equal(byId(card, "submit").disabled, false, "it can be sent again");
}));

test("a closed card is drawn read-only with one line saying how it ended", () => withDom(() => {
  resetCards();
  for (const [state, line] of [["sent", "已提交"], ["cancelled", "已取消"], ["expired", "已过期"], ["closed", "已结束"]]) {
    const root = renderA2uiCard(new FakeNode("div"), formItem({ id: `f-${state}`, state }), recorder());
    assert.equal(byClass(root, "a2-status").textContent, line);
    assert.equal(byId(root, "submit").disabled, true);
    assert.equal(control(root, "name").disabled, true);
  }
}));

test("a button on an agent's card is the owner's say to the agent, with the card's values; open actions open", async () => withDom(async () => {
  resetCards();
  const opened = [];
  const ctx = recorder({ open: (action) => opened.push(action) });
  const item = { id: "m9", type: "card", side: "agent", card: { type: "a2ui", id: "pick-1", owner: "agent:helper", state: "open", updated_at: 1,
    plan: { root: "root", data: { size: 2 }, components: [
      { id: "root", component: "Row", children: ["go", "link"] },
      { id: "go", component: "Button", variant: "primary", child: "go.t", action: { event: { name: "order", context: { sku: "A1" } } } },
      { id: "go.t", component: "Text", text: "下单" },
      { id: "link", component: "Button", child: "link.t", action: { openUrl: { url: "https://example.com/" } } },
      { id: "link.t", component: "Text", text: "看看" }] } } };
  const root = renderA2uiCard(new FakeNode("div"), item, ctx);
  byId(root, "go").click();
  await until(() => ctx.calls.some(([k]) => k === "say"));
  assert.deepEqual(ctx.calls.find(([k]) => k === "say").slice(1), ["agent:helper", "下单", { id: "pick-1", action: "order", context: { sku: "A1" }, data: { size: 2 } }]);
  byId(root, "link").click();
  await tick();
  assert.deepEqual(opened, [{ openUrl: { url: "https://example.com/" } }]);
}));

test("only a frame this page made speaks for its card, and only with {ash: send, action, context}", async () => withDom(async () => {
  resetCards();
  const ctx = recorder();
  const item = { id: "m", type: "card", card: { type: "a2ui", id: "mini", owner: "agent:main", state: "open", updated_at: 1,
    plan: { root: "root", data: { k: 1 }, components: [{ id: "root", component: "Html", html: "<b>x</b>", height: 100 }] } } };
  const root = renderA2uiCard(new FakeNode("div"), item, ctx);
  const frame = root.find((n) => n.tag === "iframe");
  frame.contentWindow = { name: "frame window" };
  assert.equal(frameMessage({ source: { name: "someone else" }, data: { ash: "send", action: "go" } }), false);
  assert.equal(frameMessage({ source: frame.contentWindow, data: { ash: "send", action: "bad name!" } }), false);
  assert.equal(frameMessage({ source: frame.contentWindow, data: { ash: "send", action: "go", context: { n: 1 } } }), true);
  await until(() => ctx.calls.some(([k]) => k === "say"));
  assert.deepEqual(ctx.calls.find(([k]) => k === "say").slice(1), ["agent:main", "go", { id: "mini", action: "go", context: { n: 1 }, data: { k: 1 } }]);
  root.find((n) => n.tag === "button" && n.textContent === "存成应用").click();
  await until(() => ctx.calls.filter(([k]) => k === "say").length === 2);
  assert.deepEqual(ctx.calls.filter(([k]) => k === "say")[1].slice(1), ["agent:main", "把这个小应用存成应用", { id: "mini", action: "save_app", context: { component: "root" }, data: { k: 1 } }]);
}));

// ---- the page's words ----

test("a card's say passes the say contract, and a form is answered like an ask with word form", async () => {
  // The test kernel runs the hub's TypeScript (npm test loads tsx for it).
  const [{ startKernel }, { netFor }] = await Promise.all([import("./kernel.js"), import("./support.js")]);
  const kernel = startKernel();
  const { net } = netFor(kernel);
  net.start();
  await until(() => net.status === "online", 2000, "online");
  const clientId = await net.enqueueSay("下单", [], null, "agent:main", { id: "pick-1", action: "order", context: { sku: "A1" }, data: { size: 2 } });
  await until(() => kernel.requests.some((r) => r.word === "say"));
  assert.deepEqual(kernel.requests.find((r) => r.word === "say"), { to: "agent:main", kind: "request", word: "say",
    body: { text: "下单", card: { id: "pick-1", action: "order", context: { sku: "A1" }, data: { size: 2 } } }, client_id: clientId });
  await until(() => net.outbox.every((item) => item.status === "accepted") || net.outbox.length === 0, 2000, "accepted, not refused");
  await assert.rejects(net.enqueueSay("x", [], null, "agent:main", { id: "", action: "a" }), /invalid card action/);
  await net.answerForm({ to: "agent:main", reply_to: "form-1", body: formCancelBody(), client_id: "c-form" });
  assert.deepEqual(kernel.requests.find((r) => r.word === "form"), { to: "agent:main", kind: "response", word: "form", reply_to: "form-1", body: formCancelBody(), client_id: "c-form" });
  net.stop(); kernel.close();
});

test("a card.update answered by the hub, or a form answered, names the card to read again", () => {
  const changes = [];
  const fake = { onCardChange: (c) => changes.push(c), cardUpdates: new Map() };
  return import("../js/net.js").then(({ Net }) => {
    const call = (m) => Net.prototype.cardChanged.call(fake, m);
    call({ id: "u1", kind: "request", to: "person:owner", from: "agent:main", word: "card.update", body: { id: "card-7" } });
    assert.deepEqual(changes, [], "not before the hub has changed it");
    call({ id: "u2", kind: "response", from: "person:owner", to: "agent:main", word: "card.update", reply_to: "u1", body: { ok: true } });
    call({ id: "u3", kind: "response", from: "person:owner", to: "agent:main", word: "form", reply_to: "form-msg", body: { ok: true } });
    call({ id: "u4", kind: "response", from: "person:owner", to: "agent:main", word: "card.update", reply_to: "unknown", body: { ok: true } });
    assert.deepEqual(changes, [{ card: "card-7" }, { message: "form-msg" }]);
  });
});
