import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { APP_SCHEMA, appToolContract, toolEffectRisk, wakeEvents, type AppJson } from "../src/app";
import { compileSchema, effectRiskProblem } from "../src/word";

test("annotations -> effect and risk: the four rules of SPEC-02 §5.3", () => {
  assert.deepEqual(toolEffectRisk({ readOnlyHint: true }), { effect: "read", risk: "none" });
  assert.deepEqual(toolEffectRisk({ destructiveHint: true }), { effect: "write", risk: "structure" });
  assert.deepEqual(toolEffectRisk({ destructiveHint: false }), { effect: "act", risk: "outward" });
  assert.deepEqual(toolEffectRisk({ destructiveHint: false, openWorldHint: true }), { effect: "act", risk: "outward" });
  assert.deepEqual(toolEffectRisk({ destructiveHint: false, openWorldHint: false }), { effect: "write", risk: "none" });
});

test("a tool that says nothing needs approval", () => {
  for (const annotations of [undefined, null, {}, { title: "x" }, { idempotentHint: true }, { openWorldHint: false }, { readOnlyHint: false }]) {
    assert.deepEqual(toolEffectRisk(annotations), { effect: "write", risk: "structure" }, JSON.stringify(annotations));
  }
  // a wrong type is not a safe declaration
  assert.deepEqual(toolEffectRisk({ readOnlyHint: "true" as unknown as boolean }), { effect: "write", risk: "structure" });
  assert.deepEqual(toolEffectRisk({ destructiveHint: "false" as unknown as boolean, openWorldHint: false }), { effect: "write", risk: "structure" });
});

test("several annotations at once: the first rule that matches wins", () => {
  assert.deepEqual(toolEffectRisk({ readOnlyHint: true, destructiveHint: true, openWorldHint: true }), { effect: "read", risk: "none" });
  assert.deepEqual(toolEffectRisk({ readOnlyHint: false, destructiveHint: false, openWorldHint: false }), { effect: "write", risk: "none" });
  assert.deepEqual(toolEffectRisk({ readOnlyHint: false, destructiveHint: true, openWorldHint: false }), { effect: "write", risk: "structure" });
  assert.deepEqual(toolEffectRisk({ destructiveHint: false, openWorldHint: true, idempotentHint: true }), { effect: "act", risk: "outward" });
  for (const hints of [{}, { readOnlyHint: true }, { destructiveHint: false }, { destructiveHint: false, openWorldHint: false }]) {
    const { effect, risk } = toolEffectRisk(hints);
    assert.equal(effectRiskProblem(effect, risk), null);
  }
});

