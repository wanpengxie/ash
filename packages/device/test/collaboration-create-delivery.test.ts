import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { CreateOperationStore } from "../src/collaboration/create-operation-store";
import { CreateDeliveryJournal } from "../src/collaboration/create-delivery";
import { createPayloadHash, toCreateFactDto } from "../src/collaboration/create-protocol";
import { CollaborationCreateError, type CreateAdapter, type CreateLease, type CreateOutcome, type CreateStage, type CreateWorkRequest } from "../src/collaboration/create-types";
const request: CreateWorkRequest = { version:1,request_id:'r',operation_id:'op',authorization_revision:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',target:{node_id:'node',endpoint_id:'ep',project_id:'project',cwd:'/workspace'},title:'Private title',input:{text:'PRIVATE BODY'},expires_at:4102444800000 };
const work = {node_id:'node',endpoint_id:'ep',kind:'conversation' as const,native_id:'thread'};
function lease(extra: Partial<CreateLease> = {}): CreateLease { return { principal:{principal_id:'owner'},authorized_scope:Object.freeze({node_id:'node',endpoint_id:'ep',cwd:'/workspace'}),target:request.target,authorization_revision:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',connector_epoch:'epoch',native_interface_version:'v1',authorize:async()=>true,run:async(_purpose,fn)=>fn(), ...extra }; }
const accepted = (stage: CreateStage): CreateOutcome => ({status:'accepted',receipt:stage==='first_input'?{stage,accepted_by:'native',work,native_turn_id:'turn',native_message_id:null,correlation:'uncertain'}:{stage,accepted_by:'native',work}});
function adapter(extra: Partial<CreateAdapter> = {}): CreateAdapter { return { connector_epoch:'epoch',native_interface_version:'v1',projects:async()=>[],resolveProject:async t=>t,metadata:async()=>({work,cwd:'/workspace'}),createThread:async()=>accepted('create'),nameThread:async()=>accepted('name'),startFirstInput:async()=>accepted('first_input'),history:async()=>({items:[],next_cursor:null,observed_at:new Date().toISOString(),source:'codex.saved_history',completeness:'source_page',runtime_state:'unknown'}), ...extra }; }
async function folder(t: any) { const dir=await mkdtemp(join(tmpdir(),'ash-create-')); t.after(()=>rm(dir,{recursive:true,force:true})); return {file:join(dir,'create.db'),calls:join(dir,'calls')}; }
const isCode = (code:string) => (e:unknown) => e instanceof CollaborationCreateError && e.code===code;
const worker = fileURLToPath(new URL('./fixtures/collaboration-create-worker.mjs',import.meta.url));
function child(file:string,calls:string,stage:string,window:string,hold='none') {
  const p=spawn(process.execPath,['--import','tsx',worker,file,calls,stage,window,hold],{stdio:['ignore','pipe','pipe']}); let output='',error='';
  p.stdout.on('data',c=>output+=c); p.stderr.on('data',c=>error+=c);
  const done=new Promise<{code:number|null,error:string}>((resolve,reject)=>{p.on('error',reject);p.on('exit',code=>resolve({code,error}));});
  return {p,done, async waitInvoking() { if(output.includes('invoking'))return; await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{p.kill();reject(new Error(error||'worker stalled'));},5000); const onData=()=>{if(output.includes('invoking')){clearTimeout(timer);p.stdout.off('data',onData);resolve();}};p.stdout.on('data',onData);}); }};
}
async function calls(file:string) { try{return (await readFile(file,'utf8')).trim().split('\n').filter(Boolean);}catch{return [];} }

