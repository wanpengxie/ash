import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import WebSocket from 'ws';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {createServer} from 'node:net';
import {JsonProcess} from '../src/agents/process';
import {captureNativeReadDiscoveryInput,currentNativeReadDiscoveryInput,releaseNativeReadDiscoveryInput,discoverSavedHistorySource,currentSavedHistorySourceCandidate,nativeSavedHistorySourceSelection,releaseSavedHistorySourceCandidate} from '../src/setup/read-source-discovery';
// Fixed installed CLI, offline synthetic history, exact child environment only.
// Existing endpoint discovery sends initialize/initialized/config/read, no tasks.
const nativeFixturePath=new URL('./fixtures/read-source-native-realm.mjs',import.meta.url).href;
const native=await import(nativeFixturePath);
const pause=()=>new Promise(r=>setTimeout(r,20));
async function fixture(external=false){
 const root=realpathSync(mkdtempSync('/tmp/ash-rrealm.'));
 try{const f=await native.createNativeRealmFixture(root),socket=join(root,'read.sock');
 if(external)writeFileSync(join(f.home,'config.toml'),`sqlite_home = ${JSON.stringify(f.external)}\n`,{mode:0o600});
 writeFileSync(join(f.state,'collaboration-control-runtime.json'),JSON.stringify({version:1,endpoint_id:'fixture',socket,executable:f.executable,supportedVersions:[native.FIXED_VERSION]}),{mode:0o600});
 const p=new JsonProcess({command:f.executable,args:['app-server','--listen',`unix://${socket}`],env:{HOME:f.osHome,CODEX_HOME:f.home,PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}},f.home);
 const until=Date.now()+5000;while(!existsSync(socket)&&Date.now()<until)await pause();
 assert(existsSync(socket),'own native socket ready');
 return {...f,root,socket,p,capture:(current=()=>undefined)=>captureNativeReadDiscoveryInput({stateDir:f.state,endpointId:'fixture',codexHome:f.home,current,testing:{accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}}}),close:async()=>{await p.close();if(!p.child.stdout.closed||!p.child.stderr.closed)await new Promise<void>(r=>p.child.once('close',()=>r()));rmSync(root,{recursive:true,force:true});}};
 }catch(e){rmSync(root,{recursive:true,force:true});throw e;}
}
test('existing fixed native endpoint proves default and external physical SQLite sources without a new reader', {skip:process.platform!=='darwin',timeout:60000},async()=>{
 for(const external of [false,true]){const f=await fixture(external);let input:any,candidate:any;try{
 input=f.capture();candidate=await discoverSavedHistorySource(input);
 assert.deepEqual(Object.keys(candidate).sort(),['candidate_id','kind']);
 assert.equal(currentSavedHistorySourceCandidate(candidate),undefined);
 const selection=nativeSavedHistorySourceSelection(candidate);assert.equal(selection.codex_home,f.home);assert.equal(selection.sqlite_home,external?f.external:f.home);assert.equal(selection.profile,'default');
 assert.equal(existsSync(join(f.state,'collaboration-read.json')),false);assert.equal(existsSync(join(f.state,'collaboration-read-runtime.json')),false);
 // Ordinary history writes do not invalidate physical source continuity.
 writeFileSync(join(selection.sqlite_home,'ordinary-history-growth'),'synthetic',{mode:0o600});assert.equal(currentSavedHistorySourceCandidate(candidate),undefined);
 }finally{if(candidate)releaseSavedHistorySourceCandidate(candidate);if(input)releaseNativeReadDiscoveryInput(input);await f.close();}}
});
test('native-issued tokens reject forged inputs and candidates and missing endpoints',()=>{
 assert.throws(()=>currentNativeReadDiscoveryInput({kind:'native-read-discovery-input'}),{code:'invalid'});
 assert.throws(()=>currentSavedHistorySourceCandidate({kind:'saved-history-source-candidate',candidate_id:'synthetic'}),{code:'invalid'});
 const root=realpathSync(mkdtempSync('/tmp/ash-rrealm.'));try{assert.throws(()=>captureNativeReadDiscoveryInput({stateDir:root,endpointId:'fixture',codexHome:root,current:()=>undefined}),{code:process.platform==='darwin'?'source_required':'unsupported'});}finally{rmSync(root,{recursive:true,force:true});}
});
test('unknown artifact fails before any endpoint connection', {skip:process.platform!=='darwin'},()=>{
 const root=realpathSync(mkdtempSync('/tmp/ash-rrealm.'));try{const exe=join(root,'untrusted');writeFileSync(exe,'#!/bin/sh\necho codex-cli 0.162.0-alpha.17.2\n',{mode:0o700});writeFileSync(join(root,'collaboration-control-runtime.json'),JSON.stringify({version:1,endpoint_id:'fixture',socket:join(root,'absent.sock'),executable:exe,supportedVersions:[native.FIXED_VERSION]}),{mode:0o600});assert.throws(()=>captureNativeReadDiscoveryInput({stateDir:root,endpointId:'fixture',codexHome:root,current:()=>undefined,testing:{accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}}}),{code:'unsupported'});}finally{rmSync(root,{recursive:true,force:true});}
});
test('config response await replacement fails closed and cannot revive the old input', {skip:process.platform!=='darwin',timeout:30000},async()=>{
 const f=await fixture();let input:any;const original=WebSocket.prototype.send;try{
 input=f.capture();let changed=false;
 WebSocket.prototype.send=function(data:any,...args:any[]){const result=(original as any).call(this,data,...args);if(typeof data==='string'&&JSON.parse(data).method==='config/read'&&!changed){changed=true;queueMicrotask(()=>writeFileSync(join(f.home,'config.toml'),`sqlite_home = ${JSON.stringify(f.external)}\n`,{mode:0o600}));}return result;};
 await assert.rejects(discoverSavedHistorySource(input),{code:'stale'});assert(changed);rmSync(join(f.home,'config.toml'));assert.throws(()=>currentNativeReadDiscoveryInput(input),{code:'stale'});
 }finally{WebSocket.prototype.send=original;if(input)releaseNativeReadDiscoveryInput(input);await f.close();}
});
test('candidate retains realm/root/config fences after endpoint close', {skip:process.platform!=='darwin',timeout:60000},async()=>{
 for(const change of ['root','config','listener']as const){const f=await fixture(true);let input:any,candidate:any;try{input=f.capture();candidate=await discoverSavedHistorySource(input);
 if(change==='root'){renameSync(f.external,f.external+'.old');mkdirSync(f.external,{mode:0o700});writeFileSync(join(f.external,'state_5.sqlite'),readFileSync(join(f.external+'.old','state_5.sqlite')),{mode:0o600});}
 else if(change==='config'){const path=join(f.home,'config.toml');writeFileSync(path+'.new',readFileSync(path),{mode:0o600});renameSync(path+'.new',path);}
 else await f.p.close();
 assert.throws(()=>currentSavedHistorySourceCandidate(candidate),{code:'stale'});assert.throws(()=>nativeSavedHistorySourceSelection(candidate),{code:'stale'});
 }finally{if(candidate)releaseSavedHistorySourceCandidate(candidate);if(input)releaseNativeReadDiscoveryInput(input);await f.close();}}
});

