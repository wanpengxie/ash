import { isAbsolute, resolve } from 'node:path';
import { MaterialProtocolError } from './material-types';
import type { WorkRef } from './types';
const relayId = (v:unknown):string => { if(typeof v!=='string'||!v.length||Buffer.byteLength(v)>256||/[\x00-\x1f]/.test(v))throw new MaterialProtocolError('invalid');return v; };
const relayRecord = (v:unknown,keys:readonly string[]):Record<string,any> => {if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw new MaterialProtocolError('invalid');return v as Record<string,any>;};
export const MATERIAL_PROVIDER_REQUEST_TYPE = 'ash.material.provider.request.v1';
export const MATERIAL_PROVIDER_RESPONSE_TYPE = 'ash.material.provider.response.v1';
export interface MaterialTargetInput { work: WorkRef; authorization_revision: string; action: 'send_input'|'steer'; }
export interface MaterialTargetFacts extends MaterialTargetInput { cwd:string; generation:string; target_known:true; send_authorized:true; expires_at:number; authorized_until:number|null; }
export function parseTargetInput(value:unknown):MaterialTargetInput {
  const v=relayRecord(value,['work','authorization_revision','action']),w=relayRecord(v.work,['node_id','endpoint_id','kind','native_id']);
  if(w.kind!=='conversation'||!['send_input','steer'].includes(v.action)||typeof v.authorization_revision!=='string'||!/^[a-f0-9]{64}$/.test(v.authorization_revision))throw new MaterialProtocolError('invalid');
  return {work:{node_id:relayId(w.node_id),endpoint_id:relayId(w.endpoint_id),kind:'conversation',native_id:relayId(w.native_id)},authorization_revision:v.authorization_revision,action:v.action};
}
export function parseTargetFacts(value:unknown,now=Date.now()):MaterialTargetFacts {
  const v=relayRecord(value,['work','authorization_revision','action','cwd','generation','target_known','send_authorized','expires_at','authorized_until']);
  const input=parseTargetInput({work:v.work,authorization_revision:v.authorization_revision,action:v.action});
  if(typeof v.cwd!=='string'||Buffer.byteLength(v.cwd)>4096||!isAbsolute(v.cwd)||resolve(v.cwd)!==v.cwd||/[\x00-\x1f]/.test(v.cwd)||typeof v.generation!=='string'||!v.generation||Buffer.byteLength(v.generation)>8192||v.target_known!==true||v.send_authorized!==true||!Number.isSafeInteger(v.expires_at)||v.expires_at<=now||v.expires_at>now+30_000)throw new MaterialProtocolError('invalid');
  if(v.authorized_until!==null&&(!Number.isSafeInteger(v.authorized_until)||v.authorized_until<=now||v.expires_at>v.authorized_until))throw new MaterialProtocolError('invalid');
  return {...input,cwd:v.cwd,generation:v.generation,target_known:true,send_authorized:true,expires_at:v.expires_at,authorized_until:v.authorized_until};
}
