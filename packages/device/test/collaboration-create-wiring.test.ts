import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileSigner} from '../src/link';
import {createDeviceCollaboration} from '../src/main';
import {startConnectedDevice} from './fixtures/connected-device';
import {controlAuthorizationSnapshot} from '../src/collaboration/control-authorization';
import {controlRuntimePath} from '../src/collaboration/control-runtime';
import {CREATE_CAPABILITIES} from '../src/collaboration/create-protocol';
import {FakeCreateSocket} from './fixtures/codex-create-socket';
async function fixture(){
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ash-create-link-'))),signer=await fileSigner(dir),peer=await fileSigner(join(dir,'peer')),node=signer.id;
 writeFileSync(join(dir,'paired.json'),JSON.stringify({owner_key:peer.publicKey}),{mode:0o600});
 const config={version:1,endpoint_id:node,socket:'/fake.sock',executable:'/fake/codex',supportedVersions:['1.2.3']};
 const grant={version:1,endpoint_id:node,owner_id:peer.id,authorization_generation:1,allowed_actions:['create_work'],scope:{kind:'exact_cwd',cwd:'/project'}};
 writeFileSync(controlRuntimePath(dir),JSON.stringify(config));writeFileSync(join(dir,'collaboration-control.json'),JSON.stringify(grant));
 const sockets:FakeCreateSocket[]=[];let watchClosed=0;
 const testing={listener:()=>({...config,pid:123,version:'1.2.3',identity:'one'}),connectSocket:async()=>{const socket=new FakeCreateSocket();sockets.push(socket);return socket;},watch:()=>()=>{watchClosed++;}};
 const collaboration=createDeviceCollaboration(dir,node,{createTesting:testing,controlTesting:{watch:testing.watch},createDeadlineMs:1000});
 const app=await startConnectedDevice({gateway:'https://fixture.invalid',name:'Create fixture',stateDir:dir,workdir:join(dir,'work')},undefined,{detect:async()=>[],collaborationFactory:()=>collaboration});
 const revision=controlAuthorizationSnapshot(grant,node).authorization_revision!,target={node_id:node,endpoint_id:node,project_id:'project',cwd:'/project'};
 const projects={version:1,node_id:node,endpoint_id:node,authorization_revision:revision,cwd:'/project'},query={version:1,target,authorization_revision:revision,operation_id:'operation'};
 const request={version:1,target,authorization_revision:revision,request_id:'request',operation_id:'operation',title:'Title',input:{text:'private-body'},expires_at:Date.now()+10000};
 return {dir,node,peer,app,collaboration,sockets,projects,query,request,get watchClosed(){return watchClosed;},async close(){await app.close();rmSync(dir,{recursive:true,force:true});}};
}
const writes=(f:Awaited<ReturnType<typeof fixture>>)=>f.sockets.flatMap(socket=>socket.calls).filter(call=>['thread/start','thread/name/set','turn/start'].includes(call.method));
test('new device describe exposes exact locally authorized create scope and outward apply risk',async()=>{
 const f=await fixture();try{const result=await f.app.call('collaboration.endpoint.describe');assert.equal(result.ok,true);const manifest=result.data as any;assert.deepEqual(manifest.collaboration_create.scope,{kind:'exact_cwd',cwd:'/project'});assert.equal(manifest.capabilities.filter((c:any)=>c.name.startsWith('collaboration.create.')).length,4);assert.equal(manifest.capabilities.find((c:any)=>c.name===CREATE_CAPABILITIES.apply).risk,'outward');assert.equal(f.sockets.length,0);}finally{await f.close();}
});
test('HandClient fixed create dispatch creates once and query/reconcile never replay native writes',async()=>{
 const f=await fixture();try{
  const projects=await f.app.call(CREATE_CAPABILITIES.projects,f.projects);assert.equal(projects.ok,true);
  const body={version:1,request:f.request,expected_connector_epoch:(projects.data as any).connector_epoch};
  const first=await f.app.call(CREATE_CAPABILITIES.apply,body);assert.equal(first.ok,true);assert.equal((first.data as any).fact.first_input.status,'accepted');
  assert.deepEqual(writes(f).map(call=>call.method),['thread/start','thread/name/set','turn/start']);assert.doesNotMatch(JSON.stringify(first),/private-body|principal_id|payload_hash/);
  for(const name of [CREATE_CAPABILITIES.query,CREATE_CAPABILITIES.reconcile]){const result=await f.app.call(name,f.query);assert.equal(result.ok,true);assert.equal((result.data as any).fact.work.native_id,'thread');}
  const repeat=await f.app.call(CREATE_CAPABILITIES.apply,body);assert.equal(repeat.ok,true);assert.equal(writes(f).length,3);
 }finally{await f.close();}
});
test('create rejects agent callers, native passthrough, oversized input and revoked owner before native access',async()=>{
 const f=await fixture();try{
  for(const name of Object.values(CREATE_CAPABILITIES))assert.equal((await f.app.call(name,f.projects,'agent:model')).ok,false);
  assert.equal((await f.app.call('collaboration.create.native',{method:'thread.start'})).ok,false);assert.equal((await f.app.call(CREATE_CAPABILITIES.apply,{text:'x'.repeat(65536)})).ok,false);assert.equal(f.sockets.length,0);
  writeFileSync(join(f.dir,'paired.json'),JSON.stringify({owner_key:f.peer.publicKey,revoked:true}));assert.equal((await f.app.call('collaboration.endpoint.describe')).ok,false);assert.equal(f.sockets.length,0);
 }finally{await f.close();}
});
