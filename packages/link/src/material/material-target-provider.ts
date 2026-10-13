import { randomUUID } from 'node:crypto';
import { GatewayClient } from 'ash-gateway/client/client';
import { deviceIdForKey } from 'ash-gateway/src/protocol';
import { MaterialProtocolError } from '../../../sdk/src/collaboration/material-types';
import { relayFrame,relayRecord,relayId,relaySize,type MaterialRelayPeer,type MaterialRelayTransport } from './material-client';
import { MATERIAL_PROVIDER_REQUEST_TYPE,MATERIAL_PROVIDER_RESPONSE_TYPE,parseTargetInput,parseTargetFacts,type MaterialTargetInput,type MaterialTargetFacts } from '../../../sdk/src/collaboration/material-target-types';
export interface MaterialTargetWorkProof {readonly target:'material_to_work';}
export interface MaterialTargetProofRecord {readonly facts:Readonly<MaterialTargetFacts>;readonly pairing_id:string;readonly local_id:string;current():undefined;check():Promise<boolean>;release():void;}
const proofs=new WeakMap<object,MaterialTargetProofRecord>();
const registrations=new WeakMap<object,object>();
/** Opaque proof reader: no public issuer or structural callback can mint authority. */
export function currentMaterialTargetProof(proof:MaterialTargetWorkProof):MaterialTargetProofRecord {
  const record=proofs.get(proof);if(!record)throw new MaterialProtocolError('permission_denied');record.current();return record;
}
/** A reopened registry must recapture, rather than reattach a previous instance's snapshot. */
export function bindMaterialTargetProof(proof:MaterialTargetWorkProof,registry:object):MaterialTargetProofRecord {
  const record=currentMaterialTargetProof(proof),prior=registrations.get(proof);if(prior&&prior!==registry)throw new MaterialProtocolError('permission_denied');registrations.set(proof,registry);return record;
}
interface Pending {peer?:MaterialRelayPeer;input:MaterialTargetInput;message:string;deadline:number;epoch:number;timer:ReturnType<typeof setTimeout>;resolve(proof:MaterialTargetWorkProof):void;reject(error:unknown):void;}
export interface MaterialTargetProviderOptions {gateway:Pick<GatewayClient,"envelope">;transport:MaterialRelayTransport;observeUnfinished(work:Promise<unknown>):undefined;budgetMs?:number;}
/** Narrow base for signed provider operations; target.resolve is the only admitted operation. */
export class MaterialTargetProvider {
  private closed=false;private epoch=0;private pending=new Map<string,Pending>();private readonly budget:number;
  constructor(private readonly options:MaterialTargetProviderOptions){this.budget=options.budgetMs??30_000;if(!Number.isInteger(this.budget)||this.budget<1||this.budget>30_000)throw new MaterialProtocolError('invalid');}
  captureTarget(value:MaterialTargetInput):Promise<MaterialTargetWorkProof>{
    if(this.closed)return Promise.reject(new MaterialProtocolError('offline'));if(this.pending.size>=32)return Promise.reject(new MaterialProtocolError('too_large'));
    let input:MaterialTargetInput;try{input=parseTargetInput(value);}catch(e){return Promise.reject(e);}
    const call=randomUUID(),message=randomUUID(),deadline=Date.now()+this.budget,epoch=this.epoch;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{if(this.pending.get(call)!==p)return;this.pending.delete(call);reject(new MaterialProtocolError('timeout'));},this.budget);
      const p:Pending={input,message,deadline,epoch,timer,resolve,reject};this.pending.set(call,p);
      this.raw(async()=>{this.fence(call,p);p.peer=Object.freeze(structuredClone(await this.options.transport.capture()));this.fence(call,p);if(input.work.node_id!==p.peer.peer_id)throw new MaterialProtocolError('permission_denied');
        const e=await this.options.gateway.envelope(MATERIAL_PROVIDER_REQUEST_TYPE,p.peer.peer_id,{version:1,call_id:call,operation:'target.resolve',input},{ttlMs:Math.max(1,deadline-Date.now()-1),messageId:message});this.fence(call,p);relaySize(e);if(e.from!==p.peer.local_id||e.reply_to!==null)throw new MaterialProtocolError('permission_denied');if(this.options.transport.send(e)!==undefined)throw new MaterialProtocolError('offline');
      }).catch(e=>this.reject(call,p,e));
    });
  }
  private raw<T>(work:()=>Promise<T>):Promise<T>{let registered=false;const raw=Promise.resolve().then(()=>{if(!registered)throw new MaterialProtocolError('offline');return work();});raw.catch(()=>{});try{if(this.options.observeUnfinished(raw)!==undefined)throw new MaterialProtocolError('offline');registered=true;}catch{}return raw;}
  private fence(call:string,p:Pending):void{if(this.closed||p.epoch!==this.epoch||this.pending.get(call)!==p)throw new MaterialProtocolError('offline');if(Date.now()>=p.deadline)throw new MaterialProtocolError('timeout');if(p.peer&&this.options.transport.current(p.peer)!==undefined)throw new MaterialProtocolError('permission_denied');}
  private reject(call:string,p:Pending,e:unknown):void{if(this.pending.get(call)!==p)return;this.pending.delete(call);clearTimeout(p.timer);p.reject(e);}
  ownsResponse(value:unknown):boolean{try{return (value as any)?.type===MATERIAL_PROVIDER_RESPONSE_TYPE&&this.pending.has(JSON.parse((value as any).payload).call_id);}catch{return false;}}
  acceptFrame(value:unknown):Promise<boolean>{if((value as any)?.type!==MATERIAL_PROVIDER_RESPONSE_TYPE)return Promise.resolve(false);let copy:unknown;try{copy=structuredClone(value);}catch{return Promise.resolve(true);}return this.raw(()=>this.accept(copy));}
  private async accept(value:unknown):Promise<boolean>{let p:Pending|undefined,call='';try{
    const e=relayFrame(value,MATERIAL_PROVIDER_RESPONSE_TYPE,Date.now()),body=JSON.parse(e.payload);call=relayId(body.call_id);p=this.pending.get(call);if(!p?.peer)return true;this.fence(call,p);
    if(e.from!==p.peer.peer_id||e.to!==p.peer.local_id||e.reply_to!==p.message||e.expires_at>p.deadline||await deviceIdForKey(p.peer.public_key)!==p.peer.peer_id||!await GatewayClient.verifyEnvelope(e,p.peer.public_key))throw new MaterialProtocolError('permission_denied');this.fence(call,p);relayFrame(e,MATERIAL_PROVIDER_RESPONSE_TYPE,Date.now());
    if(Object.hasOwn(body,'error')){relayRecord(body,['version','call_id','error']);if(body.version!==1||!['invalid','offline','permission_denied','not_found','unsupported','timeout'].includes(body.error))throw new MaterialProtocolError('invalid');throw new MaterialProtocolError(body.error);}
    relayRecord(body,['version','call_id','result']);if(body.version!==1)throw new MaterialProtocolError('invalid');const facts=parseTargetFacts(body.result);if(JSON.stringify({work:facts.work,authorization_revision:facts.authorization_revision,action:facts.action})!==JSON.stringify(p.input)||facts.expires_at>p.deadline)throw new MaterialProtocolError('permission_denied');this.fence(call,p);
    const peer=p.peer,epoch=this.epoch,input=p.input;Object.freeze(facts.work);Object.freeze(facts);let released=false;
    const current=():undefined=>{try{if(released||this.closed||epoch!==this.epoch||Date.now()>=facts.expires_at||this.options.transport.current(peer)!==undefined)throw new Error();return undefined;}catch{released=true;throw new MaterialProtocolError('permission_denied');}};
    const proof=Object.freeze({target:'material_to_work' as const});proofs.set(proof,Object.freeze({facts,pairing_id:peer.pairing_id,local_id:peer.local_id,current,release:()=>{released=true;},check:async()=>{try{current();const next=await this.captureTarget(input);try{const record=currentMaterialTargetProof(next);current();if(record.facts.generation!==facts.generation||record.facts.cwd!==facts.cwd)throw new Error();return true;}finally{currentMaterialTargetProof(next).release();}}catch{released=true;return false;}}}));
    this.pending.delete(call);clearTimeout(p.timer);p.resolve(proof);
  }catch(e){if(p)this.reject(call,p,e);}return true;}
  invalidate():void{this.epoch++;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new MaterialProtocolError('offline'));}this.pending.clear();}
  close():void{this.closed=true;this.invalidate();}
  get inflight():number{return this.pending.size;}
}
