import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,realpathSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Connection} from 'ash-gateway/client/client';
import {fileSigner} from '../src/link';
import {startConnectedDevice as startDevice, type ConnectedDevice} from './fixtures/connected-device';
import {controlRuntimePath} from '../src/collaboration/control-runtime';
import {controlAuthorizationSnapshot} from '../src/collaboration/control-authorization';
import {callMaterialSetup} from '../src/setup/material-ipc';
import {ConnectionSetupService} from '../src/setup/service';
import {SetupError} from '../src/setup/scope-settings';

test('material reservation rejects a live control read before writing, then admits when the raw call settles',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ash-material-control-'))),signer=await fileSigner(dir),peer=await fileSigner(join(dir,'peer')),project=join(dir,'project');
 const grant={version:1,endpoint_id:signer.id,owner_id:peer.id,authorization_generation:1,allowed_actions:['send_input'],scope:{kind:'exact_cwd',cwd:project}};
 writeFileSync(join(dir,'paired.json'),JSON.stringify({owner_key:peer.publicKey,permissions:[],grant_version:1}),{mode:0o600});writeFileSync(join(dir,'collaboration-control.json'),JSON.stringify(grant),{mode:0o600});
 const config={version:1,endpoint_id:signer.id,socket:'/fixture.sock',executable:'/fixture-native',supportedVersions:['1.2.3']};writeFileSync(controlRuntimePath(dir),JSON.stringify(config),{mode:0o600});
 let app:Awaited<ReturnType<typeof startDevice>>|undefined,link:ConnectedDevice|undefined,hold:Promise<void>|undefined,release:(()=>void)|undefined,reading=false;
 try{
  app=await startDevice({gateway:'https://paired-fixture.invalid',name:'material-control',stateDir:dir,workdir:project},undefined,{detect:async()=>[],controlTesting:{listener:()=>({...config,pid:1,identity:'fixture',version:'1.2.3'}),async connectSocket(){const socket=new EventEmitter()as any;socket.close=()=>socket.emit('close');socket.send=(raw:string)=>{const frame=JSON.parse(raw);if(frame.id===undefined)return;void(async()=>{if(frame.method==='thread/read'){reading=true;await hold;}const result=frame.method==='initialize'?{userAgent:'fixture 1.2.3'}:{thread:{id:'thread',cwd:project,status:{type:'idle'}}};socket.emit('message',Buffer.from(JSON.stringify({id:frame.id,result})));})();};return socket;}},testing:{detectBrowser:async()=>undefined,}});await app.run;link=app;
  const work={node_id:signer.id,endpoint_id:signer.id,kind:'conversation',native_id:'thread'},selection={expiresAt:Date.now()+60000,grants:[{action:'receive_input',source_node_id:peer.id,source_endpoint_id:'materials' as const,target:work}]};
  const preview=await callMaterialSetup(dir,signer.id,'material.prepare',{selection});assert.ok(preview.preview_id);hold=new Promise<void>(resolve=>release=resolve);reading=false;
  const context={transportOwnerId:peer.id,isCurrent:()=>true};const pending=app!.call('collaboration.control.state',{version:1,endpoint_id:signer.id,authorization_revision:controlAuthorizationSnapshot(grant,signer.id).authorization_revision,work,action:'send_input'});
  const until=Date.now()+3000;while(!reading&&Date.now()<until)await new Promise(resolve=>setImmediate(resolve));assert.ok(reading);
  const blocked=await callMaterialSetup(dir,signer.id,'material.apply',{preview_id:preview.preview_id,selection_hash:preview.selection_hash});assert.equal(blocked.error,'busy');assert.equal((await callMaterialSetup(dir,signer.id,'material.status',{})).state,'missing');release!();assert.equal((await pending).ok,true);hold=undefined;
  const fresh=await callMaterialSetup(dir,signer.id,'material.prepare',{selection});const result=await callMaterialSetup(dir,signer.id,'material.apply',{preview_id:fresh.preview_id,selection_hash:fresh.selection_hash});assert.equal(result.material.grants[0].target.native_id,'thread');
 }finally{release?.();await app?.close();rmSync(dir,{recursive:true,force:true});}
});
test('receive-only runtime retains shared reservation, exact target validation and pairing/precondition fences',async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'ash-material-fences-'))),signer=await fileSigner(dir),peer=await fileSigner(join(dir,'peer'));
 writeFileSync(join(dir,'paired.json'),JSON.stringify({owner_key:peer.publicKey,permissions:[],grant_version:1}),{mode:0o600});let held:Promise<void>|undefined,release:(()=>void)|undefined,reserved=false,entered=false,valid=true,epoch='one';
 const service=new ConnectionSetupService({stateDir:dir,nodeId:signer.id,endpointId:signer.id,observationEpoch:()=>epoch,runtime:{async reserveChange(){throw new SetupError('unavailable');}},materialRuntime:{async reserveChange(){if(reserved)throw new SetupError('busy');reserved=true;return {assertCurrent:()=>{if(!reserved)throw new SetupError('stale');return undefined;},release:()=>{reserved=false;return undefined;}};}},materialVerification:async()=>{entered=true;await held;return valid;}});
 const selection={expiresAt:Date.now()+60000,grants:[{action:'receive_input' as const,source_node_id:peer.id,source_endpoint_id:'materials' as const,target:{node_id:signer.id,endpoint_id:signer.id,kind:'conversation' as const,native_id:'known'}}]};
 try{
  const before=service.materialStatus().precondition!;await service.previewMaterial(selection,before);held=new Promise<void>(resolve=>release=resolve);entered=false;const applying=service.applyMaterial(selection,before);while(!entered)await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(service.revokeMaterial(before),(e:any)=>e.code==='busy');epoch='two';release!();await assert.rejects(applying,(e:any)=>e.code==='stale');assert.equal(service.materialStatus().state,'missing');assert.equal(reserved,false);held=undefined;
  valid=false;const current=service.materialStatus().precondition!;await assert.rejects(service.applyMaterial(selection,current),(e:any)=>e.code==='invalid');assert.equal(service.materialStatus().state,'missing');valid=true;
  const prepared=await service.previewMaterial(selection,current);const pair=JSON.parse(readFileSync(join(dir,'paired.json'),'utf8'));writeFileSync(join(dir,'paired.json'),JSON.stringify({...pair,revoked:true}),{mode:0o600});await assert.rejects(service.applyMaterial(prepared.selection,prepared.precondition),(e:any)=>e.code==='unpaired');assert.equal(service.materialStatus().state,'missing');
 }finally{release?.();service.close();rmSync(dir,{recursive:true,force:true});}
});
