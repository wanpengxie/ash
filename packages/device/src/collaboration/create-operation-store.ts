import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseCreateWorkRequest, toCreateFactDto } from "./create-protocol";
import { CollaborationCreateError, type CreateStore, type CreateWorkFact, type CreateWorkRequest, type CreateStage, type CreateStageFact, type CreateOutcome, type CreateReconciliationProvenance } from "./create-types";

const epoch = randomUUID();
const stages: CreateStage[] = ["create", "name", "first_input"];
type Ended = { fact: CreateWorkFact; stage: CreateStage; outcome: CreateOutcome | null; now: number };
const pendingByFile = new Map<string, Map<string, Ended>>();
const sameWork = (a: any, b: any) => a?.node_id === b?.node_id && a?.endpoint_id === b?.endpoint_id && a?.kind === b?.kind && a?.native_id === b?.native_id;
function dead(pid: number): boolean { try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; } }
function idle(now: number): CreateStageFact { return { status: "not_started", attempt_id: null, owner_epoch: null, connector_epoch: null, native_interface_version: null, started_at: null, observed_at: now, receipt: null, error_code: null }; }
/** Single-host FULL SQLite journal. Capacity never evicts deduplication keys or uncertain attempts. */
export class CreateOperationStore implements CreateStore {
  private db: DatabaseSync;
  private fileKey: string;
  private closed = false;
  private owned = new Set<string>();
  constructor(file: string, private maxRecords = 10_000) {
    if (file === ":memory:" || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_000_000) throw new CollaborationCreateError("invalid");
    const deadline = Date.now() + 2_000;
    for (;;) {
      let opened: DatabaseSync | undefined;
      try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        this.db = opened = new DatabaseSync(file); chmodSync(file, 0o600);
        this.db.exec("PRAGMA busy_timeout=1000");
        const version = Number((this.db.prepare("PRAGMA user_version").get() as any).user_version);
        if (version > 1) throw new Error();
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
        if (version === 0 && tables.length > 0 || tables.some(t => t.name !== "create_operations") || version === 1 && !tables.some(t => t.name === "create_operations")) throw new Error();
        this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
        this.db.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS create_operations (principal TEXT NOT NULL, operation_id TEXT NOT NULL, fact TEXT NOT NULL, create_pid INTEGER, name_pid INTEGER, first_input_pid INTEGER, PRIMARY KEY(principal,operation_id)); PRAGMA user_version=1; COMMIT");
        this.fileKey = realpathSync(file); this.recoverAbandoned(); break;
      } catch (e) {
        try { opened?.close(); } catch {}
        const code = (e as { errcode?: number })?.errcode;
        if (typeof code === "number" && [5, 6].includes(code & 255) && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); continue;
        }
        throw new CollaborationCreateError("storage_failure");
      }
    }
  }
  private protect<T>(fn: () => T): T { if (this.closed) throw new CollaborationCreateError("storage_failure"); try { return fn(); } catch (e) { if (e instanceof CollaborationCreateError) throw e; throw new CollaborationCreateError("storage_failure"); } }
  private tx<T>(fn: () => T): T { return this.protect(() => { this.db.exec("BEGIN IMMEDIATE"); try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }); }
  private save(f: CreateWorkFact): void { toCreateFactDto(f); this.db.prepare("UPDATE create_operations SET fact=? WHERE principal=? AND operation_id=?").run(JSON.stringify(f), f.principal_id, f.operation_id); }
  get(principal: string, operation: string): CreateWorkFact | null { return this.protect(() => { const row = this.db.prepare("SELECT fact FROM create_operations WHERE principal=? AND operation_id=?").get(principal, operation) as any; return row ? JSON.parse(row.fact) : null; }); }
  /** Body-free read-only drain facts; accepted input is not execution completion. */
  changeFacts(): { invoking: number; unknown: number; acceptedInput: number } {
    return this.protect(() => {
      const row = this.db.prepare(`SELECT
        coalesce(sum(CASE WHEN json_extract(fact,'$.create.status')='invoking' OR json_extract(fact,'$.name.status')='invoking' OR json_extract(fact,'$.first_input.status')='invoking' THEN 1 ELSE 0 END),0) AS invoking,
        coalesce(sum(CASE WHEN json_extract(fact,'$.create.status')='unknown' OR json_extract(fact,'$.name.status')='unknown' OR json_extract(fact,'$.first_input.status')='unknown' THEN 1 ELSE 0 END),0) AS unknown,
        coalesce(sum(CASE WHEN json_extract(fact,'$.first_input.status')='accepted' THEN 1 ELSE 0 END),0) AS acceptedInput
        FROM create_operations`).get() as any;
      return { invoking: Number(row.invoking), unknown: Number(row.unknown), acceptedInput: Number(row.acceptedInput) };
    });
  }
  record(principal: string, value: CreateWorkRequest, payloadHash: string, now: number): CreateWorkFact {
    const r = parseCreateWorkRequest(value);
    return this.tx(() => {
      const old = this.get(principal, r.operation_id);
      if (old) { if (old.payload_hash !== payloadHash) throw new CollaborationCreateError("conflict"); return old; }
      if (Number((this.db.prepare("SELECT count(*) AS n FROM create_operations").get() as any).n) >= this.maxRecords) throw new CollaborationCreateError("too_large");
      const f: CreateWorkFact = { version: 1, principal_id: principal, request_id: r.request_id, operation_id: r.operation_id, authorization_revision: r.authorization_revision, target: r.target, payload_hash: payloadHash, expires_at: r.expires_at, status: "recorded", create: idle(now), name: idle(now), first_input: idle(now), work: null, native_client_message_id: null, reconciliation: null, error_code: null, observed_at: now };
      toCreateFactDto(f);
      this.db.prepare("INSERT INTO create_operations(principal,operation_id,fact) VALUES(?,?,?)").run(principal, r.operation_id, JSON.stringify(f)); return f;
    });
  }
  claim(principal: string, operation: string, stage: CreateStage, connectorEpoch: string, now: number, nativeVersion: string): { fact: CreateWorkFact; claimed: boolean } {
    const result = this.tx(() => {
      if (!stages.includes(stage)) throw new CollaborationCreateError("invalid");
      const f = this.get(principal, operation); if (!f) throw new CollaborationCreateError("invalid");
      if (f[stage].status !== "not_started") return { fact: f, claimed: false };
      if (stage !== "create" && f[stage === "name" ? "create" : "name"].status !== "accepted") return { fact: f, claimed: false };
      if (now >= f.expires_at) throw new CollaborationCreateError("expired");
      f[stage] = { ...idle(now), status: "invoking", attempt_id: randomUUID(), owner_epoch: epoch, connector_epoch: connectorEpoch, native_interface_version: nativeVersion, started_at: now };
      if (stage === "first_input") f.native_client_message_id = randomUUID();
      f.observed_at = now; this.save(f);
      this.db.prepare(`UPDATE create_operations SET ${stage}_pid=? WHERE principal=? AND operation_id=?`).run(process.pid, principal, operation);
      return { fact: f, claimed: true };
    });
    if (result.claimed) this.owned.add(result.fact[stage].attempt_id!); return result;
  }
  finish(fact: CreateWorkFact, stage: CreateStage, outcome: CreateOutcome | null, now: number): CreateWorkFact {
    const attempt = fact[stage].attempt_id;
    if (!attempt || !this.owned.has(attempt)) throw new CollaborationCreateError("conflict");
    this.owned.delete(attempt);
    const ended = structuredClone({ fact, stage, outcome, now });
    const pending = pendingByFile.get(this.fileKey) ?? new Map(); pending.set(attempt, ended); pendingByFile.set(this.fileKey, pending);
    return this.commitEnded(ended);
  }
  private commitEnded(e: Ended): CreateWorkFact {
    const result = this.tx(() => {
      const f = this.get(e.fact.principal_id, e.fact.operation_id);
      const original = e.fact[e.stage];
      if (!f || f[e.stage].attempt_id !== original.attempt_id || f[e.stage].owner_epoch !== epoch) throw new CollaborationCreateError("conflict");
      if (f[e.stage].status !== "invoking") return f;
      const receipt = e.outcome?.status === "accepted" ? e.outcome.receipt : null;
      if (receipt && (receipt.stage !== e.stage || (e.stage !== "create" && !sameWork(receipt.work, f.work)))) throw new CollaborationCreateError("invalid");
      if (receipt && e.stage === "create") f.work = receipt.work;
      const code = e.outcome?.status === "rejected" ? e.outcome.code : e.outcome === null ? "result_unknown" : null;
      f[e.stage] = { ...f[e.stage], status: e.outcome?.status ?? "unknown", receipt, error_code: code, observed_at: e.now };
      f.error_code = code; f.observed_at = e.now; this.save(f); return f;
    });
    const pending = pendingByFile.get(this.fileKey); pending?.delete(e.fact[e.stage].attempt_id!); if (!pending?.size) pendingByFile.delete(this.fileKey); return result;
  }
  private flush(): void { for (const e of [...(pendingByFile.get(this.fileKey)?.values() ?? [])]) this.commitEnded(e); }
  recoverAbandoned(): void {
    this.flush(); this.tx(() => {
      for (const row of this.db.prepare("SELECT * FROM create_operations").all() as any[]) {
        const f: CreateWorkFact = JSON.parse(row.fact); let changed = false;
        for (const s of stages) if (f[s].status === "invoking" && dead(Number(row[`${s}_pid`]))) {
          f[s] = { ...f[s], status: "unknown", error_code: "result_unknown", observed_at: Date.now() }; f.error_code = "result_unknown"; f.observed_at = Date.now(); changed = true;
        }
        if (changed) this.save(f);
      }
    });
  }
  reconcile(fact: CreateWorkFact, proof: CreateReconciliationProvenance, now: number): CreateWorkFact {
    return this.tx(() => {
      const f = this.get(fact.principal_id, fact.operation_id);
      if (!f || !f.work || f.first_input.attempt_id !== fact.first_input.attempt_id || f.native_client_message_id !== proof.native_client_message_id || f.first_input.native_interface_version !== proof.native_interface_version || !sameWork(f.work, proof.work)) throw new CollaborationCreateError("conflict");
      const r = f.first_input.receipt;
      if (!["accepted", "unknown"].includes(f.first_input.status) || (r?.stage === "first_input" && (r.correlation === "stable_message_id" || r.native_turn_id !== proof.native_turn_id || (r.native_message_id && r.native_message_id !== proof.native_message_id)))) return f;
      f.first_input = { ...f.first_input, status: "accepted", receipt: { stage: "first_input", accepted_by: "native", work: f.work, native_turn_id: proof.native_turn_id, native_message_id: proof.native_message_id, correlation: "stable_message_id" }, error_code: null, observed_at: now };
      f.reconciliation = structuredClone(proof); f.error_code = null; f.observed_at = now; this.save(f); return f;
    });
  }
  close(): void {
    if (this.owned.size) throw new CollaborationCreateError("busy"); if (this.closed) return;
    let failed = false; try { this.flush(); } catch { failed = true; }
    this.protect(() => this.db.close()); this.closed = true; if (failed) throw new CollaborationCreateError("storage_failure");
  }
}
