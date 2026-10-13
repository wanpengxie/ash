import {AsyncLocalStorage} from 'node:async_hooks';
import {MaterialProtocolError,type MaterialTrustedContext} from './material-types';
import type {MaterialGatewayBindingResolver,MaterialGatewayOperation} from './material-gateway';
import type {MaterialRelayPeer} from './material-client';
/** Admission capacity follows genuine raw chains, including provider work after an observer ends. */
export class MaterialLinkWork {
 private accepting=true;private admissionFence?:()=>undefined;private readonly active=new Set<{outer:boolean;raw:number}>();private readonly invocation=new AsyncLocalStorage<{outer:boolean;raw:number}>();
 setAdmissionFence(current:()=>undefined):void{if(this.admissionFence)throw new MaterialProtocolError('conflict');this.admissionFence=current;}
 private reserve(){if(!this.accepting)throw new MaterialProtocolError('offline');if(this.admissionFence?.()!==undefined)throw new MaterialProtocolError('offline');if(this.active.size>=32)throw new MaterialProtocolError('too_large');const slot={outer:false,raw:0};this.active.add(slot);return slot;}
 private settle(slot:{outer:boolean;raw:number}){if(slot.outer&&slot.raw===0)this.active.delete(slot);}
 observeUnfinished=(work:Promise<unknown>):undefined=>{const captured=this.invocation.getStore(),current=captured&&this.active.has(captured)?captured:undefined,slot=current??this.reserve();if(!current)slot.outer=true;slot.raw++;work.finally(()=>{slot.raw--;this.settle(slot);}).catch(()=>{});return undefined;};
 run<T>(work:()=>Promise<T>):Promise<T>{let slot:{outer:boolean;raw:number};try{slot=this.reserve();}catch(error){return Promise.reject(error);}return this.invocation.run(slot,()=>Promise.resolve().then(()=>{this.current();return work();})).finally(()=>{slot.outer=true;this.settle(slot);});}
 current():undefined{if(!this.accepting)throw new MaterialProtocolError('offline');return undefined;}
 stop():void{this.accepting=false;}
 async drain(budgetMs=20000):Promise<{state:'closed'|'draining';busy:number}>{if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>20000)throw new MaterialProtocolError('invalid');this.stop();const until=Date.now()+budgetMs;while(this.active.size&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,Math.min(10,Math.max(1,until-Date.now()))));return {state:this.active.size?'draining':'closed',busy:this.active.size};}
 get busy(){return this.active.size;}
}
/** The device runtime owns issuance. A paired owner key alone never supplies a material actor. */
export interface DeviceMaterialBindingIssuer {resolve(bindingId:string,peer:MaterialRelayPeer,call?:MaterialGatewayOperation):Promise<{context:MaterialTrustedContext;current():undefined;finalCurrent?():undefined}>;current():undefined;}
export class DeviceMaterialLinkBindings implements MaterialGatewayBindingResolver {
 constructor(private readonly issuer:DeviceMaterialBindingIssuer){}
 async resolve(id:string,peer:MaterialRelayPeer,call?:MaterialGatewayOperation){peer=Object.freeze(structuredClone(peer));if(this.issuer.current()!==undefined)throw new MaterialProtocolError('permission_denied');const issued=await this.issuer.resolve(id,peer,call),context=Object.freeze(structuredClone(issued.context));if(this.issuer.current()!==undefined||issued.current()!==undefined||context.pairing_id!==peer.pairing_id)throw new MaterialProtocolError('permission_denied');return {context,finalCurrent:():undefined=>{if(this.issuer.current()!==undefined)throw new MaterialProtocolError('permission_denied');if((issued.finalCurrent?issued.finalCurrent():issued.current())!==undefined)throw new MaterialProtocolError('permission_denied');return undefined;},current:():undefined=>{if(this.issuer.current()!==undefined||issued.current()!==undefined)throw new MaterialProtocolError('permission_denied');return undefined;}};}
}
export const MATERIAL_IDENTITY_TYPE='ash.material.identity.v1';
