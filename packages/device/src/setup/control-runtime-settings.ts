import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,realpathSync} from 'node:fs';
import {LocalStateTransaction,type LocalStateObservation} from '../collaboration/local-state-transaction';
import {parseCurrentPairing} from '../collaboration/pairing';
import {parseControlRuntimeConfig,discoverControlListener,type ControlRuntimeConfig} from '../collaboration/control-runtime';
import {CodexTransport,verifyListenerMainEvidence} from '../collaboration/codex-transport';
import type {ListenerEvidence} from '../collaboration/control-native-types';
import type {WorkRef} from '../collaboration/types';
import {SetupError} from './scope-settings';
import type {SetupRuntime} from './service';

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function owner(observed:LocalStateObservation):string {
 const raw=observed.files['paired.json'],pair=raw?parseCurrentPairing(raw.raw):null;
 if(!pair||pair.revoked)throw new SetupError('unpaired');return pair.ownerId;
}
function mapped(error:unknown):never {
 if(error instanceof SetupError)throw error;
 const code=(error as {code?:string})?.code;
 if(['stale','busy','storage','invalid','unsupported'].includes(code??'')){const failure=new SetupError(code as 'stale'|'busy'|'storage'|'invalid'|'unsupported');Object.assign(failure,{cause:error});throw failure;}
 throw new SetupError('unavailable');
}
/** Native-side candidates only. No daemon spawning, resume, grant or model operation. */
async function capture(config:ControlRuntimeConfig,current:()=>undefined) {
 current();const first=verifyListenerMainEvidence(discoverControlListener(config));
 const verify=()=>{current();const next=verifyListenerMainEvidence(discoverControlListener(config));if(JSON.stringify(first)!==JSON.stringify(next))throw new SetupError('stale');return next;};
 const native=new CodexTransport({...config,pid:first.pid,timeoutMs:5000,maxBytes:1024*1024,current,verifyListener:verify});
 try{await native.connect();current();native.finalCurrent();return {native,listener:first,current:()=>{current();native.finalCurrent();return undefined;}};}
 catch(error){native.close();current();throw error;}
}
interface Options {stateDir:string;endpointId:string;current():undefined;runtime:SetupRuntime;}
interface Preview {hash:string;before:LocalStateObservation;config:ControlRuntimeConfig;listener:ListenerEvidence;expires:number;}
/** Reuse the writer's exact commit receipt. A fresh observer has no authority to
 * ignore a notification merely because its bytes happen to be unchanged. */
function stateLease(state:LocalStateTransaction,current:()=>undefined,ownsState:boolean,onReleased:()=>void=()=>{}) {
 let released=false,onClose:()=>void=()=>{};
 const release=()=>{if(released)return;released=true;onReleased();onClose();if(ownsState)state.close();};
 return {state,current:():undefined=>{if(released)throw new SetupError('stale');if(current()!==undefined)throw new SetupError('unavailable');return undefined;},onClose:(fn:()=>void)=>{onClose=fn;},release};
}
export class ControlRuntimeSettings {
 private readonly state:LocalStateTransaction;private borrowers=new Set<()=>void>();private previews=new Map<string,Preview>();private closed=false;private pending=new Set<Promise<unknown>>();
 constructor(private readonly options:Options){this.state=new LocalStateTransaction(options.stateDir);}
 private fence(current:()=>undefined){if(this.closed||this.options.current()!==undefined||current()!==undefined)throw new SetupError('unavailable');}
 private track<T>(work:()=>Promise<T>):Promise<T>{const task=Promise.resolve().then(work);this.pending.add(task);task.finally(()=>this.pending.delete(task)).catch(()=>{});return task;}
 prepare(candidate:unknown,current:()=>undefined=()=>undefined){return this.track(async()=>{
  this.fence(current);for(const[id,p]of this.previews)if(p.expires<=Date.now())this.previews.delete(id);
  if(this.previews.size>=4||this.pending.size>4)throw new SetupError('busy');
  let proof:Awaited<ReturnType<typeof capture>>|undefined;
  try{const config=parseControlRuntimeConfig(candidate,this.options.endpointId),before=this.state.capture(),ownerId=owner(before);
   const check=():undefined=>{this.fence(current);this.state.assertCurrent(before);return undefined;};
   proof=await capture(config,check);proof.current();const id=randomUUID(),hash=digest({id,config,ownerId,revision:before.revision,listener:proof.listener});
   this.previews.set(id,{hash,before,config,listener:proof.listener,expires:Date.now()+30000});
   return {preview_id:id,selection_hash:hash,owner_id:ownerId,configuration:structuredClone(config),listener:structuredClone(proof.listener)};
  }catch(error){mapped(error);}finally{proof?.native.close();}
 });}
 apply(id:string,hash:string,current:()=>undefined=()=>undefined){return this.track(async()=>{
  this.fence(current);const p=this.previews.get(id);if(!p||p.hash!==hash||p.expires<=Date.now())throw new SetupError('stale');this.previews.delete(id);
  let proof:Awaited<ReturnType<typeof capture>>|undefined,reservation:Awaited<ReturnType<SetupRuntime['reserveChange']>>|undefined;
  const check=():undefined=>{this.fence(current);if(p.expires<=Date.now())throw new SetupError('stale');this.state.assertCurrent(p.before);owner(p.before);reservation?.assertCurrent();return undefined;};
  try{check();reservation=await this.options.runtime.reserveChange();check();proof=await capture(p.config,check);
   if(JSON.stringify(proof.listener)!==JSON.stringify(p.listener))throw new SetupError('stale');proof.current();
   this.state.write('collaboration-control-runtime.json',JSON.stringify(p.config)+'\n',p.before,()=>{check();proof!.current();return undefined;});
   return {state:'saved' as const,needsControlGrant:true as const};
  }catch(error){mapped(error);}finally{proof?.native.close();reservation?.release();}
 });}
 /** Explicit same-instance path retains the writer's registered commit receipt. */
 captureLoadedWork(work:WorkRef,current:()=>undefined=()=>undefined){return this.track(()=>{
  const lease=stateLease(this.state,()=>{this.fence(current);return undefined;},false,()=>this.borrowers.delete(lease.release));this.borrowers.add(lease.release);
  return captureLoadedControlWorkWithState({endpointId:this.options.endpointId,work},lease);
 });}
 listLoadedWorks(project:string,current:()=>undefined=()=>undefined){return this.track(()=>{
  const lease=stateLease(this.state,()=>{this.fence(current);return undefined;},false,()=>this.borrowers.delete(lease.release));this.borrowers.add(lease.release);
  return listLoadedControlWorksWithState({endpointId:this.options.endpointId,project},lease);
 });}
 get busy(){return this.pending.size;}
 async close(){this.closed=true;this.previews.clear();for(const release of [...this.borrowers])release();while(this.pending.size)await Promise.allSettled([...this.pending]);this.state.close();}
}

