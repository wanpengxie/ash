import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { RequestContextSnapshot } from "./ledger";

type Row = Record<string, unknown>;
export interface ClockPayload { to: string; word: "wake" | "say"; body: Record<string, unknown>; label: string }
export interface ClockTimer { id: string; next: number; every: number | null; payload: ClockPayload | null; createdBy: string; delegated: RequestContextSnapshot | null; sourceRequestId: string | null; legacy: boolean; blocked: string | null }
export interface ClockFire { timerId: string; scheduledAt: number; payload: ClockPayload | null; createdBy: string; delegated: RequestContextSnapshot | null; sourceRequestId: string | null; legacy: boolean; outcome: "dispatched" | "skipped" | "failed" | null; reason: string | null; requestId: string | null; eventId: string | null }

const safeTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const obj = (text: unknown) => JSON.parse(String(text)) as Record<string, unknown>;
const timerId = (requestId: string) => `tmr_${createHash("sha256").update(requestId).digest("base64url").slice(0, 20)}`;

/** A separate SQLite connection to the same ledger file; no v1 event writer is used. */
export class ClockJournal {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    try { this.db.exec(`
      CREATE TABLE IF NOT EXISTS timers (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, text TEXT NOT NULL, fire_at INTEGER NOT NULL,
        repeat_seconds INTEGER, created_by TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS clock_meta (
        timer_id TEXT PRIMARY KEY, payload TEXT NOT NULL, delegated TEXT NOT NULL,
        set_request_id TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS clock_commands (
        request_id TEXT PRIMARY KEY, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS clock_blocked (
        timer_id TEXT PRIMARY KEY, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS clock_fires (
        timer_id TEXT NOT NULL, scheduled_at INTEGER NOT NULL, payload TEXT,
        created_by TEXT NOT NULL, delegated TEXT, source_request_id TEXT, legacy INTEGER NOT NULL,
        outcome TEXT, reason TEXT, request_id TEXT, event_id TEXT,
        PRIMARY KEY(timer_id,scheduled_at));
    `); }
    catch (error) { this.db.close(); throw error; }
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  private decodeTimer(row: Row): ClockTimer {
    const legacy = row.payload === null;
    const owner = String(row.owner);
    const text = String(row.text);
    const payload = legacy ? owner === "agent:main" ? { to: "agent:main" as const, word: "say" as const, body: { text }, label: text }
      : owner === "person:owner" ? { to: "person:owner" as const, word: "say" as const, body: { text, kind: "due" }, label: text } : null
      : obj(row.payload) as unknown as ClockPayload;
    return { id: String(row.id), next: Number(row.fire_at), every: row.repeat_seconds === null ? null : Number(row.repeat_seconds),
      payload, createdBy: String(row.created_by), delegated: row.delegated === null ? null : obj(row.delegated) as unknown as RequestContextSnapshot,
      sourceRequestId: row.set_request_id === null ? null : String(row.set_request_id), legacy,
      blocked: row.blocked_reason === null ? null : String(row.blocked_reason) };
  }

  list(): ClockTimer[] {
    const rows = this.db.prepare(`SELECT t.*,m.payload,m.delegated,m.set_request_id,b.reason AS blocked_reason FROM timers t
      LEFT JOIN clock_meta m ON m.timer_id=t.id LEFT JOIN clock_blocked b ON b.timer_id=t.id ORDER BY t.fire_at,t.id`).all() as Row[];
    return rows.map((row) => this.decodeTimer(row));
  }

  command(requestId: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT result FROM clock_commands WHERE request_id=?").get(requestId) as Row | undefined;
    return row ? obj(row.result) : null;
  }

