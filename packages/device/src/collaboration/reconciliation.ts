import { CollaborationControlError, type AuthenticatedPrincipal, type AuthorizeControl, type DeliveryFact, type ReconciliationProvenance } from "./control-types";
import type { WorkRef } from "./types";
import { OperationStore } from "./operation-store";

/** Body-free saved-history projection. No invoke, resume, or replay capability. */
export interface ReconciliationPage {
  work: WorkRef;
  native_interface_version: string;
  connector_epoch: string;
  source: "codex.saved_history";
  observed_at: string;
  items: { source_client_message_id?: string; native_turn_id: string; native_message_id: string }[];
  next_cursor: string | null;
}
export interface ReconciliationReader {
  readonly connector_epoch: string;
  readonly native_interface_version: string;
  readHistoryPage(input: { work: WorkRef; cursor?: string; limit: number }): Promise<ReconciliationPage>;
}
export interface ReconciliationOptions {
  store: OperationStore;
  reader: ReconciliationReader;
  node_id: string;
  endpoint_id: string;
  /** Supply a lease bound to the ORIGINAL admitted grant, not a fresh grant during lookup. */
  authorize: AuthorizeControl;
  now?: () => number;
  failpoint?: (stage: "before_reconcile_save" | "after_reconcile_save") => void;
}
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value);
const validCursor = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f]/.test(value);
const sameWork = (a: WorkRef, b: WorkRef) => a?.node_id === b.node_id && a.endpoint_id === b.endpoint_id && a.kind === b.kind && a.native_id === b.native_id;
/** Finite readonly lookup. Absence, ambiguity, source changes, and failures never mean rejection. */
export class DeliveryReconciler {
  constructor(private readonly options: ReconciliationOptions) {}
  private async authorized(principal: AuthenticatedPrincipal, work: WorkRef, fact: DeliveryFact | null): Promise<void> {
    try { if (await this.options.authorize(principal, work, fact?.action ?? "send_input", "query") === true) return; } catch { /* deny sanitized */ }
    throw new CollaborationControlError("permission_denied");
  }
  private stage(stage: "before_reconcile_save" | "after_reconcile_save"): void {
    try { this.options.failpoint?.(stage); } catch { throw new CollaborationControlError("storage_failure"); }
  }
  async reconcile(identity: AuthenticatedPrincipal, operationId: string, value: WorkRef): Promise<DeliveryFact | null> {
    if (!validId(identity?.principal_id) || !validId(operationId) || !validId(value?.node_id) || !validId(value?.endpoint_id) || !validId(value?.native_id) || value.kind !== "conversation") throw new CollaborationControlError("invalid");
    const principal = Object.freeze({ principal_id: identity.principal_id }), work = Object.freeze({ ...value });
    if (work.node_id !== this.options.node_id || work.endpoint_id !== this.options.endpoint_id) throw new CollaborationControlError("permission_denied");
    let fact = this.options.store.get(principal.principal_id, operationId);
    await this.authorized(principal, work, fact);
    this.options.store.recoverAbandoned();
    fact = this.options.store.get(principal.principal_id, operationId);
    if (fact && !sameWork(fact.work, work)) throw new CollaborationControlError("permission_denied");
    const reader = this.options.reader, epoch = reader.connector_epoch, version = reader.native_interface_version;
    let proof: ReconciliationProvenance | null = null;
    if (fact && ["unknown", "accepted"].includes(fact.delivery_status) && fact.receipt?.correlation !== "stable_message_id" && fact.attempt_id && fact.native_client_message_id && fact.native_interface_version === version && validId(epoch) && validId(version)) {
      try {
        let cursor: string | undefined;
        const seen = new Set<string>(), matches = new Map<string, ReconciliationProvenance>();
        let complete = false, pages = 0;
        for (let count = 0; count < 4; count++) {
          await this.authorized(principal, work, fact);
          if (reader.connector_epoch !== epoch || reader.native_interface_version !== version) throw new Error();
          const page = await reader.readHistoryPage({ work, cursor, limit: 25 });
          pages++;
          if (reader.connector_epoch !== epoch || reader.native_interface_version !== version || !sameWork(page.work, work) || page.native_interface_version !== version || page.connector_epoch !== epoch || page.source !== "codex.saved_history" || typeof page.observed_at !== "string" || !Number.isFinite(Date.parse(page.observed_at)) || !Array.isArray(page.items) || page.items.length > 25) throw new Error();
          for (const item of page.items) {
            if (item.source_client_message_id !== fact.native_client_message_id) continue;
            if (!validId(item.native_turn_id) || !validId(item.native_message_id)) throw new Error();
            matches.set(JSON.stringify([item.native_turn_id, item.native_message_id]), { source: page.source, lookup_scope: "bounded_history_pages", pages_observed: 0, history_exhausted: false, native_interface_version: version, connector_epoch: epoch, observed_at: page.observed_at, native_client_message_id: fact.native_client_message_id, native_turn_id: item.native_turn_id, native_message_id: item.native_message_id });
          }
          if (page.next_cursor === null) { complete = true; break; }
          if (!validCursor(page.next_cursor) || seen.has(page.next_cursor)) throw new Error();
          seen.add(page.next_cursor); cursor = page.next_cursor;
        }
        // Exactly one association in the observed window; provenance does not claim
        // that unobserved older history is globally free of another client ID.
        if (matches.size === 1) proof = { ...Array.from(matches.values())[0]!, pages_observed: pages, history_exhausted: complete };
      } catch { proof = null; } // No native source error text leaves this boundary.
    }
    await this.authorized(principal, work, fact);
    if (proof && (reader.connector_epoch !== epoch || reader.native_interface_version !== version)) proof = null;
    if (proof && fact) {
      this.stage("before_reconcile_save");
      fact = this.options.store.reconcile(fact, proof, (this.options.now ?? Date.now)());
      this.stage("after_reconcile_save");
    } else fact = this.options.store.get(principal.principal_id, operationId);
    await this.authorized(principal, work, fact);
    return fact;
  }
}
