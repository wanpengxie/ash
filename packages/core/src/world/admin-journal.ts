import { DatabaseSync } from "node:sqlite";
import type { Message } from "../../../sdk/src/api";

type Row = Record<string, unknown>;

/** The sole production writer of the durable pause fact. Commands are keyed by accepted message ID. */
export class AdminJournal {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    try {
      this.db.exec("PRAGMA synchronous=FULL");
      this.db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      this.db.exec(`CREATE TABLE IF NOT EXISTS admin_pause_commands (
        request_id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, paused INTEGER NOT NULL CHECK(paused IN (0,1)));`);
    } catch (error) { this.db.close(); throw error; }
  }

  isPaused(): boolean {
    const row = this.db.prepare("SELECT value FROM kv WHERE key='v2:admin:paused'").get() as Row | undefined;
    if (!row) return false;
    try { const value = JSON.parse(String(row.value)) as unknown; if (typeof value === "boolean") return value; }
    catch { /* fail closed; a malformed value is never silently treated as false */ }
    throw new TypeError("invalid durable pause state");
  }

  /** An older accepted command cannot undo a newer one, including after a restart. */
  apply(message: Message, paused: boolean): { applied: boolean; paused: boolean } {
    if (message.kind !== "request" || message.to !== "service:admin" || !["pause", "resume"].includes(message.word) ||
      (message.word === "pause") !== paused || !Number.isSafeInteger(message.seq) || message.seq <= 0) throw new TypeError("invalid admin command");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.isPaused();
      const latest = Number((this.db.prepare("SELECT MAX(seq) AS seq FROM admin_pause_commands").get() as Row).seq ?? 0);
      const prior = this.db.prepare("SELECT seq,paused FROM admin_pause_commands WHERE request_id=?").get(message.id) as Row | undefined;
      if (prior && (Number(prior.seq) !== message.seq || Boolean(prior.paused) !== paused)) throw new TypeError("admin command changed after acceptance");
      if (message.seq < latest || (message.seq === latest && !prior)) {
        this.db.exec("COMMIT");
        return { applied: false, paused: current };
      }
      if (!prior) {
        this.db.prepare("INSERT INTO admin_pause_commands(request_id,seq,paused) VALUES(?,?,?)").run(message.id, message.seq, paused ? 1 : 0);
        this.db.prepare("INSERT INTO kv(key,value) VALUES('v2:admin:paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(JSON.stringify(paused));
      } else if (current !== paused) throw new TypeError("admin pause fact conflicts with committed command");
      this.db.exec("COMMIT");
      return { applied: true, paused };
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  close(): void { this.db.close(); }
}
