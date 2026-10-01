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

test("local owner grants one exact device capability without waiving the agent's risk ask", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ash-gate-access-http-"));
  const running = await startOwner({ stateDir, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  let effects = 0;
  try {
    running.members.registerDevice({ id: "device:fake", kind: "device", name: "Synthetic device", online: false,
      capabilities: () => [{ name: "run", description: "Synthetic effect", label: "Run synthetic", risk: "outward",
        input_schema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false } }],
      handle: () => { effects++; return { ok: true, result: {} }; } });
    const ownerToken = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const call = async (word: string, body: object, client_id?: string) => {
      const response = await fetch(`${running.url}/api/send`, { method: "POST",
        headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
        body: JSON.stringify({ to: "service:gate", kind: "request", word, body, wait: true, ...(client_id ? { client_id } : {}) }) });
      return { status: response.status, value: await response.json() as { id: string; reply?: { body: { ok: boolean; result?: Record<string, unknown> } } } };
    };
    const agent = { transport: "agent" as const, member: "agent:main", transportPrincipal: "agent:main",
      local: true, remote: false, ownerProxy: false };
    const attempt = () => running.world.send(agent, { to: "device:fake", kind: "request", word: "run", body: { n: 1 } });
    await assert.rejects(attempt(), /device access grant unavailable/);
    const bad = await call("access.grant", { member: "agent:main", scope: "device:fake/*" });
    assert.equal(bad.status, 400);
    assert.equal(running.ledger.gateAccessPage().items.length, 0);
    const beforeRemote = running.ledger.lastSeq();
    await assert.rejects(running.world.send({ transport: "web_ui", member: "person:owner", transportPrincipal: "remote-owner",
      local: false, remote: true, ownerProxy: true, screenId: "screen:remote", screenLabel: "Remote" },
    { to: "service:gate", kind: "request", word: "access.grant", body: { member: "agent:main", scope: "device:fake/run" } }), /current local owner/);
    assert.equal(running.ledger.lastSeq(), beforeRemote);
    const unknown = await call("access.grant", { member: "agent:main", scope: "device:fake/missing" });
    assert.equal(unknown.value.reply?.body.ok, false);
    assert.equal(running.ledger.gateAccessPage().items.length, 0);
    const grant = await call("access.grant", { member: "agent:main", scope: "device:fake/run" }, "grant-once");
    assert.equal(grant.status, 200);
    assert.equal(grant.value.reply?.body.ok, true);
    const granted = running.ledger.gateAccessPage().items[0]!;
    assert.equal(granted.source, "current");
    assert.equal(granted.scope, "device:fake/run");
    assert.equal((await call("access.grant", { member: "agent:main", scope: "device:fake/run" }, "grant-once")).value.id, grant.value.id);
    assert.equal(running.ledger.gateAccessPage().items.length, 1);
    const requested = await attempt();
    const deadline = Date.now() + 2_000;
    while (!running.ledger.gateCase(requested.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(running.ledger.gateCase(requested.id));
    assert.equal(effects, 0);
    const revoked = await call("access.revoke", { id: granted.id });
    assert.equal(revoked.value.reply?.body.result?.revoked, true);
    const caseState = running.ledger.gateCase(requested.id)!;
    const screen = running.edge.screens.register({ member: "person:owner", transport: "api", local: true, remote: false,
      ownerProxy: true, transportPrincipal: `token:${createHash("sha256").update(ownerToken).digest("hex")}` }, "access-scope", "Controlled tab");
    const answer = await fetch(`${running.url}/api/send`, { method: "POST",
      headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json", "Ash-Screen": screen.token },
      body: JSON.stringify({ to: "service:gate", kind: "response", word: "ask", reply_to: caseState.askId,
        body: { ok: true, result: { choice: "once" } } }) });
    assert.equal(answer.status, 200);
    while (!running.ledger.responseTo(requested.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(effects, 0);
    assert.equal(running.ledger.responseTo(requested.id)?.body.error?.code, "forbidden");
  } finally { await running.close(); }
});
