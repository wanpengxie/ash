import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startOwner } from "../../src/main.ts";

test("uncertain clock cancel acknowledgement replays the same fact after a core restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-clock-cancel-ui-"));
  const config = { stateDir: join(dir, "state"), listen: "127.0.0.1:0",
    agents: [{ id: "agent:main" as const, runtime: "echo" as const }] };
  let owner: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    owner = await startOwner(config);
    const send = async (word: string, body: Record<string, unknown>, client_id?: string) => {
      const credential = Object.entries(owner!.tokens.api).find(([, member]) => member === "person:owner")![0];
      const response = await fetch(`${owner!.url}/api/send`, { method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify({ to: "service:clock", kind: "request", word, body, wait: true,
          ...(client_id ? { client_id } : {}) }) });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ id: string; seq: number; reply: { body: { ok: boolean; result: Record<string, unknown> } } }>;
    };
    const set = await send("set", { at: Date.now() + 3_600_000, to: "agent:main", word: "say",
      body: { text: "synthetic reminder" }, label: "synthetic reminder" });
    assert.equal(set.reply.body.ok, true);
    const timerId = String(set.reply.body.result.id);
    const intent = "synthetic-cancel-retry-one";
    const first = await send("cancel", { id: timerId }, intent);
    assert.deepEqual(first.reply.body.result, { cancelled: true });
    const firstRequest = owner.ledger.list({ limit: 1000 }).filter((row) => row.kind === "request" && row.to === "service:clock" && row.word === "cancel");
    assert.equal(firstRequest.length, 1);
    await owner.close(); owner = null;
    owner = await startOwner(config);
    const retry = await send("cancel", { id: timerId }, intent);
    assert.equal(retry.id, first.id);
    assert.equal(retry.seq, first.seq);
    assert.deepEqual(retry.reply.body.result, { cancelled: true });
    const afterRestart = owner.ledger.list({ limit: 1000 }).filter((row) => row.kind === "request" && row.to === "service:clock" && row.word === "cancel");
    assert.equal(afterRestart.length, 1, "restart cannot create a second cancellation command");
    const list = await send("list", {});
    assert.deepEqual(list.reply.body.result.timers, []);
  } finally {
    await owner?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
