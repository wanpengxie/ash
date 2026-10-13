import { GatewayClient } from "ash-gateway/client/client";
import { MaterialProtocolError, type MaterialTrustedContext, type MaterialRequestService, type MaterialAssetService, type MaterialOperation, type AssetOperation, type MaterialInputs, type AssetInputs } from "./material-types";
import { MATERIAL_REQUEST_TYPE, MATERIAL_RESPONSE_TYPE, ASSET_OPERATIONS, relayFrame, relayRecord, relayId, relaySize, relayInput, relayResult, relayResultBinding, relayError, type MaterialRelayPeer, type MaterialRelayTransport } from "./material-client";
const replayOwners=new WeakMap<object,Map<string,number>>();
/** Physical runtime owns this opaque replay ledger across exact peer detach/reconnect. */
export class MaterialGatewayReplayOwner {readonly replay='material' as const;constructor(){replayOwners.set(this,new Map());Object.freeze(this);}}
export interface MaterialGatewayBinding { readonly context: MaterialTrustedContext; current(): undefined; finalCurrent?():undefined; }
/** Resolve a protected credential/session mapping AND exact current device/pairing/source endpoint. A body handle alone never authorizes. */
export type MaterialGatewayOperation = { [K in MaterialOperation]: Readonly<{operation:K;input:Readonly<MaterialInputs[K]>}> }[MaterialOperation] | { [K in AssetOperation]: Readonly<{operation:K;input:Readonly<AssetInputs[K]>}> }[AssetOperation];
/** This parsed copy is supplied only after signature verification and the current peer fence. */
export interface MaterialGatewayBindingResolver { resolve(bindingId: string, peer: MaterialRelayPeer, call?:MaterialGatewayOperation): Promise<MaterialGatewayBinding>; }
function freezeParsed<T>(value:T):T{if(value&&typeof value==='object'){Object.values(value).forEach(freezeParsed);Object.freeze(value);}return value;}
export interface MaterialGatewayAdapterOptions { gateway: GatewayClient; transport: MaterialRelayTransport; bindings: MaterialGatewayBindingResolver; requests?: MaterialRequestService; assets: MaterialAssetService; clock?: () => number; /** Private lifecycle observer, called synchronously before raw work starts. */ observeUnfinished?(work: Promise<unknown>): undefined; maxInflight?: number; maxReplayEntries?: number; replayOwner?:MaterialGatewayReplayOwner; }
export class MaterialGatewayAdapter {
  private epoch = 0; private closed = false; private active = new Set<object>(); private cancellations = new Map<object, () => void>(); private readonly seen:Map<string,number>; private readonly clock: () => number; private readonly limit: number; private readonly replayLimit: number;
  constructor(private readonly options: MaterialGatewayAdapterOptions) {const seen=options.replayOwner?replayOwners.get(options.replayOwner):new Map<string,number>();if(!seen)throw new MaterialProtocolError('invalid');this.seen=seen; this.clock = options.clock ?? Date.now; this.limit = options.maxInflight ?? 32; this.replayLimit = options.maxReplayEntries ?? 4096; if (!Number.isInteger(this.limit) || this.limit < 1 || this.limit > 32 || !Number.isInteger(this.replayLimit) || this.replayLimit < 1 || this.replayLimit > 4096) throw new MaterialProtocolError("invalid"); }
  async acceptFrame(value: unknown): Promise<boolean> {
    if ((value as any)?.type !== MATERIAL_REQUEST_TYPE) return false;
    if (this.closed || this.active.size >= this.limit) return true;
    const token = {}, epoch = this.epoch; this.active.add(token);
    let peer: MaterialRelayPeer | undefined, binding: MaterialGatewayBinding | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const e = relayFrame(value, MATERIAL_REQUEST_TYPE, this.clock());
      const body = relayRecord(JSON.parse(e.payload), ["version", "call_id", "binding_id", "operation", "input"]);
      if (body.version !== 1 || e.reply_to !== null) throw new MaterialProtocolError("invalid"); relayId(body.call_id); relayId(body.binding_id);
      // relayInput rejects unknown operations and validates their exact corresponding DTO.
      const call = freezeParsed(structuredClone({operation:body.operation,input:relayInput(body.operation,body.input)})) as MaterialGatewayOperation;
      const input = call.input;
      const deadline = Math.min(e.expires_at, this.clock() + 30_000);
      const fence = () => { if (this.closed || this.epoch !== epoch || !this.active.has(token)) throw new MaterialProtocolError("offline"); if (this.clock() >= deadline) throw new MaterialProtocolError("timeout"); if (peer) this.options.transport.current(peer); if (binding) { binding.current(); if (binding.context.pairing_id !== peer!.pairing_id || binding.context.expires_at <= this.clock()) throw new MaterialProtocolError("permission_denied"); } };
      const work = async () => {
        fence(); peer = Object.freeze(structuredClone(await this.options.transport.capture())); fence();
        if (e.from !== peer.peer_id || e.to !== peer.local_id) throw new MaterialProtocolError("permission_denied");
        if (!await GatewayClient.verifyEnvelope(e, peer.public_key)) throw new MaterialProtocolError("permission_denied"); fence(); relayFrame(e, MATERIAL_REQUEST_TYPE, this.clock());
        const resolved = await this.options.bindings.resolve(body.binding_id, peer, call);
        const context = structuredClone(resolved.context);
        const freeze = (v: any): void => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } }; freeze(context);
        binding = Object.freeze({ context, current: () => resolved.current(),finalCurrent:()=>resolved.finalCurrent?resolved.finalCurrent():resolved.current() }); fence();
        const replay = `${peer.pairing_id}:${peer.peer_id}:${e.message_id}`;
        const now = this.clock();
        for (const [key, expires] of this.seen) if (expires <= now) this.seen.delete(key);
        if (this.seen.has(replay)) return;
        if (this.seen.size >= this.replayLimit) throw new MaterialProtocolError("too_large");
        this.seen.set(replay, e.expires_at);
        let payload: object;
        try {
          fence(); const result = ASSET_OPERATIONS.includes(body.operation) ? await this.options.assets.invoke(body.operation as AssetOperation, input as AssetInputs[AssetOperation], binding.context) : await this.invokeRequest(body.operation as MaterialOperation,input,binding.context);
          fence(); const parsed = relayResult(body.operation, result); relayResultBinding(body.operation, input, parsed); payload = { version: 1, call_id: body.call_id, result: parsed };
        } catch (error) { fence(); payload = { version: 1, call_id: body.call_id, error: relayError(error).code }; }
        fence();if(binding.finalCurrent?.()!==undefined)throw new MaterialProtocolError('permission_denied'); const response = await this.options.gateway.envelope(MATERIAL_RESPONSE_TYPE, peer.peer_id, payload, { replyTo: e.message_id, ttlMs: Math.max(1, deadline - this.clock() - 1) });
        fence();if(binding.finalCurrent?.()!==undefined)throw new MaterialProtocolError('permission_denied'); relaySize(response); if (response.from !== peer.local_id || response.expires_at > deadline) throw new MaterialProtocolError("permission_denied"); this.options.transport.send(response);
      };
      let registered=false;const raw=Promise.resolve().then(()=>{if(!registered)throw new MaterialProtocolError('offline');return work();});raw.catch(()=>{});if(this.options.observeUnfinished?.(raw)!==undefined)throw new MaterialProtocolError('offline');registered=true;
      await Promise.race([raw, new Promise<never>((_, reject) => { this.cancellations.set(token, () => reject(new MaterialProtocolError("offline"))); timer = setTimeout(() => { this.active.delete(token); reject(new MaterialProtocolError("timeout")); }, Math.max(1, deadline - this.clock())); })]);
    } catch { /* Malformed/untrusted frames receive no oracle; late service completion is fenced. */ }
    finally { if (timer) clearTimeout(timer); this.active.delete(token); this.cancellations.delete(token); }
    return true;
  }
  private invokeRequest(operation:MaterialOperation,input:any,context:MaterialTrustedContext){if(!this.options.requests)throw new MaterialProtocolError('unsupported');return this.options.requests.invoke(operation,input,context);}
  invalidate(): void { this.epoch++; for (const cancel of this.cancellations.values()) cancel(); this.cancellations.clear(); this.active.clear(); /* Keep bounded replay tombstones across reconnects. */ }
  close(): void { this.closed = true; this.invalidate(); }
  get inflight(): number { return this.active.size; }
}
