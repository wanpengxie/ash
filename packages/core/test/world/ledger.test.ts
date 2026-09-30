import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Ledger, type MigrationStage } from "../../src/world/ledger";

const fixture = fileURLToPath(new URL("../fixtures/v10-ash.db", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
function isolated(): string {
  const dir = mkdtempSync(join(tmpdir(), "ash-ledger-"));
  const path = join(dir, "ash.db");
  copyFileSync(fixture, path);
  return path;
}
function rows(file: string, table: string): Record<string, unknown>[] {
  const db = new DatabaseSync(file);
  try { return db.prepare(`SELECT * FROM ${table} ORDER BY seq`).all() as Record<string, unknown>[]; }
  finally { db.close(); }
}

test("synthetic v10 migration preserves conversation, order, timestamps and legacy archive", async () => {
  const file = isolated();
  const old = rows(file, "events");
  const ledger = await Ledger.open(file);
  try {
    assert.equal(ledger.migration.migrated, old.length);
    assert.equal(ledger.migration.lastLegacySeq, old.at(-1)!.seq);
    assert.ok(ledger.migration.backup && existsSync(ledger.migration.backup));
    assert.equal(statSync(ledger.migration.backup!).mode & 0o077, 0);
    const backup = new DatabaseSync(ledger.migration.backup!);
    try { assert.equal(Object.values(backup.prepare("PRAGMA integrity_check").get()!)[0], "ok"); }
    finally { backup.close(); }
    assert.deepEqual(rows(file, "events"), old, "old events remain intact and read-only after migration");
    const migrated = ledger.list({ limit: 100 });
    assert.deepEqual(migrated.map((m) => m.seq), old.map((e) => e.seq));
    assert.deepEqual(migrated.map((m) => m.ts), old.map((e) => e.ts));
    assert.equal(migrated[0].word, "say");
    assert.equal(migrated[0].body.text, "Synthetic hello");
    assert.deepEqual(migrated[0].body.legacy, { seq: old[0].seq, workspace: "home", member: "person:owner" });
    assert.equal((migrated[0].body.attachments as unknown[]).length, 1);
    assert.equal(migrated[7].body.text, "Synthetic answer");
    assert.equal(migrated[7].body.kind, "reply");
    assert.equal(migrated[7].reply_to, migrated[0].id);
    assert.deepEqual(migrated[1].body.ids, [migrated[0].id]);
    assert.equal(migrated[1].body.turn, migrated[1].turn);
    assert.equal(migrated[8].body.turn, migrated[1].turn);
    assert.equal(migrated[5].turn, migrated[1].turn);
    assert.equal(migrated[13].body.text, "Synthetic second workspace");
    assert.deepEqual(migrated[13].body.legacy, { seq: old[13].seq, workspace: "secondary", member: "person:owner" });
    assert.deepEqual(migrated[14].body.legacy, { seq: old[14].seq, workspace: "secondary", member: "agent:helper" });
    assert.equal(migrated[14].from, "agent:helper");
    assert.equal(migrated[13].to, "agent:helper");
    assert.equal(migrated[14].reply_to, migrated[13].id);
    assert.equal(migrated[3].kind, "request");
    assert.equal(migrated[4].kind, "response");
    assert.equal(migrated[4].reply_to, migrated[3].id);
    assert.equal(migrated[6].reply_to, migrated[5].id);
    assert.equal(migrated[6].from, "device:lab");
    const serialized = JSON.stringify(migrated);
    for (const forbidden of ["synthetic-secret-must-not-migrate", "synthetic-private-result-must-not-migrate", "synthetic-unknown-must-not-migrate"]) assert.ok(!serialized.includes(forbidden));
    assert.equal(migrated[15].body.legacy_seq, old.at(-1)!.seq);
    const readonly = new DatabaseSync(file);
    try { assert.throws(() => readonly.prepare("DELETE FROM events WHERE seq=1").run(), /read-only/); }
    finally { readonly.close(); }
  } finally { ledger.close(); }
  const again = await Ledger.open(file);
  try { assert.equal(again.migration.migrated, 0); assert.equal(again.list({ limit: 100 }).length, old.length); }
  finally { again.close(); }
});

test("append and stable-transport retry claim commit atomically; response settles once", async () => {
  const file = isolated();
  const ledger = await Ledger.open(file);
  try {
    const input = { from: "person:owner", to: "agent:main", kind: "request" as const, word: "say", body: { text: "Hi", meta: { a: 1, b: 2 } } };
    const retry = { transportPrincipal: "paired-device:synthetic", clientId: "retry-1" };
    const first = ledger.append(input, retry);
    assert.equal(first.duplicate, false);
    assert.equal(first.message.seq, 17);
    input.body.meta.a = 99;
    assert.equal((first.message.body.meta as { a: number }).a, 1, "returned message must not share mutable caller body");
    input.body.meta.a = 1;
    const second = ledger.append({ ...input, body: { meta: { b: 2, a: 1 }, text: "Hi" } }, retry);
    assert.equal(second.duplicate, true);
    assert.deepEqual(second.message, first.message);
    assert.throws(() => ledger.append({ ...input, body: { text: "Changed" } }, retry), /different message/);
    assert.throws(() => ledger.append({ ...input, kind: "bogus" as "request" }), /invalid message envelope/);
    assert.equal(ledger.lastSeq(), 17);
    const response = ledger.settle(first.message.id, "agent:main", { ok: true, result: { accepted: true } });
    assert.equal(response.settled, true);
    assert.equal(response.message.reply_to, first.message.id);
    assert.equal(response.message.word, "say");
    assert.equal(response.message.to, "person:owner");
    const late = ledger.settle(first.message.id, "agent:main", { ok: false, error: { code: "cancelled", message: "late" } });
    assert.equal(late.settled, false);
    assert.equal(late.message.id, response.message.id);
    assert.equal(ledger.lastSeq(), 18);
    assert.throws(() => ledger.settle(first.message.id, "device:other", { ok: true }), /sender/);
    assert.equal(ledger.list({ before: 18, limit: 2 }).at(-1)?.seq, 17);
  } finally { ledger.close(); }
  const reopened = await Ledger.open(file);
  try {
    assert.equal(reopened.migration.migrated, 0);
    assert.equal(reopened.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { meta: { a: 1, b: 2 }, text: "Hi" } }, { transportPrincipal: "paired-device:synthetic", clientId: "retry-1" }).duplicate, true);
    assert.equal(reopened.lastSeq(), 18);
  } finally { reopened.close(); }
});

