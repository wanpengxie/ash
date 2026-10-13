import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,rmSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {DeviceKey,type Connection} from 'ash-gateway/client/client';
import {deviceCli} from '../src/cli';
import {startConnectedDevice as startDevice, type ConnectedDevice} from './fixtures/connected-device';

import {ConnectionSetupService} from '../src/setup/service';
import {MaterialSetupIpcServer} from '../src/setup/material-ipc';
import type {ControlRuntimeSettings} from '../src/setup/control-runtime-settings';
import {captureProtectedReadSource,currentReadSource,releaseReadSource,readSourceDrained} from '../src/collaboration/read-source';

const loader=import.meta.resolve('tsx');
const cli=fileURLToPath(new URL('./fixtures/connect-cli.ts',import.meta.url));
const python=String.raw`import os,pty,subprocess,select,sys,json,time
cwd,answers=sys.argv[1],json.loads(sys.argv[2]);master,slave=pty.openpty()
p=subprocess.Popen(sys.argv[3:],cwd=cwd,stdin=slave,stdout=slave,stderr=slave);os.close(slave);data=b'';sent=0;end=time.monotonic()+30
while time.monotonic()<end:
 ready,_,_=select.select([master],[],[],.1)
 if ready:
  try:chunk=os.read(master,65536)
  except OSError:break
  if not chunk:break
  data+=chunk
  if sent<len(answers) and answers[sent][0].encode() in data:
   os.write(master,(answers[sent][1]+'\n').encode());sent+=1
 if p.poll() is not None:break
if p.poll() is None:p.terminate()
p.wait(timeout=5);os.close(master)
print(json.dumps({'exit':p.returncode,'prompts':sent,'output':data.decode(errors='replace')}))`;
async function terminal(cwd:string,args:string[],answers:string[][],env:NodeJS.ProcessEnv=process.env){
 const result=await promisify(execFile)('python3',['-c',python,cwd,JSON.stringify(answers),process.execPath,'--import',loader,cli,...args],{timeout:40000,env,maxBuffer:16384});
 return JSON.parse(result.stdout) as {exit:number;prompts:number;output:string};
}
function snapshot(state:string){return Object.fromEntries(readdirSync(state).filter(name=>name.endsWith('.json')||name.endsWith('.jwk')).map(name=>[name,readFileSync(join(state,name),'utf8')]));}
async function config(root:string,project:string){
 const state=join(root,'state');mkdirSync(state,{mode:0o700});const key=await DeviceKey.generate(),owner=await DeviceKey.generate();
 writeFileSync(join(state,'device.jwk'),JSON.stringify(await key.exportJwk()),{mode:0o600});
 writeFileSync(join(state,'paired.json'),JSON.stringify({owner_key:owner.publicKey,grant_version:1,permissions:[]}),{mode:0o600});
 const path=join(root,'device.json');writeFileSync(path,JSON.stringify({gateway:'https://fixture.invalid',name:'fixture',stateDir:state,workdir:project}),{mode:0o600});
 return {state,key,owner,path};
}

test('invalid project arguments and wrong connect targets fail before startup or state access',async()=>{
 const start=(async()=>{throw Error('must not start');}) as typeof startDevice;
 for(const args of [['connect','other'],['connect','codex','--project'],['connect','codex','--project',''],['connect','codex','--project','--control'],['connect','codex','--project','--config','missing'],['connect','codex','stray'],['connect','codex','--project','a','--project','b']]){
  await assert.rejects(deviceCli(start,args),/Use ash-device connect codex|requires a value|Unexpected connect argument/);
 }
});

test('control cwd default and explicit override reach numbered discovery through real protected IPC; cancellation and non-TTY never grant',async()=>{
 const root=realpathSync(mkdtempSync('/tmp/ash-connect-cli-')),cwd=join(root,'cwd'),explicit=join(root,"other ' $(project)");mkdirSync(cwd);mkdirSync(explicit);
 const f=await config(root,cwd),projects:string[]=[];
 writeFileSync(join(f.state,'collaboration-read.json'),JSON.stringify({version:2,owner_id:f.owner.id,endpoint_id:f.key.id,authorization_generation:1,allowedCwds:[cwd]}),{mode:0o600});
 writeFileSync(join(f.state,'collaboration-control-runtime.json'),JSON.stringify({version:1,endpoint_id:f.key.id,socket:'/isolated/control.sock',executable:'/isolated/codex',supportedVersions:['0.134.0']}),{mode:0o600});
 // Only the native metadata port is isolated; CLI parsing, selection, pairing,
 // runtime configuration validation, service and authenticated IPC are real.
 const runtime={listLoadedWorks:async(project:string,current:()=>undefined)=>{assert.equal(current(),undefined);projects.push(project);return {owner_id:f.owner.id,items:[{work:{node_id:f.key.id,endpoint_id:f.key.id,kind:'conversation',native_id:'fixture-loaded'},title:'fixture conversation',cwd:project,updated_at:null}]};}};
 const service=new ConnectionSetupService({stateDir:f.state,endpointId:f.key.id,controlRuntime:runtime as unknown as ControlRuntimeSettings});
 const server=await MaterialSetupIpcServer.open(f.state,f.key.id,service),before=snapshot(f.state);
 try{
  for(const extra of [[],['--project',explicit]]){
   const result=await terminal(cwd,['connect','codex','--control',...extra,'--config',f.path],[['Choose a conversation number','']]);
   assert.equal(result.exit,0,result.output);assert.equal(result.prompts,1);assert.match(result.output,/Cancelled; no control permission/);assert(!result.output.includes('Control permission saved'));
   assert.deepEqual(snapshot(f.state),before);
  }
  assert.deepEqual(projects,[cwd,explicit]);
  const error=await promisify(execFile)(process.execPath,['--import',loader,cli,'connect','codex','--control','--config',f.path],{cwd}).then(()=>null,error=>error);
  assert.match(error.stderr,/interactive terminal/);assert.deepEqual(projects,[cwd,explicit]);assert.deepEqual(snapshot(f.state),before);
 }finally{await server.close();service.close();rmSync(root,{recursive:true,force:true});}
});


