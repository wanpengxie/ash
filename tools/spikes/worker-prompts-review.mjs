#!/usr/bin/env node
// Synthetic, tool-free first-pass review. The credential is read only from the process environment.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { workerCases } from "./worker-review-cases.mjs";
import { compileWorker } from "../../packages/core/src/workers/compile.ts";
import { parseWorkerJson } from "../../packages/core/src/workers/schema.ts";
import { validateWorkerResult, workerInputErrors } from "../../packages/core/src/workers/validate.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const chosenWorker = option("--worker");
const limitText = option("--limit");
const limit = limitText === undefined ? Infinity : Number(limitText);
if ((chosenWorker && !["extract", "verify_claims", "reconcile", "verify_plan", "proactive", "opener"].includes(chosenWorker)) ||
  !(limit > 0 && Number.isInteger(limit)) && limit !== Infinity) throw new Error("invalid review selection");
const selected = workerCases.filter((item) => !chosenWorker || item.worker === chosenWorker).slice(0, limit);
const key = process.env.ASH_CONTENT_API_KEY || process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error("ASH_CONTENT_API_KEY is required; no live review was run");
const model = process.env.ASH_CONTENT_MODEL || "deepseek-flash";
const evidence = resolve(root, option("--out") || "build/evidence/ASH-806");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const sourceHashes = {};
for (const name of ["extract", "verify_claims", "reconcile", "verify_plan", "proactive", "opener"]) {
  const path = `packages/core/src/prompts/workers/${name}.md`;
  sourceHashes[path] = sha(await readFile(resolve(root, path)));
}
await mkdir(evidence, { recursive: true });
const records = [];
for (const item of selected) {
  const request = JSON.parse(JSON.stringify(item.request));
  const errors = workerInputErrors(item.worker, request);
  if (errors.length) throw new Error(`${item.id}: invalid synthetic fixture: ${errors.join("; ")}`);
  const prompt = compileWorker(item.worker, request);
  const started = performance.now();
  let record;
  try {
    const response = await fetch("https://api.deepseek.com/anthropic/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1600, temperature: 0.1, thinking: { type: "disabled" },
        tools: [], system: prompt.system, messages: [{ role: "user", content: prompt.user }] }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const blocks = Array.isArray(body.content) ? body.content : [];
    const textBlocks = blocks.filter((part) => part.type === "text" && typeof part.text === "string");
    const visible = textBlocks.length === 1 ? textBlocks[0].text : "";
    let schemaPass = false;
    let value = null;
    let validationError = null;
    try {
      if (body.stop_reason !== "end_turn") throw new Error(`stop_reason=${String(body.stop_reason)}`);
      if (blocks.length !== 1 || textBlocks.length !== 1) throw new Error("expected one visible text block and zero tools");
      value = validateWorkerResult(item.worker, request, parseWorkerJson(visible));
      schemaPass = true;
    } catch (error) { validationError = error instanceof Error ? error.message : "unknown validation error"; }
    record = { id: item.id, worker: item.worker, expect: item.expect, focus: item.focus,
      request, prompt_sha256: sha(JSON.stringify(prompt)), stop_reason: body.stop_reason ?? null,
      visible, value, schema_pass: schemaPass, validation_error: validationError,
      mode: schemaPass ? ("no_change" in value ? "no_change" : "result") : null,
      elapsed_ms: Math.round(performance.now() - started) };
  } catch (error) {
    record = { id: item.id, worker: item.worker, expect: item.expect, focus: item.focus,
      request, prompt_sha256: sha(JSON.stringify(prompt)), stop_reason: null, visible: "", value: null,
      schema_pass: false, validation_error: error instanceof Error ? error.message : "model transport error",
      mode: null, elapsed_ms: Math.round(performance.now() - started) };
  }
  records.push(record);
  await writeFile(resolve(evidence, "live.json"), JSON.stringify({ model, endpoint: "official DeepSeek Anthropic-compatible messages",
    source_sha256: sourceHashes, case_count: records.length, complete: records.length === selected.length,
    schema_pass_count: records.filter((row) => row.schema_pass).length, records }, null, 2) + "\n");
  console.log(`${item.id} ${record.schema_pass ? "schema-pass" : "schema-fail"} ${record.stop_reason ?? "transport"} ${record.elapsed_ms}ms`);
}
if (records.some((row) => !row.schema_pass)) process.exitCode = 1;
