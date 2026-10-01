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
        request_id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, paused INTEGER NOT NULL CHECK(paused IN (0,1)), target_turn TEXT);`);
      const columns = this.db.prepare("PRAGMA table_info(admin_pause_commands)").all() as Row[];
      if (!columns.some((column) => column.name === "target_turn")) this.db.exec("ALTER TABLE admin_pause_commands ADD COLUMN target_turn TEXT");
    } catch (error) { this.db.close(); throw error; }
  }

  isPaused(): boolean {
    const row = this.db.prepare("SELECT value FROM kv WHERE key='v2:admin:paused'").get() as Row | undefined;
    if (!row) return false;
    try { const value = JSON.parse(String(row.value)) as unknown; if (typeof value === "boolean") return value; }
    catch { /* fail closed; a malformed value is never silently treated as false */ }
    throw new TypeError("invalid durable pause state");
  }

  quietHours(): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key='v2:delivery:quiet'").get() as Row | undefined;
    return row ? String(row.value) : null;
  }

  setQuietHours(value: string): void {
    this.db.prepare("INSERT INTO kv(key,value) VALUES('v2:delivery:quiet',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(value);
  }

  /** The latest command and KV must agree before a pause can affect restart reconciliation. */
  currentCommand(): { requestId: string; seq: number; paused: boolean; targetTurn: string | null } | null {
    const row = this.db.prepare("SELECT request_id,seq,paused,target_turn FROM admin_pause_commands ORDER BY seq DESC LIMIT 1").get() as Row | undefined;
    const state = this.isPaused();
    if (!row) {
      if (state) throw new TypeError("admin pause state has no committed command");
      return null;
    }
    const seq = Number(row.seq);
    if (!Number.isSafeInteger(seq) || seq <= 0 || typeof row.request_id !== "string" || Boolean(row.paused) !== state ||
      (row.target_turn !== null && (!state || typeof row.target_turn !== "string" || !row.target_turn)))
      throw new TypeError("admin durable state conflicts with latest command");
    return { requestId: row.request_id, seq, paused: state, targetTurn: row.target_turn as string | null };
  }

  /** A committed fact is evidence of a past effect, not permission to run the request again. */
  committedFact(message: Message): { paused: boolean; current: boolean } | null {
    if (message.kind !== "request" || message.to !== "service:admin" || !["pause", "resume"].includes(message.word)) return null;
    const row = this.db.prepare("SELECT seq,paused FROM admin_pause_commands WHERE request_id=?").get(message.id) as Row | undefined;
    if (!row) return null;
    const paused = message.word === "pause";
    if (Number(row.seq) !== message.seq || Boolean(row.paused) !== paused) throw new TypeError("admin committed fact conflicts with accepted request");
    const latest = this.currentCommand();
    if (!latest) throw new TypeError("admin committed fact has no latest command");
    return { paused, current: latest.seq === message.seq };
  }

  /** An older accepted command cannot undo a newer one, including after a restart. */
  apply(message: Message, paused: boolean, targetTurn: string | null = null): { applied: boolean; paused: boolean } {
    if (message.kind !== "request" || message.to !== "service:admin" || !["pause", "resume"].includes(message.word) ||
      (message.word === "pause") !== paused || !Number.isSafeInteger(message.seq) || message.seq <= 0 ||
      (targetTurn !== null && (!paused || typeof targetTurn !== "string" || !targetTurn))) throw new TypeError("invalid admin command");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.isPaused();
      const latest = Number((this.db.prepare("SELECT MAX(seq) AS seq FROM admin_pause_commands").get() as Row).seq ?? 0);
      const prior = this.db.prepare("SELECT seq,paused,target_turn FROM admin_pause_commands WHERE request_id=?").get(message.id) as Row | undefined;
      if (prior && (Number(prior.seq) !== message.seq || Boolean(prior.paused) !== paused || prior.target_turn !== targetTurn)) throw new TypeError("admin command changed after acceptance");
      if (message.seq < latest || (message.seq === latest && !prior)) {
        this.db.exec("COMMIT");
        return { applied: false, paused: current };
      }
      if (!prior) {
        this.db.prepare("INSERT INTO admin_pause_commands(request_id,seq,paused,target_turn) VALUES(?,?,?,?)").run(message.id, message.seq, paused ? 1 : 0, targetTurn);
        this.db.prepare("INSERT INTO kv(key,value) VALUES('v2:admin:paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
          .run(JSON.stringify(paused));
      } else if (current !== paused) throw new TypeError("admin pause fact conflicts with committed command");
      this.db.exec("COMMIT");
      return { applied: true, paused };
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  close(): void { this.db.close(); }
}