test("an app tool compiles to a word contract", () => {
  const contract = appToolContract("todo", { name: "todo.list", title: "List todos", description: "List the todo items.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } });
  assert.equal(contract.member, "app:todo");
  assert.equal(contract.word, "todo.list");
  assert.deepEqual([contract.effect, contract.risk], ["read", "none"]);
  assert.deepEqual(contract.label, { doing: "在用 List todos" });
  const plain = appToolContract("todo", { name: "todo.add" });
  assert.deepEqual([plain.effect, plain.risk], ["write", "structure"]);
  assert.deepEqual(plain.input_schema, { type: "object" });
});

test("an app tool without a title is labelled by the app's name, never by its raw name", () => {
  assert.deepEqual(appToolContract("todo", { name: "todo.add" }, "待办").label, { doing: "在用 待办 的功能" });
  assert.deepEqual(appToolContract("todo", { name: "todo.add" }).label, { doing: "在处理" }, "no title and no app name");
  assert.deepEqual(appToolContract("todo", { name: "todo.add", title: "todo.add" }, "待办").label, { doing: "在用 待办 的功能" }, "a title that is only the name");
  assert.deepEqual(appToolContract("todo", { name: "todo.add", annotations: { title: "Add an item" } }, "待办").label, { doing: "在用 Add an item" });
  for (const tool of [{ name: "todo.add" }, { name: "get_items", title: "get_items" }]) assert.ok(!/todo\.add|get_items/.test(appToolContract("todo", tool, "待办").label.doing));
});

test("wake_events may name the agent to wake", () => {
  const app = { wake_events: ["notes.due", { event: "message.received", agent: "agent:ash-chat" }, { event: "x.y" }] } as Pick<AppJson, "wake_events">;
  assert.deepEqual(wakeEvents(app), [{ event: "notes.due" }, { event: "message.received", agent: "agent:ash-chat" }, { event: "x.y" }]);
  assert.deepEqual(wakeEvents({}), []);
});

// ---- docs/app.schema.json -----------------------------------------------------------------------------------------------

// A key that is missing here, or not in AppJson, fails to compile: the field list and the type cannot drift apart.
const APP_JSON_FIELDS: Record<keyof AppJson, true> = {
  contract: true, id: true, name: true, version: true, icon: true, summary: true, role: true, publisher: true, server: true, surfaces: true,
  events: true, wake_events: true, listens: true, data_dir: true, cards: true, needs: true,
};
const validateApp = compileSchema({ ...APP_SCHEMA, $schema: undefined });
const BASE: AppJson = { contract: "ash-app/1", id: "demo", name: "Demo", version: "1.0.0", summary: "A demo app.", publisher: "ash", server: { command: "node", args: ["server.mjs"] } };

test("the app schema has exactly the fields of AppJson, and the required ones", () => {
  assert.deepEqual(Object.keys(APP_SCHEMA.properties).sort(), Object.keys(APP_JSON_FIELDS).sort());
  assert.deepEqual([...APP_SCHEMA.required].sort(), ["contract", "id", "name", "publisher", "server", "summary", "version"]);
});

test("docs/app.schema.json is what APP_SCHEMA generates", () => {
  const file = fileURLToPath(new URL("../../../docs/app.schema.json", import.meta.url));
  assert.equal(readFileSync(file, "utf8"), `${JSON.stringify(APP_SCHEMA, null, 2)}\n`, "run npm run gen:app-schema");
});

test("needs.member: a service, one agent, any agent (agent:*), one hand or any (device:*); not a wildcard anywhere else", () => {
  const need = (member: string) => validateApp({ ...BASE, needs: [{ member, words: ["wake"], why: "w" }] });
  for (const good of ["service:llm", "agent:main", "agent:*", "device:*", "device:ABCDEFGHIJKLMNOPQRSTUV", "app:notes"]) assert.equal(need(good), true, good);
  for (const bad of ["agent:", "agent:Main", "agent:m*", "service:*", "app:*", "body:*", "*"]) assert.equal(need(bad), false, bad);
});

test("listens and wake_events as the schema accepts them", () => {
  const good: AppJson = {
    ...BASE, events: ["message.received", "digest.ready"],
    wake_events: ["digest.ready", { event: "message.received", agent: "agent:ash-feishu" }, { event: "digest.ready" }],
    listens: ["sense.location", "sense.*", "calendar.event.created"],
  };
  assert.equal(validateApp(good), true, JSON.stringify(validateApp.errors));
  assert.equal(validateApp(BASE), true);
  const bad = (patch: Record<string, unknown>) => validateApp({ ...BASE, ...patch });
  assert.equal(bad({ listens: ["sense"] }), false, "an event has at least two segments");
  assert.equal(bad({ listens: ["*"] }), false);
  assert.equal(bad({ listens: ["sense.*.x"] }), false, "the wildcard is the last segment only");
  assert.equal(bad({ listens: ["Sense.Location"] }), false);
  assert.equal(bad({ listens: "sense.location" }), false);
  assert.equal(bad({ wake_events: [{ agent: "agent:ash-feishu" }] }), false, "the object form needs the event");
  assert.equal(bad({ wake_events: [{ event: "a.b", agent: "ash-feishu" }] }), false, "the agent is a full id (agent:<name>), not a bare name");
  assert.equal(bad({ wake_events: [{ event: "a.b", agent: "service:x" }] }), false);
  assert.equal(bad({ wake_events: [{ event: "a.b", extra: 1 }] }), false);
  assert.equal(bad({ wake_events: [{ event: "nodot" }] }), false);
});

test("a system app as apps.list shows it passes the word's own result schema", async () => {
  const { wordContract } = await import("../src/words");
  const { systemAppInfo } = await import("../src/app");
  const validate = compileSchema(wordContract("service:apps", "apps.list")!.result_schema!);
  const info = systemAppInfo({ id: "codex", name: "Codex", summary: "电脑上的 Codex", icon: "laptop" });
  assert.ok(validate({ apps: [info] }), JSON.stringify(validate.errors));
  assert.deepEqual([info.kind, info.ui, info.granted, info.enabled], ["system", "native", true, true]);
});
