// Durable ash-api/2 message log. The v1 Store remains active until the edge/router cutover.
// Open this ledger only after the v1 writer has stopped: migration is a one-time handoff.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { LegacyConversationMetadata, Message, PostDeliveryBodyV2, ResponseBody } from "../../../sdk/src/api";

type Row = Record<string, unknown>;
type NewMessage = Pick<Message, "from" | "to" | "kind" | "word" | "body"> & Pick<Partial<Message>, "reply_to" | "origin" | "turn">;
type ClientRetry = { transportPrincipal: string; clientId: string };
export type MigrationStage = "before-transaction" | "after-schema" | "after-first-row" | "halfway" | "before-commit" | "after-commit";
export interface LedgerOptions { failpoint?: (stage: MigrationStage) => void }
export interface MigrationStats { migrated: number; lastLegacySeq: number; backup: string | null }
export type RequestPhase = "accepted" | "gate_waiting" | "dispatching" | "settled";
export interface RequestContextSnapshot {
  member: string;
  local: boolean;
  remote: boolean;
  ownerProxy: boolean;
  /** Authenticated principal identifier, never a bearer token. */
  transportPrincipal?: string;
  pairedDeviceId?: string;
  screenId?: string;
}
export interface RequestTracking { deadlineAt: number; context: RequestContextSnapshot }
export interface TrackedRequest { message: Message; phase: RequestPhase; deadlineAt: number; context: RequestContextSnapshot }

const marker = "v2:messages:migrated";
const idFromSeq = (seq: number) => `m_${createHash("sha256").update(`v10:${seq}`).digest("base64url").slice(0, 12)}`;
const turnFromSeq = (seq: number) => `t_${seq.toString(36)}`;
const newId = () => `m_${randomBytes(9).toString("base64url")}`;
const obj = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Row)[key])}`).join(",")}}` : JSON.stringify(value);
const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const retryPayload = (input: NewMessage) => digest({ to: input.to, kind: input.kind, word: input.word, body: input.body, reply_to: input.reply_to ?? null });

function integrity(db: DatabaseSync): void {
  const result = db.prepare("PRAGMA integrity_check").get() as Row | undefined;
  if (!result || Object.values(result)[0] !== "ok") throw new Error("SQLite integrity check failed");
}

/** Fingerprint all pre-migration schema and table rows, including non-event durable state. */
function snapshotFingerprint(db: DatabaseSync): string {
  const hash = createHash("sha256");
  const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all() as Row[];
  for (const entry of schema) hash.update(stable(entry)).update("\n");
  for (const entry of schema.filter((item) => item.type === "table")) {
    const table = String(entry.name).replaceAll('"', '""');
    hash.update(`table:${table}\n`);
    for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).iterate() as Iterable<Row>) hash.update(stable(row)).update("\n");
  }
  return hash.digest("hex");
}

/** Online, WAL-consistent snapshot made before the first schema write. Never checkpoints source. */
async function ensureBackup(file: string): Promise<string> {
  const source = new DatabaseSync(file);
  try {
    source.exec("PRAGMA query_only=ON");
    const sourceFingerprint = snapshotFingerprint(source);
    let target = `${file}.v10.backup`;
    if (existsSync(target)) {
      const existing = new DatabaseSync(target);
      try {
        existing.exec("PRAGMA query_only=ON"); integrity(existing);
        if (snapshotFingerprint(existing) === sourceFingerprint) {
          if (snapshotFingerprint(source) !== sourceFingerprint) throw new Error("source changed while verifying migration backup");
          return target;
        }
        target = `${target}.${sourceFingerprint.slice(0, 16)}`;
      } finally { existing.close(); }
    }
    if (existsSync(target)) {
      const existing = new DatabaseSync(target);
      try {
        existing.exec("PRAGMA query_only=ON"); integrity(existing);
        if (snapshotFingerprint(existing) !== sourceFingerprint) throw new Error("migration backup name collision or inconsistent source");
      }
      finally { existing.close(); }
      if (snapshotFingerprint(source) !== sourceFingerprint) throw new Error("source changed while verifying migration backup");
      return target;
    }
    const dir = mkdtempSync(join(dirname(file), `.${basename(file)}-backup-`));
    const temp = join(dir, "snapshot.db");
    try {
      await backup(source, temp);
      chmodSync(temp, 0o600);
      const check = new DatabaseSync(temp);
      try {
        check.exec("PRAGMA query_only=ON"); integrity(check);
        if (snapshotFingerprint(check) !== sourceFingerprint || snapshotFingerprint(source) !== sourceFingerprint) throw new Error("source changed during online backup; retry after writer stops");
      } finally { check.close(); }
      // Earlier recovery points are never overwritten when old v1 events grew after a failed attempt.
      if (!existsSync(target)) renameSync(temp, target);
      return target;
    } finally { rmSync(dir, { recursive: true, force: true }); }
  } finally {
    source.close();
  }
}

