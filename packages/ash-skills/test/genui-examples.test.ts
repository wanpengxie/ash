import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { formCard } from "../../core/src/edges/link-server/human/form";
import { checkChatCard } from "../../sdk/src/card";

/**
 * The genui skill's examples are what the agent copies: each one is the exact body of a `show` (a2ui) or a `form` (schema)
 * call, and must draw cleanly as it stands: nothing left out (problems) and nothing the design checks would flag (hints).
 */
const dir = join(import.meta.dirname, "../skills/genui/examples");
const examples = readdirSync(dir).filter((file) => file.endsWith(".json")).sort()
  .map((file) => ({ file, body: JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown> }));

test("the genui skill has examples of both kinds", () => {
  assert.ok(examples.some((e) => "a2ui" in e.body), "a show example");
  assert.ok(examples.some((e) => "schema" in e.body), "a form example");
  for (const { file, body } of examples) assert.ok("a2ui" in body !== "schema" in body, `${file}: the body of either show (a2ui) or form (schema)`);
});

test("every show example draws with no problems and no hints", () => {
  for (const { file, body } of examples.filter((e) => "a2ui" in e.body)) {
    assert.ok(typeof body.id === "string" && typeof body.text === "string", `${file}: names the card (id) and says it in one line (text)`);
    const render = checkChatCard(body.a2ui);
    assert.deepEqual(render.problems, [], `${file}: problems`);
    assert.deepEqual(render.hints, [], `${file}: hints`);
  }
});

test("every form example builds a card the conversation draws with no problems", () => {
  for (const { file, body } of examples.filter((e) => "schema" in e.body)) {
    const { a2ui } = formCard(body as Parameters<typeof formCard>[0]);
    assert.deepEqual(checkChatCard(a2ui).problems, [], `${file}: problems`);
  }
});