export interface LoadedControlWorkProof {readonly kind:'loaded-control-work';}
const works=new WeakMap<object,{target:{work:WorkRef;cwd:string;owner_id:string;confirmation_binding:string};current():undefined;release():void}>();
export function controlWorkProofTarget(proof:LoadedControlWorkProof){const value=works.get(proof);if(!value)throw new SetupError('invalid');value.current();return structuredClone(value.target);}
export function currentLoadedControlWork(proof:LoadedControlWorkProof):undefined{const value=works.get(proof);if(!value)throw new SetupError('invalid');return value.current();}
export function releaseLoadedControlWork(proof:LoadedControlWorkProof):void{const value=works.get(proof);if(!value)throw new SetupError('invalid');value.release();}
const MAX_LOADED=32,MAX_PAGES=4;
async function loadedIds(captured:Awaited<ReturnType<typeof capture>>,wanted?:string):Promise<string[]> {
 let cursor:string|null=null;const cursors=new Set<string>(),ids=new Set<string>();
 for(let page=0;page<MAX_PAGES;page++){captured.current();const result=await captured.native.request('thread/loaded/list',{limit:MAX_LOADED,...(cursor?{cursor}:{})});captured.current();
  if(!result||!Array.isArray(result.data)||result.data.length>MAX_LOADED||result.data.some((id:unknown)=>typeof id!=='string'||!id||id.length>1024||/[\u0000-\u001f]/.test(id)))throw new SetupError('unavailable');
  for(const id of result.data)ids.add(id);if(ids.size>MAX_LOADED)throw new SetupError('busy');if(wanted&&ids.has(wanted))return [...ids];
  if(result.nextCursor===null||result.nextCursor===undefined)return [...ids];
  if(typeof result.nextCursor!=='string'||!result.nextCursor||result.nextCursor.length>4096||cursors.has(result.nextCursor))throw new SetupError('unavailable');const next:string=result.nextCursor;cursor=next;cursors.add(next);
 }
 throw new SetupError('busy');
}
function operationFence(lease:ReturnType<typeof stateLease>,before:LocalStateObservation) {
 const deadline=Date.now()+30000;
 return ():undefined=>{lease.current();if(Date.now()>=deadline)throw new SetupError('unavailable');lease.state.assertCurrent(before);return undefined;};
}
/** Proves an already loaded target on this exact listener; never resumes a target. */
export async function captureLoadedControlWork(options:{stateDir:string;endpointId:string;work:WorkRef;current():undefined}):Promise<LoadedControlWorkProof>{
 return captureLoadedControlWorkWithState(options,stateLease(new LocalStateTransaction(options.stateDir),options.current,true));
}
async function captureLoadedControlWorkWithState(options:{endpointId:string;work:WorkRef},lease:ReturnType<typeof stateLease>):Promise<LoadedControlWorkProof>{
 const state=lease.state;let native:CodexTransport|undefined,transferred=false;
 try{const work=structuredClone(options.work);if(work.node_id!==options.endpointId||work.endpoint_id!==options.endpointId||work.kind!=='conversation'||typeof work.native_id!=='string'||!work.native_id||work.native_id.length>1024)throw new SetupError('invalid');
  const before=state.capture(),ownerId=owner(before),file=before.files['collaboration-control-runtime.json'];if(!file)throw new SetupError('unavailable');
  const config=parseControlRuntimeConfig(JSON.parse(file.raw),options.endpointId);
  const check=operationFence(lease,before),captured=await capture(config,check);native=captured.native;lease.onClose(()=>captured.native.close());
  if(!(await loadedIds(captured,work.native_id)).includes(work.native_id))throw new SetupError('source_not_running');
  const result=await native.request('thread/read',{threadId:work.native_id,includeTurns:false});captured.current();
  const thread=result?.thread;if(!thread||thread.id!==work.native_id||typeof thread.cwd!=='string')throw new SetupError('invalid');
  const cwd=thread.cwd,physical=()=>{if(realpathSync(cwd)!==cwd)throw new SetupError('stale');const s=lstatSync(cwd,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())throw new SetupError('stale');return `${s.dev}:${s.ino}`;},directory=physical();
  let released=false;const current=():undefined=>{try{if(released)throw new SetupError('stale');captured.current();if(physical()!==directory)throw new SetupError('stale');return undefined;}catch(error){return mapped(error);}};current();
  const proof=Object.freeze({kind:'loaded-control-work' as const});works.set(proof,{target:{work,cwd,owner_id:ownerId,confirmation_binding:digest({ownerId,pair:before.files['paired.json']?.identity,listener:captured.listener,work,cwd,directory})},current,release:()=>{if(!released){released=true;lease.release();}}});transferred=true;return proof;
 }catch(error){return mapped(error);}finally{if(!transferred){native?.close();lease.release();}}
}

