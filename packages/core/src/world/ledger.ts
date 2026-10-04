// Durable ash-api/2 message log. The v1 Store remains active until the edge/router cutover.
// Open this ledger only after the v1 writer has stopped: migration is a one-time handoff.

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { STREAM_RAW_PAGE_BYTES, type GateAccessItemV2, type GateHistoryItemV2, type GateRuleItemV2, type LegacyConversationMetadata, type Message, type MessageSummaryV2, type PostDeliveryBodyV2, type ResponseBody, type StreamPageEndV2, type WorkRunInfoV2, type WorkRunStepBodyV2 } from "../../../sdk/src/api";
import { matchesSchema } from "../../../sdk/src/schema";
import { AGENT_ID, wordContract, workRunTurn, workRunsResultErrors } from "../../../sdk/src/words";
import { readSummaryPage, type StreamPageQuery } from "./stream-page";

type Row = Record<string, unknown>;
type NewMessage = Pick<Message, "from" | "to" | "kind" | "word" | "body"> & Pick<Partial<Message>, "reply_to" | "origin" | "turn">;
type ClientRetry = { transportPrincipal: string; clientId: string };
export type MigrationStage = "before-transaction" | "after-schema" | "after-first-row" | "halfway" | "before-commit" | "after-commit";
export type WorkStage = "start-after-row" | "start-before-commit" | "start-after-commit" | "end-after-row" | "end-before-commit" | "end-after-commit";
export interface LedgerOptions { failpoint?: (stage: MigrationStage) => void; workFailpoint?: (stage: WorkStage) => void }
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
  nativeUi?: boolean;
}
export interface RequestTracking { deadlineAt: number; context: RequestContextSnapshot }
export interface TrackedRequest { message: Message; phase: RequestPhase; deadlineAt: number; context: RequestContextSnapshot }
export interface AgentJobRecord {
  requestId: string; owner: string; turn: string; member: string; word: string; label: string; at: number; phase: RequestPhase;
}
export interface GateCaseStart {
  /** Stable authenticated identity, not a screen registration or bearer token. */
  subject: string;
  risk: "none" | "outward" | "structure";
  contractFingerprint: string;
  askBody: Record<string, unknown>;
  expiresAt: number;
  /** What "always" would cover: the request's target (gateRulePattern), or "*" for the capability. Absent: always is not offered. */
  objectPattern?: string;
  ruleId?: string;
}
export interface GateCaseRecord {
  requestId: string;
  askId: string;
  subject: string;
  risk: "none" | "outward" | "structure";
  contractFingerprint: string;
  expiresAt: number;
  decision: "waiting" | "allowed" | "denied" | "timeout" | "cancelled";
  objectPattern?: string;
}

const marker = "v2:messages:migrated";
const idFromSeq = (seq: number) => `m_${createHash("sha256").update(`v10:${seq}`).digest("base64url").slice(0, 12)}`;
const turnFromSeq = (seq: number) => `t_${seq.toString(36)}`;
const newId = () => `m_${randomBytes(9).toString("base64url")}`;
const obj = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Row)[key])}`).join(",")}}` : JSON.stringify(value);
const digest = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");
const retryPayload = (input: NewMessage) => digest({ to: input.to, kind: input.kind, word: input.word, body: input.body, reply_to: input.reply_to ?? null });
export interface UsageTotals { calls: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_usd: number; unpriced_calls: number }
export interface UsageCall { at: number; scope: string; model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cost_usd: number | null; ms: number }
export interface UsageSummary {
  as_of: number; currency: "USD"; estimated: true; periods: { today: UsageTotals; "7d": UsageTotals; "30d": UsageTotals };
  by_scope: (UsageTotals & { scope: string })[]; by_day: (UsageTotals & { date: string })[]; recent: UsageCall[];
}

const browserSite = (value: unknown): string => typeof value === "string" ? value.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "") : "";
const WEIGHTY_CLICK = /发布|发表|发送|发帖|提交|删除|移除|购买|支付|付款|下单|转账|关注|取消关注|转发|post|tweet|send|reply|publish|submit|delete|remove|buy|pay|purchase|checkout|order|follow|retweet|repost|confirm|transfer/i;
/** The thing an approval is about when a capability names one: a calendar, a site, a recipient. Null when it names none. */
export const gateTarget = (target: string, word: string, body: Record<string, unknown>): string | null => {
  if (target.startsWith("device:") && word === "calendar.create") {
    const id = body.calendar_id;
    if (Number.isSafeInteger(id) && (id as number) > 0) return String(id);
  }
  // A browser approval is about a site, not a button: the phone refuses a click or typing whose site is not the page's.
  if (target.startsWith("device:") && (word === "browser.click" || word === "browser.type")) {
    const site = browserSite(body.site);
    // Buttons that publish, send, delete or pay are never covered by "allow this site": each one asks again.
    if (word === "browser.click" && WEIGHTY_CLICK.test(String(body.label ?? ""))) return `exact:${stable(body)}`;
    if (/^[a-z0-9][a-z0-9.-]{0,200}$/.test(site)) return `site:${site}`;
  }
  // A browser script is about the sites it clicks or types on, judged like those single steps: one site is "this site";
  // several sites or any weighty button only this exact script; a script that only looks is its own target, so allowing
  // looking never covers acting.
  if (target.startsWith("device:") && word === "browser.run") {
    const acting = (Array.isArray(body.steps) ? body.steps : []).map(obj).filter((step) => step.op === "click" || step.op === "type");
    if (acting.some((step) => step.op === "click" && WEIGHTY_CLICK.test(String(step.label ?? "")))) return `exact:${stable(body)}`;
    const sites = [...new Set(acting.map((step) => browserSite(step.site)))];
    if (sites.length === 0) return "browse";
    if (sites.length === 1 && /^[a-z0-9][a-z0-9.-]{0,200}$/.test(sites[0]!)) return `site:${sites[0]}`;
    return `exact:${stable(body)}`;
  }
  if (target.startsWith("device:") && word === "message.send") {
    const recipient = body.recipient_id;
    if (typeof recipient === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(recipient.toLowerCase()))
      return recipient.toLowerCase();
  }
  return null;
};
/** The exact action object: its target, or the whole request body. Earlier exact rules were stored this way. */
export const gateObject = (target: string, word: string, body: Record<string, unknown>): string =>
  gateTarget(target, word, body) ?? stable(body);
/** "Always" covers the target when there is one, otherwise every use of this capability by this agent. */
export const gateRulePattern = (target: string, word: string, body: Record<string, unknown>): string =>
  gateTarget(target, word, body) ?? "*";
