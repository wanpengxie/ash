import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Message } from "../../../sdk/src/api";

export type StoredTurnReason = "completed" | "error";
export interface StoredTurn {
  id: string;
  status: "active" | "ended";
  reason: StoredTurnReason | null;
  error: string | null;
  readLogged: boolean;
  startLogged: boolean;
  endLogged: boolean;
}
type Row = Record<string, unknown>;

const turnId = () => `t_${randomBytes(9).toString("base64url")}`;
const decodeTurn = (row: Row): StoredTurn => ({
  id: String(row.id), status: row.status as StoredTurn["status"],
  reason: row.reason as StoredTurnReason | null, error: row.error === null ? null : String(row.error),
  readLogged: Boolean(row.read_logged), startLogged: Boolean(row.start_logged), endLogged: Boolean(row.end_logged),
});

/** Private durable intake. The ledger owns the message body; this DB stores only references and turn state. */
export class AgentInbox {
  private readonly db: DatabaseSync;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const file = join(stateDir, "agent-inbox.db");
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
    this.db.exec(`CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('active','ended')),
      reason TEXT CHECK(reason IN ('completed','error')), error TEXT,
      read_logged INTEGER NOT NULL DEFAULT 0, start_logged INTEGER NOT NULL DEFAULT 0,
      end_logged INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inbox (
      message_id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN ('pending','read')),
      turn_id TEXT REFERENCES turns(id), received_logged INTEGER NOT NULL DEFAULT 0,
      CHECK ((state='pending' AND turn_id IS NULL) OR (state='read' AND turn_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(state,seq);
    CREATE INDEX IF NOT EXISTS inbox_turn ON inbox(turn_id,seq);`);
  }

  accept(message: Message): boolean {
    if (message.kind !== "request" || message.to !== "agent:main" || message.word !== "say") throw new TypeError("not an agent say request");
    const result = this.db.prepare("INSERT OR IGNORE INTO inbox(message_id,seq,state) VALUES (?,?,'pending')").run(message.id, message.seq);
    const row = this.db.prepare("SELECT seq FROM inbox WHERE message_id=?").get(message.id) as Row | undefined;
    if (!row || Number(row.seq) !== message.seq) throw new Error("inbox message identity collision");
    return Number(result.changes) === 1;
  }

  pendingIds(): string[] {
    return (this.db.prepare("SELECT message_id FROM inbox WHERE state='pending' ORDER BY seq").all() as Row[]).map((row) => String(row.message_id));
  }

  unreceivedIds(): string[] {
    return (this.db.prepare("SELECT message_id FROM inbox WHERE received_logged=0 ORDER BY seq").all() as Row[]).map((row) => String(row.message_id));
  }

  markReceived(id: string): void { this.db.prepare("UPDATE inbox SET received_logged=1 WHERE message_id=?").run(id); }

  claim(ids: readonly string[]): StoredTurn | null {
    if (!ids.length) return null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pending = this.pendingIds();
      if (pending.length !== ids.length || pending.some((id, index) => id !== ids[index])) throw new Error("pending inbox changed before claim");
      const id = turnId();
      this.db.prepare("INSERT INTO turns(id,status,created_at) VALUES (?,'active',?)").run(id, Date.now());
      const change = this.db.prepare("UPDATE inbox SET state='read',turn_id=? WHERE state='pending'").run(id);
      if (Number(change.changes) !== ids.length) throw new Error("incomplete inbox claim");
      this.db.exec("COMMIT");
      return this.turn(id);
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  turn(id: string): StoredTurn {
    const row = this.db.prepare("SELECT * FROM turns WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error("unknown inbox turn");
    return decodeTurn(row);
  }

  turnsNeedingEvents(): StoredTurn[] {
    return (this.db.prepare("SELECT * FROM turns WHERE read_logged=0 OR start_logged=0 OR (status='ended' AND end_logged=0) ORDER BY rowid").all() as Row[]).map(decodeTurn);
  }

  turnIds(id: string): string[] {
    return (this.db.prepare("SELECT message_id FROM inbox WHERE turn_id=? ORDER BY seq").all(id) as Row[]).map((row) => String(row.message_id));
  }

  markTurnEvent(id: string, field: "read_logged" | "start_logged" | "end_logged"): void {
    this.db.prepare(`UPDATE turns SET ${field}=1 WHERE id=?`).run(id);
  }

  finish(id: string, reason: StoredTurnReason, error?: string): StoredTurn {
    this.db.prepare("UPDATE turns SET status='ended',reason=?,error=? WHERE id=? AND status='active'").run(reason, error ?? null, id);
    return this.turn(id);
  }

  interruptActive(): StoredTurn[] {
    this.db.prepare("UPDATE turns SET status='ended',reason='error',error='Interrupted by process restart' WHERE status='active'").run();
    return this.turnsNeedingEvents();
  }

  counts(): { pending: number; read: number; active: number } {
    const row = this.db.prepare("SELECT (SELECT COUNT(*) FROM inbox WHERE state='pending') AS pending, (SELECT COUNT(*) FROM inbox WHERE state='read') AS read, (SELECT COUNT(*) FROM turns WHERE status='active') AS active").get() as Row;
    return { pending: Number(row.pending), read: Number(row.read), active: Number(row.active) };
  }

  close(): void { this.db.close(); }
}
