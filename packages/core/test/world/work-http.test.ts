import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";

test("production echo entry exposes real work member but no unimplemented flow or second alarm", async () => {
  const root = mkdtempSync(join(tmpdir(), "ash-work-http-"));
  const running = await startOwner({ stateDir: join(root, "state"), listen: "127.0.0.1:0",
    agents: [{ id: "agent:main", runtime: "echo" }] });
  try {
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const describe = await fetch(`${running.url}/api/describe?member=service:work`, { headers });
    assert.equal(describe.status, 200);
    const detail = await describe.json() as { members: { words: { word: string }[] }[] };
    assert.deepEqual(detail.members[0].words.map((word) => word.word).sort(), ["run", "runs"]);
    const send = async (word: string, body: Record<string, unknown>, authorization = `Bearer ${token}`) => {
      const response = await fetch(`${running.url}/api/send`, { method: "POST", headers: { ...headers, authorization },
        body: JSON.stringify({ to: "service:work", kind: "request", word, body, wait: true }) });
      return { status: response.status, result: await response.json() as { reply?: { body: { ok: boolean; error?: { code: string }; result?: unknown } } } };
    };
    const missing = await send("run", { flow: "memory" });
    assert.equal(missing.status, 200);
    assert.equal(missing.result.reply?.body.error?.code, "not_found");
    assert.equal(running.ledger.workRuns().length, 0);
    assert.equal(running.ledger.list().filter((row) => row.word === "run.start").length, 0);
    const list = await send("runs", {});
    assert.deepEqual(list.result.reply?.body.result, { runs: [] });
    assert.equal((await send("runs", {}, "Bearer invalid")).status, 401);
  } finally { await running.close(); rmSync(root, { recursive: true, force: true }); }
});
