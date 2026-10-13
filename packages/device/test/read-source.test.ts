import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmodSync,linkSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {captureProtectedReadSource,currentReadSource,readSourceProcessDrainState,startReadSourceProcess,readSourceDrained,parseReadSourceDescriptor,readSourcePath,releaseReadSource} from '../src/collaboration/read-source';
import {JsonProcess} from '../src/agents/process';
import {probeSavedHistorySource} from '../src/collaboration/read-source-probe';
const python=execFileSync('python3',['-c','import sys; print(sys.executable)'],{encoding:'utf8'}).trim();
function fixture(){
  const root=realpathSync(mkdtempSync('/tmp/ash-rs.'));chmodSync(root,0o700);
  const state=join(root,'state'),home=join(root,'home'),cwd=join(root,'project'),exe=join(root,'codex');
  for(const p of [state,home,cwd])mkdirSync(p,{mode:0o700});
  writeFileSync(join(home,'auth.json'),JSON.stringify({auth_mode:'chatgpt',tokens:{account_id:'synthetic-fixture-account',id_token:[Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:'synthetic-fixture-subject',exp:4102444800,'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-fixture-account'}})).toString('base64url'),'synthetic-signature'].join('.'),access_token:'synthetic-fixture-access',refresh_token:'synthetic-fixture-refresh'},last_refresh:'2026-01-01T00:00:00Z'}),{mode:0o600});
 const body=`#!${python}\n${readFileSync('packages/device/test/fixtures/read-source-cli.py','utf8')}`;writeFileSync(exe,body,{mode:0o700});
  writeFileSync(join(home,'state_5.sqlite'),'synthetic database fixture',{mode:0o600});
  const descriptor={version:1,endpoint_id:'fixture-endpoint',source_id:'fixture-source',executable:exe,executable_sha256:createHash('sha256').update(body).digest('hex'),codex_home:home,sqlite_home:home,profile:'default',supported_versions:['0.0.1']};
  const config=readSourcePath(state);
  const save=()=>writeFileSync(config,JSON.stringify(descriptor),{mode:0o600});save();
  const capture=()=>captureProtectedReadSource({stateDir:state,endpointId:descriptor.endpoint_id,testing:{home,realmVersion:'0.0.1',artifact:{sha256:descriptor.executable_sha256,version:'0.0.1'}}});
  const replace=(p:string,mode:number)=>{writeFileSync(p+'.new',readFileSync(p),{mode});renameSync(p+'.new',p);};
  return {root,state,home,cwd,exe,config,descriptor,save,capture,replace,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
test('protected source accepts ordinary history growth and rejects source/config/executable replacement',()=>{
  for(const change of ['config','exe','home','mode']as const){const f=fixture();const source=f.capture();try{
    writeFileSync(join(f.home,'new-history'),'synthetic');assert.equal(currentReadSource(source),undefined);
    if(change==='config')f.replace(f.config,0o600);else if(change==='exe')f.replace(f.exe,0o700);else if(change==='home'){renameSync(f.home,f.home+'.old');mkdirSync(f.home,{mode:0o700});}else chmodSync(f.config,0o644);
    assert.throws(()=>currentReadSource(source),{code:'stale'});
  }finally{releaseReadSource(source);f.cleanup();}}
});
test('descriptor is closed default-profile contract and unavailable errors are explicit',()=>{
  const f=fixture();try{
    assert.throws(()=>parseReadSourceDescriptor({...f.descriptor,command:'arbitrary'},f.descriptor.endpoint_id),{code:'invalid'});
    assert.throws(()=>parseReadSourceDescriptor({...f.descriptor,profile:'named'},f.descriptor.endpoint_id),{code:'unsupported'});
    assert.throws(()=>currentReadSource({source_id:'forged',source_revision:'forged',version:'0.0.1'}),{code:'invalid'});
    f.descriptor.executable_sha256='0'.repeat(64);f.save();assert.throws(f.capture,{code:'unsupported'});
    rmSync(f.config);assert.throws(f.capture,{code:'source_required'});
  }finally{f.cleanup();}
});
test('same bound reader probe requests only scoped metadata and discards private fields',async()=>{
  for(const mode of ['','empty']){const f=fixture();writeFileSync(join(f.home,'fixture-mode'),mode);const source=f.capture();try{
    const result=await probeSavedHistorySource({source,allowedCwds:[f.cwd]});
    assert.deepEqual(result,{source:'codex.saved_history',source_state:'verified',readCapability:'verified',runtime_state:'unknown'});
    assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
    assert.deepEqual(readFileSync(join(f.home,'fixture-methods'),'utf8').trim().split('\n'),['initialize','initialized','thread/list']);
    assert.equal(currentReadSource(source),undefined);
  }finally{releaseReadSource(source);f.cleanup();}}
});
test('no selected scope observes source but leaves read capability unknown',async()=>{
  const f=fixture(),source=f.capture();try{
    assert.equal((await probeSavedHistorySource({source})).readCapability,'unknown');
    assert.deepEqual(readFileSync(join(f.home,'fixture-methods'),'utf8').trim().split('\n'),['initialize','initialized']);
  }finally{releaseReadSource(source);f.cleanup();}
});
test('metadata rejection, response tail replacement and shutdown tail replacement fail closed',async()=>{
  for(const mode of ['wrong-cwd','replace','drain-replace']){const f=fixture();writeFileSync(join(f.home,'fixture-mode'),mode);const source=f.capture();try{
    await assert.rejects(probeSavedHistorySource({source,allowedCwds:[f.cwd]}),{code:mode==='wrong-cwd'?'offline':'stale'});
  }finally{releaseReadSource(source);f.cleanup();}}
});
test('timeout and cancellation drain own dedicated process without native tasks',async()=>{
  for(const abort of [false,true]){const f=fixture();writeFileSync(join(f.home,'fixture-mode'),'hold');const source=f.capture();const controller=new AbortController();const timer=abort?setTimeout(()=>controller.abort(),100):undefined;try{
    await assert.rejects(probeSavedHistorySource({source,allowedCwds:[f.cwd],timeoutMs:200,signal:controller.signal}),{code:abort?'cancelled':'timeout'});
    assert.equal(currentReadSource(source),undefined);
  }finally{clearTimeout(timer);releaseReadSource(source);f.cleanup();}}
});

test('opaque default configuration continuity: presence, absence, replacement, deletion, links and callback changes',()=>{
  for(const change of ['absent-create','replace','delete','symlink','hardlink','callback']as const){
    const f=fixture(),config=join(f.home,'config.toml');
    if(change!=='absent-create')writeFileSync(config,'# synthetic config\n',{mode:0o600});
    let mutate=false;
    const source=captureProtectedReadSource({stateDir:f.state,endpointId:f.descriptor.endpoint_id,testing:{home:f.home,realmVersion:'0.0.1',artifact:{sha256:f.descriptor.executable_sha256,version:'0.0.1'}},current:()=>{if(mutate){mutate=false;writeFileSync(config,'# changed synthetic config\n');}return undefined;}});
    try{
      writeFileSync(join(f.home,'ordinary-history'),'synthetic');assert.equal(currentReadSource(source),undefined);
      if(change==='absent-create')writeFileSync(config,'# synthetic config\n',{mode:0o600});
      else if(change==='replace')f.replace(config,0o600);
      else if(change==='delete')rmSync(config);
      else if(change==='symlink'){renameSync(config,config+'.old');symlinkSync(config+'.old',config);}
      else if(change==='hardlink')linkSync(config,config+'.linked');
      else mutate=true;
      assert.throws(()=>currentReadSource(source),{code:'stale'});
      if(change==='absent-create')rmSync(config);
      assert.throws(()=>currentReadSource(source),{code:'stale'},'old proof must remain invalid after apparent restoration');
    }finally{releaseReadSource(source);f.cleanup();}
  }
  for(const linked of ['symlink','hardlink']){const f=fixture(),config=join(f.home,'config.toml');try{
    writeFileSync(config+'.target','# synthetic config\n',{mode:0o600});
    if(linked==='symlink')symlinkSync(config+'.target',config);else linkSync(config+'.target',config);
    assert.throws(f.capture,{code:'offline'});
  }finally{f.cleanup();}}
});
test('default configuration changes at metadata response and process drain reject retained proof',async()=>{
  for(const mode of ['response-config','drain-config']){const f=fixture();writeFileSync(join(f.home,'config.toml'),'# synthetic config\n',{mode:0o600});writeFileSync(join(f.home,'fixture-mode'),mode);const source=f.capture();try{
    await assert.rejects(probeSavedHistorySource({source,allowedCwds:[f.cwd]}),{code:'stale'});
    assert.throws(()=>currentReadSource(source),{code:'stale'});
  }finally{releaseReadSource(source);f.cleanup();}}
});

test('same-version nonvalidated artifact is rejected; HOME/realm isolation is not authenticity bypass',()=>{
  const f=fixture();try{
    const body=readFileSync(f.exe,'utf8').replaceAll('0.0.1','0.162.0-alpha.17.2');writeFileSync(f.exe,body);f.descriptor.executable_sha256=createHash('sha256').update(body).digest('hex');f.descriptor.supported_versions=['0.162.0-alpha.17.2'];f.save();
    for(const testing of [undefined,{home:f.home},{home:f.home,realmVersion:'0.162.0-alpha.17.2'}])assert.throws(()=>captureProtectedReadSource({stateDir:f.state,endpointId:f.descriptor.endpoint_id,testing}),{code:'unsupported'});
  }finally{f.cleanup();}
});
test('SIGTERM-ignoring fixture is not verified before actual child and raw pipes close',async()=>{
  const f=fixture();writeFileSync(join(f.home,'fixture-mode'),'ignore-term');const source=f.capture();const original=JsonProcess.prototype.close;let observed:JsonProcess|undefined;JsonProcess.prototype.close=function(){observed=this;return original.call(this);};try{
    const result=await probeSavedHistorySource({source,allowedCwds:[f.cwd]});assert.equal(result.readCapability,'verified');assert(observed);assert(observed.child.exitCode!==null||observed.child.signalCode!==null);assert.equal(observed.child.stdin.closed,true);assert.equal(observed.child.stdout.closed,true);assert.equal(observed.child.stderr.closed,true);assert.equal(readSourceProcessDrainState(source,observed),'closed');
    // release succeeds only after exact child/pipe close and group disappearance.
    assert.equal(releaseReadSource(source),undefined);
  }finally{JsonProcess.prototype.close=original;await readSourceDrained(source);releaseReadSource(source);f.cleanup();}
});
test('escaped raw pipe holder yields draining, retains source, and releases only on late real drain',async()=>{
  const f=fixture();writeFileSync(join(f.home,'fixture-mode'),'escape-pipe');const source=f.capture();let holder:number|undefined;const original=JsonProcess.prototype.close;let observed:JsonProcess|undefined;JsonProcess.prototype.close=function(){observed=this;return original.call(this);};
  try{
    await assert.rejects(probeSavedHistorySource({source,allowedCwds:[f.cwd]}),{code:'draining'});
    assert(observed);assert.equal(readSourceProcessDrainState(source,observed),'draining');assert.equal(observed.child.stdout.closed,false);assert.throws(()=>releaseReadSource(source),{code:'draining'});await assert.rejects(startReadSourceProcess(source),{code:'offline'});
    holder=Number(readFileSync(join(f.home,'fixture-pipe-holder'),'utf8'));assert(Number.isSafeInteger(holder)&&holder>0);process.kill(-holder,'SIGKILL');holder=undefined;
    await readSourceDrained(source);assert.equal(currentReadSource(source),undefined);assert.equal(releaseReadSource(source),undefined);
  }finally{
    JsonProcess.prototype.close=original;
    if(holder===undefined){try{const pid=Number(readFileSync(join(f.home,'fixture-pipe-holder'),'utf8'));if(Number.isSafeInteger(pid)&&pid>0)process.kill(-pid,'SIGKILL');}catch{}}
    else try{process.kill(-holder,'SIGKILL');}catch{}
    await readSourceDrained(source);releaseReadSource(source);f.cleanup();
  }
});

test('fresh source retains durable grant binding after ordinary configuration rewrites while old proof stays stale',()=>{
 for(const change of ['runtime','profile','artifact','auth']as const){const f=fixture();writeFileSync(join(f.home,'config.toml'),'# synthetic config\n',{mode:0o600});const first=f.capture();try{
  if(change==='runtime')f.replace(f.config,0o600);else if(change==='profile')writeFileSync(join(f.home,'config.toml'),'# ordinary non-source preference change\n',{mode:0o600});else if(change==='artifact')f.replace(f.exe,0o700);else f.replace(join(f.home,'auth.json'),0o600);
  assert.throws(()=>currentReadSource(first),{code:'stale'});const next=f.capture();try{assert.equal(next.source_revision,first.source_revision);assert.equal(currentReadSource(next),undefined);}finally{releaseReadSource(next);}
 }finally{releaseReadSource(first);f.cleanup();}}
});
