import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync,type BigIntStats} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import WebSocket from 'ws';
import {readLocalStateFile} from '../collaboration/local-state';
import {captureReadSourceAccount,stableReadSourceRevision} from '../collaboration/read-source-account';
import {controlRuntimePath,parseControlRuntimeConfig,discoverControlListener} from '../collaboration/control-runtime';
import type {ListenerEvidence} from '../collaboration/control-native-types';
import {ReadSourceError,VALIDATED_READ_SOURCE_SHA256,VALIDATED_READ_SOURCE_VERSION} from '../collaboration/read-source';
import {captureReadRealm,currentReadRealm,releaseReadRealm,type ProtectedReadRealm} from '../collaboration/read-source-realm';

/** Native producer only. Never construct these inputs from renderer paths, PID,
 * argv, environment, or self-reported owner evidence. The runtime file is fixed. */
export interface NativeReadDiscoveryInput {readonly kind:'native-read-discovery-input';}
/** Candidate owns its realm descriptors; keep its issuing input alive until the
 * candidate has been consumed/released. It grants no read/control authority. */
export interface SavedHistorySourceCandidate {readonly kind:'saved-history-source-candidate';readonly candidate_id:string;}
interface InputState {accountRevision:string;current():undefined;sourceCurrent():undefined;release():undefined;socket:string;executable:string;home:string;version:string;pid:number;}
interface CandidateState {accountRevision:string;current():undefined;release():undefined;descriptor:Readonly<{executable:string;executable_sha256:string;codex_home:string;sqlite_home:string;profile:'default';supported_versions:readonly string[]}>;}
const inputs=new WeakMap<object,InputState>(),candidates=new WeakMap<object,CandidateState>();
const fileID=(s:BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':');
const dirID=(s:BigIntStats)=>[s.dev,s.ino].join(':');
// A physical path snapshot; ctime is replacement evidence, not a kernel generation.
const socketID=(s:BigIntStats)=>[s.dev,s.ino,s.ctimeNs].join(':');
function safeFile(s:BigIntStats){if(!s.isFile()||s.nlink!==1n||(s.mode&0o022n)!==0n)throw new ReadSourceError('offline');}
function safeHome(s:BigIntStats){if(!s.isDirectory()||s.uid!==BigInt(process.getuid?.()??-1)||(s.mode&0o022n)!==0n)throw new ReadSourceError('offline');}
/** Trusted native chooser/default-home producer calls this after choosing HOME.
 * No new server is started. The selected already-running endpoint must own the
 * fixed tested executable. No control grant is consumed or created by metadata. */
