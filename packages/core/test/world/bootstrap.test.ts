import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";

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