/** Read-only choices from a fixed listener. Loaded membership does not by itself
 * prove that a GUI is attached; every chosen work still needs a fresh proof. */
export async function listLoadedControlWorks(options:{stateDir:string;endpointId:string;project:string;current():undefined}):Promise<{owner_id:string;items:Array<{work:WorkRef;title:string;cwd:string;updated_at:number|null}>}> {
 return listLoadedControlWorksWithState(options,stateLease(new LocalStateTransaction(options.stateDir),options.current,true));
}
async function listLoadedControlWorksWithState(options:{endpointId:string;project:string},lease:ReturnType<typeof stateLease>):Promise<{owner_id:string;items:Array<{work:WorkRef;title:string;cwd:string;updated_at:number|null}>}> {
 let native:CodexTransport|undefined;
 try{const project=realpathSync(options.project),directory=()=>{if(realpathSync(options.project)!==project)throw new SetupError('stale');const stat=lstatSync(project,{bigint:true});if(!stat.isDirectory()||stat.isSymbolicLink())throw new SetupError('invalid');return `${stat.dev}:${stat.ino}`;},identity=directory();
  const before=lease.state.capture(),ownerId=owner(before),file=before.files['collaboration-control-runtime.json'];if(!file)throw new SetupError('unavailable');
  const config=parseControlRuntimeConfig(JSON.parse(file.raw),options.endpointId),stateCheck=operationFence(lease,before),check=():undefined=>{stateCheck();if(directory()!==identity)throw new SetupError('stale');return undefined;};
  const captured=await capture(config,check);native=captured.native;lease.onClose(()=>captured.native.close());const ids=await loadedIds(captured),items:Array<{work:WorkRef;title:string;cwd:string;updated_at:number|null}>=[];
  for(const id of ids){const result=await native.request('thread/read',{threadId:id,includeTurns:false});captured.current();const thread=result?.thread;if(!thread||thread.id!==id||typeof thread.cwd!=='string')throw new SetupError('unavailable');if(thread.cwd!==project)continue;
   const rawTitle=typeof thread.name==='string'?thread.name:typeof thread.title==='string'?thread.title:'';
   const title=rawTitle.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,512)||`未命名会话 · ${id.slice(0,8)}`;
   const seconds=thread.updatedAt,updated_at=typeof seconds==='number'&&Number.isSafeInteger(seconds)&&seconds>=0&&seconds<=Number.MAX_SAFE_INTEGER/1000?seconds*1000:null;
   items.push({work:{node_id:options.endpointId,endpoint_id:options.endpointId,kind:'conversation',native_id:id},title,cwd:project,updated_at});
  }
  captured.current();return {owner_id:ownerId,items};
 }catch(error){return mapped(error);}finally{native?.close();lease.release();}
}
