import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";

test("production owner HTTP routes one fake risk request through durable ask and screen answer", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ash-gate-http-"));
  const running = await startOwner({ stateDir, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  let effects = 0;
  try {
    running.members.registerDevice({ id: "device:fake", kind: "device", name: "Synthetic device", online: true,
      capabilities: () => [{ name: "run", description: "Synthetic effect", label: "Run synthetic", risk: "outward",
        input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } }],
      handle: () => { effects++; return { ok: true, result: {} }; } });
    const auth = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const headers = { authorization: `Bearer ${auth}`, "content-type": "application/json" };
    const send = (wire: unknown, extra: Record<string, string> = {}) => fetch(`${running.url}/api/send`,
      { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(wire) });
    const accepted = await send({ to: "device:fake", kind: "request", word: "run", body: { n: 1 } });
    assert.equal(accepted.status, 200);
    const request = await accepted.json() as { id: string };
    const deadline = Date.now() + 2_000;
    while (!running.ledger.gateCase(request.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    const gateCase = running.ledger.gateCase(request.id);
    assert.ok(gateCase);
    assert.equal(effects, 0);
    const answer = { to: "service:gate", kind: "response", word: "ask", reply_to: gateCase.askId,
      body: { ok: true, result: { choice: "once" } }, client_id: "controlled-answer" };
    assert.equal((await send(answer)).status, 403); // an owner API token is not a screen confirmation
    const screen = running.edge.screens.register({ member: "person:owner", transport: "api", local: true, remote: false,
      ownerProxy: true, transportPrincipal: `token:${createHash("sha256").update(auth).digest("hex")}` }, "controlled-scope", "Controlled tab");
    const approved = await send(answer, { "Ash-Screen": screen.token });
    assert.equal(approved.status, 200);
    const first = await approved.json() as { id: string };
    assert.equal((await (await send(answer, { "Ash-Screen": screen.token })).json() as { id: string }).id, first.id);
    while (!running.ledger.responseTo(request.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(effects, 1);
    assert.equal(running.ledger.responseTo(request.id)?.body.ok, true);
    assert.equal(running.ledger.list().filter((message) => message.word === "gate.asked").length, 1);
    assert.equal(running.ledger.list().filter((message) => message.word === "gate.passed").length, 1);
  } finally { await running.close(); }
});
