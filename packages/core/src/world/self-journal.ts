import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

type Row = Record<string, unknown>;
export type SelfOperation = { id: string; digest: string; path: string; word: string; by: string; oldHash: string | null; newHash: string; snapshotTs: number | null; result: Record<string, unknown>; summary: string; state: "intent" | "committed" | "conflict" | "aborted" };

function decode(row: Row): SelfOperation {
  return { id: String(row.id), digest: String(row.digest), path: String(row.path), word: String(row.word), by: String(row.by),
    oldHash: row.old_hash === null ? null : String(row.old_hash), newHash: String(row.new_hash),
    snapshotTs: row.snapshot_ts === null ? null : Number(row.snapshot_ts), result: JSON.parse(String(row.result)),
    summary: String(row.summary), state: row.state as SelfOperation["state"] };
}

/** Durable authorization intent; the ledger owns request/event/response messages. */
export class SelfJournal {
  private readonly db: DatabaseSync;
  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const file = join(stateDir, "self-operations.db");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS self_operations (
      id TEXT PRIMARY KEY, digest TEXT NOT NULL, path TEXT NOT NULL, word TEXT NOT NULL, by TEXT NOT NULL,
      old_hash TEXT, new_hash TEXT NOT NULL, snapshot_ts INTEGER, result TEXT NOT NULL, summary TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('intent','committed','conflict','aborted'))
    );`);
  }
  get(id: string): SelfOperation | null {
    const row = this.db.prepare("SELECT * FROM self_operations WHERE id=?").get(id) as Row | undefined;
    return row ? decode(row) : null;
  }
  insert(op: SelfOperation): void {
    this.db.prepare("INSERT INTO self_operations(id,digest,path,word,by,old_hash,new_hash,snapshot_ts,result,summary,state) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(op.id, op.digest, op.path, op.word, op.by, op.oldHash, op.newHash, op.snapshotTs, JSON.stringify(op.result), op.summary, op.state);
  }
  state(id: string, state: SelfOperation["state"]): void { this.db.prepare("UPDATE self_operations SET state=? WHERE id=?").run(state, id); }
  active(): SelfOperation[] { return (this.db.prepare("SELECT * FROM self_operations WHERE state IN ('intent','committed') ORDER BY rowid").all() as Row[]).map(decode); }
  close(): void { this.db.close(); }
}
