// Research-only observation of the real services used by the isolated Android
// fixture. No input text, bearer, nonce or packet contents are recorded.
import {MaterialInputReader} from '../../packages/device/src/collaboration/material-input-reader';
import {MaterialAssetStore} from '../../packages/device/src/collaboration/material-store';
import {AsyncLocalStorage} from 'node:async_hooks';import {appendFileSync,mkdirSync} from 'node:fs';import {join} from 'node:path';
import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
import {MaterialInputService} from '../../packages/core/src/collaboration/material-input-service';
import {MaterialTargetProvider} from '../../packages/core/src/collaboration/material-target-provider';
import {MaterialReceiverProvider} from '../../packages/device/src/collaboration/material-receiver-provider';
import {EdgeRouter} from '../../packages/core/src/server';
const evidence=process.env.ASH_PROJECT_ANDROID_EVIDENCE??'docs/evidence/project-first-send-local-20261013';mkdirSync(evidence,{recursive:true});process.env.ASH_PROJECT_ANDROID_EVIDENCE=evidence;process.env.ASH_PROJECT_ANDROID_OUT??='build/project-first-send-local-20261013';
const context=new AsyncLocalStorage<{call:number;stage:string}>();let call=0;
const runId=`host-${process.pid}-${Date.now()}`;
const record=(value:unknown)=>appendFileSync(join(evidence,process.env.ASH_PROJECT_ANDROID_STAGE_FILE??'stages.jsonl'),JSON.stringify({run_id:runId,host_pid:process.pid,at_ms:Math.round(performance.now()),...value as object})+'\n');
const handle=EdgeRouter.prototype.handle;
EdgeRouter.prototype.handle=async function(...args:Parameters<typeof handle>){const req=args[0],path=req.url.pathname,id=++call,start=performance.now(),abort=()=>record({event:'http_abort',call:id,path,ms:Math.round(performance.now()-start)});req.signal?.addEventListener('abort',abort,{once:true});record({event:'http_begin',call:id,path});try{return await context.run({call:id,stage:path},async()=>{const result=await handle.apply(this,args);record({event:'http_end',call:id,path,status:result.status,aborted:req.signal?.aborted??false,ms:Math.round(performance.now()-start)});return result;});}finally{req.signal?.removeEventListener('abort',abort);}};
for(const [prototype,names] of [[MaterialInputReader.prototype,['read']],[MaterialAssetStore.prototype,['readChunk']],[MaterialInputService.prototype,['submit','transfer','target','projection','control','edge']],[MaterialTargetProvider.prototype,['captureTarget']],[MaterialReceiverProvider.prototype,['capture','resolve']]] as const){
 for(const stage of names){const original=(prototype as any)[stage];if(typeof original!=='function')throw Error('Missing observed method '+stage);
  (prototype as any)[stage]=async function(...args:unknown[]){const id=++call,parent=context.getStore()?.call,start=performance.now();record({event:'begin',call:id,parent,stage});return context.run({call:id,stage},async()=>{try{const result=await original.apply(this,args);record({event:'end',call:id,parent,stage,ms:Math.round(performance.now()-start),ok:true});return result;}catch(error){record({event:'end',call:id,parent,stage,ms:Math.round(performance.now()-start),ok:false,code:(error as any).code??'unknown'});throw error;}});};
 }
}
const original=childProcess.execFileSync;
childProcess.execFileSync=((...args:Parameters<typeof original>)=>{const start=performance.now();try{return original(...args);}finally{record({event:'command',parent:context.getStore()?.call,stage:args[0]==='lsof'?'listener':Array.isArray(args[1])&&args[1].includes('--version')?'version':'other',ms:Math.round(performance.now()-start)});}})as typeof original;syncBuiltinESMExports();
await import('./project-android-host');
