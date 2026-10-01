import assert from "node:assert/strict";
import test from "node:test";
import { renderMainContext } from "../src/context";

test("main context keeps persona, rules and standing files in design order", () => {
  const context = renderMainContext({ soul: "SOUL_MARKER", identity: "IDENTITY_MARKER", user: "USER_MARKER",
    memory: "MEMORY_MARKER", heartbeat: "HEARTBEAT_MARKER" });
  const positions = ["SOUL_MARKER", "IDENTITY_MARKER", "像在对话里帮一个熟悉的人办事", "USER_MARKER",
    "MEMORY_MARKER", "HEARTBEAT_MARKER"].map((marker) => context.indexOf(marker));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])));
});

test("main context asks for the owner's calendar grant through an in-chat card", () => {
  const context = renderMainContext({ soul: null, identity: null, user: null, memory: null, heartbeat: null });
  assert.match(context, /没有 `calendar\.search`/);
  assert.match(context, /`ash_show`/);
  assert.match(context, /"type": "permission", "permission": "calendar"/);
  assert.match(context, /获得授权并看到能力可用后，才查询日历/);
});
