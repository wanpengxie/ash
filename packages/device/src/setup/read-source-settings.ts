import {randomUUID,createHash} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {LocalStateTransaction,type LocalStateObservation} from '../collaboration/local-state-transaction';
import {parseCurrentPairing} from '../collaboration/pairing';
import {parseReadAuthorization} from '../collaboration/authorization';
import {ReadSourceError,captureProtectedReadSource,currentReadSource,releaseReadSource,parseReadSourceDescriptor,type ProtectedReadSource} from '../collaboration/read-source';
import {savedHistorySourceConfirmationBinding,discoverDefaultStdioSavedHistorySource,captureNativeReadDiscoveryInput,discoverSavedHistorySource,currentSavedHistorySourceCandidate,nativeSavedHistorySourceSelection,releaseSavedHistorySourceCandidate,releaseNativeReadDiscoveryInput,type NativeReadDiscoveryInput,type SavedHistorySourceCandidate} from './read-source-discovery';
import {readLocalStateFile} from '../collaboration/local-state';
import {SetupError} from './scope-settings';
import type {SetupRuntime} from './service';
export type ReadSourceSelection={kind:'default'}|{kind:'clear'};
export interface ReadSourcePreview {readonly preview_id:string;readonly selection_hash:string;readonly source:{state:'selected'|'clear';profile:'default'|null};readonly resetsReadGrant:true;readonly source_label?:string|null;readonly confirmation_binding?:string|null;}
interface Preview {id:string;hash:string;expires:number;claimed:boolean;before:LocalStateObservation;input?:NativeReadDiscoveryInput;candidate?:SavedHistorySourceCandidate;gate:{token:LocalStateObservation};}
interface Options {stateDir:string;endpointId:string;current():undefined;runtime:SetupRuntime;now?:()=>number;testing?:{defaultHome?:string;source?:Parameters<typeof captureProtectedReadSource>[0]['testing'];beforeDescriptorWrite?():void;afterCandidateCapture?():void;releaseCandidate?(candidate:SavedHistorySourceCandidate):undefined;releaseInput?(input:NativeReadDiscoveryInput):undefined};}
const same=(a:LocalStateObservation,b:LocalStateObservation,except?:string)=>Object.keys(a.files).every(k=>k===except||a.files[k as keyof typeof a.files]?.identity===b.files[k as keyof typeof b.files]?.identity);
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Trusted native producer only. Renderer requests carry opaque native choice IDs,
 * never paths or descriptor evidence. No history reader starts during discovery. */
export class ReadSourceSettings {
 private readonly state:LocalStateTransaction;private readonly previews=new Map<string,Preview>();private cached?:ProtectedReadSource;private closing=false;private closingWork?:Promise<void>;private raw=new Set<Promise<unknown>>();
 constructor(private readonly options:Options){this.state=new LocalStateTransaction(options.stateDir);}
 private now(){return (this.options.now??Date.now)();}
 private fence(current:()=>undefined=()=>undefined):undefined{if(this.closing||this.options.current()!==undefined||current()!==undefined)throw new SetupError('unavailable');return undefined;}
 private owner(observed:LocalStateObservation):string{const raw=observed.files['paired.json'];const pair=raw?parseCurrentPairing(raw.raw):null;if(!pair||pair.revoked)throw new SetupError('unpaired');return pair.ownerId;}
 private release(p:Pick<Preview,'candidate'|'input'>){let failure:unknown;try{if(p.candidate)(this.options.testing?.releaseCandidate??releaseSavedHistorySourceCandidate)(p.candidate);}catch(error){failure??=error;}try{if(p.input)(this.options.testing?.releaseInput??releaseNativeReadDiscoveryInput)(p.input);}catch(error){failure??=error;}if(failure)throw failure;}
 private prune(){for(const[id,p]of this.previews)if(p.expires<=this.now()){this.previews.delete(id);this.release(p);}}

