import {realpathSync,statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {closeReadSourceProcess,attestReadSourceProcess,currentReadSource,startReadSourceProcess,ReadSourceError,type ProtectedReadSource} from './read-source';

export interface SavedHistoryProbe {readonly source:'codex.saved_history';readonly source_state:'verified';readonly readCapability:'verified'|'unknown';readonly runtime_state:'unknown';}
/** Only a scoped saved-history metadata observation. Never a control/login/grant
 * proof. Verified means this configured reader answered; it does not prove
 * desktop runtime ownership. The factory child must separately attest its opened
 * SQLite FD against the explicitly selected existing physical root.
 * Native name/preview fields are discarded and no turns are requested. */
export async function probeSavedHistorySource(options:{source:ProtectedReadSource;allowedCwds?:readonly string[];current?:()=>undefined;timeoutMs?:number;signal?:AbortSignal}):Promise<SavedHistoryProbe> {
  const timeout=options.timeoutMs??5000;if(!Number.isSafeInteger(timeout)||timeout<1||timeout>15000)throw new ReadSourceError('invalid');
  const directories=new Map<string,string>();
  const directory=(p:string)=>{try{if(typeof p!=='string'||!isAbsolute(p)||/[\u0000-\u001f]/.test(p)||realpathSync(p)!==p)throw new ReadSourceError('invalid');const s=statSync(p,{bigint:true});if(!s.isDirectory())throw new ReadSourceError('invalid');return [s.dev,s.ino].join(':');}catch{throw new ReadSourceError('invalid');}};
  if(options.allowedCwds!==undefined&&!Array.isArray(options.allowedCwds))throw new ReadSourceError('invalid');
  for(const cwd of options.allowedCwds??[])directories.set(cwd,directory(cwd));
  if(directories.size>64)throw new ReadSourceError('invalid');
  const current=()=>{if(options.signal?.aborted)throw new ReadSourceError('cancelled');if(options.current&&options.current()!==undefined)throw new ReadSourceError('stale');currentReadSource(options.source);for(const[p,id]of directories)if(directory(p)!==id)throw new ReadSourceError('stale');};
  current();const process=await startReadSourceProcess(options.source),abort=()=>{void closeReadSourceProcess(options.source,process).catch(()=>{});};options.signal?.addEventListener('abort',abort,{once:true});
  process.onFrame=frame=>{if(frame.id!==undefined&&!frame.method)process.settle(frame.id,frame.result,frame.error);};
  const request=async(method:'initialize'|'thread/list',params:Record<string,unknown>)=>{current();const result=await process.request(method,params,timeout);current();if(Buffer.byteLength(JSON.stringify(result??null))>1024*1024)throw new ReadSourceError('offline');return result;};
  try {
    current();
    const init=await request('initialize',{clientInfo:{name:'ash-saved-history-probe',version:'1'},capabilities:{experimentalApi:true}});
    if(init?.userAgent?.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0]!==options.source.version)throw new ReadSourceError('unsupported');
    current();process.write({jsonrpc:'2.0',method:'initialized',params:{}});current();
    if(directories.size){const result=await request('thread/list',{limit:1,cwd:[...directories.keys()],sortKey:'updated_at',sortDirection:'desc',useStateDbOnly:true});if(!result||!Array.isArray(result.data)||result.data.length>1||result.data.some((v:any)=>!v||typeof v.id!=='string'||!v.id.length||v.id.length>1024||/[\u0000-\u001f]/.test(v.id)||!directories.has(v.cwd))||(result.nextCursor!=null&&(typeof result.nextCursor!=='string'||!result.nextCursor.length||result.nextCursor.length>1024||/[\u0000-\u001f]/.test(result.nextCursor))))throw new ReadSourceError('offline');}
    current();attestReadSourceProcess(options.source,process);current();return Object.freeze({source:'codex.saved_history',source_state:'verified',readCapability:directories.size?'verified':'unknown',runtime_state:'unknown'});
  }catch(error){current();if(error instanceof ReadSourceError)throw error;throw new ReadSourceError(/timed out|timeout/i.test(error instanceof Error?error.message:'')?'timeout':'offline');}
  finally{options.signal?.removeEventListener('abort',abort);await closeReadSourceProcess(options.source,process);current();}
}
