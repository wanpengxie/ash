import assert from "node:assert/strict";
import test from "node:test";
import type { WorldConfigV2 } from "../../sdk/src/config";
import { dshWorkerModel } from "../src/workers";
import { DshHost } from "../src/host";

const prompt = { system: "Synthetic background instruction", user: "Synthetic input" };

test("worker model selection reads current config on every call: null, override A, B, null", async () => {
  type Selection = WorldConfigV2["workers"]["model"];
  let setting: Selection = null;
  let defaultModel: { provider: string; model: string } | undefined = { provider: "default", model: "base" };
  const captured: { provider: string; model: string; tools: unknown[]; maxTokens?: number }[] = [];
  const host = {
    agentOptions: () => defaultModel,
    ctx: { get: (name: string) => name === "llm" ? { async *stream(request: { provider: string; model: string; tools: unknown[]; maxTokens?: number }) {
      captured.push(request);
      yield { type: "text-delta", text: "{}" };
      yield { type: "finish", reason: { kind: "stop" } };
    } } : undefined },
  } as unknown as DshHost;
  const model = dshWorkerModel(host, () => setting);
  const signal = new AbortController().signal;
  for (const value of [null, { provider: "selected", model: "A" }, { provider: "selected", model: "B" }, null] as Selection[]) {
    setting = value;
    assert.deepEqual(await model.complete(prompt, signal), { text: "{}", finish: "stop" });
  }
  assert.deepEqual(captured.map(({ provider, model }) => [provider, model]), [["default", "base"], ["selected", "A"], ["selected", "B"], ["default", "base"]]);
  assert.ok(captured.every(({ tools }) => Array.isArray(tools) && tools.length === 0));
  // Room for a reasoning model to think and still finish its JSON.
  assert.ok(captured.every(({ maxTokens }) => (maxTokens ?? 0) >= 8_192));
  defaultModel = undefined;
  setting = { provider: "selected", model: "A" };
  assert.deepEqual(await model.complete(prompt, signal), { text: "{}", finish: "stop" }, "explicit override must not depend on a default model");
});

test("missing config and unavailable explicit override fail closed without default fallback", async () => {
  let setting: WorldConfigV2["workers"]["model"] | undefined = undefined;
  const calls: string[] = [];
  const host = {
    agentOptions: () => ({ provider: "default", model: "base" }),
    ctx: { get: (name: string) => name === "llm" ? { async *stream(request: { model: string }) {
      calls.push(request.model);
      if (request.model === "unavailable") throw new Error("model not configured");
      yield { type: "finish", reason: { kind: "stop" } };
    } } : undefined },
  } as unknown as DshHost;
  const model = dshWorkerModel(host, () => setting!);
  await assert.rejects(model.complete(prompt, new AbortController().signal), /setting unavailable/);
  assert.deepEqual(calls, []);
  setting = { provider: "selected", model: "unavailable" };
  await assert.rejects(model.complete(prompt, new AbortController().signal), /model not configured/);
  assert.deepEqual(calls, ["unavailable"], "the default model must not be tried as fallback");
});

test("worker returns provider-reported token usage with the selected model", async () => {
  const host = {
    agentOptions: () => ({ provider: "default", model: "base" }),
    ctx: { get: () => ({ async *stream() {
      yield { type: "usage", usage: { inputTokens: 12, outputTokens: 7, cacheReadTokens: 3 } };
      yield { type: "text-delta", text: "{}" };
      yield { type: "finish", reason: { kind: "stop" } };
    } }) },
  } as unknown as DshHost;
  assert.deepEqual(await dshWorkerModel(host, () => ({ provider: "selected", model: "small" })).complete(prompt, new AbortController().signal), {
    text: "{}", finish: "stop", usage: { provider: "selected", model: "small", inputTokens: 12, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 0 },
  });
});

test("worker prices each call from the selected DSH model catalog route", async () => {
  const selected: string[] = [];
  const host = {
    agentOptions: () => ({ provider: "default", model: "base" }),
    modelRates: async (provider: string, model: string) => {
      selected.push(`${provider}/${model}`);
      return model === "known" ? { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5,
        tiers: [{ inputTokensAbove: 100, input: 4, output: 12, cacheRead: 1, cacheWrite: 5 }] } : null;
    },
    ctx: { get: () => ({ async *stream() {
      yield { type: "usage", usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 } };
      yield { type: "finish", reason: { kind: "stop" } };
    } }) },
  } as unknown as DshHost;
  const known = await dshWorkerModel(host, () => ({ provider: "test", model: "known" })).complete(prompt, new AbortController().signal);
  assert.equal(known.usage?.costUsd, (80 * 4 + 20 * 12 + 30) / 1_000_000);
  const unknown = await dshWorkerModel(host, () => ({ provider: "test", model: "unknown" })).complete(prompt, new AbortController().signal);
  assert.equal(unknown.usage?.costUsd, undefined, "an unpriced model must not be recorded as free");
  assert.deepEqual(selected, ["test/known", "test/unknown"]);
});

test("installed DSH catalog supplies a known model price and leaves unknown models unpriced", {
  skip: !process.env.ASH_TEST_DSH_ROOT,
}, async () => {
  const host = new DshHost({ root: process.env.ASH_TEST_DSH_ROOT!, home: "/tmp/ash-unused-catalog-home" });
  const known = await host.modelRates("anthropic", "claude-haiku-4-5");
  assert.ok(known && known.input > 0 && known.output > 0);
  assert.equal(await host.modelRates("unknown-provider", "unknown-model"), null);
});

test("installed DSH price reaches the actual worker completion", { skip: !process.env.ASH_TEST_DSH_ROOT }, async () => {
  const host = new DshHost({ root: process.env.ASH_TEST_DSH_ROOT!, home: "/tmp/ash-unused-catalog-home" });
  host.ctx = { get: () => ({ async *stream() {
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 0 } };
    yield { type: "text-delta", text: "{}" };
    yield { type: "finish", reason: { kind: "stop" } };
  } }) };
  const result = await dshWorkerModel(host, () => ({ provider: "anthropic", model: "claude-haiku-4-5" }))
    .complete(prompt, new AbortController().signal);
  assert.equal(result.usage?.costUsd, (100 * 1 + 20 * 5 + 10 * 0.1) / 1_000_000);
});