function decode(row: Row): Message {
  return {
    seq: Number(row.seq), id: String(row.id), ts: Number(row.ts), from: String(row.from),
    to: row.to === null ? null : String(row.to), kind: row.kind as Message["kind"], word: String(row.word),
    body: JSON.parse(String(row.body)),
    ...(row.reply_to === null ? {} : { reply_to: String(row.reply_to) }),
    ...(row.origin === null ? {} : { origin: JSON.parse(String(row.origin)) }),
    ...(row.turn === null ? {} : { turn: String(row.turn) }),
  };
}

type LegacyRow = { seq: number; ts: number; workspace: string; member: string; type: string; data: string };
type MigrationState = {
  deliveries: Map<string, string>;
  turns: Map<string, string>;
  activeTurns: Map<string, string>;
  toolCalls: Map<string, string[]>;
  deviceCalls: Map<string, { id: string; word: string; from: string; to: string }>;
};
const legacyKey = (workspace: string, key: string) => `${workspace}\0${key}`;

function fromLegacy(row: LegacyRow, state: MigrationState): NewMessage {
  const data = obj(JSON.parse(row.data));
  const legacy: LegacyConversationMetadata = { seq: row.seq, workspace: row.workspace, member: row.member };
  const from = str(data.from, row.member);
  const context = legacyKey(row.workspace, str(data.message_id));
  const actor = legacyKey(row.workspace, row.member);
  const turn = state.turns.get(context) ?? state.activeTurns.get(actor);
  // Non-conversation v1 payloads can contain device arguments or credential material.
  // The old events table remains the full archive; messages keeps display-safe metadata.
  const event = (word: string, body: Row): NewMessage => ({ from: row.member, to: null, kind: "event", word, body, ...(turn ? { turn } : {}) });
  switch (row.type) {
    case "message.delivered": {
      const id = str(data.message_id);
      if (id) state.deliveries.set(legacyKey(row.workspace, id), idFromSeq(row.seq));
      const body: Row = { text: str(data.text), legacy };
      if (Array.isArray(data.attachments)) body.attachments = data.attachments;
      const origin = typeof data.origin === "string" ? { screen: "legacy", label: data.origin } : undefined;
      return { from, to: str(data.to, "agent:main"), kind: "request", word: "say", body, ...(origin ? { origin } : {}) };
    }
    case "agent.text":
      return { from: row.member, to: "person:owner", kind: "request", word: "say", body: { text: str(data.text), kind: "reply", legacy }, ...(state.deliveries.has(context) ? { reply_to: state.deliveries.get(context) } : {}), ...(turn ? { turn } : {}) };
    case "agent.turn.started": {
      const current = turnFromSeq(row.seq);
      state.turns.set(context, current);
      state.activeTurns.set(actor, current);
      return { from: row.member, to: null, kind: "event", word: "turn.start", body: { turn: current, ids: state.deliveries.has(context) ? [state.deliveries.get(context)!] : [] }, turn: current };
    }
    case "agent.turn.ended": {
      state.turns.delete(context);
      state.activeTurns.delete(actor);
      const ended = turn ?? turnFromSeq(row.seq);
      const reason = ["completed", "cancelled", "error"].includes(data.reason as string) ? data.reason : "error";
      return { from: row.member, to: null, kind: "event", word: "turn.end", body: { turn: ended, reason, ...(data.error ? { error: "Legacy error details retained in v1 archive" } : {}) }, turn: ended };
    }
    case "agent.tool.call": {
      const word = str(data.name, "legacy.tool");
      const key = legacyKey(row.workspace, `${str(data.message_id)}\0${word}`);
      state.toolCalls.set(key, [...(state.toolCalls.get(key) ?? []), idFromSeq(row.seq)]);
      return { from: row.member, to: "service:legacy-tool", kind: "request", word, body: { legacy_seq: row.seq, arguments_omitted: true }, ...(turn ? { turn } : {}) };
    }
    case "agent.tool.result": {
      const word = str(data.name, "legacy.tool");
      const key = legacyKey(row.workspace, `${str(data.message_id)}\0${word}`);
      const pending = state.toolCalls.get(key) ?? [];
      const reply_to = pending.shift();
      if (!reply_to) return event("legacy.agent.tool.result", { legacy_seq: row.seq, unmatched: true });
      const ok = data.ok === true;
      return { from: "service:legacy-tool", to: row.member, kind: "response", word, reply_to, body: ok ? { ok: true, result: { legacy_seq: row.seq, output_omitted: true } } : { ok: false, error: { code: "failed", message: "Legacy tool failed; details retained in v1 archive" }, legacy_seq: row.seq }, ...(turn ? { turn } : {}) };
    }
    case "call.started": {
      const word = str(data.capability, "legacy.call");
      const key = legacyKey(row.workspace, str(data.id));
      const to = str(data.device, "device:unknown");
      state.deviceCalls.set(key, { id: idFromSeq(row.seq), word, from: str(data.caller, row.member), to });
      return { from: str(data.caller, row.member), to, kind: "request", word, body: { legacy_seq: row.seq, arguments_omitted: true }, ...(turn ? { turn } : {}) };
    }
    case "call.ended": {
      const key = legacyKey(row.workspace, str(data.id));
      const call = state.deviceCalls.get(key);
      if (!call) return event("legacy.call.ended", { legacy_seq: row.seq, unmatched: true });
      state.deviceCalls.delete(key);
      const ok = data.ok === true;
      return { from: call.to, to: call.from, kind: "response", word: call.word, reply_to: call.id, body: ok ? { ok: true, result: { legacy_seq: row.seq, output_omitted: true } } : { ok: false, error: { code: "failed", message: "Legacy device call failed; details retained in v1 archive" }, legacy_seq: row.seq }, ...(turn ? { turn } : {}) };
    }
    case "agent.status": return event("legacy.agent.status", { state: str(data.status), ...(data.error ? { error_omitted: true, legacy_seq: row.seq } : {}) });
    default: return event(row.type, { legacy_seq: row.seq, legacy_workspace: row.workspace });
  }
}

