import test from 'node:test';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import assert from 'node:assert/strict';
import {appendFileSync,chmodSync,linkSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,statSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {captureReadRealm,currentReadRealm,releaseReadRealm} from '../src/collaboration/read-source-realm';
import {closeReadSourceProcess,attestReadSourceProcess,captureProtectedReadSource,currentReadSource,parseReadSourceDescriptor,readSourcePath,releaseReadSource,startReadSourceProcess} from '../src/collaboration/read-source';
import {probeSavedHistorySource} from '../src/collaboration/read-source-probe';
const mac={skip:process.platform!=='darwin',timeout:30000};
const native=await import(new URL('./fixtures/read-source-native-realm.mjs',import.meta.url).href);
function bare(){const root=realpathSync(mkdtempSync('/tmp/ash-rrealm.'));chmodSync(root,0o700);const realm=join(root,'realm');mkdirSync(realm,{mode:0o700});const db=join(realm,'state_5.sqlite');writeFileSync(db,'synthetic database fixture',{mode:0o600});return {root,realm,db,cleanup:()=>rmSync(root,{recursive:true,force:true})};}
test('realm pins physical directory and DB identity but accepts normal database writes',mac,()=>{
  const f=bare(),proof=captureReadRealm({root:f.realm,version:'0.162.0-alpha.17.2'});try{
    appendFileSync(f.db,' ordinary synthetic history update');writeFileSync(join(f.realm,'state_5.sqlite-wal'),'synthetic');assert.equal(currentReadRealm(proof),undefined);
    renameSync(f.db,f.db+'.old');writeFileSync(f.db,'replacement',{mode:0o600});assert.throws(()=>currentReadRealm(proof),{code:'stale'});
    rmSync(f.db);renameSync(f.db+'.old',f.db);assert.throws(()=>currentReadRealm(proof),{code:'stale'});
  }finally{releaseReadRealm(proof);releaseReadRealm(proof);f.cleanup();}
});
test('realm rejects replacement, missing, relative, symlink and hardlink sources',mac,()=>{
  for(const mode of ['root','missing','relative','root-symlink','db-symlink','db-hardlink']){const f=bare();try{
    if(mode==='root'){const p=captureReadRealm({root:f.realm,version:'0.162.0-alpha.17.2'});try{renameSync(f.realm,f.realm+'.old');mkdirSync(f.realm,{mode:0o700});writeFileSync(f.db,'replacement',{mode:0o600});assert.throws(()=>currentReadRealm(p),{code:'stale'});}finally{releaseReadRealm(p);}}
    else{let root=f.realm;if(mode==='missing')rmSync(f.db);else if(mode==='relative')root='relative';else if(mode==='root-symlink'){symlinkSync(f.realm,f.realm+'.alias');root=f.realm+'.alias';}else if(mode==='db-symlink'){renameSync(f.db,f.db+'.old');symlinkSync(f.db+'.old',f.db);}else linkSync(f.db,f.db+'.alias');assert.throws(()=>captureReadRealm({root,version:'0.162.0-alpha.17.2'}),{code:mode==='missing'?'source_required':mode==='relative'||mode==='root-symlink'?'invalid':'offline'});}
  }finally{f.cleanup();}}
});
test('unknown layout and missing explicit realm do not infer another default database',()=>{
  const f=bare();try{
    assert.throws(()=>captureReadRealm({root:f.realm,version:'99.0.0'}),{code:'unsupported'});
    assert.throws(()=>currentReadRealm({revision:'forged'}),{code:'invalid'});
    assert.throws(()=>parseReadSourceDescriptor({version:1},'fixture-endpoint'),{code:'source_required'});
  }finally{f.cleanup();}
});
test('callback replacement invalidates realm before returning snapshot and stays invalid',mac,()=>{
  const f=bare();let mutate=false;const p=captureReadRealm({root:f.realm,version:'0.162.0-alpha.17.2',current:()=>{if(mutate){mutate=false;renameSync(f.db,f.db+'.old');writeFileSync(f.db,'replacement',{mode:0o600});}return undefined;}});try{mutate=true;assert.throws(()=>currentReadRealm(p),{code:'stale'});assert.throws(()=>currentReadRealm(p),{code:'stale'});}finally{releaseReadRealm(p);f.cleanup();}
});
test('actual fixed CLI resolves distinct existing default/external synthetic list and metadata read',mac,async()=>{
  const root=realpathSync(mkdtempSync('/tmp/ash-rrealm.'));try{
    const f=await native.createNativeRealmFixture(root);
    for(const[i,realm]of [f.home,f.external].entries()){
      writeFileSync(readSourcePath(f.state),JSON.stringify(f.descriptor(realm)),{mode:0o600});const source=captureProtectedReadSource({stateDir:f.state,endpointId:'fixture-endpoint',testing:{home:f.osHome,accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}}});
      try{
        const state=await probeSavedHistorySource({source,allowedCwds:[f.project]});assert.equal(state.readCapability,'verified');assert.equal(state.runtime_state,'unknown');
        const process=await startReadSourceProcess(source);process.onFrame=frame=>{if(frame.id!==undefined&&!frame.method)process.settle(frame.id,frame.result,frame.error);};
        try{
          await process.request('initialize',{clientInfo:{name:'ash-realm-reader-test',version:'1'},capabilities:{experimentalApi:true}},10000);currentReadSource(source);process.write({jsonrpc:'2.0',method:'initialized',params:{}});
          const page=await process.request('thread/list',{limit:1,cwd:[f.project],useStateDbOnly:true},10000);currentReadSource(source);attestReadSourceProcess(source,process);assert.equal(page.data[0]?.id,f.markers[i]);
          const read=await process.request('thread/read',{threadId:f.markers[i],includeTurns:false},10000);currentReadSource(source);attestReadSourceProcess(source,process);assert.equal(read.thread?.id,f.markers[i]);
          await assert.rejects(process.request('thread/read',{threadId:f.markers[1-i],includeTurns:false},10000));
          assert.throws(()=>attestReadSourceProcess(source,{} as any),{code:'invalid'});
        }finally{await closeReadSourceProcess(source,process);currentReadSource(source);}
        const statBefore=statSync(join(realm,'state_5.sqlite'),{bigint:true});
        const r=await native.nativeReader(f.executable,f.home,f.osHome,f.project,realm);try{await r.call('thread/list',{limit:1,cwd:[f.project],useStateDbOnly:true});}finally{await r.close();}
        assert.equal(statSync(join(realm,'state_5.sqlite'),{bigint:true}).ino,statBefore.ino);assert.equal(currentReadSource(source),undefined);
      }finally{releaseReadSource(source);}
    }
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('actual CLI open-FD proof rejects a deliberately misdirected testing command',mac,async()=>{
  const root=realpathSync(mkdtempSync('/tmp/ash-rrealm.'));try{const f=await native.createNativeRealmFixture(root);writeFileSync(readSourcePath(f.state),JSON.stringify(f.descriptor(f.home)),{mode:0o600});const source=captureProtectedReadSource({stateDir:f.state,endpointId:'fixture-endpoint',testing:{home:f.osHome,accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'},command:{command:f.executable,args:['-c',`sqlite_home=${JSON.stringify(f.external)}`,'app-server','--stdio'],env:{HOME:f.osHome,CODEX_HOME:f.home,PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}}}});try{await assert.rejects(probeSavedHistorySource({source,allowedCwds:[f.project]}),{code:'offline'});}finally{releaseReadSource(source);}}finally{rmSync(root,{recursive:true,force:true});}
});
test('actual configured external realm and cwd change remain on the explicitly selected existing root',mac,async()=>{
  const root=realpathSync(mkdtempSync('/tmp/ash-rrealm.'));try{const f=await native.createNativeRealmFixture(root);writeFileSync(join(f.home,'config.toml'),`sqlite_home = ${JSON.stringify(f.external)}\n`,{mode:0o600});writeFileSync(readSourcePath(f.state),JSON.stringify(f.descriptor(f.external)),{mode:0o600});const source=captureProtectedReadSource({stateDir:f.state,endpointId:'fixture-endpoint',testing:{home:f.osHome,accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}}});try{assert.equal((await probeSavedHistorySource({source,allowedCwds:[f.project]})).readCapability,'verified');appendFileSync(join(f.home,'config.toml'),'\n# synthetic configuration replacement\n');assert.throws(()=>currentReadSource(source),{code:'stale'});}finally{releaseReadSource(source);}}finally{rmSync(root,{recursive:true,force:true});}
});

test('real open-FD scan tail database replacement rejects before verified result',mac,async()=>{
  const root=realpathSync(mkdtempSync('/tmp/ash-rrealm.'));const original=childProcess.execFileSync;let swapped=false;
  try{const f=await native.createNativeRealmFixture(root);writeFileSync(readSourcePath(f.state),JSON.stringify(f.descriptor(f.home)),{mode:0o600});const source=captureProtectedReadSource({stateDir:f.state,endpointId:'fixture-endpoint',testing:{home:f.osHome,accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}}});try{
    childProcess.execFileSync=((file:any,args:any,options:any)=>{const result=(original as any)(file,args,options);if(file==='/usr/sbin/lsof'&&!swapped){swapped=true;const db=join(f.home,'state_5.sqlite');writeFileSync(db+'.replacement',readFileSync(db),{mode:0o600});renameSync(db+'.replacement',db);}return result;})as typeof original;syncBuiltinESMExports();
    await assert.rejects(probeSavedHistorySource({source,allowedCwds:[f.project]}),{code:'stale'});assert.equal(swapped,true);assert.throws(()=>currentReadSource(source),{code:'stale'});
  }finally{childProcess.execFileSync=original;syncBuiltinESMExports();releaseReadSource(source);}}finally{childProcess.execFileSync=original;syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
});
test('actual owned child permission-denied FD evidence never falls back to metadata success',mac,async()=>{
  const root=realpathSync(mkdtempSync('/tmp/ash-rrealm.'));const original=childProcess.execFileSync;let denied=false;
  try{const f=await native.createNativeRealmFixture(root);writeFileSync(readSourcePath(f.state),JSON.stringify(f.descriptor(f.home)),{mode:0o600});const source=captureProtectedReadSource({stateDir:f.state,endpointId:'fixture-endpoint',testing:{home:f.osHome,accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}}});try{
    childProcess.execFileSync=((file:any,args:any,options:any)=>{if(file==='/usr/sbin/lsof'){denied=true;throw Object.assign(new Error('Synthetic permission failure'),{code:'EACCES'});}return(original as any)(file,args,options);})as typeof original;syncBuiltinESMExports();
    await assert.rejects(probeSavedHistorySource({source,allowedCwds:[f.project]}),{code:'offline'});assert.equal(denied,true);
  }finally{childProcess.execFileSync=original;syncBuiltinESMExports();releaseReadSource(source);}}finally{childProcess.execFileSync=original;syncBuiltinESMExports();rmSync(root,{recursive:true,force:true});}
});

test('release attempts every retained FD and caches failure without leaking later descriptors',mac,async()=>{
  const root=realpathSync(mkdtempSync('/tmp/ash-rrealm.'));const original=fs.closeSync;let failedFD:number|undefined,attempts=0;
  try{const f=await native.createNativeRealmFixture(root);writeFileSync(readSourcePath(f.state),JSON.stringify(f.descriptor(f.home)),{mode:0o600});const source=captureProtectedReadSource({stateDir:f.state,endpointId:'fixture-endpoint',testing:{home:f.osHome,accountIdentity:{account_id:'synthetic-fixture-account',subject:'synthetic-fixture-subject'}}});
    fs.closeSync=((fd:number)=>{attempts++;if(failedFD===undefined){failedFD=fd;throw new Error('Synthetic close failure');}return original(fd);})as typeof original;syncBuiltinESMExports();
    let first:unknown;try{releaseReadSource(source);}catch(error){first=error;}assert(first);assert.equal((first as any).code,'offline');assert(attempts>=6,'remaining realm and source descriptors must all be attempted');const count=attempts;try{releaseReadSource(source);assert.fail('cached release failure required');}catch(error){assert.equal(error,first);}assert.equal(attempts,count);
  }finally{fs.closeSync=original;syncBuiltinESMExports();if(failedFD!==undefined)original(failedFD);rmSync(root,{recursive:true,force:true});}
});
