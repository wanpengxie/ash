import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startHarness, requestText, waitForTurn } from "./harness";

const harness = await startHarness((request) => {
  const marks = [...requestText(request).matchAll(/probe:(MAIN|MIND):(\d+)/g)];
  const last = marks.at(-1);
  return last ? `ack:${last[1]}:${last[2]}` : "helper";
});
try {
  const registry = harness.host.ctx.get("agents");
  const mainId = `spike-main-${randomUUID()}`;
  const mindId = `spike-mind-${randomUUID()}`;
  const options = harness.host.agentOptions();
  const main = await registry.create({ sessionId: mainId, meta: { cwd: harness.dir }, agentOptions: options });
  const mind = await registry.create({ sessionId: mindId, meta: { cwd: harness.dir }, agentOptions: options });
  assert.equal(main.agent.id, main.agent.session.id, "DSH agent id is its one session id");
  assert.equal(mind.agent.id, mind.agent.session.id);
  assert.notEqual(main.agent.session.id, mind.agent.session.id);
  console.log("same-agent-two-sessions: unsupported by DSH agent/session identity (agent.id === agent.session.id)");
  for (let turn = 1; turn <= 10; turn++) {
    const runs = ([{ agent: main.agent, id: mainId, role: "MAIN" }, { agent: mind.agent, id: mindId, role: "MIND" }] as const).map(({ agent, id, role }) => waitForTurn(harness.host, id, () => agent.followup({ id: randomUUID(), role: "user", content: [{ type: "text", text: `probe:${role}:${turn}` }], source: { kind: "user" } })));
    const [a, b] = await Promise.all(runs);
    assert.equal(a.text, `ack:MAIN:${turn}`);
    assert.equal(b.text, `ack:MIND:${turn}`);
    assert.ok(a.events.includes("turn/end") && b.events.includes("turn/end"));
    console.log(`round ${turn}: ${a.text} | ${b.text}`);
  }
  const modelCalls = harness.requests.filter((request) => request.tools.length > 0);
  const mainCalls = modelCalls.filter((request) => requestText(request).includes("probe:MAIN:"));
  const mindCalls = modelCalls.filter((request) => requestText(request).includes("probe:MIND:"));
  assert.ok(mainCalls.length >= 10 && mindCalls.length >= 10);
  assert.ok(mainCalls.every((request) => !requestText(request).includes("probe:MIND:")), "main saw mind history");
  assert.ok(mindCalls.every((request) => !requestText(request).includes("probe:MAIN:")), "mind saw main history");
  console.log(`PASS: 10 interleaved rounds; ${mainCalls.length} main and ${mindCalls.length} mind model requests; no cross-session prompt content`);
  const wrong = await waitForTurn(harness.host, mainId, () => main.agent.followup({ id: randomUUID(), role: "user", content: [{ type: "text", text: "probe:MIND:11" }], source: { kind: "user" } }));
  assert.equal(wrong.text, "ack:MIND:11");
  const mixedPrompt = requestText(harness.requests.at(-1)!);
  assert.match(mixedPrompt, /probe:MAIN:10/);
  assert.match(mixedPrompt, /probe:MIND:11/);
  console.log("NEGATIVE CONTROL: sending mind work to the main agent shares its history, so one agent cannot isolate the two conversations");
  await Promise.all([main.dispose(), mind.dispose()]);
} finally {
  await harness.close();
}