test('each durable phase crash window survives SQLite reopen without replay',async t=>{
  for(const stage of ['create','name','first_input'] as const) for(const window of ['before_claim','after_claim','after_native','after_saved']) await t.test(stage+'/'+window,async st=>{
    const f=await folder(st); const c=await child(f.file,f.calls,stage,window).done;assert.equal(c.code,70,c.error);
    const store=new CreateOperationStore(f.file);const before=store.get('owner','op')!;toCreateFactDto(before);
    assert.equal(before[stage].status,window==='before_claim'?'not_started':window==='after_saved'?'accepted':'unknown');
    if(stage!=='create')assert.deepEqual(before.work,work);
    const original=await calls(f.calls);const observed:string[]=[];
    const j=new CreateDeliveryJournal({store,adapter:adapter({createThread:async()=>{observed.push('create');return accepted('create');},nameThread:async()=>{observed.push('name');return accepted('name');},startFirstInput:async()=>{observed.push('first_input');return accepted('first_input');}})});
    await j.query(lease(),'op');assert.equal(observed.length,0);
    await j.apply(lease(),request);
    if(window==='after_claim'||window==='after_native')assert.equal(observed.length,0);
    else assert.ok(!observed.some(s=>original.includes(s)));
    j.close();
  });
});
test('alive process retains invoking and other process cannot claim or close owner attempt',async t=>{
  const f=await folder(t);const c=child(f.file,f.calls,'none','none','create');await c.waitInvoking();
  const store=new CreateOperationStore(f.file);const j=new CreateDeliveryJournal({store,adapter:adapter({createThread:async()=>{assert.fail('replayed');}})});
  assert.equal((await j.apply(lease(),request)).create.status,'invoking');
  assert.throws(()=>store.finish(store.get('owner','op')!,'create',accepted('create'),Date.now()),isCode('conflict'));
  c.p.kill('SIGKILL');await c.done;store.recoverAbandoned();assert.equal(store.get('owner','op')!.create.status,'unknown');j.close();
});
test('FULL durable intent/client ID are present before each native call; concurrent same key invokes once',async t=>{
  const f=await folder(t),store=new CreateOperationStore(f.file),peer=new CreateOperationStore(f.file);let release!:()=>void;
  const wait=new Promise<void>(r=>release=r);let creations=0;
  const a=adapter({createThread:async invocation=>{creations++; const fact=peer.get('owner','op')!; assert.equal(fact.create.status,'invoking');assert.equal(fact.create.attempt_id,invocation.attempt_id);await wait;return accepted('create');},nameThread:async invocation=>{assert.equal(peer.get('owner','op')!.name.attempt_id,invocation.attempt_id);return accepted('name');},startFirstInput:async invocation=>{assert.equal(peer.get('owner','op')!.native_client_message_id,invocation.native_client_message_id);return accepted('first_input');}});
  const j=new CreateDeliveryJournal({store,adapter:a});const first=j.apply(lease(),request);
  for(let n=0;!creations && n<1000;n++)await new Promise(r=>setTimeout(r,1)); assert.equal(creations,1);
  assert.throws(()=>j.close(),isCode('busy'));assert.throws(()=>store.close(),isCode('busy'));
  const p=new CreateDeliveryJournal({store:peer,adapter:a});assert.equal((await p.apply(lease(),request)).create.status,'invoking');release();
  const final=await first;assert.equal(final.first_input.status,'accepted');assert.equal(creations,1);j.close();p.close();
  const raw=await readFile(f.file);assert.ok(!raw.includes(Buffer.from('PRIVATE BODY')));assert.ok(!raw.includes(Buffer.from('Private title')));
});
test('name failure retains created work and blocks first input; malformed receipt becomes unknown',async t=>{
  for(const malformed of [false,true])await t.test(String(malformed),async st=>{
    const f=await folder(st),store=new CreateOperationStore(f.file);let first=0;
    const j=new CreateDeliveryJournal({store,adapter:adapter({nameThread:async()=>malformed?accepted('create'):{status:'rejected',code:'offline'},startFirstInput:async()=>{first++;return accepted('first_input');}})});
    const fact=await j.apply(lease(),request);assert.deepEqual(fact.work,work);assert.equal(fact.name.status,malformed?'unknown':'rejected');assert.equal(fact.first_input.status,'not_started');
    await j.apply(lease(),request);assert.equal(first,0);j.close();
  });
});
test('expired partial work cannot advance, changed body conflicts, fresh grant cannot reuse old fact',async t=>{
  const f=await folder(t),store=new CreateOperationStore(f.file);let now=1;
  const r={...request,expires_at:100}; const j=new CreateDeliveryJournal({store,now:()=>now,adapter:adapter({createThread:async()=>{now=100;return accepted('create');}})});
  await assert.rejects(j.apply(lease(),r),isCode('expired'));assert.equal(store.get('owner','op')!.create.status,'accepted');
  assert.equal((await j.query(lease(),'op'))!.work!.native_id,'thread');
  await assert.rejects(j.apply(lease(),{...r,input:{text:'different'}}),isCode('conflict'));
  await assert.rejects(j.query(lease({authorization_revision:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}),'op'),isCode('permission_denied'));j.close();
});
test('authorization revoked during native acceptance saves receipt before denying response',async t=>{
  const f=await folder(t),store=new CreateOperationStore(f.file);let allowed=true;
  const l=lease({authorize:async()=>allowed});const j=new CreateDeliveryJournal({store,adapter:adapter({createThread:async()=>{allowed=false;return accepted('create');}})});
  await assert.rejects(j.apply(l,request),isCode('permission_denied'));assert.equal(store.get('owner','op')!.create.status,'accepted');assert.equal(store.get('owner','op')!.name.status,'not_started');j.close();
});
test('failed native receipt commit drains exact ended attempt on reopen without invoking again',async t=>{
  const f=await folder(t),store=new CreateOperationStore(f.file);store.record('owner',request,createPayloadHash(request),1);
  const fact=store.claim('owner','op','create','epoch',2,'v1').fact;
  const lock=new DatabaseSync(f.file);lock.exec('BEGIN IMMEDIATE');
  assert.throws(()=>store.finish(fact,'create',accepted('create'),3),isCode('storage_failure'));
  assert.throws(()=>store.close(),isCode('storage_failure'));lock.exec('ROLLBACK');lock.close();
  const reopen=new CreateOperationStore(f.file);assert.equal(reopen.get('owner','op')!.create.status,'accepted');
  assert.equal(reopen.claim('owner','op','create','epoch',4,'v1').claimed,false);reopen.close();
});
test('capacity retains dedup keys and future schema fails closed without mutation',async t=>{
  const f=await folder(t),store=new CreateOperationStore(f.file,1);store.record('owner',request,createPayloadHash(request),1);
  assert.throws(()=>store.record('owner',{...request,operation_id:'other'},'hash',2),isCode('too_large'));
  assert.equal(store.record('owner',request,createPayloadHash(request),3).operation_id,'op');store.close();
  const db=new DatabaseSync(f.file);db.exec('PRAGMA user_version=900');db.close();assert.throws(()=>new CreateOperationStore(f.file),isCode('storage_failure'));
  const inspect=new DatabaseSync(f.file);assert.equal((inspect.prepare('PRAGMA user_version').get() as any).user_version,900);inspect.close();
});
test('bounded stable history association enriches unknown; ambiguous and cyclic pages never invent acceptance',async t=>{
  for(const mode of ['stable','ambiguous','cycle','text_only'])await t.test(mode,async st=>{
    const f=await folder(st),store=new CreateOperationStore(f.file);
    const j=new CreateDeliveryJournal({store,adapter:adapter({startFirstInput:async()=>{throw new Error('lost reply');}})});const fact=await j.apply(lease(),request);assert.equal(fact.first_input.status,'unknown');
    let reads=0;
    const r=new CreateDeliveryJournal({store,adapter:adapter({history:async()=>{reads++;const message={work,turn_id:'turn',source_message_id:'message',role:'user' as const,text:request.input.text,...(mode==='text_only'?{}:{source_client_message_id:fact.native_client_message_id!})};return {items:[{turn_id:'turn',history_status:null,status_source:'codex.saved_history',messages:mode==='ambiguous'?[message,{...message,source_message_id:'other'}]:[message]}],next_cursor:mode==='stable'?'more'+reads:mode==='cycle'?'cycle':null,observed_at:new Date().toISOString(),source:'codex.saved_history',completeness:'source_page',runtime_state:'unknown'};}})});
    const result=await r.reconcile(lease(),'op');assert.equal(result!.first_input.status,mode==='stable'?'accepted':'unknown');
    if(mode==='stable'){assert.equal(result!.reconciliation!.pages_observed,4);assert.equal(result!.reconciliation!.history_exhausted,false);}assert.ok(reads<=4);j.close();
  });
});

