import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MODEL, migrateModelChoice, patchText } from "../src/launch";
import { catalogRates, piWorkerModel } from "../src/workers";
import { modelOf } from "../src/host";
import { DEEPSEEK_DEFAULT_MODEL, resolveModel } from "../../core/src/workers/deepseek-model";

test("the default model is DeepSeek's image-reading Flash, by the id the runtime knows", () => {
  assert.deepEqual(DEFAULT_MODEL, { provider: "deepseek-official", model: "deepseek-flash" });
  assert.equal(DEEPSEEK_DEFAULT_MODEL, "deepseek-flash");
  assert.match(patchText("/p", DEFAULT_MODEL), /model: 'deepseek-flash'/);
});

test("a stored choice of exactly the retired default moves to deepseek-flash; any other choice is kept", () => {
  assert.deepEqual(migrateModelChoice({ provider: "deepseek-official", model: "deepseek-v4-flash" }), DEFAULT_MODEL);
  for (const kept of [{ provider: "deepseek-official", model: "deepseek-v4-pro" }, { provider: "deepseek-official", model: "deepseek-flash" },
    { provider: "openrouter", model: "deepseek-v4-flash" }]) assert.equal(migrateModelChoice(kept), kept);
});

test("background model calls resolve deepseek-flash although pi-ai's catalog does not list it", () => {
  for (const provider of ["deepseek", "deepseek-official"]) {
    const model = resolveModel(provider, "deepseek-flash")!;
    assert.ok(model, provider);
    assert.deepEqual([model.id, model.provider, model.api, model.baseUrl], ["deepseek-flash", "deepseek", "openai-completions", "https://api.deepseek.com"]);
    assert.deepEqual(model.input, ["text", "image"]);
  }
  assert.notEqual(resolveModel("deepseek", "deepseek-flash"), resolveModel("deepseek", "deepseek-flash"), "each caller gets its own copy");
  assert.equal(resolveModel("deepseek", "deepseek-v4-pro")!.id, "deepseek-v4-pro", "catalog models still come from the catalog");
  assert.equal(resolveModel("deepseek", "no-such-model"), undefined);
  assert.equal(resolveModel("openrouter", "deepseek-flash"), undefined, "only DeepSeek's own route gains the added model");
  assert.deepEqual(catalogRates("deepseek-official", "deepseek-flash"), { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 });
  assert.equal(catalogRates("deepseek-official", "no-such-model"), null);
});

test("a worker on an unknown model fails plainly instead of calling out", async () => {
  const worker = piWorkerModel(() => "sk-test", () => ({ provider: "deepseek-official", model: "no-such-model" }));
  await assert.rejects(worker.complete({ system: "s", user: "u" }, new AbortController().signal), /worker model unavailable: deepseek\/no-such-model/);
});

test("a session's model is read from the runtime's own config option", () => {
  const options = [{ id: "model", type: "select", currentValue: JSON.stringify(["deepseek-official", "deepseek-flash"]), options: [] },
    { id: "reasoning", currentValue: "high" }];
  assert.deepEqual(modelOf(options), { provider: "deepseek-official", model: "deepseek-flash" });
  assert.equal(modelOf(undefined), null);
  assert.equal(modelOf([{ id: "model", currentValue: "not json" }]), null);
  // Only a retired id is moved, and only to its successor.
  assert.deepEqual(migrateModelChoice({ provider: "deepseek-official", model: "deepseek-v4-flash" }), DEFAULT_MODEL);
  const kept = { provider: "deepseek-official", model: "deepseek-v4-pro" };
  assert.equal(migrateModelChoice(kept), kept);
});
