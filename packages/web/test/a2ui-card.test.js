import assert from "node:assert/strict";
import test from "node:test";
import { CARD_ICON_GLYPHS, CARD_ICON_SHAPES, COPIED_MS, DRAFT_DELAY_MS, SeenReporter, actBody, actOnce, actProblem, actTimeoutMs, buttonLabel, buttonView, cardIdsOnScreen,
  cardState, cssColor, fieldPath, formAnswerBody, formCancelBody, formatClock, formatSpan, frameMessage, liveLine, masked, pinnable, miniAppDocument, miniAppRequest, MINI_APP_CSP,
  parsePlan, patchA2uiCard, readPointer, renderA2uiCard, resetCards, runtimeKind, sayBody, secretsOf, stateLine, writePointer,
  updateA2uiCard, miniAppRpc, MINI_APP_MAX_BYTES } from "../js/a2ui-card.js";
import { renderCard } from "../js/cards.js";
import { ICON_SHAPES } from "../js/ash-icons.js";
import { CARD_ICONS } from "../../sdk/src/card.ts";
import { tick, until } from "./support.js";

// ---- a small stand-in DOM: enough for the card builder (no layout) ----

class FakeNode {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parent = null; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.value = ""; this.className = "";
    const style = {};
    Object.defineProperty(style, "setProperty", { value: (k, v) => { style[k] = v; } });
    Object.defineProperty(style, "removeProperty", { value: (k) => { delete style[k]; } });
    Object.defineProperty(style, "cssText", { set: () => { for (const k of Object.keys(style)) delete style[k]; }, get: () => "" });
    this.style = style;
  }
  get parentNode() { return this.parent; }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() { return this.parent ? this.parent.children[this.parent.children.indexOf(this) + 1] ?? null : null; }
  insertBefore(node, ref) {
    node.parent?.children.splice(node.parent.children.indexOf(node), 1);
    node.parent = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(node); else this.children.splice(at, 0, node);
    return node;
  }
  removeAttribute(k) { delete this.attributes[k]; }
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
/** The token of [frame]'s current load, as its bridge has it. */
const frameToken = (frame) => /g="([0-9a-f]+)"/.exec(frame.srcdoc)?.[1];
/** A message event of the mini app in [frame], as its bridge posts it (JSON-RPC under the load's token). */
const rpc = (frame, message, token = frameToken(frame)) => ({ source: frame.contentWindow, data: { g: token, m: JSON.stringify({ jsonrpc: "2.0", ...message }) } });
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