test('classic all-visible extra-owner output after capture invalidates discovery permanently', {skip:process.platform!=='darwin',timeout:30000},async()=>{
 // Parser-adversarial fixture, not a claim that the tested CLI itself forks.
 // Real fork/accepted-clone kernel coverage remains native-listener-evidence.test.
 const f=await fixture();let input:any;const original=childProcess.execFileSync;try{
 input=f.capture();let injected=false;
 childProcess.execFileSync=((file:any,args:any,options:any)=>{const value=(original as any)(file,args,options);if(file==='lsof'&&args?.includes('-Fpn')){injected=true;return String(value)+`p2147483646\nn${f.socket}\n`;}return value;}) as any;syncBuiltinESMExports();
 await assert.rejects(discoverSavedHistorySource(input),{code:'stale'});assert(injected);
 childProcess.execFileSync=original;syncBuiltinESMExports();assert.throws(()=>currentNativeReadDiscoveryInput(input),{code:'stale'});
 }finally{childProcess.execFileSync=original;syncBuiltinESMExports();if(input)releaseNativeReadDiscoveryInput(input);await f.close();}
});

test('first classic version scan tail rejects physical socket replacement at capture and input current', {skip:process.platform!=='darwin',timeout:30000},async()=>{
 for(const phase of ['capture','current']as const){const f=await fixture(),server=createServer(),replacement=join(f.root,'replacement.sock'),old=join(f.root,'original.sock');let input:any,swapped=false;const original=childProcess.execFileSync;
 try{await new Promise<void>(r=>server.listen(replacement,r));if(phase==='current')input=f.capture();
 childProcess.execFileSync=((file:any,args:any,options:any)=>{const value=(original as any)(file,args,options);if(!swapped&&file===f.executable&&args?.includes('--version')){swapped=true;renameSync(f.socket,old);renameSync(replacement,f.socket);}return value;})as any;syncBuiltinESMExports();
 assert.throws(()=>phase==='capture'?f.capture():currentNativeReadDiscoveryInput(input),{code:'stale'});assert(swapped,'actual classic version tail replaced the listening pathname');
 childProcess.execFileSync=original;syncBuiltinESMExports();
 // Restoring the old pathname does not revive an already rejected input.
 renameSync(f.socket,replacement);renameSync(old,f.socket);if(input)assert.throws(()=>currentNativeReadDiscoveryInput(input),{code:'stale'});
 }finally{childProcess.execFileSync=original;syncBuiltinESMExports();if(input)releaseNativeReadDiscoveryInput(input);await new Promise<void>(r=>server.close(()=>r()));await f.close();}}
});
