import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,existsSync,readFileSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {DeviceKey} from 'ash-gateway/client/client';
import {JsonProcess} from '../src/agents/process';
import {ReadSourceSettings} from '../src/setup/read-source-settings';
import {ConnectionSetupService} from '../src/setup/service';
import {releaseSavedHistorySourceCandidate,releaseNativeReadDiscoveryInput} from '../src/setup/read-source-discovery';
import {MaterialSetupIpcServer,callReadSourceSetup,callConnectionSetup} from '../src/setup/material-ipc';
import {observeAuthorizationWrites} from './fixtures/authorization-events';
import {SetupNativeVerification} from '../src/setup/native-verification';
import {captureProtectedReadSource,releaseReadSource} from '../src/collaboration/read-source';
const path=new URL('./fixtures/read-source-native-realm.mjs',import.meta.url).href,native=await import(path);
async function fixture(external=false,hook?:()=>void){const root=realpathSync(mkdtempSync('/tmp/ash-rrealm.'));const f=await native.createNativeRealmFixture(root),owner=await DeviceKey.generate(),socket=join(root,'read.sock');
 writeFileSync(join(f.state,'paired.json'),JSON.stringify({owner_key:owner.publicKey,grant_version:1}),{mode:0o600});
 if(external)writeFileSync(join(f.home,'config.toml'),`sqlite_home = ${JSON.stringify(f.external)}\n`,{mode:0o600});
 writeFileSync(join(f.state,'collaboration-control-runtime.json'),JSON.stringify({version:1,endpoint_id:'fixture',socket,executable:f.executable,supportedVersions:[native.FIXED_VERSION]}),{mode:0o600});
 const p=new JsonProcess({command:f.executable,args:['app-server','--listen',`unix://${socket}`],env:{HOME:f.osHome,CODEX_HOME:f.home,PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}},f.home);
 const until=Date.now()+5000;while(!existsSync(socket)&&Date.now()<until)await new Promise(r=>setTimeout(r,20));assert(existsSync(socket));let reserved=false,now=Date.now(),stopping=false;
 const current=()=>{if(stopping)throw Error('fixture closed');return undefined;};
 const runtime={reserveChange:async()=>{assert(!reserved);reserved=true;let released=false;return {assertCurrent:()=>{assert(!released&&!stopping);return undefined;},release:()=>{released=true;reserved=false;return undefined;}};}};
 const source=new ReadSourceSettings({stateDir:f.state,endpointId:'fixture',runtime,current,now:()=>now,testing:{defaultHome:f.home,source:{home:f.osHome,accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}},beforeDescriptorWrite:()=>hook?.()}});
 const verification=new SetupNativeVerification({stateDir:f.state,nodeId:'fixture',endpointId:'fixture',current,readTesting:{home:f.osHome,accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}}});
 const service=new ConnectionSetupService({stateDir:f.state,nodeId:'fixture',endpointId:'fixture',runtime,verification,readSource:source});const ipc=await MaterialSetupIpcServer.open(f.state,'fixture',service);
 return {...f,owner,root,p,source,service,ipc,advance:()=>now+=31000,reserved:()=>reserved,stop:()=>stopping=true,async close(){await ipc.close();await verification.close();await source.close();service.close();await p.close();if(!p.child.stdout.closed||!p.child.stderr.closed)await new Promise<void>(r=>p.child.once('close',()=>r()));rmSync(root,{recursive:true,force:true});}};
}
test('actual fixed source service and authenticated IPC save default/external, reset old v2, and require explicit v3 scope',{skip:process.platform!=='darwin',timeout:90000},async()=>{
 for(const external of [false,true]){const f=await fixture(external);try{
 writeFileSync(join(f.state,'collaboration-read.json'),JSON.stringify({version:2,owner_id:f.owner.id,endpoint_id:'fixture',authorization_generation:1,allowedCwds:[f.project]}),{mode:0o600});
 await new Promise(r=>setTimeout(r,1100));const before=readFileSync(join(f.state,'collaboration-read.json'),'utf8');const preview=await callReadSourceSetup(f.state,'fixture','source.prepare',{selection:{kind:'default'}});
 assert.equal(preview.resetsReadGrant,true);assert.equal(existsSync(join(f.state,'collaboration-read-runtime.json')),false);assert.equal(readFileSync(join(f.state,'collaboration-read.json'),'utf8'),before);
 const status=await callReadSourceSetup(f.state,'fixture','source.apply',{preview_id:preview.preview_id,selection_hash:preview.selection_hash});assert.equal(status.state,'configured');assert.equal(status.needsReadGrant,true);assert(!existsSync(join(f.state,'collaboration-read.json')));
 const descriptor=JSON.parse(readFileSync(join(f.state,'collaboration-read-runtime.json'),'utf8'));assert.equal(descriptor.sqlite_home,external?f.external:f.home);
 await assert.rejects(callReadSourceSetup(f.state,'fixture','source.apply',{preview_id:preview.preview_id,selection_hash:preview.selection_hash}));
 // The saved reader is independent of the control listener after selection.
 await f.p.close();await observeAuthorizationWrites(f.state,['collaboration-control-runtime.json'],()=>rmSync(join(f.state,'collaboration-control-runtime.json')));
 const read=await callConnectionSetup(f.state,'fixture','setup.prepare',{selection:{kind:'read',allowedCwds:[f.project]}});await callConnectionSetup(f.state,'fixture','setup.apply',{preview_id:read.preview_id,selection_hash:read.selection_hash});
 const grant=JSON.parse(readFileSync(join(f.state,'collaboration-read.json'),'utf8')),proof=captureProtectedReadSource({stateDir:f.state,endpointId:'fixture',testing:{home:f.osHome,accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}}});try{assert.equal(grant.version,3);assert.equal(grant.source_id,proof.source_id);assert.equal(grant.binding_revision,proof.source_revision);}finally{releaseReadSource(proof);}
 assert.equal((await callReadSourceSetup(f.state,'fixture','source.status',{})).needsReadGrant,false);assert.equal(f.reserved(),false);
 }finally{await f.close();}}
});
test('expiry, foreign family, raw paths and failed descriptor phase do not retain old authorization',{skip:process.platform!=='darwin',timeout:90000},async()=>{
 let action=()=>{};const f=await fixture(false,()=>action());try{
 await assert.rejects(callReadSourceSetup(f.state,'fixture','source.prepare',{selection:{kind:'default',home:f.home}}));
 const clear=await callConnectionSetup(f.state,'fixture','setup.prepare',{selection:{kind:'read',clear:true}});await assert.rejects(callReadSourceSetup(f.state,'fixture','source.apply',{preview_id:clear.preview_id,selection_hash:clear.selection_hash}));
 let p=await callReadSourceSetup(f.state,'fixture','source.prepare',{selection:{kind:'default'}});f.advance();await assert.rejects(callReadSourceSetup(f.state,'fixture','source.apply',{preview_id:p.preview_id,selection_hash:p.selection_hash}));
 const old={version:2,owner_id:f.owner.id,endpoint_id:'fixture',authorization_generation:1,allowedCwds:[f.project]};writeFileSync(join(f.state,'collaboration-read.json'),JSON.stringify(old),{mode:0o600});
 await new Promise(r=>setTimeout(r,1100));p=await callReadSourceSetup(f.state,'fixture','source.prepare',{selection:{kind:'default'}});action=()=>{throw Error('owned injected second-write fault');};await assert.rejects(callReadSourceSetup(f.state,'fixture','source.apply',{preview_id:p.preview_id,selection_hash:p.selection_hash}));assert(!existsSync(join(f.state,'collaboration-read.json')));assert(!existsSync(join(f.state,'collaboration-read-runtime.json')));assert.equal(f.reserved(),false);
 action=()=>{};p=await callReadSourceSetup(f.state,'fixture','source.prepare',{selection:{kind:'clear'}});await callReadSourceSetup(f.state,'fixture','source.apply',{preview_id:p.preview_id,selection_hash:p.selection_hash});
 }finally{await f.close();}
});
test('a foreign owner write between the exact deletion receipt and descriptor commit is rejected',{skip:process.platform!=='darwin',timeout:45000},async()=>{
 let action=()=>{};const f=await fixture(false,()=>action());try{
 writeFileSync(join(f.state,'collaboration-read.json'),JSON.stringify({version:2,owner_id:f.owner.id,endpoint_id:'fixture',authorization_generation:1,allowedCwds:[f.project]}),{mode:0o600});await new Promise(r=>setTimeout(r,1100));const p=await callReadSourceSetup(f.state,'fixture','source.prepare',{selection:{kind:'default'}});const other=await DeviceKey.generate();action=()=>writeFileSync(join(f.state,'paired.json'),JSON.stringify({owner_key:other.publicKey,grant_version:2}),{mode:0o600});
 await assert.rejects(callReadSourceSetup(f.state,'fixture','source.apply',{preview_id:p.preview_id,selection_hash:p.selection_hash}));assert(!existsSync(join(f.state,'collaboration-read.json')));assert(!existsSync(join(f.state,'collaboration-read-runtime.json')));assert.equal(f.reserved(),false);
 }finally{await f.close();}
});

test('candidate release failure still closes the independent discovery input',{skip:process.platform!=='darwin',timeout:60000},async()=>{const f=await fixture();try{let inputs=0;const hooks=(f.source as any).options.testing;hooks.releaseCandidate=(candidate:any)=>{releaseSavedHistorySourceCandidate(candidate);throw Error('synthetic release failure');};hooks.releaseInput=(input:any)=>{inputs++;return releaseNativeReadDiscoveryInput(input);};await assert.rejects(callReadSourceSetup(f.state,'fixture','source.inspect',{}));assert.equal(inputs,1);assert(!existsSync(join(f.state,'collaboration-read-runtime.json')));assert(!existsSync(join(f.state,'collaboration-read.json')));}finally{await f.close();}});
