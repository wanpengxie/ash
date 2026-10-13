import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDeviceControlRuntime,controlRuntimePath} from '../src/collaboration/control-runtime';
import {controlAuthorizationSnapshot} from '../src/collaboration/control-authorization';
import {OperationStore} from '../src/collaboration/operation-store';

const work={node_id:'node',endpoint_id:'endpoint',kind:'conversation' as const,native_id:'thread'};
const config={version:1,endpoint_id:'endpoint',socket:'/fake.sock',executable:'/fake/codex',supportedVersions:['1.2.3']};
const grant={version:1,endpoint_id:'endpoint',owner_id:'owner',authorization_generation:1,allowed_actions:['send_input'],scope:{kind:'exact_cwd',cwd:'/project'}};
class Socket extends EventEmitter {
  send(data:string) {
    const call=JSON.parse(data);if(!call.id)return;
    const result=call.method==='initialize'?{userAgent:'codex 1.2.3'}:{thread:{id:'thread',cwd:'/project',status:{type:'idle'}}};
    queueMicrotask(()=>this.emit('message',Buffer.from(JSON.stringify({id:call.id,result}))));
  }
  close() {}
}
function fixture(configured=false, seed?: (store:OperationStore)=>void) {
  const dir=mkdtempSync(join(tmpdir(),'ash-control-bootstrap-'));
  if(configured)writeFileSync(controlRuntimePath(dir),JSON.stringify(config));
  writeFileSync(join(dir,'collaboration-control.json'),JSON.stringify(grant));
  if(seed){const store=new OperationStore(join(dir,'collaboration-control.sqlite'));try{seed(store);}finally{store.close();}}
  let watchError=()=>{},connections=0,connectHook:undefined|(()=>Promise<void>);
  const runtime=createDeviceControlRuntime({stateDir:dir,nodeId:'node',endpointId:'endpoint',pinnedOwnerId:()=> 'owner',testing:{
    listener:()=>({socket:config.socket,executable:config.executable,pid:123,version:'1.2.3',identity:'one'}),
    connectSocket:async()=>{connections++;await connectHook?.();return new Socket();},
    watch:(_paths,_changed,error)=>{watchError=error;return ()=>{};},
  }});
  const envelope={version:1,endpoint_id:'endpoint',authorization_revision:controlAuthorizationSnapshot(grant,'endpoint').authorization_revision!,work,action:'send_input'};
  return {dir,runtime,envelope,context:{transportOwnerId:'owner',isCurrent:()=>true},watchError:()=>watchError(),get connections(){return connections;},setConnectHook(hook:()=>Promise<void>){connectHook=hook;},async close(){await runtime.close();rmSync(dir,{recursive:true,force:true});}};
}
test('fresh missing configuration is safe without connecting or granting',async()=>{
  const f=fixture();try {
    assert.deepEqual(f.runtime.changeSafety(),{scope:'control-runtime',state:'safe',reason:'config_required',generation:0});
    assert.equal(f.connections,0);
    assert.equal(f.runtime.status().state,'config_required');
    assert.equal(f.runtime.manifest().grant_state,'ready');
  } finally {await f.close();}
});
test('invalid configuration, failed watcher and closed runtime cannot bootstrap',async()=>{
  const f=fixture();try {
    writeFileSync(controlRuntimePath(f.dir),'{}');
    assert.equal(f.runtime.changeSafety().state,'unavailable');
    rmSync(controlRuntimePath(f.dir));f.watchError();
    assert.equal(f.runtime.changeSafety().state,'unavailable');
    await f.runtime.close();assert.equal(f.runtime.changeSafety().state,'unavailable');
    assert.equal(f.connections,0);
  } finally {await f.close();}
});
for(const status of ['invoking','unknown'] as const)test(`missing config still rejects journal ${status} before config lookup`,async()=>{
  const f=fixture(),store=new OperationStore(join(f.dir,'collaboration-control.sqlite'));
  try {
    const request={request_id:'request',operation_id:'operation',work,action:'send_input' as const,input:{text:'fixture only'},expires_at:Date.now()+60_000};
    store.record('owner',request,'hash',Date.now());
    const claimed=store.claim('owner','operation','epoch',Date.now(),'1.2.3');
    assert.equal(claimed.claimed,true);
    if(status==='unknown')store.finish(claimed.fact,null,Date.now());
    assert.deepEqual(f.runtime.changeSafety(),{scope:'control-runtime',state:status==='invoking'?'busy':'unavailable',reason:`journal_${status}`,generation:0});
    assert.equal(f.connections,0);
    if(status==='invoking')store.finish(claimed.fact,null,Date.now());
  } finally {store.close();await f.close();}
});
test('a previously bound native cannot bootstrap after config deletion and invalidation',async()=>{
  const f=fixture(true);try {
    await f.runtime.execute('query',{...f.envelope,operation_id:'operation'},f.context);
    assert.equal(f.connections,1);
    assert.equal(f.runtime.changeSafety().state,'safe');
    rmSync(controlRuntimePath(f.dir));f.runtime.invalidate();
    assert.equal(f.runtime.busy,false);
    assert.deepEqual(f.runtime.changeSafety(),{scope:'control-runtime',state:'unavailable',reason:'unavailable',generation:1});
  } finally {await f.close();}
});
for(const status of ['accepted','rejected','recorded'] as const)test(`fresh missing configuration checks persisted ${status} native history`,async()=>{
  const f=fixture(false,store=>{
    const request={request_id:'request',operation_id:'operation',work,action:'send_input' as const,input:{text:'fixture only'},expires_at:Date.now()+60_000};
    store.record('owner',request,'hash',Date.now());
    if(status==='recorded')return;
    const {fact}=store.claim('owner','operation','epoch',Date.now(),'1.2.3');
    store.finish(fact,status==='accepted'?{status:'accepted',receipt:{accepted_by:'native',native_turn_id:'turn',correlation:'uncertain'}}:{status:'rejected',code:'unsupported'},Date.now());
  });
  try {
    assert.deepEqual(f.runtime.changeSafety(),{scope:'control-runtime',state:status==='recorded'?'safe':'unavailable',reason:status==='recorded'?'config_required':'unavailable',generation:0});
    assert.equal(f.connections,0);
  } finally {await f.close();}
});
test('pending native connection remains busy when configuration disappears',async()=>{
  const f=fixture(true);let release!:()=>void;
  f.setConnectHook(()=>new Promise<void>(resolve=>{release=resolve;}));
  const execution=f.runtime.execute('query',{...f.envelope,operation_id:'operation'},f.context);
  // Attach rejection handling before invalidating the pending native request.
  const rejected=assert.rejects(execution);
  try {
    while(!release)await new Promise<void>(resolve=>setImmediate(resolve));
    rmSync(controlRuntimePath(f.dir));f.runtime.invalidate();
    assert.equal(f.runtime.changeSafety().state,'busy');
    assert.equal(f.runtime.changeSafety().reason,'raw_pending');
    release();await rejected;
    assert.equal(f.runtime.changeSafety().state,'unavailable');
  } finally {release?.();await rejected;await f.close();}
});