test('simultaneous process startup and apply use one durable attempt per phase',async t=>{
  const f=await folder(t);const outcomes=await Promise.all([child(f.file,f.calls,'none','none').done,child(f.file,f.calls,'none','none').done]);
  for(const result of outcomes)assert.equal(result.code,0,result.error);
  assert.deepEqual(await calls(f.calls),['create','name','first_input']);
  const store=new CreateOperationStore(f.file);assert.equal(store.get('owner','op')!.first_input.status,'accepted');store.close();
});
test('CAS protects original attempts and conservative live PID/EPERM recovery',async t=>{
  const f=await folder(t),store=new CreateOperationStore(f.file);store.record('owner',request,createPayloadHash(request),1);
  const first=store.claim('owner','op','create','epoch',2,'v1').fact;
  const fake=structuredClone(first);fake.create.attempt_id='other-attempt';assert.throws(()=>store.finish(fake,'create',accepted('create'),3),isCode('conflict'));
  assert.equal(store.claim('owner','op','create','new-epoch',100000,'v2').claimed,false);
  const kill=process.kill;process.kill=(()=>{throw Object.assign(new Error(),{code:'EPERM'});}) as typeof process.kill;
  try{store.recoverAbandoned();assert.equal(store.get('owner','op')!.create.status,'invoking');}finally{process.kill=kill;}
  store.finish(first,'create',accepted('create'),3);assert.throws(()=>store.finish(first,'create',null,4),isCode('conflict'));store.close();
});
test('query never advances idle work and revocation during read prevents facts',async t=>{
  const f=await folder(t),store=new CreateOperationStore(f.file);store.record('owner',request,createPayloadHash(request),1);let writes=0;
  const j=new CreateDeliveryJournal({store,adapter:adapter({createThread:async()=>{writes++;return accepted('create');}})});
  assert.equal((await j.query(lease(),'op'))!.create.status,'not_started');await j.reconcile(lease(),'op');assert.equal(writes,0);
  let checks=0;await assert.rejects(j.query(lease({authorize:async()=>++checks<2}),'op'),isCode('permission_denied'));j.close();
});

