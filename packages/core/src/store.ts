// Durable state of one space: the append-only event log, timers, and idempotency keys.
// node:sqlite (Node >= 22.5) keeps core dependency-free.

import { DatabaseSync } from "node:sqlite";
import type { AshEvent, EventType, Timer } from "../../sdk/src/api";

export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, workspace TEXT NOT NULL,
        member TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_ws ON events (workspace, seq);
      CREATE TABLE IF NOT EXISTS timers (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, text TEXT NOT NULL, fire_at INTEGER NOT NULL,
        repeat_seconds INTEGER, created_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_ids (id TEXT PRIMARY KEY, ts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  append(workspace: string, member: string, type: EventType, data: Record<string, unknown>): AshEvent {
    const ts = Date.now();
    const r = this.db.prepare("INSERT INTO events (ts, workspace, member, type, data) VALUES (?, ?, ?, ?, ?)").run(ts, workspace, member, type, JSON.stringify(data));
    return { seq: Number(r.lastInsertRowid), ts, workspace, member, type, data };
  }

  events(q: { after?: number; limit?: number; workspace?: string; type?: string }): AshEvent[] {
    const where = ["seq > ?"];
    const args: (string | number)[] = [q.after ?? 0];
    if (q.workspace) where.push("workspace = ?"), args.push(q.workspace);
    if (q.type) where.push("type = ?"), args.push(q.type);
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ${limit}`).all(...args) as Record<string, unknown>[];
    return rows.map((r) => ({ seq: Number(r.seq), ts: Number(r.ts), workspace: String(r.workspace), member: String(r.member), type: r.type as EventType, data: JSON.parse(String(r.data)) }));
  }

  recent(limit: number, workspace?: string): AshEvent[] {
    const rows = (workspace
      ? this.db.prepare("SELECT * FROM events WHERE workspace = ? ORDER BY seq DESC LIMIT ?").all(workspace, limit)
      : this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?").all(limit)) as Record<string, unknown>[];
    return rows.reverse().map((r) => ({ seq: Number(r.seq), ts: Number(r.ts), workspace: String(r.workspace), member: String(r.member), type: r.type as EventType, data: JSON.parse(String(r.data)) }));
  }

  /** Record an idempotency key; false if it was already used. */
  claimMessageId(id: string): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO message_ids (id, ts) VALUES (?, ?)").run(id, Date.now());
    return Number(r.changes) === 1;
  }

  putTimer(t: Timer): void {
    this.db.prepare("INSERT OR REPLACE INTO timers (id, owner, text, fire_at, repeat_seconds, created_by) VALUES (?, ?, ?, ?, ?, ?)").run(t.id, t.owner, t.text, t.fire_at, t.repeat_seconds, t.created_by);
  }

  timers(owner?: string): Timer[] {
    const rows = (owner ? this.db.prepare("SELECT * FROM timers WHERE owner = ? ORDER BY fire_at").all(owner) : this.db.prepare("SELECT * FROM timers ORDER BY fire_at").all()) as Record<string, unknown>[];
    return rows.map((r) => ({ id: String(r.id), owner: String(r.owner), text: String(r.text), fire_at: Number(r.fire_at), repeat_seconds: r.repeat_seconds === null ? null : Number(r.repeat_seconds), created_by: String(r.created_by) }));
  }

  deleteTimer(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM timers WHERE id = ?").run(id).changes) === 1;
  }

  get(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }

  set(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
  }
}
