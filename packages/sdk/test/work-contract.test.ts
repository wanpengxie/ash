import assert from "node:assert/strict";
import test from "node:test";
import type { WorkRunInfoV2, WorkRunStepBodyV2 } from "../src/api";
import { matchesSchema } from "../src/schema";
import { wordContract, workRunTurn, workRunsResultErrors } from "../src/words";

test("run.step is outbound-only, closed, and carries bounded metadata rather than content", () => {
  const contract = wordContract("service:work", "run.step")!;
  assert.equal(contract.kind, "event");
  assert.equal(contract.direction, "out");
  assert.equal(contract.result_schema, undefined);
  assert.equal(wordContract("service:other", "run.step"), undefined);
  const valid: WorkRunStepBodyV2 = { run: "r_1", step: "window.collect_1", state: "started" };
  for (const state of ["started", "done", "failed", "skipped"])
    assert.ok(matchesSchema(contract.input_schema!, { ...valid, state }));
  for (const invalid of [
    {}, null, { ...valid, run: "" }, { ...valid, run: "1" }, { ...valid, run: "w_1" },
    { ...valid, run: "r_/1" }, { ...valid, run: `r_${"a".repeat(127)}` },
    { ...valid, step: "" }, { ...valid, step: "1window" }, { ...valid, step: "a".repeat(49) },
    { ...valid, step: "输入" }, { ...valid, state: "running" },
    { ...valid, output: "secret" }, { ...valid, prompt: "secret" }, { ...valid, detail: "secret" },
  ]) assert.ok(!matchesSchema(contract.input_schema!, invalid), `accepted ${JSON.stringify(invalid)}`);
});

test("runs returns only bounded safe metadata, never arbitrary projection rows", () => {
  const contract = wordContract("service:work", "runs")!;
  assert.equal(contract.audience, "owner");
  const input = contract.input_schema!;
  for (const valid of [{}, { flow: "memory" }, { limit: 1 }, { limit: 100, flow: "memory.hourly" }])
    assert.ok(matchesSchema(input, valid));
  for (const invalid of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { flow: "bad/flow" }, { flow: "a".repeat(49) }, { extra: true }])
    assert.ok(!matchesSchema(input, invalid));

  const run: WorkRunInfoV2 = { run: "r_1", flow: "memory", trigger: "manual", state: "running", started_at: 1, ended_at: null };
  const result = contract.result_schema!;
  assert.ok(matchesSchema(result, { runs: [run] }));
  assert.ok(matchesSchema(result, { runs: [{ ...run, state: "done", ended_at: 2 }] }));
  assert.ok(matchesSchema(result, { runs: [] }));
  assert.deepEqual(workRunsResultErrors({ runs: [run, { ...run, run: "r_2", state: "failed", ended_at: 1 }] }), []);
  for (const invalid of [
    { runs: [{ ...run, ended_at: 2 }] },
    { runs: [{ ...run, state: "done", ended_at: null }] },
    { runs: [{ ...run, state: "done", ended_at: 0 }] },
  ]) assert.notDeepEqual(workRunsResultErrors(invalid), [], `accepted temporal mismatch ${JSON.stringify(invalid)}`);
  for (const invalid of [
    { runs: [{ ...run, flow: "" }] }, { runs: [{ ...run, trigger: "raw event text" }] },
    { runs: [{ ...run, state: "success" }] }, { runs: [{ ...run, started_at: -1 }] },
    { runs: [{ ...run, ended_at: Number.POSITIVE_INFINITY }] },
    { runs: [{ ...run, input: "secret" }] }, { runs: [{ ...run, output: "secret" }] },
    { runs: [run], next: "secret" }, { runs: Array.from({ length: 101 }, () => run) },
  ]) assert.ok(!matchesSchema(result, invalid), `accepted ${JSON.stringify(invalid)}`);
});

test("run, run.start and run.end use one bounded r_ run identity and safe program codes", () => {
  const run = wordContract("service:work", "run")!;
  const start = wordContract("service:work", "run.start")!;
  const end = wordContract("service:work", "run.end")!;
  assert.equal(start.direction, "out");
  assert.equal(end.direction, "out");
  assert.ok(matchesSchema(run.input_schema!, { flow: "memory.hourly" }));
  assert.ok(matchesSchema(run.result_schema!, { run: "r_opaque_1" }));
  assert.ok(matchesSchema(start.input_schema!, { run: "r_opaque_1", flow: "memory", trigger: "hourly" }));
  assert.ok(matchesSchema(end.input_schema!, { run: "r_opaque_1", outcome: "failed", detail: "unknown_effect" }));
  assert.equal(workRunTurn("r_opaque_1"), "r_opaque_1");
  assert.throws(() => workRunTurn("opaque_1"));
  for (const flow of ["", "1memory", "memory / user", "a".repeat(49), "模型"])
    assert.ok(!matchesSchema(run.input_schema!, { flow }));
  for (const runId of ["opaque_1", "r_", "r_/bad", `r_${"a".repeat(127)}`]) {
    assert.ok(!matchesSchema(run.result_schema!, { run: runId }));
    assert.ok(!matchesSchema(start.input_schema!, { run: runId, flow: "memory", trigger: "manual" }));
    assert.ok(!matchesSchema(end.input_schema!, { run: runId, outcome: "done", detail: "complete" }));
  }
  for (const invalid of [
    { run: "r_1", flow: "memory", trigger: "timer:1" },
    { run: "r_1", flow: "bad/flow", trigger: "manual" },
    { run: "r_1", flow: "memory", trigger: "manual", raw: "secret" },
  ]) assert.ok(!matchesSchema(start.input_schema!, invalid));
  for (const invalid of [
    { run: "r_1", outcome: "done", detail: "" },
    { run: "r_1", outcome: "done", detail: "user content" },
    { run: "r_1", outcome: "done", detail: "a".repeat(97) },
    { run: "r_1", outcome: "cancelled", detail: "complete" },
    { run: "r_1", outcome: "done", detail: "complete", output: "secret" },
  ]) assert.ok(!matchesSchema(end.input_schema!, invalid));
});