 status(){this.fence();this.prune();const observed=this.state.capture();let owner:string|null=null;try{owner=this.owner(observed);}catch{}
  const file=observed.files['collaboration-read-runtime.json'];if(!file)return {state:'missing' as const,profile:null,needsReadGrant:true};
  try{const descriptor=parseReadSourceDescriptor(JSON.parse(file.raw),this.options.endpointId);if(this.cached){try{currentReadSource(this.cached);}catch{releaseReadSource(this.cached);this.cached=undefined;}}if(!this.cached)this.cached=captureProtectedReadSource({stateDir:this.options.stateDir,endpointId:this.options.endpointId,current:()=>this.fence(),...(this.options.testing?.source?{testing:this.options.testing.source}:{})});
   currentReadSource(this.cached);let ready=false;try{const raw=observed.files['collaboration-read.json'],grant=raw?parseReadAuthorization(JSON.parse(raw.raw),this.options.endpointId):null;ready=!!owner&&grant?.owner_id===owner&&grant.version===3&&grant.source_id===this.cached.source_id&&grant.binding_revision===this.cached.source_revision&&grant.allowedCwds.length>0;}catch{}
   this.state.assertCurrent(observed);return {state:'configured' as const,profile:'default' as const,needsReadGrant:!ready,source_id:this.cached.source_id,binding_revision:this.cached.source_revision,source_label:descriptor.codex_home};
  }catch{if(this.cached){releaseReadSource(this.cached);this.cached=undefined;}return {state:'changed' as const,profile:null,needsReadGrant:true};}
 }
 prepare(selection:ReadSourceSelection,current:()=>undefined=()=>undefined):Promise<ReadSourcePreview>{const work=this.prepareImpl(selection,current);this.raw.add(work);work.finally(()=>this.raw.delete(work)).catch(()=>{});return work;}
 private async prepareImpl(selection:ReadSourceSelection,current:()=>undefined){this.fence(current);this.prune();if(this.previews.size+this.raw.size>=4)throw new SetupError('busy');
  if(!selection||typeof selection!=='object'||Array.isArray(selection)||!['default','clear'].includes(selection.kind)||Object.keys(selection).length!==1)throw new SetupError('invalid');
  const before=this.state.capture();this.owner(before);const gate={token:before};const stable=():undefined=>{this.fence();this.state.assertCurrent(gate.token);return undefined;};let input:NativeReadDiscoveryInput|undefined,candidate:SavedHistorySourceCandidate|undefined,transferred=false;
  try{if(selection.kind!=='clear'){const home=realpathSync(this.options.testing?.defaultHome??join(homedir(),'.codex'));
   if(readLocalStateFile(join(this.options.stateDir,'collaboration-control-runtime.json'),16384)){input=captureNativeReadDiscoveryInput({stateDir:this.options.stateDir,endpointId:this.options.endpointId,codexHome:home,current:stable,testing:this.options.testing?.source});candidate=await discoverSavedHistorySource(input,{current:()=>this.fence(current)});}else{candidate=discoverDefaultStdioSavedHistorySource({codexHome:home,current:stable,testing:this.options.testing?.source});}this.fence(current);stable();currentSavedHistorySourceCandidate(candidate);this.options.testing?.afterCandidateCapture?.();}
   this.fence(current);stable();const id=randomUUID(),hash=digest({id,kind:selection.kind,candidate:candidate?.candidate_id??null,revision:before.revision});const p:Preview={id,hash,expires:this.now()+30000,claimed:false,before,gate,input,candidate};this.previews.set(id,p);transferred=true;return Object.freeze({preview_id:id,selection_hash:hash,source:Object.freeze({state:selection.kind==='clear'?'clear' as const:'selected' as const,profile:selection.kind==='clear'?null:'default' as const}),resetsReadGrant:true as const,confirmation_binding:candidate?savedHistorySourceConfirmationBinding(candidate):null,source_label:candidate?nativeSavedHistorySourceSelection(candidate).codex_home:null});
  }catch(error){if(error instanceof SetupError)throw error;if(error instanceof ReadSourceError&&['source_not_running','ambiguous_source','unsupported'].includes(error.code))throw new SetupError(error.code as 'source_not_running'|'ambiguous_source'|'unsupported');throw new SetupError('unavailable');}finally{if(!transferred)this.release({candidate,input});}
 }
 async inspectDefault(current:()=>undefined=()=>undefined){const preview=await this.prepare({kind:'default'},current);const p=this.previews.get(preview.preview_id);if(!p)throw new SetupError('stale');this.previews.delete(preview.preview_id);try{this.fence(current);if(p.candidate)currentSavedHistorySourceCandidate(p.candidate);return {source:preview.source,source_label:preview.source_label,confirmation_binding:preview.confirmation_binding};}finally{this.release(p);}}
 apply(id:string,hash:string,current:()=>undefined=()=>undefined){const work=this.applyImpl(id,hash,current);this.raw.add(work);work.finally(()=>this.raw.delete(work)).catch(()=>{});return work;}
 private async applyImpl(id:string,hash:string,current:()=>undefined){this.fence(current);this.prune();const p=this.previews.get(id);if(!p||p.claimed||p.expires<=this.now()||p.hash!==hash)throw new SetupError('stale');p.claimed=true;this.previews.delete(id);let reservation:Awaited<ReturnType<SetupRuntime['reserveChange']>>|undefined;
  const check=():undefined=>{this.fence(current);if(p.expires<=this.now())throw new SetupError('stale');this.state.assertCurrent(p.gate.token);reservation?.assertCurrent();if(p.candidate)currentSavedHistorySourceCandidate(p.candidate);return this.fence(current);};
  try{reservation=await this.options.runtime.reserveChange();check();this.owner(p.before);
   // Only the exact receipt from this synchronous deletion can advance the gate.
   const after=this.state.write('collaboration-read.json',null,p.before,check);
   if(after.files['collaboration-read.json']!==null||!same(p.before,after,'collaboration-read.json')||this.owner(after)!==this.owner(p.before))throw new SetupError('stale');
   p.gate.token=after;check();this.options.testing?.beforeDescriptorWrite?.();check();
   const value=p.candidate?{version:1,endpoint_id:this.options.endpointId,source_id:randomUUID(),...nativeSavedHistorySourceSelection(p.candidate)}:null;
   if(value)parseReadSourceDescriptor(value,this.options.endpointId);
   this.state.write('collaboration-read-runtime.json',value?JSON.stringify(value)+'\n':null,after,check);
   if(this.cached){releaseReadSource(this.cached);this.cached=undefined;}
  }catch(error){if(error instanceof SetupError)throw error;if(error instanceof ReadSourceError&&['source_not_running','ambiguous_source','unsupported'].includes(error.code))throw new SetupError(error.code as 'source_not_running'|'ambiguous_source'|'unsupported');throw new SetupError('unavailable');}finally{try{this.release(p);}finally{reservation?.release();}}
  this.fence(current);return this.status();
 }
 get busy(){return this.raw.size;}
 close():Promise<void>{if(this.closingWork)return this.closingWork;this.closing=true;return this.closingWork=(async()=>{while(this.raw.size)await Promise.allSettled([...this.raw]);let failure:unknown;for(const p of this.previews.values())try{this.release(p);}catch(error){failure??=error;}this.previews.clear();try{if(this.cached){releaseReadSource(this.cached);this.cached=undefined;}}catch(error){failure??=error;}this.state.close();if(failure)throw failure;})();}
}
