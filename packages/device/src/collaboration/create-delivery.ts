import { createPayloadHash, parseCreateWorkRequest, createId, toCreateFactDto, createLeaseReadContext, assertCreateSourceScope } from "./create-protocol";
import { CollaborationCreateError, type CreateAdapter, type CreateLease, type CreateStore, type CreateStage, type CreateWorkRequest, type CreateWorkFact, type CreateOutcome, type CreateReconciliationProvenance, type CreateReadContext } from "./create-types";
import type { WorkRef } from "./types";

const sameWork = (a: WorkRef, b: WorkRef) => a.node_id === b.node_id && a.endpoint_id === b.endpoint_id && a.kind === b.kind && a.native_id === b.native_id;
const sameTarget = (a: CreateLease["target"], b: CreateLease["target"]) => a.node_id === b.node_id && a.endpoint_id === b.endpoint_id && a.project_id === b.project_id && a.cwd === b.cwd;
export type CreateDeliveryWindow = "before_record" | "after_record" | "before_claim" | "after_claim" | "after_native" | "after_saved";
export interface CreateDeliveryOptions { store: CreateStore; adapter: CreateAdapter; now?: () => number; failpoint?: (window: CreateDeliveryWindow, stage: CreateStage) => void }
/** Only explicit apply advances idle phases. Unknown/invoking/rejected phases never replay. */
export class CreateDeliveryJournal {
  private now: () => number;
  private closing = false;
  private active = 0;
  private pins = new WeakMap<CreateLease, { scope: CreateReadContext["authorized_scope"]; target: CreateLease["target"]; revision: string; principal: string; epoch: string; version: string }>();
  private pinned(lease: CreateLease): void {
    let pin = this.pins.get(lease);
    if (!pin) {
      const context = createLeaseReadContext(lease, this.now() + 30_000, "query");
      pin = { scope: context.authorized_scope, target: Object.freeze({ ...lease.target }), revision: lease.authorization_revision, principal: lease.principal.principal_id, epoch: lease.connector_epoch, version: lease.native_interface_version };
      this.pins.set(lease, pin);
    }
    assertCreateSourceScope(pin.scope, lease.authorized_scope);
    assertCreateSourceScope(pin.scope, lease.target);
    if (!sameTarget(pin.target, lease.target) || pin.revision !== lease.authorization_revision || pin.principal !== lease.principal.principal_id || pin.epoch !== lease.connector_epoch || pin.version !== lease.native_interface_version) throw new CollaborationCreateError("permission_denied");
  }
  constructor(private options: CreateDeliveryOptions) { this.now = options.now ?? Date.now; }
  private async auth(lease: CreateLease, purpose: "invoke" | "query"): Promise<void> {
    try { this.pinned(lease); const allowed = await lease.authorize(purpose); this.pinned(lease); if (allowed === true) return; } catch {} throw new CollaborationCreateError("permission_denied");
  }
  private binding(lease: CreateLease, f: { target: CreateLease["target"]; authorization_revision: string }): void {
    if (!sameTarget(lease.target, f.target) || lease.authorization_revision !== f.authorization_revision) throw new CollaborationCreateError("permission_denied");
  }
  private epoch(lease: CreateLease): void { if (this.options.adapter.connector_epoch !== lease.connector_epoch || this.options.adapter.native_interface_version !== lease.native_interface_version) throw new CollaborationCreateError("stale_precondition"); }
  private window(w: CreateDeliveryWindow, s: CreateStage): void { try { this.options.failpoint?.(w, s); } catch { throw new CollaborationCreateError("storage_failure"); } }
  private context(lease: CreateLease, deadline: number, purpose: "invoke" | "query"): CreateReadContext {
    this.pinned(lease);
    const trusted = createLeaseReadContext(lease, deadline, purpose);
    return Object.freeze({ ...trusted, authorize: async () => {
      this.pinned(lease);
      const allowed = await trusted.authorize();
      this.pinned(lease); this.epoch(lease);
      if (!allowed) throw new CollaborationCreateError("permission_denied");
      if (this.now() >= deadline) throw new CollaborationCreateError("offline"); return true;
    } });
  }
  private async response<T>(lease: CreateLease, fn: () => Promise<T>): Promise<T> {
    this.active++;
    try { const result = await fn(); await this.auth(lease, "query"); return result; }
    catch (e) { await this.auth(lease, "query"); if (e instanceof CollaborationCreateError) throw e; throw new CollaborationCreateError("result_unknown"); }
    finally { this.active--; }
  }
  async apply(lease: CreateLease, value: CreateWorkRequest): Promise<CreateWorkFact> {
    return this.response(lease, async () => {
      if (this.closing) throw new CollaborationCreateError("busy");
      const parsed = parseCreateWorkRequest(value); const request = Object.freeze({ ...parsed, target: Object.freeze(parsed.target), input: Object.freeze(parsed.input) }); this.binding(lease, request); createId(lease.principal.principal_id);
      await this.auth(lease, "query"); this.options.store.recoverAbandoned();
      const hash = createPayloadHash(request), old = this.options.store.get(lease.principal.principal_id, request.operation_id);
      if (old && old.payload_hash !== hash) throw new CollaborationCreateError("conflict");
      if (!old && this.now() >= request.expires_at) throw new CollaborationCreateError("expired");
      if (!old) await this.auth(lease, "invoke");
      this.window("before_record", "create");
      let fact = this.options.store.record(lease.principal.principal_id, request, hash, this.now()); this.window("after_record", "create");
      const deadline = this.now() + 30_000;
      this.active++;
      try {
        for (const stage of ["create", "name", "first_input"] as const) {
          if (fact[stage].status === "accepted") continue;
          if (fact[stage].status !== "not_started") break;
          await this.auth(lease, "invoke"); this.epoch(lease);
          if (this.now() >= request.expires_at) throw new CollaborationCreateError("expired");
          if (this.now() >= deadline) throw new CollaborationCreateError("offline");
          const context = this.context(lease, deadline, "invoke");
          if (stage === "create") {
            const resolved = await lease.run("invoke", () => this.options.adapter.resolveProject(request.target, context));
            await this.auth(lease, "invoke"); this.epoch(lease);
            if (!sameTarget(resolved, request.target)) throw new CollaborationCreateError("stale_precondition");
          } else {
            const metadata = await lease.run("invoke", () => this.options.adapter.metadata(fact.work!, context));
            await this.auth(lease, "invoke"); this.epoch(lease);
            if (!sameWork(metadata.work, fact.work!) || metadata.cwd !== context.authorized_scope.cwd) throw new CollaborationCreateError("stale_precondition");
          }
          if (this.now() >= request.expires_at) throw new CollaborationCreateError("expired");
          this.window("before_claim", stage);
          const claim = this.options.store.claim(lease.principal.principal_id, request.operation_id, stage, lease.connector_epoch, this.now(), lease.native_interface_version);
          fact = claim.fact; if (!claim.claimed) break;
          let outcome: CreateOutcome | null = null;
          try {
            this.window("after_claim", stage); await this.auth(lease, "invoke"); this.epoch(lease);
            // Expiry after durable intent cannot license a later replay.
            if (this.now() >= request.expires_at || this.now() >= deadline) throw new CollaborationCreateError("expired");
            const invocation = { ...context, principal: lease.principal, request, attempt_id: fact[stage].attempt_id!, connector_epoch: lease.connector_epoch, native_interface_version: lease.native_interface_version };
            const result = await lease.run("invoke", () => stage === "create" ? this.options.adapter.createThread(invocation) : stage === "name" ? this.options.adapter.nameThread({ ...invocation, work: fact.work! }) : this.options.adapter.startFirstInput({ ...invocation, work: fact.work!, native_client_message_id: fact.native_client_message_id! }));
            // Validate the adapter's complete result before recording acceptance.
            const candidate = structuredClone(fact);
            candidate[stage] = { ...candidate[stage], status: result.status, receipt: result.status === "accepted" ? result.receipt : null, error_code: result.status === "rejected" ? result.code : null };
            if (stage === "create" && result.status === "accepted") candidate.work = result.receipt.work;
            toCreateFactDto(candidate); outcome = result;
            this.window("after_native", stage);
          } catch { outcome = null; }
          fact = this.options.store.finish(fact, stage, outcome, this.now()); this.window("after_saved", stage);
          await this.auth(lease, "invoke"); this.epoch(lease);
          if (fact[stage].status !== "accepted") break;
        }
        return fact;
      } finally { this.active--; }
    });
  }
  async query(lease: CreateLease, operationId: string): Promise<CreateWorkFact | null> {
    return this.response(lease, async () => {
      createId(operationId); await this.auth(lease, "query"); this.options.store.recoverAbandoned();
      const f = this.options.store.get(lease.principal.principal_id, operationId); if (f) this.binding(lease, f); return f;
    });
  }
  async reconcile(lease: CreateLease, operationId: string): Promise<CreateWorkFact | null> {
    return this.response(lease, async () => {
      let fact = await this.query(lease, operationId); const adapter = this.options.adapter;
      if (!fact?.work || !fact.native_client_message_id || !["unknown", "accepted"].includes(fact.first_input.status) || fact.first_input.receipt?.stage === "first_input" && fact.first_input.receipt.correlation === "stable_message_id" || fact.first_input.native_interface_version !== lease.native_interface_version) return fact;
      const work = fact.work, client = fact.native_client_message_id;
      const matches = new Map<string, CreateReconciliationProvenance>();
      let cursor: string | undefined, pages = 0, exhausted = false, bytes = 0;
      const cursors = new Set<string>(), context = this.context(lease, this.now() + 30_000, "query");
      try {
        this.epoch(lease);
        const metadata = await lease.run("query", () => adapter.metadata(work, context));
        if (!sameWork(metadata.work, work) || metadata.cwd !== context.authorized_scope.cwd) throw new CollaborationCreateError("permission_denied");
        for (; pages < 4;) {
          await this.auth(lease, "query"); this.epoch(lease);
          const before = await lease.run("query", () => adapter.metadata(work, context));
          await this.auth(lease, "query"); this.epoch(lease);
          if (!sameWork(before.work, work) || before.cwd !== context.authorized_scope.cwd) throw new CollaborationCreateError("permission_denied");
          const page = await lease.run("query", () => adapter.history(work, { ...context, cursor, limit: 25 })); pages++;
          const after = await lease.run("query", () => adapter.metadata(work, context));
          await this.auth(lease, "query"); this.epoch(lease);
          if (!sameWork(after.work, work) || after.cwd !== context.authorized_scope.cwd) throw new CollaborationCreateError("permission_denied");
          await this.auth(lease, "query"); this.epoch(lease);
          bytes += Buffer.byteLength(JSON.stringify(page));
          if (this.now() >= context.deadline || bytes > 1024 * 1024) throw new Error();
          if (page.source !== "codex.saved_history" || page.completeness !== "source_page" || !Number.isFinite(Date.parse(page.observed_at)) || page.items.length > 25 || Buffer.byteLength(JSON.stringify(page)) > 1024 * 1024) throw new Error();
          for (const turn of page.items) {
            if (turn.status_source !== "codex.saved_history" || !Array.isArray(turn.messages) || turn.messages.length > 1024) throw new Error();
            for (const message of turn.messages) {
              if (!sameWork(message.work, work)) throw new CollaborationCreateError("permission_denied");
              if (message.source_client_message_id !== client) continue;
              if (!sameWork(message.work, work) || message.role !== "user" || message.turn_id !== turn.turn_id) throw new Error();
              createId(turn.turn_id); createId(message.source_message_id);
              matches.set(JSON.stringify([turn.turn_id, message.source_message_id]), { source: "codex.saved_history", lookup_scope: "bounded_history_pages", work, pages_observed: 0, history_exhausted: false, connector_epoch: lease.connector_epoch, native_interface_version: lease.native_interface_version, observed_at: page.observed_at, native_client_message_id: client, native_turn_id: turn.turn_id, native_message_id: message.source_message_id });
            }
          }
          if (page.next_cursor === null) { exhausted = true; break; }
          if (typeof page.next_cursor !== "string" || !page.next_cursor.length || page.next_cursor.length > 1024 || /[\u0000-\u001f]/.test(page.next_cursor) || cursors.has(page.next_cursor)) throw new Error();
          cursors.add(page.next_cursor); cursor = page.next_cursor;
        }
      } catch (e) { if (e instanceof CollaborationCreateError && e.code === "permission_denied") throw e; matches.clear(); }
      await this.auth(lease, "query"); this.epoch(lease);
      if (matches.size === 1) fact = this.options.store.reconcile(fact, { ...[...matches.values()][0]!, pages_observed: pages, history_exhausted: exhausted }, this.now());
      return fact;
    });
  }
  close(): void { this.closing = true; if (this.active) throw new CollaborationCreateError("busy"); this.options.store.close(); }
}
