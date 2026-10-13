import {captureProtectedReadSource,currentReadSource,releaseReadSource,readSourceDrained,type ProtectedReadSource} from '../collaboration/read-source';
import {probeSavedHistorySource} from '../collaboration/read-source-probe';
import {isDeepStrictEqual} from 'node:util';
import {lstatSync,realpathSync,statSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {LocalStateTransaction} from '../collaboration/local-state-transaction';
import {readLocalStateFile} from '../collaboration/local-state';
import {parseControlRuntimeConfig,discoverControlListener,type DeviceControlRuntimeOptions} from '../collaboration/control-runtime';
import {CodexTransport} from '../collaboration/codex-transport';
import {SetupError} from './scope-settings';
import type {SetupVerification,ScopeSelection} from './service';

export interface SetupVerificationProof {readonly kind:'setup-native-verification';}
const proofs=new WeakMap<object,{selection:ScopeSelection;current(final:boolean):undefined;sourceCurrent():undefined;release():undefined;binding?:{source_id:string;binding_revision:string}}> ();
export function currentSetupVerificationProof(proof:SetupVerificationProof,selection:Readonly<ScopeSelection>,final=false):undefined{const issued=proofs.get(proof);if(!issued||!isDeepStrictEqual(issued.selection,selection))throw new SetupError('unavailable');return issued.current(final);}
/** Final cheap source check after any blocking reservation/native scan; private issued proof only. */
export function currentSetupVerificationSourceProof(proof:SetupVerificationProof,selection:Readonly<ScopeSelection>):undefined{const issued=proofs.get(proof);if(!issued||!isDeepStrictEqual(issued.selection,selection))throw new SetupError('unavailable');return issued.sourceCurrent();}
export function releaseSetupVerificationProof(proof:SetupVerificationProof):undefined{const issued=proofs.get(proof);if(!issued)throw new SetupError('unavailable');return issued.release();}
export function setupVerificationReadBinding(proof:SetupVerificationProof,selection:Readonly<ScopeSelection>){const issued=proofs.get(proof);if(!issued||selection.kind!=='read'||!isDeepStrictEqual(issued.selection,selection)||!issued.binding)throw new SetupError('unavailable');issued.sourceCurrent();return Object.freeze({...issued.binding});}
interface Options {stateDir:string;nodeId:string;endpointId:string;current():undefined;testing?:DeviceControlRuntimeOptions['testing'];readTesting?:Parameters<typeof captureProtectedReadSource>[0]['testing'];}
/** Online authenticated local management lookup only. Metadata never constitutes a grant. */
export class SetupNativeVerification implements SetupVerification {
 private readonly state:LocalStateTransaction;private closed=false;private raw=new Set<Promise<unknown>>();private closing?:Promise<void>;private retained=new Set<SetupVerificationProof>();private drains=new Set<Promise<void>>();
 constructor(private readonly options:Options){this.state=new LocalStateTransaction(options.stateDir);}
 private fence(current:()=>undefined):undefined{if(this.closed||this.options.current()!==undefined||current()!==undefined)throw new SetupError('unavailable');return undefined;}
 async verifyScope(selection:Readonly<ScopeSelection>,current:()=>undefined=()=>undefined):Promise<boolean>{const proof=await this.captureScope(selection,current);try{currentSetupVerificationProof(proof,selection,true);return true;}finally{releaseSetupVerificationProof(proof);}}
 captureScope(selection:Readonly<ScopeSelection>,current:()=>undefined=()=>undefined):Promise<SetupVerificationProof>{
  const input=structuredClone(selection);if(this.closed||this.raw.size+this.retained.size>=8)return Promise.reject(new SetupError(this.closed?'unavailable':'busy'));
  const work=Promise.resolve().then(()=>this.verify(input,current));this.raw.add(work);work.finally(()=>this.raw.delete(work)).catch(()=>{});return work;
 }
 private disposeSource(source:ProtectedReadSource){try{releaseReadSource(source);}catch(error){if((error as {code?:string}).code!=='draining')throw error;const task=readSourceDrained(source).then(()=>{releaseReadSource(source);});this.drains.add(task);task.then(()=>this.drains.delete(task),()=>{});}}
 private async verifyRead(selection:Extract<ScopeSelection,{kind:'read'}>,current:()=>undefined){
  const observed=this.state.capture(),directories=new Map(selection.allowedCwds.map(path=>[path,this.directory(path)]));let source:ProtectedReadSource|undefined,transferred=false;
  const check=():undefined=>{this.fence(current);this.state.assertCurrent(observed);for(const[path,id]of directories)if(this.directory(path)!==id)throw new SetupError('stale');return undefined;};
  try{check();source=captureProtectedReadSource({stateDir:this.options.stateDir,endpointId:this.options.endpointId,current:check,...(this.options.readTesting?{testing:this.options.readTesting}:{})});
   await probeSavedHistorySource({source,allowedCwds:selection.allowedCwds,current:check});check();currentReadSource(source);const held=source;let released=false;
   const proof=Object.freeze({kind:'setup-native-verification' as const});proofs.set(proof,{selection:structuredClone(selection),binding:{source_id:held.source_id,binding_revision:held.source_revision},current:()=>{if(released)throw new SetupError('unavailable');check();currentReadSource(held);check();return undefined;},sourceCurrent:()=>{if(released)throw new SetupError('unavailable');check();currentReadSource(held);check();return undefined;},release:()=>{if(!released){released=true;this.disposeSource(held);this.retained.delete(proof);}return undefined;}});this.retained.add(proof);transferred=true;return proof;
  }finally{if(source&&!transferred)this.disposeSource(source);}
 }
 private async verify(selection:ScopeSelection,current:()=>undefined){
  if(selection.kind==='read')return this.verifyRead(selection,current);
  this.fence(current);const observed=this.state.capture(),file=readLocalStateFile(join(this.options.stateDir,'collaboration-control-runtime.json'),16384);if(!file)throw new SetupError('unavailable');
  const config=parseControlRuntimeConfig(JSON.parse(file.raw),this.options.endpointId),directories=new Map<string,string>(),socketIdentity=this.socketIdentity(config.socket);
  const check=():undefined=>{this.fence(current);this.state.assertCurrent(observed);if(readLocalStateFile(join(this.options.stateDir,'collaboration-control-runtime.json'),16384)?.identity!==file.identity)throw new SetupError('stale');if(this.socketIdentity(config.socket)!==socketIdentity)throw new SetupError('stale');for(const[path,id]of directories)if(this.directory(path)!==id)throw new SetupError('stale');return undefined;};
  if(selection.scope.kind==='exact_cwd')directories.set(selection.scope.cwd,this.directory(selection.scope.cwd));
  else {const work=selection.scope.work;if(work.node_id!==this.options.nodeId||work.endpoint_id!==this.options.endpointId||work.kind!=='conversation')throw new SetupError('invalid');}
  check();const discover=()=>{check();return this.options.testing?.listener?.(config)??discoverControlListener(config);},evidence=discover();
  const native=new CodexTransport({socket:config.socket,executable:config.executable,pid:evidence.pid,supportedVersions:config.supportedVersions,timeoutMs:5000,maxBytes:1048576,current:check,verifyListener:discover,...(this.options.testing?.connectSocket?{connectSocket:this.options.testing.connectSocket}:{})});
  try{
   await native.connect();check();native.finalCurrent();check();
   if(selection.kind==='control'&&selection.scope.kind==='single_work'){
    const work=selection.scope.work,result=await native.request('thread/read',{threadId:work.native_id,includeTurns:false});check();native.finalCurrent();check();
    const thread=result?.thread;if(!thread||thread.id!==work.native_id||typeof thread.cwd!=='string')throw new SetupError('invalid');directories.set(thread.cwd,this.directory(thread.cwd));
   }
   check();native.finalCurrent();check();let released=false;
   const proof=Object.freeze({kind:'setup-native-verification' as const});
   proofs.set(proof,{selection:structuredClone(selection),current:(final):undefined=>{if(released)throw new SetupError('unavailable');check();if(final)native.finalCurrent();else native.verifyCurrent();check();return undefined;},sourceCurrent:():undefined=>{if(released)throw new SetupError('unavailable');return check();},release:():undefined=>{if(!released){released=true;native.close();this.retained.delete(proof);}return undefined;}});
   this.retained.add(proof);return proof;
  }catch(error){try{check();throw error;}finally{native.close();}}
 }
 private socketIdentity(path:string):string{const canonical=realpathSync(path),stat=statSync(canonical,{bigint:true});if(!stat.isSocket())throw new SetupError('unavailable');return [canonical,stat.dev,stat.ino,stat.ctimeNs].join(':');}
 private directory(path:string):string{if(!isAbsolute(path)||realpathSync(path)!==path)throw new SetupError('invalid');const s=lstatSync(path,{bigint:true});if(!s.isDirectory()||s.isSymbolicLink())throw new SetupError('invalid');return [s.dev,s.ino,s.ctimeNs].join(':');}
 async diagnostics(){this.fence(()=>undefined);const file=readLocalStateFile(join(this.options.stateDir,'collaboration-control-runtime.json'),16384);if(!file)return {socket:'missing' as const,controlCapability:'missing' as const};try{const config=parseControlRuntimeConfig(JSON.parse(file.raw),this.options.endpointId),evidence=this.options.testing?.listener?.(config)??discoverControlListener(config);this.fence(()=>undefined);if(readLocalStateFile(join(this.options.stateDir,'collaboration-control-runtime.json'),16384)?.identity!==file.identity)throw 0;return {socket:'verified' as const,version:config.supportedVersions.includes(evidence.version)?'verified' as const:'incompatible' as const,client:'verified' as const};}catch{this.fence(()=>undefined);return {socket:'unavailable' as const};}}
 get draining(){return this.drains.size;}
 get busy(){return this.raw.size+this.retained.size;}
 close():Promise<void>{if(this.closing)return this.closing;this.closed=true;return this.closing=(async()=>{while(this.raw.size)await Promise.allSettled([...this.raw]);for(const proof of this.retained)releaseSetupVerificationProof(proof);while(this.drains.size)await Promise.all([...this.drains]);this.state.close();})();}
}