export function captureNativeReadDiscoveryInput(options:{stateDir:string;endpointId:string;codexHome:string;current():undefined;testing?:{accountIdentity?:{account_id:string;subject:string}}}):NativeReadDiscoveryInput {
 const fds:number[]=[];let transferred=false;let account:ReturnType<typeof captureReadSourceAccount>|undefined;
 try{
  if(process.platform!=='darwin')throw new ReadSourceError('unsupported');
  if(options.current()!==undefined)throw new ReadSourceError('stale');
  const runtimePath=controlRuntimePath(options.stateDir),runtime=readLocalStateFile(runtimePath,16384);if(!runtime)throw new ReadSourceError('source_required');
  const config=parseControlRuntimeConfig(JSON.parse(runtime.raw),options.endpointId);
  const home=options.codexHome,executable=config.executable;
  if(!isAbsolute(home)||realpathSync(home)!==home||lstatSync(home).isSymbolicLink()||realpathSync(executable)!==executable)throw new ReadSourceError('invalid');
  const hold=(p:string)=>{const fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);fds.push(fd);return {fd,stat:fstatSync(fd,{bigint:true})};};
  const heldRuntime=hold(runtimePath);safeFile(heldRuntime.stat);if(heldRuntime.stat.uid!==BigInt(process.getuid?.()??-1)||runtime.identity.split(':').slice(0,6).join(':')!==fileID(heldRuntime.stat))throw new ReadSourceError('stale');
  const heldHome=hold(home);safeHome(heldHome.stat);account=captureReadSourceAccount(home,options.testing?.accountIdentity);
  const heldExe=hold(executable);safeFile(heldExe.stat);if(heldExe.stat.size<1n||heldExe.stat.size>512n*1024n*1024n)throw new ReadSourceError('unsupported');
  const profilePath=join(home,'config.toml'),profile=readLocalStateFile(profilePath,1024*1024);
  const heldProfile=profile?hold(profilePath):undefined;if(heldProfile){safeFile(heldProfile.stat);if(profile!.identity.split(':').slice(0,6).join(':')!==fileID(heldProfile.stat)||heldProfile.stat.uid!==BigInt(process.getuid?.()??-1))throw new ReadSourceError('offline');}
  const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let offset=0,n:number;
  while((n=readSync(heldExe.fd,buffer,0,buffer.length,offset))>0){offset+=n;if(BigInt(offset)>heldExe.stat.size)throw new ReadSourceError('stale');hash.update(buffer.subarray(0,n));}
  if(BigInt(offset)!==heldExe.stat.size||hash.digest('hex')!==VALIDATED_READ_SOURCE_SHA256)throw new ReadSourceError('unsupported');
  const socket=realpathSync(config.socket),socketStat=lstatSync(socket,{bigint:true});
  if(!socketStat.isSocket())throw new ReadSourceError('offline');
  const currentSocket=():undefined=>{const now=lstatSync(socket,{bigint:true});if(realpathSync(config.socket)!==socket||realpathSync(socket)!==socket||!now.isSocket()||socketID(now)!==socketID(socketStat))throw new ReadSourceError('stale');return undefined;};
  let released=false,releaseFailed=false,stale=false;const first:ListenerEvidence=discoverControlListener(config);
  currentSocket();if(first.socket!==socket)throw new ReadSourceError('stale');
  if(first.version!==VALIDATED_READ_SOURCE_VERSION||!config.supportedVersions.includes(first.version))throw new ReadSourceError('unsupported');
  const sourceCurrent=():undefined=>{try{
   account!.current();currentSocket();if(released||stale||options.current()!==undefined||readLocalStateFile(runtimePath,16384)?.identity!==runtime.identity)throw new ReadSourceError('stale');
   if(realpathSync(home)!==home||realpathSync(executable)!==executable)throw new ReadSourceError('stale');
   const nowHome=lstatSync(home,{bigint:true}),nowExe=lstatSync(executable,{bigint:true});safeHome(nowHome);safeFile(nowExe);
   if(dirID(nowHome)!==dirID(heldHome.stat)||dirID(fstatSync(heldHome.fd,{bigint:true}))!==dirID(heldHome.stat)||fileID(nowExe)!==fileID(heldExe.stat)||fileID(fstatSync(heldExe.fd,{bigint:true}))!==fileID(heldExe.stat))throw new ReadSourceError('stale');
   if(fileID(fstatSync(heldRuntime.fd,{bigint:true}))!==fileID(heldRuntime.stat)||readLocalStateFile(profilePath,1024*1024)?.identity!==profile?.identity)throw new ReadSourceError('stale');
   if(heldProfile&&fileID(fstatSync(heldProfile.fd,{bigint:true}))!==fileID(heldProfile.stat))throw new ReadSourceError('stale');
   // Scan tail can run arbitrary synchronous native work. Recheck source after it.
   if(options.current()!==undefined||readLocalStateFile(runtimePath,16384)?.identity!==runtime.identity||readLocalStateFile(profilePath,1024*1024)?.identity!==profile?.identity||dirID(lstatSync(home,{bigint:true}))!==dirID(heldHome.stat)||fileID(lstatSync(executable,{bigint:true}))!==fileID(heldExe.stat))throw new ReadSourceError('stale');
   safeHome(lstatSync(home,{bigint:true}));safeFile(lstatSync(executable,{bigint:true}));
   if(fileID(fstatSync(heldExe.fd,{bigint:true}))!==fileID(heldExe.stat)||fileID(fstatSync(heldRuntime.fd,{bigint:true}))!==fileID(heldRuntime.stat)||heldProfile&&fileID(fstatSync(heldProfile.fd,{bigint:true}))!==fileID(heldProfile.stat))throw new ReadSourceError('stale');
   currentSocket();return undefined;
  }catch{stale=true;throw new ReadSourceError('stale');}};
  const current=():undefined=>{try{sourceCurrent();const owner=discoverControlListener(config);if(owner.identity!==first.identity||owner.pid!==first.pid||owner.version!==first.version)throw new ReadSourceError('stale');return sourceCurrent();}catch{stale=true;throw new ReadSourceError('stale');}};
  current();const input=Object.freeze({kind:'native-read-discovery-input' as const});
  inputs.set(input,{accountRevision:account.revision,current,sourceCurrent,socket:first.socket,executable,home,version:first.version,pid:first.pid,release:()=>{if(!released){released=true;try{account!.release();}catch{releaseFailed=true;}for(const fd of fds)try{closeSync(fd);}catch{releaseFailed=true;}}if(releaseFailed)throw new ReadSourceError('offline');return undefined;}});transferred=true;return input;
 }catch(error){if(error instanceof ReadSourceError)throw error;throw new ReadSourceError('offline');}
 finally{if(!transferred){try{account?.release();}catch{}for(const fd of fds)try{closeSync(fd);}catch{}}}
}
export function currentNativeReadDiscoveryInput(input:NativeReadDiscoveryInput):undefined {const s=inputs.get(input);if(!s)throw new ReadSourceError('invalid');return s.current();}
export function releaseNativeReadDiscoveryInput(input:NativeReadDiscoveryInput):undefined {const s=inputs.get(input);if(!s)throw new ReadSourceError('invalid');return s.release();}
/** Existing PID comes only from native-issued all-visible listener ownership.
 * REG FD dev/ino and canonical DB must match. A different opened state DB rejects.
 * This is current snapshot evidence, never PID/kernel generation or absolute
 * ownership of inaccessible OS processes. Raw lsof data is never returned. */
