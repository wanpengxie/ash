import {realpathSync,statSync,lstatSync} from 'node:fs';import {join} from 'node:path';import {readLocalStateFile} from '../collaboration/local-state';
import {currentSetupConnectionProof,type SetupConnectionProof} from '../link';
import {setupVerificationReadBinding,currentSetupVerificationProof,currentSetupVerificationSourceProof,releaseSetupVerificationProof,type SetupVerificationProof} from './native-verification';
import type {ScopeSelection,SetupVerification} from './service';
import type {DiagnosticEvidence} from './diagnostics';
import {SetupError,type ScopeSnapshot} from './scope-settings';

export interface ShellStatusObservation {readonly evidence:DiagnosticEvidence;readonly readGrantState?:ScopeSnapshot['readState'];current():undefined;release():undefined;}
/** Read-only online diagnostics. Grants, login and successful business execution are distinct. */
export class SetupShellStatus {
 constructor(private readonly options:{stateDir:string;connection():SetupConnectionProof;verification:SetupVerification;current():undefined;now?:()=>number}){}
 /** Retry guard contains identities only; it never revalidates or revives a discarded lease. */
 boundary(snapshot:ScopeSnapshot):()=>undefined{
  const file=join(this.options.stateDir,'collaboration-control-runtime.json');
  const source=()=>{const value=readLocalStateFile(file,16384);if(!value)return JSON.stringify(['missing',readLocalStateFile(join(this.options.stateDir,'collaboration-read-runtime.json'),16384)?.identity??null]);const raw=JSON.parse(value.raw),socket=realpathSync(raw.socket),stat=statSync(socket,{bigint:true});return JSON.stringify([readLocalStateFile(join(this.options.stateDir,'collaboration-read-runtime.json'),16384)?.identity??null,value.identity,socket,String(stat.dev),String(stat.ino),String(stat.ctimeNs),stat.isSocket()]);};
  const paths=new Set(snapshot.read?.allowedCwds??[]);if(snapshot.control?.scope.kind==='exact_cwd')paths.add(snapshot.control.scope.cwd);
  const directories=()=>JSON.stringify([...paths].map(path=>{const canonical=realpathSync(path),stat=lstatSync(canonical,{bigint:true});return [path,canonical,String(stat.dev),String(stat.ino),String(stat.ctimeNs),stat.isDirectory()];}));
  let original:string|undefined,dirs:string|undefined;try{original=source();dirs=directories();}catch{/* An unprovable source is ineligible for transparent retry. */}
  let connection:SetupConnectionProof|undefined;try{connection=this.options.connection();}catch{}
  return ()=>{if(this.options.current()!==undefined||original===undefined||dirs===undefined||source()!==original||directories()!==dirs)throw Error('Setup source changed during diagnostics');if(connection)currentSetupConnectionProof(connection);else {let connected=false;try{this.options.connection();connected=true;}catch{}if(connected)throw Error('Setup connection changed during diagnostics');}return undefined;};
 }
 async capture(snapshot:ScopeSnapshot,current:()=>undefined):Promise<ShellStatusObservation>{
  const fence=():undefined=>{if(this.options.current()!==undefined||current()!==undefined)throw Error('Setup status is unavailable');return undefined;};fence();
  let connection:SetupConnectionProof|undefined;try{connection=this.options.connection();currentSetupConnectionProof(connection);}catch{/* Paired offline is an ordinary diagnostic state. */}
  const c=snapshot.control,active=!!c&&(c.expires_at===undefined||c.expires_at>(this.options.now??Date.now)());
  const controlSelection:ScopeSelection=active?{kind:'control',allowedActions:[...c!.allowed_actions],scope:structuredClone(c!.scope),...(c!.expires_at===undefined?{}:{expiresAt:c!.expires_at})}:{kind:'control',allowedActions:[],scope:{kind:'exact_cwd',cwd:this.options.stateDir}};
  const readSelection:ScopeSelection={kind:'read',allowedCwds:snapshot.read?.version===3?[...snapshot.read.allowedCwds]:[]};
  let controlProof:SetupVerificationProof|undefined,readProof:SetupVerificationProof|undefined;
  try{if(this.options.verification.captureScope)controlProof=await this.options.verification.captureScope(controlSelection,fence);}catch{fence();if(connection)currentSetupConnectionProof(connection);}
  try{if(this.options.verification.captureScope)readProof=await this.options.verification.captureScope(readSelection,fence);}catch{fence();if(connection)currentSetupConnectionProof(connection);}
  let released=false;
  const expiry=():undefined=>{if(active&&c!.expires_at!==undefined&&c!.expires_at<=(this.options.now??Date.now)())throw new SetupError('stale');return undefined;};
  const check=():undefined=>{expiry();if(released)throw Error('Setup status was released');fence();for(const[p,s]of [[controlProof,controlSelection],[readProof,readSelection]]as const)if(p){currentSetupVerificationProof(p,s,true);currentSetupVerificationSourceProof(p,s);}if(connection)currentSetupConnectionProof(connection);expiry();return fence();};
  const release=():undefined=>{if(!released){released=true;try{if(controlProof)releaseSetupVerificationProof(controlProof);}finally{if(readProof)releaseSetupVerificationProof(readProof);}}return undefined;};
  try{check();let readReady=false;if(readProof&&snapshot.read?.version===3){const binding=setupVerificationReadBinding(readProof,readSelection);readReady=snapshot.read.source_id===binding.source_id&&snapshot.read.binding_revision===binding.binding_revision;}
   const readGrantState=snapshot.readState==='missing'?'missing' as const:readReady?'configured' as const:'invalid' as const;
   return Object.freeze({readGrantState,evidence:Object.freeze({installation:'verified',gateway:connection?'verified':'unavailable',client:controlProof||readProof?'verified':'unavailable',version:controlProof||readProof?'verified':'unavailable',socket:controlProof?'verified':'unavailable',source:readProof?'verified':'unavailable',readCapability:!readProof?(snapshot.readState==='missing'?'missing':'unavailable'):readReady?'verified':snapshot.readState==='missing'?'missing':'unavailable',controlCapability:!active?'missing':controlProof?'verified':'unavailable',login:'unknown'} as DiagnosticEvidence),current:check,release});}catch(error){release();throw error;}
 }
}
