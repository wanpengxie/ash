import assert from "node:assert/strict";
import test from "node:test";
import { matchesSchema } from "../src/schema";
import { wordContract } from "../src/words";

test("managed editor writes require exact hash or explicit new-file null", () => {
  const read = wordContract("service:self", "read")!;
  const write = wordContract("service:self", "write")!;
  const plan = wordContract("service:self", "apply_plan")!;
  const sha = "a".repeat(64);
  assert.equal(matchesSchema(read.input_schema!, { path: "SOUL.md" }), true);
  // A foreign path passes the schema so that service:self can refuse it as forbidden (F-S22).
  assert.equal(matchesSchema(read.input_schema!, { path: "../SOUL.md" }), true);
  assert.equal(matchesSchema(write.input_schema!, { path: "USER.md", content: "text", why: "owner edit", expected_hash: sha }), true);
  assert.equal(matchesSchema(write.input_schema!, { path: "USER.md", content: "text", why: "owner edit", expected_hash: null }), true);
  for (const body of [
    { path: "USER.md", content: "text", why: "owner edit" },
    { path: "USER.md", content: "text", why: "owner edit", expected_hash: "wrong" },
  ]) assert.equal(matchesSchema(write.input_schema!, body), false);
  assert.equal(matchesSchema(plan.input_schema!, { path: "MEMORY.md", expected_hash: sha, edits: [{ op: "replace", start: 1, end: 1, guard: "old", text: "new", reason: "correct", evidence: ["m1"] }] }), true);
  assert.equal(matchesSchema(plan.input_schema!, { path: "MEMORY.md", edits: [] }), false);
});

test("rollback requires an exact baseline hash as well as a snapshot timestamp", () => {
  const history = wordContract("service:self", "history")!;
  const rollback = wordContract("service:self", "rollback")!;
  assert.equal(matchesSchema(history.input_schema!, { path: "MEMORY.md" }), true);
  assert.equal(matchesSchema(rollback.input_schema!, { path: "MEMORY.md", to_ts: 1000, expected_hash: "a".repeat(64) }), true);
  assert.equal(matchesSchema(rollback.input_schema!, { path: "MEMORY.md", to_ts: 1000 }), false);
  assert.equal(matchesSchema(rollback.input_schema!, { path: "MEMORY.md", to_ts: 1000, expected_hash: null }), false);
});
