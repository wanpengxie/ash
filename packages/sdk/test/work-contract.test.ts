import assert from "node:assert/strict";
import test from "node:test";
import type { WorkRunInfoV2, WorkRunStepBodyV2 } from "../src/api";
import { matchesSchema } from "../src/schema";
import { wordContract } from "../src/words";

test("run.step is outbound-only, closed, and carries bounded metadata rather than content", () => {
  const contract = wordContract("service:work", "run.step")!;
  assert.equal(contract.kind, "event");
  assert.equal(contract.direction, "out");
  assert.equal(contract.result_schema, undefined);
  assert.equal(wordContract("service:other", "run.step"), undefined);
  const valid: WorkRunStepBodyV2 = { run: "w_1", step: "window.collect_1", state: "started" };
  for (const state of ["started", "done", "failed", "skipped"])
    assert.ok(matchesSchema(contract.input_schema!, { ...valid, state }));
  for (const invalid of [
    {}, null, { ...valid, run: "" }, { ...valid, run: "w/1" }, { ...valid, run: "a".repeat(129) },
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

  const run: WorkRunInfoV2 = { run: "w_1", flow: "memory", trigger: "manual", state: "running", started_at: 1, ended_at: null };
  const result = contract.result_schema!;
  assert.ok(matchesSchema(result, { runs: [run] }));
  assert.ok(matchesSchema(result, { runs: [{ ...run, state: "done", ended_at: 2 }] }));
  assert.ok(matchesSchema(result, { runs: [] }));
  for (const invalid of [
    { runs: [{ ...run, flow: "" }] }, { runs: [{ ...run, trigger: "raw event text" }] },
    { runs: [{ ...run, state: "success" }] }, { runs: [{ ...run, started_at: -1 }] },
    { runs: [{ ...run, ended_at: Number.POSITIVE_INFINITY }] },
    { runs: [{ ...run, input: "secret" }] }, { runs: [{ ...run, output: "secret" }] },
    { runs: [run], next: "secret" }, { runs: Array.from({ length: 101 }, () => run) },
  ]) assert.ok(!matchesSchema(result, invalid), `accepted ${JSON.stringify(invalid)}`);
});
