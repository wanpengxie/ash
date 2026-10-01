import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";
import { Ledger } from "../../src/world/ledger";

test("production DSH configuration fails before migration rather than falling back to echo", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-v2-boot-"));
  const stateDir = join(root, "state");
  await assert.rejects(startOwner({ stateDir, agents: [{ id: "agent:main", runtime: "dsh" }] }), /ASH-206/);
  assert.equal(existsSync(stateDir), false);
});

test("real production main serves only v2 routes with explicit echo and one durable inbox", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ash-v2-boot-"));
  const running = await startOwner({ stateDir, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
  try {
    const auth = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const headers = { authorization: `Bearer ${auth}`, "content-type": "application/json" };
    const old = await fetch(`${running.url}/api/agents`, { headers });
    assert.equal(old.status, 404);
    const describe = await fetch(`${running.url}/api/describe?member=agent:main`, { headers });
    assert.equal(describe.status, 200);
    assert.equal(((await describe.json()) as { members: { words: { word: string }[] }[] }).members[0].words.some((word) => word.word === "say"), true);
    const request = { to: "agent:main", kind: "request", word: "say", body: { text: "controlled echo input" }, client_id: "boot-say" };
    const accepted = await fetch(`${running.url}/api/send`, { method: "POST", headers, body: JSON.stringify(request) });
    assert.equal(accepted.status, 200);
    const first = await accepted.json() as { id: string; seq: number };
    const retry = await fetch(`${running.url}/api/send`, { method: "POST", headers, body: JSON.stringify(request) });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json() as { id: string }).id, first.id);
    assert.equal(running.ledger.list().filter((message) => message.id === first.id).length, 1);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !running.ledger.list().some((message) => message.from === "agent:main" && message.word === "say")) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(running.ledger.list().some((message) => message.from === "agent:main" && message.word === "say"), true);
    assert.equal(existsSync(join(stateDir, "ash.db")), true);
    assert.equal(existsSync(join(stateDir, "agent-main", "agent-inbox.db")), true);
  } finally { await running.close(); }
});

test("production recovery rechecks a stable local token digest and fails closed after revocation", async () => {
  for (const active of [true, false]) {
    const stateDir = mkdtempSync(join(tmpdir(), "ash-v2-recovery-"));
    const oldToken = "controlled-old-high-entropy-token";
    const currentToken = active ? oldToken : "controlled-new-high-entropy-token";
    writeFileSync(join(stateDir, "tokens.json"), JSON.stringify({ api: { [currentToken]: "person:owner" }, mcp: {} }), { mode: 0o600 });
    const ledger = await Ledger.open(join(stateDir, "ash.db"));
    const request = ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "controlled recovery" } }, undefined,
      { deadlineAt: Date.now() + 30_000, context: { member: "person:owner", local: true, remote: false, ownerProxy: true,
        transportPrincipal: `token:${createHash("sha256").update(oldToken).digest("hex")}` } }).message;
    ledger.close();
    const running = await startOwner({ stateDir, listen: "127.0.0.1:0", agents: [{ id: "agent:main", runtime: "echo" }] });
    try {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && !running.ledger.responseTo(request.id)) await new Promise((resolve) => setTimeout(resolve, 10));
      const response = running.ledger.responseTo(request.id);
      assert.ok(response);
      assert.equal(response.body.ok, active);
      if (!active) {
        assert.equal((response.body.error as { code: string }).code, "forbidden");
        assert.equal(running.ledger.list().some((message) => message.from === "agent:main" && message.kind === "request" && message.word === "say"), false);
      }
    } finally { await running.close(); }
  }
});
