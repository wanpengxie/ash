import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DeviceKey } from 'ash-gateway/client/client';
import { readLocalStateFile } from '../collaboration/local-state';
import { callConnectionSetup, type SetupSelection } from './material-ipc';
import type { ConnectionSetupService } from './service';

type Status=Awaited<ReturnType<ConnectionSetupService['scopeStatus']>>;
export type ShellRequest={id:string;method:'status'|'choose-directory'|'prepare'|'apply';body:unknown};
export type ShellResponse={id:string;ok:true;result:unknown}|{id:string;ok:false;error:{code:string}};
const MAX=64*1024;
const fail=(code='invalid'):never=>{throw Object.assign(new Error(code),{code});};
function object(v:unknown,keys:string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))fail();return v as Record<string,unknown>;}
function exact(v:unknown,keys:string[]){const r=object(v,keys);if(keys.some(k=>!Object.hasOwn(r,k)))fail();return r;}
function identifier(v:unknown):string{if(typeof v!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(v))fail();return v as string;}
function dirIdentity(path:string):string{const s=lstatSync(path);if(!isAbsolute(path)||realpathSync(path)!==path||!s.isDirectory()||s.isSymbolicLink())fail();return `${s.dev}:${s.ino}`;}
function protectedDirectory(path:string):string{const s=lstatSync(path);if(s.uid!==process.getuid?.()||(s.mode&0o077)!==0)fail('unavailable');return dirIdentity(path);}
function protectedFile(path:string,max:number){const s=lstatSync(path);if(s.uid!==process.getuid?.()||(s.mode&0o077)!==0||!s.isFile()||s.isSymbolicLink())fail('unavailable');const f=readLocalStateFile(path,max);if(!f)fail('unavailable');return f!;}
export interface ShellConnection {current():undefined;call(operation:'setup.status'|'setup.prepare'|'setup.apply',body:unknown):Promise<unknown>}
/** Trusted native-side constructor; root is never supplied by a renderer or stdio frame. */
export async function openShellConnection(root=join(homedir(),'.ash-device')):Promise<ShellConnection>{
 root=resolve(root);const rootId=protectedDirectory(root),configPath=join(root,'device.json'),configFile=protectedFile(configPath,MAX),config=JSON.parse(configFile.raw);
 if(!config||typeof config.stateDir!=='string'||!isAbsolute(config.stateDir)||realpathSync(config.stateDir)!==config.stateDir)fail('unavailable');
 const state=config.stateDir,stateId=protectedDirectory(state),keyPath=join(state,'device.jwk'),key=protectedFile(keyPath,16*1024),signer=await DeviceKey.fromJwk(JSON.parse(key.raw));
 const current=():undefined=>{if(protectedDirectory(root)!==rootId||protectedDirectory(state)!==stateId||protectedFile(configPath,MAX).identity!==configFile.identity||protectedFile(keyPath,16*1024).identity!==key.identity)fail('stale');return undefined;};current();
 return {current,async call(operation,body){current();const result=await callConnectionSetup(state,signer.id,operation as 'setup.status',body as Record<string,never>);current();return result;}};
}
/** Path ingestion is exclusively native NSOpenPanel→private stdio. Public UI uses opaque IDs. */
export class SetupShellBridge {
 private closed=false;private epoch=0;private viewEpoch=0;private pending=0;private directories=new Map<string,{path:string;identity:string}>();private status:Status|undefined;private previews=new Map<string,{hash:string;epoch:number}>();
 constructor(private readonly connection:ShellConnection){}
 close():void{this.closed=true;this.epoch++;this.previews.clear();this.directories.clear();}
 get busy(){return this.pending;}
 async dispatch(value:unknown):Promise<ShellResponse>{let id='invalid';const epoch=this.epoch;try{
  if(Buffer.byteLength(JSON.stringify(value))>MAX)fail('too_large');const request=exact(value,['id','method','body']);id=identifier(request.id);if(this.closed)fail('closed');if(this.pending>=8)fail('busy');
  const current=()=>{if(this.closed||epoch!==this.epoch)fail('closed');this.connection.current();};current();this.pending++;
  try{let result:unknown;
   if(request.method==='status'){exact(request.body,[]);result=await this.connection.call('setup.status',{});current();this.status=result as Status;this.viewEpoch++;this.previews.clear();this.directories.clear();if((this.status.read?.allowedCwds.length??0)>128)fail('too_large');const readDirectories=(this.status.read?.allowedCwds??[]).map(path=>{const directory_id=randomUUID();try{this.directories.set(directory_id,{path,identity:dirIdentity(path)});return {directory_id,path,available:true};}catch{return {directory_id,path,available:false};}});result={...this.status,readDirectories};}
   else if(request.method==='choose-directory'){
    const body=exact(request.body,['path']);if(typeof body.path!=='string'||body.path.length>4096||/[\x00-\x1f]/.test(body.path))fail();const path=resolve(body.path as string);if(path!==body.path)fail();if(this.directories.size>=128)fail('too_large');const token=randomUUID();this.directories.set(token,{path,identity:dirIdentity(path)});result={directory_id:token,path};
   }else if(request.method==='prepare'){
    if(!this.status?.precondition)fail('unpaired');const viewEpoch=this.viewEpoch;const body=object(request.body,['kind','clear','directory_ids','directory_id','actions','retain_single_work','expires_in_minutes']);let selection:SetupSelection|undefined;
    const directory=(value:unknown)=>{const entry=this.directories.get(identifier(value));if(!entry||dirIdentity(entry.path)!==entry.identity)fail('stale');return entry!.path;};
    if(body.clear===true){exact(body,['kind','clear']);if(body.kind!=='read'&&body.kind!=='control')fail();selection={kind:body.kind as 'read'|'control',clear:true};}
    else if(body.kind==='read'){exact(body,['kind','directory_ids']);if(!Array.isArray(body.directory_ids)||body.directory_ids.length>128||new Set(body.directory_ids).size!==body.directory_ids.length)fail();selection={kind:'read',allowedCwds:(body.directory_ids as unknown[]).map(directory)};}
    else if(body.kind==='control'){
     object(body,['kind','directory_id','actions','retain_single_work','expires_in_minutes']);if(!Array.isArray(body.actions)||!body.actions.length||body.actions.length>3||new Set(body.actions).size!==body.actions.length||body.actions.some(x=>!['send_input','steer','create_work'].includes(x)))fail();
     let scope:NonNullable<Status['control']>['scope'];
     if(body.retain_single_work===true){const existing=this.status!.control;if(Object.hasOwn(body,'directory_id')||existing?.scope.kind!=='single_work'||(body.actions as string[]).some(x=>!existing!.allowed_actions.includes(x as any)))fail();scope=structuredClone(existing!.scope);}
     else {if(Object.hasOwn(body,'retain_single_work'))fail();scope={kind:'exact_cwd',cwd:directory(body.directory_id)};}
     const minutes=body.expires_in_minutes;if(!Number.isSafeInteger(minutes)||(minutes as number)<1||(minutes as number)>10080)fail();let expiresAt=Date.now()+(minutes as number)*60_000;
     if(scope.kind==='single_work'&&this.status!.control?.expires_at!==undefined)expiresAt=Math.min(expiresAt,this.status!.control!.expires_at!);
     selection={kind:'control',allowedActions:body.actions as ('send_input'|'steer'|'create_work')[],scope,expiresAt};
    }else fail();
    if(!selection)fail();result=await this.connection.call('setup.prepare',{selection});current();if(viewEpoch!==this.viewEpoch)fail('stale');const p=result as {preview_id:string;selection_hash:string};if(this.previews.size>=8)this.previews.clear();this.previews.set(p.preview_id,{hash:p.selection_hash,epoch});
   }else if(request.method==='apply'){
    const body=exact(request.body,['preview_id','selection_hash']);const preview=this.previews.get(identifier(body.preview_id));if(!preview||preview.epoch!==epoch||preview.hash!==body.selection_hash)fail('stale');this.previews.delete(body.preview_id as string);result=await this.connection.call('setup.apply',body);current();this.status=result as Status;
   }else fail();current();return {id,ok:true,result};
  }finally{this.pending--;}
 }catch(error){const code=(error as {code?:string}).code??(/result_unknown/.test(String(error))?'result_unknown':'unavailable');return {id,ok:false,error:{code:['invalid','too_large','busy','closed','stale','unpaired','unavailable','storage','result_unknown'].includes(code)?code:'unavailable'}};}}
}
/** Fixed entry: newline frames, bounded admission; EOF invalidates late responses, never stops the assistant. */
export async function runShellStdio():Promise<void>{let bridge:SetupShellBridge;try{bridge=new SetupShellBridge(await openShellConnection());}catch{bridge=new SetupShellBridge({current(){fail('unavailable');},call:async()=>fail('unavailable')});}
 let bytes=Buffer.alloc(0),ended=false;const active=new Set<Promise<void>>();process.stdin.on('data',(chunk:Buffer)=>{bytes=Buffer.concat([bytes,chunk]);if(bytes.length>MAX&&!bytes.includes(10)){ended=true;bridge.close();process.stdin.destroy();return;}let newline:number;while((newline=bytes.indexOf(10))>=0){const line=bytes.subarray(0,newline);bytes=bytes.subarray(newline+1);if(line.length>MAX||active.size>=8){ended=true;bridge.close();process.stdin.destroy();return;}let value:unknown;try{value=JSON.parse(line.toString('utf8'));}catch{value={};}let raw:Promise<void>;raw=bridge.dispatch(value).then(response=>{if(!ended){const wire=JSON.stringify(response);process.stdout.write(Buffer.byteLength(wire)<=MAX?wire+'\n':JSON.stringify({id:response.id,ok:false,error:{code:'too_large'}})+'\n');}}).finally(()=>active.delete(raw));active.add(raw);}});
 process.stdin.on('end',()=>{ended=true;bridge.close();});process.stdin.on('error',()=>{ended=true;bridge.close();});}
if(process.argv[1]&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href)void runShellStdio();
