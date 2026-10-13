import { parseControlMaterial } from "./control-protocol";
import { finishPreparedMaterialInput, type MaterialInputDraft, type PreparedMaterialInput } from "./material-input-reader";
import type { Invocation } from "./control-types";
import { createHash } from "node:crypto";
import { controlIdentity } from "./control-protocol";
import type { WorkRef } from "./types";
import { OperationStore } from "./operation-store";
import {
  CollaborationControlError, type AuthenticatedPrincipal, type AuthorizeControl, type ControlAdapter,
  type ControlRequest, type DeliveryFact, type DeliveryStage, type NativeOutcome,
} from "./control-types";

export interface NativeInvocationClaim {readonly kind:'native-invocation-claim'}
const claims=new WeakMap<object,{invocation:Invocation;consumed:boolean}>(),endedClaims=new WeakSet<object>();
export function currentNativeInvocationClaim(proof:NativeInvocationClaim,invocation?:Invocation):Invocation{const c=claims.get(proof);if(!c||invocation&&JSON.stringify([c.invocation.principal,c.invocation.request,c.invocation.attempt_id,c.invocation.connector_epoch,c.invocation.native_client_message_id,c.invocation.native_interface_version])!==JSON.stringify([invocation.principal,invocation.request,invocation.attempt_id,invocation.connector_epoch,invocation.native_client_message_id,invocation.native_interface_version]))throw new CollaborationControlError('permission_denied');return c.invocation;}
export function isNativeInvocationClaimSettled(proof:NativeInvocationClaim):boolean{return endedClaims.has(proof);}
export function consumeNativeInvocationClaim(proof:NativeInvocationClaim,method:string,params:any):undefined{const i=currentNativeInvocationClaim(proof),c=claims.get(proof)!;if(c.consumed||i.request.input.material||method!==(i.request.action==='steer'?'turn/steer':'turn/start')||params.threadId!==i.request.work.native_id||params.clientUserMessageId!==i.native_client_message_id||params.expectedTurnId!==i.request.expected_turn_id||JSON.stringify(params.input)!==JSON.stringify([{type:'text',text:i.request.input.text,text_elements:[]}]))throw new CollaborationControlError('permission_denied');c.consumed=true;return undefined;}
const maxInputBytes = 64 * 1024;
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value)) throw new CollaborationControlError("invalid");
  return value;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new CollaborationControlError("invalid");
  return value as Record<string, unknown>;
}
function scope(value: unknown): WorkRef {
  const work = object(value, ["node_id", "endpoint_id", "kind", "native_id"]);
  if (work.kind !== "conversation") throw new CollaborationControlError("invalid");
  return Object.freeze({ node_id: controlIdentity(work.node_id), endpoint_id: controlIdentity(work.endpoint_id), kind: "conversation", native_id: id(work.native_id) });
}
/** Copies and freezes validated primitives before any async authorizer/adapter sees them. */
function envelope(value: unknown): ControlRequest {
  const request = object(value, ["request_id", "operation_id", "work", "action", "input", "expected_turn_id", "expires_at"]);
  const input = object(request.input, ["text", "material"]);
  if (typeof input.text !== "string" || !input.text.length) throw new CollaborationControlError("invalid");
  if (Buffer.byteLength(input.text, "utf8") > maxInputBytes) throw new CollaborationControlError("too_large");
  if (request.action !== "send_input" && request.action !== "steer") throw new CollaborationControlError("invalid");
  if (!Number.isSafeInteger(request.expires_at) || Number(request.expires_at) <= 0) throw new CollaborationControlError("invalid");
  const expected = request.expected_turn_id === undefined ? undefined : id(request.expected_turn_id);
  if (request.action === "steer" && !expected) throw new CollaborationControlError("invalid");
  return Object.freeze({ request_id: id(request.request_id), operation_id: id(request.operation_id), work: scope(request.work),
    action: request.action, input: Object.freeze({ text: input.text, ...(input.material===undefined?{}:{material:parseControlMaterial(input.material)}) }), expected_turn_id: expected, expires_at: Number(request.expires_at) });
}
function principal(value: AuthenticatedPrincipal): AuthenticatedPrincipal {
  return Object.freeze({ principal_id: controlIdentity(value?.principal_id) });
}
function digest(request: ControlRequest): string {
  // Explicit fixed ordering, including request ID, scope, action, precondition and expiry.
  // Input content is exact (no whitespace/Unicode folding), and never persisted.
  const legacy = [
    request.request_id, request.operation_id, request.work.node_id, request.work.endpoint_id,
    request.work.kind, request.work.native_id, request.action, request.input.text,
    request.expected_turn_id ?? null, request.expires_at,
  ];
  const m=request.input.material;
  return createHash("sha256").update(JSON.stringify(m?['ash.control.material-input/v1',legacy,m.version,m.profile,m.request_id,m.assets.map(a=>[a.asset_id,a.asset_version,a.sha256,a.byte_length,a.media_type])]:legacy)).digest("hex");
}
function outcome(value: NativeOutcome): NativeOutcome {
  const result = object(value, ["status", "receipt", "code"]);
  if (result.status === "rejected") {
    if (!["unsupported", "offline", "stale_precondition", "permission_denied"].includes(String(result.code)) || result.receipt !== undefined) throw new CollaborationControlError("invalid");
    return { status: "rejected", code: result.code as Extract<NativeOutcome, { status: "rejected" }>["code"] };
  }
  if (result.status !== "accepted" || result.code !== undefined) throw new CollaborationControlError("invalid");
  const receipt = object(result.receipt, ["accepted_by", "native_turn_id", "native_message_id", "correlation"]);
  if (receipt.accepted_by !== "native" && receipt.accepted_by !== "connector") throw new CollaborationControlError("invalid");
  if (receipt.correlation !== "stable_message_id" && receipt.correlation !== "uncertain") throw new CollaborationControlError("invalid");
  const message = receipt.native_message_id === undefined ? undefined : id(receipt.native_message_id);
  if (receipt.correlation === "stable_message_id" && !message) throw new CollaborationControlError("invalid");
  return { status: "accepted", receipt: { accepted_by: receipt.accepted_by, correlation: receipt.correlation,
    native_turn_id: receipt.native_turn_id === undefined ? undefined : id(receipt.native_turn_id), native_message_id: message } };
}

