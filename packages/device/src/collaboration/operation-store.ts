import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CollaborationControlError, type ControlErrorCode, type ControlRequest, type DeliveryFact, type NativeOutcome, type ReconciliationProvenance } from "./control-types";

type Row = Record<string, unknown>;
const processEpoch = randomUUID();
type EndedAttempt = { fact: DeliveryFact; outcome: NativeOutcome | null; now: number };
// Only attempts whose native call ENDED enter this process-local registry. It
// contains no body, and never licenses invocation. After a failed receipt commit,
// another store in this same process may persist the exact receipt using the
// original attempt + owner epoch guard. If this process dies, recovery is unknown.
const endedByFile = new Map<string, Map<string, EndedAttempt>>();
function ownerExited(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function startupBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown })?.errcode;
  return typeof code === "number" && ((code & 255) === 5 || (code & 255) === 6);
}
function decode(row: Row): DeliveryFact {
  return {
    principal_id: String(row.principal), request_id: String(row.request_id), operation_id: String(row.operation_id),
    work: { node_id: String(row.node_id), endpoint_id: String(row.endpoint_id), kind: "conversation", native_id: String(row.native_id) },
    action: row.action as DeliveryFact["action"], payload_hash: String(row.payload_hash), expires_at: Number(row.expires_at),
    delivery_status: row.status as DeliveryFact["delivery_status"], attempt_id: row.attempt_id as string | null,
    connector_epoch: row.connector_epoch as string | null,
    native_client_message_id: row.native_client_message_id as string | null,
    native_interface_version: row.native_interface_version as string | null,
    expected_turn_id: row.expected_turn_id as string | null,
    reconciliation: row.reconciliation === null ? null : JSON.parse(String(row.reconciliation)), receipt: row.receipt === null ? null : JSON.parse(String(row.receipt)),
    error_code: row.error_code as ControlErrorCode | null, observed_at: Number(row.updated_at),
  };
}

/**
 * Local, single-host journal. SQLite FULL commits precede native invocation.
 * Atomic claims permit multiple processes, without leases or automatic replay.
 * Only ESRCH proves an owner dead; live PID, PID reuse and EPERM retain invoking.
 * Do not share the DB across hosts/PID namespaces. No deletion/TTL cleanup is
 * offered: retained keys (including unknown) prevent repeat native execution.
 * At capacity intake stops; an operator must retain tombstones when archiving.
 * This is not Core's logical request ledger and stores no message body.
 */
