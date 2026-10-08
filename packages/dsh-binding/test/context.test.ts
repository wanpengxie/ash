import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { renderMainContext } from "../src/context";

test("main context keeps persona, rules and standing files in design order", () => {
  const context = renderMainContext({ soul: "SOUL_MARKER", identity: "IDENTITY_MARKER", user: "USER_MARKER",
    memory: "MEMORY_MARKER", heartbeat: "HEARTBEAT_MARKER" });
  const positions = ["SOUL_MARKER", "IDENTITY_MARKER", "像在对话里帮一个熟悉的人办事", "USER_MARKER",
    "MEMORY_MARKER", "HEARTBEAT_MARKER"].map((marker) => context.indexOf(marker));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
});

test("main context points at the reminders skill for the calendar grant, and the skill holds the steps", () => {
  const context = renderMainContext({ soul: null, identity: null, user: null, memory: null, heartbeat: null });
  assert.match(context, /看不到 `calendar\.search`/);
  assert.match(context, /不要说已经看过日历/);
  assert.match(context, /技能 `reminders`/);
  const skill = readFileSync(join(import.meta.dirname, "../../ash-skills/skills/reminders/SKILL.md"), "utf8");
  assert.match(skill, /没有这个词/);
  assert.match(skill, /不要声称已经读到了日历/);
  assert.match(skill, /`human_show`/);
  assert.match(skill, /`\{type: "permission", permission: "calendar"/);
  assert.match(skill, /授权后看到能力出现再查/);
});
