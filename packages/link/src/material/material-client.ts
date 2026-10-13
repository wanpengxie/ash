import { randomUUID } from "node:crypto";
import { GatewayClient } from "ash-gateway/client/client";
import type { Envelope } from "ash-gateway/src/protocol";
import { MATERIAL_LIMITS, MaterialProtocolError, type MaterialOperation, type AssetOperation, type MaterialInputs, type AssetInputs, type MaterialRequestService, type MaterialAssetService } from "../../../sdk/src/collaboration/material-types";
import { parseMaterialEnvelope, parseAssetEnvelope, toMaterialResultDto, toMaterialTransferDto, parseMaterialTarget, assertMaterialFactBinding } from "../../../sdk/src/collaboration/material-protocol";
export const MATERIAL_REQUEST_TYPE = "ash.material.request.v1";
export const MATERIAL_RESPONSE_TYPE = "ash.material.response.v1";
export const MATERIAL_OPERATIONS = Object.freeze(["discover", "submit", "reply", "get_result", "await_result", "ack_result"] as const);
export const ASSET_OPERATIONS = Object.freeze(["offer", "put_chunk", "commit", "read_chunk", "ack"] as const);
export type RelayOperation = MaterialOperation | AssetOperation;
export interface MaterialRelayPeer { readonly local_id: string; readonly peer_id: string; readonly public_key: string; readonly pairing_id: string; readonly generation: string; }
/** Implement capture from current verified pairing records; observe every revoke/restore by advancing generation. */
export interface MaterialRelayTransport {
  capture(): Promise<MaterialRelayPeer>;
  current(peer: MaterialRelayPeer): undefined;
  /** Synchronous enqueue on the captured connection. No implicit reconnect or resend. */
  send(envelope: Envelope): undefined;
}
export interface MaterialCallBinding { readonly binding_id: string; readonly deadline?: number; current(): undefined; }
export interface MaterialClientOptions { gateway: Pick<GatewayClient, "envelope">; transport: MaterialRelayTransport; clock?: () => number; /** Private lifecycle observer; no authority is conferred. */ observeUnfinished?(work: Promise<unknown>): undefined; maxInflight?: number; budgetMs?: number; }
export interface MaterialRelayRequest { version: 1; call_id: string; binding_id: string; operation: RelayOperation; input: unknown; }
const errorCodes = new Set(["invalid", "too_large", "permission_denied", "expired", "conflict", "not_found", "unsupported", "offline", "timeout", "result_unknown", "hash_mismatch"]);
export function relayError(error: unknown): MaterialProtocolError { return new MaterialProtocolError(error instanceof MaterialProtocolError ? error.code : "offline"); }
export function relayRecord(value: unknown, keys: readonly string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw new MaterialProtocolError("invalid");
  return value as Record<string, any>;
}
export function relayId(value: unknown): string { if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > 256 || /[\x00-\x1f]/.test(value)) throw new MaterialProtocolError("invalid"); return value; }
export function relaySize(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MATERIAL_LIMITS.envelope_bytes) throw new MaterialProtocolError("too_large"); }
export function relayFrame(value: unknown, type: string, now: number): Envelope {
  relaySize(value);
  const e = relayRecord(value, ["v", "type", "message_id", "from", "to", "issued_at", "expires_at", "reply_to", "payload", "sig"]);
  if (e.v !== 1 || e.type !== type || typeof e.payload !== "string" || typeof e.sig !== "string" || !e.sig || !Number.isSafeInteger(e.issued_at) || !Number.isSafeInteger(e.expires_at) || e.issued_at > now || e.expires_at <= now || e.expires_at <= e.issued_at || e.expires_at - e.issued_at > 30_000) throw new MaterialProtocolError("invalid");
  relayId(e.message_id); relayId(e.from); relayId(e.to); if (e.reply_to !== null) relayId(e.reply_to);
  return e as Envelope;
}
export function relayInput(operation: unknown, input: unknown): unknown {
  if (MATERIAL_OPERATIONS.includes(operation as MaterialOperation)) return parseMaterialEnvelope(operation as MaterialOperation, input);
  if (ASSET_OPERATIONS.includes(operation as AssetOperation)) return parseAssetEnvelope(operation as AssetOperation, input);
  throw new MaterialProtocolError("unsupported");
}
export function relayResult(operation: RelayOperation, value: unknown): unknown {
  if (operation === "discover") { const v = relayRecord(value, ["version", "target", "capabilities"]); if (v.version !== 1 || !Array.isArray(v.capabilities) || v.capabilities.length > 32 || v.capabilities.some((x: unknown) => typeof x !== "string" || Buffer.byteLength(x) > 256)) throw new MaterialProtocolError("invalid"); return { version: 1, target: parseMaterialTarget(v.target), capabilities: v.capabilities }; }
  if (operation === "read_chunk") return parseAssetEnvelope("put_chunk", value);
  return ASSET_OPERATIONS.includes(operation as AssetOperation) ? toMaterialTransferDto(value) : toMaterialResultDto(value);
}
export function relayResultBinding(operation: RelayOperation, input: any, result: any): void {
  if (operation === "discover") { if (JSON.stringify(input.target) !== JSON.stringify(result.target)) throw new MaterialProtocolError("permission_denied"); return; }
  if (operation === "submit") assertMaterialFactBinding(result, input, result.question);
  if (input.request_id !== result.request_id) throw new MaterialProtocolError("permission_denied");
  for (const key of ["transfer_id", "asset_id", "asset_version"]) if (key in input && input[key] !== result[key]) throw new MaterialProtocolError("permission_denied");
  if (operation === "read_chunk" && input.chunk_index !== result.chunk_index) throw new MaterialProtocolError("permission_denied");
}
interface Pending { peer: MaterialRelayPeer; binding: MaterialCallBinding; message: string; deadline: number; operation: RelayOperation; input: unknown; epoch: number; timer: ReturnType<typeof setTimeout>; resolve(value: any): void; reject(error: Error): void; }
export class MaterialClient {
  private pending = new Map<string, Pending>(); private epoch = 0; private closed = false;
  private readonly clock: () => number; private readonly budget: number; private readonly limit: number;
  constructor(private readonly options: MaterialClientOptions) { this.clock = options.clock ?? Date.now; this.budget = options.budgetMs ?? 30_000; this.limit = options.maxInflight ?? 32; if (!Number.isInteger(this.budget) || this.budget < 1 || this.budget > 30_000 || !Number.isInteger(this.limit) || this.limit < 1 || this.limit > 32) throw new MaterialProtocolError("invalid"); }
  invoke<K extends MaterialOperation>(operation: K, input: MaterialInputs[K], binding: MaterialCallBinding): Promise<K extends "discover" ? { version: 1; target: import("../../../sdk/src/collaboration/material-types").MaterialTarget; capabilities: readonly string[] } : import("../../../sdk/src/collaboration/material-types").MaterialResultFact> { return this.call(operation, input, binding) as any; }
  invokeAsset<K extends AssetOperation>(operation: K, input: AssetInputs[K], binding: MaterialCallBinding): Promise<K extends "read_chunk" ? AssetInputs["put_chunk"] : import("../../../sdk/src/collaboration/material-types").TransferFact> { return this.call(operation, input, binding) as any; }
  private call(operation: RelayOperation, value: unknown, binding: MaterialCallBinding): Promise<any> {
    if (this.closed) return Promise.reject(new MaterialProtocolError("offline"));
    if (this.pending.size >= this.limit) return Promise.reject(new MaterialProtocolError("too_large"));
    let input: unknown; try { binding.current(); relayId(binding.binding_id); input = relayInput(operation, value); } catch (e) { return Promise.reject(relayError(e)); }
    const call = randomUUID(), message = randomUUID(), deadline = Math.min(this.clock() + this.budget, binding.deadline ?? Infinity), epoch = this.epoch;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { let error = new MaterialProtocolError("timeout"); try { binding.current(); if (entry.peer) this.options.transport.current(entry.peer); } catch (e) { error = relayError(e); } this.pending.delete(call); reject(error); }, Math.max(1, deadline - this.clock()));
      const entry: Pending = { peer: undefined as any, binding, message, deadline, operation, input, epoch, timer, resolve, reject }; this.pending.set(call, entry);
      this.raw(async () => {
        this.fence(call,entry);
        entry.peer = Object.freeze(structuredClone(await this.options.transport.capture())); this.fence(call, entry);
        const envelope = await this.options.gateway.envelope(MATERIAL_REQUEST_TYPE, entry.peer.peer_id, { version: 1, call_id: call, binding_id: binding.binding_id, operation, input }, { ttlMs: Math.max(1, deadline - this.clock() - 1), messageId: message });
        this.fence(call, entry); relaySize(envelope); if (envelope.from !== entry.peer.local_id || envelope.reply_to !== null) throw new MaterialProtocolError("permission_denied"); this.options.transport.send(envelope);
      }).catch(error => { if (this.pending.get(call) === entry) { this.pending.delete(call); clearTimeout(timer); try { binding.current(); if(entry.peer) this.options.transport.current(entry.peer); } catch (e) { error = e; } reject(relayError(error)); } });
    });
  }
  private fence(call: string, entry: Pending): void { if (this.closed || this.pending.get(call) !== entry || entry.epoch !== this.epoch) throw new MaterialProtocolError("offline"); if (this.clock() >= entry.deadline) throw new MaterialProtocolError("timeout"); entry.binding.current(); if (entry.peer) this.options.transport.current(entry.peer); }
  private raw<T>(work:()=>Promise<T>):Promise<T>{let registered=false;const task=Promise.resolve().then(()=>{if(!registered)throw new MaterialProtocolError('offline');return work();});task.catch(()=>{});try{if(this.options.observeUnfinished?.(task)!==undefined)throw new MaterialProtocolError('offline');registered=true;}catch{/* Raw task rejects without starting provider work. */}return task;}
  acceptFrame(value:unknown):Promise<boolean>{if((value as any)?.type!==MATERIAL_RESPONSE_TYPE)return Promise.resolve(false);let captured:unknown;try{captured=structuredClone(value);}catch{return Promise.resolve(true);}return this.raw(()=>this.acceptResponse(captured));}
  private async acceptResponse(value: unknown): Promise<boolean> {
    if ((value as any)?.type !== MATERIAL_RESPONSE_TYPE) return false;
    let entry: Pending | undefined, call = "";
    try {
      const e = relayFrame(value, MATERIAL_RESPONSE_TYPE, this.clock()), body = JSON.parse(e.payload);
      if (body?.version !== 1) throw new MaterialProtocolError("invalid"); call = relayId(body.call_id); entry = this.pending.get(call); if (!entry?.peer) return true;
      this.fence(call, entry);
      if (e.from !== entry.peer.peer_id || e.to !== entry.peer.local_id || e.reply_to !== entry.message || e.expires_at > entry.deadline) throw new MaterialProtocolError("permission_denied");
      if (!await GatewayClient.verifyEnvelope(e, entry.peer.public_key)) throw new MaterialProtocolError("permission_denied"); this.fence(call, entry); relayFrame(e, MATERIAL_RESPONSE_TYPE, this.clock());
      if (Object.hasOwn(body, "error")) { relayRecord(body, ["version", "call_id", "error"]); if (!errorCodes.has(body.error)) throw new MaterialProtocolError("invalid"); throw new MaterialProtocolError(body.error); }
      relayRecord(body, ["version", "call_id", "result"]); const result = relayResult(entry.operation, body.result); relayResultBinding(entry.operation, entry.input, result); this.fence(call, entry);
      this.pending.delete(call); clearTimeout(entry.timer); entry.resolve(result);
    } catch (error) { if (entry && this.pending.get(call) === entry) { this.pending.delete(call); clearTimeout(entry.timer); try { entry.binding.current(); this.options.transport.current(entry.peer); } catch(e) { error=e; } entry.reject(relayError(error)); } }
    return true;
  }
  invalidate(): void { this.epoch++; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new MaterialProtocolError("offline")); } this.pending.clear(); }
  close(): void { this.closed = true; this.invalidate(); }
  get inflight(): number { return this.pending.size; }
}
