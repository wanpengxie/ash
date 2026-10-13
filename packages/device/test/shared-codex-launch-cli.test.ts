import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';

const terminalPython=String.raw`import os,pty,subprocess,select,sys,json,time
master,slave=pty.openpty();p=subprocess.Popen(sys.argv[2:],stdin=slave,stdout=slave,stderr=slave);os.close(slave);data=b'';sent=False;end=time.monotonic()+20
while time.monotonic()<end:
 ready,_,_=select.select([master],[],[],.1)
 if ready:
  try:chunk=os.read(master,65536)
  except OSError:break
  if not chunk:break
  data+=chunk
  if not sent and b'Prepare shared connection and open Codex? [y/N]' in data:os.write(master,(sys.argv[1]+'\n').encode());sent=True
 if p.poll() is not None:break
if p.poll() is None:p.terminate()
p.wait(timeout=5);os.close(master);print(json.dumps({'exit':p.returncode,'output':data.decode(errors='replace')}))`;

test('CLI missing setup asks one specific confirmation; cancel/non-TTY never launch, success remains attachment unverified',async()=>{
 const root=mkdtempSync('/tmp/ash-shared-cli-'),entry=join(root,'cli.mjs');
 try{
  // Only the shared-launch backend boundary is isolated. The actual CLI branch
  // and readline terminal confirmation run in child processes and real PTYs.
  await build({stdin:{contents:`import {deviceCli} from ${JSON.stringify(resolve('packages/device/src/cli.ts'))};try{await deviceCli(async()=>{throw Error('unexpected device start')});}catch(error){console.error(error.message);process.exitCode=1;}`,resolveDir:process.cwd(),sourcefile:'shared-cli-fixture.ts'},outfile:entry,bundle:true,platform:'node',target:'node22',format:'esm',banner:{js:"import{createRequire as __ashTestRequire}from'node:module';const require=__ashTestRequire(import.meta.url);"},logLevel:'silent',plugins:[{name:'shared-launch-backend-fixture',setup(b){b.onResolve({filter:/setup\/shared-codex-launch$/},()=>({path:'fixture',namespace:'shared-cli'}));b.onLoad({filter:/.*/,namespace:'shared-cli'},()=>({contents:`export async function planSharedCodexLaunch(){const mode=process.env.ASH_SHARED_TEST_MODE;return {version:'fixture',desktop:mode==='running'?'running':'closed',daemon:'offline',policy:mode==='compatible'?'disabled':'missing',blockers:mode==='running'?['daemon_policy_missing','desktop_must_be_closed']:mode==='compatible'?[]:['daemon_policy_missing']};}export async function startSharedCodexLaunch(plan,authorization){console.log('FIXTURE_START '+JSON.stringify(authorization));if(plan.desktop==='running')return {state:'blocked',code:'desktop_must_be_closed'};if(process.env.ASH_SHARED_TEST_MODE==='failure')return {state:'blocked',code:'settings_preparation_failed'};return {state:'launched',mode:'shared',attachment:'attachment_unverified'};}`,loader:'js'}));}}]});
  const run=async(mode:string,answer?:string)=>{
   const env={...process.env,HOME:root,ASH_SHARED_TEST_MODE:mode};
   if(answer!==undefined){const result=await promisify(execFile)('python3',['-c',terminalPython,answer,process.execPath,entry,'codex-shared','--start'],{env,timeout:30000});return JSON.parse(result.stdout) as {exit:number;output:string};}
   return promisify(execFile)(process.execPath,[entry,'codex-shared','--start'],{env}).then(r=>({exit:0,output:r.stdout+r.stderr}),(e:any)=>({exit:e.code,output:e.stdout+e.stderr}));
  };
  const cancelled=await run('missing','n');assert.equal(cancelled.exit,0,cancelled.output);assert.match(cancelled.output,/remote control and automatic daemon updates turned off/);assert.equal((cancelled.output.match(/Prepare shared connection and open Codex\? \[y\/N\]/g)??[]).length,1);assert.match(cancelled.output,/Cancelled; no shared settings or launch changes made/);assert(!cancelled.output.includes('FIXTURE_START'));assert(!cancelled.output.includes('Codex opened'));
  const plain=await run('missing');assert.equal(plain.exit,1);assert.match(plain.output,/interactive terminal/);assert(!plain.output.includes('FIXTURE_START'));
  const approved=await run('missing','yes');assert.equal(approved.exit,0,approved.output);assert.match(approved.output,/FIXTURE_START {"approved":true,"prepareMissingSettings":true}/);assert.match(approved.output,/Desktop attachment must still be verified before sending/);assert(!approved.output.includes('connected successfully'));
  const failure=await run('failure','yes');assert.equal(failure.exit,1);assert.match(failure.output,/settings_preparation_failed/);assert(!failure.output.includes('Codex opened'));
  const compatible=await run('compatible');assert.equal(compatible.exit,0);assert.match(compatible.output,/"prepareMissingSettings":false/);assert(!compatible.output.includes('Prepare shared connection and open Codex?'));
  const running=await run('running');assert.equal(running.exit,1);assert.match(running.output,/desktop_must_be_closed/);assert(!running.output.includes('Prepare shared connection and open Codex?'));assert(!running.output.includes('Codex opened'));
  assert.equal(existsSync(join(root,'.codex')),false);
 }finally{rmSync(root,{recursive:true,force:true});}
});