test('record-only crash windows leave no native calls and explicit apply can advance idle phases',async t=>{
  for(const window of ['before_record','after_record'])await t.test(window,async st=>{
    const f=await folder(st),c=await child(f.file,f.calls,'create',window).done;assert.equal(c.code,70,c.error);assert.deepEqual(await calls(f.calls),[]);
    const store=new CreateOperationStore(f.file),j=new CreateDeliveryJournal({store,adapter:adapter()});const before=await j.query(lease(),'op');
    assert.equal(before?.create.status??null,window==='before_record'?null:'not_started');assert.equal((await j.apply(lease(),request)).first_input.status,'accepted');j.close();
  });
});

test('all adapter contexts carry frozen independent grant scope and mutable lease drift denies output',async t=>{
  const f=await folder(t),store=new CreateOperationStore(f.file);const l=lease();let writes=0;
  const granted={node_id:'node',endpoint_id:'ep',cwd:'/workspace'};
  const j=new CreateDeliveryJournal({store,adapter:adapter({resolveProject:async(target,context)=>{
    assert.notEqual(context.authorized_scope,target);assert.deepEqual(context.authorized_scope,granted);assert.ok(Object.isFrozen(context.authorized_scope));assert.ok(Object.isFrozen(context));
    assert.equal(await context.authorize(),true);
    (l as any).authorized_scope={...granted,cwd:'/foreign'};return target;
  },createThread:async()=>{writes++;return accepted('create');}})});
  await assert.rejects(j.apply(l,request),isCode('permission_denied'));assert.equal(writes,0);assert.equal(store.get('owner','op')!.create.status,'not_started');j.close();
});
test('foreign grant/source scope and after-history cwd switching never return reconciliation facts',async t=>{
  for(const mode of ['foreign_grant','foreign_metadata','foreign_history','cwd_after_history'])await t.test(mode,async st=>{
    const f=await folder(st),store=new CreateOperationStore(f.file);const initial=new CreateDeliveryJournal({store,adapter:adapter({startFirstInput:async()=>{throw new Error('lost');}})});
    const fact=await initial.apply(lease(),request);let historyRead=false;
    const r=new CreateDeliveryJournal({store,adapter:adapter({metadata:async(_work,context)=>{
      assert.deepEqual(context.authorized_scope,{node_id:'node',endpoint_id:'ep',cwd:'/workspace'});
      return {work,cwd:mode==='foreign_metadata'||mode==='cwd_after_history'&&historyRead?'/foreign':'/workspace'};
    },history:async(_work,context)=>{
      assert.deepEqual(context.authorized_scope,{node_id:'node',endpoint_id:'ep',cwd:'/workspace'});historyRead=true;
      return {items:[{turn_id:'turn',history_status:null,status_source:'codex.saved_history',messages:[{work:mode==='foreign_history'?{...work,node_id:'foreign'}:work,turn_id:'turn',source_message_id:'message',source_client_message_id:fact.native_client_message_id!,role:'user',text:'unreturned foreign text'}]}],next_cursor:null,observed_at:new Date().toISOString(),source:'codex.saved_history',completeness:'source_page',runtime_state:'unknown'};
    }})});
    const l=mode==='foreign_grant'?lease({authorized_scope:Object.freeze({node_id:'node',endpoint_id:'ep',cwd:'/foreign'})}):lease();
    await assert.rejects(r.reconcile(l,'op'),isCode('permission_denied'));assert.equal(store.get('owner','op')!.first_input.status,'unknown');initial.close();
  });
});
test('lease scope/revision/identity mutation during final async authorization denies saved output',async t=>{
  const f=await folder(t),store=new CreateOperationStore(f.file);store.record('owner',request,createPayloadHash(request),1);let checks=0;
  const l=lease({authorize:async()=>{checks++;if(checks===2){await Promise.resolve();(l as any).target={...request.target,cwd:'/foreign'};}return true;}});
  const j=new CreateDeliveryJournal({store,adapter:adapter()});await assert.rejects(j.query(l,'op'),isCode('permission_denied'));j.close();
});
test('gateway node/endpoint identities beginning with underscore and hyphen retain trusted scopes',async t=>{
  for(const prefix of ['_','-'])await t.test(prefix,async st=>{
    const f=await folder(st),store=new CreateOperationStore(f.file);
    // Explicit test grant and selected target are separately constructed.
    const grant=Object.freeze({node_id:prefix+'node',endpoint_id:prefix+'ep',cwd:'/workspace'});
    const r={...request,target:{node_id:prefix+'node',endpoint_id:prefix+'ep',project_id:'project',cwd:'/workspace'}};
    const w={node_id:prefix+'node',endpoint_id:prefix+'ep',kind:'conversation' as const,native_id:'thread'};
    const accept=(stage:CreateStage):CreateOutcome=>({status:'accepted',receipt:stage==='first_input'?{stage,accepted_by:'native',work:w,native_turn_id:'turn',native_message_id:null,correlation:'uncertain'}:{stage,accepted_by:'native',work:w}});
    const j=new CreateDeliveryJournal({store,adapter:adapter({resolveProject:async(target,context)=>{assert.deepEqual(context.authorized_scope,grant);assert.equal(await context.authorize(),true);return target;},metadata:async()=>({work:w,cwd:'/workspace'}),createThread:async()=>accept('create'),nameThread:async()=>accept('name'),startFirstInput:async()=>accept('first_input')})});
    assert.equal((await j.apply(lease({authorized_scope:grant,target:r.target}),r)).first_input.status,'accepted');j.close();
  });
});
