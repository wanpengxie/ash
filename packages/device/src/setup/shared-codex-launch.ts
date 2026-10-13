import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {closeSync,constants,fsyncSync,linkSync,lstatSync,mkdirSync,openSync,realpathSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {readLocalStateFile} from '../collaboration/local-state';

export const SHARED_CODEX_APP='/Applications/ChatGPT.app';
export const SHARED_CODEX_CLI=SHARED_CODEX_APP+'/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
export const SHARED_CODEX_VERSION='0.162.0-alpha.17.2';
type FileState={identity:string;kind:'file'|'directory'|'socket'|'other'};
type CommandResult={exitCode:number;stdout:string};
/** Explicit test port only; production paths and commands are fixed below. */
export interface SharedCodexLaunchTestBackend {
 platform:string;homeDir:string;
 file(path:string):FileState|null;
 read(path:string):string|null;
 prepareSettings?():string;
 run(command:string,args:readonly string[],env:Readonly<Record<string,string>>):Promise<CommandResult>;
}
/** Fixed ps output only: discard unrelated complete lines as they arrive.
 * A bounded line/match buffer cannot turn failure or truncated output into a
 * closed-desktop result. No process list is retained or returned. */
export function createSharedCodexDesktopScan(){
 let pending=Buffer.alloc(0),failed=false;const matches:string[]=[];
 return {
  write(chunk:Buffer){
   if(failed)return;
   let offset=0;
   while(offset<chunk.length){
    const newline=chunk.indexOf(10,offset),end=newline<0?chunk.length:newline,size=end-offset;
    if(pending.length+size>4096){failed=true;pending=Buffer.alloc(0);return;}
    if(size)pending=Buffer.concat([pending,chunk.subarray(offset,end)],pending.length+size);
    if(newline<0)return;
    const line=pending.toString('utf8').trim();pending=Buffer.alloc(0);
    if(line){const match=line.match(/^(\d+)\s+(.+)$/);if(!match){failed=true;return;}if(match[2]===SHARED_CODEX_APP+'/Contents/MacOS/ChatGPT'){if(matches.length>=8){failed=true;return;}matches.push(line);}}
    offset=newline+1;
   }
  },
  finish(complete:boolean):CommandResult{return complete&&!failed&&pending.length===0?{exitCode:0,stdout:matches.length?matches.join('\n')+'\n':''}:{exitCode:-1,stdout:''};},
 };
}
const production:SharedCodexLaunchTestBackend={platform:process.platform,homeDir:homedir(),file(path){try{if(path.endsWith('/settings.json')){const value=readLocalStateFile(path,16384);return value?{identity:value.identity,kind:'file'}:null;}const stat=path.endsWith('/app-server-control.sock')?statSync(path,{bigint:true}):lstatSync(path,{bigint:true});return {identity:`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,kind:stat.isFile()?'file':stat.isDirectory()?'directory':stat.isSocket()?'socket':'other'};}catch(error){return (error as NodeJS.ErrnoException).code==='ENOENT'?null:{identity:'unavailable',kind:'other'};}},read(path){try{return readLocalStateFile(path,16384)?.raw??null;}catch{return null;}},
 prepareSettings(){return prepareMissingSharedCodexSettings(this.homeDir);},
 run(command,args,env){return new Promise(resolve=>{
  let stdout='',bytes=0,failed=false,ended=false;
  const scan=command==='/bin/ps'&&args.length===2&&args[0]==='-axo'&&args[1]==='pid=,comm='?createSharedCodexDesktopScan():null;
  const child=spawn(command,[...args],{env:{...env},stdio:['ignore','pipe','ignore'],timeout:15000});
  child.stdout.on('data',chunk=>{if(scan){scan.write(chunk);return;}bytes+=chunk.length;if(bytes<=65536)stdout+=chunk.toString();else failed=true;});
  child.stdout.once('end',()=>{ended=true;});child.stdout.once('error',()=>{failed=true;});child.once('error',()=>{failed=true;});
  child.once('close',code=>resolve(scan?scan.finish(ended&&!failed&&code===0):{exitCode:failed?-1:code??-1,stdout:failed?'':stdout}));
 });}};
export interface SharedCodexLaunchPlan {
 readonly kind:'shared-codex-launch-plan';
 readonly desktop:'running'|'closed'|'unknown';
 readonly daemon:'running'|'offline'|'unknown';
 readonly socket:'present'|'missing';
 readonly policy:'missing'|'disabled'|'unknown';
 readonly version:string|null;
 readonly blockers:readonly string[];
 readonly paths:Readonly<{app:string;cli:string;codexHome:string;socket:string;url:string}>;
}
const DEFAULT_SHARED_SETTINGS = JSON.stringify({remoteControlEnabled:false,updater:{autoUpdateEnabled:false}},null,2)+'\n';
/** Only the absent fixed settings file is initialized. Existing policy is never
 * changed. No daemon, updater or service-manager command runs here. */
export function prepareMissingSharedCodexSettings(homeDir:string):string {
 const directory=(path:string)=>{
  const stat=lstatSync(path,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==path||stat.uid!==BigInt(process.getuid?.()??-1)||(stat.mode&0o022n)!==0n)throw Error('Unsafe daemon settings directory');
  return `${stat.dev}:${stat.ino}`;
 };
 directory(homeDir);
 const dirs=[homeDir,join(homeDir,'.codex'),join(homeDir,'.codex','app-server-daemon')];
 for(const path of dirs.slice(1)){try{mkdirSync(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}directory(path);}
 const identities=dirs.map(directory),path=join(dirs[2],'settings.json');
 // Publish a complete, synced ordinary file without replacing a concurrent
 // settings file/link. Failed writes leave only our removable temporary file.
 const temporary=join(dirs[2],`.ash-shared-settings-${randomUUID()}.tmp`);
 let created=false;
 try{
  const fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);created=true;
  try{writeFileSync(fd,DEFAULT_SHARED_SETTINGS);fsyncSync(fd);}finally{closeSync(fd);}
  if(dirs.some((dir,index)=>directory(dir)!==identities[index])||readLocalStateFile(temporary,16384)?.raw!==DEFAULT_SHARED_SETTINGS)throw Error('Daemon settings changed during preparation');
  linkSync(temporary,path);
 }finally{if(created)unlinkSync(temporary);}
 const file=readLocalStateFile(path,16384);
 if(dirs.some((dir,index)=>directory(dir)!==identities[index])||file?.raw!==DEFAULT_SHARED_SETTINGS)throw Error('Daemon settings changed during preparation');
 return file.identity;
}
function compatiblePolicy(raw:string|null):boolean {
 try{
  const value=raw===null?null:JSON.parse(raw);
  const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  if(!object(value)||Object.keys(value).some(key=>!['remoteControlEnabled','updater','shutdownGraceSeconds'].includes(key))||value.remoteControlEnabled!==false||!object(value.updater)||Object.keys(value.updater).some(key=>!['autoUpdateEnabled','updateIntervalMinutes'].includes(key))||value.updater.autoUpdateEnabled!==false)return false;
  if(value.shutdownGraceSeconds!==undefined&&(!Number.isSafeInteger(value.shutdownGraceSeconds)||value.shutdownGraceSeconds<0||value.shutdownGraceSeconds>300))return false;
  if(value.updater.updateIntervalMinutes!==undefined&&(!Number.isSafeInteger(value.updater.updateIntervalMinutes)||value.updater.updateIntervalMinutes<1||value.updater.updateIntervalMinutes>0xffffffff))return false;
  return true;
 }catch{return false;}
}
const plans=new WeakMap<object,{backend:SharedCodexLaunchTestBackend;appIdentity:string|null;cliIdentity:string|null;settingsIdentity:string|null;expires:number;claimed:boolean}>();
function paths(backend:SharedCodexLaunchTestBackend){const codexHome=join(backend.homeDir,'.codex'),socket=join(codexHome,'app-server-control/app-server-control.sock');return {app:SHARED_CODEX_APP,cli:SHARED_CODEX_CLI,codexHome,socket,url:`ws+unix://localhost${socket}:/rpc`};}
function environment(backend:SharedCodexLaunchTestBackend){return {HOME:backend.homeDir,CODEX_HOME:join(backend.homeDir,'.codex'),PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C'};}
async function desktop(backend:SharedCodexLaunchTestBackend):Promise<SharedCodexLaunchPlan['desktop']>{const result=await backend.run('/bin/ps',['-axo','pid=,comm='],environment(backend));if(result.exitCode!==0)return 'unknown';for(const line of result.stdout.split('\n')){const match=line.trim().match(/^(\d+)\s+(.+)$/);if(match&&match[2]===SHARED_CODEX_APP+'/Contents/MacOS/ChatGPT')return 'running';}return 'closed';}
async function snapshot(backend:SharedCodexLaunchTestBackend){
 const p=paths(backend),app=backend.file(p.app),cli=backend.file(p.cli),settingsPath=join(p.codexHome,'app-server-daemon/settings.json'),settings=backend.file(settingsPath),raw=backend.read(settingsPath);
 const policy:SharedCodexLaunchPlan['policy']=settings===null&&raw===null?'missing':settings?.kind==='file'&&compatiblePolicy(raw)?'disabled':'unknown';
 let version:string|null=null,daemon:SharedCodexLaunchPlan['daemon']='unknown',desktopState:SharedCodexLaunchPlan['desktop']='unknown';
 const blockers:string[]=[];if(backend.platform!=='darwin')blockers.push('unsupported_platform');if(app?.kind!=='directory'||cli?.kind!=='file')blockers.push('fixed_bundle_missing');
 if(!blockers.length){const v=await backend.run(p.cli,['--version'],environment(backend));version=v.exitCode===0?v.stdout.match(/\bcodex-cli (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/)?.[1]??null:null;if(version!==SHARED_CODEX_VERSION)blockers.push('unsupported_version');desktopState=await desktop(backend);
  const result=await backend.run(p.cli,['app-server','daemon','version'],environment(backend));if(result.exitCode!==0)daemon=backend.file(p.socket)?.kind==='socket'?'unknown':'offline';else try{const value=JSON.parse(result.stdout);daemon=value?.appServerVersion===SHARED_CODEX_VERSION?'running':'unknown';}catch{}
 }
 const socket=backend.file(p.socket)?.kind==='socket'?'present' as const:'missing' as const;
 if(policy==='missing')blockers.push('daemon_policy_missing');else if(policy!=='disabled')blockers.push('daemon_policy_not_disabled');if(desktopState==='running')blockers.push('desktop_must_be_closed');if(desktopState==='unknown')blockers.push('desktop_state_unknown');if(daemon==='unknown')blockers.push('daemon_state_unknown');if(daemon==='running'&&socket==='missing')blockers.push('daemon_socket_missing');
 return {view:{kind:'shared-codex-launch-plan' as const,desktop:desktopState,daemon,socket,policy,version,blockers,paths:p},appIdentity:app?.identity??null,cliIdentity:cli?.identity??null,settingsIdentity:settings?.identity??null};
}
/** Read-only plan. It never starts, quits, stops, configures or updates anything. */
export async function planSharedCodexLaunch(options:{testing?:SharedCodexLaunchTestBackend}={}):Promise<SharedCodexLaunchPlan>{const backend=options.testing??production,value=await snapshot(backend),plan=Object.freeze({...value.view,blockers:Object.freeze(value.view.blockers),paths:Object.freeze(value.view.paths)});plans.set(plan,{backend,appIdentity:value.appIdentity,cliIdentity:value.cliIdentity,settingsIdentity:value.settingsIdentity,expires:Date.now()+300000,claimed:false});return plan;}
export type SharedCodexLaunchResult={state:'launched';attachment:'attachment_unverified';mode:'shared'|'normal';reason?:string}|{state:'blocked';code:string};
/** Approval is required at this call. An active desktop is never automatically
 * exited. A daemon is never stopped during failure recovery. */
export async function startSharedCodexLaunch(plan:SharedCodexLaunchPlan,authorization:{approved:boolean;prepareMissingSettings?:boolean}):Promise<SharedCodexLaunchResult>{
 if(authorization?.approved!==true)return {state:'blocked',code:'approval_required'};
 const receipt=plans.get(plan);if(!receipt||receipt.claimed||receipt.expires<=Date.now())return {state:'blocked',code:'stale_plan'};receipt.claimed=true;
 const {backend}=receipt;let fresh=await snapshot(backend),settingsIdentity=receipt.settingsIdentity;if(fresh.appIdentity!==receipt.appIdentity||fresh.cliIdentity!==receipt.cliIdentity||fresh.settingsIdentity!==receipt.settingsIdentity)return {state:'blocked',code:'changed_plan'};
 const blockers=fresh.view.blockers.filter(code=>code!=='daemon_policy_missing');
 if(blockers.length)return {state:'blocked',code:blockers[0]};
 if(fresh.view.policy==='missing'){
  if(authorization.prepareMissingSettings!==true)return {state:'blocked',code:'settings_preparation_required'};
  if(!backend.prepareSettings)return {state:'blocked',code:'settings_preparation_unavailable'};
  // Recheck the live desktop immediately before the only settings write.
  if(await desktop(backend)!=='closed')return {state:'blocked',code:'desktop_must_be_closed'};
  let preparedIdentity:string;try{preparedIdentity=backend.prepareSettings();}catch{return {state:'blocked',code:'settings_preparation_failed'};}
  fresh=await snapshot(backend);
  if(fresh.appIdentity!==receipt.appIdentity||fresh.cliIdentity!==receipt.cliIdentity)return {state:'blocked',code:'changed_plan'};
  if(fresh.view.policy!=='disabled'||fresh.settingsIdentity===null)return {state:'blocked',code:'settings_preparation_failed'};
  if(fresh.settingsIdentity!==preparedIdentity)return {state:'blocked',code:'changed_plan'};
  if(fresh.view.blockers.length)return {state:'blocked',code:fresh.view.blockers[0]};
  settingsIdentity=fresh.settingsIdentity;
 }
 const p=fresh.view.paths,env=environment(backend);
 const policyCurrent=()=>{try{const path=join(p.codexHome,'app-server-daemon/settings.json');return backend.file(path)?.identity===settingsIdentity&&compatiblePolicy(backend.read(path));}catch{return false;}};
 const fallback=async(reason:string):Promise<SharedCodexLaunchResult>=>{if(await desktop(backend)!=='closed')return {state:'blocked',code:'normal_reopen_requires_closed_desktop'};const opened=await backend.run('/usr/bin/open',['-a',p.app],env);return opened.exitCode===0?{state:'launched',attachment:'attachment_unverified',mode:'normal',reason}:{state:'blocked',code:'normal_reopen_failed'};};
 if(fresh.view.daemon!=='running'){
  if(await desktop(backend)!=='closed')return {state:'blocked',code:'desktop_must_be_closed'};
  if(!policyCurrent())return {state:'blocked',code:'changed_plan'};
  const started=await backend.run(p.cli,['app-server','daemon','start'],env);if(started.exitCode!==0)return fallback('daemon_start_failed');
 }
 // One bounded readiness observation. A launch cannot substitute for attachment
 // verification, and transient failure is not hidden with retries.
 const ready=await snapshot(backend);if(ready.view.desktop!=='closed')return {state:'blocked',code:'desktop_must_be_closed'};
 if(ready.appIdentity!==receipt.appIdentity||ready.cliIdentity!==receipt.cliIdentity||ready.settingsIdentity!==settingsIdentity)return {state:'blocked',code:'changed_plan'};
 if(ready.view.blockers.length||ready.view.daemon!=='running'||ready.view.socket!=='present')return fallback('daemon_not_ready');
 if(await desktop(backend)!=='closed')return {state:'blocked',code:'desktop_must_be_closed'};
 if(!policyCurrent())return {state:'blocked',code:'changed_plan'};
 const opened=await backend.run('/usr/bin/open',['-a',p.app,'--env',`CODEX_APP_SERVER_WS_URL=${p.url}`],env);if(opened.exitCode!==0)return fallback('shared_open_failed');
 return {state:'launched',attachment:'attachment_unverified',mode:'shared'};
}
