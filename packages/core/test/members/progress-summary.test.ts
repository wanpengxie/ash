import assert from "node:assert/strict";
import test from "node:test";
import { ProgressSummaryWorker } from "../../src/review/progress";
const tick = () => new Promise<void>((r) => setImmediate(r));
test("thought summary is optional, async, deduplicated and cannot replace a later tool stage", async () => {
  const resolvers: ((s: string) => void)[] = [], published: unknown[] = [];
  const w = new ProgressSummaryWorker(() => new Promise((r) => resolvers.push(r)), (text, current) => published.push({ text, current }));
  w.thought("raw thought"); w.thought("raw thought"); assert.equal(resolvers.length, 1);
  w.stageChanged(); resolvers[0]("先读取书架，再核对是否有遗漏"); await tick();
  assert.deepEqual(published, [{ text: "先读取书架，再核对是否有遗漏", current: false }]);
  w.thought("new thought"); w.close(); resolvers[1]("late result"); await tick(); assert.equal(published.length, 1);
});
test("superseded and failed summaries never fabricate progress", async () => {
  const resolvers: ((s: string) => void)[] = [], published: string[] = [];
  const w = new ProgressSummaryWorker(() => new Promise((r) => resolvers.push(r)), (text) => published.push(text));
  w.thought("one"); w.thought("two"); resolvers[0]("stale"); resolvers[1]("核对当前页面"); await tick();
  assert.deepEqual(published, ["核对当前页面"]); w.close();
  const failure = new ProgressSummaryWorker(async () => { throw new Error("timeout"); }, (s) => published.push(s));
  failure.thought("failed"); await tick(); assert.equal(published.length, 1); failure.close();
});
