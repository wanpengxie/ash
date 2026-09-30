import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startHarness, requestText, waitForTurn } from "./harness";

const harness = await startHarness((request) => requestText(request).includes("one-shot-bad-json") ? "not-json" : requestText(request).includes("one-shot-json") ? JSON.stringify({ ok: true, value: "complete" }) : "session-complete");
try {
  const model = harness.host.agentOptions();
  assert.ok(model, "DSH default model unavailable");
  const llm = harness.host.ctx.get("llm");
  assert.ok(llm?.stream, "DSH llm service unavailable");
  const started = performance.now();
  let text = "";
  let finish: unknown;
  for await (const chunk of llm.stream({ ...model, system: "Return a JSON object with ok=true and value=complete.", messages: [{ role: "user", content: [{ type: "text", text: "one-shot-json" }] }], tools: [], maxTokens: 128 })) {
    if (chunk.type === "text-delta") text += chunk.text;
    if (chunk.type === "finish") finish = chunk.reason;
  }
  const oneShotMs = Math.round(performance.now() - started);
  assert.deepEqual(JSON.parse(text), { ok: true, value: "complete" });
  assert.deepEqual(finish, { kind: "stop" });
  const oneShotRequest = harness.requests.at(-1)!;
  assert.match(oneShotRequest.system, /Return a JSON object/);
  assert.equal(oneShotRequest.tools.length, 0);
  assert.equal(oneShotRequest.messages.length, 1);

  const id = `spike-session-${randomUUID()}`;
  const handle = await harness.host.ctx.get("agents").create({ sessionId: id, meta: { cwd: harness.dir }, agentOptions: model });
  const sessionStarted = performance.now();
  const session = await waitForTurn(harness.host, id, () => handle.agent.followup({ id: randomUUID(), role: "user", content: [{ type: "text", text: "session-compare" }], source: { kind: "user" } }));
  const sessionMs = Math.round(performance.now() - sessionStarted);
  assert.equal(session.text, "session-complete");
  await handle.dispose();
  console.log(`PASS: one-shot returned complete JSON, system prompt reached provider, no tools or session history; one-shot=${oneShotMs}ms session=${sessionMs}ms (local scripted model)`);

  let malformed = "";
  for await (const chunk of llm.stream({ ...model, system: "Return JSON", messages: [{ role: "user", content: [{ type: "text", text: "one-shot-bad-json" }] }], tools: [] })) if (chunk.type === "text-delta") malformed += chunk.text;
  assert.throws(() => JSON.parse(malformed), SyntaxError);
  console.log("NEGATIVE CONTROL: malformed model JSON reaches the caller and must be rejected by worker schema validation");

  const { credentialRef } = await harness.host.imp("@deepseek-ai/dsh-credentials");
  const credential = await harness.host.ctx.get("credentials")?.resolve(credentialRef("DEEPSEEK_API_KEY"));
  assert.ok(credential?.value, "configured DSH provider credential unavailable");
  const response = await fetch(`http://127.0.0.1:${harness.port}/anthropic/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": credential.value, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: model.model, max_tokens: 128, system: "Return JSON", messages: [{ role: "user", content: "one-shot-json" }] }) });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /complete/);
  console.log("PASS: direct provider HTTP fallback sample used DSH credential resolution and returned a streamed response");
} finally {
  await harness.close();
}
