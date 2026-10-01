import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main";

test("production owner clock list/cancel shape feeds the upcoming sheet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-upcoming-"));
  const config = { stateDir: join(dir, "state"), listen: "127.0.0.1:0", agents: [{ id: "agent:main" as const, runtime: "echo" as const }] };
  let running: Awaited<ReturnType<typeof startOwner>> | null = await startOwner(config);
  try {
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")?.[0];
    assert.ok(token);
    const send = async (word: string, body: Record<string, unknown>) => {
      const response = await fetch(`${running!.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ to: "service:clock", kind: "request", word, body, wait: true }) });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ reply: { body: { ok: boolean; result?: { id?: string; cancelled?: boolean; timers?: unknown[] } } } }>;
    };
    assert.deepEqual((await send("list", {})).reply.body.result?.timers, []);
    const at = Date.now() + 180_000;
    const set = await send("set", { at, to: "agent:main", word: "say", body: { text: "synthetic due" }, label: "Synthetic reminder" });
    assert.equal(set.reply.body.ok, true);
    const id = set.reply.body.result?.id;
    assert.equal(typeof id, "string");
    await running.close(); running = null;
    running = await startOwner(config);
    const listed = await send("list", {});
    assert.deepEqual(listed.reply.body.result?.timers, [{ id, next: at, every: null, to: "agent:main", word: "say", label: "Synthetic reminder", blocked: null }]);
    const replyMessage = running.ledger.list({ limit: 1000 }).filter((item) => item.from === "service:clock" && item.kind === "response" && item.word === "list").at(-1);
    assert.ok(replyMessage);
    assert.deepEqual(replyMessage.body, listed.reply.body);
    const cancelled = await send("cancel", { id });
    assert.equal(cancelled.reply.body.result?.cancelled, true);
    assert.deepEqual((await send("list", {})).reply.body.result?.timers, []);
    const denied = await fetch(`${running.url}/api/send`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "service:clock", kind: "request", word: "list", body: {}, wait: true }) });
    assert.notEqual(denied.status, 200, "clock list must not become an unauthenticated UI shortcut");
  } finally { await running?.close(); rmSync(dir, { recursive: true, force: true }); }
});
