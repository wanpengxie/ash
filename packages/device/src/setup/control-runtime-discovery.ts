import {homedir} from 'node:os';
import {join,relative} from 'node:path';
import {realpathSync,lstatSync,openSync,closeSync,fstatSync,readSync,constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {discoverControlListener,parseControlRuntimeConfig,parseUnixListenerPid,type ControlRuntimeConfig} from '../collaboration/control-runtime';
import {verifyListenerMainEvidence} from '../collaboration/codex-transport';
import type {ListenerEvidence} from '../collaboration/control-native-types';
import {VALIDATED_READ_SOURCE_VERSION} from '../collaboration/read-source';

type FileEvidence={kind:'directory'|'file'|'socket'|'symlink'|'other';uid:number;mode:number;identity:string};
/** Explicit fixtures only. Production resolves only the fixed Codex managed paths. */
export interface ControlRuntimeDiscoveryTestBackend {
 platform:string;home:string;uid:number;arch:string;
 canonical(path:string):string;
 file(path:string):FileEvidence;
 run(command:string,args:string[]):string;
 hash(path:string):string;
 verify(config:ControlRuntimeConfig):ListenerEvidence;
}
const fileIdentity=(s:import('node:fs').BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink].join(':');
const production:ControlRuntimeDiscoveryTestBackend={platform:process.platform,home:homedir(),uid:process.getuid?.()??-1,arch:process.arch,canonical:realpathSync,file(path){const s=lstatSync(path,{bigint:true});return {kind:s.isSymbolicLink()?'symlink':s.isDirectory()?'directory':s.isFile()?'file':s.isSocket()?'socket':'other',uid:Number(s.uid),mode:Number(s.mode),identity:s.isDirectory()?[s.dev,s.ino,s.uid,s.mode].join(':'):fileIdentity(s)};},run:(command,args)=>execFileSync(command,args,{encoding:'utf8',timeout:5000,maxBuffer:1024*1024}),verify:config=>verifyListenerMainEvidence(discoverControlListener(config),true),hash(path){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.nlink!==1n||before.size<1n||before.size>512n*1024n*1024n)throw Error('Unprotected Codex artifact.');
  const digest=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let count:number;while((count=readSync(fd,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,count));
  if(fileIdentity(before)!==fileIdentity(fstatSync(fd,{bigint:true}))||fileIdentity(before)!==fileIdentity(lstatSync(path,{bigint:true})))throw Error('Codex artifact changed.');return digest.digest('hex');
 }finally{closeSync(fd);}
}};
/** Fixed local discovery only. This never starts a daemon or changes Codex. */
export function discoverDefaultControlRuntime(endpointId:string,options:{testing?:ControlRuntimeDiscoveryTestBackend}={}):ControlRuntimeConfig {
 const backend=options.testing??production;if(backend.platform!=='darwin')throw Error('Shared desktop control is not yet supported on this operating system.');
 const observations=new Map<string,FileEvidence>();
 const inspect=(path:string)=>{const value=backend.file(path);observations.set(path,value);return value;};
 const protectedDirectory=(path:string)=>{const s=inspect(path);if(s.kind!=='directory'||s.uid!==backend.uid||(s.mode&0o022)!==0)throw Error('Unprotected Codex managed directory.');};
 const home=backend.canonical(join(backend.home,'.codex'));protectedDirectory(home);
 const control=join(home,'app-server-control');protectedDirectory(control);
 const managedSocket=join(control,'app-server-control.sock');let socket:string;
 try{const link=inspect(managedSocket);if(link.uid!==backend.uid||!['socket','symlink'].includes(link.kind))throw Error();socket=backend.canonical(managedSocket);
  if(link.kind==='symlink'){const managedRoot=`/private/tmp/codex-daemon-${backend.uid}`;protectedDirectory(managedRoot);if(!new RegExp(`^${managedRoot}/[a-f0-9]{64}$`).test(socket))throw Error();}
  else if(socket!==managedSocket)throw Error();
  const actual=inspect(socket);if(actual.kind!=='socket'||actual.uid!==backend.uid||(actual.mode&0o022)!==0)throw Error();
 }catch{throw Error('Codex managed shared socket is unavailable or unverified. Complete the controlled desktop connection step first.');}
 const pid=parseUnixListenerPid(backend.run('/usr/sbin/lsof',['-nP','-a','-U','-Fpn','--',socket]),socket,backend.canonical);
 const process=backend.run('/bin/ps',['-p',String(pid),'-o','uid=,comm=']).trim().match(/^(\d+)\s+(.+)$/);
 if(!process||Number(process[1])!==backend.uid)throw Error('Codex shared listener is not owned by the current user.');
 const executable=backend.canonical(process[2]),bundle=backend.canonical('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex');
 if(executable!==bundle){
  const root=join(home,'packages/app-server-daemon/releases'),suffix=relative(root,executable),architecture=backend.arch==='arm64'?'aarch64':backend.arch==='x64'?'x86_64':null;
  if(!architecture||!new RegExp(`^local-[a-f0-9]{64}-${architecture}-apple-darwin/CodexCLI\\.app/Contents/MacOS/codex$`).test(suffix))throw Error('Codex listener is outside the fixed managed release.');
  let directory=home;for(const part of relative(home,executable).split('/').slice(0,-1)){directory=join(directory,part);protectedDirectory(directory);}
 }
 for(const path of new Set([executable,bundle])){const s=inspect(path);if(s.kind!=='file'||![0,backend.uid].includes(s.uid)||(s.mode&0o022)!==0)throw Error('Unprotected Codex executable.');}
 if(executable!==bundle&&backend.hash(executable)!==backend.hash(bundle))throw Error('Managed Codex artifact differs from the fixed desktop bundle.');
 const config=parseControlRuntimeConfig({version:1,endpoint_id:endpointId,socket,executable,supportedVersions:[VALIDATED_READ_SOURCE_VERSION]},endpointId);
 const evidence=backend.verify(config);if(evidence.pid!==pid||evidence.socket!==socket||evidence.executable!==executable||evidence.version!==VALIDATED_READ_SOURCE_VERSION)throw Error('Codex listener identity or version changed.');
 for(const[path,before]of observations)if(backend.file(path).identity!==before.identity)throw Error('Codex managed connection changed during discovery.');
 if(backend.canonical(managedSocket)!==socket||backend.canonical(process[2])!==executable)throw Error('Codex managed connection was retargeted.');
 return config;
}
