import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileSigner} from '../src/link';
import {createDeviceCollaboration} from '../src/main';
import {startConnectedDevice} from './fixtures/connected-device';
import {controlAuthorizationSnapshot} from '../src/collaboration/control-authorization';
import {CONTROL_CAPABILITIES} from '../src/collaboration/control-protocol';
import {controlRuntimePath} from '../src/collaboration/control-runtime';
class Socket extends EventEmitter {
  closed = false;
  constructor(private calls: any[], private mode: { hang: boolean; delayMs?: number; holdRead?: Promise<void>; holdTurn?: Promise<void>; onCall?: (call: any) => void }) { super(); }
  send(data: string) {
    const call = JSON.parse(data); this.calls.push(call); this.mode.onCall?.(call);
    if (!call.id || this.mode.hang && call.method === "turn/start") return;
    const result = call.method === "initialize" ? { userAgent: "codex 1.2.3" } : call.method === "turn/start" ? { turn: { id: "turn" } } : { thread: { id: "thread", cwd: "/project", status: { type: "idle" } } };
    const respond = () => this.emit("message", Buffer.from(JSON.stringify({ id: call.id, result })));
    if (call.method === "thread/read" && this.mode.holdRead) void this.mode.holdRead.then(respond);
    else if (call.method === "turn/start" && this.mode.holdTurn) void this.mode.holdTurn.then(respond);
    else if (this.mode.delayMs) setTimeout(respond, this.mode.delayMs); else queueMicrotask(respond);
  }
  close() { this.closed = true; }
}