export class OperationStore {
  private readonly db: DatabaseSync;
  private readonly fileKey: string;
  private readonly owned = new Set<string>();
  private closed = false;
  constructor(file: string, private readonly maxRecords = 10_000) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_000_000 || file === ":memory:") throw new CollaborationControlError("invalid");
    const deadline = Date.now() + 2_000;
    // WAL mode changes can return SQLITE_BUSY immediately despite busy_timeout.
    // Retry only initialization, with each failed connection closed first. There
    // is no operation/native retry here, and FULL is set on every new connection.
    for (;;) {
      let opened: DatabaseSync | undefined;
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        this.db = opened = new DatabaseSync(file);
        chmodSync(file, 0o600);
        this.db.exec("PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
        this.db.exec(`CREATE TABLE IF NOT EXISTS operations (
          principal TEXT NOT NULL, operation_id TEXT NOT NULL, request_id TEXT NOT NULL,
          node_id TEXT NOT NULL, endpoint_id TEXT NOT NULL, native_id TEXT NOT NULL,
          action TEXT NOT NULL, payload_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('recorded','invoking','accepted','rejected','unknown')),
          attempt_id TEXT, connector_epoch TEXT, owner_pid INTEGER, owner_epoch TEXT,
          receipt TEXT, error_code TEXT, updated_at INTEGER NOT NULL,
          PRIMARY KEY(principal,operation_id)
        )`);
        const schemaVersion = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version);
        if (schemaVersion > 2) throw new CollaborationControlError("storage_failure");
        // Real legacy DB migration is transactional; never invent IDs for old attempts.
        this.db.exec("BEGIN IMMEDIATE");
        try {
          const columns = new Set((this.db.prepare("PRAGMA table_info(operations)").all() as Row[]).map(row => String(row.name)));
          for (const column of ["native_client_message_id", "native_interface_version", "expected_turn_id", "reconciliation"])
            if (!columns.has(column)) this.db.exec(`ALTER TABLE operations ADD COLUMN ${column} TEXT`);
          this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS native_client_message_unique ON operations(native_client_message_id) WHERE native_client_message_id IS NOT NULL");
          this.db.exec("PRAGMA user_version=2; COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
        break;
      } catch (error) {
        try { opened?.close(); } catch { /* Preserve a fixed, sanitized failure. */ }
        if (startupBusy(error) && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          continue;
        }
        throw new CollaborationControlError("storage_failure");
      }
    }
    try { this.fileKey = realpathSync(file); this.recoverAbandoned(); }
    catch { try { this.db.close(); } catch { /* Preserve sanitized failure. */ } throw new CollaborationControlError("storage_failure"); }
  }
  private protect<T>(fn: () => T): T {
    if (this.closed) throw new CollaborationControlError("storage_failure");
    try { return fn(); } catch (error) {
      if (error instanceof CollaborationControlError) throw error;
      throw new CollaborationControlError("storage_failure");
    }
  }
  private transaction<T>(fn: () => T): T {
    return this.protect(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try { const value = fn(); this.db.exec("COMMIT"); return value; }
      catch (error) { this.db.exec("ROLLBACK"); throw error; }
    });
  }
  /** Safe while another instance invokes. Never recovers merely because an epoch changed. */
  recoverAbandoned(): void {
    this.flushEnded();
    this.transaction(() => {
      const rows = this.db.prepare("SELECT principal,operation_id,owner_pid FROM operations WHERE status='invoking'").all() as Row[];
      for (const row of rows) if (ownerExited(Number(row.owner_pid))) {
        this.db.prepare("UPDATE operations SET status='unknown',error_code='result_unknown',updated_at=? WHERE principal=? AND operation_id=? AND status='invoking'")
          .run(Date.now(), String(row.principal), String(row.operation_id));
      }
    });
  }
  /** Internal trusted API; use DeliveryJournal for authorization and validated envelopes. */
  get(principal: string, operation: string): DeliveryFact | null {
    return this.protect(() => {
      const row = this.db.prepare("SELECT * FROM operations WHERE principal=? AND operation_id=?").get(principal, operation) as Row | undefined;
      return row ? decode(row) : null;
    });
  }
  /** Body-free drain facts only; does not recover, claim, retry or reinterpret a native outcome. */
  unsettled(): {invoking:number;unknown:number} {
    return this.protect(() => { const rows=this.db.prepare("SELECT status,count(*) AS n FROM operations WHERE status IN ('invoking','unknown') GROUP BY status").all() as Row[];return {invoking:Number(rows.find(r=>r.status==='invoking')?.n??0),unknown:Number(rows.find(r=>r.status==='unknown')?.n??0)}; });
  }
  /** Bootstrap gate only: a native acknowledgement does not prove a turn ended. */
  hasNativeInvocation(): boolean {
    return this.protect(() => !!this.db.prepare("SELECT 1 FROM operations WHERE attempt_id IS NOT NULL OR status IN ('invoking','unknown','accepted') LIMIT 1").get());
  }
  record(principal: string, request: ControlRequest, hash: string, now: number): DeliveryFact {
    return this.transaction(() => {
      const existing = this.get(principal, request.operation_id);
      if (existing) {
        if (existing.payload_hash !== hash) throw new CollaborationControlError("conflict");
        // A legacy recorded row has never invoked. Its exact envelope hash licenses
        // filling the original precondition, not fabrication for invoked rows.
        if (existing.delivery_status === "recorded" && existing.expected_turn_id === null && request.expected_turn_id)
          this.db.prepare("UPDATE operations SET expected_turn_id=? WHERE principal=? AND operation_id=? AND status='recorded'").run(request.expected_turn_id, principal, request.operation_id);
        return this.get(principal, request.operation_id)!;
      }
      const count = this.db.prepare("SELECT count(*) AS n FROM operations").get() as Row;
      if (Number(count.n) >= this.maxRecords) throw new CollaborationControlError("too_large");
      this.db.prepare(`INSERT INTO operations (principal,operation_id,request_id,node_id,endpoint_id,native_id,action,payload_hash,expires_at,status,updated_at,expected_turn_id)
        VALUES (?,?,?,?,?,?,?,?,?,'recorded',?,?)`).run(principal, request.operation_id, request.request_id, request.work.node_id, request.work.endpoint_id, request.work.native_id, request.action, hash, request.expires_at, now, request.expected_turn_id ?? null);
      return this.get(principal, request.operation_id)!;
    });
  }
  rejectRecorded(principal: string, operation: string, code: "expired" | "permission_denied", now: number): DeliveryFact {
    return this.transaction(() => {
      this.db.prepare("UPDATE operations SET status='rejected',error_code=?,updated_at=? WHERE principal=? AND operation_id=? AND status='recorded'").run(code, now, principal, operation);
      return this.get(principal, operation)!;
    });
  }
  /** A successful FULL transaction is the calling intent. Only its claimant may invoke. */
  claim(principal: string, operation: string, epoch: string, now: number, nativeVersion: string): { fact: DeliveryFact; claimed: boolean } {
    const result = this.transaction(() => {
      const fact = this.get(principal, operation)!;
      if (fact.delivery_status !== "recorded") return { fact, claimed: false };
      if (now >= fact.expires_at) return { fact: this.rejectInTransaction(principal, operation, now), claimed: false };
      const attempt = randomUUID(), client = fact.native_client_message_id ?? randomUUID();
      this.db.prepare("UPDATE operations SET status='invoking',attempt_id=?,connector_epoch=?,owner_pid=?,owner_epoch=?,updated_at=?,native_client_message_id=?,native_interface_version=? WHERE principal=? AND operation_id=? AND status='recorded'")
        .run(attempt, epoch, process.pid, processEpoch, now, client, nativeVersion, principal, operation);
      return { fact: this.get(principal, operation)!, claimed: true };
    });
    if (result.claimed) this.owned.add(result.fact.attempt_id!);
    return result;
  }
  private rejectInTransaction(principal: string, operation: string, now: number): DeliveryFact {
    this.db.prepare("UPDATE operations SET status='rejected',error_code='expired',updated_at=? WHERE principal=? AND operation_id=? AND status='recorded'").run(now, principal, operation);
    return this.get(principal, operation)!;
  }
  finish(fact: DeliveryFact, outcome: NativeOutcome | null, now: number): DeliveryFact {
    if (!fact.attempt_id || !this.owned.has(fact.attempt_id)) throw new CollaborationControlError("conflict");
    // The native call has ended even when SQLite cannot commit its receipt yet.
    // Release active ownership; keep a bounded, body-free completion for saving.
    this.owned.delete(fact.attempt_id);
    const ended = { fact, outcome, now };
    const pending = endedByFile.get(this.fileKey) ?? new Map();
    pending.set(fact.attempt_id, ended);
    endedByFile.set(this.fileKey, pending);
    return this.commitEnded(ended);
  }
  private commitEnded({ fact, outcome, now }: EndedAttempt): DeliveryFact {
    const result = this.transaction(() => {
      const status = outcome?.status ?? "unknown";
      const receipt = outcome?.status === "accepted" ? JSON.stringify(outcome.receipt) : null;
      const code = outcome?.status === "rejected" ? outcome.code : outcome === null ? "result_unknown" : null;
      const changed = this.db.prepare("UPDATE operations SET status=?,receipt=?,error_code=?,updated_at=? WHERE principal=? AND operation_id=? AND status='invoking' AND attempt_id=? AND owner_epoch=?")
        .run(status, receipt, code, now, fact.principal_id, fact.operation_id, fact.attempt_id!, processEpoch);
      const current = this.get(fact.principal_id, fact.operation_id)!;
      if (Number(changed.changes) !== 1 && (!current || current.attempt_id !== fact.attempt_id || current.delivery_status === "invoking" || current.delivery_status === "recorded")) throw new CollaborationControlError("conflict");
      return current;
    });
    const pending = endedByFile.get(this.fileKey);
    pending?.delete(fact.attempt_id!);
    if (pending?.size === 0) endedByFile.delete(this.fileKey);
    return result;
  }
  private flushEnded(): void {
    for (const ended of Array.from(endedByFile.get(this.fileKey)?.values() ?? [])) this.commitEnded(ended);
  }
  /** CAS only: saved history can establish acceptance or enrich a receipt, never overwrite rejection. */
  reconcile(fact: DeliveryFact, proof: ReconciliationProvenance, now: number): DeliveryFact {
    return this.transaction(() => {
      const current = this.get(fact.principal_id, fact.operation_id);
      if (!current || current.attempt_id !== fact.attempt_id || current.native_client_message_id !== proof.native_client_message_id || current.native_interface_version !== proof.native_interface_version) throw new CollaborationControlError("conflict");
      if (current.delivery_status !== "unknown" && current.delivery_status !== "accepted") return current;
      if ((current.expected_turn_id && current.expected_turn_id !== proof.native_turn_id) ||
          (current.receipt?.native_turn_id && current.receipt.native_turn_id !== proof.native_turn_id) ||
          (current.receipt?.native_message_id && current.receipt.native_message_id !== proof.native_message_id)) return current;
      if (current.receipt?.correlation === "stable_message_id") return current;
      const receipt = { accepted_by: "native", correlation: "stable_message_id", native_turn_id: proof.native_turn_id, native_message_id: proof.native_message_id };
      this.db.prepare("UPDATE operations SET status='accepted',receipt=?,reconciliation=?,error_code=NULL,updated_at=? WHERE principal=? AND operation_id=? AND attempt_id=? AND status IN ('unknown','accepted')")
        .run(JSON.stringify(receipt), JSON.stringify(proof), now, fact.principal_id, fact.operation_id, fact.attempt_id!);
      return this.get(fact.principal_id, fact.operation_id)!;
    });
  }
  close(): void {
    if (this.owned.size) throw new CollaborationControlError("busy");
    if (this.closed) return;
    let completionFailed = false;
    try { this.flushEnded(); } catch { completionFailed = true; }
    // A failed save must not leak the connection or leave an ended attempt busy.
    // The registry permits saving on later same-process reopen; durable invoking
    // remains conservative until then (or becomes unknown when this PID exits).
    this.protect(() => this.db.close()); this.closed = true;
    if (completionFailed) throw new CollaborationControlError("storage_failure");
  }
}