  set(requestId: string, payload: ClockPayload, delegated: RequestContextSnapshot, createdBy: string, next: number, every: number | null): { id: string; next: number } {
    if (!safeTime(next) || (every !== null && (!Number.isSafeInteger(every) || every < 60))) throw new TypeError("invalid timer time");
    return this.transaction(() => {
      const previous = this.command(requestId);
      if (previous) return previous as { id: string; next: number };
      const id = timerId(requestId);
      this.db.prepare("INSERT INTO timers(id,owner,text,fire_at,repeat_seconds,created_by) VALUES(?,?,?,?,?,?)")
        .run(id, payload.to, payload.label, next, every, createdBy);
      this.db.prepare("INSERT INTO clock_meta(timer_id,payload,delegated,set_request_id) VALUES(?,?,?,?)")
        .run(id, JSON.stringify(payload), JSON.stringify(delegated), requestId);
      const result = { id, next };
      this.db.prepare("INSERT INTO clock_commands(request_id,result) VALUES(?,?)").run(requestId, JSON.stringify(result));
      return result;
    });
  }

  cancel(requestId: string, id: string): { cancelled: boolean } {
    return this.transaction(() => {
      const previous = this.command(requestId);
      if (previous) return previous as { cancelled: boolean };
      const changed = Number(this.db.prepare("DELETE FROM timers WHERE id=?").run(id).changes) === 1;
      if (changed) {
        this.db.prepare("DELETE FROM clock_meta WHERE timer_id=?").run(id);
        this.db.prepare("DELETE FROM clock_blocked WHERE timer_id=?").run(id);
      }
      const result = { cancelled: changed };
      this.db.prepare("INSERT INTO clock_commands(request_id,result) VALUES(?,?)").run(requestId, JSON.stringify(result));
      return result;
    });
  }

  /** Old rows require a matching, trusted v1 timer.set provenance event. */
  legacyEvidence(timer: ClockTimer): boolean {
    if (!timer.legacy || !timer.payload || !["person:owner", "agent:main"].includes(timer.createdBy) ||
      !["person:owner", "agent:main"].includes(timer.payload.to) ||
      (timer.createdBy !== timer.payload.to && timer.createdBy !== "person:owner") || !safeTime(timer.next) ||
      (timer.every !== null && (!Number.isSafeInteger(timer.every) || timer.every < 60 || !Number.isSafeInteger(timer.every * 1000)))) return false;
    const hasEvents = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get();
    if (!hasEvents) return false;
    const rows = this.db.prepare(`SELECT json_extract(data,'$.timer.fire_at') AS initial_at FROM events
      WHERE type='timer.set' AND member=? AND json_valid(data)
        AND json_extract(data,'$.timer.id')=? AND json_extract(data,'$.timer.owner')=?
        AND json_extract(data,'$.timer.text')=? AND json_extract(data,'$.timer.repeat_seconds') IS ?
        AND json_extract(data,'$.timer.created_by')=?`).all(timer.createdBy, timer.id, timer.payload.to,
      timer.payload.label, timer.every, timer.createdBy) as Row[];
    return rows.some((row) => {
      const initial = Number(row.initial_at);
      if (!safeTime(initial) || timer.next < initial) return false;
      return timer.every === null ? timer.next === initial : (timer.next - initial) % (timer.every * 1000) === 0;
    });
  }

  block(id: string, reason: string): void {
    this.db.prepare("INSERT OR IGNORE INTO clock_blocked(timer_id,reason) VALUES(?,?)").run(id, reason);
  }

