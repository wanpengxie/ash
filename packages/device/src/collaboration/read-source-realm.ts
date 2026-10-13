import {createHash} from 'node:crypto';
import {execFileSync,type ChildProcess} from 'node:child_process';
import {closeSync,constants,fstatSync,lstatSync,openSync,realpathSync,type BigIntStats} from 'node:fs';
import {isAbsolute,join,resolve} from 'node:path';
import {ReadSourceError} from './read-source';
/** Private existing physical SQLite realm; never wire configuration or a grant. */
export interface ProtectedReadRealm {readonly revision:string;}
const realms=new WeakMap<object,{current():undefined;release():undefined;root:string;database:string;identity:string;}>();
const identity=(s:BigIntStats)=>`${s.dev}:${s.ino}`;
function safe(s:BigIntStats,dir:boolean){if((dir?!s.isDirectory():!s.isFile())||s.uid!==BigInt(process.getuid?.()??-1)||(s.mode&0o022n)!==0n||!dir&&s.nlink!==1n)throw new ReadSourceError('offline');}
/** Only the layout actually observed with the fixed installed CLI is supported.
 * A testing version is explicit, never accepted from descriptor/wire fields. */
export function captureReadRealm(options:{root:string;version:string;current?:()=>undefined;testing?:{version:string}}):ProtectedReadRealm{
  const fds:number[]=[];let transferred=false;
  try{
    if(process.platform!=='darwin')throw new ReadSourceError('unsupported');
    if(options.version!=='0.162.0-alpha.17.2'&&options.testing?.version!==options.version)throw new ReadSourceError('unsupported');
    const root=options.root;
    if(typeof root!=='string'||!isAbsolute(root)||resolve(root)!==root||/[\u0000-\u001f]/.test(root)||realpathSync(root)!==root)throw new ReadSourceError('invalid');
    const database=join(root,'state_5.sqlite');
    const open=(p:string)=>{const fd=openSync(p,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);fds.push(fd);return fd;};
    const rootFD=open(root),rootStat=fstatSync(rootFD,{bigint:true});safe(rootStat,true);
    let dbFD:number;try{dbFD=open(database);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new ReadSourceError('source_required');throw error;}
    const dbStat=fstatSync(dbFD,{bigint:true});safe(dbStat,false);
    let released=false,stale=false,releaseError:ReadSourceError|undefined;
    const current=():undefined=>{try{
      if(released||stale||options.current&&options.current()!==undefined)throw new ReadSourceError('stale');
      if(realpathSync(root)!==root||realpathSync(database)!==database)throw new ReadSourceError('stale');
      for(const [fd,p,before,dir]of [[rootFD,root,rootStat,true],[dbFD,database,dbStat,false]]as const){const held=fstatSync(fd,{bigint:true}),now=lstatSync(p,{bigint:true});safe(held,dir);safe(now,dir);if(identity(held)!==identity(before)||identity(now)!==identity(before))throw new ReadSourceError('stale');}
      return undefined;
    }catch{stale=true;throw new ReadSourceError('stale');}};
    current();const proof=Object.freeze({revision:createHash('sha256').update(JSON.stringify([root,identity(rootStat),database,identity(dbStat)])).digest('hex')});
    realms.set(proof,{root,database,identity:identity(dbStat),current,release:()=>{if(!released){released=true;let failed=false;for(const fd of fds)try{closeSync(fd);}catch{failed=true;}if(failed)releaseError=new ReadSourceError('offline');}if(releaseError)throw releaseError;return undefined;}});transferred=true;return proof;
  }catch(error){if(error instanceof ReadSourceError)throw error;throw new ReadSourceError('offline');}
  finally{if(!transferred)for(const fd of fds)try{closeSync(fd);}catch{}}
}
export function currentReadRealm(proof:ProtectedReadRealm):undefined{const v=realms.get(proof);if(!v)throw new ReadSourceError('invalid');return v.current();}
export function readRealmOverride(proof:ProtectedReadRealm):string{const v=realms.get(proof);if(!v)throw new ReadSourceError('invalid');v.current();return `sqlite_home=${JSON.stringify(v.root)}`;}
export function releaseReadRealm(proof:ProtectedReadRealm):undefined{const v=realms.get(proof);if(!v)throw new ReadSourceError('invalid');return v.release();}
/** Caller supplies only its exact spawned process via the source WeakMap gate.
 * No PID/file inspector is exposed through IPC. Actual open REG FD dev+ino and
 * canonical path must match the retained database, not merely an empty list.
 * This is a current snapshot, not kernel generation or future continuity. */
export function attestReadRealmProcess(proof:ProtectedReadRealm,child:ChildProcess,current:()=>undefined):undefined{
  const v=realms.get(proof);if(!v)throw new ReadSourceError('invalid');
  const check=()=>{current();v.current();if(!child.pid||child.exitCode!==null||child.signalCode!==null||child.killed)throw new ReadSourceError('offline');};
  check();let output:string;
  try{output=execFileSync('/usr/sbin/lsof',['-nP','-a','-p',String(child.pid),'-FpfDitn'],{encoding:'utf8',timeout:5000,maxBuffer:4*1024*1024,env:{PATH:'/usr/bin:/bin',LANG:'C'}});}catch{check();throw new ReadSourceError('offline');}
  check();let pid=false,fd:Record<string,string>={},found=false,bad=false;
  const flush=()=>{if(fd.n===v.database){if(!pid||!/^\d+[rwu]?$/.test(fd.f??'')||fd.t!=='REG'||!/^0x[0-9a-f]+$/i.test(fd.D??'')||!/^\d+$/.test(fd.i??'')||`${BigInt(fd.D)}:${BigInt(fd.i)}`!==v.identity)bad=true;else found=true;}else if(fd.n?.endsWith('/state_5.sqlite'))bad=true;};
  for(const line of output.split('\n')){const key=line[0],value=line.slice(1);if(key==='p'){flush();fd={};pid=value===String(child.pid);}else if(key==='f'){flush();fd={f:value};}else if(['D','i','t','n'].includes(key))fd[key]=value;}flush();
  check();if(!found||bad)throw new ReadSourceError('offline');return undefined;
}
