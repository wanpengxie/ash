import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DeviceKey } from 'ash-gateway/client/client';
import { deviceIdForKey } from 'ash-gateway/src/protocol';
import { JsonProcess } from '../src/agents/process';
import { captureProtectedReadSource,currentReadSource,releaseReadSource,readSourceDrained,readSourcePath } from '../src/collaboration/read-source';
import { CollaborationReadService } from '../src/collaboration/read-service';
import { COLLABORATION_LIST,COLLABORATION_READ } from '../src/collaboration/capabilities';
import type { CallResult } from '../src/collaboration/compat';
import type { HistoryTurn,ReadPage,WorkSummary } from '../src/collaboration/types';
const nativeFixturePath='./fixtures/read-source-native-realm.mjs';
const native=await import(nativeFixturePath);
const key=(await DeviceKey.generate()).publicKey,owner=await deviceIdForKey(key);
const context={transportOwnerId:owner,isCurrent:()=>true};
const code=(r:any)=>r.data?.code;
const tick=()=>new Promise(r=>setTimeout(r,180));
/** All rollout rows and SQLite writes are synthetic and confined to our own root. */
function seedTurns(rollout:string,project:string){
  const ids=[randomUUID(),randomUUID(),randomUUID()];
  const entries:any[]=[];
  for(const [i,id] of ids.entries()){
    const push=(type:string,payload:unknown)=>entries.push({timestamp:`2026-01-01T00:00:0${i+1}.000Z`,type,payload});
    push('event_msg',{type:'task_started',turn_id:id,model_context_window:1000,collaboration_mode_kind:'default'});
    push('turn_context',{turn_id:id,cwd:project,approval_policy:'never',sandbox_policy:{type:'read-only'},model:'synthetic',effort:null,summary:'auto'});
    push('event_msg',{type:'user_message',message:`synthetic user ${i}`,images:[],local_images:[],text_elements:[]});
    push('response_item',{type:'message',role:'user',content:[{type:'input_text',text:`synthetic user ${i}`}]});
    push('event_msg',{type:'agent_message',message:`synthetic assistant ${i}`,phase:'final_answer'});
    push('response_item',{type:'message',role:'assistant',content:[{type:'output_text',text:`synthetic assistant ${i}`}],phase:'final_answer'});
    push('event_msg',{type:'task_complete',turn_id:id,last_agent_message:`synthetic assistant ${i}`});
  }
  appendFileSync(rollout,entries.map(e=>JSON.stringify(e)).join('\n')+'\n');
  return ids;
}
test('actual fixed CLI protected service preserves list/turn pagination and same-cwd realm switch requires new grant',{skip:process.platform!=='darwin'},async()=>{
  const root=realpathSync(mkdtempSync('/tmp/ash-rrealm.'));
  let service:CollaborationReadService|undefined;
  const original=JsonProcess.prototype.request;
  const methods:string[]=[];
  try{
    const f=await native.createNativeRealmFixture(root);
    const turnIds=seedTurns(join(f.home,'synthetic-rollout.jsonl'),f.project);
    // Three threads make list pagination observable using real native cursors.
    const extraIds=[randomUUID(),randomUUID()];
    for(const[id,index]of extraIds.map((id:string,i:number)=>[id,i]as const)){
      const rollout=join(f.home,`synthetic-extra-${index}.jsonl`);
      writeFileSync(rollout,JSON.stringify({timestamp:'2026-01-01T00:00:00.000Z',type:'session_meta',payload:{id,timestamp:'2026-01-01T00:00:00.000Z',cwd:f.project,originator:'isolated-fixture',cli_version:native.FIXED_VERSION,source:'cli',model_provider:'openai'}})+'\n',{mode:0o600});
      execFileSync('python3',['-c',`import sqlite3,json,sys
v=json.load(sys.stdin);c=sqlite3.connect(v['db']);row=c.execute('SELECT * FROM threads WHERE id=?',(v['original'],)).fetchone();columns=[x[1] for x in c.execute('PRAGMA table_info(threads)')];values=dict(zip(columns,row));values.update(id=v['id'],rollout_path=v['rollout'],created_at=1767225601+v['index'],updated_at=1767225601+v['index'],recency_at=1767225601+v['index']);
for name in ['created_at_ms','updated_at_ms','recency_at_ms']:
 if name in values:values[name]=(1767225601+v['index'])*1000
c.execute('INSERT INTO threads ('+','.join(columns)+') VALUES ('+','.join('?' for _ in columns)+')',[values[x] for x in columns]);c.commit();c.close()
`],{input:JSON.stringify({db:join(f.home,'state_5.sqlite'),id,rollout,original:f.markers[0],index}),encoding:'utf8',timeout:5000,maxBuffer:4096});
    }
    writeFileSync(join(f.state,'paired.json'),JSON.stringify({owner_key:key}),{mode:0o600});
    const capture=(current?:()=>undefined)=>captureProtectedReadSource({stateDir:f.state,endpointId:'fixture-endpoint',current,testing:{home:f.osHome,accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}}});
    const port={capture,current:currentReadSource,release:releaseReadSource,drained:readSourceDrained};
    const select=(realm:string,id:string)=>writeFileSync(readSourcePath(f.state),JSON.stringify({...f.descriptor(realm),source_id:id}),{mode:0o600});
    const grant=(version=3,wrong=false)=>{
      const p=capture();try{writeFileSync(join(f.state,'collaboration-read.json'),JSON.stringify({version,owner_id:owner,endpoint_id:'fixture-endpoint',authorization_generation:1,allowedCwds:[f.project],...(version===3?{source_id:p.source_id,binding_revision:wrong?'0'.repeat(64):p.source_revision}:{})}),{mode:0o600});}finally{releaseReadSource(p);}
    };
    JsonProcess.prototype.request=function(method,params,timeout){methods.push(method);return original.call(this,method,params,timeout);};
    select(f.home,'A');
    for(const mode of ['legacy','wrong']){
      grant(mode==='legacy'?2:3,mode==='wrong');service=new CollaborationReadService({stateDir:f.state,nodeId:'fixture-endpoint',testing:{source:port}});await tick();
      assert.deepEqual(service.manifest().capabilities,[]);const m=service.manifest().collaboration;
      assert.equal((await service.call(COLLABORATION_LIST,{version:1,endpoint_id:m.endpoint_id,authorization_revision:m.authorization_revision},undefined,context)).ok,false);
      assert.deepEqual(methods,[]);await service.close();service=undefined;
    }
    grant();service=new CollaborationReadService({stateDir:f.state,nodeId:'fixture-endpoint',testing:{source:port}});await tick();
    const env=()=>({version:1,endpoint_id:'fixture-endpoint',authorization_revision:service!.manifest().collaboration.authorization_revision});
    const old=env();const all:WorkSummary[]=[];let cursor:string|null=null,oldCursor:string|undefined;
    do{const r:CallResult=await service.call(COLLABORATION_LIST,{...env(),page:{limit:1,...(cursor?{cursor}:{})}},undefined,context);assert.equal(r.ok,true,JSON.stringify({code:code(r)}));const p=r.data as ReadPage<WorkSummary>;all.push(...p.items);cursor=p.next_cursor;oldCursor??=cursor??undefined;}while(cursor);
    assert.equal(new Set(all.map(w=>w.work.native_id)).size,3);assert(all.some(w=>w.work.native_id===f.markers[0]));assert(!all.some(w=>w.work.native_id===f.markers[1]));
    const work=all.find(w=>w.work.native_id===f.markers[0])!.work;
    const turns:HistoryTurn[]=[];cursor=null;
    do{const r:CallResult=await service.call(COLLABORATION_READ,{...env(),work,page:{limit:1,...(cursor?{cursor}:{})}},undefined,context);assert.equal(r.ok,true,JSON.stringify({code:code(r)}));const p=r.data as ReadPage<HistoryTurn>;turns.push(...p.items);cursor=p.next_cursor;}while(cursor);
    assert.deepEqual(new Set(turns.map(t=>t.turn_id)),new Set(turnIds));assert.equal(turns.reduce((n,t)=>n+t.messages.length,0),6);
    const before=methods.length;select(f.external,'B');await tick();
    assert.deepEqual(service.manifest().capabilities,[]);
    assert.equal((await service.call(COLLABORATION_LIST,{...old,page:{limit:1,cursor:oldCursor}},undefined,context)).ok,false);
    assert.equal((await service.call(COLLABORATION_READ,{...old,work},undefined,context)).ok,false);assert.equal(methods.length,before);
    grant();await tick();const r:CallResult=await service.call(COLLABORATION_LIST,{...env(),page:{limit:1}},undefined,context);assert.equal(r.ok,true,JSON.stringify({code:code(r)}));assert.equal((r.data as ReadPage<WorkSummary>).items[0]?.work.native_id,f.markers[1]);
    assert.notEqual(env().authorization_revision,old.authorization_revision);
    assert(methods.every(m=>['initialize','thread/list','thread/read','thread/turns/list'].includes(m)));
  }finally{JsonProcess.prototype.request=original;await service?.close();rmSync(root,{recursive:true,force:true});}
});
