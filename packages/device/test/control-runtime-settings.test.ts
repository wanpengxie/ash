import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,realpathSync,writeFileSync,readFileSync,existsSync,rmSync,statSync,renameSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {ControlRuntimeSettings,captureLoadedControlWork,controlWorkProofTarget,currentLoadedControlWork,releaseLoadedControlWork,listLoadedControlWorks} from '../src/setup/control-runtime-settings';
import {loadControlRuntimeConfig} from '../src/collaboration/control-runtime';
import {SetupError} from '../src/setup/scope-settings';

async function fixture(t:{after(fn:()=>Promise<void>):void},configured=false,mode='normal') {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'ash-control-settings-'))),state=join(root,'state'),cwd=join(root,'project');mkdirSync(state,{mode:0o700});mkdirSync(cwd,{mode:0o700});
 const pair=join(state,'paired.json');writeFileSync(pair,JSON.stringify({owner_key:Buffer.from('unit-owner').toString('base64url')}),{mode:0o600});
 const socket=join(root,'native.sock'),python=realpathSync(execFileSync('python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).trim());
 const main=realpathSync(execFileSync(python,['-c',"import os,subprocess; print(next(x[1:] for x in subprocess.check_output(['lsof','-a','-p',str(os.getpid()),'-d','txt','-Fn'],text=True).splitlines() if x.startswith('n')))"],{encoding:'utf8'}).trim());
 const version=execFileSync(main,['--version'],{encoding:'utf8'}).match(/\b\d+\.\d+\.\d+\b/)![0];
 const config={version:1,endpoint_id:'endpoint',socket,executable:main,supportedVersions:[version]};if(configured)writeFileSync(join(state,'collaboration-control-runtime.json'),JSON.stringify(config),{mode:0o600});
 // Reuse the existing explicit synthetic read-only peer; add loaded-list only.
 const script=readFileSync(fileURLToPath(new URL('./fixtures/setup-native.py',import.meta.url)),'utf8').replace("elif method=='thread/read': result={'thread': {'id': request['params']['threadId'], 'cwd': cwd}}",`elif method=='thread/loaded/list':
                cursor=request['params'].get('cursor')
                if '${mode}'=='overflow': result={'data':['overflow-'+str(i) for i in range(32)] if not cursor else ['overflow-extra'], 'nextCursor':'next' if not cursor else None}
                elif '${mode}'=='loop': result={'data':[], 'nextCursor':'repeat'}
                else: result={'data':['loaded-work'] if not cursor else ['other-project','untitled-work'], 'nextCursor':'next' if not cursor else None}
            elif method=='thread/read':
                thread=request['params']['threadId']
                result={'thread': {'id':thread, 'cwd':cwd+'/other' if thread=='other-project' else cwd}}
                if thread=='loaded-work': result['thread'].update({'name':'Current project\\nconversation', 'updatedAt':123})`);
 const scriptPath=join(root,'peer.py');writeFileSync(scriptPath,script);const child=spawn(python,[scriptPath,socket,cwd],{stdio:['pipe','pipe','pipe']}),calls:any[]=[];let text='';
 let stopped=false;const stop=async()=>{if(stopped)return;stopped=true;const exit=once(child,'exit');child.stdin.end();await exit;};
 t.after(async()=>{await stop();rmSync(root,{recursive:true,force:true});});
 await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('peer startup deadline')),3000);child.once('error',reject);child.stdout.on('data',b=>{text+=b.toString();let n:number;while((n=text.indexOf('\n'))>=0){const row=JSON.parse(text.slice(0,n));text=text.slice(n+1);if(row.ready){clearTimeout(timer);resolve();}if(row.call)calls.push(row.call);}});});
 const executable=realpathSync(execFileSync('lsof',['-a','-p',String(child.pid),'-d','txt','-Fn'],{encoding:'utf8'}).split('\n').find(line=>line.startsWith('n'))!.slice(1));
 assert.equal(executable,main,'fixture main executable must match the preconfigured candidate');let unsafe=false,released=0;
 const settings=new ControlRuntimeSettings({stateDir:state,endpointId:'endpoint',current:()=>undefined,runtime:{reserveChange:async()=>{if(unsafe)throw new SetupError('busy');return {assertCurrent:()=>undefined,release:()=>{released++;return undefined;}};}}});
 t.after(async()=>{await settings.close();});
 return {state,cwd,pair,config,settings,calls,stop,setUnsafe:()=>{unsafe=true;},released:()=>released,work:{node_id:'endpoint',endpoint_id:'endpoint',kind:'conversation' as const,native_id:'loaded-work'}};
}
const denied=(code:string)=>(error:unknown)=>error instanceof SetupError&&error.code===code;
test('native candidate saves private runtime only; result does not claim grant or ready',{timeout:30000},async t=>{
 const f=await fixture(t),p=await f.settings.prepare(f.config);assert.equal(existsSync(join(f.state,'collaboration-control-runtime.json')),false);
 assert.deepEqual(await f.settings.apply(p.preview_id,p.selection_hash),{state:'saved',needsControlGrant:true});
 assert.equal(loadControlRuntimeConfig(f.state,'endpoint').state,'configured');assert.equal(statSync(join(f.state,'collaboration-control-runtime.json')).mode&0o777,0o600);
 assert.equal(existsSync(join(f.state,'collaboration-control.json')),false);assert.equal(existsSync(join(f.state,'collaboration-read.json')),false);assert.equal(f.released(),1);
 assert.equal(readdirSync(f.state).some(n=>n.endsWith('.tmp')),false);assert.ok(f.calls.every(c=>['initialize','initialized'].includes(c.method)));
 await assert.rejects(f.settings.apply(p.preview_id,p.selection_hash),denied('stale'));
});
test('endpoint mismatch and unavailable listener cannot save',{timeout:30000},async t=>{
 const f=await fixture(t);await assert.rejects(f.settings.prepare({...f.config,endpoint_id:'other'}),denied('invalid'));
 await assert.rejects(f.settings.prepare({...f.config,socket:join(f.state,'missing.sock')}),denied('unavailable'));
 await assert.rejects(f.settings.prepare({...f.config,supportedVersions:['0.0.0']}),denied('unsupported'));
 assert.equal(existsSync(join(f.state,'collaboration-control-runtime.json')),false);
});
test('pair replacement and revoked pairing prevent save',{timeout:30000},async t=>{
 const f=await fixture(t),p=await f.settings.prepare(f.config);writeFileSync(f.pair,JSON.stringify({owner_key:Buffer.from('unit-other-owner').toString('base64url')}));
 await assert.rejects(f.settings.apply(p.preview_id,p.selection_hash),denied('stale'));
 writeFileSync(f.pair,JSON.stringify({owner_key:Buffer.from('unit-owner').toString('base64url'),revoked:true}));await assert.rejects(f.settings.prepare(f.config),denied('unpaired'));
 assert.equal(existsSync(join(f.state,'collaboration-control-runtime.json')),false);
});
test('busy admission prevents a verified candidate from saving',{timeout:30000},async t=>{
 const f=await fixture(t),p=await f.settings.prepare(f.config);f.setUnsafe();await assert.rejects(f.settings.apply(p.preview_id,p.selection_hash),denied('busy'));assert.equal(existsSync(join(f.state,'collaboration-control-runtime.json')),false);
});
test('listener exit invalidates captured preview',{timeout:30000},async t=>{
 const f=await fixture(t),p=await f.settings.prepare(f.config);await f.stop();await assert.rejects(f.settings.apply(p.preview_id,p.selection_hash),denied('unavailable'));
 assert.equal(existsSync(join(f.state,'collaboration-control-runtime.json')),false);
});
test('loaded-work proof is native issued, stable between captures, never resumes',{timeout:30000},async t=>{
 const f=await fixture(t,true);
 const args={stateDir:f.state,endpointId:'endpoint',work:f.work,current:()=>undefined};
 const proof=await captureLoadedControlWork(args),target=controlWorkProofTarget(proof);assert.equal(target.cwd,f.cwd);assert.deepEqual(target.work,f.work);currentLoadedControlWork(proof);releaseLoadedControlWork(proof);
 assert.throws(()=>currentLoadedControlWork(proof),denied('stale'));
 const fresh=await captureLoadedControlWork(args);assert.equal(controlWorkProofTarget(fresh).confirmation_binding,target.confirmation_binding);releaseLoadedControlWork(fresh);
 await assert.rejects(captureLoadedControlWork({...args,work:{...f.work,native_id:'not-loaded'}}),denied('source_not_running'));
 assert.throws(()=>currentLoadedControlWork({kind:'loaded-control-work'}),denied('invalid'));
 assert.ok(f.calls.some(c=>c.method==='thread/loaded/list'));assert.ok(f.calls.every(c=>['initialize','initialized','thread/loaded/list','thread/read'].includes(c.method)));
});
test('loaded-work proof rejects same-byte runtime replacement and wrong endpoint',{timeout:30000},async t=>{
 const f=await fixture(t,true),path=join(f.state,'collaboration-control-runtime.json');
 const args={stateDir:f.state,endpointId:'endpoint',work:f.work,current:()=>undefined},proof=await captureLoadedControlWork(args);
 writeFileSync(path+'.replacement',readFileSync(path),{mode:0o600});renameSync(path+'.replacement',path);assert.throws(()=>currentLoadedControlWork(proof),denied('stale'));releaseLoadedControlWork(proof);
 await assert.rejects(captureLoadedControlWork({...args,work:{...f.work,endpoint_id:'other'}}),denied('invalid'));
});
test('runtime own commit immediately captures loaded work without a new observer or retry',{timeout:30000},async t=>{
 const f=await fixture(t),p=await f.settings.prepare(f.config);await f.settings.apply(p.preview_id,p.selection_hash);
 const proof=await f.settings.captureLoadedWork(f.work);assert.deepEqual(controlWorkProofTarget(proof).work,f.work);currentLoadedControlWork(proof);
 const path=join(f.state,'collaboration-control-runtime.json');writeFileSync(path+'.replacement',readFileSync(path),{mode:0o600});renameSync(path+'.replacement',path);
 assert.throws(()=>currentLoadedControlWork(proof),denied('stale'));releaseLoadedControlWork(proof);
});
test('settings shutdown invalidates and releases a borrowed loaded proof',{timeout:30000},async t=>{
 const f=await fixture(t,true),proof=await f.settings.captureLoadedWork(f.work);await f.settings.close();assert.throws(()=>currentLoadedControlWork(proof),denied('stale'));releaseLoadedControlWork(proof);
});
test('loaded choices page through the fixed listener and filter exact project with native time',{timeout:30000},async t=>{
 const f=await fixture(t,true),result=await listLoadedControlWorks({stateDir:f.state,endpointId:'endpoint',project:f.cwd,current:()=>undefined});
 assert.equal(result.items.length,2);assert.deepEqual(result.items[0],{work:f.work,title:'Current project conversation',cwd:f.cwd,updated_at:123000});assert.equal(result.items[1].updated_at,null);assert.match(result.items[1].title,/未命名会话/);assert.ok(result.owner_id);
 assert.equal(f.calls.filter(c=>c.method==='thread/loaded/list').length,2);assert.ok(f.calls.filter(c=>c.method==='thread/read').every(c=>c.params.includeTurns===false));assert.ok(f.calls.every(c=>['initialize','initialized','thread/loaded/list','thread/read'].includes(c.method)));
});
for(const mode of ['overflow','loop'])test(`loaded choices reject ${mode} rather than silently showing a partial list`,{timeout:30000},async t=>{
 const f=await fixture(t,true,mode);await assert.rejects(listLoadedControlWorks({stateDir:f.state,endpointId:'endpoint',project:f.cwd,current:()=>undefined}),denied(mode==='overflow'?'busy':'unavailable'));assert.equal(f.calls.some(c=>c.method==='thread/read'),false);
});

test('runtime save immediately lists via the same writer, without independent observer or retry',{timeout:30000},async t=>{
 const f=await fixture(t),p=await f.settings.prepare(f.config);await f.settings.apply(p.preview_id,p.selection_hash);
 const result=await f.settings.listLoadedWorks(f.cwd);assert.equal(result.items.length,2);assert.deepEqual(result.items[0].work,f.work);
 const path=join(f.state,'collaboration-control-runtime.json');writeFileSync(path+'.replacement',readFileSync(path),{mode:0o600});renameSync(path+'.replacement',path);
 // A fresh call captures the new physical file, rather than carrying the old list as authority.
 await f.settings.close();await assert.rejects(f.settings.listLoadedWorks(f.cwd),denied('unavailable'));
});
