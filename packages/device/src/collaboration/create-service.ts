import type { TrustedCallContext } from "./authorization";
import { CreateAuthorization, type CreateAdmission } from "./create-authorization";
import { CreateDeliveryJournal } from "./create-delivery";
import { createLeaseReadContext, createPayloadHash, parseCreateEnvelope, sameCreateTarget, toCreateFactDto, validateCreateResponse, type CreateEnvelope, type CreateOperation, type CreateResponse } from "./create-protocol";
import { CollaborationCreateError, type CreateAdapter, type CreateLease, type CreateReadContext, type CreateStore, type CreateWorkFact, type CreateManifestDto } from "./create-types";
export type ScopedCreateNative = CreateAdapter & { connect?(): Promise<void>; close(): void };
export interface DeviceCreateServiceOptions {
  node_id: string; endpoint_id: string; store: CreateStore; authorization: CreateAuthorization;
  /** A separate connection to the selected daemon; close only closes this connection. */
  native(): ScopedCreateNative;
  now?: () => number; deadlineMs?: number; closeStore?: boolean;
}
export type { CreateManifestDto } from "./create-types";
interface Source { native: ScopedCreateNative; connecting: Promise<void> | null; retired: boolean }
const error = (code: "offline" | "busy" | "permission_denied" | "stale_precondition" | "result_unknown") => new CollaborationCreateError(code);
/** One source per service, request-local authorization closures, durable journal owns every write. */
export class DeviceCreateService {
  private source?: Source;
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private storeClosed = false;
  constructor(private readonly options: DeviceCreateServiceOptions) {
    if (options.deadlineMs !== undefined && (!Number.isInteger(options.deadlineMs) || options.deadlineMs < 1 || options.deadlineMs > 30_000)) throw new CollaborationCreateError("invalid");
  }
  get busy(): boolean { return this.pending.size > 0; }
  manifest(context?: TrustedCallContext): CreateManifestDto {
    const grant = this.options.authorization.status();
    const scope = !this.closed ? this.options.authorization.manifestScope(context) : null;
    return { version: 1, endpoint_id: this.options.endpoint_id, grant_state: scope ? "ready" : grant.state === "invalid_configuration" ? "invalid_configuration" : "grant_required", authorization_revision: scope ? grant.authorization_revision : null,
      actions: scope ? ["projects", "apply", "query", "reconcile"] : [], scope,
      limitations: { native_readiness: "unknown", cancel: false, automatic_replay: false, execution_completion: "unknown" } };
  }
  invalidate(): void {
    this.options.authorization.invalidate();
    if (this.source) { this.source.retired = true; this.source.native.close(); this.source = undefined; }
  }
  private async connected(admission: CreateAdmission): Promise<Source> {
    return admission.run(async () => {
      if (this.closed) throw error("offline");
      let source = this.source;
      if (!source) { source = { native: this.options.native(), connecting: null, retired: false }; this.source = source; }
      if (!await admission.check()) throw error("permission_denied");
      const current = source;
      if (current.native.connector_epoch === "disconnected" && !current.connecting) {
        current.connecting = Promise.resolve().then(() => current.native.connect?.()).then(() => {
          if (current.retired || this.closed || current.native.connector_epoch === "disconnected") throw error("offline");
        });
      }
      if (current.connecting) {
        try { await current.connecting; }
        catch (e) { current.retired = true; current.native.close(); if (this.source === current) this.source = undefined; throw e; }
        finally { current.connecting = null; }
      }
      if (current.retired || this.closed) throw error("offline"); return current;
    });
  }
  async execute(operation: CreateOperation, body: unknown, context?: TrustedCallContext): Promise<CreateResponse> {
    if (this.closed) throw error("offline");
    // Parsing synchronously clones all nested request fields before the first await.
    const input = parseCreateEnvelope(operation, body) as CreateEnvelope;
    const binding = "request" in input ? input.request : input;
    const scope = "target" in binding ? binding.target : binding;
    const admission = this.options.authorization.begin(context && { transportOwnerId: context.transportOwnerId, isCurrent: () => !this.closed && context.isCurrent() }, scope, binding.authorization_revision);
    const deadline = Date.now() + Math.min(30_000, Math.max(1, this.options.deadlineMs ?? 30_000));
    let finalLease: CreateLease | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    const execution = admission.run(() => this.executeBound(operation, input, admission, deadline, lease => { finalLease = lease; }));
    this.pending.add(execution);
    execution.then(() => this.pending.delete(execution), () => this.pending.delete(execution));
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(error(operation === "apply" ? "result_unknown" : "offline")), Math.max(1, deadline - Date.now())); });
    try { return await Promise.race([execution, timeout]); }
    catch (e) {
      // Deadline is not native cancellation. Authorization still governs every error response.
      if (!await admission.check()) throw error("permission_denied");
      if (operation === "apply" && Date.now() >= deadline) throw error("result_unknown");
      if (finalLease) await finalLease.run("query", async () => undefined);
      if (e instanceof CollaborationCreateError) throw e; throw error("offline");
    } finally { if (timer) clearTimeout(timer); }
  }
  private adapter(native: ScopedCreateNative, deadline: number): CreateAdapter {
    const context = <T extends CreateReadContext>(c: T): T => ({ ...c, deadline: Math.min(c.deadline, deadline), authorize: async () => {
      if (!await c.authorize()) return false;
      if (Date.now() >= deadline) throw error("offline"); return true;
    } });
    // Recheck same-instance native cwd after each phase, including naming and first input.
    const outcome = async (invoke: () => ReturnType<CreateAdapter["createThread"]>, c: CreateReadContext) => {
      const result = await invoke();
      if (result.status === "accepted") await native.metadata(result.receipt.work, context(c));
      return result;
    };
    return {
      get connector_epoch() { return native.connector_epoch; }, get native_interface_version() { return native.native_interface_version; },
      projects: (s,c) => native.projects(s,context(c)), resolveProject: (t,c) => native.resolveProject(t,context(c)),
      metadata: (w,c) => native.metadata(w,context(c)), history: (w,c) => native.history(w,context(c)),
      createThread: i => outcome(() => native.createThread(context(i)),i), nameThread: i => outcome(() => native.nameThread(context(i)),i), startFirstInput: i => outcome(() => native.startFirstInput(context(i)),i),
    };
  }
  private async executeBound(operation: CreateOperation, input: CreateEnvelope, admission: CreateAdmission, deadline: number, capture: (lease: CreateLease) => void): Promise<CreateResponse> {
    let saved: CreateWorkFact | null = null;
    if ((operation === "query" || operation === "reconcile") && "operation_id" in input) {
      this.options.store.recoverAbandoned(); saved = this.options.store.get(admission.principal.principal_id, input.operation_id);
      if (saved && (!sameCreateTarget(saved.target, input.target) || saved.authorization_revision !== input.authorization_revision)) throw error("permission_denied");
      // Query reports saved receipts only; it requires no live native source or synthetic epoch.
      if (operation === "query" || !saved) return validateCreateResponse(operation, { fact: saved ? toCreateFactDto(saved) : null }, input);
    }
    if (operation === "apply" && "request" in input) {
      const old = this.options.store.get(admission.principal.principal_id, input.request.operation_id);
      if (old && old.payload_hash !== createPayloadHash(input.request)) throw new CollaborationCreateError("conflict");
      if (old && ([old.create, old.name, old.first_input].some(s => ["invoking", "unknown", "rejected"].includes(s.status)) || old.first_input.status === "accepted")) {
        // No continuing phase exists: do not reconnect, resolve projects, or replay an unknown attempt.
        return validateCreateResponse(operation, { fact: toCreateFactDto(old) }, input);
      }
      if ((this.options.now ?? Date.now)() >= input.request.expires_at) throw new CollaborationCreateError("expired");
    }
    const source = await this.connected(admission), native = source.native;
    const discovery = admission.projects(native), adapter = this.adapter(native, deadline);
    if (operation === "projects" && "cwd" in input) return discovery.run(async () => validateCreateResponse(operation, {
      target: discovery.scope, authorization_revision: discovery.authorization_revision, connector_epoch: discovery.connector_epoch, native_interface_version: discovery.native_interface_version,
      projects: await adapter.projects(discovery.scope, createLeaseReadContext(discovery, deadline, "query")), complete: true,
    }, input));
    if (!("request" in input) && !("target" in input)) throw error("stale_precondition");
    const target = "request" in input ? input.request.target : input.target;
    if (operation === "apply" && "request" in input) {
      if (native.connector_epoch !== input.expected_connector_epoch) throw error("stale_precondition");
      // Select a real native project while the cwd-only discovery lease is still current.
      const resolved = await discovery.run(() => adapter.resolveProject(target, createLeaseReadContext(discovery, deadline, "invoke")));
      if (!sameCreateTarget(resolved, target)) throw error("stale_precondition");
    }
    const lease = admission.target(target, native); capture(lease);
    const journal = new CreateDeliveryJournal({ store: this.options.store, adapter, now: this.options.now });
    return lease.run(operation === "apply" ? "invoke" : "query", async () => {
      const fact = operation === "apply" && "request" in input ? await journal.apply(lease, input.request) : operation === "reconcile" && "operation_id" in input ? await journal.reconcile(lease, input.operation_id) : "operation_id" in input ? await journal.query(lease, input.operation_id) : null;
      if (fact?.work) await adapter.metadata(fact.work, createLeaseReadContext(lease, deadline, "query"));
      return validateCreateResponse(operation, { fact: fact ? toCreateFactDto(fact) : null }, input);
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; this.invalidate();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closing = Promise.race([Promise.allSettled([...this.pending]), new Promise<never>((_r,reject) => { timer = setTimeout(() => reject(error("busy")), Math.min(30_000, Math.max(1,this.options.deadlineMs ?? 30_000))); })]).then(() => {
      if (this.options.closeStore && !this.storeClosed) { this.options.store.close(); this.storeClosed = true; }
    }).finally(() => { if (timer) clearTimeout(timer); if (this.closing === closing) this.closing = undefined; });
    this.closing = closing; return closing;
  }
}