test("every component of a plan is drawn in the card shell; an unknown one is skipped and a hidden one kept out of sight", () => withDom(() => {
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
  assert.equal(byId(root, "hidden").style.display, "none", "drawn but not shown: showing it later is a patch, not a new subtree");
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

test("every card icon name is a line icon (Ash's or the cards' own), drawn in the node's colour; an unknown one is the neutral outline; an svgPath outline is stroked", () => withDom(() => {
  resetCards();
  assert.deepEqual(Object.keys(CARD_ICON_GLYPHS).sort(), [...CARD_ICONS].sort(), "one entry for every name the hub accepts");
  for (const [name, glyph] of Object.entries(CARD_ICON_GLYPHS)) assert.ok(ICON_SHAPES[glyph] || CARD_ICON_SHAPES[glyph], `${name} -> ${glyph}: no name falls back to the circle`);
  for (const name of ["sun", "cloud", "rain", "snow", "wind", "moon", "person", "accountCircle", "star", "starHalf", "starOff", "volumeUp", "volumeDown", "volumeMute", "volumeOff", "weight", "water", "car"])
    assert.ok(CARD_ICON_SHAPES[CARD_ICON_GLYPHS[name]] || ICON_SHAPES[CARD_ICON_GLYPHS[name]], name);
  for (const shapes of Object.values(CARD_ICON_SHAPES)) for (const [tag, attrs] of shapes) assert.ok(tag === "path" && typeof attrs.d === "string" && attrs.d.length > 4);
  const item = { id: "m", type: "card", card: { type: "a2ui", id: "icons", owner: "agent:main", state: "open", updated_at: 1, plan: { root: "root", components: [
    { id: "root", component: "Row", children: ["ok", "sun", "img", "line", "solid", "odd"] }, { id: "odd", component: "Icon", name: "nothingLikeThis" },
    { id: "ok", component: "Icon", name: "check", style: { color: "accent" } }, { id: "sun", component: "Icon", name: "sun" },
    { id: "img", component: "Image", url: "icon:mail" },
    { id: "line", component: "Icon", svgPath: "M4 12h16" }, { id: "solid", component: "Icon", svgPath: "M4 4h16v16H4Z" }] } } };
  const root = renderA2uiCard(new FakeNode("div"), item, recorder());
  const ok = byId(root, "ok");
  assert.equal(ok.style.color, "var(--you)", "tinted with the node's colour");
  assert.ok(ok.find((n) => n.tag === "path"), "a line icon, not a glyph");
  assert.equal(root.textContent.includes("✓"), false);
  const sun = byId(root, "sun").find((n) => n.tag === "svg");
  assert.doesNotMatch(sun.attributes.class, /a2-icon-none/);
  assert.equal(sun.findAll((n) => n.tag === "path").length, CARD_ICON_SHAPES.sun.length, "the cards' own sun");
  const odd = byId(root, "odd").find((n) => n.tag === "svg");
  assert.match(odd.attributes.class, /a2-icon-none/);
  assert.ok(odd.find((n) => n.tag === "circle"), "no match at all: a small circle");
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

const thumbs = (root) => byClass(root, "a2-feedback")?.findAll((n) => n.tag === "button" && n.has("a2-fb")) ?? [];

test("an agent's card, open or closed, has the quiet thumbs; a tap is the owner's say with the values; the chosen one stays chosen", async () => withDom(async () => {
  resetCards();
  const ctx = recorder();
  const plan = { root: "root", data: { n: 1 }, components: [{ id: "root", component: "Text", text: "hi" }] };
  const item = { id: "m1", type: "card", card: { type: "a2ui", id: "fb-1", owner: "agent:helper", state: "open", updated_at: 1, plan } };
  const root = renderA2uiCard(new FakeNode("div"), item, ctx);
  const [up, down] = thumbs(root);
  assert.deepEqual([up.attributes["aria-label"], down.attributes["aria-label"]], ["有用", "没用"]);
  assert.ok([up, down].every((b) => b.find((n) => n.tag === "svg") && !b.textContent.includes("👍") && !b.textContent.includes("👎")), "line icons, not emoji");
  assert.notDeepEqual(up.find((n) => n.tag === "path").attributes, down.find((n) => n.tag === "path").attributes, "thumbs up and down differ");
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

test("a reactive card is patched from the draft's answer: the focused input is the same one, its caret and focus untouched", async () => withDom(async () => {
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
  assert.equal(again, input, "patched in place, never drawn again");
  assert.equal(again.caret, undefined, "no caret put back: it never moved");
  assert.equal(globalThis.document.activeElement, input);
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

test("only the frame this page made, in its current load, speaks for its card; a card without an app has ash.send alone", async () => withDom(async () => {
  resetCards();
  const ctx = recorder({ act: async (body) => { ctx.calls.push(["act", body]); return { state: "ok", text: "不该到这里" }; } });
  const item = { id: "m", type: "card", card: { type: "a2ui", id: "mini", owner: "agent:main", state: "open", updated_at: 1,
    plan: { root: "root", data: { k: 1 }, components: [{ id: "root", component: "Html", html: "<b>x</b>", height: 100 }] } } };
  const root = renderA2uiCard(new FakeNode("div"), item, ctx);
  const frame = root.find((n) => n.tag === "iframe");
  const posted = [];
  frame.contentWindow = { name: "frame window", postMessage: (message) => posted.push(message) };
  assert.ok(frame.srcdoc.includes("window.ash=Object.freeze(a)") && !frame.srcdoc.includes("a.call="), "its bridge has ash.send alone");
  assert.equal(frameMessage({ ...rpc(frame, { method: "ash/send", params: { action: "go" } }), source: { name: "someone else" } }), false);
  assert.equal(frameMessage(rpc(frame, { method: "ash/send", params: { action: "bad name!" } })), false);
  assert.equal(frameMessage(rpc(frame, { method: "ash/send", params: { action: "go", context: { n: 1 } } })), true);
  await until(() => ctx.calls.some(([k]) => k === "say"));
  assert.deepEqual(ctx.calls.find(([k]) => k === "say").slice(1), ["agent:main", "go", { id: "mini", action: "go", context: { n: 1 }, data: { k: 1 } }]);
  // ash.call / ask / tell are not there for it: a page that posts one anyway is refused (and told so), nothing runs.
  assert.equal(frameMessage(rpc(frame, { id: "r1", method: "ash/call", params: { member: "app:weather", word: "now", body: {} } })), false);
  assert.equal(frameMessage(rpc(frame, { id: "r2", method: "ash/ask", params: { text: "明天呢" } })), false);
  await tick();
  assert.equal(ctx.calls.filter(([k]) => k === "act").length, 0);
  assert.deepEqual(posted.map((m) => JSON.parse(m.m)), [{ jsonrpc: "2.0", id: "r1", result: { state: "failed", text: "这张卡不能这样做。" } },
    { jsonrpc: "2.0", id: "r2", result: { state: "failed", text: "这张卡不能这样做。" } }]);
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

// ---- the card runtime (docs/CARD-RUNTIME.md) ----

const runtimeItem = (card = {}) => ({ id: "m-rt", seq: 4, ts: 1, type: "card", side: "agent",
  card: { type: "a2ui", id: "rt-1", owner: "agent:helper", text: "天气", state: "open", updated_at: 1000, app: "weather", life: "active",
    plan: { root: "root", data: { city: "杭州" }, components: [
      { id: "root", component: "Column", children: ["go", "ask", "copy", "tap"] },
      { id: "go", component: "Button", variant: "primary", child: "go.t", action: { call: { member: "app:weather", word: "refresh", body: { city: "杭州" }, timeout_s: 10 } } },
      { id: "go.t", component: "Text", text: "刷新" },
      { id: "ask", component: "Button", child: "ask.t", action: { ask: { text: "明天呢？" } } },
      { id: "ask.t", component: "Text", text: "问问" },
      { id: "copy", component: "Button", variant: "borderless", child: "copy.t", action: { copy: { text: "杭州 晴 21°" } } },
      { id: "copy.t", component: "Text", text: "复制" },
      { id: "tap", component: "Text", text: "点我", action: { tell: { text: "看过了" } } }] }, ...card } });
const buttonOf = (root, id) => byId(root, id)?.find((n) => n.tag === "button");
const lineOf = (root, id) => byId(root, id)?.find((n) => n.has?.("a2-act-line"));

test("a press the hub runs: what it sends, how long it waits, and why it failed in the owner's words", async () => {
  assert.equal(runtimeKind({ call: { member: "m", word: "w", body: {} } }), "call");
  assert.equal(runtimeKind({ ask: { text: "x" } }), "ask");
  assert.equal(runtimeKind({ tell: { text: "x" } }), "tell");
  assert.equal(runtimeKind({ event: { name: "x" } }), null);
  assert.equal(runtimeKind({ copy: { text: "x" } }), null);
  const data = { a: { b: 1 } };
  const body = actBody("card-1", "go", data);
  assert.deepEqual(body, { card: "card-1", component: "go", data: { a: { b: 1 } } });
  data.a.b = 2;
  assert.equal(body.data.a.b, 1, "the values as they were at the press");
  assert.deepEqual(actBody("card-1", "mini", {}, { ask: { text: "hi" } }), { card: "card-1", component: "mini", data: {}, request: { ask: { text: "hi" } } });
  assert.equal(actTimeoutMs({ call: { member: "m", word: "w", body: {}, timeout_s: 10 } }), 15_000);
  assert.equal(actTimeoutMs({ call: { member: "m", word: "w", body: {} } }), 35_000, "the default: 30 s and 5 more");
  assert.equal(actTimeoutMs({ tell: { text: "x" } }), 35_000);
  assert.equal(actTimeoutMs({ ask: { text: "x" } }), 125_000, "an agent's answer: the hub waits 120 s");
  assert.match(actProblem({ code: "conflict" }), /已经结束/);
  assert.match(actProblem({ code: "offline" }), /没连上/);
  assert.match(actProblem({ code: "result_unknown" }), /没有及时回应/);
  assert.equal(actProblem(new Error("x")), "没做成，可以再按一次。");
  assert.deepEqual(await actOnce(async () => ({ state: "ok", text: "已完成 · 10:42", result: { t: 21 } }), body, 1000), { state: "ok", text: "已完成 · 10:42", result: { t: 21 } });
  assert.deepEqual(await actOnce(async () => { throw Object.assign(new Error("closed"), { code: "conflict" }); }, body, 1000), { state: "failed", text: actProblem({ code: "conflict" }) });
  assert.deepEqual(await actOnce(() => new Promise(() => {}), body, 20), { state: "failed", text: "没有及时回应，可以再按一次。" }, "no answer in time: retryable");
});

test("a button's state: busy while this screen's press is on its way or the hub says it runs (until the wait is over); the newest outcome below it", () => {
  const action = { call: { member: "m", word: "w", body: {}, timeout_s: 10 } };
  const local = { pressing: new Set(), outcomes: {}, copied: {}, runningSince: new Map() };
  const card = (actions) => ({ actions });
  assert.deepEqual(buttonView(card(undefined), local, "go", action, 0), { busy: false, line: null });
  local.pressing.add("go");
  assert.deepEqual(buttonView(card(undefined), local, "go", action, 0), { busy: true, line: null });
  local.pressing.delete("go");
  // Another screen pressed it: the hub says it runs.
  const running = card({ go: { state: "running", text: "处理中…", at: 500 } });
  assert.equal(buttonView(running, local, "go", action, 1000).busy, true);
  assert.equal(buttonView(running, local, "go", action, 1000 + 14_000).busy, true);
  assert.equal(buttonView(running, local, "go", action, 1000 + 15_000).busy, false, "a run never finished stops counting after the wait");
  // This screen's answer, then the hub's own record of it, then a newer press elsewhere.
  local.outcomes.go = { state: "failed", text: "没有及时回应，可以再按一次。", after: 500 };
  assert.deepEqual(buttonView(card({ go: { state: "running", text: "处理中…", at: 500 } }), { ...local, runningSince: new Map() }, "go", action, 0).busy, true);
  assert.deepEqual(buttonView(card({}), local, "go", action, 0).line, { state: "failed", text: "没有及时回应，可以再按一次。" });
  assert.deepEqual(buttonView(card({ go: { state: "ok", text: "已完成 · 10:42", at: 900 } }), local, "go", action, 0).line, { state: "ok", text: "已完成 · 10:42" }, "the hub wrote a newer one");
  local.outcomes.go.after = 900;
  assert.deepEqual(buttonView(card({ go: { state: "ok", text: "已完成 · 10:42", at: 900 } }), local, "go", action, 0).line.state, "failed", "not newer than the answer");
  local.copied.go = { until: 2000, state: "ok", text: "已复制" };
  assert.deepEqual(buttonView(card({}), local, "go", action, 1999), { busy: false, line: { state: "ok", text: "已复制" } });
  assert.notEqual(buttonView(card({}), local, "go", action, 2000).line?.text, "已复制", "gone after a moment");
});

test("pressing a call button: 「处理中…」 and disabled at once, one press at a time, the act with the card's values, the outcome under it, then pressable again", async () => withDom(async () => {
  resetCards();
  let answer;
  const ctx = recorder({ act: (body) => { ctx.calls.push(["act", body]); return new Promise((resolve) => { answer = resolve; }); } });
  let root = renderA2uiCard(new FakeNode("div"), runtimeItem(), ctx);
  const go = buttonOf(root, "go");
  assert.equal(go.disabled, false);
  assert.equal(go.textContent, "刷新");
  assert.equal(lineOf(root, "go"), undefined, "no line before a press");
  go.click();
  assert.equal(buttonOf(root, "go").textContent, "处理中…");
  assert.equal(buttonOf(root, "go").disabled, true);
  await until(() => ctx.calls.some(([k]) => k === "act"));
  buttonOf(root, "go").fire("click");
  await tick();
  assert.equal(ctx.calls.filter(([k]) => k === "act").length, 1, "a press while one runs does nothing");
  assert.deepEqual(ctx.calls.find(([k]) => k === "act")[1], { card: "rt-1", component: "go", data: { city: "杭州" } });
  assert.equal(ctx.calls.some(([k]) => k === "say"), false, "not a say");
  answer({ state: "ok", text: "已完成 · 10:42" });
  await until(() => !buttonOf(root, "go").disabled);
  assert.equal(buttonOf(root, "go").textContent, "刷新");
  assert.equal(lineOf(root, "go").textContent, "已完成 · 10:42");
  assert.equal(lineOf(root, "go").has("failed"), false);
  // A failure says why, in red-ish text, and the button can be pressed again.
  buttonOf(root, "go").click();
  await until(() => ctx.calls.filter(([k]) => k === "act").length === 2);
  answer({ state: "failed", text: "这张卡的应用没有被批准做这件事，安装时没给这一项权限。" });
  await until(() => !buttonOf(root, "go").disabled);
  assert.ok(lineOf(root, "go").has("failed"));
  // The hub's card says another screen's press runs: the button waits for it.
  root = renderA2uiCard(new FakeNode("div"), runtimeItem({ updated_at: 2000, actions: { ask: { state: "running", text: "处理中…", at: 1990 } } }), ctx);
  assert.equal(buttonOf(root, "ask").disabled, true);
  assert.equal(buttonOf(root, "ask").textContent, "处理中…");
  // A tap target with a hub action is a press too (tell).
  const ctx2 = recorder({ act: async (body) => { ctx2.calls.push(["act", body]); return { state: "ok", text: "已转告" }; } });
  const tapRoot = renderA2uiCard(new FakeNode("div"), runtimeItem({ id: "rt-2" }), ctx2);
  byId(tapRoot, "tap").fire("click");
  await until(() => ctx2.calls.some(([k]) => k === "act"));
  assert.deepEqual(ctx2.calls.find(([k]) => k === "act")[1], { card: "rt-2", component: "tap", data: { city: "杭州" } });
}));

test("copy puts the text on this device's clipboard, sends nothing, and says 「已复制」 under the button for a moment", async () => withDom(async () => {
  resetCards();
  const copied = [];
  const ctx = recorder({ copy: async (text) => { copied.push(text); }, act: async () => { throw new Error("not this"); } });
  const root = renderA2uiCard(new FakeNode("div"), runtimeItem({ id: "rt-copy" }), ctx);
  buttonOf(root, "copy").click();
  await until(() => lineOf(root, "copy"));
  assert.deepEqual(copied, ["杭州 晴 21°"]);
  assert.equal(lineOf(root, "copy").textContent, "已复制");
  assert.deepEqual(ctx.calls.filter(([k]) => k !== "draft"), [], "nothing sent");
  await until(() => !lineOf(root, "copy"), COPIED_MS + 500, "the line goes");
}));

test("the card's live line: when its data came, that it sleeps with the time of its data; only on a card with an app", () => {
  const at = new Date(2026, 9, 15, 9, 5).getTime();
  assert.equal(liveLine({ app: "weather", life: "active", fed_at: at }), "09:05 更新");
  assert.equal(liveLine({ temporary_app: true, life: "active" }), "", "the line keeps its place before data comes");
  assert.equal(liveLine({ app: "weather", life: "dormant", fed_at: at, updated_at: 1 }), "已休眠 · 09:05 的数据");
  assert.equal(liveLine({ app: "weather", life: "dormant", updated_at: at }), "已休眠 · 09:05 的数据", "no live data yet: the card's own time");
  assert.equal(liveLine({ app: "weather", life: "closed", fed_at: at }), null);
  assert.equal(liveLine({ app: "weather", state: "closed", life: "active", fed_at: at }), null);
  assert.equal(liveLine({ life: "dormant", updated_at: at }), null, "an agent's card without an app holds nothing");
  assert.equal(liveLine({ app: "weather" }), null);
  assert.equal(stateLine({ state: "open", life: "closed" }), "已结束", "a closed card is read-only");
});

test("the footer: the live line, 「存成应用」 for a temporary app (gone once kept), the thumbs as line icons; a dormant card still draws its data", async () => withDom(async () => {
  resetCards();
  const at = new Date(2026, 9, 15, 14, 30).getTime();
  const ctx = recorder({ keep: async (id) => { ctx.calls.push(["keep", id]); return { kept: true }; } });
  const root = renderA2uiCard(new FakeNode("div"), runtimeItem({ id: "rt-life", life: "dormant", fed_at: at, temporary_app: true }), ctx);
  const bar = byClass(root, "a2-feedback");
  assert.equal(byClass(bar, "a2-live").textContent, "已休眠 · 14:30 的数据");
  assert.equal(buttonOf(root, "go").textContent, "刷新", "the data is still drawn");
  assert.equal(thumbs(root).length, 2);
  assert.ok(bar.find((n) => n.has?.("a2-pin")), "「常驻」 for an app's card");
  const keep = bar.find((n) => n.tag === "button" && n.textContent === "存成应用");
  keep.click();
  await until(() => ctx.calls.some(([k]) => k === "keep"));
  assert.deepEqual(ctx.calls.find(([k]) => k === "keep"), ["keep", "rt-life"]);
  await until(() => !byClass(root, "a2-feedback").find((n) => n.tag === "button" && n.textContent === "存成应用"));
  // An app's card (not an agent's): the live line alone, no thumbs.
  const app = renderA2uiCard(new FakeNode("div"), runtimeItem({ id: "rt-app", owner: "app:weather", life: "active", fed_at: at }), ctx);
  assert.equal(byClass(app, "a2-live").textContent, "14:30 更新");
  assert.equal(thumbs(app).length, 0);
  // A closed card: read-only, no live line, nothing to keep.
  const closed = renderA2uiCard(new FakeNode("div"), runtimeItem({ id: "rt-closed", life: "closed", temporary_app: true, fed_at: at }), ctx);
  assert.equal(byClass(closed, "a2-status").textContent, "已结束");
  assert.equal(buttonOf(closed, "go").disabled, true);
  assert.equal(byClass(closed, "a2-live"), undefined);
  assert.equal(closed.find((n) => n.tag === "button" && n.textContent === "存成应用"), undefined);
}));

test("a pushed card replaces the card's state and is patched in place, even while the focus is on one of its buttons", () => withDom(() => {
  resetCards();
  const ctx = recorder();
  const root = renderA2uiCard(new FakeNode("div"), runtimeItem({ id: "rt-patch" }), ctx);
  assert.equal(patchA2uiCard({ id: "nobody", plan: {} }), false);
  const go = buttonOf(root, "go");
  go.focus();
  const next = { ...runtimeItem({ id: "rt-patch" }).card, updated_at: 3000, fed_at: 2999, plan: { ...runtimeItem().card.plan, data: { city: "上海" } },
    actions: { go: { state: "ok", text: "已完成 · 10:42", at: 2990 } } };
  assert.equal(patchA2uiCard(next), true);
  assert.equal(cardState("rt-patch").item.card.fed_at, 2999, "the hub's card");
  assert.deepEqual(cardState("rt-patch").data, { city: "上海" }, "no field of it is being edited: the working copy follows the hub");
  assert.equal(cardState("rt-patch").ui.root, root, "the same card on screen");
  assert.equal(buttonOf(root, "go"), go, "the same button, still focused");
  assert.equal(globalThis.document.activeElement, go);
  assert.equal(lineOf(root, "go").textContent, "已完成 · 10:42", "its line drawn in place");
}));

test("the timeline takes a pushed card into every item showing it and redraws only those rows", async () => {
  const { ConversationTimeline } = await import("../js/conversation-timeline.js");
  const changes = [];
  const timeline = new ConversationTimeline({ binding: () => ({}), same: () => true }, (view, conversation, dirty) => changes.push(dirty));
  const card = { type: "a2ui", id: "c-9", owner: "agent:main", state: "open", updated_at: 1, plan: { root: "r", components: [{ id: "r", component: "Text", text: "a" }] } };
  timeline.acceptPage({ dataset_id: "d", snapshot_seq: 10, items: [{ id: "m1", seq: 1, ts: 1, type: "say", side: "agent", text: "hi" },
    { id: "m2", seq: 2, ts: 2, type: "card", side: "agent", card, byte_size: 10 }], has_more_before: false, has_more_after: false });
  changes.length = 0;
  const dirty = timeline.patchCard({ ...card, updated_at: 5, life: "dormant" });
  assert.deepEqual([...dirty], ["m2"]);
  assert.deepEqual(changes.map((d) => [...d]), [["m2"]]);
  assert.equal(timeline.get("m2").card.life, "dormant");
  assert.equal(timeline.get("m2").card.type, "a2ui");
  assert.equal(timeline.get("m1").text, "hi");
  assert.deepEqual([...timeline.patchCard({ id: "elsewhere" })], [], "a card not loaded here changes nothing");
});

test("the page answers a pushed card.patch and hands the card on; a bad one is refused", async () => {
  const { Net } = await import("../js/net.js");
  const got = [];
  const fake = { onCardPatch: (card) => got.push(card), onPresent: async () => ({ ok: false }) };
  const present = (frame) => Net.prototype.present.call(fake, frame);
  assert.deepEqual(await present({ surface: "chat", op: "card.patch", body: { card: { id: "c-1", type: "a2ui", life: "idle" } } }), { ok: true, data: {} });
  assert.deepEqual(got, [{ id: "c-1", type: "a2ui", life: "idle" }]);
  assert.equal((await present({ surface: "chat", op: "card.patch", body: {} })).ok, false);
  assert.equal((await present({ surface: "chat", op: "card.preview", body: {} })).error.code, "unavailable", "a preview picture is still the phone's");
});

test("the cards on screen are told to the hub after scrolling stops and once a minute, only while the chat is visible", async () => {
  const el = (id, top, bottom) => ({ dataset: { cardId: id }, getBoundingClientRect: () => ({ top, bottom, height: bottom - top }) });
  const log = { getBoundingClientRect: () => ({ top: 100, bottom: 700 }),
    querySelectorAll: () => [el("above", 0, 90), el("a", 50, 150), el("b", 300, 400), el("b", 400, 500), el("below", 710, 900), el("", 200, 300), el("flat", 300, 300)] };
  assert.deepEqual(cardIdsOnScreen(log), ["a", "b"]);
  assert.deepEqual(cardIdsOnScreen(null), []);
  const sent = [];
  let visible = true, ids = ["a", "b"];
  const seen = new SeenReporter({ ids: () => ids, visible: () => visible, send: async (cards) => { sent.push(cards); if (cards.includes("boom")) throw new Error("offline"); }, delay: 20, every: 60 });
  seen.poke(); seen.poke(); seen.poke();
  await tick(40);
  assert.deepEqual(sent, [["a", "b"]], "one report after the scrolling stopped");
  seen.start();
  await until(() => sent.length >= 2, 1000, "the regular report");
  visible = false;
  const before = sent.length;
  seen.poke();
  await tick(150);
  assert.equal(sent.length, before, "nothing while the chat is hidden");
  visible = true; ids = [];
  seen.report();
  await tick();
  assert.equal(sent.length, before, "never an empty list");
  ids = ["boom"];
  seen.report();
  await tick();
  assert.deepEqual(sent.at(-1), ["boom"], "a failure is ignored");
  seen.dispose();
});

test("table cells are the card's Markdown, not raw marks", () => withDom(() => {
  resetCards();
  const item = { id: "m", type: "card", card: { type: "a2ui", id: "tbl", owner: "agent:main", state: "open", updated_at: 1, plan: { root: "root", components: [
    { id: "root", component: "Table", header: ["**城市**", "天气"], rows: [["**杭州**", "晴 `21°`"], ["上海", "多云\n有风"]] }] } } };
  const root = renderA2uiCard(new FakeNode("div"), item, recorder());
  const cells = root.findAll((n) => n.tag === "td" || n.tag === "th");
  assert.equal(cells[0].find((n) => n.tag === "b")?.textContent, "城市");
  assert.equal(cells[2].find((n) => n.tag === "b")?.textContent, "杭州");
  assert.equal(cells[3].find((n) => n.tag === "code")?.textContent, "21°");
  assert.ok(cells.every((c) => !c.textContent.includes("**")), "no raw asterisks");
  assert.ok(cells[5].find((n) => n.tag === "br"), "lines kept");
}));

test("the mini app's ash.call / ash.ask / ash.tell are presses of its card, answered into the frame, at most two a second", async () => withDom(async () => {
  resetCards();
  const doc = miniAppDocument("<p>x</p>", { scheme: "light" }, null, { token: "abc", full: true });
  for (const part of ["send:function", "a.call=function", "a.ask=function", "a.tell=function", 'g="abc"', 'jsonrpc:"2.0"']) assert.ok(doc.includes(part), part);
  assert.deepEqual(miniAppRequest({ call: { member: "app:weather", word: "now", body: { city: "杭州" } } }), { call: { member: "app:weather", word: "now", body: { city: "杭州" } } });
  assert.deepEqual(miniAppRequest({ call: { member: "app:weather", word: "now" } }), { call: { member: "app:weather", word: "now", body: {} } });
  assert.deepEqual(miniAppRequest({ ask: { text: "明天呢" } }), { ask: { text: "明天呢" } });
  assert.equal(miniAppRequest({ tell: { text: " " } }), null);
  assert.equal(miniAppRequest({ call: { member: "", word: "x" } }), null);
  assert.equal(miniAppRequest({ call: { member: "m", word: "w", body: { big: "x".repeat(17 * 1024) } } }), null);
  const ctx = recorder({ act: async (body) => { ctx.calls.push(["act", body]); return { state: "ok", text: "已完成", result: { t: 21 } }; } });
  const item = { id: "m", type: "card", card: { type: "a2ui", id: "mini-rt", owner: "agent:main", app: "weather", state: "open", updated_at: 1,
    plan: { root: "root", data: { k: 1 }, components: [{ id: "root", component: "Html", html: "<b>x</b>", height: 100 }] } } };
  const root = renderA2uiCard(new FakeNode("div"), item, ctx);
  assert.equal(root.find((n) => n.tag === "button" && n.textContent === "存成应用"), undefined, "a card of an app is saved through its footer, not the old way");
  const frame = root.find((n) => n.tag === "iframe");
  assert.ok(frame.srcdoc.includes("a.call=function"), "a card of an app has call / ask / tell");
  const posted = [];
  frame.contentWindow = { postMessage: (message, origin) => posted.push([message, origin]) };
  const token = frameToken(frame);
  assert.equal(frameMessage(rpc(frame, { id: "r1", method: "ash/call", params: { member: "app:weather", word: "now", body: { city: "杭州" } } })), true);
  await until(() => posted.length === 1);
  assert.deepEqual(ctx.calls.find(([k]) => k === "act")[1], { card: "mini-rt", component: "root", data: { k: 1 }, request: { call: { member: "app:weather", word: "now", body: { city: "杭州" } } } });
  assert.deepEqual(posted[0], [{ g: token, m: JSON.stringify({ jsonrpc: "2.0", id: "r1", result: { state: "ok", text: "已完成", result: { t: 21 } } }) }, "*"]);
  assert.equal(frameMessage(rpc(frame, { id: "r2", method: "ash/ask", params: { text: "明天呢" } })), true);
  assert.equal(frameMessage(rpc(frame, { id: "r3", method: "ash/tell", params: { text: "好" } })), true);
  await until(() => posted.length === 3);
  assert.deepEqual(posted.map(([m]) => JSON.parse(m.m)).find((m) => m.id === "r3").result, { state: "failed", text: "太快了，稍后再试。" }, "a third in the same second is refused");
  assert.equal(ctx.calls.filter(([k]) => k === "act").length, 2);
  assert.equal(frameMessage(rpc(frame, { id: "r4", method: "ash/call", params: { nothing: true } })), false);
  await until(() => posted.length === 4);
  assert.equal(JSON.parse(posted.at(-1)[0].m).result.state, "failed", "a request it cannot read is answered too");
  assert.equal(frameMessage({ ...rpc(frame, { id: "r5", method: "ash/ask", params: { text: "x" } }), source: { other: true } }), false, "only its own frame");
}));

test("「常驻」 on an app's card: drawn from the start, set at once through service:cards/pin, put back with a short line when refused", async () => withDom(async () => {
  resetCards();
  const at = new Date(2026, 9, 15, 8, 0).getTime();
  assert.equal(pinnable({ app: "weather", life: "active", state: "open" }), true);
  assert.equal(pinnable({ app: "weather", life: "closed" }), false);
  assert.equal(pinnable({ owner: "agent:main", life: "active" }), false, "an agent's card without an app holds nothing to keep");
  assert.equal(liveLine({ app: "weather", life: "active", pinned: true, fed_at: at }), "常驻中");
  assert.equal(liveLine({ app: "weather", life: "dormant", pinned: true, fed_at: at }), "已休眠 · 08:00 的数据");
  let refuse = false;
  const ctx = recorder({ pin: async (id, pinned) => { ctx.calls.push(["pin", id, pinned]); if (refuse) throw Object.assign(new Error("no"), { code: "offline" }); return { pinned }; } });
  const root = renderA2uiCard(new FakeNode("div"), runtimeItem({ id: "rt-pin", fed_at: at }), ctx);
  const pin = () => byClass(root, "a2-pin");
  const live = () => byClass(root, "a2-live");
  assert.equal(pin().attributes.role, "switch");
  assert.equal(pin().attributes["aria-checked"], "false");
  assert.equal(pin().textContent, "常驻");
  assert.equal(live().textContent, "08:00 更新");
  pin().click();
  assert.equal(pin().attributes["aria-checked"], "true", "on at once");
  assert.equal(live().textContent, "常驻中");
  await until(() => ctx.calls.some(([k]) => k === "pin"));
  assert.deepEqual(ctx.calls.find(([k]) => k === "pin"), ["pin", "rt-pin", true]);
  await until(() => !pin().disabled);
  // The hub's card agrees; then turning it off is refused: it goes back, with a short line.
  patchA2uiCard({ ...runtimeItem({ id: "rt-pin", fed_at: at }).card, pinned: true, updated_at: 1001 });
  assert.equal(cardState("rt-pin").pinned, undefined, "the hub's card says the same now");
  renderA2uiCard(new FakeNode("div"), runtimeItem({ id: "rt-pin", fed_at: at, pinned: true, updated_at: 1001 }), ctx);
  const again = cardState("rt-pin").ui.root;
  refuse = true;
  byClass(again, "a2-pin").click();
  assert.equal(byClass(again, "a2-pin").attributes["aria-checked"], "false");
  await until(() => byClass(again, "a2-pin").attributes["aria-checked"] === "true" && !byClass(again, "a2-pin").disabled);
  assert.equal(byClass(again, "a2-live").textContent, "没关掉常驻，请再试一次");
  assert.ok(byClass(again, "a2-live").has("failed"));
  assert.deepEqual(ctx.calls.filter(([k]) => k === "pin").map(([, , on]) => on), [true, false]);
  // A closed card, or an agent's card without an app: no switch.
  assert.equal(byClass(renderA2uiCard(new FakeNode("div"), runtimeItem({ id: "rt-pin-closed", life: "closed" }), ctx), "a2-pin"), undefined);
  assert.equal(byClass(renderA2uiCard(new FakeNode("div"), runtimeItem({ id: "rt-pin-agent", app: undefined, life: "active" }), ctx), "a2-pin"), undefined);
}));

// ---- patched in place, component by component (spec: card surface §1; MOBILE-ARCH §12.6, §2.3, §3.3, §2.5) ----

/** A card of an app with live data: a temperature, a field, a row, a picture, a press, a mini app. */
const liveCard = ({ updated_at = 1, temp = "21°", data = { name: "" }, actions, html = "<p>mini</p>", ...rest } = {}) => ({
  id: "m-live", seq: 5, ts: 1, type: "card", side: "agent",
  card: { type: "a2ui", id: "live-1", owner: "agent:main", app: "weather", state: "open", life: "active", updated_at, ...(actions ? { actions } : {}), ...rest,
    plan: { root: "root", data, components: [
      { id: "root", component: "Column", children: ["temp", "name", "row", "img", "go", "html"] },
      { id: "temp", component: "Text", text: temp },
      { id: "name", component: "TextField", label: "名字", bind: "/name", text: "" },
      { id: "row", component: "Row", children: ["a", "b"] }, { id: "a", component: "Badge", text: "晴" }, { id: "b", component: "Text", text: "杭州" },
      { id: "img", component: "Image", url: "https://example.com/a.png" },
      { id: "go", component: "Button", child: "go.t", action: { call: { member: "app:weather", word: "refresh", body: {} } } }, { id: "go.t", component: "Text", text: "刷新" },
      { id: "html", component: "Html", html, height: 80 }] } } });
/** [input]'s value with every write counted. */
function spyValue(input) {
  let value = input.value, writes = 0;
  Object.defineProperty(input, "value", { get: () => value, set: (v) => { writes++; value = v; }, configurable: true });
  return { writes: () => writes };
}
const outside = (root, inside) => root.all().filter((n) => !inside.contains(n) || n === inside);

test("a patch that changes only a Text changes only that Text: every other element is the same instance, the field being typed in too", () => withDom(() => {
  resetCards();
  const ctx = recorder();
  const root = renderA2uiCard(new FakeNode("div"), liveCard(), ctx);
  const name = control(root, "name");
  name.focus(); name.value = "小"; name.fire("input");
  const temp = byId(root, "temp");
  const before = outside(root, temp);
  const frame = root.find((n) => n.tag === "iframe"), doc = frame.srcdoc;
  const next = liveCard({ updated_at: 2, temp: "22°" });
  assert.equal(patchA2uiCard(next.card), true, "the hub's push");
  assert.equal(updateA2uiCard(root, next, ctx), true, "and the timeline's redraw of the row: a patch too");
  assert.equal(byId(root, "temp"), temp);
  assert.equal(temp.textContent, "22°");
  const after = outside(root, temp);
  assert.equal(after.length, before.length);
  after.forEach((n, i) => assert.equal(n, before[i], `element ${i} (${n.tag}.${n.className}) is the one drawn before`));
  assert.equal(control(root, "name"), name);
  assert.equal(name.value, "小");
  assert.equal(globalThis.document.activeElement, name);
  assert.equal(frame.srcdoc, doc, "the mini app is not loaded again");
  assert.equal(updateA2uiCard(new FakeNode("div"), next, ctx), false, "a root this card is not drawn in is drawn anew");
}));

test("a patch while a field is focused, composing or selected leaves its text, caret and composition alone; the hub's value comes in when the editing ends unless the owner changed it", async () => withDom(async () => {
  resetCards();
  const ctx = recorder();
  const root = renderA2uiCard(new FakeNode("div"), liveCard(), ctx);
  const name = control(root, "name");
  const spy = spyValue(name);
  const blur = () => { globalThis.document.activeElement = null; name.fire("blur"); };
  // Focused, with a caret: nothing is written into it; the rest of the card follows.
  name.focus(); name.selectionStart = name.selectionEnd = 0;
  patchA2uiCard(liveCard({ updated_at: 2, temp: "22°", data: { name: "hub-1" } }).card);
  assert.equal(spy.writes(), 0, "never set while focused");
  assert.deepEqual([name.value, name.selectionStart, name.selectionEnd], ["", 0, 0]);
  assert.equal(byId(root, "temp").textContent, "22°");
  assert.deepEqual(cardState("live-1").data, { name: "" }, "the hub's value waits beside the field");
  assert.deepEqual(cardState("live-1").held.get("name"), { path: "/name", value: "hub-1", local: "" });
  blur(); await tick(5);
  assert.equal(name.value, "hub-1", "the owner left it unchanged: the hub's value comes in");
  assert.deepEqual(cardState("live-1").data, { name: "hub-1" });
  // Composing with an IME (no focus needed to count): the composing text stays.
  name.fire("compositionstart");
  const writes = spy.writes();
  patchA2uiCard(liveCard({ updated_at: 3, data: { name: "hub-2" } }).card);
  assert.equal(spy.writes(), writes, "never set while composing");
  assert.equal(name.value, "hub-1");
  name.fire("compositionend"); await tick(5);
  assert.equal(name.value, "hub-2");
  // A selection in it.
  let range = true;
  globalThis.document.getSelection = () => ({ rangeCount: 1, isCollapsed: !range, containsNode: (n) => n === name });
  patchA2uiCard(liveCard({ updated_at: 4, data: { name: "hub-3" } }).card);
  assert.equal(name.value, "hub-2", "never set while selected");
  range = false; name.fire("blur"); await tick(5);
  assert.equal(name.value, "hub-3");
  // The owner types while the hub's value waits: the owner's value wins and goes with the next draft.
  name.focus();
  patchA2uiCard(liveCard({ updated_at: 5, data: { name: "hub-4" } }).card);
  name.value = "mine"; name.fire("input");
  blur(); await tick(5);
  assert.equal(name.value, "mine");
  assert.deepEqual(cardState("live-1").data, { name: "mine" });
  await until(() => ctx.calls.some(([k]) => k === "draft"));
  assert.deepEqual(ctx.calls.filter(([k]) => k === "draft").at(-1).slice(1), ["live-1", { name: "mine" }]);
  assert.equal(control(root, "name"), name, "one input instance all along");
}));

test("text the owner is selecting is not redrawn under the selection; it follows once the selection ends", async () => withDom(async () => {
  resetCards();
  const listeners = {};
  globalThis.document.addEventListener = (type, fn) => { (listeners[type] ??= []).push(fn); };
  const root = renderA2uiCard(new FakeNode("div"), liveCard(), recorder());
  const temp = byId(root, "temp"), inner = temp.children[0];
  let range = true;
  globalThis.document.getSelection = () => ({ rangeCount: 1, isCollapsed: !range, containsNode: (n) => temp.contains(n) || n.contains(temp) });
  patchA2uiCard(liveCard({ updated_at: 2, temp: "22°" }).card);
  assert.equal(temp.children[0], inner, "the selected text's nodes stay");
  assert.equal(temp.textContent, "21°");
  range = false;
  for (const fn of listeners.selectionchange ?? []) fn();
  await tick(5);
  assert.equal(temp.textContent, "22°");
}));

test("a button's state from the hub changes that button and its line only", () => withDom(() => {
  resetCards();
  const root = renderA2uiCard(new FakeNode("div"), runtimeItem({ id: "rt-only" }), recorder());
  const before = root.all();
  patchA2uiCard({ ...runtimeItem({ id: "rt-only" }).card, updated_at: 1001, actions: { go: { state: "ok", text: "已完成 · 10:42", at: 1000 } } });
  const after = root.all();
  assert.deepEqual(before.filter((n) => !after.includes(n)), [], "nothing taken away");
  assert.deepEqual(after.filter((n) => !before.includes(n)), [lineOf(root, "go")], "one line added, under 「刷新」");
  assert.equal(lineOf(root, "go").textContent, "已完成 · 10:42");
  // Another screen's press runs: 「问问」 waits, its label kept aside (the same instance comes back), nothing else moves.
  const label = byId(root, "ask.t"), others = root.all().filter((n) => !byId(root, "ask").contains(n));
  patchA2uiCard({ ...runtimeItem({ id: "rt-only" }).card, updated_at: 1002, actions: { go: { state: "ok", text: "已完成 · 10:42", at: 1000 }, ask: { state: "running", at: 1001 } } });
  assert.equal(buttonOf(root, "ask").textContent, "处理中…");
  assert.equal(buttonOf(root, "ask").disabled, true);
  assert.ok(others.every((n) => root.contains(n)), "every other element stays");
  patchA2uiCard({ ...runtimeItem({ id: "rt-only" }).card, updated_at: 1003, actions: { go: { state: "ok", text: "已完成 · 10:42", at: 1000 }, ask: { state: "ok", text: "答了", at: 1002 } } });
  assert.equal(byId(root, "ask.t"), label, "the same label back in the button");
  assert.equal(lineOf(root, "ask").textContent, "答了");
}));

test("an image's box has its final size before the picture loads, and keeps it when the picture changes", () => withDom(() => {
  resetCards();
  const card = (url = "https://example.com/a.png") => ({ id: "m-img", type: "card", card: { type: "a2ui", id: "img-1", owner: "agent:main", state: "open", updated_at: url.length,
    plan: { root: "root", components: [{ id: "root", component: "Column", children: ["plain", "wide", "header", "sized", "bad"] }, { id: "bad", component: "Image", url: "http://example.com/plain-http.png" },
      { id: "plain", component: "Image", url },
      { id: "wide", component: "Image", url, style: { width: 120 } },
      { id: "header", component: "Image", url, variant: "header" },
      { id: "sized", component: "Image", url, style: { width: 40, height: 30 } }] } } });
  const root = renderA2uiCard(new FakeNode("div"), card(), recorder());
  const plain = byId(root, "plain");
  assert.equal(byId(root, "bad"), undefined, "a picture it may not load is left out");
  assert.deepEqual([plain.style.aspectRatio, plain.style.width], ["16 / 9", "100%"], "no size given: 16:9 of the row's width");
  assert.deepEqual([byId(root, "wide").style.aspectRatio, byId(root, "wide").style.width], ["16 / 9", "120px"]);
  assert.equal(byId(root, "header").style.aspectRatio, undefined, "the variant's own box (160 high)");
  assert.deepEqual([byId(root, "sized").style.width, byId(root, "sized").style.height, byId(root, "sized").style.aspectRatio], ["40px", "30px", undefined]);
  const style = { ...plain.style };
  plain.fire("load"); plain.fire("error");
  assert.deepEqual({ ...plain.style }, style, "a load or a failure does not touch the box");
  patchA2uiCard(card("https://example.com/b-longer.png").card);
  assert.equal(byId(root, "plain"), plain, "the same box");
  assert.equal(plain.src, "https://example.com/b-longer.png");
  assert.deepEqual({ ...plain.style }, style);
}));

test("the mini app is loaded again only when its html changes; a message of an older load, or one that is no load's, is refused", () => withDom(() => {
  resetCards();
  const ctx = recorder();
  const root = renderA2uiCard(new FakeNode("div"), liveCard(), ctx);
  const frame = root.find((n) => n.tag === "iframe");
  frame.contentWindow = { postMessage() {} };
  const first = frameToken(frame), doc = frame.srcdoc;
  patchA2uiCard(liveCard({ updated_at: 2, temp: "22°", data: { name: "x" }, actions: { go: { state: "ok", text: "好", at: 1 } } }).card);
  assert.equal(frame.srcdoc, doc, "a data patch never reloads it");
  patchA2uiCard(liveCard({ updated_at: 3, html: "<p>mini 2</p>" }).card);
  assert.equal(root.find((n) => n.tag === "iframe"), frame, "the same frame");
  const second = frameToken(frame);
  assert.ok(frame.srcdoc.includes("mini 2") && second && second !== first, "its new html, under a new token");
  const send = { method: "ash/send", params: { action: "go" } };
  assert.equal(frameMessage(rpc(frame, send, first)), false, "the older load is no one now");
  assert.equal(frameMessage({ source: frame.contentWindow, data: { ash: "send", action: "go" } }), false, "a stray message without the load's token");
  assert.equal(frameMessage(rpc(frame, send, second)), true);
  // The frame went somewhere else (its own navigation): its document comes back under a new token.
  frame.fire("load");
  assert.equal(frameToken(frame), second, "its own load");
  frame.fire("load");
  assert.notEqual(frameToken(frame), second, "a second load is a navigation: loaded again, a new token");
  assert.equal(frameMessage(rpc(frame, send, second)), false);
}));

test("a mini app's message: at most 64 KB, JSON-RPC 2.0 with a known method and its params' schema, call / ask / tell only on a card of an app, identity never from the message", async () => withDom(async () => {
  resetCards();
  const at = { token: "t1", full: true };
  const wire = (message, g = "t1") => ({ g, m: typeof message === "string" ? message : JSON.stringify(message) });
  const ok = { jsonrpc: "2.0", id: "r1", method: "ash/call", params: { member: "app:weather", word: "now", body: { city: "杭州" } } };
  assert.deepEqual(miniAppRpc(wire(ok), at), { method: "ash/call", id: "r1", params: { call: { member: "app:weather", word: "now", body: { city: "杭州" } } } });
  assert.equal(miniAppRpc(wire(ok, "t0"), at).refused, "stranger", "another load's token");
  assert.equal(miniAppRpc({ ...wire(ok), card: "other" }, at).refused, "stranger", "nothing beside the token and the message");
  assert.equal(miniAppRpc({ ash: "act", id: "r1", request: { call: ok.params } }, at).refused, "stranger", "the old unchecked shape");
  const big = { ...ok, params: { ...ok.params, body: { pad: "x".repeat(MINI_APP_MAX_BYTES) } } };
  assert.equal(miniAppRpc(wire(big), at).refused, "size");
  assert.equal(miniAppRpc(wire(JSON.stringify(ok).padEnd(MINI_APP_MAX_BYTES + 1)), at).refused, "size");
  assert.equal(miniAppRpc(wire("{not json"), at).refused, "schema");
  assert.equal(miniAppRpc(wire({ ...ok, jsonrpc: "1.0" }), at).refused, "schema");
  assert.equal(miniAppRpc(wire({ ...ok, extra: 1 }), at).refused, "schema");
  assert.equal(miniAppRpc(wire({ ...ok, id: "bad id!" }), at).refused, "schema");
  assert.deepEqual(miniAppRpc(wire({ ...ok, method: "ash/open" }), at), { refused: "schema", id: "r1" });
  assert.deepEqual(miniAppRpc(wire({ ...ok, params: { ...ok.params, card: "other-card" } }), at), { refused: "schema", id: "r1" }, "params carry no identity");
  assert.equal(miniAppRpc(wire({ ...ok, params: { member: "app:weather", word: "now", body: [1] } }), at).refused, "schema");
  assert.equal(miniAppRpc(wire({ ...ok, id: undefined }), at).refused, "schema", "a press needs an id to be answered");
  assert.equal(miniAppRpc(wire({ jsonrpc: "2.0", id: 1, method: "ash/ask", params: { text: "明天呢", app: "evil" } }), at).refused, "schema");
  assert.deepEqual(miniAppRpc(wire({ jsonrpc: "2.0", method: "ash/send", params: { action: "go", context: { n: 1 } } }), at), { method: "ash/send", id: undefined, params: { name: "go", context: { n: 1 } } });
  assert.equal(miniAppRpc(wire({ jsonrpc: "2.0", method: "ash/send", params: { action: "go", context: [1] } }), at).refused, "schema");
  assert.deepEqual(miniAppRpc(wire(ok), { token: "t1", full: false }), { refused: "forbidden", id: "r1" }, "a card without an app: ash.send alone");
  assert.equal(miniAppRpc(wire(ok, ""), { token: "", full: true }).refused, "stranger", "a frame not loaded (or gone) takes nothing");
  // Who presses is the card and component the frame was made for, whatever the message carries in its body.
  const ctx = recorder({ act: async (body) => { ctx.calls.push(["act", body]); return { state: "ok", text: "好" }; } });
  const root = renderA2uiCard(new FakeNode("div"), liveCard(), ctx);
  const frame = root.find((n) => n.tag === "iframe");
  frame.contentWindow = { postMessage() {} };
  assert.equal(frameMessage(rpc(frame, { id: "r9", method: "ash/call", params: { member: "app:weather", word: "now", body: { card: "other-card", component: "x", app: "evil" } } })), true);
  await until(() => ctx.calls.some(([k]) => k === "act"));
  const sent = ctx.calls.find(([k]) => k === "act")[1];
  assert.deepEqual([sent.card, sent.component], ["live-1", "html"]);
  assert.deepEqual(sent.request.call.body, { card: "other-card", component: "x", app: "evil" }, "just data for the word");
}));