async function fixture() {
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ash-control-link-'))), signer=await fileSigner(dir), peer=await fileSigner(join(dir,'peer')),node=signer.id;
 writeFileSync(join(dir,'paired.json'),JSON.stringify({owner_key:peer.publicKey}),{mode:0o600});
 const config={version:1,endpoint_id:node,socket:'/fake.sock',executable:'/fake/codex',supportedVersions:['1.2.3']};
 const grant={version:1,endpoint_id:node,owner_id:peer.id,authorization_generation:1,allowed_actions:['send_input'],scope:{kind:'exact_cwd',cwd:'/project'}};
 writeFileSync(controlRuntimePath(dir),JSON.stringify(config));writeFileSync(join(dir,'collaboration-control.json'),JSON.stringify(grant));
 const calls:any[]=[],sockets:Socket[]=[],mode={hang:false,holdRead:undefined as Promise<void>|undefined,holdTurn:undefined as Promise<void>|undefined};
 let invalidate=()=>{},watchClosed=0;
 const testing={listener:()=>({...config,pid:123,version:'1.2.3',identity:'one'}),connectSocket:async()=>{const socket=new Socket(calls,mode);sockets.push(socket);return socket;},watch:(_paths:readonly string[],change:()=>void)=>{invalidate=change;return ()=>{watchClosed++;};}};
 const collaboration=createDeviceCollaboration(dir,node,{controlTesting:testing,controlDeadlineMs:1000});
 const app=await startConnectedDevice({gateway:'https://fixture.invalid',name:'Control fixture',stateDir:dir,workdir:join(dir,'work'),installRoot:join(dir,'install')},undefined,{detect:async()=>[],collaborationFactory:()=>collaboration,restart:()=>{}});
 const work={node_id:node,endpoint_id:node,kind:'conversation',native_id:'thread'}, envelope={version:1,endpoint_id:node,authorization_revision:controlAuthorizationSnapshot(grant,node).authorization_revision!,work,action:'send_input'};
 return {dir,node,peer,grant,app,collaboration,mode,calls,sockets,envelope,work,changed:()=>invalidate(),get watchClosed(){return watchClosed;},async close(){await app.close();rmSync(dir,{recursive:true,force:true});}};
}
const writes=(calls:any[])=>calls.filter(call=>['turn/start','turn/steer'].includes(call.method));
test('ash-link manifest and describe preserve local control grant and outward apply risk',async()=>{
 const f=await fixture();try {const result=await f.app.call('collaboration.endpoint.describe');assert.equal(result.ok,true);const manifest=result.data as any;assert.equal(manifest.collaboration.authorization_state,'scope_required');assert.equal(manifest.collaboration_control.grant_state,'ready');assert.equal(manifest.capabilities.find((c:any)=>c.name===CONTROL_CAPABILITIES.apply).risk,'outward');assert.equal(f.calls.length,0);}finally{await f.close();}
});
test('real HandClient state/query/reconcile remain read-only, apply uses one durable operation and never repeats native input',async()=>{
 const f=await fixture();try {
  for(const op of ['query','reconcile']as const){const result=await f.app.call(CONTROL_CAPABILITIES[op],{...f.envelope,operation_id:'operation'});assert.equal(result.ok,true);assert.equal((result.data as any).fact,null);}
  const state=await f.app.call(CONTROL_CAPABILITIES.state,f.envelope);assert.equal(state.ok,true);assert.equal(writes(f.calls).length,0);
  const {action,...base}=f.envelope, request={request_id:'request',operation_id:'operation',work:f.work,action,input:{text:'private body'},expires_at:Date.now()+10000};
  const body={...base,request,expected_connector_epoch:(state.data as any).connector_epoch};
  const first=await f.app.call(CONTROL_CAPABILITIES.apply,body), repeat=await f.app.call(CONTROL_CAPABILITIES.apply,body);
  assert.equal(first.ok,true);assert.equal(repeat.ok,true);assert.equal(writes(f.calls).length,1);assert.doesNotMatch(JSON.stringify(first),/private body|principal_id|payload_hash/);
  const query=await f.app.call(CONTROL_CAPABILITIES.query,{...f.envelope,operation_id:'operation'});assert.equal((query.data as any).fact.delivery_status,'accepted');assert.equal(writes(f.calls).length,1);
 }finally{await f.close();}
});
test('agent callers, stale owner, oversized input and unknown native methods never reach Codex',async()=>{
 const f=await fixture();try {
  for(const name of Object.values(CONTROL_CAPABILITIES)){assert.equal((await f.app.call(name,f.envelope,'agent:model')).ok,false);}
  assert.equal((await f.app.call('collaboration.control.native',{method:'thread.start'})).ok,false);
  assert.equal((await f.app.call(CONTROL_CAPABILITIES.apply,{text:'s'.repeat(65536)})).ok,false);assert.equal(f.calls.length,0);
  writeFileSync(join(f.dir,'paired.json'),JSON.stringify({owner_key:f.peer.publicKey,revoked:true}));assert.equal((await f.app.call(CONTROL_CAPABILITIES.state,f.envelope)).ok,false);assert.equal(f.calls.length,0);
 }finally{await f.close();}
});
for(const change of ['owner','runtime','disconnect']as const)test(`late control metadata after ${change} cannot return private data or invoke native input`,async()=>{
 const f=await fixture();let release!:()=>void;try {
  f.mode.holdRead=new Promise<void>(resolve=>release=resolve);const pending=f.app.call(CONTROL_CAPABILITIES.state,f.envelope);
  const until=Date.now()+3000;while(!f.calls.some(call=>call.method==='thread/read')&&Date.now()<until)await new Promise(resolve=>setImmediate(resolve));assert.ok(f.calls.some(call=>call.method==='thread/read'));
  if(change==='owner')writeFileSync(join(f.dir,'paired.json'),JSON.stringify({owner_key:f.peer.publicKey,revoked:true}));
  if(change==='runtime'){writeFileSync(controlRuntimePath(f.dir),'{}');f.changed();}
  if(change==='disconnect')f.app.disconnect();release();const result=await pending;assert.equal(result.ok,false);assert.equal(writes(f.calls).length,0);assert.doesNotMatch(JSON.stringify(result),/private body/);
 }finally{release?.();await f.close();}
});
