import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CardError, formatDate, levels, setPointer, validateCard, type WidgetComponent } from "../../src/members/widgets-card";
import { cases } from "../fixtures/widget-cards.cases.mjs";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/widget-cards.json"), "utf8")) as {
  cases: { name: string; expect: string; error?: string; levels?: number; result: string; rendered?: unknown }[];
};
const outcome = (a2ui: unknown): string => { try { validateCard(a2ui); return "ok"; } catch (e) { if (e instanceof CardError) return e.message; throw e; } };
const byId = (a2ui: unknown) => new Map(validateCard(a2ui).components.map((c) => [c.id, c] as [string, WidgetComponent]));

test("the shared card cases (also drawn by the phone's tests) are current", () => {
  assert.equal(fixture.cases.length, cases.length, "run npm run gen:widget-cards");
  for (const [i, c] of (cases as { name: string; a2ui: unknown }[]).entries()) {
    assert.equal(fixture.cases[i].result, outcome(c.a2ui), `${c.name}: run npm run gen:widget-cards`);
    let rendered: unknown;
    try { rendered = validateCard(c.a2ui, { checkLevels: false }); } catch { rendered = undefined; }
    assert.deepEqual(fixture.cases[i].rendered, rendered === undefined ? undefined : JSON.parse(JSON.stringify(rendered)), `${c.name}: run npm run gen:widget-cards`);
  }
});

test("each card case is accepted, or refused naming the component and the reason", () => {
  for (const c of fixture.cases) {
    if (c.expect === "ok") assert.equal(c.result, "ok", c.name);
    else assert.ok(c.result.includes(c.error!), `${c.name}: ${c.result}`);
    if (c.levels !== undefined) {
      const render = c.rendered as ReturnType<typeof validateCard>;
      const map = new Map(render.components.map((x) => [x.id, x]));
      const roots = [render.root, ...(render.sizes ?? []).map((s) => s.root)];
      assert.equal(Math.max(...roots.map((r) => levels(map, r))), c.levels, c.name);
    }
  }
});

test("templates make one copy per item, with relative paths, item keys and two-way bindings", () => {
  const todo = (cases as { name: string; a2ui: unknown }[]).find((c) => c.name.startsWith("a to-do list"))!.a2ui;
  const map = byId(todo);
  assert.equal(map.get("title")!.text, "待办 2 项");
  assert.deepEqual(map.get("list")!.children, ["item@0", "item@1"]);
  const second = map.get("check@1")!;
  assert.equal(second.label, "回邮件");
  assert.equal(second.checked, true);
  assert.equal(second.bind, "/todo/1/done");
  assert.equal(second.item, "mail");
  assert.equal(second.weight, 1);
  assert.deepEqual(map.get("item@0")!.action, { event: { name: "open", context: { id: "milk" } } });
  assert.equal(map.get("del_icon@1")!.item, "mail");
});

test("styles are normalized: colours to #RRGGBBAA, boxes to [top, end, bottom, start]", () => {
  const map = byId({ components: [{ id: "root", component: "Column", children: ["a"], style: { background: "#0008", padding: [4, 8], margin: { top: 2, start: 6 } } },
    { id: "a", component: "Text", text: "x", style: { color: { light: "#123", dark: "white" }, fontWeight: "medium" } }] });
  assert.deepEqual(map.get("root")!.style, { background: "#00000088", padding: [4, 8, 4, 8], margin: [2, 0, 0, 6] });
  assert.deepEqual(map.get("a")!.style, { color: { light: "#112233FF", dark: "white" }, fontWeight: 500 });
});

