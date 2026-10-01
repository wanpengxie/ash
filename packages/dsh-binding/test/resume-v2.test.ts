import assert from "node:assert/strict";
import { test } from "node:test";
import { assertResumableHistory } from "../src/host";

test("resume accepts only already-started application prompts and internal context snapshots", () => {
  const turns = new Set(["t_started"]);
  assert.doesNotThrow(() => assertResumableHistory([
    { type: "user/message", data: { id: "core-t_started", source: { kind: "user" } } },
    { type: "user/message", data: { id: "a6b1fcb5-cd06-4033-8e04-febb6de6b04f", source: { kind: "runtime-context", form: "snapshot",
      sections: [{ name: "policy", text: "Safe context." }] }, content: [{ type: "text", text: "Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nSafe context." }] } },
    { type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, inserted: [{ id: "core-t_started" }] } },
    { type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, removedCount: 1, inserted: [] } },
  ], turns, turns));
  assert.throws(() => assertResumableHistory([{ type: "user/message", data: { id: "core-t_other", source: { kind: "user" } } }], turns),
    /without a core turn/);
  assert.throws(() => assertResumableHistory([{ type: "user/message", data: { id: "forged", source: { kind: "user" } } }], turns),
    /without a core turn/);
  assert.throws(() => assertResumableHistory([{ type: "user/message", data: { id: "forged", source: { kind: "runtime-context" } } }], turns),
    /without a core turn/);
  assert.throws(() => assertResumableHistory([], turns, turns), /completed core turn is missing/);
  assert.throws(() => assertResumableHistory([
    { type: "user/message", data: { id: "core-t_started", source: { kind: "user" } } },
    { type: "user/message", data: { id: "core-t_started", source: { kind: "user" } } },
  ], turns), /repeats a core prompt/);
});

test("resume refuses every DSH-owned pending prompt or next-step call before the agent is published", () => {
  for (const target of ["next-turn", "next-step"]) {
    assert.throws(() => assertResumableHistory([
      { type: "agent/inbox/spliced", data: { target, start: 0, inserted: [{ id: "queued" }] } },
    ], new Set()), /queued work/);
  }
  assert.throws(() => assertResumableHistory([
    { type: "agent/inbox/spliced", data: { target: "next-turn", start: 2, inserted: [] } },
  ], new Set()), /invalid DSH inbox splice/);
});