for (const stage of ["before-transaction", "after-schema", "after-first-row", "halfway", "before-commit", "after-commit"] as MigrationStage[]) {
  test(`SIGKILL at ${stage} recovers without missing or duplicate messages`, async () => {
    const file = isolated();
    const source = `import { Ledger } from './packages/core/src/world/ledger.ts'; await Ledger.open(${JSON.stringify(file)}, {failpoint: (at) => { if (at === ${JSON.stringify(stage)}) process.kill(process.pid, 'SIGKILL'); }});`;
    const child = spawnSync(process.execPath, ["--expose-internals", "--import", "tsx", "--input-type=module", "-e", source], { cwd: repo, timeout: 20_000 });
    assert.equal(child.signal, "SIGKILL", child.stderr.toString());
    const ledger = await Ledger.open(file);
    try {
      assert.equal(ledger.list({ limit: 100 }).length, 16);
      assert.deepEqual(ledger.list({ limit: 100 }).map((m) => m.seq), rows(file, "events").map((e) => e.seq));
      assert.equal(ledger.migration.migrated, stage === "after-commit" ? 0 : 16);
      assert.ok(existsSync(`${file}.v10.backup`));
    } finally { ledger.close(); }
    const repeat = await Ledger.open(file);
    try { assert.equal(repeat.migration.migrated, 0); assert.equal(repeat.lastSeq(), 16); }
    finally { repeat.close(); }
  });
}

test("online backup includes committed rows still resident in a live WAL", async () => {
  const file = isolated();
  const writer = new DatabaseSync(file);
  try {
    writer.exec("PRAGMA journal_mode=WAL");
    writer.prepare("INSERT INTO events(ts,workspace,member,type,data) VALUES(?,?,?,?,?)").run(1_700_000_001_000, "home", "person:owner", "message.delivered", JSON.stringify({ to: "agent:main", from: "person:owner", text: "WAL tail", message_id: "msg-tail" }));
    assert.ok(existsSync(`${file}-wal`));
    const ledger = await Ledger.open(file);
    try {
      assert.equal(ledger.migration.migrated, 17);
      assert.equal(ledger.list({ limit: 100 }).at(-1)?.body.text, "WAL tail");
      assert.equal(rows(`${file}.v10.backup`, "events").length, 17);
    } finally { ledger.close(); }
  } finally { writer.close(); }
});

