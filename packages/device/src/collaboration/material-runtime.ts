import {parseAssetEnvelope,parseMaterialEnvelope} from './material-protocol';
import {randomBytes} from 'node:crypto';
import {GatewayClient} from 'ash-gateway/client/client';
import {deviceIdForKey,verifySignature} from 'ash-gateway/src/protocol';
import type {Signer} from '../link';
import {MaterialAssetStore} from './material-store';
import {MaterialTransferService,type MaterialTransferServiceOptions} from './material-transfer';
import {MaterialProtocolError,type MaterialRequestService,type MaterialTrustedContext,type MaterialAssetService} from './material-types';
import type {MaterialCustodyAuthority} from './material-custody';
import {MaterialClient,type MaterialRelayTransport} from './material-client';
import {MaterialGatewayAdapter,type MaterialGatewayBindingResolver} from './material-gateway';
const capture=<T>(value:T):T=>{const copy=structuredClone(value);const freeze=(v:any):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}};freeze(copy);return copy;};
const deny=():never=>{throw new MaterialProtocolError('offline');};
/** Current physical node/state/store proof is supplied by the protected device runtime, never a request DTO. */
export interface DeviceMaterialRuntimeOptions extends Omit<MaterialTransferServiceOptions,'store'> {
 observeUnfinished?(work:Promise<unknown>):undefined;
 signer:Signer;rootDir:string;localStoreId:string;custody:MaterialCustodyAuthority;
 physicalCurrent():undefined;
 gateway:GatewayClient;transport:MaterialRelayTransport;bindings:MaterialGatewayBindingResolver;
 /** Explicit authenticated request service; absent services are unsupported, never an allow-all shim. */
 requests?:MaterialRequestService;
 clock?:()=>number;
}
/** Owns only its A1 store, transfer service and A3 pair. Caller owns injected authority/request service. */
export class DeviceMaterialRuntime {
 readonly store:MaterialAssetStore;readonly client:MaterialClient;readonly adapter:MaterialGatewayAdapter;readonly assets:MaterialAssetService;
 private generation=0;private closed=false;private draining=false;private closing?:Promise<void>;private readonly active=new Set<Promise<unknown>>();
 private constructor(private readonly options:DeviceMaterialRuntimeOptions){
  this.store=new MaterialAssetStore({rootDir:options.rootDir,localStoreId:options.localStoreId,custody:options.custody,authorization:options.authorization,clock:options.clock});
  const service=new MaterialTransferService({...options,store:this.store,currentContext:context=>{this.current(context);return undefined;}});
  this.assets={invoke:((action,input,context)=>{try{const parsed=capture(parseAssetEnvelope(action,input)),ctx=capture(context);return this.run(()=>service.invoke(action,parsed,ctx),ctx);}catch(error){return Promise.reject(error);}}) as MaterialAssetService['invoke']};
  const transport:MaterialRelayTransport={capture:async()=>{this.current();const peer=capture(await options.transport.capture());this.current();if(peer.local_id!==options.signer.id)deny();options.transport.current(peer);return peer;},current:peer=>{this.current();if(options.transport.current(peer)!==undefined)deny();return undefined;},send:frame=>{this.current();if(frame.from!==options.signer.id||options.transport.send(frame)!==undefined)deny();return undefined;}};
  this.client=new MaterialClient({gateway:options.gateway,transport,clock:options.clock,observeUnfinished:options.observeUnfinished});this.adapter=new MaterialGatewayAdapter({gateway:options.gateway,transport,bindings:{resolve:async(id,peer,call)=>{this.current();const binding=await options.bindings.resolve(id,peer,call),context=capture(binding.context);this.current(context);return {context,finalCurrent:()=>{if((binding.finalCurrent?binding.finalCurrent():binding.current())!==undefined)throw new MaterialProtocolError('permission_denied');return undefined;},current:()=>{this.current(context);if(binding.current()!==undefined)deny();return undefined;}};}},requests:options.requests?{invoke:((action,input,context)=>{try{const parsed=capture(parseMaterialEnvelope(action,input)),ctx=capture(context);return this.run(()=>options.requests!.invoke(action,parsed,ctx),ctx);}catch(error){return Promise.reject(error);}}) as MaterialRequestService['invoke']}:undefined,assets:this.assets,clock:options.clock,observeUnfinished:options.observeUnfinished});
 }
 static async open(options:DeviceMaterialRuntimeOptions):Promise<DeviceMaterialRuntime>{
  if(options.physicalCurrent()!==undefined)deny();const challenge=randomBytes(32),signature=await options.signer.sign(challenge);if(options.physicalCurrent()!==undefined||await deviceIdForKey(options.signer.publicKey)!==options.signer.id||!await verifySignature(options.signer.publicKey,signature,challenge))deny();if(options.physicalCurrent()!==undefined)deny();const peer=capture(await options.transport.capture());if(options.physicalCurrent()!==undefined||options.transport.current(peer)!==undefined||peer.local_id!==options.signer.id)deny();return new DeviceMaterialRuntime(options);
 }
 current(context?:Readonly<MaterialTrustedContext>):undefined{if(this.closed||this.draining)deny();if(this.options.physicalCurrent()!==undefined)deny();if(context&&this.options.currentContext(context as MaterialTrustedContext)!==undefined)deny();return undefined;}
 private run<T>(work:()=>Promise<T>,context:MaterialTrustedContext):Promise<T>{this.current(context);if(this.active.size>=32)return Promise.reject(new MaterialProtocolError('too_large'));const epoch=this.generation,task=Promise.resolve().then(work);this.active.add(task);task.finally(()=>this.active.delete(task)).catch(()=>{});return task.then(value=>{this.current(context);if(epoch!==this.generation)deny();return value;},error=>{this.current(context);if(epoch!==this.generation)deny();throw error;});}
 readiness(){let live=false;try{this.current();live=true;}catch{}return Object.freeze({material:live,generation:this.generation,local_store_id:this.options.localStoreId,node_id:this.options.signer.id});}
 get busy(){return this.active.size+this.client.inflight+this.adapter.inflight;}
 async acceptFrame(frame:unknown){frame=capture(frame);this.current();return await this.adapter.acceptFrame(frame)||await this.client.acceptFrame(frame);}
 invalidate():void{this.generation++;this.client.invalidate();this.adapter.invalidate();}
 close(budgetMs=20000):Promise<{state:'closed'|'draining';busy:number}>{if(!Number.isSafeInteger(budgetMs)||budgetMs<1||budgetMs>20000)return Promise.reject(new MaterialProtocolError('invalid'));if(!this.closing){this.draining=true;this.invalidate();this.client.close();this.adapter.close();this.closing=(async()=>{while(this.active.size)await Promise.allSettled([...this.active]);await this.store.close();this.closed=true;})();this.closing.catch(()=>{});}let timer:ReturnType<typeof setTimeout>|undefined;return Promise.race([this.closing.then(()=>({state:'closed' as const,busy:0})),new Promise<{state:'draining';busy:number}>(resolve=>{timer=setTimeout(()=>resolve({state:'draining',busy:Math.max(1,this.busy)}),budgetMs);})]).finally(()=>{if(timer)clearTimeout(timer);});}
}