  /** Atomically claim each due occurrence and advance the timer before any routed effect. */
  claimDue(now: number): ClockFire[] {
    if (!safeTime(now)) throw new TypeError("invalid clock time");
    return this.transaction(() => {
      const due = this.list().filter((timer) => !timer.blocked && timer.next <= now);
      for (const timer of due) {
        if (timer.legacy && !this.legacyEvidence(timer)) {
          this.block(timer.id, "unverified_legacy");
          this.insertFire(timer, "failed", "unverified_legacy");
          continue; // Preserve the original row intact for the owner to review.
        }
        if (!timer.payload || !safeTime(timer.next)) {
          this.block(timer.id, "invalid_timer");
          this.insertFire(timer, "failed", "invalid_timer");
          continue;
        }
        if (timer.every === null) {
          this.db.prepare("DELETE FROM timers WHERE id=?").run(timer.id);
          this.db.prepare("DELETE FROM clock_meta WHERE timer_id=?").run(timer.id);
        } else {
          const period = timer.every * 1000;
          const steps = Math.floor((now - timer.next) / period) + 1;
          const next = timer.next + steps * period;
          if (!Number.isSafeInteger(period) || !safeTime(next) || next <= now) {
            this.block(timer.id, "invalid_next_time");
            this.insertFire(timer, "failed", "invalid_next_time");
            continue;
          }
          this.db.prepare("UPDATE timers SET fire_at=? WHERE id=?").run(next, timer.id);
        }
        this.insertFire(timer, null, null);
      }
      return this.pendingFires();
    });
  }

  private insertFire(timer: ClockTimer, outcome: ClockFire["outcome"], reason: string | null): void {
    this.db.prepare(`INSERT OR IGNORE INTO clock_fires(timer_id,scheduled_at,payload,created_by,delegated,source_request_id,legacy,outcome,reason)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(timer.id, timer.next, timer.payload ? JSON.stringify(timer.payload) : null,
      timer.createdBy, timer.delegated ? JSON.stringify(timer.delegated) : null, timer.sourceRequestId, timer.legacy ? 1 : 0, outcome, reason);
  }

  pendingFires(): ClockFire[] {
    const rows = this.db.prepare("SELECT * FROM clock_fires WHERE event_id IS NULL ORDER BY scheduled_at,timer_id").all() as Row[];
    return rows.map((row) => ({ timerId: String(row.timer_id), scheduledAt: Number(row.scheduled_at),
      payload: row.payload === null ? null : obj(row.payload) as unknown as ClockPayload, createdBy: String(row.created_by),
      delegated: row.delegated === null ? null : obj(row.delegated) as unknown as RequestContextSnapshot,
      sourceRequestId: row.source_request_id === null ? null : String(row.source_request_id),
      legacy: Number(row.legacy) === 1, outcome: row.outcome === null ? null : row.outcome as ClockFire["outcome"],
      reason: row.reason === null ? null : String(row.reason), requestId: row.request_id === null ? null : String(row.request_id),
      eventId: row.event_id === null ? null : String(row.event_id) }));
  }

  finishFire(fire: ClockFire, outcome: Exclude<ClockFire["outcome"], null>, reason: string | null, requestId: string | null): void {
    this.db.prepare("UPDATE clock_fires SET outcome=?,reason=?,request_id=? WHERE timer_id=? AND scheduled_at=? AND outcome IS NULL")
      .run(outcome, reason, requestId, fire.timerId, fire.scheduledAt);
  }
  markEvent(fire: ClockFire, eventId: string): void {
    this.db.prepare("UPDATE clock_fires SET event_id=? WHERE timer_id=? AND scheduled_at=? AND event_id IS NULL")
      .run(eventId, fire.timerId, fire.scheduledAt);
  }
  nextAlarm(): number | null {
    const row = this.db.prepare("SELECT MIN(fire_at) AS next FROM timers WHERE id NOT IN (SELECT timer_id FROM clock_blocked)").get() as Row;
    return row.next === null ? null : Number(row.next);
  }
  /** ASH-306 owns writes to this durable key; malformed state fails closed. */
  isPaused(): boolean {
    const row = this.db.prepare("SELECT value FROM kv WHERE key='v2:admin:paused'").get() as Row | undefined;
    if (!row) return false;
    try {
      const parsed = JSON.parse(String(row.value)) as unknown;
      if (typeof parsed === "boolean") return parsed;
    } catch { /* malformed JSON is not an unpaused state */ }
    throw new TypeError("invalid durable pause state: expected JSON boolean at v2:admin:paused");
  }
  close(): void { this.db.close(); }
}
