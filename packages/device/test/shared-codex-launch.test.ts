import test,{mock} from 'node:test';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {chmodSync,existsSync,linkSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {readLocalStateFile} from '../src/collaboration/local-state';
import assert from 'node:assert/strict';
import {planSharedCodexLaunch,startSharedCodexLaunch,SHARED_CODEX_APP,SHARED_CODEX_CLI,SHARED_CODEX_VERSION,prepareMissingSharedCodexSettings,createSharedCodexDesktopScan,type SharedCodexLaunchTestBackend} from '../src/setup/shared-codex-launch';

function fixture(){
 const calls:Array<{command:string;args:readonly string[];env:Readonly<Record<string,string>>}>=[];
 const state={desktop:false,psUnknown:false,running:false,socket:false,version:SHARED_CODEX_VERSION,appIdentity:'app-1',cliIdentity:'cli-1',settingsIdentity:'settings-1',remote:false,update:false,startFails:false,notReady:false,openFails:false,normalFails:false,desktopOnStart:false,missing:false,raw:null as string|null,prepared:0,prepareFail:false,invalidPrepared:false};
 const backend:SharedCodexLaunchTestBackend={platform:'darwin',homeDir:'/fixture/home',file(path){if(path===SHARED_CODEX_APP)return {identity:state.appIdentity,kind:'directory'};if(path===SHARED_CODEX_CLI)return {identity:state.cliIdentity,kind:'file'};if(path.endsWith('/settings.json'))return state.missing?null:{identity:state.settingsIdentity,kind:'file'};if(path.endsWith('/app-server-control.sock')&&state.socket)return {identity:'socket-1',kind:'socket'};return null;},read(){if(state.missing)return null;return state.raw??JSON.stringify({remoteControlEnabled:state.remote,updater:{autoUpdateEnabled:state.update}});},prepareSettings(){state.prepared++;if(state.prepareFail)throw Error('write failed');state.missing=false;state.settingsIdentity='prepared-settings';if(state.invalidPrepared)state.remote=true;return state.settingsIdentity;},async run(command,args,env){calls.push({command,args,env});
  if(command==='/bin/ps')return {exitCode:state.psUnknown?1:0,stdout:state.desktop?`42 ${SHARED_CODEX_APP}/Contents/MacOS/ChatGPT\n`:''};
  if(command===SHARED_CODEX_CLI&&args[0]==='--version')return {exitCode:0,stdout:`codex-cli ${state.version}\n`};
  if(command===SHARED_CODEX_CLI&&args[2]==='version')return state.running?{exitCode:0,stdout:JSON.stringify({appServerVersion:state.version})}:{exitCode:1,stdout:''};
  if(command===SHARED_CODEX_CLI&&args[2]==='start'){if(state.desktopOnStart)state.desktop=true;if(state.startFails)return {exitCode:1,stdout:''};state.running=!state.notReady;state.socket=!state.notReady;return {exitCode:0,stdout:JSON.stringify({status:'started'})};}
  if(command==='/usr/bin/open'){const shared=args.includes('--env');return {exitCode:shared?state.openFails?1:0:state.normalFails?1:0,stdout:''};}
  throw Error('unexpected command');}};
 const mutations=()=>calls.filter(c=>c.command==='/usr/bin/open'||c.args[2]==='start');
 return {backend,state,calls,mutations};
}
test('plan is read only and pins supported macOS bundle, home and historic URL',async()=>{
 const f=fixture(),plan=await planSharedCodexLaunch({testing:f.backend});assert.equal(plan.desktop,'closed');assert.equal(plan.daemon,'offline');assert.deepEqual(plan.blockers,[]);assert.equal(f.mutations().length,0);
 assert.equal(plan.paths.cli,SHARED_CODEX_CLI);assert.equal(plan.paths.codexHome,'/fixture/home/.codex');assert.equal(plan.paths.url,'ws+unix://localhost/fixture/home/.codex/app-server-control/app-server-control.sock:/rpc');assert.ok(Object.isFrozen(plan));
});
test('approved closed desktop starts daemon, observes readiness, then opens shared URL',async()=>{
 const f=fixture(),plan=await planSharedCodexLaunch({testing:f.backend}),result=await startSharedCodexLaunch(plan,{approved:true});assert.deepEqual(result,{state:'launched',attachment:'attachment_unverified',mode:'shared'});
 assert.deepEqual(f.mutations().map(c=>[c.command,...c.args]),[[SHARED_CODEX_CLI,'app-server','daemon','start'],['/usr/bin/open','-a',SHARED_CODEX_APP,'--env',`CODEX_APP_SERVER_WS_URL=${plan.paths.url}`]]);
 const startIndex=f.calls.findIndex(c=>c.args[2]==='start'),openIndex=f.calls.findIndex(c=>c.command==='/usr/bin/open');assert.ok(f.calls.slice(startIndex+1,openIndex).some(c=>c.args[2]==='version'));
 assert.ok(f.calls.every(c=>c.env.CODEX_HOME==='/fixture/home/.codex'));assert.ok(f.calls.every(c=>Object.keys(c.env).sort().join(',')==='CODEX_HOME,HOME,LANG,PATH'));
 assert.equal((await startSharedCodexLaunch(plan,{approved:true})).state,'blocked');
});
test('live desktop and missing explicit approval never trigger exit, start or open',async()=>{
 const f=fixture();f.state.desktop=true;const plan=await planSharedCodexLaunch({testing:f.backend});assert.ok(plan.blockers.includes('desktop_must_be_closed'));
 assert.deepEqual(await startSharedCodexLaunch(plan,{approved:false}),{state:'blocked',code:'approval_required'});assert.deepEqual(await startSharedCodexLaunch(plan,{approved:true}),{state:'blocked',code:'desktop_must_be_closed'});assert.equal(f.mutations().length,0);
});
test('desktop can close manually after plan; existing daemon is retained',async()=>{
 const f=fixture();f.state.desktop=true;f.state.running=true;f.state.socket=true;const plan=await planSharedCodexLaunch({testing:f.backend});f.state.desktop=false;
 assert.equal((await startSharedCodexLaunch(plan,{approved:true})).state,'launched');assert.equal(f.mutations().filter(c=>c.args[2]==='start').length,0);assert.equal(f.mutations().length,1);
});
for(const failure of ['startFails','notReady','openFails'] as const)test(`${failure} falls back to normal open without stopping daemon`,async()=>{
 const f=fixture();f.state[failure]=true;const plan=await planSharedCodexLaunch({testing:f.backend}),result=await startSharedCodexLaunch(plan,{approved:true});assert.equal(result.state,'launched');assert.equal(result.state==='launched'?result.mode:null,'normal');
 assert.deepEqual(f.mutations().at(-1)?.args,['-a',SHARED_CODEX_APP]);assert.ok(f.calls.every(c=>!c.args.some(a=>['stop','restart','bootstrap','enable-remote-control','update','kill','quit'].includes(a))));
});
test('desktop appearing during daemon start is never exited or opened again',async()=>{
 const f=fixture();f.state.desktopOnStart=true;const plan=await planSharedCodexLaunch({testing:f.backend});assert.deepEqual(await startSharedCodexLaunch(plan,{approved:true}),{state:'blocked',code:'desktop_must_be_closed'});assert.equal(f.calls.some(c=>c.command==='/usr/bin/open'),false);
});
test('changed artifact, changed settings, unsupported version and unsafe daemon policy block',async()=>{
 for(const field of ['appIdentity','cliIdentity','settingsIdentity'] as const){const f=fixture(),plan=await planSharedCodexLaunch({testing:f.backend});f.state[field]='changed';assert.deepEqual(await startSharedCodexLaunch(plan,{approved:true}),{state:'blocked',code:'changed_plan'});assert.equal(f.mutations().length,0);}
 for(const field of ['remote','update'] as const){const f=fixture();f.state[field]=true;const plan=await planSharedCodexLaunch({testing:f.backend});assert.deepEqual(await startSharedCodexLaunch(plan,{approved:true}),{state:'blocked',code:'daemon_policy_not_disabled'});assert.equal(f.mutations().length,0);}
 const f=fixture();f.state.version='9.9.9';const plan=await planSharedCodexLaunch({testing:f.backend});assert.deepEqual(await startSharedCodexLaunch(plan,{approved:true}),{state:'blocked',code:'unsupported_version'});assert.equal(f.mutations().length,0);
});
test('unknown desktop and forged plan fail closed; unsuccessful normal reopen remains blocked',async()=>{
 const f=fixture();f.state.psUnknown=true;const plan=await planSharedCodexLaunch({testing:f.backend});assert.deepEqual(await startSharedCodexLaunch(plan,{approved:true}),{state:'blocked',code:'desktop_state_unknown'});assert.equal(f.mutations().length,0);
 assert.deepEqual(await startSharedCodexLaunch({...plan},{approved:true}),{state:'blocked',code:'stale_plan'});
 const other=fixture();other.state.openFails=true;other.state.normalFails=true;const p=await planSharedCodexLaunch({testing:other.backend});assert.deepEqual(await startSharedCodexLaunch(p,{approved:true}),{state:'blocked',code:'normal_reopen_failed'});
});

test('missing policy needs separate preparation approval; cancellation stays read only',async()=>{
 const f=fixture();f.state.missing=true;
 const cancelled=await planSharedCodexLaunch({testing:f.backend});assert.equal(cancelled.policy,'missing');assert.deepEqual(cancelled.blockers,['daemon_policy_missing']);
 assert.deepEqual(await startSharedCodexLaunch(cancelled,{approved:false,prepareMissingSettings:true}),{state:'blocked',code:'approval_required'});
 const unprepared=await planSharedCodexLaunch({testing:f.backend});assert.deepEqual(await startSharedCodexLaunch(unprepared,{approved:true}),{state:'blocked',code:'settings_preparation_required'});
 assert.equal(f.state.prepared,0);assert.equal(f.mutations().length,0);
});
test('explicit missing preparation rechecks policy, then keeps the original unverified launch flow',async()=>{
 const f=fixture();f.state.missing=true;const plan=await planSharedCodexLaunch({testing:f.backend});
 assert.deepEqual(await startSharedCodexLaunch(plan,{approved:true,prepareMissingSettings:true}),{state:'launched',attachment:'attachment_unverified',mode:'shared'});
 assert.equal(f.state.prepared,1);assert.deepEqual(f.mutations().map(c=>c.command),[SHARED_CODEX_CLI,'/usr/bin/open']);
});
test('running desktop or unsupported version prevents missing-settings writes',async()=>{
 for(const mode of ['desktop','version']){
  const f=fixture();f.state.missing=true;if(mode==='desktop')f.state.desktop=true;else f.state.version='unsupported';
  const plan=await planSharedCodexLaunch({testing:f.backend});assert.equal((await startSharedCodexLaunch(plan,{approved:true,prepareMissingSettings:true})).state,'blocked');
  assert.equal(f.state.prepared,0);assert.equal(f.mutations().length,0);
 }
});
test('partial, unknown and conflicting settings remain byte-for-byte unchanged without startup',async()=>{
 for(const raw of ['{}','null','[]','{"remoteControlEnabled":false}','{"updater":{"autoUpdateEnabled":false}}','{"remoteControlEnabled":false,"updater":{}}','{"remoteControlEnabled":true,"updater":{"autoUpdateEnabled":false}}','{"remoteControlEnabled":false,"updater":{"autoUpdateEnabled":true}}','{"remoteControlEnabled":false,"updater":{"autoUpdateEnabled":false,"unrecognized":false}}','{"remoteControlEnabled":false,"updater":{"autoUpdateEnabled":false},"unrecognized":false}','not json']){
  const f=fixture();f.state.raw=raw;const plan=await planSharedCodexLaunch({testing:f.backend});assert.equal(plan.policy,'unknown');
  assert.deepEqual(await startSharedCodexLaunch(plan,{approved:true,prepareMissingSettings:true}),{state:'blocked',code:'daemon_policy_not_disabled'});assert.equal(f.state.raw,raw);assert.equal(f.state.prepared,0);assert.equal(f.mutations().length,0);
 }
});
test('preparation failure and noncompatible reread never launch either shared or normal desktop',async()=>{
 for(const mode of ['prepareFail','invalidPrepared'] as const){const f=fixture();f.state.missing=true;f.state[mode]=true;const plan=await planSharedCodexLaunch({testing:f.backend});assert.deepEqual(await startSharedCodexLaunch(plan,{approved:true,prepareMissingSettings:true}),{state:'blocked',code:'settings_preparation_failed'});assert.equal(f.mutations().length,0);}
});
function filesystemFixture(){
 const f=fixture(),home=realpathSync(mkdtempSync('/tmp/ash-shared-settings-')),settings=join(home,'.codex/app-server-daemon/settings.json');
 const fixedFile=f.backend.file.bind(f.backend);f.backend.homeDir=home;
 f.backend.file=path=>{if(path===SHARED_CODEX_APP||path===SHARED_CODEX_CLI)return fixedFile(path);if(path===settings){try{const value=readLocalStateFile(path,16384);return value?{identity:value.identity,kind:'file'}:null;}catch{return {identity:'unsafe',kind:'other'};}}if(path.endsWith('/app-server-control.sock')&&f.state.socket)return {identity:'socket',kind:'socket'};return null;};
 f.backend.read=path=>{try{return readLocalStateFile(path,16384)?.raw??null;}catch{return null;}};
 f.backend.prepareSettings=()=>{f.state.prepared++;return prepareMissingSharedCodexSettings(home);};
 return {...f,home,settings,close:()=>rmSync(home,{recursive:true,force:true})};
}
test('real filesystem missing preparation creates only minimal 0600 settings and reaches fixture launch',async()=>{
 const f=filesystemFixture();try{
  const plan=await planSharedCodexLaunch({testing:f.backend});assert.equal(existsSync(join(f.home,'.codex')),false);
  assert.deepEqual(await startSharedCodexLaunch(plan,{approved:true,prepareMissingSettings:true}),{state:'launched',attachment:'attachment_unverified',mode:'shared'});
  assert.deepEqual(JSON.parse(readFileSync(f.settings,'utf8')),{remoteControlEnabled:false,updater:{autoUpdateEnabled:false}});assert.equal(lstatSync(f.settings).mode&0o777,0o600);
  assert.equal(lstatSync(join(f.home,'.codex')).mode&0o777,0o700);assert.equal(lstatSync(join(f.home,'.codex/app-server-daemon')).mode&0o777,0o700);
 }finally{f.close();}
});
test('real missing cancellation creates no directories; existing compatible bytes are reused',async()=>{
 const f=filesystemFixture();try{
  const plan=await planSharedCodexLaunch({testing:f.backend});await startSharedCodexLaunch(plan,{approved:false,prepareMissingSettings:true});assert.equal(existsSync(join(f.home,'.codex')),false);
  mkdirSync(join(f.home,'.codex/app-server-daemon'),{recursive:true,mode:0o700});const raw=' { "remoteControlEnabled": false, "updater": { "autoUpdateEnabled": false }, "shutdownGraceSeconds": 2 }\n';writeFileSync(f.settings,raw,{mode:0o600});const before=readLocalStateFile(f.settings,16384)!;
  const compatible=await planSharedCodexLaunch({testing:f.backend});assert.equal(compatible.policy,'disabled');assert.equal((await startSharedCodexLaunch(compatible,{approved:true})).state,'launched');
  assert.deepEqual(readLocalStateFile(f.settings,16384),before);assert.equal(f.state.prepared,0);
 }finally{f.close();}
});
test('real config appearing after confirmation or inside exclusive creation is never overwritten',async()=>{
 for(const race of ['before','create']){const f=filesystemFixture();try{
  const plan=await planSharedCodexLaunch({testing:f.backend}),raw='{"remoteControlEnabled":true,"updater":{"autoUpdateEnabled":true}}\n';
  const create=()=>{mkdirSync(join(f.home,'.codex/app-server-daemon'),{recursive:true,mode:0o700});writeFileSync(f.settings,raw,{mode:0o600});};
  if(race==='before')create();else f.backend.prepareSettings=()=>{create();return prepareMissingSharedCodexSettings(f.home);};
  assert.deepEqual(await startSharedCodexLaunch(plan,{approved:true,prepareMissingSettings:true}),{state:'blocked',code:race==='before'?'changed_plan':'settings_preparation_failed'});
  assert.equal(readFileSync(f.settings,'utf8'),raw);assert.equal(f.mutations().length,0);
 }finally{f.close();}}
});
test('real prepared file replaced before recheck refuses even compatible replacement',async()=>{
 const f=filesystemFixture();try{
  const plan=await planSharedCodexLaunch({testing:f.backend});f.backend.prepareSettings=()=>{const receipt=prepareMissingSharedCodexSettings(f.home);writeFileSync(f.settings,'{"remoteControlEnabled":false,"updater":{"autoUpdateEnabled":false}}\n',{mode:0o600});return receipt;};
  assert.deepEqual(await startSharedCodexLaunch(plan,{approved:true,prepareMissingSettings:true}),{state:'blocked',code:'changed_plan'});assert.equal(f.mutations().length,0);
 }finally{f.close();}
});
test('real symlink parents and links or special settings are refused without changing targets',async()=>{
 for(const kind of ['home-parent','daemon-parent','settings-link','settings-hardlink','settings-directory']){const f=filesystemFixture();try{
  const other=join(f.home,'other');mkdirSync(other,{mode:0o700});const target=join(other,'target');writeFileSync(target,'original',{mode:0o600});
  if(kind==='home-parent')symlinkSync(other,join(f.home,'.codex'));
  else{mkdirSync(join(f.home,'.codex'),{mode:0o700});if(kind==='daemon-parent')symlinkSync(other,join(f.home,'.codex/app-server-daemon'));else{mkdirSync(join(f.home,'.codex/app-server-daemon'),{mode:0o700});if(kind==='settings-link')symlinkSync(target,f.settings);else if(kind==='settings-hardlink')linkSync(target,f.settings);else mkdirSync(f.settings,{mode:0o700});}}
  assert.throws(()=>prepareMissingSharedCodexSettings(f.home));assert.equal(readFileSync(target,'utf8'),'original');
 }finally{f.close();}}
});
test('actual filesystem write failure stays preparation_failed with zero startup', {skip:process.getuid?.()===0},async()=>{
 const f=filesystemFixture();try{
  mkdirSync(join(f.home,'.codex/app-server-daemon'),{recursive:true,mode:0o700});chmodSync(join(f.home,'.codex/app-server-daemon'),0o500);
  const plan=await planSharedCodexLaunch({testing:f.backend});assert.deepEqual(await startSharedCodexLaunch(plan,{approved:true,prepareMissingSettings:true}),{state:'blocked',code:'settings_preparation_failed'});assert.equal(existsSync(f.settings),false);assert.equal(f.mutations().length,0);
 }finally{chmodSync(join(f.home,'.codex/app-server-daemon'),0o700);f.close();}
});

test('write, sync and publication failures never leave partial settings or own temporary files',()=>{
 for(const method of ['writeFileSync','fsyncSync','linkSync'] as const){
  const f=filesystemFixture(),original=fs[method];
  try{
   mock.method(fs,method,((...args:unknown[])=>{if(method!=='writeFileSync'||typeof args[0]==='number')throw Error('isolated filesystem failure');return (original as Function)(...args);}) as any);syncBuiltinESMExports();
   assert.throws(()=>prepareMissingSharedCodexSettings(f.home),/isolated filesystem failure/);
   assert.equal(existsSync(f.settings),false);assert.deepEqual(readdirSync(join(f.home,'.codex/app-server-daemon')),[]);
  }finally{mock.restoreAll();syncBuiltinESMExports();f.close();}
 }
});

test('configuration changing during async preflight is rejected before native start',async()=>{
 for(const missing of [false,true]){const f=fixture();f.state.missing=missing;const plan=await planSharedCodexLaunch({testing:f.backend}),run=f.backend.run.bind(f.backend);let changed=false;
  f.backend.run=async(command,args,env)=>{const result=await run(command,args,env);if(command==='/bin/ps'&&!changed&&(!missing||f.state.prepared>0)){changed=true;f.state.remote=true;f.state.settingsIdentity='externally-changed';}return result;};
  assert.deepEqual(await startSharedCodexLaunch(plan,{approved:true,prepareMissingSettings:true}),{state:'blocked',code:'changed_plan'});assert.equal(f.mutations().length,0);
 }
});

test('fixed ps stream discards over 64KiB of unrelated rows and finds an exact main process at the end',async()=>{
 const scan=createSharedCodexDesktopScan(),unrelated='100 /Applications/Other.app/Contents/MacOS/Other\n';
 for(let i=0;i<3000;i++)scan.write(Buffer.from(unrelated));
 const exact=`999 ${SHARED_CODEX_APP}/Contents/MacOS/ChatGPT\n`;
 scan.write(Buffer.from(exact.slice(0,35)));scan.write(Buffer.from(exact.slice(35)));
 const result=scan.finish(true);assert.deepEqual(result,{exitCode:0,stdout:exact});assert.equal(result.stdout.includes('Other'),false);
 const f=fixture(),run=f.backend.run.bind(f.backend);f.backend.run=(command,args,env)=>command==='/bin/ps'?Promise.resolve(result):run(command,args,env);
 assert.equal((await planSharedCodexLaunch({testing:f.backend})).desktop,'running');assert.equal(f.mutations().length,0);
});
test('complete large ps stream with only unrelated and near-match helper paths reports closed',async()=>{
 const scan=createSharedCodexDesktopScan();
 for(let i=0;i<3000;i++)scan.write(Buffer.from('100 /usr/bin/unrelated-process\n'));
 scan.write(Buffer.from(`101 ${SHARED_CODEX_APP}/Contents/MacOS/ChatGPT Helper\n102 ${SHARED_CODEX_APP}/Contents/MacOS/ChatGPT.other\n103 /Other${SHARED_CODEX_APP}/Contents/MacOS/ChatGPT\n`));
 const result=scan.finish(true);assert.deepEqual(result,{exitCode:0,stdout:''});
 const f=fixture(),run=f.backend.run.bind(f.backend);f.backend.run=(command,args,env)=>command==='/bin/ps'?Promise.resolve(result):run(command,args,env);
 assert.equal((await planSharedCodexLaunch({testing:f.backend})).desktop,'closed');assert.equal(f.mutations().length,0);
});
test('incomplete, failed, overlong, malformed or too many matching ps rows remain unknown',async()=>{
 for(const scenario of ['stream-incomplete','process-failed','truncated-tail','overlong','malformed','too-many']){
  const scan=createSharedCodexDesktopScan(),exact=`999 ${SHARED_CODEX_APP}/Contents/MacOS/ChatGPT\n`;
  scan.write(Buffer.from(exact));
  if(scenario==='truncated-tail')scan.write(Buffer.from('101 /unfinished'));
  if(scenario==='overlong'){for(let i=0;i<100;i++)scan.write(Buffer.alloc(1024,65));scan.write(Buffer.from('\n'));}
  if(scenario==='malformed')scan.write(Buffer.from('unexpected output\n'));
  if(scenario==='too-many')for(let i=0;i<8;i++)scan.write(Buffer.from(exact));
  const result=scan.finish(!['stream-incomplete','process-failed'].includes(scenario));assert.deepEqual(result,{exitCode:-1,stdout:''},scenario);
  const f=fixture(),run=f.backend.run.bind(f.backend);f.backend.run=(command,args,env)=>command==='/bin/ps'?Promise.resolve(result):run(command,args,env);
  assert.equal((await planSharedCodexLaunch({testing:f.backend})).desktop,'unknown',scenario);assert.equal(f.mutations().length,0);
 }
});