/** A stable digest of one exact request body. */
export const gateBodyDigest = (body: Record<string, unknown>): string => digest(body);
/** Agents reach device capabilities without a separate access grant; every other non-owner sender is refused. */
const deviceCaller = (from: string): boolean => from === "person:owner" || /^agent:[A-Za-z0-9_-]+$/.test(from);

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
  private constructor(private readonly db: DatabaseSync, readonly migration: MigrationStats, private readonly workFailpoint?: (stage: WorkStage) => void) {}

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
      db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec(`CREATE TABLE IF NOT EXISTS request_state (
        request_id TEXT PRIMARY KEY, phase TEXT NOT NULL, deadline_at INTEGER NOT NULL,
        context TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
      db.exec(`CREATE TABLE IF NOT EXISTS agent_jobs (
        request_id TEXT PRIMARY KEY, owner TEXT NOT NULL, turn TEXT NOT NULL, member TEXT NOT NULL,
        word TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL,
        FOREIGN KEY(request_id) REFERENCES request_state(request_id));
        CREATE INDEX IF NOT EXISTS agent_jobs_owner ON agent_jobs(owner,created_at);
        CREATE TABLE IF NOT EXISTS agent_job_cutoffs (
          owner TEXT PRIMARY KEY, through_seq INTEGER NOT NULL);`);
      db.exec(`CREATE TABLE IF NOT EXISTS admin_pause_claims (
        by_message_id TEXT PRIMARY KEY, pause_request_id TEXT NOT NULL UNIQUE);`);
      db.exec(`CREATE TABLE IF NOT EXISTS option_answers (
        card_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE);`);
      db.exec(`CREATE TABLE IF NOT EXISTS work_runs (
        run TEXT PRIMARY KEY, request_id TEXT UNIQUE, flow TEXT NOT NULL, trigger TEXT NOT NULL,
        state TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, detail TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS work_one_active_flow ON work_runs(flow) WHERE state='running';
        CREATE TABLE IF NOT EXISTS work_trigger_slots (
          slot TEXT PRIMARY KEY, flow TEXT NOT NULL, trigger TEXT NOT NULL,
          run TEXT UNIQUE, state TEXT NOT NULL CHECK(state IN ('started','skipped')));`);
      db.exec(`CREATE TABLE IF NOT EXISTS gate_cases (
        request_id TEXT PRIMARY KEY, ask_id TEXT NOT NULL UNIQUE, subject TEXT NOT NULL,
        risk TEXT NOT NULL, contract_fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL,
        object_pattern TEXT, rule_id TEXT,
        decision TEXT NOT NULL CHECK(decision IN ('waiting','allowed','denied','timeout','cancelled')),
        decided_at INTEGER);
        CREATE INDEX IF NOT EXISTS gate_cases_ask ON gate_cases(ask_id);`);
      // access_scope is kept only so databases written by the earlier access cards still open and settle.
      if (!(db.prepare("PRAGMA table_info(gate_cases)").all() as Row[]).some((column) => column.name === "access_scope"))
        db.exec("ALTER TABLE gate_cases ADD COLUMN access_scope TEXT");
      db.exec(`CREATE TABLE IF NOT EXISTS gate_history (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, request_id TEXT,
        ask_id TEXT, subject TEXT, target TEXT, word TEXT,
        risk TEXT, decision TEXT NOT NULL, at INTEGER NOT NULL, rule_id TEXT,
        source TEXT NOT NULL CHECK(source IN ('current','legacy')), legacy_scope TEXT, legacy_source_hash TEXT);
        CREATE INDEX IF NOT EXISTS gate_history_request ON gate_history(request_id);`);
      if (!(db.prepare("PRAGMA table_info(gate_history)").all() as Row[]).some((column) => column.name === "reason"))
        db.exec("ALTER TABLE gate_history ADD COLUMN reason TEXT");
      db.exec(`CREATE TABLE IF NOT EXISTS gate_rules (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, subject TEXT NOT NULL, subject_alias TEXT NOT NULL,
        device_id TEXT, capability_id TEXT, target TEXT NOT NULL, word TEXT NOT NULL,
        object_pattern TEXT NOT NULL, risk TEXT NOT NULL, contract_fingerprint TEXT NOT NULL,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
        CREATE INDEX IF NOT EXISTS gate_rules_match ON gate_rules(subject,target,word,object_pattern,expires_at);`);
      // Who made or revoked a rule: null is the owner's own card or screen, otherwise the approved request that did it.
      for (const column of ["created_by", "revoked_by"])
        if (!(db.prepare("PRAGMA table_info(gate_rules)").all() as Row[]).some((item) => item.name === column)) db.exec(`ALTER TABLE gate_rules ADD COLUMN ${column} TEXT`);
      // The evidence behind each approval decision: the facts the reviewer saw, its verdict, the card shown.
      db.exec(`CREATE TABLE IF NOT EXISTS gate_evidence (
        request_id TEXT PRIMARY KEY, at INTEGER NOT NULL, requester TEXT NOT NULL, member TEXT NOT NULL, word TEXT NOT NULL,
        label TEXT, effect TEXT, turn TEXT, content TEXT, facts TEXT, review TEXT, card TEXT);
        CREATE INDEX IF NOT EXISTS gate_evidence_requester ON gate_evidence(requester);`);
      db.exec(`CREATE TABLE IF NOT EXISTS gate_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS gate_access (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, source_hash TEXT UNIQUE,
          member TEXT NOT NULL, scope TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('current','legacy')),
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER);
        CREATE INDEX IF NOT EXISTS gate_access_match ON gate_access(member,scope,expires_at);
        CREATE TABLE IF NOT EXISTS gate_access_audit (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE,
          access_id TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('grant','revoke')),
          at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS internal_approval_calls (
          session_id TEXT NOT NULL, turn TEXT NOT NULL, call_id TEXT NOT NULL,
          request_id TEXT NOT NULL UNIQUE, PRIMARY KEY(session_id,turn,call_id));`);
      Ledger.migrateLegacyGate(db);
      return new Ledger(db, stats, options.workFailpoint);
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

  /** One-way ACL import. Old confirms are audit-only; neither table creates an approval rule. */
  private static migrateLegacyGate(db: DatabaseSync): void {
    if (db.prepare("SELECT 1 FROM gate_meta WHERE key='legacy_migration_at'").get()) return;
    const at = Date.now();
    const expires = at + 30 * 24 * 60 * 60_000;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='grants'").get()) {
        for (const row of db.prepare("SELECT id,member,scope,created_by,created_at FROM grants ORDER BY rowid").iterate() as Iterable<Row>) {
          const scope = String(row.scope);
          const member = String(row.member);
          const valid = row.created_by === "person:owner" && /^agent:[A-Za-z0-9_-]+$/.test(member) &&
            /^(\*|device:[A-Za-z0-9_-]+\/(\*|[A-Za-z0-9_.-]+))$/.test(scope) &&
            Number.isSafeInteger(Number(row.created_at)) && Number(row.created_at) >= 0;
          const decision = valid ? "legacy_access_imported" : "legacy_access_invalid";
          const sourceHash = digest({ type: "grant", id: row.id });
          if (valid) db.prepare("INSERT INTO gate_access(id,source_hash,member,scope,source,created_at,expires_at) VALUES(?,?,?,?,?,?,?)")
            .run(newId(), sourceHash, member, scope, "legacy", at, expires);
          db.prepare("INSERT INTO gate_history(id,subject,decision,at,source,legacy_scope,legacy_source_hash) VALUES(?,?,?,?,?,?,?)")
            .run(newId(), valid ? member : null, decision, at, "legacy", valid ? scope : null, valid ? sourceHash : null);
        }
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='confirms'").get()) {
        for (const row of db.prepare("SELECT id,state,created_at FROM confirms ORDER BY rowid").iterate() as Iterable<Row>) {
          const state = String(row.state);
          const decision = state === "approved" ? "legacy_approved" : state === "denied" ? "legacy_denied"
            : state === "expired" ? "legacy_expired" : state === "cancelled" ? "legacy_cancelled" : "legacy_unresolved";
          const timestamp = Number(row.created_at);
          db.prepare("INSERT INTO gate_history(id,decision,at,source) VALUES(?,?,?,?)")
            .run(newId(), decision, Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : at, "legacy");
        }
      }
      db.prepare("INSERT INTO gate_meta(key,value) VALUES('legacy_migration_at',?)").run(String(at));
      db.exec("COMMIT");
    } catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  }

  append(input: NewMessage, retry?: ClientRetry, tracking?: RequestTracking,
    pauseClaim?: { byMessageId: string }): { message: Message; duplicate: boolean } {
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
      const optionCardId = input.from === "person:owner" && input.to === "agent:main" && input.word === "say" &&
        typeof input.body.in_reply_to === "string" ? input.body.in_reply_to : null;
      if (optionCardId) {
        const card = this.byId(optionCardId);
        const value = card?.body.card as { type?: unknown; options?: { id?: unknown; text?: unknown }[]; allow_custom?: unknown } | undefined;
        const optionId = input.body.option_id;
        const selected = value?.options?.find((option) => option.id === optionId);
        if (!card || card.kind !== "request" || card.word !== "show" || card.to !== "person:owner" ||
          !["agent:main", "service:work"].includes(card.from) || value?.type !== "options" ||
          !Array.isArray(value.options) || new Set(value.options.map((option) => option.id)).size !== value.options.length ||
          (selected ? selected.text !== input.body.text : !(optionId === "__custom" && value.allow_custom === true && typeof input.body.text === "string" && input.body.text.length > 0)))
          throw new TypeError("invalid option answer");
        if (this.db.prepare("SELECT 1 FROM option_answers WHERE card_id=?").get(optionCardId)) throw new TypeError("option already answered");
      }
      const id = newId();
      const ts = Date.now();
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, ts, input.from, input.to, input.kind, input.word, JSON.stringify(input.body), input.reply_to ?? null, input.origin ? JSON.stringify(input.origin) : null, input.turn ?? null);
      if (optionCardId) this.db.prepare("INSERT INTO option_answers(card_id,message_id) VALUES(?,?)").run(optionCardId, id);
      if (input.kind === "request") {
        const deadlineAt = tracking?.deadlineAt ?? ts + 60_000;
        const supplied = tracking?.context ?? { member: input.from, local: true, remote: false, ownerProxy: false };
        if (!Number.isSafeInteger(deadlineAt)) throw new TypeError("invalid request deadline");
        const context: RequestContextSnapshot = { member: supplied.member, local: supplied.local, remote: supplied.remote, ownerProxy: supplied.ownerProxy,
          ...(supplied.nativeUi ? { nativeUi: true } : {}),
          ...(supplied.transportPrincipal ? { transportPrincipal: supplied.transportPrincipal } : {}),
          ...(supplied.pairedDeviceId ? { pairedDeviceId: supplied.pairedDeviceId } : {}), ...(supplied.screenId ? { screenId: supplied.screenId } : {}) };
        this.db.prepare("INSERT INTO request_state(request_id,phase,deadline_at,context,updated_at) VALUES(?,?,?,?,?)").run(id, "accepted", deadlineAt, JSON.stringify(context), ts);
      }
      if (retry) this.db.prepare("INSERT INTO client_retries (scope_hash,client_id,payload_hash,message_id) VALUES (?,?,?,?)").run(scope, retry.clientId, payload, id);
      if (pauseClaim) {
        if (input.kind !== "request" || input.from !== "service:reflex" || input.to !== "service:admin" || input.word !== "pause" ||
          input.body.by !== pauseClaim.byMessageId || !pauseClaim.byMessageId) throw new TypeError("invalid pause claim");
        try { this.db.prepare("INSERT INTO admin_pause_claims(by_message_id,pause_request_id) VALUES(?,?)").run(pauseClaim.byMessageId, id); }
        catch { throw new TypeError("owner message already consumed for pause"); }
      }
      this.db.exec("COMMIT");
      return { message: this.byId(id)!, duplicate: false };
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  /** No public route accepts this word. A call identity and parent request commit together. */
  acceptInternalApproval(input: { member?: string; sessionId: string; turn: string; callId: string; toolName: string;
    contractFingerprint: string; deadlineAt: number }): Message {
    if (!/^session-[0-9a-f-]{36}$/.test(input.sessionId) || !/^t_[A-Za-z0-9_-]+$/.test(input.turn) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.callId) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.toolName) ||
      !/^[a-f0-9]{64}$/.test(input.contractFingerprint) || !Number.isSafeInteger(input.deadlineAt) || input.deadlineAt <= Date.now())
      throw new TypeError("invalid internal approval identity");
    const member = input.member ?? "agent:main";
    if (!AGENT_ID.test(member)) throw new TypeError("invalid internal approval identity");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const id = newId(); const at = Date.now();
      this.db.prepare(`INSERT INTO internal_approval_calls(session_id,turn,call_id,request_id) VALUES(?,?,?,?)`)
        .run(input.sessionId, input.turn, input.callId, id);
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, at, member, "service:gate", "request", "internal.approval", JSON.stringify({ session_id: input.sessionId,
          tool_name: input.toolName, call_id: input.callId, contract_fingerprint: input.contractFingerprint }), null, null, input.turn);
      this.db.prepare("INSERT INTO request_state(request_id,phase,deadline_at,context,updated_at) VALUES(?,?,?,?,?)")
        .run(id, "accepted", input.deadlineAt, JSON.stringify({ member, local: true, remote: false,
          ownerProxy: false, transportPrincipal: member }), at);
      this.db.exec("COMMIT");
      return this.byId(id)!;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  /** A DSH session cannot resume a borrowed approval call after process death. */
  failInternalApproval(requestId: string): Message | null {
    const request = this.byId(requestId);
    if (!request || !AGENT_ID.test(request.from) || request.to !== "service:gate" || request.word !== "internal.approval") return null;
    const prior = this.responseTo(requestId);
    if (prior) return prior;
    const gate = this.gateCase(requestId);
    if (gate?.decision === "waiting") {
      const settled = this.settleGateAsk(gate.askId, "deny", "cancelled");
      if (settled?.originalResponse) return settled.originalResponse;
    }
    return this.settle(requestId, "service:gate", { ok: false, error: { code: "failed", message: "DSH approval handoff unknown after restart" } }).message;
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

  /** Persist which authenticated agent owns a receipt so it survives MCP/core restarts. */
  recordAgentJob(input: Omit<AgentJobRecord, "phase">): void {
    if (!input.requestId || !AGENT_ID.test(input.owner) || !input.turn || !input.member || !input.word ||
      !input.label || !Number.isSafeInteger(input.at) || input.at < 0) throw new TypeError("invalid agent job");
    const source = this.requestSource(input.requestId);
    if (!source || source.message.from !== input.owner || source.message.to !== input.member ||
      source.message.word !== input.word || source.message.turn !== input.turn) throw new TypeError("agent job does not match request");
    this.db.prepare(`INSERT OR IGNORE INTO agent_jobs(request_id,owner,turn,member,word,label,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(input.requestId, input.owner, input.turn, input.member, input.word, input.label.slice(0, 160), input.at);
  }

  agentJob(owner: string, requestId: string): AgentJobRecord | null {
    const row = this.db.prepare(`SELECT j.*,s.phase FROM agent_jobs j JOIN request_state s ON s.request_id=j.request_id
      WHERE j.owner=? AND j.request_id=?`).get(owner, requestId) as Row | undefined;
    if (row) return { requestId: String(row.request_id), owner: String(row.owner), turn: String(row.turn), member: String(row.member),
      word: String(row.word), label: String(row.label), at: Number(row.created_at), phase: String(row.phase) as RequestPhase };
    // Crash-safe fallback: request acceptance commits before the MCP layer can index the receipt. The authenticated
    // request snapshot is sufficient to recover it, except across an explicit agent deletion cutoff.
    const fallback = this.db.prepare(`SELECT m.*,s.phase,s.context AS tracking_context FROM messages m
      JOIN request_state s ON s.request_id=m.id WHERE m.id=? AND m."from"=? AND m.seq>
      COALESCE((SELECT through_seq FROM agent_job_cutoffs WHERE owner=?),0)`).get(requestId, owner, owner) as Row | undefined;
    return fallback ? this.agentJobFromRequest(owner, fallback) : null;
  }

  pendingAgentJobs(owner: string): AgentJobRecord[] {
    const rows = this.db.prepare(`SELECT j.*,s.phase FROM agent_jobs j JOIN request_state s ON s.request_id=j.request_id
      WHERE j.owner=? AND s.phase!='settled' ORDER BY j.created_at`).all(owner) as Row[];
    const indexed = rows.map((row) => ({ requestId: String(row.request_id), owner: String(row.owner), turn: String(row.turn),
      member: String(row.member), word: String(row.word), label: String(row.label), at: Number(row.created_at), phase: String(row.phase) as RequestPhase }));
    const ids = new Set(indexed.map((job) => job.requestId));
    const fallback = (this.db.prepare(`SELECT m.*,s.phase,s.context AS tracking_context FROM messages m
      JOIN request_state s ON s.request_id=m.id WHERE m."from"=? AND s.phase!='settled' AND m.seq>
      COALESCE((SELECT through_seq FROM agent_job_cutoffs WHERE owner=?),0) ORDER BY m.seq`).all(owner, owner) as Row[])
      .map((row) => this.agentJobFromRequest(owner, row)).filter((job): job is AgentJobRecord => Boolean(job) && !ids.has(job!.requestId));
    return [...indexed, ...fallback].sort((a, b) => a.at - b.at);
  }

  /** Removing an agent creates a fresh identity even when the display id is later reused. */
  forgetAgentJobs(owner: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM agent_jobs WHERE owner=?").run(owner);
      this.db.prepare(`INSERT INTO agent_job_cutoffs(owner,through_seq) VALUES(?,?)
        ON CONFLICT(owner) DO UPDATE SET through_seq=excluded.through_seq`).run(owner, this.lastSeq());
      this.db.exec("COMMIT");
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  private agentJobFromRequest(owner: string, row: Row): AgentJobRecord | null {
    try {
      const context = JSON.parse(String(row.tracking_context)) as RequestContextSnapshot;
      if (!AGENT_ID.test(owner) || row.kind !== "request" || row.from !== owner || typeof row.to !== "string" ||
        typeof row.turn !== "string" || context.member !== owner || context.transportPrincipal !== owner) return null;
      return { requestId: String(row.id), owner, turn: String(row.turn), member: String(row.to), word: String(row.word),
        label: String(row.word), at: Number(row.ts), phase: String(row.phase) as RequestPhase };
    } catch { return null; }
  }

  /** Internal recovery probe for a server-owned stable client ID; never exposed as a public lookup. */
  retryMessage(transportPrincipal: string, clientId: string): Message | null {
    const row = this.db.prepare("SELECT message_id FROM client_retries WHERE scope_hash=? AND client_id=?")
      .get(digest(transportPrincipal), clientId) as Row | undefined;
    return row ? this.byId(String(row.message_id)) : null;
  }

  /** Bounded peripheral evidence, indexed by durable turn identity. */
  turnMessages(turn: string): Message[] {
    return (this.db.prepare("SELECT * FROM messages WHERE turn=? ORDER BY seq LIMIT 2000").all(turn) as Row[]).map(decode);
  }

  /** A restart closes peripheral work as interrupted; it must never replay focus changes. */
  unfinishedDecisions(): Message[] {
    return (this.db.prepare(`SELECT s.* FROM messages s WHERE s."from"='service:reflex'
      AND s.kind='event' AND s.word='decision.started' AND NOT EXISTS (
        SELECT 1 FROM messages a WHERE a."from"='service:reflex' AND a.kind='event'
        AND a.word='decision.applied' AND json_extract(a.body,'$.decision_id')=json_extract(s.body,'$.decision_id'))
      ORDER BY s.seq LIMIT 100`).all() as Row[]).map(decode);
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

  /** A run row and its start event are one durable fact; the active-flow index is the mutex. */
  workStart(requestId: string | null, flow: string, trigger: WorkRunInfoV2["trigger"], now = Date.now()): { run: string; event: Message | null; duplicate: boolean } {
    if (!Number.isSafeInteger(now) || now < 0 || !matchesSchema(wordContract("service:work", "run.start")!.input_schema!, { run: "r_check", flow, trigger }))
      throw new TypeError("invalid work start");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (requestId !== null) {
        const prior = this.db.prepare("SELECT run FROM work_runs WHERE request_id=?").get(requestId) as Row | undefined;
        if (prior) { this.db.exec("COMMIT"); return { run: String(prior.run), event: null, duplicate: true }; }
        const source = this.byId(requestId);
        if (!source || source.kind !== "request" || source.to !== "service:work" || source.word !== "run" || source.body.flow !== flow)
          throw new TypeError("work source does not match accepted request");
      }
      const pausedRow = this.db.prepare("SELECT value FROM kv WHERE key='v2:admin:paused'").get() as Row | undefined;
      if (pausedRow) {
        let paused: unknown;
        try { paused = JSON.parse(String(pausedRow.value)); } catch { throw new TypeError("invalid durable pause state"); }
        if (typeof paused !== "boolean") throw new TypeError("invalid durable pause state");
        if (paused) throw new TypeError("work paused");
      }
      const run = workRunTurn(`r_${randomBytes(12).toString("hex")}`);
      this.db.prepare("INSERT INTO work_runs(run,request_id,flow,trigger,state,started_at,ended_at,detail) VALUES(?,?,?,?,?,?,NULL,'')")
        .run(run, requestId, flow, trigger, "running", now);
      this.workFailpoint?.("start-after-row");
      const id = newId();
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, now, "service:work", null, "event", "run.start", JSON.stringify({ run, flow, trigger }), null, null, run);
      this.workFailpoint?.("start-before-commit");
      this.db.exec("COMMIT");
      this.workFailpoint?.("start-after-commit");
      return { run, event: this.byId(id)!, duplicate: false };
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  /** A process-local timer claims a durable slot once; pause consumes it without later replay. */
  workStartScheduled(flow: string, trigger: "cooldown" | "hourly" | "event", slot: string, now = Date.now()):
    { run: string | null; event: Message | null; duplicate: boolean; skipped: boolean } {
    if (typeof slot !== "string" || !/^[a-z][a-z0-9._:-]{0,127}$/.test(slot) ||
      !Number.isSafeInteger(now) || now < 0 || !matchesSchema(wordContract("service:work", "run.start")!.input_schema!, { run: "r_check", flow, trigger }))
      throw new TypeError("invalid work trigger");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT run,state FROM work_trigger_slots WHERE slot=?").get(slot) as Row | undefined;
      if (prior) { this.db.exec("COMMIT"); return { run: prior.run === null ? null : String(prior.run), event: null, duplicate: true, skipped: prior.state === "skipped" }; }
      const pausedRow = this.db.prepare("SELECT value FROM kv WHERE key='v2:admin:paused'").get() as Row | undefined;
      let paused = false;
      if (pausedRow) {
        try { const value: unknown = JSON.parse(String(pausedRow.value)); if (typeof value !== "boolean") throw new Error(); paused = value; }
        catch { throw new TypeError("invalid durable pause state"); }
      }
      if (paused) {
        this.db.prepare("INSERT INTO work_trigger_slots(slot,flow,trigger,run,state) VALUES(?,?,?,NULL,'skipped')").run(slot, flow, trigger);
        this.db.exec("COMMIT");
        return { run: null, event: null, duplicate: false, skipped: true };
      }
      const run = workRunTurn(`r_${randomBytes(12).toString("hex")}`);
      this.db.prepare("INSERT INTO work_runs(run,request_id,flow,trigger,state,started_at,ended_at,detail) VALUES(?,NULL,?,?,?, ?,NULL,'')")
        .run(run, flow, trigger, "running", now);
      this.db.prepare("INSERT INTO work_trigger_slots(slot,flow,trigger,run,state) VALUES(?,?,?,?, 'started')").run(slot, flow, trigger, run);
      const id = newId();
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, now, "service:work", null, "event", "run.start", JSON.stringify({ run, flow, trigger }), null, null, run);
      this.db.exec("COMMIT");
      return { run, event: this.byId(id)!, duplicate: false, skipped: false };
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  /** Latest completed main turn, unless a newer owner message makes that idle window stale. */
  workCooldownCandidate(now: number): { id: string; due: number } | null {
    const row = this.db.prepare(`SELECT seq,id,ts FROM messages WHERE "from"='agent:main' AND kind='event' AND word='turn.end' ORDER BY seq DESC LIMIT 1`).get() as Row | undefined;
    if (!row) return null;
    const due = Number(row.ts) + 300_000;
    if (!Number.isSafeInteger(due) || now < due) return null;
    const later = this.db.prepare(`SELECT 1 FROM messages WHERE seq>? AND "from"='person:owner' AND "to"='agent:main' AND kind='request' AND word='say' LIMIT 1`).get(Number(row.seq));
    return later ? null : { id: String(row.id), due };
  }

  /** Settle the run and its terminal event atomically; late or repeated completions cannot add a second end. */
  workFinish(run: string, outcome: "done" | "no_change" | "failed", detail: string, now = Date.now()): Message | null {
    if (!Number.isSafeInteger(now) || now < 0 || !matchesSchema(wordContract("service:work", "run.end")!.input_schema!, { run, outcome, detail }))
      throw new TypeError("invalid work finish");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT state,started_at FROM work_runs WHERE run=?").get(run) as Row | undefined;
      if (!row) throw new TypeError("unknown work run");
      if (row.state !== "running") { this.db.exec("COMMIT"); return null; }
      if (now < Number(row.started_at)) throw new TypeError("work end precedes start");
      this.db.prepare("UPDATE work_runs SET state=?,ended_at=?,detail=? WHERE run=? AND state='running'").run(outcome, now, detail, run);
      this.workFailpoint?.("end-after-row");
      const id = newId();
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, now, "service:work", null, "event", "run.end", JSON.stringify({ run, outcome, detail }), null, null, run);
      this.workFailpoint?.("end-before-commit");
      this.db.exec("COMMIT");
      this.workFailpoint?.("end-after-commit");
      return this.byId(id)!;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  /** No uncertain step or external effect is replayed after a process death. */
  workRecover(now = Date.now()): Message[] {
    const active = this.db.prepare("SELECT run,started_at FROM work_runs WHERE state='running' ORDER BY started_at,run").all() as Row[];
    return active.flatMap((row) => {
      const event = this.workFinish(String(row.run), "failed", "interrupted_unknown_effect", Math.max(now, Number(row.started_at)));
      return event ? [event] : [];
    });
  }

  workRuns(flow?: string, limit = 50, state?: WorkRunInfoV2["state"]): WorkRunInfoV2[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("invalid runs limit");
    if (flow !== undefined && !matchesSchema(wordContract("service:work", "run")!.input_schema!, { flow })) throw new TypeError("invalid flow");
    if (state !== undefined && flow === undefined) throw new TypeError("state filter needs a flow");
    const rows = (flow === undefined
      ? this.db.prepare("SELECT run,flow,trigger,state,started_at,ended_at FROM work_runs ORDER BY started_at DESC,run DESC LIMIT ?").all(limit)
      : state === undefined
        ? this.db.prepare("SELECT run,flow,trigger,state,started_at,ended_at FROM work_runs WHERE flow=? ORDER BY started_at DESC,run DESC LIMIT ?").all(flow, limit)
        : this.db.prepare("SELECT run,flow,trigger,state,started_at,ended_at FROM work_runs WHERE flow=? AND state=? ORDER BY started_at DESC,run DESC LIMIT ?").all(flow, state, limit)) as Row[];
    const runs = rows.map((row) => ({ run: String(row.run), flow: String(row.flow), trigger: String(row.trigger) as WorkRunInfoV2["trigger"],
      state: String(row.state) as WorkRunInfoV2["state"], started_at: Number(row.started_at), ended_at: row.ended_at === null ? null : Number(row.ended_at) }));
    if (workRunsResultErrors({ runs }).length) throw new TypeError("invalid durable work run metadata");
    return runs;
  }

  /** Conversation since the last successfully processed memory run, frozen at this run's start. */
  memoryEvidenceWindow(run: string): Message[] {
    const start = this.db.prepare("SELECT seq FROM messages WHERE turn=? AND word='run.start' AND kind='event'").get(run) as Row | undefined;
    if (!start) throw new TypeError("memory run has no start event");
    const previous = this.db.prepare(`SELECT MAX(m.seq) AS seq FROM messages m JOIN work_runs w ON w.run=m.turn
      WHERE m.word='run.end' AND m.kind='event' AND w.flow='memory' AND w.state IN ('done','no_change') AND m.seq<?`).get(Number(start.seq)) as Row;
    const rows = this.db.prepare(`SELECT * FROM messages WHERE seq>? AND seq<? AND kind='request' AND word='say'
      AND (("from"='person:owner' AND "to"='agent:main') OR ("from"='agent:main' AND "to"='person:owner')) ORDER BY seq`)
      .all(Number(previous.seq ?? 0), Number(start.seq)) as Row[];
    return rows.map(decode);
  }

  /** Provenance for a code-owned work request; existence of a service name alone is not authorization. */
  workRunSource(run: string): { flow: string; startedAt: number; endedAt: number | null } | null {
    if (!matchesSchema(wordContract("service:work", "run")!.result_schema!, { run })) return null;
    const row = this.db.prepare("SELECT flow,started_at,ended_at FROM work_runs WHERE run=?").get(run) as Row | undefined;
    return row ? { flow: String(row.flow), startedAt: Number(row.started_at), endedAt: row.ended_at === null ? null : Number(row.ended_at) } : null;
  }

  workStep(body: WorkRunStepBodyV2, now = Date.now()): Message {
    if (!Number.isSafeInteger(now) || now < 0 || !matchesSchema(wordContract("service:work", "run.step")!.input_schema!, body))
      throw new TypeError("invalid work step");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT state FROM work_runs WHERE run=?").get(body.run) as Row | undefined;
      if (row?.state !== "running") throw new TypeError("work step needs active run");
      const id = newId();
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, now, "service:work", null, "event", "run.step", JSON.stringify(body), null, null, workRunTurn(body.run));
      this.db.exec("COMMIT");
      return this.byId(id)!;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  trackedRequests(): TrackedRequest[] {
    const rows = this.db.prepare(`SELECT m.*, s.phase AS tracking_phase, s.deadline_at, s.context AS tracking_context
      FROM request_state s JOIN messages m ON m.id=s.request_id WHERE s.phase!='settled' ORDER BY m.seq`).all() as Row[];
    return rows.map((row) => ({ message: decode(row), phase: String(row.tracking_phase) as RequestPhase, deadlineAt: Number(row.deadline_at), context: JSON.parse(String(row.tracking_context)) }));
  }

  /** A settled request retains its authenticated caller snapshot for later provenance checks. */
  requestSource(id: string): { message: Message; context: RequestContextSnapshot } | null {
    const row = this.db.prepare(`SELECT m.*,s.context AS tracking_context FROM request_state s
      JOIN messages m ON m.id=s.request_id WHERE s.request_id=?`).get(id) as Row | undefined;
    if (!row) return null;
    try {
      const context = JSON.parse(String(row.tracking_context)) as RequestContextSnapshot;
      if (!context || typeof context !== "object" || typeof context.member !== "string" || typeof context.local !== "boolean" ||
        typeof context.remote !== "boolean" || typeof context.ownerProxy !== "boolean" ||
        (context.nativeUi !== undefined && typeof context.nativeUi !== "boolean") ||
        (context.transportPrincipal !== undefined && typeof context.transportPrincipal !== "string") ||
        (context.screenId !== undefined && typeof context.screenId !== "string")) return null;
      return { message: decode(row), context };
    } catch { return null; }
  }

  advanceRequest(requestId: string, from: RequestPhase, to: RequestPhase): boolean {
    if (!((from === "accepted" && (to === "gate_waiting" || to === "dispatching")) || (from === "gate_waiting" && to === "dispatching"))) throw new TypeError("invalid request phase transition");
    const updated = this.db.prepare("UPDATE request_state SET phase=?,updated_at=? WHERE request_id=? AND phase=?").run(to, Date.now(), requestId, from);
    return Number(updated.changes) === 1;
  }

  /** Atomically enter the gate and create its single owner ask and audit event. */
  beginGate(requestId: string, input: GateCaseStart): { ask: Message; event: Message } | null {
    if (!input.subject || !/^[a-f0-9]{64}$/.test(input.contractFingerprint) ||
      !["none", "outward", "structure"].includes(input.risk) || !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt < 0 || !matchesSchema(wordContract("person:owner", "ask")!.input_schema!,
        { ...input.askBody, expires_at: input.expiresAt })) throw new TypeError("invalid gate case");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const tracked = this.db.prepare(`SELECT m.*,s.phase,s.deadline_at FROM messages m JOIN request_state s ON s.request_id=m.id
        WHERE m.id=?`).get(requestId) as Row | undefined;
      if (!tracked || tracked.kind !== "request" || tracked.phase !== "accepted" || !tracked.to ||
        input.expiresAt > Number(tracked.deadline_at) || input.expiresAt <= Date.now()) { this.db.exec("COMMIT"); return null; }
      if (String(tracked.to).startsWith("device:") && !deviceCaller(String(tracked.from))) { this.db.exec("COMMIT"); return null; }
      const source = obj(input.askBody.source);
      if (source.word !== tracked.word || source.to !== tracked.to) throw new TypeError("gate ask source does not match accepted request");
      const optionIds = (input.askBody.options as { id?: unknown }[]).map((option) => option.id);
      const reviewedObject = typeof input.objectPattern === "string" &&
        gateRulePattern(String(tracked.to), String(tracked.word), obj(JSON.parse(String(tracked.body)))) === input.objectPattern;
      if (input.objectPattern !== undefined && !reviewedObject) throw new TypeError("approval object does not match request");
      if (optionIds.join(",") !== (reviewedObject ? "once,always,deny" : "once,deny")) throw new TypeError("gate choices do not match reviewed object policy");
      if (this.db.prepare("SELECT 1 FROM gate_cases WHERE request_id=?").get(requestId)) throw new TypeError("duplicate gate case");
      const at = Date.now();
      const askId = newId();
      const askBody = { ...input.askBody, expires_at: input.expiresAt };
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(askId, at, "service:gate", "person:owner", "request", "ask", JSON.stringify(askBody), null, null, tracked.turn === null ? null : String(tracked.turn));
      this.db.prepare("INSERT INTO request_state(request_id,phase,deadline_at,context,updated_at) VALUES(?,?,?,?,?)")
        .run(askId, "accepted", input.expiresAt, JSON.stringify({ member: "service:gate", local: true, remote: false, ownerProxy: false, transportPrincipal: "service:gate" }), at);
      this.db.prepare(`INSERT INTO gate_cases(request_id,ask_id,subject,risk,contract_fingerprint,expires_at,object_pattern,decision)
        VALUES(?,?,?,?,?,?,?,?)`).run(requestId, askId, input.subject, input.risk, input.contractFingerprint, input.expiresAt,
          input.objectPattern ?? null, "waiting");
      const changed = this.db.prepare("UPDATE request_state SET phase='gate_waiting',updated_at=? WHERE request_id=? AND phase='accepted'").run(at, requestId);
      if (Number(changed.changes) !== 1) throw new TypeError("gate phase changed");
      const eventId = newId();
      const body = { request_id: requestId, ask_id: askId, risk: input.risk, to: String(tracked.to), word: String(tracked.word), expires_at: input.expiresAt };
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(eventId, at, "service:gate", null, "event", "gate.asked", JSON.stringify(body), null, null, tracked.turn === null ? null : String(tracked.turn));
      this.db.exec("COMMIT");
      return { ask: this.byId(askId)!, event: this.byId(eventId)! };
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  /**
   * An owner's "always" rule may pass a new request without an ask: a rule for this target, a rule for the whole
   * capability ("*"), or an earlier exact-object rule for this very request.
   */
  passGateByRule(requestId: string, subject: string, contractFingerprint: string): Message | null {
    if (!subject || !/^[a-f0-9]{64}$/.test(contractFingerprint)) return null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const request = this.db.prepare(`SELECT m.*,s.phase,s.deadline_at FROM messages m JOIN request_state s ON s.request_id=m.id
        WHERE m.id=?`).get(requestId) as Row | undefined;
      if (!request || request.phase !== "accepted" || typeof request.to !== "string" ||
        Date.now() >= Number(request.deadline_at) || (request.to.startsWith("device:") && !deviceCaller(String(request.from)))) {
        this.db.exec("COMMIT"); return null;
      }
      const body = obj(JSON.parse(String(request.body)));
      const patterns = [...new Set([gateRulePattern(request.to, String(request.word), body), gateObject(request.to, String(request.word), body)])];
      const now = Date.now();
      const rule = this.db.prepare(`SELECT id,risk FROM gate_rules WHERE subject=? AND target=? AND word=? AND object_pattern IN (${patterns.map(() => "?").join(",")})
        AND contract_fingerprint=? AND expires_at>? AND revoked_at IS NULL ORDER BY seq DESC LIMIT 1`)
        .get(subject, String(request.to), String(request.word), ...patterns, contractFingerprint, now) as Row | undefined;
      if (!rule) { this.db.exec("COMMIT"); return null; }
      const changed = this.db.prepare("UPDATE request_state SET phase='dispatching',updated_at=? WHERE request_id=? AND phase='accepted'")
        .run(now, requestId);
      if (Number(changed.changes) !== 1) throw new TypeError("rule pass phase changed");
      const id = newId();
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, now, "service:gate", null, "event", "gate.passed", JSON.stringify({ request_id: requestId, by: "rule", rule_id: rule.id }),
          null, null, request.turn === null ? null : String(request.turn));
      this.db.prepare(`INSERT INTO gate_history(id,request_id,subject,target,word,risk,decision,at,source,rule_id)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(newId(), requestId, subject, request.to as string, request.word as string,
        rule.risk as string, "rule", now, "current", rule.id as string);
      this.db.exec("COMMIT");
      return this.byId(id)!;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  /**
   * Pass an accepted request without an owner ask: the reviewer judged it (review) or the same thing was allowed a few
   * minutes ago (carry). The phase change, the audit event and the history row commit together.
   */
  passGate(requestId: string, subject: string, by: "review" | "carry", reason: string, risk: "none" | "outward" | "structure"): Message | null {
    const why = reason.replace(/[\p{Cc}]+/gu, " ").trim().slice(0, 500);
    if (!subject || !why) return null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const request = this.db.prepare(`SELECT m.*,s.phase,s.deadline_at FROM messages m JOIN request_state s ON s.request_id=m.id
        WHERE m.id=?`).get(requestId) as Row | undefined;
      if (!request || request.kind !== "request" || request.phase !== "accepted" || typeof request.to !== "string" ||
        Date.now() >= Number(request.deadline_at) || (request.to.startsWith("device:") && !deviceCaller(String(request.from)))) {
        this.db.exec("COMMIT"); return null;
      }
      const now = Date.now();
      const changed = this.db.prepare("UPDATE request_state SET phase='dispatching',updated_at=? WHERE request_id=? AND phase='accepted'")
        .run(now, requestId);
      if (Number(changed.changes) !== 1) throw new TypeError("gate pass phase changed");
      const id = newId();
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, now, "service:gate", null, "event", "gate.passed", JSON.stringify({ request_id: requestId, by, reason: why }),
          null, null, request.turn === null ? null : String(request.turn));
      this.db.prepare(`INSERT INTO gate_history(id,request_id,subject,target,word,risk,decision,at,source,reason)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(newId(), requestId, subject, request.to, String(request.word), risk, by, now, "current", why);
      this.db.exec("COMMIT");
      return this.byId(id)!;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  /**
   * What the reviewer may know about the turn a request belongs to: the owner's own words that opened it, and the
   * requester's earlier actions in it (word and a short preview of what it asked, never results).
   */
  turnFacts(turn: string | undefined, requester: string, beforeSeq: number): { ownerSaid: string[]; steps: string[] } {
    if (!turn) return { ownerSaid: [], steps: [] };
    // The turn's opening messages, plus any the owner added while it ran (each recorded by a read event of that turn).
    const events = this.db.prepare(`SELECT body FROM messages WHERE turn=? AND kind='event' AND word IN ('turn.start','read') AND "from"=?
      ORDER BY seq`).all(turn, requester) as Row[];
    const ids = [...new Set(events.flatMap((event) => { const listed = obj(JSON.parse(String(event.body))).ids; return Array.isArray(listed) ? listed : []; }))];
    const ownerSaid: string[] = [];
    for (const id of ids.slice(-8)) {
      const said = typeof id === "string" ? this.byId(id) : null;
      if (said && said.from === "person:owner" && said.kind === "request" && said.word === "say" && typeof said.body.text === "string" && said.body.text.trim())
        ownerSaid.push(said.body.text);
    }
    const rows = this.db.prepare(`SELECT "to",word,body FROM messages WHERE turn=? AND "from"=? AND kind='request' AND seq<?
      ORDER BY seq DESC LIMIT 8`).all(turn, requester, beforeSeq) as Row[];
    const steps = rows.reverse().map((row) => `${String(row.to)}/${String(row.word)} ${String(row.body).slice(0, 200)}`);
    return { ownerSaid, steps };
  }

  gateCase(requestId: string): GateCaseRecord | null {
    const row = this.db.prepare("SELECT * FROM gate_cases WHERE request_id=?").get(requestId) as Row | undefined;
    if (!row) return null;
    return { requestId: String(row.request_id), askId: String(row.ask_id), subject: String(row.subject),
      risk: row.risk as GateCaseRecord["risk"], contractFingerprint: String(row.contract_fingerprint),
      expiresAt: Number(row.expires_at), decision: row.decision as GateCaseRecord["decision"],
      ...(row.object_pattern === null ? {} : { objectPattern: String(row.object_pattern) }),
      ...(row.rule_id === null ? {} : { ruleId: String(row.rule_id) }) };
  }

  gateCaseByAsk(askId: string): GateCaseRecord | null {
    const row = this.db.prepare("SELECT request_id FROM gate_cases WHERE ask_id=?").get(askId) as Row | undefined;
    return row ? this.gateCase(String(row.request_id)) : null;
  }

  /** Trusted answer/deadline cause is supplied by the router, never inferred from choice=deny. */
  settleGateAsk(askId: string, choice: "once" | "always" | "deny", cause: "answer" | "deadline" | "cancelled",
    origin?: Message["origin"], retry?: ClientRetry): { askResponse: Message; event: Message | null; originalResponse: Message | null } | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT c.*,s.phase AS request_phase,m."to" AS target,m.word AS request_word,
        a."from" AS ask_from,a."to" AS ask_to,a.word AS ask_word
        FROM gate_cases c JOIN request_state s ON s.request_id=c.request_id JOIN messages m ON m.id=c.request_id
        JOIN messages a ON a.id=c.ask_id WHERE c.ask_id=?`).get(askId) as Row | undefined;
      if (!row || row.decision !== "waiting" || row.request_phase !== "gate_waiting" || row.ask_from !== "service:gate" ||
        row.ask_to !== "person:owner" || row.ask_word !== "ask") { this.db.exec("COMMIT"); return null; }
      const at = Date.now();
      if (cause === "answer" && at >= Number(row.expires_at)) throw new TypeError("gate ask expired before answer");
      if (cause === "deadline" && at < Number(row.expires_at)) throw new TypeError("gate deadline has not elapsed");
      // A card left waiting by the earlier access-card gate offered "always"; it now means this once.
      if (choice === "always" && typeof row.object_pattern !== "string" && typeof row.access_scope === "string") choice = "once";
      if (cause === "answer" && choice === "always" && typeof row.object_pattern !== "string")
        throw new TypeError("always not available for this capability");
      const timedOut = cause === "deadline";
      const decision = cause === "cancelled" ? "cancelled" : timedOut ? "timeout" : choice === "deny" ? "denied" : "allowed";
      const askBody: ResponseBody = decision === "cancelled"
        ? { ok: false, error: { code: "cancelled", message: "approval withdrawn" } }
        : { ok: true, result: { choice: timedOut ? "deny" : choice } };
      const askResponseId = newId();
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(askResponseId, at, "person:owner", "service:gate", "response", "ask", JSON.stringify(askBody), askId,
          origin ? JSON.stringify(origin) : null, null);
      this.db.prepare("UPDATE request_state SET phase='settled',updated_at=? WHERE request_id=? AND phase!='settled'").run(at, askId);
      if (retry) this.db.prepare("INSERT INTO client_retries(scope_hash,client_id,payload_hash,message_id) VALUES(?,?,?,?)")
        .run(digest(retry.transportPrincipal), retry.clientId,
          retryPayload({ from: "person:owner", to: "service:gate", kind: "response", word: "ask", body: askBody, reply_to: askId }), askResponseId);
      this.db.prepare("UPDATE gate_cases SET decision=?,decided_at=? WHERE ask_id=? AND decision='waiting'").run(decision, at, askId);
      let ruleId: string | null = null;
      if (decision === "allowed" && choice === "always") {
        ruleId = newId();
        const original = this.byId(String(row.request_id))!;
        this.db.prepare(`INSERT INTO gate_rules(id,subject,subject_alias,device_id,capability_id,target,word,object_pattern,risk,
          contract_fingerprint,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(ruleId, row.subject as string, original.from, row.target as string, row.request_word as string,
            row.target as string, row.request_word as string, row.object_pattern as string, row.risk as string,
            row.contract_fingerprint as string, at, at + 30 * 24 * 60 * 60_000);
        this.db.prepare("UPDATE gate_cases SET rule_id=? WHERE ask_id=?").run(ruleId, askId);
      }
      const historyDecision = decision === "allowed" ? choice : decision === "timeout" ? "timeout" : decision === "cancelled" ? "cancelled" : "deny";
      this.db.prepare(`INSERT INTO gate_history(id,request_id,ask_id,subject,target,word,risk,decision,at,source,rule_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(newId(), row.request_id as string, askId, row.subject as string,
        row.target as string, row.request_word as string, row.risk as string, historyDecision, at, "current", ruleId);
      let eventId: string | null = null;
      if (decision !== "cancelled") {
        eventId = newId();
        const eventWord = decision === "allowed" ? "gate.passed" : "gate.denied";
        const eventBody = decision === "allowed"
          ? { request_id: row.request_id, by: "answer", ask_id: askId, ...(ruleId ? { rule_id: ruleId } : {}) }
          : { request_id: row.request_id, by: decision === "timeout" ? "timeout" : "answer", ask_id: askId };
        this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(eventId, at, "service:gate", null, "event", eventWord, JSON.stringify(eventBody), null, null, null);
      }
      let originalResponseId: string | null = null;
      if (decision !== "allowed") {
        originalResponseId = newId();
        const body: ResponseBody = { ok: false, error: { code: decision === "cancelled" ? "cancelled" : "denied",
          message: decision === "timeout" ? "approval expired" : decision === "cancelled" ? "request cancelled" : "owner denied request" } };
        this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(originalResponseId, at, row.target as string, this.byId(String(row.request_id))!.from, "response", row.request_word as string,
            JSON.stringify(body), row.request_id as string, null, null);
        this.db.prepare("UPDATE request_state SET phase='settled',updated_at=? WHERE request_id=? AND phase='gate_waiting'").run(at, row.request_id as string);
      }
      this.db.exec("COMMIT");
      return { askResponse: this.byId(askResponseId)!, event: eventId ? this.byId(eventId)! : null,
        originalResponse: originalResponseId ? this.byId(originalResponseId)! : null };
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  /** Called only after current authority and endpoint contract are revalidated. */
  dispatchAllowedGate(requestId: string, subject: string, contractFingerprint: string): boolean {
    if (!subject || !/^[a-f0-9]{64}$/.test(contractFingerprint)) return false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare(`SELECT c.decision,c.subject,c.contract_fingerprint,c.expires_at,s.phase,s.deadline_at,
        m."from" AS request_from,m."to" AS request_to,m.word AS request_word,
        a.kind AS ask_kind,a.word AS ask_word,r.body AS answer_body
        FROM gate_cases c JOIN request_state s ON s.request_id=c.request_id
        JOIN messages m ON m.id=c.request_id
        JOIN messages a ON a.id=c.ask_id
        LEFT JOIN messages r ON r.reply_to=c.ask_id AND r.kind='response'
        WHERE c.request_id=?`).get(requestId) as Row | undefined;
      if (!row || row.decision !== "allowed" || row.phase !== "gate_waiting" || row.subject !== subject ||
        row.contract_fingerprint !== contractFingerprint || row.ask_kind !== "request" || row.ask_word !== "ask" ||
        typeof row.answer_body !== "string" || Date.now() >= Number(row.deadline_at)) {
        this.db.exec("COMMIT"); return false;
      }
      if (String(row.request_to).startsWith("device:") && !deviceCaller(String(row.request_from))) { this.db.exec("COMMIT"); return false; }
      const answer = JSON.parse(row.answer_body) as ResponseBody;
      if (answer.ok !== true || !["once", "always"].includes(String(obj(answer.result).choice))) { this.db.exec("COMMIT"); return false; }
      const changed = this.db.prepare("UPDATE request_state SET phase='dispatching',updated_at=? WHERE request_id=? AND phase='gate_waiting'")
        .run(Date.now(), requestId);
      this.db.exec("COMMIT");
      return Number(changed.changes) === 1;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  gateRulesPage(before = Number.MAX_SAFE_INTEGER, limit = 100): { rules: GateRuleItemV2[]; next_before?: number } {
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("invalid gate rules page");
    const rows = this.db.prepare("SELECT * FROM gate_rules WHERE seq<? ORDER BY seq DESC LIMIT ?").all(before, limit + 1) as Row[];
    const page = rows.slice(0, limit);
    return { rules: page.map((row) => ({ id: String(row.id), subject: String(row.subject_alias),
      ...(row.device_id === null ? {} : { device_id: String(row.device_id) }),
      ...(row.capability_id === null ? {} : { capability_id: String(row.capability_id) }),
      to: String(row.target), word: String(row.word), object_pattern: String(row.object_pattern),
      risk: row.risk as GateRuleItemV2["risk"], contract_fingerprint: String(row.contract_fingerprint),
      created_at: Number(row.created_at), expires_at: Number(row.expires_at),
      ...(row.revoked_at === null ? {} : { revoked_at: Number(row.revoked_at) }) })),
      ...(rows.length > limit ? { next_before: Number(rows[limit - 1]!.seq) } : {}) };
  }

  gateHistoryPage(before = Number.MAX_SAFE_INTEGER, limit = 100): { items: GateHistoryItemV2[]; next_before?: number } {
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("invalid gate history page");
    const rows = this.db.prepare(`SELECT h.*,m."from" AS caller_member,a.expires_at AS legacy_expires_at,e.label AS evidence_label FROM gate_history h
      LEFT JOIN messages m ON m.id=h.request_id LEFT JOIN gate_access a ON a.source_hash=h.legacy_source_hash LEFT JOIN gate_evidence e ON e.request_id=h.request_id
      WHERE h.seq<? ORDER BY h.seq DESC LIMIT ?`).all(before, limit + 1) as Row[];
    const page = rows.slice(0, limit);
    return { items: page.map((row): GateHistoryItemV2 => row.source === "legacy"
      ? { id: String(row.id), decision: row.decision === "legacy_access_imported" && row.legacy_expires_at !== null &&
          Date.now() >= Number(row.legacy_expires_at) ? "legacy_access_expired" : row.decision as Extract<GateHistoryItemV2, { source: "legacy" }>["decision"],
        at: Number(row.at), source: "legacy", ...(row.subject === null ? {} : { subject: String(row.subject) }),
        ...(row.legacy_scope === null ? {} : { legacy_scope: String(row.legacy_scope) }) }
      : { id: String(row.id), request_id: String(row.request_id), ...(row.ask_id === null ? {} : { ask_id: String(row.ask_id) }),
        subject: String(row.caller_member), to: String(row.target), word: String(row.word), risk: row.risk as "none" | "outward" | "structure",
        decision: row.decision as "once" | "always" | "deny" | "timeout" | "cancelled" | "rule" | "review" | "carry", at: Number(row.at),
        ...(row.rule_id === null ? {} : { rule_id: String(row.rule_id) }),
        ...(typeof row.reason === "string" && row.reason ? { reason: row.reason.slice(0, 500) } : {}),
        ...(typeof row.evidence_label === "string" && row.evidence_label && row.target !== "service:gate" ? { label: row.evidence_label.slice(0, 120) } : {}), source: "current" }),
      ...(rows.length > limit ? { next_before: Number(rows[limit - 1]!.seq) } : {}) };
  }

  /**
   * The earlier per-capability access list. Nothing gates on it any more — agents reach device capabilities and the
   * approval gate judges each action — but old grants stay readable and the access.* words keep working.
   */
  gateDeviceAccess(member: string, device: string, capability: string, at = Date.now()): boolean {
    if (member === "person:owner") return true;
    if (!/^agent:[A-Za-z0-9_-]+$/.test(member) || !/^device:[A-Za-z0-9_-]+$/.test(device) || !/^[A-Za-z0-9_.-]+$/.test(capability)) return false;
    const row = this.db.prepare(`SELECT 1 FROM gate_access WHERE member=? AND revoked_at IS NULL AND expires_at>? AND
      scope IN ('*',?,?) LIMIT 1`).get(member, at, `${device}/*`, `${device}/${capability}`);
    return Boolean(row);
  }

  gateAccessPage(before = Number.MAX_SAFE_INTEGER, limit = 100): { items: GateAccessItemV2[]; next_before?: number } {
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new TypeError("invalid access page");
    const rows = this.db.prepare("SELECT * FROM gate_access WHERE seq<? ORDER BY seq DESC LIMIT ?").all(before, limit + 1) as Row[];
    return { items: rows.slice(0, limit).map((row) => ({ id: String(row.id), member: String(row.member), scope: String(row.scope),
      source: row.source as "current" | "legacy", created_at: Number(row.created_at), expires_at: Number(row.expires_at),
      ...(row.revoked_at === null ? {} : { revoked_at: Number(row.revoked_at) }) })),
    ...(rows.length > limit ? { next_before: Number(rows[limit - 1]!.seq) } : {}) };
  }

  /** The ACL mutation, its audit record and its response commit together; a retry cannot extend expiry. */
  gateAccessGrant(requestId: string, member: string, scope: string): Message {
    if (!/^agent:[A-Za-z0-9_-]+$/.test(member) || !/^device:[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(scope))
      throw new TypeError("invalid exact access target");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const request = this.db.prepare(`SELECT m.*,s.phase FROM messages m JOIN request_state s ON s.request_id=m.id WHERE m.id=?`).get(requestId) as Row | undefined;
      if (!request || request.from !== "person:owner" || request.to !== "service:gate" || request.kind !== "request" ||
        request.word !== "access.grant" || request.phase !== "dispatching") throw new TypeError("access grant request unavailable");
      const body = obj(JSON.parse(String(request.body)));
      if (body.member !== member || body.scope !== scope) throw new TypeError("access grant target changed");
      const at = Date.now();
      const expiry = at + 30 * 24 * 60 * 60_000;
      if (!Number.isSafeInteger(expiry)) throw new TypeError("access expiry exceeds safe integer");
      this.db.prepare(`UPDATE gate_access SET revoked_at=? WHERE source='current' AND member=? AND scope=?
        AND revoked_at IS NULL AND expires_at>?`).run(at, member, scope, at);
      const id = newId();
      this.db.prepare(`INSERT INTO gate_access(id,member,scope,source,created_at,expires_at) VALUES(?,?,?,?,?,?)`)
        .run(id, member, scope, "current", at, expiry);
      this.db.prepare("INSERT INTO gate_access_audit(request_id,access_id,action,at) VALUES(?,?,?,?)").run(requestId, id, "grant", at);
      const responseId = newId();
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(responseId, at, "service:gate", "person:owner", "response", "access.grant",
          JSON.stringify({ ok: true, result: { id, member, scope, expires_at: expiry } }), requestId, null, request.turn as string | null);
      this.db.prepare("UPDATE request_state SET phase='settled',updated_at=? WHERE request_id=? AND phase='dispatching'").run(at, requestId);
      this.db.exec("COMMIT");
      return this.byId(responseId)!;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  gateAccessRevoke(requestId: string, accessId: string): Message {
    if (!accessId) throw new TypeError("invalid access id");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const request = this.db.prepare(`SELECT m.*,s.phase FROM messages m JOIN request_state s ON s.request_id=m.id WHERE m.id=?`).get(requestId) as Row | undefined;
      if (!request || request.from !== "person:owner" || request.to !== "service:gate" || request.kind !== "request" ||
        request.word !== "access.revoke" || request.phase !== "dispatching" || obj(JSON.parse(String(request.body))).id !== accessId)
        throw new TypeError("access revoke request unavailable");
      const at = Date.now();
      const changed = this.db.prepare("UPDATE gate_access SET revoked_at=? WHERE id=? AND revoked_at IS NULL").run(at, accessId);
      const revoked = Number(changed.changes) === 1;
      this.db.prepare("INSERT INTO gate_access_audit(request_id,access_id,action,at) VALUES(?,?,?,?)").run(requestId, accessId, "revoke", at);
      const responseId = newId();
      this.db.prepare('INSERT INTO messages (id,ts,"from","to",kind,word,body,reply_to,origin,turn) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(responseId, at, "service:gate", "person:owner", "response", "access.revoke",
          JSON.stringify({ ok: true, result: { revoked } }), requestId, null, request.turn as string | null);
      this.db.prepare("UPDATE request_state SET phase='settled',updated_at=? WHERE request_id=? AND phase='dispatching'").run(at, requestId);
      this.db.exec("COMMIT");
      return this.byId(responseId)!;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }

  revokeGateRule(id: string, by?: string): boolean {
    if (!id) throw new TypeError("invalid gate rule id");
    const changed = this.db.prepare("UPDATE gate_rules SET revoked_at=?,revoked_by=? WHERE id=? AND revoked_at IS NULL").run(Date.now(), by ?? null, id);
    return Number(changed.changes) === 1;
  }

  /** A rule made by an approved request (an agent asked, the owner said yes), never by an agent alone. */
  addGateRule(input: { subject: string; alias: string; target: string; word: string; pattern: string; risk: string;
    contractFingerprint: string; days: number; createdBy: string }): { id: string; expires_at: number } {
    if (!/^[a-f0-9]{64}$/.test(input.subject) || !/^[a-f0-9]{64}$/.test(input.contractFingerprint) || !Number.isSafeInteger(input.days) ||
      input.days < 1 || input.days > 30 || !input.pattern) throw new TypeError("invalid gate rule");
    const id = newId();
    const at = Date.now();
    const expires = at + input.days * 24 * 60 * 60_000;
    this.db.prepare(`INSERT INTO gate_rules(id,subject,subject_alias,device_id,capability_id,target,word,object_pattern,risk,
      contract_fingerprint,created_at,expires_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, input.subject, input.alias, input.target, input.word, input.target, input.word, input.pattern, input.risk,
        input.contractFingerprint, at, expires, input.createdBy);
    return { id, expires_at: expires };
  }

  /** Record what an approval decision was based on; later stages add their part to the same request's row. */
  gateEvidence(requestId: string, fields: { requester?: string; member?: string; word?: string; label?: string; effect?: string; turn?: string | null;
    content?: string; facts?: unknown; review?: unknown; card?: unknown }): void {
    const request = this.byId(requestId);
    if (!request) return;
    this.db.prepare(`INSERT OR IGNORE INTO gate_evidence(request_id,at,requester,member,word,label,effect,turn,content)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(requestId, Date.now(), fields.requester ?? request.from, fields.member ?? request.to ?? "",
      fields.word ?? request.word, fields.label ?? null, fields.effect ?? null, fields.turn ?? request.turn ?? null, fields.content ?? null);
    for (const key of ["label", "effect", "content"] as const)
      if (fields[key] !== undefined) this.db.prepare(`UPDATE gate_evidence SET ${key}=? WHERE request_id=?`).run(fields[key] as string, requestId);
    for (const key of ["facts", "review", "card"] as const)
      if (fields[key] !== undefined) this.db.prepare(`UPDATE gate_evidence SET ${key}=? WHERE request_id=?`).run(JSON.stringify(fields[key]), requestId);
  }

  /** Approval evidence, newest first, with the decision, who made it, and whether the action then ran. */
  gateAudit(query: { request_id?: string; requester?: string; word?: string; decision?: string; before?: number; limit?: number }): { entries: Record<string, unknown>[]; next_before?: number } {
    const limit = Math.min(Math.max(query.limit ?? 10, 1), 50);
    const where: string[] = ["e.rowid<?"];
    const args: (string | number)[] = [query.before ?? Number.MAX_SAFE_INTEGER];
    if (query.request_id) { where.push("e.request_id=?"); args.push(query.request_id); }
    if (query.requester) { where.push("e.requester=?"); args.push(query.requester); }
    if (query.word) { where.push("e.word=?"); args.push(query.word); }
    const rows = this.db.prepare(`SELECT e.rowid AS row_id,e.* FROM gate_evidence e WHERE ${where.join(" AND ")} ORDER BY e.rowid DESC LIMIT ?`)
      .all(...args, query.decision ? 500 : limit + 1) as Row[];
    const parse = (value: unknown) => { try { return value === null || value === undefined ? null : JSON.parse(String(value)); } catch { return null; } };
    const entries: Record<string, unknown>[] = [];
    let last: number | undefined;
    for (const row of rows) {
      const history = this.db.prepare("SELECT decision,reason,rule_id,at,ask_id FROM gate_history WHERE request_id=? ORDER BY seq DESC LIMIT 1").get(String(row.request_id)) as Row | undefined;
      const decision = history ? String(history.decision) : "waiting";
      if (query.decision && decision !== query.decision) continue;
      if (entries.length >= limit) break;
      const response = this.responseTo(String(row.request_id));
      const answer = history?.ask_id ? this.responseTo(String(history.ask_id)) : null;
      const body = response?.body as { ok?: boolean; error?: { code?: string; message?: string } } | undefined;
      entries.push({ request_id: String(row.request_id), at: Number(row.at), requester: String(row.requester), member: String(row.member), word: String(row.word),
        label: row.label === null ? "" : String(row.label), effect: row.effect === null ? "" : String(row.effect), turn: row.turn === null ? "" : String(row.turn),
        content: row.content === null ? "" : String(row.content), facts: parse(row.facts), review: parse(row.review), card: parse(row.card),
        decision, decided_by: ["rule", "review", "carry"].includes(decision) ? decision : ["once", "always", "deny"].includes(decision) ? "owner" : decision,
        reason: history?.reason === null || history?.reason === undefined ? "" : String(history.reason),
        rule_id: history?.rule_id === null || history?.rule_id === undefined ? "" : String(history.rule_id),
        answered_at: answer ? answer.ts : null,
        executed: body ? (body.ok ? { ok: true } : { ok: false, error: body.error?.code ?? "failed", message: String(body.error?.message ?? "").slice(0, 200) }) : null });
      last = Number(row.row_id);
    }
    return { entries, ...(entries.length >= limit && last !== undefined ? { next_before: last } : {}) };
  }

  byId(id: string): Message | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id=?").get(id) as Row | undefined;
    return row ? decode(row) : null;
  }
  bySeq(seq: number): Message | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE seq=?").get(seq) as Row | undefined;
    return row ? decode(row) : null;
  }
  seqPage(after: number, limit = 1000): number[] {
    const rows = this.db.prepare("SELECT seq FROM messages WHERE seq>? ORDER BY seq LIMIT ?")
      .iterate(after, Math.min(Math.max(limit, 1), 1000)) as Iterable<Row>;
    return Array.from(rows, (row) => Number(row.seq));
  }

  /** Model usage over the last `days` days, summed by period, part of Ash and local day. Costs of unpriced calls are counted apart, never as zero. */
  usageSummary(days: number, now: number, timeZone: string): UsageSummary {
    const span = Math.min(Math.max(Math.trunc(days), 1), 90);
    const dayOf = (at: number) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
    const dayStart = (offset: number) => dayOf(now - offset * 86_400_000);
    const first = dayStart(Math.max(span, 30) - 1);
    const rows = this.db.prepare(`SELECT ts, body FROM messages WHERE "from"='service:cost' AND word='usage.recorded' AND kind='event' AND ts>=? ORDER BY seq`)
      .all(now - (Math.max(span, 30) + 1) * 86_400_000) as Row[];
    const zero = (): UsageTotals => ({ calls: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0, unpriced_calls: 0 });
    const add = (into: UsageTotals, body: Record<string, unknown>) => {
      into.calls++;
      into.input_tokens += Number(body.input_tokens) || 0; into.output_tokens += Number(body.output_tokens) || 0; into.cache_read_tokens += Number(body.cache_read_tokens) || 0;
      if (typeof body.cost_usd === "number") into.cost_usd += body.cost_usd; else into.unpriced_calls++;
    };
    const today = dayOf(now), week = dayStart(6), month = dayStart(29);
    const periods = { today: zero(), "7d": zero(), "30d": zero() };
    const byScope = new Map<string, UsageTotals>();
    const byDay = new Map<string, UsageTotals>();
    const recent: UsageCall[] = [];
    for (const row of rows) {
      const body = JSON.parse(String(row.body)) as Record<string, unknown>, at = Number(body.at) || Number(row.ts), day = dayOf(at);
      if (day < first) continue;
      if (day >= month) add(periods["30d"], body);
      if (day >= week) { add(periods["7d"], body); const scope = String(body.scope); add(byScope.get(scope) ?? byScope.set(scope, zero()).get(scope)!, body); }
      if (day === today) add(periods.today, body);
      if (day >= dayStart(span - 1)) add(byDay.get(day) ?? byDay.set(day, zero()).get(day)!, body);
      recent.push({ at, scope: String(body.scope), model: String(body.model), input_tokens: Number(body.input_tokens) || 0, output_tokens: Number(body.output_tokens) || 0,
        cache_read_tokens: Number(body.cache_read_tokens) || 0, cost_usd: typeof body.cost_usd === "number" ? body.cost_usd : null, ms: Number(body.ms) || 0 });
    }
    return { as_of: now, currency: "USD", estimated: true, periods,
      by_scope: [...byScope].map(([scope, totals]) => ({ scope, ...totals })).sort((a, b) => b.cost_usd - a.cost_usd || b.calls - a.calls),
      by_day: [...byDay].map(([date, totals]) => ({ date, ...totals })).sort((a, b) => a.date.localeCompare(b.date)), recent: recent.slice(-15).reverse() };
  }

  /** What the owner said to Ash, oldest first, independent of how much else the ledger holds. */
  ownerSays(q: { after?: number; afterTs?: number; limit?: number } = {}): Message[] {
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
    return (this.db.prepare(`SELECT * FROM messages WHERE "from"='person:owner' AND "to"='agent:main' AND kind='request' AND word='say'
      AND seq>? AND ts>? ORDER BY seq LIMIT ?`).all(q.after ?? 0, q.afterTs ?? -1, limit) as Row[]).map(decode);
  }

  list(q: { after?: number; before?: number; limit?: number } = {}): Message[] {
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
    const rows = q.before !== undefined
      ? this.db.prepare("SELECT * FROM messages WHERE seq<? ORDER BY seq DESC LIMIT ?").all(q.before, limit).reverse()
      : this.db.prepare("SELECT * FROM messages WHERE seq>? ORDER BY seq LIMIT ?").all(q.after ?? 0, limit);
    return (rows as Row[]).map(decode);
  }

  /** Preflight raw page byte cost before HTTP headers; one row at a time. */
  rawPage(q: StreamPageQuery = {}): Message[] {
    const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
    const descending = q.before !== undefined;
    const bound = descending ? q.before! : q.after ?? 0;
    const predicate = descending ? "seq<?" : "seq>?";
    const order = descending ? "DESC" : "ASC";
    let bodyBytes = 0;
    for (const row of this.db.prepare(`SELECT length(CAST(body AS BLOB)) + length(CAST(id AS BLOB)) +
      length(CAST("from" AS BLOB)) + coalesce(length(CAST("to" AS BLOB)),0) +
      length(CAST(kind AS BLOB)) + length(CAST(word AS BLOB)) +
      coalesce(length(CAST(reply_to AS BLOB)),0) + coalesce(length(CAST(origin AS BLOB)),0) +
      coalesce(length(CAST(turn AS BLOB)),0) AS n FROM messages WHERE ${predicate} ORDER BY seq ${order} LIMIT ?`)
      .iterate(bound, limit) as Iterable<Row>) {
      bodyBytes += Number(row.n);
      if (bodyBytes > STREAM_RAW_PAGE_BYTES) throw new RangeError("raw stream page exceeds 32 MiB");
    }
    const rows = this.db.prepare(descending
      ? "SELECT * FROM messages WHERE seq<? ORDER BY seq DESC LIMIT ?"
      : "SELECT * FROM messages WHERE seq>? ORDER BY seq LIMIT ?")
      .iterate(bound, limit) as Iterable<Row>;
    const page: Message[] = [];
    let bytes = 0;
    for (const row of rows) {
      const message = decode(row);
      bytes += Buffer.byteLength(JSON.stringify(message)) + 64;
      if (bytes > STREAM_RAW_PAGE_BYTES) throw new RangeError("raw stream page exceeds 32 MiB");
      page.push(message);
    }
    return descending ? page.reverse() : page;
  }

  rawPageWithEnd(q: StreamPageQuery = {}): { page: Message[]; end: StreamPageEndV2 } {
    const page = this.rawPage(q);
    if (!page.length) return { page, end: { has_more: false, first_seq: null, last_seq: null } };
    const first_seq = page[0].seq;
    const last_seq = page.at(-1)!.seq;
    const more = q.before !== undefined
      ? this.db.prepare("SELECT 1 FROM messages WHERE seq<? LIMIT 1").get(first_seq)
      : this.db.prepare("SELECT 1 FROM messages WHERE seq>? LIMIT 1").get(last_seq);
    return { page, end: { has_more: Boolean(more), first_seq, last_seq } };
  }

  /** Call inside postReadSnapshot when delivery states must share this page's watermark. */
  summaryPage(q: StreamPageQuery = {}): { page: MessageSummaryV2[]; end: StreamPageEndV2 } {
    return readSummaryPage(this.db, q);
  }

  /** Startup-only projection: never materialize unrelated message bodies or attachments. */
  agentTurnHistory(actor: string): { startedTurns: Set<string>; completedTurns: Set<string> } {
    const startedTurns = new Set<string>();
    const completedTurns = new Set<string>();
    const rows = this.db.prepare(`SELECT word, json_extract(body, '$.turn') AS turn_id,
      CASE WHEN word='turn.end' THEN json_extract(body, '$.reason') END AS reason
      FROM messages WHERE "from"=? AND kind='event' AND word IN ('turn.start', 'turn.end') AND seq > ? ORDER BY seq`)
      // Turns migrated from v1 stay visible history; they were never bound to a v2 DSH session.
      .iterate(actor, this.migration.lastLegacySeq) as Iterable<Row>;
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
