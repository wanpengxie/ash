import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createCollaborationService} from '../src/services/collaboration/service';
import {createRegistry} from '../src/kernel/registry';
import type {HandRegistry} from '../src/edges/link-server/hands/registry';
import type {HandleContext,Message} from '../../sdk/src/message';
import type {Router} from '../src/kernel/types';
const revision='a'.repeat(64);
const input={version:1,device_id:'device:pc',endpoint_id:'pc',authorization_generation:1,authorization_revision:revision,action:'list_work'};
function fixture(){
 const registry=createRegistry();let online=true,connected=true,revoked=false,manifestRev=1;const calls:string[]=[];
 const h=(id:string)=>({id,name:id,kind:id==='pc'?'computer':'phone',public_key:id,paired_at:1,lend:true,web_ui:true,revoked_at:revoked?1:null,manifest_rev:manifestRev,manifest_hash:'hash'});
 const hands={get:h,online:()=>online} as unknown as HandRegistry;
 registry.add({id:'device:pc',kind:'device',name:'computer',words:()=>['collaboration.endpoint.describe','collaboration.work.list','collaboration.work.read'].map(word=>({member:'device:pc',word,kind:'request',direction:'in',description:'Read authorized computer coworker history.',input_schema:{type:'object'},effect:'read',risk:'none',callers:['owner'],label:{doing:'读取'}})),handle:async()=>({})});
 let after:((word:string)=>void)|undefined;
 const router={send:async(out,caller)=>{calls.push(out.word);assert.equal(caller.member,'person:owner');assert.equal(caller.via,'human');const data=out.word.endsWith('describe')?{collaboration:{version:1,node_id:'pc',endpoint_id:'pc',adapter:'desktop/codex',authorization_state:'ready',authorization_generation:1,authorization_revision:revision,runtime_availability:'unknown',scope_kind:'exact_cwd',source:'codex.saved_history',runtime_state:'unknown',control:'unsupported'}}:{items:[],next_cursor:null,observed_at:new Date().toISOString(),completeness:'source_page',source:'codex.saved_history',runtime_state:'unknown'};after?.(out.word);return {ok:true,result:{content:[],data}};}} as Pick<Router,'send'>;
 const service=createCollaborationService({registry,hands,router,currentClient:()=>connected});
 const context:HandleContext={signal:new AbortController().signal,caller:{member:'person:owner',via:'human',local:false,client:'client:phone',origin:{hand:'device:phone',channel:'app',client:'client:phone',label:'phone'}},raw:input};
 const run=(word:string,body:unknown=input,ctx:HandleContext=context)=>service.handle({word,body} as Message,{...ctx,raw:body});
 return {run,calls,context,revoke:()=>{revoked=true;},disconnect:()=>{connected=false;},offline:()=>{online=false;},onCall:(fn:(word:string)=>void)=>{after=fn;},replaceManifest:()=>{manifestRev++;}};
}
test('authenticated remote human discovery and read use device words with the owner caller',async()=>{const f=fixture();const endpoints:any=await f.run('collaboration.endpoints',{});assert.equal(endpoints.data.targets[0].device_id,'device:pc');assert.match(endpoints.data.auth_scope,/^[a-f0-9]{64}$/);const read:any=await f.run('collaboration.read');assert.deepEqual(read.data.page.items,[]);assert.equal(read.data.auth_scope,endpoints.data.auth_scope);assert.deepEqual(f.calls,['collaboration.endpoint.describe','collaboration.endpoint.describe','collaboration.work.list','collaboration.endpoint.describe']);});
test('body identity cannot authorize a service caller, closed channel, or revoked owner',async()=>{const f=fixture();await assert.rejects(f.run('collaboration.read',input,{...f.context,caller:{member:'service:evil',via:'service',local:true}}),/permission_denied/);assert.equal(f.calls.length,0);f.disconnect();await assert.rejects(f.run('collaboration.read'),/permission_denied/);const revoked=fixture();revoked.revoke();await assert.rejects(revoked.run('collaboration.read'),/permission_denied/);});
test('manifest replacement or owner disconnect during device await suppresses the return',async()=>{for(const change of ['manifest','owner']){const f=fixture();f.onCall(word=>{if(word==='collaboration.work.list'){if(change==='manifest')f.replaceManifest();else f.disconnect();}});await assert.rejects(f.run('collaboration.read'),/permission_denied/);}});
test('stale device authorization is rejected before native read and offline device fails',async()=>{const f=fixture();await assert.rejects(f.run('collaboration.read',{...input,authorization_revision:'b'.repeat(64)}),/permission_denied/);assert.deepEqual(f.calls,['collaboration.endpoint.describe']);const offline=fixture();offline.offline();await assert.rejects(offline.run('collaboration.read'),/offline/);});
