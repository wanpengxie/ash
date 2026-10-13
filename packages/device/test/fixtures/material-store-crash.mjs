// Dedicated subprocess fixture: simulated grant is test-only, never exported to production.
import { FixtureCustodyRegistry } from './material-custody-fixture.ts';
import { MaterialAssetStore } from '../../src/collaboration/material-store.ts';
import { createHash } from 'node:crypto';
const [rootDir, point] = process.argv.slice(2);
const source = { kind: 'node', node_id: 'phone', endpoint_id: 'materials' };
const destination = { kind: 'work', work: { node_id: 'mac', endpoint_id: 'codex', kind: 'conversation', native_id: 'real-fixture-conversation' } };
const bytes = Buffer.from('hello');
const context = { principal_id: 'phone-principal', pairing_id: 'phone-pair', grant_revision: 'r', authorization_epoch: '1', source_binding: source, expires_at: 1e10 };
const registry=new FixtureCustodyRegistry(()=>{},()=>1000);
const store = new MaterialAssetStore({rootDir,localStoreId:'mac-store',custody:registry.authority('mac-store'), clock: () => 1000, authorization: {before: async c => c, after: async () => {}, current: () => undefined}, fault: p => { if(p === point) process.exit(74); }});
const offer = {version: 1, request_id: 'request', asset: {kind: 'asset',asset_id: 'asset',version: 1,sha256: createHash('sha256').update(bytes).digest('hex'),byte_length: bytes.length,media_type: 'application/octet-stream',display_name: '../../display-only',provenance: [],expires_at: 1e9},source,destination,expires_at: 1e9};
registry.register(offer);
const binding = action => ({context,lease: context,scope: {kind:'request',action,request_id:'request',source,return_to:source,target:destination,transfer:{asset_id:'asset',asset_version:1,source,destination}}});
const fact = await store.offer(offer,binding('offer'));
const identity = {version:1,transfer_id:fact.transfer_id,request_id:'request',asset_id:'asset',asset_version:1};
await store.putChunk({...identity,chunk_index:0,data_base64:bytes.toString('base64')},binding('put_chunk'));
await store.commit(identity,binding('commit'));
throw new Error('expected crash point was not reached');