function attestExistingRealm(s:InputState,root:string,current:()=>undefined):undefined {
 current();const db=join(root,'state_5.sqlite'),before=lstatSync(db,{bigint:true});safeFile(before);
 let raw:string;try{raw=execFileSync('/usr/sbin/lsof',['-nP','-a','-p',String(s.pid),'-FpfDitn'],{encoding:'utf8',timeout:5000,maxBuffer:4*1024*1024,env:{PATH:'/usr/bin:/bin',LANG:'C'}});}catch{current();throw new ReadSourceError('offline');}
 current();let owner=false,fd:Record<string,string>={},found=false,bad=false;
 const flush=()=>{if(fd.n?.endsWith('/state_5.sqlite')){if(!owner||fd.n!==db||fd.t!=='REG'||!/^\d+[rwu]?$/.test(fd.f??'')||!/^0x[0-9a-f]+$/i.test(fd.D??'')||!/^\d+$/.test(fd.i??'')||`${BigInt(fd.D)}:${BigInt(fd.i)}`!==dirID(before))bad=true;else found=true;}};
 for(const line of raw.split('\n')){const key=line[0],value=line.slice(1);if(key==='p'){flush();fd={};owner=value===String(s.pid);}else if(key==='f'){flush();fd={f:value};}else if(['n','t','D','i'].includes(key))fd[key]=value;}flush();
 current();if(!found||bad||dirID(lstatSync(db,{bigint:true}))!==dirID(before))throw new ReadSourceError('stale');return undefined;
}
/** Existing Unix WebSocket endpoint only. Does not spawn user-home app-server or
 * reuse the official raw daemon proxy as though it were a WebSocket. */
