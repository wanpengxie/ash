import assert from "node:assert/strict";
import test from "node:test";
import { workerCases } from "../../../../tools/spikes/worker-review-cases.mjs";
import { WORKER_NAMES } from "../../src/workers/llm";
import { workerInputErrors } from "../../src/workers/validate";
import { compileWorker } from "../../src/workers/compile";

test("six original worker prompts have ten valid synthetic review inputs each", () => {
  assert.equal(workerCases.length, 60);
  assert.equal(new Set(workerCases.map((item) => item.id)).size, 60);
  for (const name of WORKER_NAMES) {
    const items = workerCases.filter((item) => item.worker === name);
    assert.equal(items.length, 10, name);
    for (const item of items) {
      const request = JSON.parse(JSON.stringify(item.request));
      assert.deepEqual(workerInputErrors(name, request), [], item.id);
      const prompt = compileWorker(name, request);
      assert.ok(prompt.system.includes("这是后台的一步，你不直接对用户说话"));
      assert.ok(prompt.user.includes(`source="worker:${name}/input"`));
    }
  }
});
