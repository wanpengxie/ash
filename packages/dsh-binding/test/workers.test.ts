import assert from "node:assert/strict";
import test from "node:test";
import type { WorldConfigV2 } from "../../sdk/src/config";
import { dshWorkerModel } from "../src/workers";
import type { DshHost } from "../src/host";

const prompt = { system: "Synthetic background instruction", user: "Synthetic input" };

test("worker model selection reads current config on every call: null, override A, B, null", async () => {
  type Selection = WorldConfigV2["workers"]["model"];
  let setting: Selection = null;
  let defaultModel: { provider: string; model: string } | undefined = { provider: "default", model: "base" };
  const captured: { provider: string; model: string; tools: unknown[] }[] = [];
  const host = {
    agentOptions: () => defaultModel,
    ctx: { get: (name: string) => name === "llm" ? { async *stream(request: { provider: string; model: string; tools: unknown[] }) {
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
