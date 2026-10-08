import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { serviceLabel } from "../../../sdk/src/labels";
import { WORD_CONTRACTS, wordContract, wordEffect } from "../../../sdk/src/words";
import { MAIN_RULES } from "../../src/workers/rules.generated";
import { HEARTBEAT_TEMPLATE, PULSE_TEMPLATE } from "../../src/prompts/persona.generated";
// @ts-expect-error plain ESM plugin shipped beside the package
import { apply as applySkills } from "../../../ash-skills/index.mjs";

const root = join(import.meta.dirname, "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

test("the pulse words have contracts and Chinese labels; only the switch and the timer report are owner-facing", () => {
  const words = WORD_CONTRACTS.filter((item) => item.member === "service:pulse");
  assert.deepEqual(words.map((item) => item.word).sort(), ["pulse.due", "pulse.fire", "pulse.get", "pulse.history", "pulse.note", "pulse.set", "pulse.switch"]);
  for (const word of words) {
    assert.ok(word.description.length > 40, `${word.word}: a clear description`);
    assert.match(word.label ?? "", /[一-鿿]/, `${word.word}: a Chinese label`);
    if (word.word !== "pulse.due") assert.match(serviceLabel("service:pulse", word.word) ?? "", /^在/, `${word.word}: a status label`);
  }
  assert.deepEqual(words.filter((item) => item.audience === "owner").map((item) => item.word).sort(), ["pulse.due", "pulse.switch"]);
  assert.equal(wordEffect(wordContract("service:pulse", "pulse.get")!), "read");
  assert.equal(wordEffect(wordContract("service:pulse", "pulse.history")!), "read");
  assert.equal(wordContract("service:pulse", "pulse.set")!.input_schema!.additionalProperties, false);
  assert.deepEqual(wordContract("service:pulse", "pulse.set")!.input_schema!.required, ["reason"]);
  const card = wordContract("service:widgets", "widget.card.get")!;
  assert.equal(wordEffect(card), "read");
  assert.match(card.label!, /[一-鿿]/);
  assert.equal(serviceLabel("service:widgets", "widget.card.get"), "在看桌面卡片的内容");
});

test("the initial PULSE.md guides without prescribing a layout, and names the data to look at first", () => {
  assert.equal(PULSE_TEMPLATE, read("packages/ash-skills/persona/PULSE.template.md"), "run npm run gen:persona");
  assert.equal(HEARTBEAT_TEMPLATE, read("packages/ash-skills/persona/HEARTBEAT.template.md"));
  const bytes = Buffer.byteLength(PULSE_TEMPLATE);
  assert.ok(bytes >= 2000 && bytes <= 4096, `${bytes} bytes`);
  for (const name of ["location.history", "activity.history", "health.read", "health.summary", "apps.usage", "calendar.search", "history_query", "widget.list", "widget.card.get",
    "web_search", "web_fetch", "approval_log", "timer_list", "pulse.note", "pulse.set", "pulse.history", "MEMORY.md", "widget.card.put", "feedback"])
    assert.ok(PULSE_TEMPLATE.includes(name), `PULSE.md names ${name}`);
  assert.match(PULSE_TEMPLATE, /gap/);
  assert.match(PULSE_TEMPLATE, /rollback/);
  assert.match(PULSE_TEMPLATE, /review/);
  // The hard rules are few; layouts, scenes and wording templates are not in it.
  assert.doesNotMatch(PULSE_TEMPLATE, /头条|必须有|固定格式|模板句/);
  assert.match(HEARTBEAT_TEMPLATE, /pulse\.history/);
  assert.match(HEARTBEAT_TEMPLATE, /PULSE\.md/);
  // The heartbeat flow reads a checklist as empty when every line is blank or a heading: this one is not.
  assert.ok(HEARTBEAT_TEMPLATE.split("\n").some((line) => line.trim() && !line.trim().startsWith("#")));
});

test("the two layers: a short introduction in the system prompt names the skill, and the skill is loaded", async () => {
  const intro = read("packages/core/src/prompts/rules/pulse.md").trim();
  const body = intro.split("\n").filter((line) => !line.startsWith("#")).join("\n").trim();
  assert.equal(body.split("\n").length, 1);
  assert.ok((body.match(/[。！？]/g) ?? []).length >= 3 && (body.match(/[。！？]/g) ?? []).length <= 5);
  assert.match(body, /技能 `pulse-widget`/);
  assert.ok(MAIN_RULES.includes(intro), "the introduction is in the generated system prompt: run npm run gen:worker-rules");
  const skill = read("packages/ash-skills/skills/pulse-widget/SKILL.md");
  const meta = /^---\n([\s\S]*?)\n---\n/.exec(skill)![1]!;
  assert.match(meta, /^name: pulse-widget$/m);
  assert.match(meta, /^description: .{10,}$/m);
  assert.match(meta, /^whenToUse: .{10,}$/m);
  assert.ok(Buffer.byteLength(skill) <= 9000);
  for (const heading of ["做法", "好的样子", "常见错误", "怎么核对"]) assert.ok(skill.includes(`## ${heading}`), heading);
  assert.match(skill, /不要照抄/);
  const registered: { name: string }[] = [];
  applySkills({ skills: { registerProvider: (make: () => { list: () => Promise<{ name: string }[]> }) => { void make().list().then((items) => registered.push(...items)); } } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(registered.some((item) => item.name === "pulse-widget"));
});
