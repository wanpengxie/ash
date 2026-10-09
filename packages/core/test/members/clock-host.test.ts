import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startOwner } from "../../src/main";
import { STUCK_MS } from "../fixtures/wait";

test("production echo bootstrap confirms host alarm on set, restart, and cancel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-clock-host-"));
  const alarms: (number | null)[] = [];
  let alarmAck = true;
  const host = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      assert.equal(req.headers.authorization, "Bearer synthetic-host-token");
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/manifest") return void res.end(JSON.stringify({ name: "Synthetic phone", capabilities: [] }));
      if (req.method === "POST" && req.url === "/alarm") {
        const value = JSON.parse(body) as { at: number | null };
        alarms.push(value.at);
        return void res.end(JSON.stringify({ ok: alarmAck }));
      }
      res.writeHead(404).end("{}");
    });
  });
  await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
  const hostUrl = `http://127.0.0.1:${(host.address() as { port: number }).port}`;
  const config = { stateDir: join(dir, "state"), listen: "127.0.0.1:0", agents: [{ id: "agent:main" as const, runtime: "echo" as const }],
    host: { url: hostUrl, token: "synthetic-host-token" } };
  let running: Awaited<ReturnType<typeof startOwner>> | null = null;
  try {
    running = await startOwner(config);
    assert.deepEqual(alarms, [null]);
    const token = Object.entries(running.tokens.api).find(([, member]) => member === "person:owner")![0];
    const send = async (word: string, body: Record<string, unknown>) => {
      const response = await fetch(`${running!.url}/api/send`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ to: "service:clock", kind: "request", word, body, wait: true }) });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ reply: { body: { ok: boolean; result: Record<string, unknown> } } }>;
    };
    const at = Date.now() + 120_000;
    const unsupportedWake = await send("set", { at, to: "agent:main", word: "wake", body: { reason: "synthetic", context: {} }, label: "Synthetic wake" });
    assert.equal(unsupportedWake.reply.body.ok, false, "production agent has no wake endpoint before its DSH integration");
    const initialDb = new DatabaseSync(join(config.stateDir, "ash.db"));
    try { assert.equal((initialDb.prepare("SELECT COUNT(*) AS n FROM timers").get() as { n: number }).n, 0); }
    finally { initialDb.close(); }
    const set = await send("set", { at, to: "agent:main", word: "say", body: { text: "synthetic" }, label: "Synthetic" });
    assert.equal(set.reply.body.ok, true);
    assert.equal(alarms.at(-1), at);
    const id = String(set.reply.body.result.id);
    await running.close(); running = null;
    const before = alarms.length;
    running = await startOwner(config);
    assert.equal(alarms.length, before + 1);
    assert.equal(alarms.at(-1), at);
    const cancelled = await send("cancel", { id });
    assert.deepEqual(cancelled.reply.body.result, { cancelled: true });
    assert.equal(alarms.at(-1), null);
    const db = new DatabaseSync(join(config.stateDir, "ash.db"));
    try {
      db.prepare("INSERT INTO kv(key,value) VALUES(?,?)").run("v2:admin:paused", "true");
      const dueAt = Date.now() + 1200;
      const paused = await send("set", { at: dueAt, to: "agent:main", word: "say", body: { text: "no delivery" }, label: "Synthetic paused" });
      assert.equal(paused.reply.body.ok, true);
      const deadline = Date.now() + STUCK_MS;
      while (Date.now() < deadline && !running.ledger.list({ limit: 1000 }).some((item) => item.word === "clock.fired" && item.body.outcome === "skipped")) await delay(50);
      assert.equal(running.ledger.list({ limit: 1000 }).filter((item) => item.word === "clock.fired" && item.body.outcome === "skipped").length, 1);
      assert.equal(running.ledger.list({ limit: 1000 }).filter((item) => item.from === "service:clock" && item.word === "say").length, 0);
      db.prepare("UPDATE kv SET value=? WHERE key=?").run("false", "v2:admin:paused");
      await delay(1200);
      assert.equal(running.ledger.list({ limit: 1000 }).filter((item) => item.from === "service:clock" && item.word === "say").length, 0);
    } finally { db.close(); }
    alarmAck = false;
    const retryAt = Date.now() + 120_000;
    const failedAlarm = await send("set", { at: retryAt, to: "agent:main", word: "say", body: { text: "host retry" }, label: "Synthetic host retry" });
    assert.equal(failedAlarm.reply.body.ok, false);
    const pendingDb = new DatabaseSync(join(config.stateDir, "ash.db"));
    const pending = pendingDb.prepare("SELECT id FROM timers WHERE fire_at=?").get(retryAt) as { id: string } | undefined;
    pendingDb.close();
    assert.ok(pending?.id, "timer remains durable after a failed host acknowledgement");
    await running.close(); running = null;
    alarmAck = true;
    running = await startOwner(config);
    assert.equal(alarms.at(-1), retryAt, "restart re-arms the durable timer after host recovery");
    const retriedCancel = await send("cancel", { id: pending.id });
    assert.deepEqual(retriedCancel.reply.body.result, { cancelled: true });
  } finally {
    await running?.close();
    host.closeAllConnections();
    await new Promise<void>((resolve) => host.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
