import assert from "node:assert/strict";
import { dshWorkerModel } from "../../packages/dsh-binding/src/workers";
import { WorkerMember } from "../../packages/core/src/workers/llm";
import { compileWorker } from "../../packages/core/src/workers/compile";
import type { Message, WorkerRequest } from "../../packages/sdk/src/api";
import { requestText, startHarness } from "./harness";

const source: Message = { seq: 1, id: "source_1", ts: 1, from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "Keep summaries short" } };
const request: WorkerRequest<"extract"> = { run: "run_fixture", input: { chunk: [source], summary: "", known: [] } };
const outputs = [
  JSON.stringify({ claims: [{ text: "Likes brief summaries", type: "preference", salience: "medium", evidence: ["source_1"], quote: "Keep summaries short" }] }),
  JSON.stringify({ claims: [{ text: "Unsupported", type: "preference", salience: "medium", evidence: ["invented"], quote: "invented" }] }),
  "not-json",
  JSON.stringify({ claims: [{ text: "Likes brief summaries", type: "preference", salience: "medium", evidence: ["source_1"], quote: "Keep summaries short" }] }),
];
const harness = await startHarness(() => outputs.shift() ?? "unexpected");
try {
  const model = harness.host.agentOptions();
  assert.ok(model, "configured model absent");
  const worker = new WorkerMember("extract", dshWorkerModel(harness.host, () => null));
  const message = { ...source, to: "worker:extract", word: "extract", body: request } as Message;
  const context = { signal: new AbortController().signal, recovered: false };
  const good = await worker.handle(message, context);
  assert.equal(good.ok, true);
  const bad = await worker.handle(message, context);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, "failed");
  const currentDefault = harness.host.agentOptions;
  harness.host.agentOptions = () => undefined;
  try {
    const explicit = new WorkerMember("extract", dshWorkerModel(harness.host, () => model));
    assert.equal((await explicit.handle(message, context)).ok, true, "explicit model should work without default selection");
  } finally { harness.host.agentOptions = currentDefault; }
  assert.equal(harness.requests.length, 4, "one valid call, two invalid attempts, then one explicit override");
  const compiled = compileWorker("extract", request);
  for (const captured of harness.requests) {
    assert.equal(captured.model, model.model);
    assert.equal(captured.tools.length, 0);
    assert.equal(captured.system, compiled.system);
    assert.equal(requestText(captured), compiled.user);
  }
  console.log(`PASS worker service: ${harness.requests.length} no-session DSH llm.stream calls; default and explicit model captured; tools=[]; invalid evidence retried once and failed`);
} finally {
  await harness.close();
}
