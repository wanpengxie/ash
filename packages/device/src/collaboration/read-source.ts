import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync,type BigIntStats} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {JsonProcess,type Command} from '../agents/process';
import {readLocalStateFile} from './local-state';
import {captureReadSourceAccount,stableReadSourceRevision} from './read-source-account';
import {captureReadRealm,currentReadRealm,readRealmOverride,releaseReadRealm,attestReadRealmProcess,type ProtectedReadRealm} from './read-source-realm';

export class ReadSourceError extends Error {
  constructor(readonly code:'source_required'|'source_not_running'|'ambiguous_source'|'invalid'|'unsupported'|'offline'|'stale'|'timeout'|'cancelled'|'draining'){super(`Saved history source: ${code}`);}
}
export interface ReadSourceDescriptor {
  readonly version:1;readonly endpoint_id:string;readonly source_id:string;
  readonly executable:string;readonly executable_sha256:string;readonly codex_home:string;readonly sqlite_home:string;
  readonly profile:'default';readonly supported_versions:readonly string[];
}
/** Issued internal source binding, never a grant, a wire command, or desktop runtime evidence. */
export interface ProtectedReadSource {readonly source_id:string;readonly source_revision:string;readonly version:string;}
export const VALIDATED_READ_SOURCE_VERSION='0.162.0-alpha.17.2';
export const VALIDATED_READ_SOURCE_SHA256='0d5ac7aae20c4eda6242428d5e218c55ba96d8763fda2a271088ff37104b9d28';
type SourceBinding={current():undefined;release():undefined;command:Command;cwd:string;realm:ProtectedReadRealm;children:Set<JsonProcess>;closing:boolean};
type ProcessBinding={source:ProtectedReadSource;state:'running'|'draining'|'closed';drained:Promise<void>;closeStart?:Promise<void>;beginClose():Promise<void>;settle():void;};
const issued=new WeakMap<object,SourceBinding>();
const processes=new WeakMap<JsonProcess,ProcessBinding>();
const fileIdentity=(s:BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':');
const directoryIdentity=(s:BigIntStats)=>[s.dev,s.ino].join(':');
const id=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=128&&!/[\u0000-\u001f]/.test(v);
const path=(v:unknown):v is string=>typeof v==='string'&&v.length<=4096&&isAbsolute(v)&&resolve(v)===v&&!/[\u0000-\u001f]/.test(v);
const version=(v:unknown):v is string=>typeof v==='string'&&/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(v);
export const readSourcePath=(stateDir:string)=>join(stateDir,'collaboration-read-runtime.json');
export function parseReadSourceDescriptor(value:unknown,endpointId:string):ReadSourceDescriptor {
  if(value&&typeof value==='object'&&!Array.isArray(value)&&!Object.hasOwn(value,'sqlite_home'))throw new ReadSourceError('source_required');
  const keys=['version','endpoint_id','source_id','executable','executable_sha256','codex_home','sqlite_home','profile','supported_versions'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(k=>!keys.includes(k)))throw new ReadSourceError('invalid');
  const v=value as ReadSourceDescriptor;
  if(v.version!==1||v.endpoint_id!==endpointId||!id(v.endpoint_id)||!id(v.source_id)||!path(v.executable)||!path(v.codex_home)||!path(v.sqlite_home)||typeof v.executable_sha256!=='string'||!/^[a-f0-9]{64}$/.test(v.executable_sha256)||!Array.isArray(v.supported_versions)||v.supported_versions.length<1||v.supported_versions.length>32||!v.supported_versions.every(version)||new Set(v.supported_versions).size!==v.supported_versions.length)throw new ReadSourceError('invalid');
  // Named profiles need a separately verified native chooser/config contract.
  if(v.profile!=='default')throw new ReadSourceError('unsupported');
  return Object.freeze({...v,supported_versions:Object.freeze([...v.supported_versions])});
}
function directory(s:BigIntStats,privateState=false){if(!s.isDirectory()||s.uid!==BigInt(process.getuid?.()??-1)||(s.mode&0o022n)!==0n||privateState&&(s.mode&0o777n)!==0o700n)throw new ReadSourceError('offline');}
function regular(s:BigIntStats,configuration=false){if(!s.isFile()||s.nlink!==1n||(s.mode&0o022n)!==0n||configuration&&(s.uid!==BigInt(process.getuid?.()??-1)||(s.mode&0o777n)!==0o600n))throw new ReadSourceError('offline');}
/** Resolve only an already-selected protected source. No PATH search, profile
 * discovery, home creation, credential copying, or control socket fallback. */
