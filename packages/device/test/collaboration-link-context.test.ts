import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DeviceStream} from 'ash-gateway/client/client';
import {loadIdentity, TunnelPort, LINK_PATH, captureSetupConnectionProof, currentSetupConnectionProof} from '../src/link';

const events = {open() {}, message() {}, close() {}};
function stream(peer: string, label: string) {return new DeviceStream(`o-${label}-xxxxxxxxxxxxxxxxxxxx`, peer, LINK_PATH, () => {}, () => {});}

test('collaboration context comes from the authenticated tunnel peer and fences restored pairing bytes, disconnect and replacement', async () => {
 const dir=await mkdtemp(join(tmpdir(),'ash-context-'));
 try {
  const owner=await loadIdentity(join(dir,'owner')), state=join(dir,'computer');await loadIdentity(state);
  const file=join(state,'paired.json'), raw=JSON.stringify({owner_key:owner.publicKey});await writeFile(file,raw,{mode:0o600});
  const port=new TunnelPort();port.connector('',{},events);const tunnel=stream(owner.id,'owner');port.adopt(tunnel);
  let ready=true;const context=port.captureContext(state,()=>ready), proof=captureSetupConnectionProof(context);
  assert.equal(context.transportOwnerId,owner.id);assert.equal(context.isCurrent(),true);assert.equal(currentSetupConnectionProof(proof),undefined);
  await writeFile(file,JSON.stringify({owner_key:owner.publicKey,revoked:true}));assert.equal(context.isCurrent(),false);
  await writeFile(file,raw);assert.equal(context.isCurrent(),false);assert.throws(()=>currentSetupConnectionProof(proof));
  const fresh=port.captureContext(state,()=>ready);ready=false;assert.equal(fresh.isCurrent(),false);ready=true;
  const connected=port.captureContext(state,()=>ready);tunnel.finish({code:1006,reason:'gone'});assert.equal(connected.isCurrent(),false);
  port.connector('',{},events);port.adopt(stream('forged-owner','other'));assert.throws(()=>port.captureContext(state,()=>ready));port.close();
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('the real device advertises and serves describe over ash-link/1 and denies a foreign relay peer', async t => {
 const {startDevice}=await import('../src/main');
 const {startKernel,openTunnel,eventually,errorCode}=await import('./kernel');
 const dir=await mkdtemp(join(tmpdir(),'ash-context-main-'));
 const owner=await loadIdentity(join(dir,'owner')), state=join(dir,'state'), identity=await loadIdentity(state);
 await writeFile(join(state,'paired.json'),JSON.stringify({owner_key:owner.publicKey}),{mode:0o600});
 const kernel=await startKernel();kernel.pair(identity);
 let device: Awaited<ReturnType<typeof startDevice>> | undefined;
 t.after(async()=>{await device?.close();await kernel.stop();await rm(dir,{recursive:true,force:true});});
 device=await startDevice({gateway:'',name:'Test computer',stateDir:state,workdir:join(dir,'work')},undefined,{relay:false,detect:async()=>[],ego:null,kimiPorts:[0]});
 const tunnel=openTunnel(kernel,device,identity.id,owner.id);await device.client.ready();
 await eventually(()=>kernel.hands.capabilities(identity.id).includes('collaboration.endpoint.describe'),'collaboration manifest');
 const result=await kernel.call(`device:${identity.id}`,'collaboration.endpoint.describe');
 assert.equal((result.data as any).collaboration.source,'codex.saved_history');
 assert.equal((result.data as any).collaboration.endpoint_id,identity.id);
 tunnel.cut();await eventually(()=>device!.client.state!=='ready','disconnect');
 openTunnel(kernel,device,identity.id,'foreign-owner');await device.client.ready();
 assert.equal(await errorCode(kernel.call(`device:${identity.id}`,'collaboration.endpoint.describe')),'forbidden');
});