export interface DeliveryOptions {
  prepareMaterial?(request:ControlRequest):Promise<MaterialInputDraft>;
  bindMaterial?(draft:MaterialInputDraft,invocation:Invocation):PreparedMaterialInput;
  releaseMaterial?(draft:MaterialInputDraft):void;
  store: OperationStore;
  adapter: ControlAdapter;
  node_id: string;
  endpoint_id: string;
  authorize: AuthorizeControl;
  now?: () => number;
  /** Test-only fault windows. Never attach body/credentials to observations. */
  failpoint?: (stage: DeliveryStage) => void;
}
/**
 * Target-side durable delivery, with no retry queue, real connector or body log.
 * Authenticated identity MUST come from transport authentication. authorize MUST
 * recheck live grants and native scope ownership; returning true is not auth itself.
 * recorded may be claimed on a resend of the full same envelope; invoking/unknown
 * never invoke again. query returns saved journal facts; the separate readonly
 * DeliveryReconciler may enrich them using proven source client-ID associations.
 * accepted describes receipt level only, never execution or completion.
 * Expiry prevents new invocation; it does not hide retained facts from a currently
 * authorized principal querying or retransmitting the exact original envelope.
 */
export class DeliveryJournal {
  private readonly now: () => number;
  constructor(private readonly options: DeliveryOptions) {
    controlIdentity(options.node_id); controlIdentity(options.endpoint_id); id(options.adapter.connector_epoch);
    this.now = options.now ?? Date.now;
  }
  private target(work: WorkRef): void {
    if (work.node_id !== this.options.node_id || work.endpoint_id !== this.options.endpoint_id) throw new CollaborationControlError("permission_denied");
  }
  private async authorized(auth: AuthenticatedPrincipal, work: WorkRef, action: ControlRequest["action"], purpose: "invoke" | "query"): Promise<boolean> {
    try { return (await this.options.authorize(auth, work, action, purpose)) === true; }
    catch { return false; }
  }
  private stage(stage: DeliveryStage): void {
    try { this.options.failpoint?.(stage); }
    catch { throw new CollaborationControlError("storage_failure"); }
  }
  async deliver(identity: AuthenticatedPrincipal, value: ControlRequest): Promise<DeliveryFact> {
    const auth = principal(identity), request = envelope(value);
    this.target(request.work);
    if (!await this.authorized(auth, request.work, request.action, "invoke")) throw new CollaborationControlError("permission_denied");
    this.options.store.recoverAbandoned();
    const hash = digest(request);
    const existing = this.options.store.get(auth.principal_id, request.operation_id);
    if (existing && existing.payload_hash !== hash) throw new CollaborationControlError("conflict");
    if (existing && existing.delivery_status !== "recorded") return existing;
    if (this.now() >= request.expires_at) {
      if (existing) return this.options.store.rejectRecorded(auth.principal_id, request.operation_id, "expired", this.now());
      throw new CollaborationControlError("expired");
    }
    let draft:MaterialInputDraft|undefined;
    if(request.input.material){if(!this.options.prepareMaterial||!this.options.bindMaterial||!this.options.releaseMaterial)throw new CollaborationControlError('unsupported');draft=await this.options.prepareMaterial(request);}
    try {
    this.stage("before_record");
    const fact = this.options.store.record(auth.principal_id, request, hash, this.now());
    if (fact.delivery_status !== "recorded") return fact;
    this.stage("after_record");
    // Every actual invocation rechecks authorization and expiry after the durable record.
    if (!await this.authorized(auth, request.work, request.action, "invoke")) {
      this.options.store.rejectRecorded(auth.principal_id, request.operation_id, "permission_denied", this.now());
      throw new CollaborationControlError("permission_denied");
    }
    this.stage("before_invoking");
    const epoch = id(this.options.adapter.connector_epoch);
    const nativeVersion = id(this.options.adapter.native_interface_version);
    const claim = this.options.store.claim(auth.principal_id, request.operation_id, epoch, this.now(), nativeVersion);
    if (!claim.claimed) return claim.fact;
    let native: NativeOutcome | null = null;
    let prepared:PreparedMaterialInput|undefined;
    let claimProof:NativeInvocationClaim|undefined;
    try {
      this.stage("after_invoking");
      if (!await this.authorized(auth, request.work, request.action, "invoke")) throw new CollaborationControlError("permission_denied");
      if (this.options.adapter.connector_epoch !== epoch || this.options.adapter.native_interface_version !== nativeVersion) throw new CollaborationControlError("stale_precondition");
      const invocation:Invocation={ principal: auth, request, attempt_id: claim.fact.attempt_id!, connector_epoch: epoch, native_client_message_id: claim.fact.native_client_message_id!, native_interface_version: claim.fact.native_interface_version! };
      claimProof=Object.freeze({kind:'native-invocation-claim' as const});claims.set(claimProof,{invocation:Object.freeze({...invocation}),consumed:false});invocation.claim_proof=claimProof;
      if(draft){prepared=this.options.bindMaterial!(draft,invocation);invocation.prepared_input=prepared;}
      native = outcome(await this.options.adapter.invoke(invocation));
      this.stage("after_native");
    } catch {
      // An exception cannot establish that native acceptance did not occur.
      native = null;
    } finally { if(claimProof){endedClaims.add(claimProof);claims.delete(claimProof);}if(prepared)finishPreparedMaterialInput(prepared,native?.status??"unknown"); }
    const saved = this.options.store.finish(claim.fact, native, this.now());
    this.stage("after_saved");
    if (!await this.authorized(auth, request.work, request.action, "query")) throw new CollaborationControlError("permission_denied");
    return saved;
    } finally { if(draft)this.options.releaseMaterial!(draft); }
  }
  async query(identity: AuthenticatedPrincipal, operationId: string, value: WorkRef): Promise<DeliveryFact | null> {
    const auth = principal(identity), operation = id(operationId), work = scope(value);
    this.target(work);
    let fact = this.options.store.get(auth.principal_id, operation);
    // Even absent operations must pass authorization; no cross-principal enumeration.
    if (!await this.authorized(auth, work, fact?.action ?? "send_input", "query")) throw new CollaborationControlError("permission_denied");
    this.options.store.recoverAbandoned();
    fact = this.options.store.get(auth.principal_id, operation);
    if (!fact) return null;
    if (fact.work.node_id !== work.node_id || fact.work.endpoint_id !== work.endpoint_id || fact.work.native_id !== work.native_id) throw new CollaborationControlError("permission_denied");
    if (!await this.authorized(auth, work, fact.action, "query")) throw new CollaborationControlError("permission_denied");
    return fact;
  }
}