test("a failed attempt followed by new v1 events keeps the first backup and takes a fresh one", async () => {
  const file = isolated();
  await assert.rejects(Ledger.open(file, { failpoint: (stage) => { if (stage === "before-transaction") throw new Error("injected"); } }), /injected/);
  const writer = new DatabaseSync(file);
  try { writer.prepare("INSERT INTO events(ts,workspace,member,type,data) VALUES(?,?,?,?,?)").run(1_700_000_001_001, "home", "person:owner", "message.delivered", JSON.stringify({ to: "agent:main", from: "person:owner", text: "late", message_id: "msg-late" })); }
  finally { writer.close(); }
  const ledger = await Ledger.open(file);
  try {
    assert.equal(ledger.migration.migrated, 17);
    assert.equal(ledger.list({ limit: 100 }).at(-1)?.body.text, "late");
    assert.equal(rows(`${file}.v10.backup`, "events").length, 16);
    assert.equal(rows(ledger.migration.backup!, "events").length, 17);
  } finally { ledger.close(); }
});

test("same event max with changed middle row or another durable table never reuses an old backup", async () => {
  for (const changed of ["event", "timer"] as const) {
    const file = isolated();
    const originalBackup = `${file}.v10.backup`;
    copyFileSync(file, originalBackup);
    const db = new DatabaseSync(file);
    try {
      if (changed === "event") db.prepare("UPDATE events SET data=? WHERE seq=4").run(JSON.stringify({ name: "calendar.search", args: { synthetic: "changed" }, message_id: "msg-a" }));
      else db.prepare("INSERT INTO timers(id,owner,text,fire_at,repeat_seconds,created_by) VALUES(?,?,?,?,?,?)").run("timer-late", "agent:main", "synthetic", 123, null, "person:owner");
    } finally { db.close(); }
    const oldMax = Number(rows(originalBackup, "events").at(-1)!.seq);
    const ledger = await Ledger.open(file);
    try {
      assert.equal(ledger.migration.lastLegacySeq, oldMax);
      assert.notEqual(ledger.migration.backup, originalBackup);
      assert.ok(ledger.migration.backup && existsSync(ledger.migration.backup));
      assert.equal(rows(originalBackup, "events").length, 16);
      const current = new DatabaseSync(file);
      const safe = new DatabaseSync(ledger.migration.backup!);
      const prior = new DatabaseSync(originalBackup);
      try {
        if (changed === "event") {
          const read = (database: DatabaseSync) => (database.prepare("SELECT data FROM events WHERE seq=4").get() as { data: string }).data;
          assert.notEqual(read(prior), read(current));
          assert.equal(read(safe), read(current));
        } else {
          assert.equal((prior.prepare("SELECT COUNT(*) n FROM timers").get() as { n: number }).n, 0);
          assert.equal((safe.prepare("SELECT COUNT(*) n FROM timers").get() as { n: number }).n, 1);
        }
      } finally { current.close(); safe.close(); prior.close(); }
    } finally { ledger.close(); }
  }
});

test("an existing corrupt backup blocks migration and is never overwritten", async () => {
  const file = isolated();
  const backup = `${file}.v10.backup`;
  writeFileSync(backup, "not a SQLite database");
  await assert.rejects(Ledger.open(file));
  assert.equal(existsSync(backup), true);
  const db = new DatabaseSync(file);
  try { assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get(), undefined); }
  finally { db.close(); }
});

test("a committed client retry survives process death before acknowledgement", async () => {
  const file = isolated();
  const source = `import { Ledger } from './packages/core/src/world/ledger.ts'; const db=await Ledger.open(${JSON.stringify(file)}); db.append({from:'person:owner',to:'agent:main',kind:'request',word:'say',body:{text:'synthetic'}},{transportPrincipal:'paired:synthetic',clientId:'crash-retry'}); process.kill(process.pid,'SIGKILL');`;
  const child = spawnSync(process.execPath, ["--expose-internals", "--import", "tsx", "--input-type=module", "-e", source], { cwd: repo, timeout: 20_000 });
  assert.equal(child.signal, "SIGKILL", child.stderr.toString());
  const ledger = await Ledger.open(file);
  try {
    const retried = ledger.append({ from: "person:owner", to: "agent:main", kind: "request", word: "say", body: { text: "synthetic" } }, { transportPrincipal: "paired:synthetic", clientId: "crash-retry" });
    assert.equal(retried.duplicate, true);
    assert.equal(ledger.lastSeq(), 17);
  } finally { ledger.close(); }
});