test('read cwd default and explicit override use real main, native history and PTY; cancellation preserves scope and next command targets explicit project safely',{skip:process.platform!=='darwin',timeout:90000},async()=>{
 const native=await import(new URL('./fixtures/read-source-native-realm.mjs',import.meta.url).href);
 const root=realpathSync(mkdtempSync('/tmp/ash-rrealm.'));let original:any,app:Awaited<ReturnType<typeof startDevice>>|undefined;
 try{
  const f=await native.createNativeRealmFixture(root),explicit=join(root,"other ' $(project)");mkdirSync(explicit);
  const key=await DeviceKey.generate(),owner=await DeviceKey.generate();writeFileSync(join(f.state,'device.jwk'),JSON.stringify(await key.exportJwk()),{mode:0o600});writeFileSync(join(f.state,'paired.json'),JSON.stringify({owner_key:owner.publicKey,grant_version:1,permissions:[]}),{mode:0o600});
  const control=JSON.stringify({version:1,owner_id:owner.id,endpoint_id:key.id,authorization_generation:1,allowed_actions:['send_input','steer'],scope:{kind:'single_work',work:{node_id:key.id,endpoint_id:key.id,kind:'conversation',native_id:'existing-control'}}});
  writeFileSync(join(f.state,'collaboration-control.json'),control,{mode:0o600});
  const path=join(root,'device.json'),device={gateway:'https://fixture.invalid',name:'fixture',stateDir:f.state,workdir:explicit};writeFileSync(path,JSON.stringify(device),{mode:0o600});
  original=await native.nativeReader(f.executable,f.home,f.osHome,f.project);
  const source={capture:(current:()=>undefined)=>captureProtectedReadSource({stateDir:f.state,endpointId:key.id,current,testing:{home:f.osHome,accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}}}),current:currentReadSource,release:releaseReadSource,drained:readSourceDrained};
  const open=()=>startDevice(device,undefined,{detect:async()=>[],testing:{sourceHome:f.home,readSource:{home:f.osHome,accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}},read:{source},detectBrowser:async()=>undefined,}});app=await open();await app.run;
  const env={PATH:process.env.PATH,HOME:f.osHome},before=snapshot(f.state);
  const cancelled=await terminal(f.project,['connect','codex','--config',path],[['Allow read access?','n']],env);assert.equal(cancelled.exit,0,cancelled.output);assert.match(cancelled.output,/Cancelled; no read, control or material permissions were saved/);assert.deepEqual(snapshot(f.state),before);
  const error=await promisify(execFile)(process.execPath,['--import',loader,cli,'connect','codex','--config',path],{cwd:f.project,env}).then(()=>null,error=>error);assert.match(error.stderr,/interactive terminal/);assert.deepEqual(snapshot(f.state),before);
  for(const extra of [[],['--project',explicit]]){
   if(extra.length){await app.close();app=await open();await app.run;}
   const project=extra.length?explicit:f.project;
   const result=await terminal(f.project,['connect','codex',...extra,'--config',path],[['Allow read access?','yes']],env);
   assert.equal(result.exit,0,result.output);assert.equal(result.prompts,1);assert.match(result.output,/This project is readable\. Sending permissions were not changed by this command\./);
   const grant=JSON.parse(readFileSync(join(f.state,'collaboration-read.json'),'utf8'));assert.deepEqual(grant.allowedCwds,[project]);assert.equal(readFileSync(join(f.state,'collaboration-control.json'),'utf8'),control);assert(!existsSync(join(f.state,'collaboration-control-runtime.json')));
   const next=result.output.split('\r\n').find(line=>line.includes('To allow sending,'))!;assert(next);assert.equal((result.output.match(/connect codex --control/g)??[]).length,1);
   if(extra.length){
    const command=next.slice(next.indexOf('confirm: ')+9);
    const parsed=await promisify(execFile)('python3',['-c','import shlex,json,sys;print(json.dumps(shlex.split(sys.argv[1])))',command]);
    assert.deepEqual(JSON.parse(parsed.stdout),[join(f.osHome,'.ash-device','current','bin','ash-device'),'connect','codex','--control','--project',explicit,'--config',path]);
   }else assert(!next.includes('--project'));
  }
 }finally{await app?.close();await original?.close();rmSync(root,{recursive:true,force:true});}
});
