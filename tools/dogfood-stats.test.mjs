import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

test("dogfood stats count observable facts without inventing manual scores or missing costs", () => {
  const dir = mkdtempSync(join(tmpdir(), "ash-dogfood-"));
  const file = join(dir, "ash.db");
  try {
    const db = new DatabaseSync(file);
    db.exec('CREATE TABLE messages (seq INTEGER PRIMARY KEY, id TEXT, ts INTEGER, "from" TEXT, "to" TEXT, kind TEXT, word TEXT, body TEXT, reply_to TEXT)');
    const add = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)');
    const at = Date.parse("2026-10-02T10:00:00Z");
    add.run(1, "say1", at, "agent:main", "person:owner", "request", "say", JSON.stringify({ kind: "offer", text: "Help?" }), null);
    add.run(2, "deliver1", at, "service:post", "service:post", "request", "deliver", JSON.stringify({ message_id: "say1", kind: "offer" }), null);
    add.run(3, "reply1", at, "service:post", "person:owner", "response", "deliver", JSON.stringify({ ok: true, result: { channel: "notification" } }), "deliver1");
    add.run(4, "deliver2", at, "service:post", "service:post", "request", "deliver", JSON.stringify({ message_id: "say1", kind: "offer" }), null);
    add.run(5, "reply2", at, "service:post", "person:owner", "response", "deliver", JSON.stringify({ ok: true, result: { channel: "notification" } }), "deliver2");
    add.run(6, "reflex", at, "service:reflex", null, "event", "reflex.judged", JSON.stringify({ acted: true }), null);
    add.run(7, "known", at, "worker:memory", null, "event", "worker.usage", JSON.stringify({ cost_usd: 0.02 }), null);
    add.run(8, "unknown", at, "worker:memory", null, "event", "worker.usage", JSON.stringify({ cost_usd: null }), null);
    db.close();
    const run = spawnSync(process.execPath, ["tools/dogfood-stats.mjs", file, "2026-10-02"], {
      cwd: process.cwd(), env: { ...process.env, TZ: "UTC" }, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const report = JSON.parse(run.stdout);
    assert.equal(report.days.length, 3);
    assert.deepEqual(report.days[0], {
      day: "2026-10-02", proactive_messages: 1, notification_presentations: 2, duplicate_notifications: 1,
      reflex_stop_decisions: 1, background_cost_usd: 0.02, background_cost_unknown: 1,
      conversation_cost_usd: null, false_interruptions: null, missed_stops: null,
      worthwhile_proactive_messages: null, memory_claims_checked: null,
      memory_claims_correct: null, fabricated_memory_claims: null, abnormal_restarts: null,
    });
    assert.equal(report.days[1].proactive_messages, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