export class Ledger {
  private constructor(private readonly db: DatabaseSync, readonly migration: MigrationStats) {}

  static async open(file: string, options: LedgerOptions = {}): Promise<Ledger> {
    const legacy = existsSync(file);
    let backupFile: string | null = null;
    if (legacy) {
      const inspect = new DatabaseSync(file);
      let needsMigration = false;
      try {
        inspect.exec("PRAGMA query_only=ON");
        const hasEvents = inspect.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get();
        const hasKv = inspect.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kv'").get();
        needsMigration = Boolean(hasEvents && (!hasKv || !(inspect.prepare("SELECT value FROM kv WHERE key=?").get(marker))));
      } finally { inspect.close(); }
      if (needsMigration) backupFile = await ensureBackup(file);
    }
    const db = new DatabaseSync(file);
    try {
      const stats = Ledger.migrate(db, backupFile, options);
      db.exec(`CREATE TABLE IF NOT EXISTS request_state (
        request_id TEXT PRIMARY KEY, phase TEXT NOT NULL, deadline_at INTEGER NOT NULL,
        context TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
      return new Ledger(db, stats);
    } catch (error) { db.close(); throw error; }
  }

  private static migrate(db: DatabaseSync, backupFile: string | null, options: LedgerOptions): MigrationStats {
    const hasEvents = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get());
    const hasMessages = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'").get());
    if (hasEvents && !backupFile && !hasMessages) throw new Error("legacy migration requires a verified backup");
    const oldLast = hasEvents ? Number((db.prepare("SELECT MAX(seq) AS n FROM events").get() as Row).n ?? 0) : 0;
    const already = hasEvents && Boolean(db.prepare("SELECT value FROM kv WHERE key=?").get(marker));
    if (already) {
      if (!hasMessages) throw new Error("migration marker exists without messages table");
      return { migrated: 0, lastLegacySeq: oldLast, backup: backupFile };
    }
    options.failpoint?.("before-transaction");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL,
          "from" TEXT NOT NULL, "to" TEXT, kind TEXT NOT NULL, word TEXT NOT NULL,
          body TEXT NOT NULL, reply_to TEXT, origin TEXT, turn TEXT);
        CREATE INDEX IF NOT EXISTS m_to ON messages("to", seq);
        CREATE INDEX IF NOT EXISTS m_reply ON messages(reply_to);
        CREATE INDEX IF NOT EXISTS m_turn ON messages(turn);
        CREATE INDEX IF NOT EXISTS m_word ON messages(word, seq);
        CREATE UNIQUE INDEX IF NOT EXISTS m_one_response ON messages(reply_to) WHERE kind='response';
        CREATE TABLE IF NOT EXISTS client_retries (
          scope_hash TEXT NOT NULL, client_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
          message_id TEXT NOT NULL UNIQUE, PRIMARY KEY(scope_hash, client_id));
      `);
      options.failpoint?.("after-schema");
      let migrated = 0;
      if (hasEvents) {
        const total = Number((db.prepare("SELECT COUNT(*) AS n FROM events").get() as Row).n);
        const state: MigrationState = { deliveries: new Map(), turns: new Map(), activeTurns: new Map(), toolCalls: new Map(), deviceCalls: new Map() };
        const insert = db.prepare('INSERT INTO messages (seq,id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
        for (const value of db.prepare("SELECT seq,ts,workspace,member,type,data FROM events ORDER BY seq").iterate() as Iterable<LegacyRow>) {
          const msg = fromLegacy(value, state);
          insert.run(value.seq, idFromSeq(value.seq), value.ts, msg.from, msg.to, msg.kind, msg.word, JSON.stringify(msg.body), msg.reply_to ?? null, msg.origin ? JSON.stringify(msg.origin) : null, msg.turn ?? null);
          migrated++;
          if (migrated === 1) options.failpoint?.("after-first-row");
          if (migrated === Math.ceil(total / 2)) options.failpoint?.("halfway");
        }
        db.exec(`
          CREATE TRIGGER IF NOT EXISTS v2_events_no_insert BEFORE INSERT ON events
            BEGIN SELECT RAISE(ABORT, 'v1 events are read-only after migration'); END;
          CREATE TRIGGER IF NOT EXISTS v2_events_no_update BEFORE UPDATE ON events
            BEGIN SELECT RAISE(ABORT, 'v1 events are read-only after migration'); END;
          CREATE TRIGGER IF NOT EXISTS v2_events_no_delete BEFORE DELETE ON events
            BEGIN SELECT RAISE(ABORT, 'v1 events are read-only after migration'); END;
        `);
        db.prepare("INSERT OR REPLACE INTO kv (key,value) VALUES (?,?)").run(marker, String(oldLast));
      }
      options.failpoint?.("before-commit");
      db.exec("COMMIT");
      options.failpoint?.("after-commit");
      return { migrated, lastLegacySeq: oldLast, backup: backupFile };
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  append(input: NewMessage, retry?: ClientRetry, tracking?: RequestTracking): { message: Message; duplicate: boolean } {
    if (input.kind === "response") throw new TypeError("use settle() for responses");
    if (!["request", "event"].includes(input.kind) || !input.from || !input.word || (input.kind === "request" && !input.to) || !input.body || typeof input.body !== "object" || Array.isArray(input.body)) throw new TypeError("invalid message envelope");
    if (retry && (!retry.transportPrincipal || !retry.clientId || retry.clientId.length > 128)) throw new TypeError("invalid client retry key");
    const scope = retry ? digest(retry.transportPrincipal) : "";
    const payload = retry ? retryPayload(input) : "";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (retry) {
        const prior = this.db.prepare("SELECT payload_hash,message_id FROM client_retries WHERE scope_hash=? AND client_id=?").get(scope, retry.clientId) as Row | undefined;
        if (prior) {
          if (prior.payload_hash !== payload) throw new TypeError("client_id reused with different message");
          const message = this.byId(String(prior.message_id));
          if (!message) throw new Error("retry record has no message");
          this.db.exec("COMMIT");
          return { message, duplicate: true };
        }
      }
      const id = newId();
      const ts = Date.now();
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, ts, input.from, input.to, input.kind, input.word, JSON.stringify(input.body), input.reply_to ?? null, input.origin ? JSON.stringify(input.origin) : null, input.turn ?? null);
      if (input.kind === "request") {
        const deadlineAt = tracking?.deadlineAt ?? ts + 60_000;
        const supplied = tracking?.context ?? { member: input.from, local: true, remote: false, ownerProxy: false };
        if (!Number.isSafeInteger(deadlineAt)) throw new TypeError("invalid request deadline");
        const context: RequestContextSnapshot = { member: supplied.member, local: supplied.local, remote: supplied.remote, ownerProxy: supplied.ownerProxy,
          ...(supplied.transportPrincipal ? { transportPrincipal: supplied.transportPrincipal } : {}),
          ...(supplied.pairedDeviceId ? { pairedDeviceId: supplied.pairedDeviceId } : {}), ...(supplied.screenId ? { screenId: supplied.screenId } : {}) };
        this.db.prepare("INSERT INTO request_state(request_id,phase,deadline_at,context,updated_at) VALUES(?,?,?,?,?)").run(id, "accepted", deadlineAt, JSON.stringify(context), ts);
      }
      if (retry) this.db.prepare("INSERT INTO client_retries (scope_hash,client_id,payload_hash,message_id) VALUES (?,?,?,?)").run(scope, retry.clientId, payload, id);
      this.db.exec("COMMIT");
      return { message: this.byId(id)!, duplicate: false };
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  /** A response retry is readable only after the edge has authenticated its current source. */
  responseRetry(retry: ClientRetry, input: NewMessage): Message | null {
    if (!retry.transportPrincipal || !retry.clientId || retry.clientId.length > 128 || input.kind !== "response") throw new TypeError("invalid response retry");
    const row = this.db.prepare("SELECT payload_hash,message_id FROM client_retries WHERE scope_hash=? AND client_id=?")
      .get(digest(retry.transportPrincipal), retry.clientId) as Row | undefined;
    if (!row) return null;
    if (row.payload_hash !== retryPayload(input)) throw new TypeError("client_id reused with different message");
    const message = this.byId(String(row.message_id));
    if (!message || message.kind !== "response") throw new Error("retry record has no response");
    return message;
  }

  settle(requestId: string, from: string, body: ResponseBody, origin?: Message["origin"], retry?: ClientRetry): { message: Message; settled: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const request = this.byId(requestId);
      if (!request || request.kind !== "request" || !request.to) throw new TypeError("unknown request");
      if (from !== request.to) throw new TypeError("response sender does not match request target");
      const input: NewMessage = { from, to: request.from, kind: "response", word: request.word, body, reply_to: requestId, ...(origin ? { origin } : {}) };
      if (retry) {
        const prior = this.responseRetry(retry, input);
        if (prior) { this.db.exec("COMMIT"); return { message: prior, settled: false }; }
      }
      const existing = this.db.prepare("SELECT * FROM messages WHERE kind='response' AND reply_to=?").get(requestId) as Row | undefined;
      if (existing) { this.db.exec("COMMIT"); return { message: decode(existing), settled: false }; }
      if (typeof body.ok !== "boolean" || (body.ok === false && !body.error)) throw new TypeError("invalid response body");
      const id = newId(); const ts = Date.now();
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, ts, from, request.from, "response", request.word, JSON.stringify(body), request.id, origin ? JSON.stringify(origin) : null, request.turn ?? null);
      if (retry) this.db.prepare("INSERT INTO client_retries (scope_hash,client_id,payload_hash,message_id) VALUES (?,?,?,?)")
        .run(digest(retry.transportPrincipal), retry.clientId, retryPayload(input), id);
      this.db.prepare("UPDATE request_state SET phase='settled',updated_at=? WHERE request_id=?").run(ts, requestId);
      this.db.exec("COMMIT");
      return { message: this.byId(id)!, settled: true };
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  responseTo(requestId: string): Message | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE kind='response' AND reply_to=?").get(requestId) as Row | undefined;
    return row ? decode(row) : null;
  }

  /** Internal recovery probe for a server-owned stable client ID; never exposed as a public lookup. */
  retryMessage(transportPrincipal: string, clientId: string): Message | null {
    const row = this.db.prepare("SELECT message_id FROM client_retries WHERE scope_hash=? AND client_id=?")
      .get(digest(transportPrincipal), clientId) as Row | undefined;
    return row ? this.byId(String(row.message_id)) : null;
  }

  /** Post's private tables and authoritative count event commit on this one ledger connection. */
  postRead<T>(read: (db: DatabaseSync) => T): T { return read(this.db); }

  /** Page rows, status lookups and their watermark must see one SQLite snapshot. */
  postReadSnapshot<T>(read: (db: DatabaseSync) => T): T {
    this.db.exec("BEGIN");
    try { const result = read(this.db); this.db.exec("COMMIT"); return result; }
    catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  postWrite<T>(write: (db: DatabaseSync, snapshot: (held: number) => Message,
    delivery: (body: PostDeliveryBodyV2) => Message) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const snapshot = (held: number): Message => {
        if (!Number.isSafeInteger(held) || held < 0) throw new TypeError("invalid held count");
        const id = newId();
        this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(id, Date.now(), "service:post", "person:owner", "event", "post.changed", JSON.stringify({ held }), null, null, null);
        return this.byId(id)!;
      };
      const delivery = (body: PostDeliveryBodyV2): Message => {
        const id = newId();
        this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(id, Date.now(), "service:post", "person:owner", "event", "post.delivery", JSON.stringify(body), null, null, null);
        return this.byId(id)!;
      };
      const result = write(this.db, snapshot, delivery);
      this.db.exec("COMMIT");
      return result;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  trackedRequests(): TrackedRequest[] {
    const rows = this.db.prepare(`SELECT m.*, s.phase AS tracking_phase, s.deadline_at, s.context AS tracking_context
      FROM request_state s JOIN messages m ON m.id=s.request_id WHERE s.phase!='settled' ORDER BY m.seq`).all() as Row[];
    return rows.map((row) => ({ message: decode(row), phase: String(row.tracking_phase) as RequestPhase, deadlineAt: Number(row.deadline_at), context: JSON.parse(String(row.tracking_context)) }));
  }

  advanceRequest(requestId: string, from: RequestPhase, to: RequestPhase): boolean {
    if (!((from === "accepted" && (to === "gate_waiting" || to === "dispatching")) || (from === "gate_waiting" && to === "dispatching"))) throw new TypeError("invalid request phase transition");
    const updated = this.db.prepare("UPDATE request_state SET phase=?,updated_at=? WHERE request_id=? AND phase=?").run(to, Date.now(), requestId, from);
    return Number(updated.changes) === 1;
  }

  byId(id: string): Message | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id=?").get(id) as Row | undefined;
    return row ? decode(row) : null;
  }

  list(q: { after?: number; before?: number; limit?: number } = {}): Message[] {
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
    const rows = q.before !== undefined
      ? this.db.prepare("SELECT * FROM messages WHERE seq<? ORDER BY seq DESC LIMIT ?").all(q.before, limit).reverse()
      : this.db.prepare("SELECT * FROM messages WHERE seq>? ORDER BY seq LIMIT ?").all(q.after ?? 0, limit);
    return (rows as Row[]).map(decode);
  }

  /** Startup-only projection: never materialize unrelated message bodies or attachments. */
  agentTurnHistory(actor: string): { startedTurns: Set<string>; completedTurns: Set<string> } {
    const startedTurns = new Set<string>();
    const completedTurns = new Set<string>();
    const rows = this.db.prepare(`SELECT word, json_extract(body, '$.turn') AS turn_id,
      CASE WHEN word='turn.end' THEN json_extract(body, '$.reason') END AS reason
      FROM messages WHERE "from"=? AND kind='event' AND word IN ('turn.start', 'turn.end') ORDER BY seq`).iterate(actor) as Iterable<Row>;
    for (const row of rows) {
      if (typeof row.turn_id !== "string") continue;
      if (row.word === "turn.start") startedTurns.add(row.turn_id);
      if (row.word === "turn.end" && row.reason === "completed") completedTurns.add(row.turn_id);
    }
    return { startedTurns, completedTurns };
  }

  lastSeq(): number { return Number((this.db.prepare("SELECT MAX(seq) AS n FROM messages").get() as Row).n ?? 0); }
  close(): void { this.db.close(); }
}
