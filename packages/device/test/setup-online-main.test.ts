import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {SetupScopeStore} from '../src/setup/scope-settings';
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,existsSync,rmSync,renameSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawn,execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {once} from 'node:events';
import {DeviceKey,type Connection} from 'ash-gateway/client/client';import {SetupNativeVerification} from '../src/setup/native-verification';import {discoverControlListener} from '../src/collaboration/control-runtime';
import {startConnectedDevice as startDevice, type ConnectedDevice} from './fixtures/connected-device';import {callConnectionSetup,callMaterialSetup} from '../src/setup/material-ipc';

async function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'setup-online-'))),state=join(root,'state'),cwd=join(root,'project');mkdirSync(state,{mode:0o700});mkdirSync(cwd,{mode:0o700});const key=await DeviceKey.generate(),owner=await DeviceKey.generate();writeFileSync(join(state,'device.jwk'),JSON.stringify(await key.exportJwk()),{mode:0o600});writeFileSync(join(state,'paired.json'),JSON.stringify({owner_key:owner.publicKey,grant_version:1,permissions:[]}),{mode:0o600});
 const socket=join(root,'native.sock'),executable=realpathSync(execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim()),version=execFileSync(executable,['--version'],{encoding:'utf8'}).match(/\b\d+\.\d+\.\d+\b/)![0],calls:any[]=[];
 const child=spawn(executable,[fileURLToPath(new URL('./fixtures/setup-native.py',import.meta.url)),socket,cwd],{stdio:['pipe','pipe','pipe']});let text='';await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture startup deadline')),3000);child.once('error',reject);child.stdout.on('data',b=>{text+=b.toString();let n:number;while((n=text.indexOf('\n'))>=0){const value=JSON.parse(text.slice(0,n));text=text.slice(n+1);if(value.ready){clearTimeout(timer);resolve();}if(value.call)calls.push(value.call);}});});
 writeFileSync(join(state,'collaboration-control-runtime.json'),JSON.stringify({version:1,endpoint_id:key.id,socket,executable:realpathSync(execFileSync('lsof',['-a','-p',String(child.pid),'-d','txt','-Fn'],{encoding:'utf8'}).split('\n').find(line=>line.startsWith('n'))!.slice(1)),supportedVersions:[version]}),{mode:0o600});
 const app=await startDevice({gateway:'https://setup-fixture.invalid',name:'setup native fixture',stateDir:state,workdir:cwd},undefined,{detect:async()=>[],testing:{detectBrowser:async()=>undefined,}});await app.run;
 return {root,state,cwd,key,owner,calls,app,hold:(value:boolean)=>child.stdin.write(JSON.stringify({hold:value})+'\n'),async close(){await app.close();const exited=once(child,'exit');child.stdin.end();await exited;rmSync(root,{recursive:true,force:true});}};
}
async function until(condition:()=>boolean){const end=Date.now()+10000;while(!condition()&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(condition(),'bounded native metadata observation');}
test('default online main authenticates settings IPC and grants first exact work without existing control authorization',{timeout:60000},async()=>{
 const f=await fixture();try{
  const status=await callConnectionSetup(f.state,f.key.id,'setup.status',{});assert.equal(status.control,null);assert.equal(status.defaultProject.state,'unavailable');assert.equal(status.diagnostics.installation,'verified');assert.equal(status.diagnostics.pairing,'paired');assert.equal(status.diagnostics.gateway,'verified');assert.equal(status.diagnostics.client,'verified');assert.equal(status.diagnostics.controlCapability,'missing');assert.equal(status.diagnostics.readCapability,'missing');assert.equal(status.diagnostics.login,'unknown');
  const work={node_id:f.key.id,endpoint_id:f.key.id,kind:'conversation' as const,native_id:'thread-one'};
  const preview=await callConnectionSetup(f.state,f.key.id,'setup.prepare',{selection:{kind:'control',allowedActions:['send_input'],scope:{kind:'single_work',work}}});assert.equal(existsSync(join(f.state,'collaboration-control.json')),false);
  const applied=await callConnectionSetup(f.state,f.key.id,'setup.apply',{preview_id:preview.preview_id,selection_hash:preview.selection_hash});assert.deepEqual(applied.control?.scope,{kind:'single_work',work});assert.equal(applied.defaultProject.state,'unavailable');assert.equal(applied.diagnostics.controlCapability,'unknown');const checked=await callConnectionSetup(f.state,f.key.id,'setup.status',{});assert.equal(checked.diagnostics.controlCapability,'verified');assert.equal(checked.diagnostics.login,'unknown');
  await assert.rejects(callConnectionSetup(f.state,f.key.id,'setup.apply',{preview_id:preview.preview_id,selection_hash:preview.selection_hash}));
  await assert.rejects(callConnectionSetup(f.state,f.key.id,'setup.prepare',{selection:{kind:'control',allowedActions:['send_input'],scope:{kind:'single_work',work:{...work,node_id:f.owner.id}}}}));
  await assert.rejects(callMaterialSetup(f.state,f.key.id,'setup.prepare',{selection:{kind:'read',allowedCwds:[f.cwd],owner_id:f.owner.id}}).then(value=>{if(value.error)throw Error(value.error);}));
  const project=await callConnectionSetup(f.state,f.key.id,'setup.prepare',{selection:{kind:'control',allowedActions:['send_input','create_work'],scope:{kind:'exact_cwd',cwd:f.cwd}}});const selected=await callConnectionSetup(f.state,f.key.id,'setup.apply',{preview_id:project.preview_id,selection_hash:project.selection_hash});assert.deepEqual(selected.defaultProject,{state:'configured',cwd:f.cwd});await callConnectionSetup(f.state,f.key.id,'setup.status',{});
  await assert.rejects(callConnectionSetup(f.state,f.key.id,'setup.prepare',{selection:{kind:'read',allowedCwds:[f.cwd]}})); // Control metadata never grants an unconfigured saved source.
  const clear=await callConnectionSetup(f.state,f.key.id,'setup.prepare',{selection:{kind:'control',clear:true}});const revoked=await callConnectionSetup(f.state,f.key.id,'setup.apply',{preview_id:clear.preview_id,selection_hash:clear.selection_hash});assert.equal(revoked.control,null);assert.equal(revoked.read,null);assert.equal(revoked.defaultProject.state,'unavailable');
  assert.ok(f.calls.some(c=>c.method==='thread/read'));assert.ok(f.calls.every(c=>['initialize','initialized','thread/read'].includes(c.method)));assert.ok(f.calls.filter(c=>c.method==='thread/read').every(c=>c.params.includeTurns===false));
 }finally{await f.close();}
});
test('shutdown fences a real pending first-grant metadata validation before its final setter',{timeout:60000},async()=>{
 const f=await fixture();try{const work={node_id:f.key.id,endpoint_id:f.key.id,kind:'conversation' as const,native_id:'thread-close'},p=await callConnectionSetup(f.state,f.key.id,'setup.prepare',{selection:{kind:'control',allowedActions:['send_input'],scope:{kind:'single_work',work}}});f.hold(true);const before=f.calls.filter(c=>c.method==='thread/read').length,apply=callConnectionSetup(f.state,f.key.id,'setup.apply',{preview_id:p.preview_id,selection_hash:p.selection_hash});const observed=assert.rejects(apply);await until(()=>f.calls.filter(c=>c.method==='thread/read').length>before);const closing=f.app.close();f.hold(false);await observed;await closing;assert.equal(existsSync(join(f.state,'collaboration-control.json')),false);}finally{f.hold(false);await f.close();}
});

for(const changed of ['owner','native-config'] as const)test(`current ${changed} replacement during native preview permanently rejects captured form`,{timeout:60000},async()=>{
 const f=await fixture();try{f.hold(true);const before=f.calls.filter(c=>c.method==='thread/read').length,work={node_id:f.key.id,endpoint_id:f.key.id,kind:'conversation' as const,native_id:'thread-replaced'};
  const preparing=callConnectionSetup(f.state,f.key.id,'setup.prepare',{selection:{kind:'control',allowedActions:['send_input'],scope:{kind:'single_work',work}}});const rejected=assert.rejects(preparing);
  await until(()=>f.calls.filter(c=>c.method==='thread/read').length>before);
  const path=join(f.state,changed==='owner'?'paired.json':'collaboration-control-runtime.json'),original=readFileSync(path);
  // Same bytes restored are a new file revision: the old in-flight observation must not revive.
  writeFileSync(path,changed==='owner'?JSON.stringify({owner_key:f.key.publicKey,grant_version:2}):'{}',{mode:0o600});writeFileSync(path,original,{mode:0o600});f.hold(false);await rejected;assert.equal(existsSync(join(f.state,'collaboration-control.json')),false);
 }finally{f.hold(false);await f.close();}
});

async function secondNative(root:string,cwd:string){
 const socket=join(root,'native-second.sock'),executable=realpathSync(execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim()),version=execFileSync(executable,['--version'],{encoding:'utf8'}).match(/\b\d+\.\d+\.\d+\b/)![0];
 const child=spawn(executable,[fileURLToPath(new URL('./fixtures/setup-native.py',import.meta.url)),socket,cwd],{stdio:['pipe','pipe','pipe']});
 await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('second native startup deadline')),3000);child.once('error',reject);child.stdout.once('data',()=>{clearTimeout(timeout);resolve();});});
 const physical=realpathSync(execFileSync('lsof',['-a','-p',String(child.pid),'-d','txt','-Fn'],{encoding:'utf8'}).split('\n').find(line=>line.startsWith('n'))!.slice(1));
 return {socket,executable:physical,supportedVersions:[version],async close(){const exited=once(child,'exit');child.stdin.end();await exited;}};
}
for(const replacement of ['valid-second-native','directory','socket','verification-close'] as const)test(`retained private verification rejects ${replacement} after capture before the final setter`,{timeout:60000},async()=>{
 const f=await fixture(),original=SetupNativeVerification.prototype.captureScope;let second:Awaited<ReturnType<typeof secondNative>>|undefined,armed=false;
 try{
  const selection={kind:'control' as const,allowedActions:['send_input' as const],scope:{kind:'single_work' as const,work:{node_id:f.key.id,endpoint_id:f.key.id,kind:'conversation' as const,native_id:'thread-final'}}};
  const preview=await callConnectionSetup(f.state,f.key.id,'setup.prepare',{selection});
  if(replacement==='valid-second-native'||replacement==='socket'){second=await secondNative(f.root,f.cwd);discoverControlListener({version:1,endpoint_id:f.key.id,...second});}
  SetupNativeVerification.prototype.captureScope=function(...args){return original.apply(this,args).then(proof=>{
   if(armed){armed=false;
    if(replacement==='valid-second-native')writeFileSync(join(f.state,'collaboration-control-runtime.json'),JSON.stringify({version:1,endpoint_id:f.key.id,socket:second!.socket,executable:second!.executable,supportedVersions:second!.supportedVersions}),{mode:0o600});
    else if(replacement==='directory'){renameSync(f.cwd,f.cwd+'-old');mkdirSync(f.cwd,{mode:0o700});}
    else if(replacement==='socket'){renameSync(join(f.root,'native.sock'),join(f.root,'native-old.sock'));renameSync(second!.socket,join(f.root,'native.sock'));}
    else void this.close();
   }
   return proof;
  });};armed=true;
  await assert.rejects(callConnectionSetup(f.state,f.key.id,'setup.apply',{preview_id:preview.preview_id,selection_hash:preview.selection_hash}));assert.equal(armed,false);assert.equal(existsSync(join(f.state,'collaboration-control.json')),false);
 }finally{SetupNativeVerification.prototype.captureScope=original;await f.app.close();await second?.close();await f.close();}
});