export function captureProtectedReadSource(options:{stateDir:string;endpointId:string;current?:()=>undefined;testing?:{accountIdentity?:{account_id:string;subject:string};command?:Command;home?:string;realmVersion?:string;artifact?:{sha256:string;version:string}}}):ProtectedReadSource {
  const fds:number[]=[];let transferred=false;let realm:ProtectedReadRealm|undefined;let account:ReturnType<typeof captureReadSourceAccount>|undefined;
  try {
    if(!['darwin','linux'].includes(process.platform))throw new ReadSourceError('unsupported');
    const state=realpathSync(options.stateDir);if(lstatSync(options.stateDir).isSymbolicLink())throw new ReadSourceError('offline');
    const open=(p:string)=>{const fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);fds.push(fd);return fd;};
    const stateFD=open(state),stateStat=fstatSync(stateFD,{bigint:true});directory(stateStat,true);
    const configuration=readSourcePath(state);let metadata;
    try{metadata=readLocalStateFile(configuration,16384);}catch{throw new ReadSourceError('offline');}
    if(!metadata)throw new ReadSourceError('source_required');
    const configurationFD=open(configuration),configurationStat=fstatSync(configurationFD,{bigint:true});regular(configurationStat,true);
    if(metadata.identity.split(':').slice(0,-1).join(':')!==fileIdentity(configurationStat))throw new ReadSourceError('stale');
    const descriptor=parseReadSourceDescriptor(JSON.parse(metadata.raw),options.endpointId);
    if(realpathSync(descriptor.executable)!==descriptor.executable||realpathSync(descriptor.codex_home)!==descriptor.codex_home)throw new ReadSourceError('invalid');
    const executableFD=open(descriptor.executable),executableStat=fstatSync(executableFD,{bigint:true});regular(executableStat);
    if((executableStat.mode&0o111n)===0n||executableStat.size<1n||executableStat.size>512n*1024n*1024n)throw new ReadSourceError('offline');
    const homeFD=open(descriptor.codex_home),homeStat=fstatSync(homeFD,{bigint:true});directory(homeStat);
    // Opaque default configuration continuity, not credential parsing. This
    // digest does NOT itself attest a configured external sqlite_home/history root.
    // The separately retained realm below binds the explicitly selected existing
    // SQLite root and factory child FD. It does not infer the original user realm
    // from HOME; native selection/attestation must supply that root unchanged.
    const profileConfiguration=join(descriptor.codex_home,'config.toml');
    const profileIdentity=readLocalStateFile(profileConfiguration,1024*1024)?.identity;
    const profileFD=profileIdentity?open(profileConfiguration):undefined;
    const profileStat=profileFD===undefined?undefined:fstatSync(profileFD,{bigint:true});
    if(profileStat){regular(profileStat);if(profileStat.uid!==BigInt(process.getuid?.()??-1))throw new ReadSourceError('offline');if(profileIdentity!.split(':').slice(0,-1).join(':')!==fileIdentity(profileStat))throw new ReadSourceError('stale');}
    account=captureReadSourceAccount(descriptor.codex_home,options.testing?.accountIdentity);
    let released=false,stale=false,releaseError:ReadSourceError|undefined;
    const current=():undefined=>{
      try {
        if(released||stale||options.current&&options.current()!==undefined)throw new ReadSourceError('stale');
        if(realpathSync(state)!==state||realpathSync(descriptor.codex_home)!==descriptor.codex_home||realpathSync(descriptor.executable)!==descriptor.executable)throw new ReadSourceError('stale');
        const pairs:[[number,string,BigIntStats,'state'|'home'|'config'|'exe'],...Array<[number,string,BigIntStats,'state'|'home'|'config'|'exe']>]=[[stateFD,state,stateStat,'state'],[homeFD,descriptor.codex_home,homeStat,'home'],[configurationFD,configuration,configurationStat,'config'],[executableFD,descriptor.executable,executableStat,'exe']];
        for(const[fd,p,before,kind]of pairs){const held=fstatSync(fd,{bigint:true}),now=lstatSync(p,{bigint:true});if(now.isSymbolicLink())throw new ReadSourceError('stale');if(kind==='state'||kind==='home'){directory(held,kind==='state');directory(now,kind==='state');if(directoryIdentity(held)!==directoryIdentity(before)||directoryIdentity(now)!==directoryIdentity(before))throw new ReadSourceError('stale');}else{regular(held,kind==='config');regular(now,kind==='config');if(fileIdentity(held)!==fileIdentity(before)||fileIdentity(now)!==fileIdentity(before))throw new ReadSourceError('stale');}}
        if(profileFD!==undefined&&profileStat){const held=fstatSync(profileFD,{bigint:true}),now=lstatSync(profileConfiguration,{bigint:true});regular(held);regular(now);if(held.uid!==BigInt(process.getuid?.()??-1)||now.uid!==held.uid||fileIdentity(held)!==fileIdentity(profileStat)||fileIdentity(now)!==fileIdentity(profileStat))throw new ReadSourceError('stale');}
        else{try{lstatSync(profileConfiguration);throw new ReadSourceError('stale');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
        account?.current();if(realm)currentReadRealm(realm);
        return undefined;
      }catch{stale=true;throw new ReadSourceError('stale');}
    };
    current();const hash=createHash('sha256'),buffer=Buffer.alloc(64*1024);let offset=0,count:number;
    while((count=readSync(executableFD,buffer,0,buffer.length,offset))>0){offset+=count;if(BigInt(offset)>executableStat.size)throw new ReadSourceError('stale');hash.update(buffer.subarray(0,count));}
    const observedHash=hash.digest('hex');
    if(BigInt(offset)!==executableStat.size||observedHash!==descriptor.executable_sha256)throw new ReadSourceError('unsupported');
    // A selected descriptor cannot declare an arbitrary same-version binary to
    // be compatible. HOME isolation/realm testing do not waive artifact identity.
    const expectedArtifact=options.testing?.artifact??{sha256:VALIDATED_READ_SOURCE_SHA256,version:VALIDATED_READ_SOURCE_VERSION};
    if(observedHash!==expectedArtifact.sha256)throw new ReadSourceError('unsupported');current();
    const env:NodeJS.ProcessEnv=Object.freeze({HOME:options.testing?.home??homedir(),CODEX_HOME:descriptor.codex_home,PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'});
    const observedVersion=execFileSync(descriptor.executable,['--version'],{env:env as NodeJS.ProcessEnv,encoding:'utf8',timeout:5000,maxBuffer:4096}).match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];current();
    if(!observedVersion||observedVersion!==expectedArtifact.version||!descriptor.supported_versions.includes(observedVersion))throw new ReadSourceError('unsupported');
    realm=captureReadRealm({root:descriptor.sqlite_home,version:observedVersion,current:options.current,testing:options.testing?.realmVersion?{version:options.testing.realmVersion}:undefined});current();
    const command=options.testing?.command?Object.freeze({command:options.testing.command.command,args:Object.freeze([...options.testing.command.args]) as unknown as string[],env:Object.freeze({...options.testing.command.env})}):Object.freeze({command:descriptor.executable,args:Object.freeze(['-c',readRealmOverride(realm),'app-server','--stdio']) as unknown as string[],env:env as NodeJS.ProcessEnv});
    const proof=Object.freeze({source_id:descriptor.source_id,source_revision:stableReadSourceRevision(descriptor,account.revision),version:observedVersion});
    const children=new Set<JsonProcess>();
    issued.set(proof,{current,command,realm,children,closing:false,cwd:descriptor.codex_home,release:()=>{if(children.size){issued.get(proof)!.closing=true;throw new ReadSourceError('draining');}if(!released){released=true;let failed=false;try{releaseReadRealm(realm!);}catch{failed=true;}try{account!.release();}catch{failed=true;}for(const fd of fds)try{closeSync(fd);}catch{failed=true;}if(failed)releaseError=new ReadSourceError('offline');}if(releaseError)throw releaseError;return undefined;}});transferred=true;return proof;
  }catch(error){if(error instanceof ReadSourceError)throw error;throw new ReadSourceError('offline');}
  finally{if(!transferred){try{account?.release();}catch{}if(realm)try{releaseReadRealm(realm);}catch{}for(const fd of fds)try{closeSync(fd);}catch{}}}
}
export function currentReadSource(proof:ProtectedReadSource):undefined {const value=issued.get(proof);if(!value)throw new ReadSourceError('invalid');return value.current();}
/** Caller owns exact child/group shutdown and raw drain before releasing proof. */
export async function startReadSourceProcess(proof:ProtectedReadSource):Promise<JsonProcess> {const value=issued.get(proof);if(!value)throw new ReadSourceError('invalid');if(value.closing)throw new ReadSourceError('offline');value.current();const process=new JsonProcess(value.command,value.cwd);trackReadSourceProcess(proof,process,value);try{value.current();return process;}catch(error){await closeReadSourceProcess(proof,process);throw error;}}
export function releaseReadSource(proof:ProtectedReadSource):undefined {const value=issued.get(proof);if(!value)throw new ReadSourceError('invalid');return value.release();}

/** Exact factory child only; a caller cannot attest a supplied PID/process. */
export function attestReadSourceProcess(proof:ProtectedReadSource,process:JsonProcess):undefined{const value=issued.get(proof);if(!value||processes.get(process)?.source!==proof)throw new ReadSourceError('invalid');return attestReadRealmProcess(value.realm,process.child,value.current);}

function ownedProcess(proof:ProtectedReadSource,process:JsonProcess):ProcessBinding{const state=processes.get(process);if(!issued.has(proof)||state?.source!==proof)throw new ReadSourceError('invalid');return state;}
function groupAlive(process:JsonProcess):boolean{try{if(!process.child.pid)return false;globalThis.process.kill(globalThis.process.platform==='win32'?process.child.pid:-process.child.pid,0);return true;}catch(error){return(error as NodeJS.ErrnoException).code!=='ESRCH';}}
function trackReadSourceProcess(proof:ProtectedReadSource,process:JsonProcess,value:SourceBinding):void{
  let childClosed=false,genericClosed=false,poll:ReturnType<typeof setTimeout>|undefined,resolveDrain!:()=>void;
  const state:ProcessBinding={source:proof,state:'running',drained:new Promise(resolve=>{resolveDrain=resolve;}),beginClose:()=>{if(state.state!=='closed')state.state='draining';return state.closeStart??=process.close().then(()=>{genericClosed=true;state.settle();});},settle:()=>{
    if(state.state==='closed')return;
    const rawClosed=childClosed&&process.child.stdin.closed&&process.child.stdout.closed&&process.child.stderr.closed;
    if(genericClosed&&rawClosed&&!groupAlive(process)){clearTimeout(poll);state.state='closed';value.children.delete(process);resolveDrain();}
    else if(genericClosed&&!poll){poll=setTimeout(()=>{poll=undefined;state.settle();},10);poll.unref();}
  }};
  processes.set(process,state);value.children.add(process);
  process.child.once('close',()=>{childClosed=true;if(state.state!=='closed')state.state='draining';state.settle();});
  for(const pipe of[process.child.stdin,process.child.stdout,process.child.stderr])pipe.once('close',state.settle);
  // Exact process remains retained until actual raw close and group disappearance.
}
/** Exact factory process only. This is an observation, not fake closure of pipes. */
export function readSourceProcessDrainState(proof:ProtectedReadSource,process:JsonProcess):'running'|'draining'|'closed'{const state=ownedProcess(proof,process);state.settle();return state.state;}
/** Actual settlement can outlive a bounded close observation. Callers must retain
 * their slot/proof until this promise settles; source release refuses pending children. */
export function readSourceProcessDrained(proof:ProtectedReadSource,process:JsonProcess):Promise<void>{return ownedProcess(proof,process).drained;}
/** Generic group termination plus source-specific child/owned-pipe raw drain.
 * Pending raw data is not destroyed or labelled closed to pass a deadline. */
export async function closeReadSourceProcess(proof:ProtectedReadSource,process:JsonProcess):Promise<void>{
  const state=ownedProcess(proof,process);if(state.state==='closed')return;
  state.state='draining';
  try{await state.beginClose();}catch{throw new ReadSourceError('draining');}
  state.settle();let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([state.drained,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ReadSourceError('draining')),1000);})]);}
  finally{clearTimeout(timer);}
}

/** Retain the source while actual process/pipe draining is pending. This closes
 * admission for new child factories and does not convert a timeout into closure. */
export async function readSourceDrained(proof:ProtectedReadSource):Promise<void>{const value=issued.get(proof);if(!value)throw new ReadSourceError('invalid');value.closing=true;const children=[...value.children];for(const child of children)void ownedProcess(proof,child).beginClose().catch(()=>{});await Promise.all(children.map(child=>readSourceProcessDrained(proof,child)));}