test("value functions: formatString, formatNumber, pluralize, formatDate, and/or/not, checks disable a button", () => {
  const data = { n: 1234.5, items: 1, when: "2026-10-08T09:05:00", ok: false };
  const map = byId({ data, components: [{ id: "root", component: "Column", children: ["a", "b", "c", "d", "btn"] },
    { id: "a", component: "Text", text: { call: "formatString", args: { value: "共 ${formatNumber(value:${/n}, decimals:1)} 元 \\${x}" } } },
    { id: "b", component: "Text", text: { call: "pluralize", args: { value: { path: "/items" }, one: "1 item", other: "many" } } },
    { id: "c", component: "Text", text: { call: "formatDate", args: { value: { path: "/when" }, format: "MM-dd HH:mm EEE" } } },
    { id: "d", component: "Text", text: "x", visible: { call: "not", args: { value: { path: "/ok" } } } },
    { id: "btn", component: "Button", child: "bl", action: { event: { name: "go" } }, checks: [{ condition: { path: "/ok" }, message: "not yet" }] },
    { id: "bl", component: "Text", text: "Go" }] });
  assert.equal(map.get("a")!.text, "共 1,234.5 元 ${x}");
  assert.equal(map.get("b")!.text, "1 item");
  assert.equal(map.get("c")!.text, "10-08 09:05 Thu");
  assert.equal(map.get("d")!.visible, undefined);
  assert.equal(map.get("btn")!.disabled, true);
  assert.equal(formatDate(new Date(2026, 0, 2, 15, 4, 5), "yyyy/M/d h:mm:ss a 'at' EEEE"), "2026/1/2 3:04:05 PM at Friday");
});

test("actions: event, openUrl to an app surface, openApp, openAsh; unsafe schemes are refused", () => {
  const act = (action: unknown) => byId({ components: [{ id: "root", component: "Text", text: "x", action }] }).get("root")!.action;
  assert.deepEqual(act({ functionCall: { call: "openUrl", args: { url: "ui://todo/home" } } }), { openApp: { app: "todo", surface: "home" } });
  assert.deepEqual(act({ functionCall: { call: "openUrl", args: { url: "ash-app://open?app=health&surface=trends" } } }), { openApp: { app: "health", surface: "trends" } });
  assert.deepEqual(act({ functionCall: { call: "openUrl", args: { url: "https://example.com/x" } } }), { openUrl: { url: "https://example.com/x" } });
  assert.deepEqual(act({ openApp: { app: "health" } }), { openApp: { app: "health" } });
  assert.deepEqual(act({ openAsh: {} }), { openAsh: {} });
  assert.throws(() => act({ functionCall: { call: "openUrl", args: { url: "javascript:alert(1)" } } }), /not opened from a card/);
  assert.throws(() => act({ functionCall: { call: "openUrl", args: { url: "intent://x#Intent;end" } } }), /not opened from a card/);
  assert.throws(() => act({ event: { name: "has space" } }), /letters, digits/);
});

test("embedded images are checked by their header; the size limit is the whole card's", () => {
  const img = (url: string) => () => validateCard({ components: [{ id: "root", component: "Image", url }] });
  assert.throws(img("data:image/png;base64,AAAA"), /not a readable png/);
  assert.throws(img(`data:image/png;base64,${"A".repeat(600_000)}`), /at most 524288 bytes/);
  assert.throws(img("icon:unicorn"), /no built-in icon/);
  assert.throws(img("avatar:angry"), /Ash's faces are/);
  assert.throws(img("https://example.com/a.svg"), /SVG cannot be drawn/);
});

test("setPointer writes a value and creates objects on the way, never prototypes", () => {
  const data: Record<string, unknown> = { todo: [{ done: false }] };
  assert.equal(setPointer(data, "/todo/0/done", true), true);
  assert.equal(setPointer(data, "/a/b", 1), true);
  assert.equal(setPointer(data, "/todo/5/done", true), false);
  assert.equal(setPointer(data, "/__proto__/x", 1), false);
  assert.deepEqual(data, { todo: [{ done: true }], a: { b: 1 } });
});

test("a list template with no items yet is part of the card, not an unreachable component", () => {
  const card = (items: unknown[]) => validateCard({ components: [{ id: "root", component: "List", children: { componentId: "row", path: "/items" } },
    { id: "row", component: "Row", children: ["box"] }, { id: "box", component: "CheckBox", label: { path: "title" }, value: { path: "done" } }], data: { items } });
  assert.deepEqual(card([]).components.map((c) => c.id), ["root"]);
  assert.deepEqual(card([{ id: "a", title: "x", done: true }]).components.map((c) => c.id), ["root", "row@0", "box@0"]);
  assert.throws(() => validateCard({ components: [{ id: "root", component: "Text", text: "a" }, { id: "lost", component: "Text", text: "b" }] }), /not reachable from root: lost/);
});
