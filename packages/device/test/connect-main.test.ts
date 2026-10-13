import test from 'node:test';import assert from 'node:assert/strict';
import {appendFileSync,mkdtempSync,realpathSync,writeFileSync,existsSync,rmSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {randomUUID} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
import {DeviceKey,type Connection} from 'ash-gateway/client/client';import {b64u} from 'ash-gateway/src/protocol';
import {startConnectedDevice as startDevice, type ConnectedDevice} from './fixtures/connected-device';import {connectCodex} from '../src/setup/connect';import {callConnectionSetup} from '../src/setup/material-ipc';
import {captureProtectedReadSource,currentReadSource,releaseReadSource,readSourceDrained} from '../src/collaboration/read-source';
const fixtureURL=new URL('./fixtures/read-source-native-realm.mjs',import.meta.url).href,native=await import(fixtureURL);

test('one confirmation discovers existing stdio without control and actual main reads through ordinary paired refresh',{skip:process.platform!=='darwin',timeout:90000},async()=>{
 const root=realpathSync(mkdtempSync('/tmp/ash-rrealm.'));let app:Awaited<ReturnType<typeof startDevice>>|undefined,original:any,link:ConnectedDevice|undefined;
 try{const f=await native.createNativeRealmFixture(root),key=await DeviceKey.generate(),owner=await DeviceKey.generate();writeFileSync(join(f.state,'device.jwk'),JSON.stringify(await key.exportJwk()),{mode:0o600});writeFileSync(join(f.state,'paired.json'),JSON.stringify({owner_key:owner.publicKey,grant_version:1,permissions:[]}),{mode:0o600});
 const turn=randomUUID(),events=[['event_msg',{type:'task_started',turn_id:turn,model_context_window:1000,collaboration_mode_kind:'default'}],['turn_context',{turn_id:turn,cwd:f.project,approval_policy:'never',sandbox_policy:{type:'read-only'},model:'synthetic',effort:null,summary:'auto'}],['event_msg',{type:'user_message',message:'synthetic user',images:[],local_images:[],text_elements:[]}],['response_item',{type:'message',role:'user',content:[{type:'input_text',text:'synthetic user'}]}],['event_msg',{type:'agent_message',message:'synthetic assistant',phase:'final_answer'}],['response_item',{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'synthetic assistant'}]}],['event_msg',{type:'task_complete',turn_id:turn,last_agent_message:'synthetic assistant'}]];appendFileSync(join(f.home,'synthetic-rollout.jsonl'),events.map(([type,payload])=>JSON.stringify({timestamp:'2026-01-01T00:00:01.000Z',type,payload})).join('\n')+'\n');
 original=await native.nativeReader(f.executable,f.home,f.osHome,f.project);
 const sourcePort={capture:(current:()=>undefined)=>captureProtectedReadSource({stateDir:f.state,endpointId:key.id,current,testing:{home:f.osHome,accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}}}),current:currentReadSource,release:releaseReadSource,drained:readSourceDrained};
 app=await startDevice({gateway:'https://paired-fixture.invalid',name:'synthetic computer',stateDir:f.state,workdir:f.project},undefined,{detect:async()=>[],testing:{sourceHome:f.home,readSource:{home:f.osHome,accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}},read:{source:sourcePort},detectBrowser:async()=>undefined,}});await app.run;link=app;
 assert(!existsSync(join(f.state,'collaboration-control-runtime.json')));assert(!existsSync(join(f.state,'collaboration-read-runtime.json')));
 let confirmations=0;const cancelled=await connectCodex({stateDir:f.state,endpointId:key.id,project:f.project,confirm:async()=>{confirmations++;return false;}});assert.equal(cancelled.state,'cancelled');assert(!existsSync(join(f.state,'collaboration-read-runtime.json')));assert(!existsSync(join(f.state,'collaboration-read.json')));
 confirmations=0;const result=await connectCodex({stateDir:f.state,endpointId:key.id,project:f.project,confirm:async summary=>{confirmations++;assert(summary.includes(f.project));assert(summary.includes(f.home));assert(summary.includes('replaces'));await new Promise(resolve=>setTimeout(resolve,31000));return true;}});assert.equal(confirmations,1);assert.equal(result.state,'readable');assert.equal(result.messages,2);
 const configPath=join(root,'device.json');writeFileSync(configPath,JSON.stringify({gateway:'https://paired-fixture.invalid',name:'synthetic computer',stateDir:f.state,workdir:f.project}),{mode:0o600});
 const python=String.raw`import os,pty,subprocess,select,sys,json,time
master,slave=pty.openpty();p=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave);os.close(slave);data=b'';sent=0;end=time.monotonic()+30
while time.monotonic()<end:
 ready,_,_=select.select([master],[],[],.1)
 if ready:
  try:chunk=os.read(master,65536)
  except OSError:break
  if not chunk:break
  data+=chunk
  if b'Allow read access? [y/N]' in data and not sent:os.write(master,b'yes\n');sent+=1
 if p.poll() is not None:break
if p.poll() is None:p.terminate()
p.wait(timeout=5);os.close(master)
print(json.dumps({'exit':p.returncode,'confirmations':sent,'connected':b'Connected. Saved conversations are readable' in data,'busy':b'busy' in data,'verify':b'read verification' in data}))`;
 const cli=await promisify(execFile)('python3',['-c',python,process.execPath,'--import','tsx',fileURLToPath(new URL('./fixtures/connect-cli.ts',import.meta.url)),'connect','codex','--project',f.project,'--config',configPath],{timeout:40000,env:{PATH:process.env.PATH,HOME:f.osHome},maxBuffer:8192});const cliEvidence=JSON.parse(cli.stdout);assert.equal(cliEvidence.exit,0,JSON.stringify(cliEvidence));assert.equal(cliEvidence.confirmations,1);assert.equal(cliEvidence.connected,true);
 const grant=JSON.parse(readFileSync(join(f.state,'collaboration-read.json'),'utf8'));assert.equal(grant.version,3);assert(!existsSync(join(f.state,'collaboration-control-runtime.json')));
 const manifestResult=await app.call('collaboration.endpoint.describe');const manifest={body:manifestResult.data as any};assert(manifest.body.capabilities.some((v:any)=>v.name==='collaboration.work.list'));const env={version:1,endpoint_id:key.id,authorization_revision:manifest.body.collaboration.authorization_revision,page:{limit:1}};
 const listed={body:await app.call('collaboration.work.list',env)};assert(listed.body.ok,JSON.stringify(listed.body.data));assert.equal((listed.body.data as any).items[0].work.native_id,f.markers[0]);
 const read={body:await app.call('collaboration.work.read',{...env,work:(listed.body.data as any).items[0].work})};assert(read.body.ok);assert.equal((read.body.data as any).items[0].messages.length,2);
 await app.replacePeer(key.id);const denied=await app.call('collaboration.work.list',env);assert.equal(denied.ok,false);
 link!.disconnect();await assert.rejects(callConnectionSetup(f.state,key.id,'setup.verify-read',{project:f.project}));
 }finally{await app?.close();await original?.close();rmSync(root,{recursive:true,force:true});}
});
