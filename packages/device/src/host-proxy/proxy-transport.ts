import type { PreparedMaterialInput } from "../collaboration/material-input-reader";
import type { Invocation } from "../collaboration/control-types";
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { SupervisorRoleAuthority } from "./supervisor-role-authority";
import { PrivateRoleListeners } from "./role-listener";
import { CodexTransport, type CodexTransportOptions } from "../collaboration/codex-transport";
import { CodexCreateTransport } from "../collaboration/codex-create-transport";
import type { ListenerFactory, ListenerPort, Role, NativeFactory, RegistryPort, RoleAuthority, RoleLease } from "./types";
interface Receipt { port:ListenerPort; path:string; inode:string; fd:string; boundPath:string }
const run=(args:string[])=>execFileSync("/usr/sbin/lsof",args,{encoding:"utf8",timeout:5000,maxBuffer:1024*1024,env:{PATH:"/usr/bin:/bin",LANG:"C"}});
function socketStamp(path:string){const s=lstatSync(path);if(realpathSync(path)!==path||!s.isSocket()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077))throw Error("proxy socket unavailable");return`${s.dev}:${s.ino}:${s.ctimeMs}`;}
/** The factory owns construction, so the fd/path delta binds the real frozen hard-link listener to its fixed role inode. */
export class AttestedProxyListeners implements ListenerFactory {
 private readonly physical:PrivateRoleListeners;private receipts=new Map<Role,Receipt>();private opening=false;private readonly executable=realpathSync(process.execPath);
 constructor(private readonly directory:string,private readonly generation:string,private readonly register:(role:Role,identity:string,current:()=>boolean)=>void){this.physical=new PrivateRoleListeners(directory);}
 private inventory(){const rows=run(["-nP","-a","-p",String(process.pid),"-Fftn"]).split("\n"),bound=new Map<string,string>();let fd="",mapped=false;for(const row of rows){if(row.startsWith("f"))fd=row.slice(1);else if(row.startsWith("n")){const path=row.slice(1);if(fd==="txt"&&path===this.executable)mapped=true;if(path.startsWith(`${this.directory}/.hp-`))bound.set(fd,path);}}return{bound,mapped};}
 async open(role:Role,accept:Parameters<ListenerFactory["open"]>[1],signal:AbortSignal):Promise<ListenerPort>{if(this.opening||this.receipts.has(role))throw Error("proxy listener unavailable");this.opening=true;let port:ListenerPort|undefined;try{const first=this.inventory();if(!first.mapped)throw Error("proxy executable unavailable");const before=first.bound;port=await this.physical.open(role,accept,signal);const last=this.inventory();if(!last.mapped)throw Error("proxy executable unavailable");const after=last.bound,added=[...after].filter(([fd,path])=>before.get(fd)!==path);if(added.length!==1)throw Error("proxy listener owner unavailable");const[fd,boundPath]=added[0],path=join(this.directory,`${role}.sock`);const receipt={port,path,inode:socketStamp(path),fd,boundPath};this.receipts.set(role,receipt);const current=()=>this.current(role,port!.identity);this.register(role,port.identity,current);if(!current()||signal.aborted)throw Error("proxy listener evidence changed");const owned=port;return{role,identity:owned.identity,current,close:async()=>{this.receipts.delete(role);await owned.close();}};}catch{await port?.close();this.receipts.delete(role);throw Error("proxy listener evidence unavailable");}finally{this.opening=false;}}
 current(role:Role,identity:string){try{const r=this.receipts.get(role),inventory=this.inventory();return!!r&&r.port.identity===identity&&r.port.current()&&socketStamp(r.path)===r.inode&&inventory.mapped&&inventory.bound.get(r.fd)===r.boundPath;}catch{return false;}}
 evidence(role:Role){const r=this.receipts.get(role);if(!r||!this.current(role,r.port.identity))throw Error("proxy listener unavailable");return{socket:r.path,pid:process.pid,executable:this.executable,identity:`${this.generation}:${r.port.identity}:${r.inode}:${r.fd}:${r.boundPath}`};}
}
/** Production use of the old verification hook: both proxy OS ownership and the original native proof are mandatory. */
export class ProxyTransportFactory {
 constructor(private readonly listeners:AttestedProxyListeners,private readonly native:NativeFactory,private readonly registry:RegistryPort,private readonly roles:RoleAuthority){}
 options(lease:RoleLease):CodexTransportOptions{const native=this.native.identity(),registryEpoch=this.registry.epoch(),roleEpoch=this.roles.epoch(lease),listener=this.listeners.evidence("device");if(lease.role!=="device")throw Error("device transport scope unavailable");const verify=()=>{const currentLease=this.roles instanceof SupervisorRoleAuthority?this.roles.transportLease(lease):lease;if(!this.native.current(native)||!this.registry.current()||this.registry.epoch()!==registryEpoch||!this.roles.current(currentLease)||(currentLease===lease&&this.roles.epoch(lease)!==roleEpoch))throw Error("proxy transport generation unavailable");const now=this.listeners.evidence("device");if(now.identity!==listener.identity)throw Error("proxy listener generation unavailable");return{...now,version:native.version,identity:`${now.identity}:${native.identity}:${native.generation}:${registryEpoch}:${roleEpoch}`};};verify();return{socket:listener.socket,pid:listener.pid,executable:listener.executable,supportedVersions:[native.version],verifyListener:verify};}
 bindTextInput(lease:RoleLease,invocation:Invocation):undefined{this.options(lease).verifyListener!();if(!(this.roles instanceof SupervisorRoleAuthority))throw Error('text authority unavailable');return this.roles.bindTextInput(this.roles.transportLease(lease),invocation);}
 bindPreparedInput(lease:RoleLease,proof:PreparedMaterialInput,invocation:Invocation):undefined{this.options(lease).verifyListener!();if(!(this.roles instanceof SupervisorRoleAuthority))throw Error('material authority unavailable');return this.roles.bindPreparedInput(this.roles.transportLease(lease),proof,invocation);}
 control(lease:RoleLease){return new CodexTransport(this.options(lease));}
 create(lease:RoleLease){return new CodexCreateTransport(this.options(lease));}
}