export async function discoverSavedHistorySource(input:NativeReadDiscoveryInput,options:{current?:()=>undefined}={}):Promise<SavedHistorySourceCandidate> {
 const s=inputs.get(input);if(!s)throw new ReadSourceError('invalid');
 const operation=():undefined=>{if(options.current&&options.current()!==undefined)throw new ReadSourceError('stale');return undefined;};
 const check=():undefined=>{operation();s.current();operation();return s.sourceCurrent();};check();
 let ws:WebSocket|undefined,realm:ProtectedReadRealm|undefined,transferred=false;
 const pending=new Map<number,{resolve(v:any):void;reject(e:Error):void;timer:ReturnType<typeof setTimeout>}>();let seq=0;
 try{
  await new Promise<void>((resolve,reject)=>{const client=ws=new WebSocket(`ws+unix://localhost${s.socket}:/rpc`,{handshakeTimeout:5000,maxPayload:1024*1024,perMessageDeflate:false});client.once('open',()=>resolve());client.once('error',()=>{client.terminate();reject(new ReadSourceError('offline'));});});check();
  const active=ws!;
  const fail=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new ReadSourceError('offline'));}pending.clear();};active.on('error',fail);active.on('close',fail);
  active.on('message',bytes=>{let f:any;try{if(Buffer.byteLength(bytes as Buffer)>1024*1024)throw 0;f=JSON.parse(bytes.toString());if(!f||typeof f!=='object'||Array.isArray(f))throw 0;}catch{fail();active.terminate();return;}if(!f.method){const p=pending.get(f.id);if(p){pending.delete(f.id);clearTimeout(p.timer);f.error?p.reject(new ReadSourceError('offline')):p.resolve(f.result);}}});
  const request=async(method:'initialize'|'config/read',params:object)=>{check();const id=++seq;const result=await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new ReadSourceError('timeout'));active.terminate();},5000);pending.set(id,{resolve,reject,timer});try{active.send(JSON.stringify({id,method,params}));}catch{clearTimeout(timer);pending.delete(id);reject(new ReadSourceError('offline'));}});check();return result;};
  const init=await request('initialize',{clientInfo:{name:'ash-source-discovery',version:'1'},capabilities:{experimentalApi:true}});check();
  if(init?.userAgent?.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0]!==s.version)throw new ReadSourceError('unsupported');active.send(JSON.stringify({method:'initialized'}));check();
  const response=await request('config/read',{includeLayers:false,cwd:null});check();
  if(!response?.config||!Object.hasOwn(response.config,'sqlite_home'))throw new ReadSourceError('unsupported');
  const configured=response.config.sqlite_home;
  const root=configured===null?s.home:configured;
  if(typeof root!=='string'||!isAbsolute(root)||/[\u0000-\u001f]/.test(root)||realpathSync(root)!==root)throw new ReadSourceError('invalid');
  if(configured!==null){const origin=response.origins?.sqlite_home?.name;if(origin?.type!=='user'||origin.file!==join(s.home,'config.toml'))throw new ReadSourceError('unsupported');}
  realm=captureReadRealm({root,version:s.version,current:s.current});const heldRealm=realm;
  let invalid=false;const current=():undefined=>{try{if(invalid)throw new ReadSourceError('stale');s.current();currentReadRealm(heldRealm);attestExistingRealm(s,root,()=>{s.current();currentReadRealm(heldRealm);return undefined;});s.current();currentReadRealm(heldRealm);return undefined;}catch{invalid=true;throw new ReadSourceError('stale');}};
  check();current();await new Promise<void>(resolve=>{if(active.readyState===WebSocket.CLOSED)return resolve();active.once('close',resolve);active.terminate();});ws=undefined;check();current();operation();s.sourceCurrent();
  let released=false,releaseFailure:unknown;const candidate=Object.freeze({kind:'saved-history-source-candidate' as const,candidate_id:randomUUID()});
  candidates.set(candidate,{accountRevision:s.accountRevision,current:()=>{if(released)throw new ReadSourceError('stale');return current();},descriptor:Object.freeze({executable:s.executable,executable_sha256:VALIDATED_READ_SOURCE_SHA256,codex_home:s.home,sqlite_home:root,profile:'default',supported_versions:Object.freeze([s.version])}),release:()=>{if(!released){released=true;try{releaseReadRealm(heldRealm);}catch(error){releaseFailure=error;}}if(releaseFailure)throw releaseFailure;return undefined;}});transferred=true;return candidate;
 }catch(error){if(error instanceof ReadSourceError)throw error;throw new ReadSourceError('offline');}
 finally{for(const p of pending.values())clearTimeout(p.timer);pending.clear();if(ws)await new Promise<void>(resolve=>{if(ws!.readyState===WebSocket.CLOSED)return resolve();ws!.once('close',resolve);ws!.terminate();});if(realm&&!transferred)releaseReadRealm(realm);}
}
export function currentSavedHistorySourceCandidate(candidate:SavedHistorySourceCandidate):undefined {const s=candidates.get(candidate);if(!s)throw new ReadSourceError('invalid');return s.current();}
/** Native writer only; never expose this record as a renderer selection action. */
export function nativeSavedHistorySourceSelection(candidate:SavedHistorySourceCandidate):CandidateState['descriptor'] {const s=candidates.get(candidate);if(!s)throw new ReadSourceError('invalid');s.current();return s.descriptor;}
export function releaseSavedHistorySourceCandidate(candidate:SavedHistorySourceCandidate):undefined {const s=candidates.get(candidate);if(!s)throw new ReadSourceError('invalid');return s.release();}

