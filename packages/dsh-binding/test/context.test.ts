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
