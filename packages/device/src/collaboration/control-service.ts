import { materialInputManifestHash } from "./material-input-manifest";
import { MaterialInputReader } from "./material-input-reader";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TrustedCallContext } from "./authorization";
import { ControlAuthorization, type ControlAuthorizationLease, type ControlAuthorizationSnapshot } from "./control-authorization";
import { CollaborationControlError, type ControlAdapter, type AuthorizeControl } from "./control-types";
import { DeliveryJournal } from "./delivery";
import { DeliveryReconciler, type ReconciliationReader } from "./reconciliation";
import type { OperationStore } from "./operation-store";
import type { WorkRef } from "./types";
import type { LiveSnapshot } from "./codex-live-state";
import { parseControlEnvelope, sameControlWork, toControlFactDto, validateControlResponse, type ControlOperation, type ControlResponse, type ControlManifestDto, type ControlEnvelope } from "./control-protocol";
export interface MaterialInputControlProof { readonly kind:'material-input-control' }
interface InputControlFacts { readonly principal_id:string; readonly work:Readonly<WorkRef>; readonly action:'send_input'|'steer'; readonly native_generation:string; readonly expires_at:number; readonly operation_id:string; readonly request_id:string; readonly manifest_hash:string|null; current():undefined;finalCurrent():undefined; }
const inputControlProofs=new WeakMap<object,InputControlFacts>();
/** Read-only capability inspection; only the actual service's admitted execution can issue it. */
export function currentInputControlProof(proof:MaterialInputControlProof):InputControlFacts { const p=inputControlProofs.get(proof);if(!p)throw new CollaborationControlError('permission_denied');p.current();return p; }
export function finalInputControlProof(proof:MaterialInputControlProof):InputControlFacts {const p=inputControlProofs.get(proof);if(!p)throw new CollaborationControlError('permission_denied');p.finalCurrent();return p;}
export type ScopedControlNative = ControlAdapter & ReconciliationReader & { current?():undefined;finalCurrent?():undefined; connect?(): Promise<void>; needsObservation?(work: WorkRef): boolean; observe(work: WorkRef): Promise<void>; snapshot(work: WorkRef): LiveSnapshot; close(): void };
/** Factory must create an isolated transport/subscription scope; never share callback slots between scopes. */
export interface ControlNativeScope { work: WorkRef; authorize: AuthorizeControl; allowSubscription(work: WorkRef): Promise<boolean>; allowHistory(work: WorkRef): Promise<boolean> }
export interface DeviceControlServiceOptions {
  node_id: string; endpoint_id: string; store: OperationStore; authorization: ControlAuthorization;
  grant(): ControlAuthorizationSnapshot;
  native(scope: ControlNativeScope): ScopedControlNative;
  materialInputReader?: MaterialInputReader;
  now?: () => number;
  deadlineMs?: number;
  /** Store lifetime can be owned by the main process instead. */
  closeStore?: boolean;
}
interface Scope { work:Readonly<WorkRef>; native: ScopedControlNative; leases: AsyncLocalStorage<ControlAuthorizationLease>; observed: string | null; observing: Promise<void> | null; connecting: Promise<void> | null; retired: boolean }
const limitations = { atomic_idle_start: false, cancel: false, queue: false, runtime_state: "unknown", subscription_state: "unknown" } as const;
export class DeviceControlService {
  private scopes = new Map<string, Scope>();
  private closed = false;
  private pending = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  private storeClosed = false;
  get busy(): boolean { return this.pending.size > 0; }
  /** Native idle must be observed; an empty proxy queue or finished RPC is insufficient. */
  changeSafety(): 'safe'|'busy'|'unknown' { if(this.closed)return 'unknown';if(this.pending.size||this.options.materialInputReader?.busy)return 'busy';for(const scope of this.scopes.values()){if(scope.retired)continue;try{const snapshot=scope.native.snapshot(scope.work);if(snapshot.connector_epoch!==scope.native.connector_epoch||snapshot.state==='unknown')return 'unknown';if(snapshot.state!=='idle')return 'busy';}catch{return 'unknown';}}return 'safe';}
  constructor(private readonly options: DeviceControlServiceOptions) {}
  /** Call on EVERY observed grant/pairing event, even a revoke/restore ABA. */
  invalidate(): void { this.options.authorization.invalidate(); for (const scope of this.scopes.values()) this.retire(scope); this.scopes.clear(); }
  manifest(): ControlManifestDto { const grant = this.options.grant(); return { version: 1, endpoint_id: this.options.endpoint_id, grant_state: grant.state, authorization_revision: grant.authorization_revision, actions: grant.state === "ready" ? (grant.config?.allowed_actions ?? []).filter((a): a is "send_input" | "steer" => a === "send_input" || a === "steer") : [], limitations: { ...limitations } }; }
  private scope(input: ControlEnvelope, lease: ControlAuthorizationLease): Scope {
    const action = input.request?.action ?? input.action;
    const key = JSON.stringify([lease.principal.principal_id, input.authorization_revision, input.work, action]);
    const old = this.scopes.get(key); if (old) return old;
    if (this.scopes.size >= 128) throw new CollaborationControlError("busy");
    const leases = new AsyncLocalStorage<ControlAuthorizationLease>();
    const authorize: AuthorizeControl = async (principal, work, action, purpose) => { const current = leases.getStore(); return !!current && await current.authorize(principal, work, action, purpose); };
    const permitted = async (work: WorkRef) => { const current = leases.getStore(); return !!current && sameControlWork(work, input.work) && await current.check("query"); };
    const native = this.options.native({ work: { ...input.work }, authorize, allowSubscription: permitted, allowHistory: permitted });
    const scope: Scope = { work:Object.freeze({...input.work}), native, leases, observed: null, observing: null, connecting: null, retired: false }; this.scopes.set(key, scope); return scope;
  }
  private retire(scope: Scope): void {
    if (scope.retired) return;
    scope.retired = true;
    for (const [key, candidate] of this.scopes) if (candidate === scope) this.scopes.delete(key);
    scope.native.close();
  }
  private async connected(scope: Scope): Promise<void> {
    if (scope.retired || this.closed) throw new CollaborationControlError("offline");
    // connect() deliberately creates a new native epoch. Admission must share an
    // ongoing handshake and must not invoke it on an already connected source.
    if (scope.connecting) { await scope.connecting; return; }
    if (scope.native.connector_epoch !== "disconnected") return;
    scope.connecting = (async () => {
      await scope.native.connect?.();
      if (scope.retired || this.closed || scope.native.connector_epoch === "disconnected") throw new CollaborationControlError("offline");
    })();
    try { await scope.connecting; } catch (error) { this.retire(scope); throw error; } finally { scope.connecting = null; }
  }
  private async observe(scope: Scope, input: ControlEnvelope): Promise<void> {
    const epoch = scope.native.connector_epoch;
    if (scope.observed === epoch && !scope.native.needsObservation?.(input.work)) return;
    // Concurrent callers do not re-resume; all still perform their own lease final checks.
    if (scope.observing) { await scope.observing; return; }
    scope.observing = scope.native.observe(input.work).then(() => { if (scope.native.connector_epoch !== epoch) throw new CollaborationControlError("stale_precondition"); scope.observed = epoch; });
    try { await scope.observing; } catch (error) { this.retire(scope); throw error; } finally { scope.observing = null; }
  }
  async execute(operation: ControlOperation, body: unknown, context?: TrustedCallContext): Promise<ControlResponse> {
    if (this.closed) throw new CollaborationControlError("offline");
    const deadline = Date.now() + Math.min(30_000, Math.max(1, this.options.deadlineMs ?? 30_000));
    const boundContext = context && { transportOwnerId: context.transportOwnerId, isCurrent: () => !this.closed && Date.now() < deadline && context.isCurrent() };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new CollaborationControlError(operation === "apply" ? "result_unknown" : "offline")), Math.max(1, deadline - Date.now())); });
    // Track the execution, not its caller's deadline race: an accepted native
    // request may still own a journal claim after the response has timed out.
    const execution = this.executeBound(operation, body, boundContext);
    this.pending.add(execution);
    execution.then(() => this.pending.delete(execution), () => this.pending.delete(execution));
    try { return await Promise.race([timeout, execution]); } finally { if (timer) clearTimeout(timer); }
  }
  private async executeBound(operation: ControlOperation, body: unknown, context?: TrustedCallContext): Promise<ControlResponse> {
    if (this.closed) throw new CollaborationControlError("offline");
    if (!["state", "apply", "query", "reconcile"].includes(operation)) throw new CollaborationControlError("invalid");
    const input = parseControlEnvelope(operation, body) as ControlEnvelope;
    const action = input.request?.action ?? input.action!;
    const lease = await this.options.authorization.begin(context, { endpoint_id: input.endpoint_id, authorization_revision: input.authorization_revision, work: input.work, action });
    return lease.run(operation === "apply" ? "invoke" : "query", async () => {
      if (this.closed) throw new CollaborationControlError("offline");
      let response: ControlResponse;
      if (operation === "query") {
        this.options.store.recoverAbandoned();
        const fact = this.options.store.get(lease.principal.principal_id, input.operation_id!);
        if (fact && (!sameControlWork(fact.work, input.work) || fact.action !== action)) throw new CollaborationControlError("permission_denied");
        response = { fact: fact ? toControlFactDto(fact) : null };
      } else {
        // Check saved target/action before constructing a source connection for reconciliation.
        if (operation === "reconcile") {
          const fact = this.options.store.get(lease.principal.principal_id, input.operation_id!);
          if (fact && (!sameControlWork(fact.work, input.work) || fact.action !== action)) throw new CollaborationControlError("permission_denied");
          if (!fact) return validateControlResponse(operation, { fact: null }, input);
        }
        const scope = this.scope(input, lease);
        response = await scope.leases.run(lease, async () => {
          await this.connected(scope);
          if (operation === "state") {
            await this.observe(scope, input);
            const snapshot = scope.native.snapshot(input.work);
            return { target: { endpoint_id: input.endpoint_id, work: { ...input.work } }, authorization_revision: input.authorization_revision, connector_epoch: scope.native.connector_epoch, native_interface_version: scope.native.native_interface_version, snapshot, allowed_actions: this.manifest().actions, limitations: { ...limitations, runtime_state: snapshot.state === "unknown" ? "unknown" : "observed", subscription_state: "observed" } };
          }
          if (operation === "apply") {
            if (scope.native.connector_epoch !== input.expected_connector_epoch) throw new CollaborationControlError("stale_precondition");
            // Expected epoch is also checked at every J invoke authorization boundary.
            const authorize: AuthorizeControl = async (...args) => await lease.authorize(...args) && (args[3] !== "invoke" || scope.native.connector_epoch === input.expected_connector_epoch);
            const reader=this.options.materialInputReader;
            let revoked=false;
            const proof=Object.freeze({kind:'material-input-control' as const});
            const generation=scope.native.connector_epoch,expires=input.request!.expires_at;
            const controlCurrent=(force:boolean):undefined=>{try{if(revoked||this.closed||scope.retired||scope.native.connector_epoch!==generation||Date.now()>=expires||lease.current()!==undefined||typeof scope.native.current!=='function')throw 0;const current=force?(scope.native.finalCurrent??scope.native.current):scope.native.current;if(current.call(scope.native)!==undefined)throw 0;return undefined;}catch{revoked=true;throw new CollaborationControlError('permission_denied');}};
            inputControlProofs.set(proof,Object.freeze({principal_id:lease.principal.principal_id,work:Object.freeze({...input.work}),action:input.request!.action,native_generation:generation,expires_at:expires,operation_id:input.request!.operation_id,request_id:input.request!.request_id,manifest_hash:input.request!.input.material?materialInputManifestHash(input.request!.input.material):null,current:()=>controlCurrent(false),finalCurrent:()=>controlCurrent(true)}));
            const journal = new DeliveryJournal({ ...(reader?{prepareMaterial:async(request)=>reader.read(request,proof),bindMaterial:(draft,invocation)=>reader.bind(draft,invocation),releaseMaterial:(draft)=>reader.release(draft)}:{}), store: this.options.store, adapter: scope.native, authorize, node_id: this.options.node_id, endpoint_id: this.options.endpoint_id, now: this.options.now });
            const fact = await journal.deliver(lease.principal, input.request!);
            return { fact: toControlFactDto(fact) };
          }
          const reconciler = new DeliveryReconciler({ store: this.options.store, reader: scope.native, authorize: lease.authorize, node_id: this.options.node_id, endpoint_id: this.options.endpoint_id, now: this.options.now });
          const fact = await reconciler.reconcile(lease.principal, input.operation_id!, input.work);
          return { fact: fact ? toControlFactDto(fact) : null };
        });
      }
      return validateControlResponse(operation, response, input);
    }).catch(error => { if (error instanceof CollaborationControlError) throw error; throw new CollaborationControlError("offline"); });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (!this.closed) { this.closed = true; this.invalidate(); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = Promise.allSettled([...this.pending]);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CollaborationControlError("busy")), Math.min(30_000, Math.max(1, this.options.deadlineMs ?? 30_000)));
    });
    const closing = Promise.race([drain, timeout]).then(() => {
      if (this.options.closeStore && !this.storeClosed) { this.options.store.close(); this.storeClosed = true; }
    }).finally(() => { if (timer) clearTimeout(timer); if (this.closing === closing) this.closing = undefined; });
    this.closing = closing;
    return closing;
  }
}
