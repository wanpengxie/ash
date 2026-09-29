// Durable state of one space: the append-only event log, timers, grants, confirmations,
// idempotency keys and small settings. node:sqlite (Node >= 22.5) keeps core dependency-free.

import { DatabaseSync } from "node:sqlite";
import type { AshEvent, Confirmation, EventType, Grant, Timer } from "../../sdk/src/api";

type Row = Record<string, unknown>;

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
      CREATE TABLE IF NOT EXISTS grants (
        id TEXT PRIMARY KEY, member TEXT NOT NULL, scope TEXT NOT NULL, created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL, UNIQUE (member, scope));
      CREATE TABLE IF NOT EXISTS confirms (
        id TEXT PRIMARY KEY, asker TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, kind TEXT NOT NULL,
        state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, answered_by TEXT);
    `);
  }

  // ------------------------------------------------------------------ events

  append(workspace: string, member: string, type: EventType, data: Record<string, unknown>): AshEvent {
    const ts = Date.now();
    const r = this.db.prepare("INSERT INTO events (ts, workspace, member, type, data) VALUES (?, ?, ?, ?, ?)").run(ts, workspace, member, type, JSON.stringify(data));
    return { seq: Number(r.lastInsertRowid), ts, workspace, member, type, data };
  }

  events(q: { after?: number; before?: number; limit?: number; workspace?: string; type?: string; member?: string }): AshEvent[] {
    const where = ["seq > ?"];
    const args: (string | number)[] = [q.after ?? 0];
    if (q.before) where.push("seq < ?"), args.push(q.before);
    if (q.workspace) where.push("workspace = ?"), args.push(q.workspace);
    if (q.type) where.push("type = ?"), args.push(q.type);
    if (q.member) where.push("member = ?"), args.push(q.member);
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    const rows = this.db.prepare(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY seq LIMIT ${limit}`).all(...args) as Row[];
    return rows.map(toEvent);
  }

  recent(limit: number, workspace?: string): AshEvent[] {
    const rows = (workspace
      ? this.db.prepare("SELECT * FROM events WHERE workspace = ? ORDER BY seq DESC LIMIT ?").all(workspace, limit)
      : this.db.prepare("SELECT * FROM events ORDER BY seq DESC LIMIT ?").all(limit)) as Row[];
    return rows.reverse().map(toEvent);
  }

  lastSeq(): number {
    const r = this.db.prepare("SELECT MAX(seq) AS s FROM events").get() as { s: number | null };
    return Number(r.s ?? 0);
  }

  /** Record an idempotency key; false if it was already used. */
  claimMessageId(id: string): boolean {
    const r = this.db.prepare("INSERT OR IGNORE INTO message_ids (id, ts) VALUES (?, ?)").run(id, Date.now());
    return Number(r.changes) === 1;
  }

  // ------------------------------------------------------------------ timers

  putTimer(t: Timer): void {
    this.db.prepare("INSERT OR REPLACE INTO timers (id, owner, text, fire_at, repeat_seconds, created_by) VALUES (?, ?, ?, ?, ?, ?)").run(t.id, t.owner, t.text, t.fire_at, t.repeat_seconds, t.created_by);
  }

  timers(owner?: string): Timer[] {
    const rows = (owner ? this.db.prepare("SELECT * FROM timers WHERE owner = ? ORDER BY fire_at").all(owner) : this.db.prepare("SELECT * FROM timers ORDER BY fire_at").all()) as Row[];
    return rows.map((r) => ({ id: String(r.id), owner: String(r.owner), text: String(r.text), fire_at: Number(r.fire_at), repeat_seconds: r.repeat_seconds === null ? null : Number(r.repeat_seconds), created_by: String(r.created_by) }));
  }

  deleteTimer(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM timers WHERE id = ?").run(id).changes) === 1;
  }

  // ------------------------------------------------------------------ grants

  grants(member?: string): Grant[] {
    const rows = (member ? this.db.prepare("SELECT * FROM grants WHERE member = ? ORDER BY created_at").all(member) : this.db.prepare("SELECT * FROM grants ORDER BY created_at").all()) as Row[];
    return rows.map((r) => ({ id: String(r.id), member: String(r.member), scope: String(r.scope), created_by: String(r.created_by), created_at: Number(r.created_at) }));
  }

  putGrant(g: Grant): Grant {
    this.db.prepare("INSERT OR IGNORE INTO grants (id, member, scope, created_by, created_at) VALUES (?, ?, ?, ?, ?)").run(g.id, g.member, g.scope, g.created_by, g.created_at);
    return this.grants(g.member).find((x) => x.scope === g.scope)!;
  }

  deleteGrant(id: string): Grant | null {
    const g = this.grants().find((x) => x.id === id) ?? null;
    if (g) this.db.prepare("DELETE FROM grants WHERE id = ?").run(id);
    return g;
  }

  // ------------------------------------------------------------------ confirmations

  putConfirm(c: Confirmation): void {
    this.db
      .prepare("INSERT OR REPLACE INTO confirms (id, asker, title, detail, kind, state, created_at, expires_at, answered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(c.id, c.asker, c.title, c.detail, c.kind, c.state, c.created_at, c.expires_at, c.answered_by ?? null);
  }

  confirms(state?: string): Confirmation[] {
    const rows = (state ? this.db.prepare("SELECT * FROM confirms WHERE state = ? ORDER BY created_at").all(state) : this.db.prepare("SELECT * FROM confirms ORDER BY created_at DESC LIMIT 200").all()) as Row[];
    return rows.map((r) => ({
      id: String(r.id),
      asker: String(r.asker),
      title: String(r.title),
      detail: String(r.detail),
      kind: r.kind as Confirmation["kind"],
      state: r.state as Confirmation["state"],
      created_at: Number(r.created_at),
      expires_at: Number(r.expires_at),
      answered_by: r.answered_by === null ? undefined : String(r.answered_by),
    }));
  }

  // ------------------------------------------------------------------ kv

  get(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }

  set(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

function toEvent(r: Row): AshEvent {
  return { seq: Number(r.seq), ts: Number(r.ts), workspace: String(r.workspace), member: String(r.member), type: r.type as EventType, data: JSON.parse(String(r.data)) };
}
