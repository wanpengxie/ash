import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Message } from "../../../sdk/src/api";

export type StoredTurnReason = "completed" | "cancelled" | "error";
export interface StoredTurn {
  id: string;
  status: "active" | "ended";
  reason: StoredTurnReason | null;
  error: string | null;
  /** The runtime already told the owner what went wrong in this failed turn. */
  told: boolean;
  /** The failed turn this one tries again, when the owner asked to retry it. */
  retryOf: string | null;
  readLogged: boolean;
  startLogged: boolean;
  endLogged: boolean;
}
type Row = Record<string, unknown>;

const turnId = () => `t_${randomBytes(9).toString("base64url")}`;
const decodeTurn = (row: Row): StoredTurn => ({
  id: String(row.id), status: row.status as StoredTurn["status"],
  reason: (row.reason_v2 ?? row.reason) as StoredTurnReason | null, error: row.error === null ? null : String(row.error),
  told: Boolean(row.told), retryOf: row.retry_of === null || row.retry_of === undefined ? null : String(row.retry_of),
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
    CREATE INDEX IF NOT EXISTS inbox_turn ON inbox(turn_id,seq);
    CREATE TABLE IF NOT EXISTS cancel_receipts (
      request_id TEXT PRIMARY KEY, cancelled INTEGER NOT NULL CHECK(cancelled IN (0,1)),
      turn_id TEXT REFERENCES turns(id)
    );
    CREATE TABLE IF NOT EXISTS cancel_intents (
      turn_id TEXT PRIMARY KEY REFERENCES turns(id), request_id TEXT NOT NULL UNIQUE,
      reason TEXT NOT NULL, by_id TEXT, fact TEXT NOT NULL, consumed_at INTEGER
    );`);
    const columns = this.db.prepare("PRAGMA table_info(turns)").all() as Row[];
    if (!columns.some((column) => column.name === "reason_v2")) this.db.exec("ALTER TABLE turns ADD COLUMN reason_v2 TEXT CHECK(reason_v2 IN ('completed','cancelled','error'))");
    if (!columns.some((column) => column.name === "told")) this.db.exec("ALTER TABLE turns ADD COLUMN told INTEGER NOT NULL DEFAULT 0");
    if (!columns.some((column) => column.name === "retry_of")) this.db.exec("ALTER TABLE turns ADD COLUMN retry_of TEXT");
  }

  accept(message: Message, agent = "agent:main"): boolean {
    if (message.kind !== "request" || message.to !== agent || message.word !== "say") throw new TypeError("not an agent say request");
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

  /** Claim the oldest pending messages, in order, as one new turn (a turn takes messages meant for one audience). */
  claim(ids: readonly string[], retryOf?: string): StoredTurn | null {
    if (!ids.length) return null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pending = this.pendingIds();
      if (pending.length < ids.length || ids.some((id, index) => id !== pending[index])) throw new Error("pending inbox changed before claim");
      const id = turnId();
      this.db.prepare("INSERT INTO turns(id,status,created_at,retry_of) VALUES (?,'active',?,?)").run(id, Date.now(), retryOf ?? null);
      let changed = 0;
      for (const message of ids) changed += Number(this.db.prepare("UPDATE inbox SET state='read',turn_id=? WHERE message_id=? AND state='pending'").run(id, message).changes);
      if (changed !== ids.length) throw new Error("incomplete inbox claim");
      this.db.exec("COMMIT");
      return this.turn(id);
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  /** Pending messages the running turn took in mid-work (a steer). They become part of that turn. */
  attach(ids: readonly string[], turn: string): void {
    if (!ids.length) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.turn(turn).status !== "active") throw new Error("steer target turn is not active");
      for (const id of ids) {
        const change = this.db.prepare("UPDATE inbox SET state='read',turn_id=? WHERE message_id=? AND state='pending'").run(turn, id);
        if (Number(change.changes) !== 1) throw new Error("steered message is no longer pending");
      }
      this.db.exec("COMMIT");
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  /** Give steered messages back to the queue when their turn was stopped, so the next turn answers them. */
  release(ids: readonly string[], turn: string): void {
    for (const id of ids) this.db.prepare("UPDATE inbox SET state='pending',turn_id=NULL WHERE message_id=? AND turn_id=? AND state='read'").run(id, turn);
  }

  turn(id: string): StoredTurn {
    const row = this.db.prepare("SELECT * FROM turns WHERE id=?").get(id) as Row | undefined;
    if (!row) throw new Error("unknown inbox turn");
    return decodeTurn(row);
  }

  activeTurn(): StoredTurn | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE status='active' ORDER BY rowid DESC LIMIT 1").get() as Row | undefined;
    return row ? decodeTurn(row) : null;
  }

  /** Store a replay-safe result and cancellation intent together before any cross-database settlement. */
  recordCancel(requestId: string, reason: string, by: string | undefined, fact: string): { cancelled: boolean; turn: string | null } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT cancelled,turn_id FROM cancel_receipts WHERE request_id=?").get(requestId) as Row | undefined;
      if (prior) { this.db.exec("COMMIT"); return { cancelled: Boolean(prior.cancelled), turn: prior.turn_id === null ? null : String(prior.turn_id) }; }
      const active = this.activeTurn();
      const existing = active ? this.db.prepare("SELECT request_id FROM cancel_intents WHERE turn_id=?").get(active.id) as Row | undefined : undefined;
      const cancelled = Boolean(active && !existing);
      this.db.prepare("INSERT INTO cancel_receipts(request_id,cancelled,turn_id) VALUES (?,?,?)").run(requestId, cancelled ? 1 : 0, cancelled ? active!.id : null);
      if (cancelled) this.db.prepare("INSERT INTO cancel_intents(turn_id,request_id,reason,by_id,fact) VALUES (?,?,?,?,?)").run(active!.id, requestId, reason, by ?? null, fact);
      this.db.exec("COMMIT");
      return { cancelled, turn: cancelled ? active!.id : null };
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  cancelIntents(): string[] {
    return (this.db.prepare("SELECT turn_id FROM cancel_intents ORDER BY rowid").all() as Row[]).map((row) => String(row.turn_id));
  }

  stopFacts(): { turn: string; text: string }[] {
    return (this.db.prepare("SELECT turn_id,fact FROM cancel_intents WHERE consumed_at IS NULL ORDER BY rowid").all() as Row[])
      .map((row) => ({ turn: String(row.turn_id), text: String(row.fact) }));
  }

  consumeStopFacts(turns: readonly string[]): void {
    for (const turn of turns) this.db.prepare("UPDATE cancel_intents SET consumed_at=? WHERE turn_id=? AND consumed_at IS NULL").run(Date.now(), turn);
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

  finish(id: string, reason: StoredTurnReason, error?: string, told = false): StoredTurn {
    this.db.prepare("UPDATE turns SET status='ended',reason=?,reason_v2=?,error=?,told=? WHERE id=? AND status='active'").run(reason === "cancelled" ? "error" : reason, reason, error ?? null, told ? 1 : 0, id);
    return this.turn(id);
  }

  /** The most recent turns, newest first. */
  recentTurns(limit: number): StoredTurn[] {
    return (this.db.prepare("SELECT * FROM turns ORDER BY rowid DESC LIMIT ?").all(limit) as Row[]).map(decodeTurn);
  }

  interruptActive(): StoredTurn[] {
    this.db.prepare("UPDATE turns SET status='ended',reason='error',reason_v2='error',error='Interrupted by process restart' WHERE status='active'").run();
    return this.turnsNeedingEvents();
  }

  counts(): { pending: number; read: number; active: number } {
    const row = this.db.prepare("SELECT (SELECT COUNT(*) FROM inbox WHERE state='pending') AS pending, (SELECT COUNT(*) FROM inbox WHERE state='read') AS read, (SELECT COUNT(*) FROM turns WHERE status='active') AS active").get() as Row;
    return { pending: Number(row.pending), read: Number(row.read), active: Number(row.active) };
  }

  close(): void { this.db.close(); }
}
