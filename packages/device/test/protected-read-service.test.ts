import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DeviceKey } from 'ash-gateway/client/client';
import { deviceIdForKey } from 'ash-gateway/src/protocol';
import { CollaborationReadService } from '../src/collaboration/read-service';
import { CodexReadAdapter } from '../src/collaboration/codex-read';
import { COLLABORATION_LIST } from '../src/collaboration/capabilities';
import { parseReadAuthorization, readAuthorizationSnapshot } from '../src/collaboration/authorization';
import { releaseReadSource } from '../src/collaboration/read-source';
import { protectedReadFixture } from './fixtures/protected-read-fixture';
const key=(await DeviceKey.generate()).publicKey,owner=await deviceIdForKey(key);
const context={transportOwnerId:owner,isCurrent:()=>true};
const code=(r:any)=>r.data?.code;
const envelope=(s:CollaborationReadService)=>({version:1,endpoint_id:'node',authorization_revision:s.manifest().collaboration.authorization_revision,page:{limit:1}});
function bind(f:ReturnType<typeof protectedReadFixture>,revision?:string,version=3) {
  const proof=f.capture(); const binding=revision??proof.source_revision;releaseReadSource(proof);
  writeFileSync(join(f.state,'paired.json'),JSON.stringify({owner_key:key}),{mode:0o600});
  writeFileSync(join(f.state,'collaboration-read.json'),JSON.stringify({version,owner_id:owner,endpoint_id:'node',authorization_generation:1,allowedCwds:[f.project],...(version===3?{source_id:f.descriptor.source_id,binding_revision:binding}:{})}),{mode:0o600});
}
test('v3 is strict and v2 retains local scopes without granting any source',()=>{
  const base={version:3,owner_id:owner,endpoint_id:'node',authorization_generation:1,allowedCwds:['/synthetic'],source_id:'fixture-source',binding_revision:'a'.repeat(64)};
  assert.equal(readAuthorizationSnapshot(base,'node',owner).state,'ready');
  for(const bad of [{...base,binding_revision:'bad'},{...base,source_id:''},{...base,extra:true},{...base,binding_revision:undefined}])assert.throws(()=>parseReadAuthorization(bad,'node'));
  const {source_id,binding_revision,...old}=base;
  const legacy=readAuthorizationSnapshot({...old,version:2},'node',owner);
  assert.equal(legacy.state,'scope_required');assert.deepEqual(legacy.allowedCwds,['/synthetic']);
});
test('legacy/missing/mismatched source offers no capability and never starts a source child',async()=>{
  for(const mode of ['legacy','wrong','missing']){
    const f=protectedReadFixture();bind(f,mode==='wrong'?'0'.repeat(64):undefined,mode==='legacy'?2:3);
    if(mode==='missing')rmSync(join(f.state,'collaboration-read-runtime.json'));
    const s=new CollaborationReadService({stateDir:f.state,nodeId:'node',testing:{source:f.port}});
    try{assert.deepEqual(s.manifest().capabilities,[]);assert.equal(s.manifest().collaboration.authorization_state,'scope_required');assert.equal((await s.call(COLLABORATION_LIST,envelope(s),undefined,context)).ok,false);assert.throws(()=>readFileSync(join(f.home,'fixture-methods')));}
    finally{await s.close();f.cleanup();}
  }
});
test('default protected adapter uses the exact source proof and response/source tail fences',async()=>{
  for(const mode of ['', 'response-config']){
    const f=protectedReadFixture();if(mode)writeFileSync(join(f.home,'config.toml'),'# synthetic\n',{mode:0o600});bind(f);writeFileSync(join(f.home,'fixture-mode'),mode);
    const s=new CollaborationReadService({stateDir:f.state,nodeId:'node',testing:{source:f.port}});
    try{await new Promise(r=>setTimeout(r,160));assert.equal(s.manifest().capabilities.length,2);const result=await s.call(COLLABORATION_LIST,envelope(s),undefined,context);
      assert.equal(result.ok,!mode,JSON.stringify({code:code(result)}));if(mode)assert.equal(code(result),'permission_denied');
      assert.deepEqual(readFileSync(join(f.home,'fixture-methods'),'utf8').trim().split('\n'),['initialize','initialized','thread/list']);
    }finally{await s.close();f.cleanup();}
  }
});
test('scope physical replacement and final trusted-context callback changes reject private output',async()=>{
  for(const mode of ['directory','context']){
    const f=protectedReadFixture();bind(f);const source=f.capture();let calls=0;
    const adapter=new CodexReadAdapter({node_id:'node',endpoint_id:'node',source,allowedCwds:[f.project]});
    try{await assert.rejects(adapter.listWork({limit:1,current:()=>{
      if(++calls===8){if(mode==='directory'){renameSync(f.project,f.project+'.old');mkdirSync(f.project,{mode:0o700});}else throw new Error('synthetic revocation');}
      return undefined;
    }}));}
    finally{try{await adapter.close();}catch{}await adapter.drained();releaseReadSource(source);f.cleanup();}
  }
});
test('escaped pipe holder retains busy slot even after a new valid source grant until actual raw drain',async()=>{
  const f=protectedReadFixture();bind(f);writeFileSync(join(f.home,'fixture-mode'),'escape-pipe');
  let factories=0,holder:number|undefined;
  const s=new CollaborationReadService({stateDir:f.state,nodeId:'node',testing:{source:f.port,factory:o=>{factories++;return new CodexReadAdapter(o);}}});
  try{
    await new Promise(r=>setTimeout(r,160));
    const first=await s.call(COLLABORATION_LIST,envelope(s),undefined,context);assert.equal(first.ok,true,JSON.stringify({code:code(first)}));
    holder=Number(readFileSync(join(f.home,'fixture-pipe-holder'),'utf8'));assert(Number.isSafeInteger(holder)&&holder>0);
    s.invalidate();await new Promise(r=>setTimeout(r,1200));assert.equal(s.busy,true);
    const external=join(f.root,'external');mkdirSync(external,{mode:0o700});writeFileSync(join(external,'state_5.sqlite'),'synthetic external DB',{mode:0o600});f.descriptor.sqlite_home=external;
    f.descriptor.source_id='new-source';writeFileSync(join(f.state,'collaboration-read-runtime.json'),JSON.stringify(f.descriptor),{mode:0o600});bind(f);writeFileSync(join(f.home,'fixture-mode'),'');await new Promise(r=>setTimeout(r,160));
    const denied=await s.call(COLLABORATION_LIST,envelope(s),undefined,context);assert.equal(code(denied),'draining');assert.equal(factories,1);assert.equal(s.busy,true);
    // Drain affects availability, not the valid persisted scope. Advertising
    // that scope must never permit another reader before actual raw drain.
    const drainingManifest=s.manifest();
    assert.equal(drainingManifest.collaboration.authorization_state,'ready');
    assert.equal(drainingManifest.collaboration.runtime_availability,'unknown');
    assert.equal(drainingManifest.capabilities.length,2);
    assert.equal(code(await s.call(COLLABORATION_LIST,envelope(s),undefined,context)),'draining');
    assert.equal(factories,1);assert.equal(s.busy,true);
    process.kill(-holder,'SIGKILL');holder=undefined;
    const end=Date.now()+3000;while(s.busy&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert.equal(s.busy,false);
    const recovered=s.manifest();
    assert.equal(recovered.collaboration.authorization_state,'ready');assert.equal(recovered.capabilities.length,2);
    assert.equal(factories,1,'manifest recovery validates source but does not spawn another reader');
    assert.equal((await s.call(COLLABORATION_LIST,envelope(s),undefined,context)).ok,true);assert.equal(factories,2);
  }finally{if(holder)process.kill(-holder,'SIGKILL');await s.close();f.cleanup();}
});

test('manifest retains a valid proof but freshly validates each failed advertisement',async()=>{
  for(const mismatch of [false,true]){
    const f=protectedReadFixture();bind(f,mismatch?'0'.repeat(64):undefined);let captures=0,checks=0;
    const s=new CollaborationReadService({stateDir:f.state,nodeId:'node',testing:{source:{...f.port,capture:current=>{captures++;return f.port.capture(current);},current:proof=>{checks++;return f.port.current(proof);}}}});
    try{await new Promise(r=>setTimeout(r,160));for(let i=0;i<10;i++)assert.equal(s.manifest().capabilities.length,mismatch?0:2);
      assert.equal(captures,mismatch?10:1);if(!mismatch)assert(checks>=10);assert.throws(()=>readFileSync(join(f.home,'fixture-methods')));
      if(mismatch){s.invalidate();s.manifest();assert.equal(captures,11,'failed refresh never promotes the unchanged mismatch');}
    }finally{await s.close();f.cleanup();}
  }
});
