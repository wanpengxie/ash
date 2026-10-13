import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {buildAndroidStateLock} from './build-android-state-lock.mjs';
test('NDK builds the fixed Android arm64 PIE and matching bounded helper manifest',async()=>{
 const root=mkdtempSync(join(tmpdir(),'ash-android-lock-'));
 try{
  buildAndroidStateLock({output:root});const binary=readFileSync(join(root,'ash-state-lock')),metadata=JSON.parse(readFileSync(join(root,'native-helper.json'),'utf8'));
  assert.deepEqual(metadata,{version:1,name:'ash-state-lock',platform:'android',arch:'arm64',sha256:createHash('sha256').update(binary).digest('hex')});
  assert.equal(binary.readUInt16LE(16),3);assert.equal(binary.readUInt16LE(18),183);assert.ok(binary.includes(Buffer.from('/system/bin/linker64\0')));assert.equal(statSync(join(root,'ash-state-lock')).mode&0o777,0o755);
  const bundled=join(root,'lock.mjs');await build({entryPoints:[resolve('packages/device/src/collaboration/descriptor-lock.ts')],outfile:bundled,bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'silent'});mkdirSync(join(root,'state'));
  // Branch-only Android simulation on the build host. Refuse native execution;
  // reaching this stub proves platform/arch/hash checks accepted the Android artifact.
  // This test never returns a successful lock or claims an Android flock was executed.
  const probe=`import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';cp.spawnSync=()=>{console.log('verified Android helper reached');return {status:1,stdout:''};};syncBuiltinESMExports();Object.defineProperty(process,'platform',{value:'android'});Object.defineProperty(process,'arch',{value:'arm64'});const {acquireDescriptorStateLock}=await import(${JSON.stringify(pathToFileURL(bundled).href)});try{acquireDescriptorStateLock(${JSON.stringify(join(root,'state'))});throw Error('must reject execution');}catch(e){if(e.code!=='unavailable')throw e;}`;
  const run=()=>execFileSync(process.execPath,['--input-type=module','-e',probe],{encoding:'utf8',timeout:5000});assert.match(run(),/verified Android helper reached/);
  for(const patch of [{platform:'linux'},{arch:'x64'},{sha256:'0'.repeat(64)}]){writeFileSync(join(root,'native-helper.json'),JSON.stringify({...metadata,...patch}));assert.equal(run(),'');}
  const assembly=readFileSync(resolve('payload/assemble.mjs'),'utf8');assert.match(assembly,/const stateLock = buildAndroidStateLock\(\)/);assert.match(assembly,/exec\.push\("ash\/ash-state-lock"\)/);assert.match(assembly,/ash\/native-helper\.json/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
