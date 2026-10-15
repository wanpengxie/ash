import assert from "node:assert/strict";
import test from "node:test";
import { CardError, checkChatCard, validateCard } from "../src/card";

const card = (components: Record<string, unknown>[], data?: Record<string, unknown>) => ({ components, ...(data ? { data } : {}) });

test("the conversation draws inputs, tables and the mini app; a home-screen widget refuses them", () => {
  const a2ui = card([
    { id: "root", component: "Column", children: ["name", "pw", "when", "n", "t", "app"] },
    { id: "name", component: "TextField", label: "名字", value: { path: "/name" } },
    { id: "pw", component: "TextField", label: "密码", variant: "obscured", value: { path: "/pw" } },
    { id: "when", component: "DateTimeInput", value: "2026-10-15", enableTime: true },
    { id: "n", component: "Slider", min: 1, max: 5, value: { path: "/n" } },
    { id: "t", component: "Table", columns: ["城市", "温度"], rows: [["北京", 12], ["上海", "18"]] },
    { id: "app", component: "Html", html: "<p>hi</p>", height: 200 },
  ], { name: "小王", pw: "never-shown", n: 3 });
  const chat = checkChatCard(a2ui);
  assert.deepEqual(chat.problems, []);
  const by = Object.fromEntries(chat.components.map((c) => [c.id, c]));
  assert.equal(by.name!.text, "小王");
  assert.equal(by.pw!.text, "", "a password box never shows a value");
  assert.equal(by.n!.value, 3);
  assert.deepEqual(by.t!.header, ["城市", "温度"]);
  assert.deepEqual(by.t!.rows, [["北京", "12"], ["上海", "18"]]);
  assert.equal(by.app!.height, 200);
  assert.deepEqual(chat.binds.sort(), ["/n", "/name"], "a password box writes nowhere in data");
  assert.equal(chat.reactive, false, "nothing shown reads what the inputs write");
  assert.throws(() => validateCard(a2ui), CardError);
});

test("leniently: unknown components and fields are left out and reported, a missing child is a placeholder, a broken root is refused", () => {
  const chat = checkChatCard(card([
    { id: "root", component: "Column", children: ["a", "b", "c", "later"] },
    { id: "a", component: "Text", text: "ok", wobble: 1 },
    { id: "b", component: "Blink" },
    { id: "c", component: "Text", text: { path: "/nothing" } },
  ]));
  assert.deepEqual(chat.components.map((c) => c.component), ["Column", "Text", "Skeleton"]);
  assert.equal(chat.problems.length, 4, chat.problems.join("\n"));
  assert.ok(chat.problems.some((p) => p.includes("\"later\"") && p.includes("placeholder")));
  assert.throws(() => checkChatCard(card([{ id: "root", component: "Blink" }])), CardError);
});

test("a card is reactive when something shown reads a path an input writes", () => {
  const chat = checkChatCard(card([
    { id: "root", component: "Column", children: ["s", "t", "go"] },
    { id: "s", component: "Slider", value: { path: "/n" }, max: 10 },
    { id: "t", component: "Text", text: { call: "formatString", args: { value: "${/n} 个" } } },
    { id: "go", component: "Button", child: "go.t", action: { event: { name: "ok" } }, checks: [{ condition: { call: "required", args: { value: { path: "/name" } } }, message: "填名字" }] },
    { id: "go.t", component: "Text", text: "好" },
  ], { n: 4 }));
  assert.equal(chat.reactive, true);
  assert.equal(chat.components.find((c) => c.id === "t")!.text, "4 个");
  assert.equal(chat.components.find((c) => c.id === "go")!.disabled, true, "a failed check greys the button");
});
