// One explicitly authorized native smoke. No GUI, login, model/session RPC,
// bootstrap, remote-control, service registration or default-instance stop.
import {createHash} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {copyFileSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readlinkSync,realpathSync,rmSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {prepareMissingSharedCodexSettings,SHARED_CODEX_CLI,SHARED_CODEX_VERSION} from '../../packages/device/src/setup/shared-codex-launch';
import {readLocalStateFile} from '../../packages/device/src/collaboration/local-state';

const expectedHash='0d5ac7aae20c4eda6242428d5e218c55ba96d8763fda2a271088ff37104b9d28';
const out=resolve('docs/evidence/first-shared-default-native-20261012'),contextPath=join(out,'context.json');
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const envFor=(root:string)=>({HOME:root,CODEX_HOME:join(root,'.codex'),TMPDIR:join(root,'tmp'),PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C'});
function identity(path:string){try{const s=lstatSync(path,{bigint:true});return {dev:String(s.dev),ino:String(s.ino),mode:String(s.mode),uid:String(s.uid),size:String(s.size),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs),kind:s.isFile()?'file':s.isDirectory()?'directory':s.isSocket()?'socket':s.isSymbolicLink()?'symlink':'other'};}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}}
function processIdentity(pid:number,root:string){const r=spawnSync('/bin/ps',['-p',String(pid),'-o','pid=,lstart=,comm='],{env:envFor(root),encoding:'utf8',timeout:5000,maxBuffer:4096});if(r.status===1&&!r.stdout.trim())return null;if(r.status!==0)throw Error('Process metadata unavailable');return r.stdout.trim()||null;}
function socketIdentity(path:string){const logical=identity(path);if(!logical)return null;const target=realpathSync(path),s=statSync(target,{bigint:true});if(!s.isSocket())throw Error('Expected Unix socket');return {logical,target,targetIdentity:{dev:String(s.dev),ino:String(s.ino),uid:String(s.uid),mode:String(s.mode),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs)},link:logical.kind==='symlink'?readlinkSync(path):null};}
function socketPids(path:string,root:string){const r=spawnSync('/usr/sbin/lsof',['-nP','-Fpc',path],{env:envFor(root),encoding:'utf8',timeout:5000,maxBuffer:16384});if(r.status===1&&!r.stdout.trim())return [];if(r.status!==0)throw Error('Socket metadata unavailable');return [...new Set(r.stdout.split('\n').flatMap(line=>/^p[0-9]+$/.test(line)?[Number(line.slice(1))]:[]))].sort((a,b)=>a-b);}
function defaultSnapshot(home:string,root:string){
 const configs=Object.fromEntries(['config.toml','app-server-daemon/settings.json'].map(name=>{const path=join(home,'.codex',name),file=readLocalStateFile(path,1024*1024);return [name,file?{identity:file.identity,sha256:hash(file.raw)}:null];}));
 const socket=socketIdentity(join(home,'.codex/app-server-control/app-server-control.sock'));
 const pids=socket?socketPids(socket.target,root):[];
 const pidFile=readLocalStateFile(join(home,'.codex/app-server-daemon/daemon.pid'),16384);if(pidFile){try{const value=JSON.parse(pidFile.raw),pid=typeof value==='number'?value:value?.pid;if(Number.isSafeInteger(pid)&&pid>1&&!pids.includes(pid))pids.push(pid);}catch{const pid=Number(pidFile.raw.trim());if(Number.isSafeInteger(pid)&&pid>1&&!pids.includes(pid))pids.push(pid);}}
 return {configs,socket,pidFile:pidFile?{identity:pidFile.identity,sha256:hash(pidFile.raw)}:null,pids:pids.sort((a,b)=>a-b).map(pid=>({pid,identity:processIdentity(pid,root)}))};
}
async function native(root:string,cli:string,args:string[],timeout:number){
 console.log('native '+args.join(' '));
 return new Promise<{exitCode:number|null;signal:string|null;timedOut:boolean;stdout:string;stdoutBytes:number;stderrBytes:number;stderrSha256:string}>(resolveCall=>{
  let stdout='',stdoutBytes=0,stderrBytes=0,failed=false,timedOut=false;const stderrHash=createHash('sha256');
  const child=spawn(cli,args,{cwd:root,env:envFor(root),stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},timeout);
  child.stdout.on('data',b=>{stdoutBytes+=b.length;if(stdoutBytes<=65536)stdout+=b.toString();else failed=true;});child.stderr.on('data',b=>{stderrBytes+=b.length;stderrHash.update(b);});child.once('error',()=>{failed=true;});child.once('close',(code,signal)=>{clearTimeout(timer);resolveCall({exitCode:failed?-1:code,signal,timedOut,stdout:failed?'':stdout,stdoutBytes,stderrBytes,stderrSha256:stderrHash.digest('hex')});});
 });
}
function lifecycle(result:Awaited<ReturnType<typeof native>>){if(result.exitCode!==0||result.timedOut)throw Error('Native lifecycle command failed');const v=JSON.parse(result.stdout);return {status:v.status,backend:v.backend,pid:v.pid,managedCodexPath:v.managedCodexPath,managedCodexVersion:v.managedCodexVersion,socketPath:v.socketPath,cliVersion:v.cliVersion,appServerVersion:v.appServerVersion};}
function safeRoot(root:string,expected:{dev:string;ino:string}){const s=identity(root);if(!root.startsWith('/private/tmp/ash-sd-')||realpathSync(root)!==root||s?.kind!=='directory'||s.dev!==expected.dev||s.ino!==expected.ino||Number(s.uid)!==process.getuid?.())throw Error('Temporary root changed');}
function ownNative(pid:number,managed:string,socket:string,root:string,defaultPids:number[]){
 if(!Number.isSafeInteger(pid)||pid<2||defaultPids.includes(pid)||!managed.startsWith(join(root,'.codex')+'/')||!realpathSync(managed).startsWith(join(root,'.codex')+'/'))throw Error('Temporary managed path/PID not verified');
 const p=processIdentity(pid,root),comm=p?.match(/^\d+\s+(?:\S+\s+){5}(.+)$/)?.[1];
 if(!comm)throw Error('Temporary PID executable metadata unavailable');
 const actualExecutable=realpathSync(comm);if(!actualExecutable.startsWith(join(root,'.codex')+'/')||hash(readFileSync(actualExecutable))!==expectedHash)throw Error('Temporary actual executable/PID not verified');
 const s=socketIdentity(socket);if(!s||Number(s.targetIdentity.uid)!==process.getuid?.()||s.target===join(homedir(),'.codex/app-server-control/app-server-control.sock'))throw Error('Temporary socket not verified');
 const parent=statSync(dirname(s.target));if(parent.uid!==process.getuid?.()||(parent.mode&0o077)!==0)throw Error('Unsafe temporary socket parent');
 if(!s.target.startsWith(root+'/')&&!s.target.startsWith(`/private/tmp/codex-daemon-${process.getuid?.()}/`))throw Error('Unknown socket relocation');
 const r=spawnSync('/usr/sbin/lsof',['-nP','-a','-p',String(pid),'-U','-Fpn'],{env:envFor(root),encoding:'utf8',timeout:5000,maxBuffer:16384});if(r.status!==0||!r.stdout.split('\n').includes('n'+s.target))throw Error('Temporary PID does not own the exact socket');
 return {pid,processIdentity:p,socket:s,actualExecutable,actualExecutableSha256:expectedHash,managedCanonical:realpathSync(managed),managedWrapperSha256:hash(readFileSync(realpathSync(managed)))};
}
if(process.argv[2]==='--preflight'){
 if(process.platform!=='darwin'||existsSync(contextPath))throw Error('Preflight requires macOS and a fresh evidence context');mkdirSync(out,{recursive:true});
 const root=realpathSync(mkdtempSync('/tmp/ash-sd-'));mkdirSync(join(root,'tmp'),{mode:0o700});const rootIdentity=identity(root)!;
 const cli=realpathSync(SHARED_CODEX_CLI),cliHash=hash(readFileSync(cli));if(cliHash!==expectedHash)throw Error('Fixed CLI hash mismatch');
 const version=await native(root,cli,['--version'],5000);if(version.exitCode!==0||version.stdout.trim()!==`codex-cli ${SHARED_CODEX_VERSION}`)throw Error('Fixed CLI version mismatch');
 const defaultHome=homedir(),before=defaultSnapshot(defaultHome,root);
 const context={root,rootIdentity,cli,cliHash,version:SHARED_CODEX_VERSION,hashSource:'packages/device/test/fixtures/read-source-native-realm.mjs FIXED_HASH; A2 prose records version only, not hash',defaultHome,before,env:envFor(root),nativeLifecycleRuns:0};
 writeFileSync(contextPath,JSON.stringify(context,null,2),{mode:0o600});console.log(JSON.stringify({stage:'preflight_ready',cliHash,version:context.version,root,defaultPidCount:before.pids.length,defaultSocketPresent:!!before.socket}));
}else if(process.argv[2]==='--run'||process.argv[2]==='--complete-started'){
 const continuing=process.argv[2]==='--complete-started';
 const ctx=JSON.parse(readFileSync(contextPath,'utf8'));safeRoot(ctx.root,ctx.rootIdentity);if(continuing?(ctx.nativeLifecycleRuns!==1||ctx.continuationClaimed):ctx.nativeLifecycleRuns!==0)throw Error('Only one native lifecycle permitted');
 if(realpathSync(SHARED_CODEX_CLI)!==ctx.cli||hash(readFileSync(ctx.cli))!==expectedHash||JSON.stringify(defaultSnapshot(ctx.defaultHome,ctx.root))!==JSON.stringify(ctx.before))throw Error('Preflight/default instance changed');
 if(continuing)ctx.continuationClaimed=true;else ctx.nativeLifecycleRuns=1;writeFileSync(contextPath,JSON.stringify(ctx,null,2),{mode:0o600});
 const original=continuing?JSON.parse(readFileSync(join(out,'smoke.json'),'utf8')):null;
 if(continuing){if(original.commands.length!==1||original.start?.status!=='started'||original.start?.backend!=='pid')throw Error('Continuation requires the single already-started temporary PID instance');copyFileSync(join(out,'smoke.json'),join(out,'smoke-pre-identity-fix.json'));}
 const report:any=original??{cli:ctx.cli,cliSha256:ctx.cliHash,version:ctx.version,hashSource:ctx.hashSource,root:ctx.root,env:ctx.env,defaultBefore:ctx.before,commands:[],success:false};let owned:ReturnType<typeof ownNative>|undefined,stopAttempted=false,pidLifecycleVerified=false;
 if(continuing){report.driverCorrection={originalFailure:report.failure,note:'Managed current/bin/codex is a launcher/alias. Verify the actual PID executable inside this same temporary release against FIXED_HASH; no additional start.'};delete report.failure;delete report.cleanupUnverified;delete report.defaultAfter;delete report.defaultUnchanged;}
 try{
  const settings=join(ctx.root,'.codex/app-server-daemon/settings.json');if(!continuing)prepareMissingSharedCodexSettings(ctx.root);const raw=readFileSync(settings,'utf8');if(JSON.stringify(JSON.parse(raw))!==JSON.stringify({remoteControlEnabled:false,updater:{autoUpdateEnabled:false}}))throw Error('Helper emitted non-minimal settings');report.settingsBefore={sha256:hash(raw),value:JSON.parse(raw)};
  let started=report.start;if(!continuing){const startResult=await native(ctx.root,ctx.cli,['app-server','daemon','start'],45000);report.commands.push({command:'start',...startResult,stdout:undefined});started=lifecycle(startResult);report.start=started;}else console.log('continue same already-started temporary PID; no new start');
  if(Number.isSafeInteger(started.pid)&&started.managedCodexPath?.startsWith(join(ctx.root,'.codex')+'/')&&started.socketPath===join(ctx.root,'.codex/app-server-control/app-server-control.sock'))owned=ownNative(started.pid,started.managedCodexPath,started.socketPath,ctx.root,ctx.before.pids.map((p:any)=>p.pid));
  if(started.status!=='started'||started.backend!=='pid'||started.appServerVersion!==SHARED_CODEX_VERSION||started.socketPath!==join(ctx.root,'.codex/app-server-control/app-server-control.sock')||!started.managedCodexPath?.startsWith(join(ctx.root,'.codex')+'/'))throw Error('Native start is not the expected temporary PID backend');
  if(!owned)throw Error('Temporary native ownership not established');pidLifecycleVerified=true;report.nativeIdentity=owned;
  const versionResult=await native(ctx.root,ctx.cli,['app-server','daemon','version'],15000);report.commands.push({command:'version',...versionResult,stdout:undefined});report.running=lifecycle(versionResult);
  if(report.running.status!=='running'||report.running.backend!=='pid'||report.running.appServerVersion!==SHARED_CODEX_VERSION||report.running.managedCodexPath!==started.managedCodexPath||report.running.socketPath!==started.socketPath)throw Error('Temporary native version/path mismatch');
  if(hash(readFileSync(settings))!==report.settingsBefore.sha256||existsSync(join(ctx.root,'.codex/auth.json')))throw Error('Settings changed or unexpected authentication file');report.settingsAfter={sha256:hash(readFileSync(settings)),value:JSON.parse(readFileSync(settings,'utf8'))};
  if(processIdentity(owned.pid,ctx.root)!==owned.processIdentity)throw Error('Temporary PID changed before stop');
  stopAttempted=true;const stopResult=await native(ctx.root,ctx.cli,['app-server','daemon','stop'],75000);report.commands.push({command:'stop',...stopResult,stdout:undefined});report.stop=lifecycle(stopResult);if(report.stop.status!=='stopped'||report.stop.backend!=='pid'||report.stop.socketPath!==started.socketPath||report.stop.managedCodexPath!==started.managedCodexPath)throw Error('Temporary native stop mismatch');
  report.success=true;
 }catch(error){report.failure=error instanceof Error?error.message:String(error);}
 finally{
  try{
   if(owned){
    if(pidLifecycleVerified&&!stopAttempted&&processIdentity(owned.pid,ctx.root)===owned.processIdentity){stopAttempted=true;const r=await native(ctx.root,ctx.cli,['app-server','daemon','stop'],75000);report.cleanupStop={...r,stdout:undefined};}
    const deadline=Date.now()+10000;while(processIdentity(owned.pid,ctx.root)&&Date.now()<deadline)await delay(200);
    if(processIdentity(owned.pid,ctx.root)===owned.processIdentity){ownNative(owned.pid,report.start.managedCodexPath,report.start.socketPath,ctx.root,ctx.before.pids.map((p:any)=>p.pid));process.kill(owned.pid,'SIGTERM');report.exactCleanupSignal='SIGTERM';report.success=false;await delay(1000);}
    report.pidGone=processIdentity(owned.pid,ctx.root)===null;report.actualSocketGone=identity(owned.socket.target)===null;
    if(!report.actualSocketGone&&report.pidGone&&socketPids(owned.socket.target,ctx.root).length===0){const s=statSync(owned.socket.target,{bigint:true});if(String(s.dev)===owned.socket.targetIdentity.dev&&String(s.ino)===owned.socket.targetIdentity.ino){unlinkSync(owned.socket.target);report.exactSocketCleanup=true;report.actualSocketGone=true;}}
   }else report.cleanupUnverified='No verified temporary PID; no native stop or process kill issued.';
   report.defaultAfter=defaultSnapshot(ctx.defaultHome,ctx.root);report.defaultUnchanged=JSON.stringify(report.defaultAfter)===JSON.stringify(ctx.before);
   if(!report.defaultUnchanged||!report.pidGone||!report.actualSocketGone)report.success=false;
   if(report.pidGone&&report.actualSocketGone){safeRoot(ctx.root,ctx.rootIdentity);rmSync(ctx.root,{recursive:true,force:true});report.temporaryRootRemoved=!existsSync(ctx.root);}
  }catch(error){report.cleanupFailure=error instanceof Error?error.message:String(error);report.success=false;}
  writeFileSync(join(out,'smoke.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({success:report.success,failure:report.failure,cleanupFailure:report.cleanupFailure,pidGone:report.pidGone,actualSocketGone:report.actualSocketGone,defaultUnchanged:report.defaultUnchanged,temporaryRootRemoved:report.temporaryRootRemoved}));
 }
 process.exitCode=report.success?0:1;
}else throw Error('Use --preflight, then --run exactly once');