/** Default-home saved-history discovery from an already running native process.
 * Reads PID/UID/start/main-image and REG FD metadata only; never argv, env or
 * history bodies. This supplies saved history, not live desktop control. */
export function discoverDefaultStdioSavedHistorySource(options:{codexHome:string;current():undefined;testing?:{executable?:string;accountIdentity?:{account_id:string;subject:string}}}):SavedHistorySourceCandidate {
 if(process.platform!=='darwin')throw new ReadSourceError('unsupported');
 const fds:number[]=[];let realm:ProtectedReadRealm|undefined,account:ReturnType<typeof captureReadSourceAccount>|undefined,transferred=false,stale=false,released=false;
 const home=options.codexHome,executable=realpathSync(options.testing?.executable??'/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
 try{
  const guard=():undefined=>{if(stale||released||options.current()!==undefined)throw new ReadSourceError('stale');return undefined;};guard();
  if(realpathSync(home)!==home||lstatSync(home).isSymbolicLink())throw new ReadSourceError('invalid');
  const hold=(p:string)=>{const fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);fds.push(fd);return {fd,stat:fstatSync(fd,{bigint:true})};};
  account=captureReadSourceAccount(home,options.testing?.accountIdentity);const heldHome=hold(home),heldExe=hold(executable);safeHome(heldHome.stat);safeFile(heldExe.stat);
  const configPath=join(home,'config.toml'),config=readLocalStateFile(configPath,1024*1024),heldConfig=config?hold(configPath):undefined;if(heldConfig){safeFile(heldConfig.stat);if(heldConfig.stat.uid!==BigInt(process.getuid?.()??-1)||fileID(heldConfig.stat)!==config!.identity.split(':').slice(0,6).join(':'))throw new ReadSourceError('stale');}
  const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let offset=0,n=0;
  if(heldExe.stat.size<1n||heldExe.stat.size>512n*1024n*1024n)throw new ReadSourceError('unsupported');
  while((n=readSync(heldExe.fd,buffer,0,buffer.length,offset))>0){offset+=n;hash.update(buffer.subarray(0,n));if(BigInt(offset)>heldExe.stat.size)throw new ReadSourceError('stale');}
  if(BigInt(offset)!==heldExe.stat.size||hash.digest('hex')!==VALIDATED_READ_SOURCE_SHA256)throw new ReadSourceError('unsupported');
  const run=(command:string,args:string[])=>execFileSync(command,args,{encoding:'utf8',timeout:5000,maxBuffer:4*1024*1024,env:{PATH:'/usr/bin:/bin',LANG:'C'}});
  if(run(executable,['--version']).trim()!==`codex-cli ${VALIDATED_READ_SOURCE_VERSION}`)throw new ReadSourceError('unsupported');
  const cheap=():undefined=>{try{account!.current();guard();if(realpathSync(home)!==home||realpathSync(executable)!==executable||dirID(lstatSync(home,{bigint:true}))!==dirID(heldHome.stat)||dirID(fstatSync(heldHome.fd,{bigint:true}))!==dirID(heldHome.stat)||fileID(lstatSync(executable,{bigint:true}))!==fileID(heldExe.stat)||fileID(fstatSync(heldExe.fd,{bigint:true}))!==fileID(heldExe.stat)||readLocalStateFile(configPath,1024*1024)?.identity!==config?.identity||heldConfig&&fileID(fstatSync(heldConfig.fd,{bigint:true}))!==fileID(heldConfig.stat))throw new ReadSourceError('stale');safeHome(lstatSync(home,{bigint:true}));safeFile(lstatSync(executable,{bigint:true}));return guard();}catch{stale=true;throw new ReadSourceError('stale');}};
  const matches:number[]=[];const lines=run('/bin/ps',['-axo','pid=,uid=,comm=']).split('\n');cheap();
  for(const line of lines){const m=line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);if(!m||Number(m[2])!==process.getuid?.()||m[3]!==executable)continue;const pid=Number(m[1]);try{
    const image=run('/usr/sbin/lsof',['-nP','-a','-p',String(pid),'-d','txt','-Fn']).split('\n').find(l=>l.startsWith('n'))?.slice(1);cheap();if(image!==executable)continue;
    attestExistingRealm({pid} as InputState,home,cheap);matches.push(pid);
   }catch(error){cheap();/* Nonmatching/closed candidate does not select a source. */}}
  if(!matches.length)throw new ReadSourceError('source_not_running');
  // All matches already attest the identical canonical default root, physical DB
  // and fixed artifact: they are instances of one saved-history source. Dedup
  // that source; a retained original attestor must remain current until commit.
  const pid=matches.sort((a,b)=>a-b)[0],birth=run('/bin/ps',['-p',String(pid),'-o','uid=,lstart=,comm=']).trim();cheap();
  realm=captureReadRealm({root:home,version:VALIDATED_READ_SOURCE_VERSION,current:cheap});const retained=realm;
  const current=():undefined=>{try{cheap();currentReadRealm(retained);if(run('/bin/ps',['-p',String(pid),'-o','uid=,lstart=,comm=']).trim()!==birth)throw new ReadSourceError('stale');cheap();if(run('/usr/sbin/lsof',['-nP','-a','-p',String(pid),'-d','txt','-Fn']).split('\n').find(l=>l.startsWith('n'))?.slice(1)!==executable)throw new ReadSourceError('stale');cheap();attestExistingRealm({pid} as InputState,home,()=>{cheap();return currentReadRealm(retained);});currentReadRealm(retained);return cheap();}catch{stale=true;throw new ReadSourceError('stale');}};
  current();const candidate=Object.freeze({kind:'saved-history-source-candidate' as const,candidate_id:randomUUID()});
  candidates.set(candidate,{accountRevision:account.revision,current,descriptor:Object.freeze({executable,executable_sha256:VALIDATED_READ_SOURCE_SHA256,codex_home:home,sqlite_home:home,profile:'default',supported_versions:Object.freeze([VALIDATED_READ_SOURCE_VERSION])}),release:()=>{if(released)return undefined;released=true;let failure:unknown;try{account!.release();}catch(error){failure=error;}try{releaseReadRealm(retained);}catch(error){failure=error;}for(const fd of fds)try{closeSync(fd);}catch(error){failure??=error;}if(failure)throw failure;return undefined;}});transferred=true;return candidate;
 }catch(error){if(error instanceof ReadSourceError)throw error;throw new ReadSourceError('offline');}
 finally{if(!transferred){try{account?.release();}catch{}if(realm)try{releaseReadRealm(realm);}catch{}for(const fd of fds)try{closeSync(fd);}catch{}}}
}

/** Stable service-derived display binding; labels/random preview IDs never bind a
 * confirmation. Ordinary SQLite content growth does not change this identity. */
export function savedHistorySourceConfirmationBinding(candidate:SavedHistorySourceCandidate):string {
 const s=candidates.get(candidate);if(!s)throw new ReadSourceError('invalid');s.current();const d=s.descriptor;
 const revision=stableReadSourceRevision(d,s.accountRevision);s.current();return revision;
}
