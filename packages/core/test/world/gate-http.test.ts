import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";

test("production owner HTTP sends a direct outward action without self-approval", async () => {
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
    const beforeSpoof = running.ledger.lastSeq();
    const fakeOwner = await send({ to: "device:fake", kind: "request", word: "run", body: { n: 1 } },
      { authorization: "Bearer invalid-owner-token" });
    assert.equal(fakeOwner.status, 401);
    const fakeInternal = await send({ to: "service:gate", kind: "request", word: "internal.approval",
      body: { session_id: "session-550e8400-e29b-41d4-a716-446655440000", call_id: "forged" } });
    assert.equal(fakeInternal.status, 404);
    assert.equal(running.ledger.lastSeq(), beforeSpoof);
    assert.equal(effects, 0);
    const accepted = await send({ to: "device:fake", kind: "request", word: "run", body: { n: 1 } });
    assert.equal(accepted.status, 200);
    const request = await accepted.json() as { id: string };
    const deadline = Date.now() + 2_000;
    while (!running.ledger.responseTo(request.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(effects, 1);
    assert.equal(running.ledger.responseTo(request.id)?.body.ok, true);
    assert.equal(running.ledger.gateCase(request.id), null);
    assert.equal(running.ledger.list().filter((message) => message.word === "gate.asked").length, 0);
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
    assert.equal((running.ledger.responseTo(requested.id)?.body.error as { code?: string } | undefined)?.code, "forbidden");
  } finally { await running.close(); }
});

test("calendar reads proceed while calendar writes wait for the owner's decision", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ash-calendar-gate-"));
  const running = await startOwner({ stateDir, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  const calls: string[] = [];
  try {
    running.members.registerDevice({ id: "device:phone", kind: "device", name: "Phone", online: true,
      capabilities: () => [
        { name: "calendar.search", description: "Find calendar events", label: "Checking your calendar", risk: "none",
          input_schema: { type: "object", properties: {}, additionalProperties: false } },
        { name: "calendar.create", description: "Add a calendar event", label: "Adding a calendar event", risk: "outward",
          input_schema: { type: "object", properties: { calendar_id: { type: "integer" }, title: { type: "string" } },
            required: ["calendar_id", "title"], additionalProperties: false } },
      ],
      handle: (message) => { calls.push(message.word); return { ok: true, result: {} }; } });
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const owner = async (wire: object, screenToken?: string) => {
      const response = await fetch(`${running.url}/api/send`, { method: "POST",
        headers: { ...headers, ...(screenToken ? { "Ash-Screen": screenToken } : {}) }, body: JSON.stringify(wire) });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ id: string; reply?: { body: { ok: boolean } } }>;
    };
    for (const word of ["calendar.search", "calendar.create"]) {
      const grant = await owner({ to: "service:gate", kind: "request", word: "access.grant",
        body: { member: "agent:main", scope: `device:phone/${word}` }, wait: true });
      assert.equal(grant.reply?.body.ok, true);
    }
    const agent = { transport: "agent" as const, member: "agent:main", transportPrincipal: "agent:main",
      local: true, remote: false, ownerProxy: false };
    const read = await running.world.send(agent, { to: "device:phone", kind: "request", word: "calendar.search", body: {} });
    assert.equal(running.ledger.gateCase(read.id), null);
    assert.deepEqual(calls, ["calendar.search"]);

    const screen = running.edge.screens.register({ member: "person:owner", transport: "api", local: true, remote: false,
      ownerProxy: true, transportPrincipal: `token:${createHash("sha256").update(token).digest("hex")}` }, "calendar-scope", "Phone screen");
    const decide = async (requestId: string, choice: "once" | "always" | "deny", before: number) => {
      const until = Date.now() + 2_000;
      while (!running.ledger.gateCase(requestId) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
      const gate = running.ledger.gateCase(requestId);
      assert.ok(gate);
      assert.match(String(running.ledger.byId(gate.askId)?.body.detail), /日历 7|日历 8/);
      assert.equal(calls.length, before);
      await owner({ to: "service:gate", kind: "response", word: "ask", reply_to: gate.askId,
        body: { ok: true, result: { choice } } }, screen.token);
      while (!running.ledger.responseTo(requestId) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(running.ledger.responseTo(requestId));
    };
    const denied = await running.world.send(agent, { to: "device:phone", kind: "request", word: "calendar.create", body: { calendar_id: 7, title: "No write" } });
    await decide(denied.id, "deny", 1);
    assert.deepEqual(calls, ["calendar.search"]);
    assert.equal(running.ledger.responseTo(denied.id)?.body.ok, false);
    const allowed = await running.world.send(agent, { to: "device:phone", kind: "request", word: "calendar.create", body: { calendar_id: 7, title: "Write once" } });
    await decide(allowed.id, "once", 1);
    assert.deepEqual(calls, ["calendar.search", "calendar.create"]);
    assert.equal(running.ledger.responseTo(allowed.id)?.body.ok, true);
    const always = await running.world.send(agent, { to: "device:phone", kind: "request", word: "calendar.create", body: { calendar_id: 7, title: "Remember this calendar" } });
    await decide(always.id, "always", 2);
    assert.equal(calls.length, 3);
    const rule = running.ledger.gateRulesPage().rules[0];
    assert.equal(rule?.object_pattern, "7");
    const repeated = await running.world.send(agent, { to: "device:phone", kind: "request", word: "calendar.create", body: { calendar_id: 7, title: "Another event" } });
    const until = Date.now() + 2_000;
    while (!running.ledger.responseTo(repeated.id) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(running.ledger.gateCase(repeated.id), null);
    assert.equal(calls.length, 4);
    const other = await running.world.send(agent, { to: "device:phone", kind: "request", word: "calendar.create", body: { calendar_id: 8, title: "Other calendar" } });
    await decide(other.id, "deny", 4);
    assert.equal(calls.length, 4);
    const revoke = await owner({ to: "service:gate", kind: "request", word: "rules.revoke", body: { id: rule!.id }, wait: true }, screen.token);
    assert.equal(revoke.reply?.body.ok, true);
    assert.ok(running.ledger.gateRulesPage().rules[0]?.revoked_at);
    const afterRevoke = await running.world.send(agent, { to: "device:phone", kind: "request", word: "calendar.create", body: { calendar_id: 7, title: "No longer automatic" } });
    await decide(afterRevoke.id, "deny", 4);
    assert.equal(calls.length, 4);
  } finally { await running.close(); }
});