// Replace a genuinely verified native source only after the blocking final version
// subprocess returns, within the real synchronous setter fence.
for(const changed of ['config','socket'] as const)test(`final native version-return ${changed} replacement cannot authorize the previous verified source`,{timeout:60000},async()=>{
 const f=await fixture(),originalWrite=SetupScopeStore.prototype.write,originalExec=childProcess.execFileSync;let second:Awaited<ReturnType<typeof secondNative>>|undefined,inSetter=false,replaced=false;
 try{
  const selection={kind:'control' as const,allowedActions:['send_input' as const],scope:{kind:'single_work' as const,work:{node_id:f.key.id,endpoint_id:f.key.id,kind:'conversation' as const,native_id:'thread-final-scan'}}};
  const preview=await callConnectionSetup(f.state,f.key.id,'setup.prepare',{selection});second=await secondNative(f.root,f.cwd);discoverControlListener({version:1,endpoint_id:f.key.id,...second});
  SetupScopeStore.prototype.write=function(kind,value,expected,fence){return originalWrite.call(this,kind,value,expected,()=>{inSetter=true;try{return fence();}finally{inSetter=false;}});};
  childProcess.execFileSync=((...args:Parameters<typeof originalExec>)=>{const result=originalExec(...args);if(inSetter&&!replaced&&Array.isArray(args[1])&&args[1].includes('--version')){replaced=true;if(changed==='socket'){renameSync(join(f.root,'native.sock'),join(f.root,'native-old.sock'));renameSync(second!.socket,join(f.root,'native.sock'));}else writeFileSync(join(f.state,'collaboration-control-runtime.json'),JSON.stringify({version:1,endpoint_id:f.key.id,socket:second!.socket,executable:second!.executable,supportedVersions:second!.supportedVersions}),{mode:0o600});}return result;}) as typeof originalExec;syncBuiltinESMExports();
  await assert.rejects(callConnectionSetup(f.state,f.key.id,'setup.apply',{preview_id:preview.preview_id,selection_hash:preview.selection_hash}));assert.equal(replaced,true);assert.equal(existsSync(join(f.state,'collaboration-control.json')),false);
 }finally{childProcess.execFileSync=originalExec;syncBuiltinESMExports();SetupScopeStore.prototype.write=originalWrite;await f.app.close();await second?.close();await f.close();}
});
