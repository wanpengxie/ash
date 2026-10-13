import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {ConnectionSetupService} from '../src/setup/service';
import {MaterialSetupIpcServer,callControlRuntimeSetup} from '../src/setup/material-ipc';
import type {ControlRuntimeSettings} from '../src/setup/control-runtime-settings';

test('fixed authenticated runtime IPC preserves candidate and fences both operations',async()=>{
 const root=realpathSync(mkdtempSync('/tmp/ash-cr-ipc-'));const calls:unknown[]=[];
 // Dispatch fixture only: the real native verifier is covered separately.
 const runtime={prepare:async(candidate:unknown,current:()=>undefined)=>{assert.equal(current(),undefined);calls.push(candidate);return {preview_id:'preview',selection_hash:'hash'};},apply:async(id:string,hash:string,current:()=>undefined)=>{assert.equal(current(),undefined);calls.push([id,hash]);return {state:'saved',needsControlGrant:true};}};
 const service=new ConnectionSetupService({stateDir:root,endpointId:'endpoint',controlRuntime:runtime as unknown as ControlRuntimeSettings});
 const server=await MaterialSetupIpcServer.open(root,'endpoint',service);
 try {
  const candidate={version:1,endpoint_id:'endpoint',socket:'/not-used',executable:'/not-used',supportedVersions:['fixture']};
  assert.deepEqual(await callControlRuntimeSetup(root,'endpoint','control-runtime.prepare',{candidate}),{preview_id:'preview',selection_hash:'hash'});
  await assert.rejects(callControlRuntimeSetup(root,'endpoint','control-runtime.apply',{preview_id:1,selection_hash:'hash'}),/invalid/);
  assert.equal(calls.length,1);
  assert.deepEqual(await callControlRuntimeSetup(root,'endpoint','control-runtime.apply',{preview_id:'preview',selection_hash:'hash'}),{state:'saved',needsControlGrant:true});
  assert.deepEqual(calls,[candidate,['preview','hash']]);
 } finally {await server.close();service.close();rmSync(root,{recursive:true,force:true});}
});

test('runtime setup remains unavailable when no native settings service is assembled',async()=>{
 const root=realpathSync(mkdtempSync('/tmp/ash-cr-ipc-'));const service=new ConnectionSetupService({stateDir:root,endpointId:'endpoint'});
 const server=await MaterialSetupIpcServer.open(root,'endpoint',service);
 try {await assert.rejects(callControlRuntimeSetup(root,'endpoint','control-runtime.prepare',{candidate:{}}),/unavailable/);}
 finally {await server.close();service.close();rmSync(root,{recursive:true,force:true});}
});
